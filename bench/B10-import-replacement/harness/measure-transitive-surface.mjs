// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/measure-transitive-surface.mjs
//
// @decision DEC-IRT-B10-METRIC-001
// @title Transitive-reachable-surface methodology
// @status accepted
// @rationale
//   METHODOLOGY
//   Tool: ts-morph Project with ModuleResolutionKind.NodeNext + an explicit
//   package.json#exports/main/module fallback reader when ts-morph returns nothing.
//
//   ALGORITHM: BFS import-closure walk
//   The single cycle guard is a visitedFiles: Set<absPath>. A file is enqueued any
//   number of times but processed exactly once. Depth is unbounded; termination is
//   guaranteed by the finite de-duplicated file set.
//
//   TRAVERSAL CUTOFF: prod-deps only, depth-unbounded (DEC §2.3 option b)
//   devDependencies and optionalDependencies are not traversed. peerDependencies
//   are included when resolvable. This matches what a production bundle's effective
//   surface is. Depth-bounding would arbitrarily truncate deep chains and under-count Arm B.
//
//   FUNCTION COUNTING UNIT (resolves §1.4 U2)
//   A node is counted as one reachable function iff it is one of:
//   FunctionDeclaration, FunctionExpression, ArrowFunction, MethodDeclaration,
//   Constructor, GetAccessor, SetAccessor -- AND it has a body (block or expression body).
//   Excluded: interface, type alias, ambient declare function/class without body,
//   function type annotations, overload signatures.
//   Applied to every file in the transitive import closure.
//
//   TWO COUNTS, REPORTED SEPARATELY (resolves §1.4 U3)
//   - reachable_functions (PRIMARY): body-bearing fn nodes across all closure files.
//     This is B10's headline axis -- "the code that ships when you import this".
//   - call_graph_from_entry (SECONDARY, if --entry given): B9-comparable BFS from
//     the named entry export. Retained for cross-bench comparability only.
//
//   EXCLUSION LISTS (never traversed, never counted -- U4 mitigation)
//   - TypeScript stdlib: lib.*.d.ts files and typescript/lib/ paths.
//     Prevents JSON.parse-style edges from resolving into lib.es5.d.ts and
//     inflating Arm B's count by thousands of stdlib type signatures.
//   - Node.js builtins: node:* specifiers and the NODE_BUILTINS set.
//     Counted in builtin_imports, never traversed.
//   - @types/* packages: pure type packages, counted in type_only-adjacent stats.
//
//   MODULE RESOLUTION ORDER (resolves §1.4 U1)
//   1. ts-morph with ModuleResolutionKind.NodeNext (understands package.json#exports).
//   2. Fallback: explicit package.json reader -- exports map -> module field -> main field
//      -> index.js for bare specifiers; subpath map for pkg/sub.
//   3. If both fail: push to unresolved_imports[], count as 0 (conservative under-count
//      of the import-heavy arm -- the safe direction for a security claim per §1.5 C1).
//
//   DYNAMIC IMPORTS (mirrors B9 DEC-V0-MIN-SURFACE-002 with direction inverted)
//   Literal import("pkg") -> resolved and traversed (it does ship that surface).
//   Non-literal import(expr) -> recorded in dynamic_non_literal_imports, NOT traversed.
//   This under-counts Arm B (import-heavy arm) -- the conservative direction for B10.
//   Note: B9 over-counts non-literal dynamic imports because the conservative direction
//   there was to disadvantage Arm A (yakcc). In B10, the traversal target IS npm packages
//   so the conservative direction for the ">=90% reduction" claim is to under-count Arm B.
//   The asymmetry is deliberate and documented here.
//
//   CONSERVATIVE BIAS (§1.5 C1)
//   Unresolvable imports -> 0. Non-literal dynamic imports -> 0. .d.ts-only packages -> 0.
//   All under-count Arm B's true surface. This is what makes ">=90% reduction" un-gameable.
//   The unresolved_imports[] field surfaces exactly what was not traversed so a reviewer
//   can judge whether the under-count is material.
//
//   RE-EXPORT HANDLING
//   export * from "./impl" and export { f } from "./impl" are treated identically to
//   imports. The defining file is traversed. Because visitedFiles de-dupes by abs path,
//   a function defined in impl.ts and re-exported through index.ts is counted once (at
//   impl.ts), never twice. Barrel files contribute ~0 own functions plus edges to real files.
//
//   npm-AUDIT CVE SECONDARY METRIC (§3.6)
//   When --audit is passed: collect (package, version) pairs from traversed files;
//   match against an offline pinned advisory DB at fixtures/npm-audit-db/advisories.json;
//   count advisories whose affected range matches a traversed (package, version).
//   Offline DB preferred (deterministic across hosts/CI); live npm audit as fallback.
//
//   TOOLING RATIONALE
//   ts-morph chosen (over esbuild, V8 coverage, hand-rolled walk) because it is already
//   a B9 dependency (C2), it gives fns + bytes + files over the un-tree-shaken import
//   closure, and it understands package.json#exports conditional maps. See §2.3.
//
//   Cross-references:
//   DEC-B10-S1-LAYOUT-001 (mirror B9 layout, no shared harness code) -- harness/run.mjs
//   DEC-V0-MIN-SURFACE-002 (B9's single-file walk -- B10 extends into node_modules)
//   plans/wi-512-b10-import-heavy-bench.md §3 (concrete algorithm + exclusion spec)
//   plans/import-replacement-triad.md (Appendix B proposed this DEC)
//
// Usage (standalone):
//   node bench/B10-import-replacement/harness/measure-transitive-surface.mjs \
//     --emit <path-to-emit-file> \
//     [--entry <exportedFnName>] \
//     [--node-modules <dir>] \
//     [--audit] \
//     [--json]
//
// Output: a single JSON object (resolver result schema §3.5).
// Exit 0 on success including unresolvable imports (those are data, not errors).
// Exit 1 only on harness errors (bad args, emit file missing).

