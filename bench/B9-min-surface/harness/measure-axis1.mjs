// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/measure-axis1.mjs
//
// @decision DEC-V0-MIN-SURFACE-002
// @title Reachability methodology — ts-morph static walk from entry symbol
// @status accepted
// @rationale
//   METHODOLOGY
//   ts-morph Project loaded with the emit's tsconfig (or default settings).
//   Entry symbol: the exported function named in the task spec (e.g., listOfInts).
//   Walk: Symbol.getDeclarations() + Identifier.findReferences() on every
//   CallExpression and NewExpression, transitively, until the reachable set is stable.
//
//   REACHABLE SET MEMBERSHIP
//   A FunctionDeclaration, FunctionExpression, ArrowFunction, MethodDeclaration,
//   or Constructor whose canonical symbol is referenced (directly or via re-export)
//   from a call site reachable from the entry symbol is included in the reachable set.
//
//   DYNAMIC IMPORT HANDLING
//   require(<literal>) and import(<literal>): argument is a string literal; resolved
//   path is added to the project and its exports treated as reachable (conservative).
//   require(<expr>) / import(<expr>) with non-literal argument: the called module's
//   entire exports surface is added to the reachable set (standard pessimistic
//   over-approximation; documented as "dynamic-non-literal" in output).
//   Dynamic imports are over-counted rather than under-counted.
//
//   EXCLUDED
//   TypeScript type-only declarations (interface, type alias); pure ambient declarations
//   (declare module, declare function without body).
//
//   TOOLING
//   ts-morph (workspace devDependency; used by @yakcc/ir and @yakcc/shave).
//   Rejected: hand-rolled AST walk (duplicates ts-morph symbol resolution).
//   Rejected: V8 runtime coverage (measures executed paths, not reachable — under-counts
//   defensive branches never exercised by benign corpus; biases Arm B upward).
//
//   CONSERVATIVE BIAS
//   Over-counting (dynamic imports → reachable, non-literal require → full exports)
//   disadvantages Arm A (yakcc) if any atom uses dynamic import, but that is the
//   methodology that makes "≥90% reduction" hard to game. The conservative direction
//   is the correct one for a security claim.
//
//   Cross-references:
//   DEC-V0-MIN-SURFACE-001 (REFUSED-EARLY classifier) — harness/measure-axis2.mjs
//   DEC-V0-MIN-SURFACE-003 (Arm B prompt) — harness/llm-baseline.mjs
//   DEC-BENCH-B9-SLICE1-001 (verdict) — harness/run.mjs
//
// Usage (standalone):
//   node bench/B9-min-surface/harness/measure-axis1.mjs --emit <path-to-ts-file> [--entry <funcName>]
//   Output: JSON { loc, bytes, transitive_imports, reachable_functions: { count, names[] } }

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    emit: { type: "string" },
    entry: { type: "string", default: "listOfInts" },
    json: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const EMIT_PATH = cliArgs["emit"];
const ENTRY_FUNCTION = cliArgs["entry"] ?? "listOfInts";
const JSON_ONLY = cliArgs["json"] === true;

if (!EMIT_PATH) {
  console.error("Usage: node measure-axis1.mjs --emit <path> [--entry <funcName>] [--json]");
  process.exit(1);
}

