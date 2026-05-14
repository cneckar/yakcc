// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/measure-axis1.mjs
//
// @decision DEC-B10-AXIS1-STRUCT-001
// @title B10 single-file structural metric — thin census for the emit file itself
// @status accepted
// @rationale
//   PURPOSE
//   B10's PRIMARY metric is the transitive-import-closure walk (measure-transitive-surface.mjs,
//   DEC-IRT-B10-METRIC-001). This file provides a SECONDARY structural census of the
//   emit file itself: LOC, bytes, and import statement count. This mirrors B9's
//   measure-axis1.mjs shape so the B9/B10 result artifacts share comparable keys.
//   It does NOT do transitive traversal — that is measure-transitive-surface.mjs's job.
//
//   METRICS PRODUCED
//   - loc / loc_nonempty / bytes: static file metrics
//   - import_count: count of static import/export-from statements in the emit itself
//   - entry_function: the named export being measured (passed by caller)
//
//   FUNCTION COUNTING
//   Counts body-bearing function nodes in the emit file ONLY (not its closure).
//   This is the emit's own contribution, distinct from the transitive closure count.
//
//   WHY SEPARATE FROM measure-transitive-surface.mjs
//   run.mjs needs the emit's structural census independently (to fill
//   result_schema.arm_a.emit_loc etc.) even when the transitive walk is the
//   primary metric. Keeping them separate preserves B9/B10 shape parity and
//   allows the census to run without ts-morph (for the LOC/bytes subset).
//
//   Cross-references:
//   DEC-IRT-B10-METRIC-001 — harness/measure-transitive-surface.mjs (primary metric)
//   DEC-B10-S1-LAYOUT-001 — harness/run.mjs (mirror B9 layout)
//   DEC-V0-MIN-SURFACE-002 — bench/B9-min-surface/harness/measure-axis1.mjs (B9 analog)
//
// Usage:
//   node bench/B10-import-replacement/harness/measure-axis1.mjs \
//     --emit <path> [--entry <funcName>] [--json]

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    emit:  { type: "string" },
    entry: { type: "string" },
    json:  { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

// ---------------------------------------------------------------------------
// ts-morph lazy loader (mirrors B10 measure-transitive-surface.mjs pattern)
// ---------------------------------------------------------------------------

async function loadTsMorph() {
  const { join } = await import("node:path");
  const candidates = [
    join(BENCH_B10_ROOT, "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "node_modules", "ts-morph", "lib",  "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "node_modules", "ts-morph", "lib",  "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "..", "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "..", "node_modules", "ts-morph", "lib",  "ts-morph.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      return mod.default ?? mod;
    }
  }
  try {
    const mod = await import("ts-morph");
    return mod.default ?? mod;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LOC / bytes
// ---------------------------------------------------------------------------

function measureLoc(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines   = content.split("\n");
  const bytes   = statSync(filePath).size;
  return {
    loc: lines.length,
    loc_nonempty: lines.filter((l) => l.trim().length > 0).length,
    bytes,
    content,
  };
}

// ---------------------------------------------------------------------------
// Import count (regex — no ts-morph needed for census)
// ---------------------------------------------------------------------------

function countImports(content) {
  // Static import/export-from statements only
  const re = /^(?:import|export)\s[^'";\n]+['"]([^'"]+)['"]/gm;
  const specifiers = new Set();
  let m;
  while ((m = re.exec(content)) !== null) specifiers.add(m[1]);
  return { import_count: specifiers.size, specifiers: [...specifiers] };
}

// ---------------------------------------------------------------------------
// Function count in emit file only (not closure)
// ---------------------------------------------------------------------------

async function countEmitFunctions(emitPath, tsMorphLib) {
  const { Project, SyntaxKind } = tsMorphLib;
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
  });
  const sf = project.addSourceFileAtPath(emitPath);
  if (!sf) return 0;

  const BODY_KINDS = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
  ]);

  let count = 0;
  for (const node of sf.getDescendants()) {
    if (!BODY_KINDS.has(node.getKind())) continue;
    // Must have a block or expression body
    let hasBody = false;
    if (typeof node.getBody === "function" && node.getBody() != null) hasBody = true;
    if (!hasBody && typeof node.getExpression === "function" && node.getExpression() != null) hasBody = true;
    if (hasBody) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main export (used by run.mjs as a module)
// ---------------------------------------------------------------------------

export async function measureAxis1({ emitPath, entryName }) {
  const absPath = resolve(emitPath);
  if (!existsSync(absPath)) {
    return { error: `emit not found: ${absPath}`, emit_path: absPath };
  }

  const { loc, loc_nonempty, bytes, content } = measureLoc(absPath);
  const { import_count, specifiers } = countImports(content);

  let emit_functions = null;
  const tsm = await loadTsMorph();
  if (tsm) {
    try {
      emit_functions = await countEmitFunctions(absPath, tsm);
    } catch (err) {
      emit_functions = null;
    }
  }

  return {
    emit_path:       absPath,
    entry_function:  entryName ?? null,
    loc,
    loc_nonempty,
    bytes,
    import_count,
    import_specifiers: specifiers,
    emit_functions,
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("measure-axis1.mjs"));

if (isMain) {
  const emitArg = cliArgs["emit"];
  if (!emitArg) {
    console.error("Usage: measure-axis1.mjs --emit <path> [--entry <funcName>] [--json]");
    process.exit(1);
  }
  const result = await measureAxis1({ emitPath: emitArg, entryName: cliArgs["entry"] });
  if (cliArgs["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log("=== B10 Axis 1: Emit structural census ===");
    console.log(`  emit:           ${result.emit_path}`);
    console.log(`  loc:            ${result.loc} (${result.loc_nonempty} non-empty)`);
    console.log(`  bytes:          ${result.bytes}`);
    console.log(`  import_count:   ${result.import_count}`);
    console.log(`  emit_functions: ${result.emit_functions ?? "N/A"}`);
    console.log();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