import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Normalize a file path to a canonical form for use as Set/Map key.
// On Windows, ts-morph may return forward-slash paths while Node fs operations
// return backslash paths; these must compare equal in visitedFiles.
// We normalize to the OS-native form via resolve() which always returns the
// canonical absolute path with the OS separator.
function normalizePath(p) {
  return resolve(p);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Node.js built-in specifiers (never traversed, counted as builtin_imports)
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]);

function isBuiltin(spec) {
  if (spec.startsWith("node:")) return true;
  return NODE_BUILTINS.has(spec);
}

// ---------------------------------------------------------------------------
// TypeScript stdlib exclusion (U4 mitigation -- prevents lib.es5.d.ts inflation)
// ---------------------------------------------------------------------------

function isStdlibFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (/\/lib\.[^/]+\.d\.ts$/.test(normalized)) return true;
  if (/\/typescript\/lib\//.test(normalized)) return true;
  if (/\/node_modules\/@types\/node\//.test(normalized)) return true;
  return false;
}

function isAtTypesPackage(spec) {
  return spec.startsWith("@types/");
}

// ---------------------------------------------------------------------------
// Package.json exports map resolver
// ---------------------------------------------------------------------------

function resolveExportsMap(exports, subpath, conditions) {
  if (!exports) return null;
  if (typeof exports === "string") {
    return subpath === "." ? exports : null;
  }
  if (typeof exports !== "object" || Array.isArray(exports)) return null;

  const hasSubpaths = Object.keys(exports).some(k => k.startsWith("."));
  if (hasSubpaths) {
    const target = exports[subpath];
    if (!target) return null;
    return resolveExportsMap(target, subpath, conditions);
  } else {
    for (const cond of conditions) {
      if (exports[cond] !== undefined) {
        return resolveExportsMap(exports[cond], subpath, conditions);
      }
    }
    return null;
  }
}

const RESOLUTION_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts", ".tsx", ".d.ts"];

function resolveFileCandidate(candidate) {
  if (!candidate) return null;
  if (existsSync(candidate)) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return candidate;
      for (const ext of RESOLUTION_EXTENSIONS) {
        const idx = join(candidate, `index${ext}`);
        if (existsSync(idx)) return idx;
      }
    } catch (_) {}
  }
  for (const ext of RESOLUTION_EXTENSIONS) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) return withExt;
  }
  return null;
}