const emitAbsPath = resolve(EMIT_PATH);
if (!existsSync(emitAbsPath)) {
  console.error(`emit path not found: ${emitAbsPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOC + bytes (simple metrics — no ts-morph needed)
// ---------------------------------------------------------------------------

function measureLoc(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const bytes = statSync(filePath).size;
  return { loc: lines.length, loc_nonempty: nonEmptyLines.length, bytes, content };
}

// ---------------------------------------------------------------------------
// ts-morph lazy loader — only loads if node_modules present
// ---------------------------------------------------------------------------

async function loadTsMorph() {
  // Try bench-local node_modules first
  const localPath = resolve(BENCH_B9_ROOT, "node_modules", "ts-morph", "lib", "ts-morph.js");
  if (existsSync(localPath)) {
    const mod = await import(pathToFileURL(localPath).href);
    return mod.default ?? mod;
  }
  // Try workspace-level node_modules
  const workspacePaths = [
    resolve(BENCH_B9_ROOT, "..", "..", "node_modules", "ts-morph", "lib", "ts-morph.js"),
    resolve(BENCH_B9_ROOT, "..", "..", "..", "node_modules", "ts-morph", "lib", "ts-morph.js"),
  ];
  for (const p of workspacePaths) {
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      return mod.default ?? mod;
    }
  }
  // Try bare import (pnpm hoisting)
  try {
    const mod = await import("ts-morph");
    return mod.default ?? mod;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transitive import count: manual regex walk (does not require ts-morph)
// ---------------------------------------------------------------------------

function countTransitiveImports(content, filePath) {
  const seen = new Set();
  const queue = [{ content, filePath }];
  let staticImports = 0;
  let dynamicImports = 0;

  while (queue.length > 0) {
    const { content: src } = queue.shift();

    // Static imports: import ... from "..."
    const staticRe = /^(?:import|export)\s[^'"]+['"]([^'"]+)['"]/gm;
    let m;
    while ((m = staticRe.exec(src)) !== null) {
      const spec = m[1];
      if (!seen.has(spec)) {
        seen.add(spec);
        staticImports++;
      }
    }

    // Dynamic imports: import("...") or require("...")
    const dynamicRe = /(?:import|require)\(['"]([^'"]+)['"]\)/g;
    while ((m = dynamicRe.exec(src)) !== null) {
      const spec = m[1];
      if (!seen.has(`dynamic:${spec}`)) {
        seen.add(`dynamic:${spec}`);
        dynamicImports++;
      }
    }
  }

  return { static: staticImports, dynamic: dynamicImports, total: staticImports + dynamicImports, unique_specs: [...seen] };
}

// ---------------------------------------------------------------------------
// ts-morph reachability walk
// ---------------------------------------------------------------------------

/**
 * @decision DEC-V0-MIN-SURFACE-002 (implementation)
 * Walk: from entry function, follow all CallExpression/NewExpression references
 * transitively until the reachable set stabilizes.
 */
async function measureReachableFunctions(emitPath, entryFuncName, tsMorphLib) {
  const { Project, SyntaxKind } = tsMorphLib;

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
    },
  });

  const sourceFile = project.addSourceFileAtPath(emitPath);
  const allFunctions = new Map(); // canonical name -> node

  // Collect all named function declarations and arrow functions assigned to const
  function collectFunctions(sf) {
    // FunctionDeclaration
    for (const fn of sf.getFunctions()) {
      const name = fn.getName() ?? "<anonymous>";
      if (!allFunctions.has(name)) {
        allFunctions.set(name, fn);
      }
    }

    // Variable declarations that are arrow functions or function expressions
    for (const varDecl of sf.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (init) {
        const kind = init.getKind();
        if (
          kind === SyntaxKind.ArrowFunction ||
          kind === SyntaxKind.FunctionExpression
        ) {
          const name = varDecl.getName();
          if (!allFunctions.has(name)) {
            allFunctions.set(name, init);
          }
        }
      }
    }

    // Class methods
    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        const name = `${cls.getName() ?? "<cls>"}.${method.getName()}`;
        if (!allFunctions.has(name)) {
          allFunctions.set(name, method);
        }
      }
      const ctor = cls.getConstructors()[0];
      if (ctor) {
        const name = `${cls.getName() ?? "<cls>"}.constructor`;
        if (!allFunctions.has(name)) {
          allFunctions.set(name, ctor);
        }
      }
    }
  }

  collectFunctions(sourceFile);

  const totalFunctions = allFunctions.size;

  // BFS from entry function
  const reachableNames = new Set();
  const queue = [];

  // Find entry function
  const entryNode = allFunctions.get(entryFuncName);
  if (!entryNode) {
    // Entry not found — treat all functions as reachable (conservative)
    for (const name of allFunctions.keys()) {
      reachableNames.add(name);
    }
    return {
      total_in_file: totalFunctions,
      reachable: reachableNames.size,
      names: [...reachableNames],
      entry_found: false,
      note: `Entry function '${entryFuncName}' not found — all functions treated as reachable (conservative)`,
    };
  }

  reachableNames.add(entryFuncName);
  queue.push(entryNode);

  const visited = new Set();
  visited.add(entryFuncName);

  while (queue.length > 0) {
    const node = queue.shift();

    // Find all call expressions within this node's body
    const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
    const newExprs = node.getDescendantsOfKind(SyntaxKind.NewExpression);

    for (const call of [...callExprs, ...newExprs]) {
      const expr = call.getExpression();
      const calledName = expr.getText().split("(")[0].trim();

      // Look up in our function map
      for (const [name, fn] of allFunctions) {
        // Match by base name (handle method calls like _nonemptyListContent)
        const baseName = name.split(".").pop() ?? name;
        if (
          (calledName === name || calledName === baseName) &&
          !visited.has(name)
        ) {
          visited.add(name);
          reachableNames.add(name);
          queue.push(fn);
        }
      }
    }
  }

  return {
    total_in_file: totalFunctions,
    reachable: reachableNames.size,
    names: [...reachableNames].sort(),
    entry_found: true,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { loc, loc_nonempty, bytes, content } = measureLoc(emitAbsPath);
  const importStats = countTransitiveImports(content, emitAbsPath);

  let reachabilityResult = {
    total_in_file: null,
    reachable: null,
    names: [],
    entry_found: false,
    note: "ts-morph not available — reachability not measured",
    error: null,
  };

  const tsMorph = await loadTsMorph();
  if (tsMorph) {
    try {
      reachabilityResult = await measureReachableFunctions(emitAbsPath, ENTRY_FUNCTION, tsMorph);
    } catch (err) {
      reachabilityResult = {
        total_in_file: null,
        reachable: null,
        names: [],
        entry_found: false,
        note: `ts-morph walk failed: ${err.message}`,
        error: err.message,
      };
    }
  } else {
    if (!JSON_ONLY) {
      console.error(
        "[axis1] WARNING: ts-morph not found. Install via: pnpm --dir bench/B9-min-surface install\n" +
        "  LOC + bytes measured; reachable_functions will be null."
      );
    }
  }

  const result = {
    emit_path: emitAbsPath,
    entry_function: ENTRY_FUNCTION,
    loc,
    loc_nonempty,
    bytes,
    transitive_imports: importStats,
    reachable_functions: {
      count: reachabilityResult.reachable,
      total_in_file: reachabilityResult.total_in_file,
      names: reachabilityResult.names,
      entry_found: reachabilityResult.entry_found,
      note: reachabilityResult.note ?? null,
    },
  };

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log("=== Axis 1: Structural Minimality ===");
    console.log(`  emit: ${emitAbsPath}`);
    console.log(`  entry: ${ENTRY_FUNCTION}`);
    console.log(`  loc: ${loc} (${loc_nonempty} non-empty)`);
    console.log(`  bytes: ${bytes}`);
    console.log(`  transitive_imports: ${importStats.total} (static=${importStats.static} dynamic=${importStats.dynamic})`);
    console.log(`  reachable_functions:`);
    console.log(`    count: ${reachabilityResult.reachable ?? "N/A"}`);
    console.log(`    total_in_file: ${reachabilityResult.total_in_file ?? "N/A"}`);
    if (reachabilityResult.note) {
      console.log(`    note: ${reachabilityResult.note}`);
    }
    if (reachabilityResult.names.length > 0) {
      console.log(`    names: ${reachabilityResult.names.join(", ")}`);
    }
    console.log();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }

  return result;
}

// Export for use by run.mjs
export { main as measureAxis1 };

// Run standalone if executed directly
const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("measure-axis1.mjs"));
if (isMain) {
  main().catch((err) => {
    console.error("[axis1] Fatal:", err.message);
    process.exit(1);
  });
}