function findPackageRoot(pkgName, fromDir) {
  const dirParts = pkgName.startsWith("@")
    ? pkgName.split("/").slice(0, 2)
    : [pkgName.split("/")[0]];
  let dir = fromDir;
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "node_modules", ...dirParts);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolvePackageViaPackageJson(spec, fromDir) {
  let pkgName, subpath;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 3) {
      pkgName = `${parts[0]}/${parts[1]}`;
      subpath = `./${parts.slice(2).join("/")}`;
    } else {
      pkgName = spec;
      subpath = ".";
    }
  } else {
    const slashIdx = spec.indexOf("/");
    if (slashIdx > 0) {
      pkgName = spec.slice(0, slashIdx);
      subpath = `./${spec.slice(slashIdx + 1)}`;
    } else {
      pkgName = spec;
      subpath = ".";
    }
  }

  const pkgRoot = findPackageRoot(pkgName, fromDir);
  if (!pkgRoot) return null;

  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch (_) {
    return null;
  }

  const conditions = ["import", "default", "require"];

  if (pkgJson.exports) {
    const exported = resolveExportsMap(pkgJson.exports, subpath, conditions);
    if (exported && typeof exported === "string") {
      const candidate = join(pkgRoot, exported);
      const resolved = resolveFileCandidate(candidate);
      if (resolved) return resolved;
    }
  }

  if (subpath !== ".") {
    const directCandidate = join(pkgRoot, subpath.slice(2));
    const resolved = resolveFileCandidate(directCandidate);
    if (resolved) return resolved;
  }

  if (pkgJson.module && subpath === ".") {
    const candidate = join(pkgRoot, pkgJson.module);
    const resolved = resolveFileCandidate(candidate);
    if (resolved) return resolved;
  }

  if (pkgJson.main && subpath === ".") {
    const candidate = join(pkgRoot, pkgJson.main);
    const resolved = resolveFileCandidate(candidate);
    if (resolved) return resolved;
  }

  if (subpath === ".") {
    for (const ext of RESOLUTION_EXTENSIONS) {
      const idx = join(pkgRoot, `index${ext}`);
      if (existsSync(idx)) return idx;
    }
  }

  return null;
}

function resolveRelative(spec, fromFile) {
  const candidate = resolve(dirname(fromFile), spec);
  return resolveFileCandidate(candidate);
}

// ---------------------------------------------------------------------------
// devDependency cutoff
// ---------------------------------------------------------------------------

function isDevDependency(filePath, emitDir) {
  const normalized = filePath.replace(/\\/g, "/");
  const nmIdx = normalized.indexOf("/node_modules/");
  if (nmIdx < 0) return false;

  const afterNm = normalized.slice(nmIdx + "/node_modules/".length);
  let pkgName;
  if (afterNm.startsWith("@")) {
    const parts = afterNm.split("/");
    pkgName = `${parts[0]}/${parts[1]}`;
  } else {
    pkgName = afterNm.split("/")[0];
  }
  if (!pkgName) return false;

  const nmParent = filePath.slice(0, nmIdx);
  const pkgJsonPath = join(nmParent, "package.json");
  if (!existsSync(pkgJsonPath)) return false;

  try {
    const pj = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const devDeps = pj.devDependencies ?? {};
    return Object.prototype.hasOwnProperty.call(devDeps, pkgName);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ts-morph lazy loader
// ---------------------------------------------------------------------------

let _tsMorphLib = null;

async function loadTsMorph() {
  if (_tsMorphLib) return _tsMorphLib;
  // Try bench-local node_modules first (npm install creates bench/B10-import-replacement/node_modules)
  // ts-morph package uses dist/ts-morph.js as main entry (lib/ only has .d.ts)
  const candidatePaths = [
    join(BENCH_B10_ROOT, "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "node_modules", "ts-morph", "lib", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "node_modules", "ts-morph", "lib", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "..", "node_modules", "ts-morph", "dist", "ts-morph.js"),
    join(BENCH_B10_ROOT, "..", "..", "..", "node_modules", "ts-morph", "lib", "ts-morph.js"),
  ];
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      _tsMorphLib = mod.default ?? mod;
      return _tsMorphLib;
    }
  }
  try {
    const mod = await import("ts-morph");
    _tsMorphLib = mod.default ?? mod;
    return _tsMorphLib;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Function counting (§3.4)
// ---------------------------------------------------------------------------

/**
 * Count body-bearing function nodes in a source file.
 *
 * Counted: FunctionDeclaration (with body), FunctionExpression, ArrowFunction,
 *          MethodDeclaration (with body), Constructor (with body),
 *          GetAccessor, SetAccessor.
 *
 * Excluded: interface, type alias, ambient declare without body,
 *           overload signatures.
 */
function countFunctions(sourceFile, SyntaxKind) {
  let count = 0;
  const descendants = sourceFile.getDescendants();
  for (const node of descendants) {
    const kind = node.getKind();
    switch (kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor: {
        // Must have a block body -- excludes overloads + ambient declarations
        const body = typeof node.getBody === "function" ? node.getBody() : null;
        if (body !== null && body !== undefined) {
          count++;
        }
        break;
      }
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction: {
        // Function expressions and arrow functions always have a body
        count++;
        break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// npm-audit secondary metric (§3.6)
// ---------------------------------------------------------------------------

function collectTraversedPackages(visitedFiles) {
  const packages = new Map();
  for (const filePath of visitedFiles) {
    const normalized = filePath.replace(/\\/g, "/");
    const nmIdx = normalized.lastIndexOf("/node_modules/");
    if (nmIdx < 0) continue;
    const afterNm = normalized.slice(nmIdx + "/node_modules/".length);
    let pkgName;
    if (afterNm.startsWith("@")) {
      const parts = afterNm.split("/");
      pkgName = `${parts[0]}/${parts[1]}`;
    } else {
      pkgName = afterNm.split("/")[0];
    }
    if (!pkgName || packages.has(pkgName)) continue;
    // nmIdx points at the '/' before 'node_modules' in the forward-slash normalized
    // string; slicing at nmIdx gives the directory that *contains* node_modules so
    // join(nmRoot, "node_modules", pkgName) is correct. The original off-by-14 slice
    // included the word "node_modules" in nmRoot causing a doubled node_modules path.
    const nmRoot = filePath.slice(0, nmIdx);
    const pkgJsonPath = join(nmRoot, "node_modules", pkgName, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pj = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        packages.set(pkgName, pj.version ?? "unknown");
      } catch (_) {
        packages.set(pkgName, "unknown");
      }
    }
  }
  return packages;
}

function loadOfflineAdvisoryDb() {
  const dbPath = join(BENCH_B10_ROOT, "fixtures", "npm-audit-db", "advisories.json");
  if (!existsSync(dbPath)) return null;
  try {
    return JSON.parse(readFileSync(dbPath, "utf8"));
  } catch (_) {
    return null;
  }
}

function parseSemver(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function semverGte(a, b) {
  const [ma, mi, pa] = parseSemver(a);
  const [mb, mj, pb] = parseSemver(b);
  if (ma !== mb) return ma > mb;
  if (mi !== mj) return mi > mj;
  return pa >= pb;
}

function semverLt(a, b) {
  return !semverGte(a, b);
}

function versionMatchesRange(version, range) {
  if (!version || !range) return false;
  if (range === "*") return true;
  if (range === version) return true;
  const rangeMatch = range.match(/^>=\s*(\S+)\s+<\s*(\S+)$/);
  if (rangeMatch) {
    return semverGte(version, rangeMatch[1]) && semverLt(version, rangeMatch[2]);
  }
  const gteMatch = range.match(/^>=\s*(\S+)$/);
  if (gteMatch) return semverGte(version, gteMatch[1]);
  const ltMatch = range.match(/^<\s*(\S+)$/);
  if (ltMatch) return semverLt(version, ltMatch[1]);
  return false;
}

function runNpmAudit(visitedFiles) {
  const traversedPackages = collectTraversedPackages(visitedFiles);
  const advisoryDb = loadOfflineAdvisoryDb();

  if (!advisoryDb) {
    return {
      ran: false,
      cve_pattern_matches: 0,
      advisories: [],
      audit_source: "skipped",
      note: "No offline advisory DB found at fixtures/npm-audit-db/advisories.json",
    };
  }

  const matches = [];
  for (const advisory of advisoryDb) {
    const pkgVersion = traversedPackages.get(advisory.package_name);
    if (!pkgVersion) continue;
    if (versionMatchesRange(pkgVersion, advisory.vulnerable_versions)) {
      matches.push({
        package: advisory.package_name,
        version: pkgVersion,
        advisory_id: advisory.id,
        cve: advisory.cve ?? null,
        severity: advisory.severity ?? null,
        vulnerable_versions: advisory.vulnerable_versions,
      });
    }
  }

  return {
    ran: true,
    cve_pattern_matches: matches.length,
    advisories: matches,
    audit_source: "offline-db",
  };
}

// ---------------------------------------------------------------------------
// Resolve specifier and enqueue
// ---------------------------------------------------------------------------

function enqueueSpecifier(spec, fromFile, queue, importStats, unresolvedImports, project) {
  if (!spec) return;

  if (isBuiltin(spec)) {
    importStats.builtin++;
    return;
  }

  if (isAtTypesPackage(spec)) {
    importStats.type_only++;
    return;
  }

  const fromDir = dirname(fromFile);
  let resolved = null;

  if (spec.startsWith(".") || spec.startsWith("/")) {
    resolved = resolveRelative(spec, fromFile);
    if (!resolved) {
      unresolvedImports.push({ specifier: spec, fromFile, reason: "relative path not found" });
      return;
    }
  } else {
    importStats.non_builtin_unique.add(spec);
    resolved = resolveViaProject(spec, fromFile, project);
    if (!resolved) {
      resolved = resolvePackageViaPackageJson(spec, fromDir);
    }
    if (!resolved) {
      unresolvedImports.push({ specifier: spec, fromFile, reason: "package not found in node_modules" });
      return;
    }
  }

  queue.push(resolved);
}

function resolveViaProject(spec, fromFile, project) {
  try {
    let sf = project.getSourceFile(fromFile);
    if (!sf) sf = project.addSourceFileAtPathIfExists(fromFile);
    if (!sf) return null;
    for (const decl of sf.getImportDeclarations()) {
      if (decl.getModuleSpecifierValue() === spec) {
        const resolved = decl.getModuleSpecifierSourceFile();
        if (resolved) return resolved.getFilePath();
      }
    }
    for (const decl of sf.getExportDeclarations()) {
      if (decl.getModuleSpecifierValue() === spec) {
        const resolved = decl.getModuleSpecifierSourceFile();
        if (resolved) return resolved.getFilePath();
      }
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Secondary: call-graph from entry (B9-comparable)
// ---------------------------------------------------------------------------

function computeCallGraphFromEntry(emitPath, entryName, project, SyntaxKind) {
  try {
    let sf = project.getSourceFile(emitPath);
    if (!sf) sf = project.addSourceFileAtPathIfExists(emitPath);
    if (!sf) return { count: 0, names: [], entry_found: false };

    const allFunctions = new Map();
    for (const fn of sf.getFunctions()) {
      const name = fn.getName() ?? "<anonymous>";
      allFunctions.set(name, fn);
    }
    for (const varDecl of sf.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (init) {
        const kind = init.getKind();
        if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
          allFunctions.set(varDecl.getName(), init);
        }
      }
    }
    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        const name = `${cls.getName() ?? "<cls>"}.${method.getName()}`;
        allFunctions.set(name, method);
      }
    }

    const entryNode = allFunctions.get(entryName);
    if (!entryNode) return { count: 0, names: [], entry_found: false };

    const reachable = new Set([entryName]);
    const bfsQueue = [entryNode];
    const visited = new Set([entryName]);
    while (bfsQueue.length > 0) {
      const node = bfsQueue.shift();
      for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const calledText = call.getExpression().getText().split("(")[0].trim();
        for (const [name, fn] of allFunctions) {
          const baseName = name.split(".").pop() ?? name;
          if ((calledText === name || calledText === baseName) && !visited.has(name)) {
            visited.add(name);
            reachable.add(name);
            bfsQueue.push(fn);
          }
        }
      }
    }
    return { count: reachable.size, names: [...reachable].sort(), entry_found: true };
  } catch (err) {
    return { count: 0, names: [], entry_found: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Core resolver (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Measure the transitive import closure of an emit file.
 *
 * @param {object} opts
 * @param {string} opts.emitPath - absolute path to the emit file
 * @param {string} [opts.entryName] - optional entry function name (secondary metric)
 * @param {string} [opts.nodeModulesRoot] - override node_modules root
 * @param {boolean} [opts.audit] - run npm-audit secondary metric
 * @returns {Promise<object>} resolver result (§3.5 schema)
 */
export async function measureTransitiveSurface({ emitPath, entryName, nodeModulesRoot, audit = false } = {}) {
  if (!emitPath) throw new Error("emitPath is required");

  const emitAbsPath = resolve(emitPath);
  if (!existsSync(emitAbsPath)) {
    throw new Error(`emit file not found: ${emitAbsPath}`);
  }

  const emitDir = dirname(emitAbsPath);

  const tsMorphLib = await loadTsMorph();
  if (!tsMorphLib) {
    throw new Error("ts-morph not found. Run: pnpm --dir bench/B10-import-replacement install");
  }

  const { Project, SyntaxKind, ModuleResolutionKind, ModuleKind } = tsMorphLib;

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      moduleResolution: ModuleResolutionKind.NodeNext,
      module: ModuleKind.NodeNext,
    },
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });

  const visitedFiles = new Set();
  const reachableFns = new Map();
  const reachableBytes = new Map();
  const queue = [emitAbsPath];

  const importStats = {
    builtin: 0,
    non_builtin_unique: new Set(),
    type_only: 0,
    dynamic_literal: 0,
    dynamic_non_literal: 0,
  };
  const unresolvedImports = [];
  let excludedStdlibFilesSeen = 0;

  while (queue.length > 0) {
    const rawPath = queue.shift();
    // Normalize to OS-canonical form so forward-slash and backslash variants
    // of the same path compare equal in the visitedFiles Set (Windows: ts-morph
    // returns forward-slash paths while Node fs returns backslash paths).
    const filePath = normalizePath(rawPath);

    if (visitedFiles.has(filePath)) continue;

    if (isStdlibFile(filePath)) {
      excludedStdlibFilesSeen++;
      visitedFiles.add(filePath);
      continue;
    }

    if (filePath !== emitAbsPath && isDevDependency(filePath, emitDir)) {
      visitedFiles.add(filePath);
      continue;
    }

    visitedFiles.add(filePath);

    let sourceFile;
    try {
      sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.addSourceFileAtPathIfExists(filePath);
      }
      if (!sourceFile) continue;
    } catch (err) {
      unresolvedImports.push({ specifier: filePath, fromFile: filePath, reason: `parse error: ${err.message}` });
      continue;
    }

    const fnCount = countFunctions(sourceFile, SyntaxKind);
    reachableFns.set(filePath, fnCount);

    try {
      reachableBytes.set(filePath, statSync(filePath).size);
    } catch (_) {
      reachableBytes.set(filePath, 0);
    }

    // Static import declarations
    for (const decl of sourceFile.getImportDeclarations()) {
      if (decl.isTypeOnly()) {
        importStats.type_only++;
        continue;
      }
      const namedImports = decl.getNamedImports();
      if (namedImports.length > 0 && namedImports.every(ni => ni.isTypeOnly())) {
        importStats.type_only++;
        continue;
      }
      const spec = decl.getModuleSpecifierValue();
      enqueueSpecifier(spec, filePath, queue, importStats, unresolvedImports, project);
    }

    // Re-exports
    for (const decl of sourceFile.getExportDeclarations()) {
      if (decl.isTypeOnly()) {
        importStats.type_only++;
        continue;
      }
      const modSpec = decl.getModuleSpecifier();
      if (!modSpec) continue;
      const spec = decl.getModuleSpecifierValue();
      if (spec) {
        enqueueSpecifier(spec, filePath, queue, importStats, unresolvedImports, project);
      }
    }

    // Dynamic imports
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const exprText = call.getExpression().getText();
      const isImportCall = exprText === "import";
      const isRequireCall = exprText === "require";
      if (!isImportCall && !isRequireCall) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      const firstArg = args[0];
      const firstArgKind = firstArg.getKind();

      if (
        firstArgKind === SyntaxKind.StringLiteral ||
        firstArgKind === SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        const spec = typeof firstArg.getLiteralValue === "function"
          ? firstArg.getLiteralValue()
          : firstArg.getText().replace(/^['"`]|['"`]$/g, "");
        importStats.dynamic_literal++;
        enqueueSpecifier(spec, filePath, queue, importStats, unresolvedImports, project);
      } else {
        importStats.dynamic_non_literal++;
      }
    }
  }

  const reachableFunctionsTotal = Array.from(reachableFns.values()).reduce((s, v) => s + v, 0);
  const reachableBytesTotal = Array.from(reachableBytes.values()).reduce((s, v) => s + v, 0);

  const npmAudit = audit ? runNpmAudit(visitedFiles) : undefined;

  const callGraphFromEntry = entryName
    ? computeCallGraphFromEntry(emitAbsPath, entryName, project, SyntaxKind)
    : undefined;

  let tsMorphVersion = "unknown";
  try {
    const tsMorphPkgPath = join(BENCH_B10_ROOT, "node_modules", "ts-morph", "package.json");
    const tsMorphPkgPath2 = join(BENCH_B10_ROOT, "..", "..", "node_modules", "ts-morph", "package.json");
    const pkgPath = existsSync(tsMorphPkgPath) ? tsMorphPkgPath
      : existsSync(tsMorphPkgPath2) ? tsMorphPkgPath2 : null;
    if (pkgPath) {
      tsMorphVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
    }
  } catch (_) {}

  return {
    emit_path: emitAbsPath,
    entry_function: entryName ?? null,
    node_modules_root: nodeModulesRoot ?? null,
    reachable_functions: reachableFunctionsTotal,
    reachable_bytes: reachableBytesTotal,
    reachable_files: reachableFns.size,
    unique_non_builtin_imports: importStats.non_builtin_unique.size,
    builtin_imports: importStats.builtin,
    type_only_imports: importStats.type_only,
    dynamic_literal_imports: importStats.dynamic_literal,
    dynamic_non_literal_imports: importStats.dynamic_non_literal,
    unresolved_imports: unresolvedImports,
    ...(callGraphFromEntry !== undefined ? { call_graph_from_entry: callGraphFromEntry } : {}),
    ...(npmAudit !== undefined ? { npm_audit: npmAudit } : {}),
    ts_morph_version: tsMorphVersion,
    excluded_stdlib_files_seen: excludedStdlibFilesSeen,
    measured_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    emit: { type: "string" },
    entry: { type: "string" },
    "node-modules": { type: "string" },
    audit: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("measure-transitive-surface.mjs"));

if (isMain) {
  const EMIT_PATH = cliArgs["emit"];
  const ENTRY_NAME = cliArgs["entry"];
  const NODE_MODULES = cliArgs["node-modules"];
  const AUDIT = cliArgs["audit"] === true;
  const JSON_ONLY = cliArgs["json"] === true;

  if (!EMIT_PATH) {
    console.error("Usage: node measure-transitive-surface.mjs --emit <path> [--entry <fn>] [--node-modules <dir>] [--audit] [--json]");
    process.exit(1);
  }

  measureTransitiveSurface({
    emitPath: EMIT_PATH,
    entryName: ENTRY_NAME,
    nodeModulesRoot: NODE_MODULES,
    audit: AUDIT,
  }).then((result) => {
    if (JSON_ONLY) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log("=== B10: Transitive Surface Measurement ===");
      console.log(`  emit: ${result.emit_path}`);
      console.log(`  reachable_functions: ${result.reachable_functions}`);
      console.log(`  reachable_bytes: ${result.reachable_bytes}`);
      console.log(`  reachable_files: ${result.reachable_files}`);
      console.log(`  unique_non_builtin_imports: ${result.unique_non_builtin_imports}`);
      console.log(`  builtin_imports: ${result.builtin_imports}`);
      console.log(`  type_only_imports: ${result.type_only_imports}`);
      console.log(`  unresolved_imports: ${result.unresolved_imports.length}`);
      console.log(`  excluded_stdlib_files_seen: ${result.excluded_stdlib_files_seen}`);
      if (result.npm_audit) {
        console.log(`  npm_audit.cve_pattern_matches: ${result.npm_audit.cve_pattern_matches}`);
      }
      console.log();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  }).catch((err) => {
    console.error(`[measure-transitive-surface] Fatal: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
