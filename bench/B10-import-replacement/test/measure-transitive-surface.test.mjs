// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/test/measure-transitive-surface.test.mjs
//
// Evaluation Contract tests for the B10 transitive-surface resolver.
// 11 exact-count unit tests against committed synthetic fixtures with known surface.
// Each fixture has a hand-verified expected surface count documented inline.
//
// Run: node --test bench/B10-import-replacement/test/measure-transitive-surface.test.mjs
//
// @decision DEC-IRT-B10-METRIC-001 (tested here)
// See harness/measure-transitive-surface.mjs for the full decision annotation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "measure-transitive-surface.fixtures");
const HARNESS = join(__dirname, "..", "harness", "measure-transitive-surface.mjs");

// Lazy import of resolver (avoids ts-morph loading at module parse time)
let resolver = null;
async function getResolver() {
  if (!resolver) {
    const resolverPath = join(__dirname, "..", "harness", "measure-transitive-surface.mjs");
    const mod = await import(pathToFileURL(resolverPath).href);
    resolver = mod.measureTransitiveSurface;
  }
  return resolver;
}

// ---------------------------------------------------------------------------
// T1: Static import traversal — 2-package chain
// emit(1fn) -> pkg-a(2fns) -> pkg-b(3fns) = 6 total
// ---------------------------------------------------------------------------
describe("T1 static import traversal", () => {
  it("traverses a 2-package chain and counts exact function totals", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "static-chain", "emit.mjs"),
    });

    // emit has 1 fn (emitFn), pkg-a has 2 fns (doA, doA2), pkg-b has 3 fns (doB1, doB2, doB3)
    assert.equal(result.reachable_functions, 6, `expected 6 reachable_functions, got ${result.reachable_functions}`);
    // 3 files: emit.mjs + pkg-a/index.mjs + pkg-b/index.mjs
    assert.equal(result.reachable_files, 3, `expected 3 reachable_files, got ${result.reachable_files}`);
    // pkg-a is the only direct bare import from emit
    assert.ok(result.unique_non_builtin_imports >= 1, "expected >=1 unique_non_builtin_imports");
    // No unresolved imports
    assert.equal(result.unresolved_imports.length, 0, `expected 0 unresolved, got ${result.unresolved_imports.length}`);
    // reachable_bytes must be positive
    assert.ok(result.reachable_bytes > 0, "reachable_bytes should be positive");
    // Schema: measured_at is a valid ISO string
    assert.ok(typeof result.measured_at === "string" && result.measured_at.includes("T"), "measured_at should be ISO8601");
  });
});

// ---------------------------------------------------------------------------
// T2: Depth-unbounded prod-deps cutoff
// emit(1fn) -> prod-dep(2fns) -> deep-dep(1fn); dev-dep(4fns) excluded
// Expected total: 4 (NOT 8)
// ---------------------------------------------------------------------------
describe("T2 depth-unbounded prod-deps cutoff", () => {
  it("traverses 3-deep prod chain and excludes devDependencies", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "dev-dep-cutoff", "emit.mjs"),
    });

    // emit(1) + prod-dep(2) + deep-dep(1) = 4; dev-dep(4) excluded
    assert.equal(result.reachable_functions, 4,
      `expected 4 reachable_functions (devDep excluded), got ${result.reachable_functions}`);
    // 3 files: emit + prod-dep + deep-dep (dev-dep excluded)
    assert.equal(result.reachable_files, 3,
      `expected 3 reachable_files, got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T3: Cycle termination — a -> b -> a
// Must terminate; each file's functions counted exactly once
// emit(1) + pkg-a(1) + pkg-b(1) = 3
// ---------------------------------------------------------------------------
describe("T3 cycle termination", () => {
  it("terminates on circular imports and counts each file once", async () => {
    const measure = await getResolver();
    // If cycle guard is broken, this will hang. Node test runner timeout protects us.
    const result = await measure({
      emitPath: join(FIXTURES, "cycle", "emit.mjs"),
    });

    // emit(1) + pkg-a(1) + pkg-b(1) = 3
    assert.equal(result.reachable_functions, 3,
      `expected 3 reachable_functions (cycle counted once), got ${result.reachable_functions}`);
    // 3 unique files
    assert.equal(result.reachable_files, 3,
      `expected 3 reachable_files, got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T4: Re-export de-duplication
// barrel re-exports impl; impl's functions counted once (not twice)
// emit(1) + barrel(0 own) + impl(2) = 3
// ---------------------------------------------------------------------------
describe("T4 re-export de-duplication", () => {
  it("counts functions in impl once when re-exported via barrel", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "reexport", "emit.mjs"),
    });

    // emit(1) + barrel-pkg/index(0 own fns) + barrel-pkg/impl(2) = 3
    assert.equal(result.reachable_functions, 3,
      `expected 3 reachable_functions (re-export de-dup), got ${result.reachable_functions}`);
    // 3 files: emit + barrel/index + barrel/impl
    assert.equal(result.reachable_files, 3,
      `expected 3 reachable_files, got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T5: Type-only exclusion
// import type {} contributes 0 to fn/byte/file counts; increments type_only_imports
// emit(1fn) + 0 from type-only = 1
// ---------------------------------------------------------------------------
describe("T5 type-only exclusion", () => {
  it("excludes type-only imports from fn/byte/file counts", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "type-only", "emit.mjs"),
    });

    // emit has 1 fn (emitFn); typed-pkg is type-only -> not traversed
    assert.equal(result.reachable_functions, 1,
      `expected 1 reachable_function (type-only excluded), got ${result.reachable_functions}`);
    // Only emit.mjs traversed
    assert.equal(result.reachable_files, 1,
      `expected 1 reachable_file, got ${result.reachable_files}`);
    // type_only_imports must be incremented
    assert.ok(result.type_only_imports >= 1,
      `expected type_only_imports >= 1, got ${result.type_only_imports}`);
  });
});

// ---------------------------------------------------------------------------
// T6: Dynamic import handling
// literal import("dyn-pkg") -> traversed (dyn-pkg has 3 fns)
// import(pkgName) -> non-literal, NOT traversed
// emit(2fns) + dyn-pkg(3fns) = 5; dynamic_literal=1, dynamic_non_literal=1
// ---------------------------------------------------------------------------
describe("T6 dynamic import handling", () => {
  it("traverses literal dynamic imports and records non-literal as untraversed", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "dynamic-import", "emit.mjs"),
    });

    // emit has 2 fns; dyn-pkg has 3 fns via literal import("dyn-pkg")
    assert.equal(result.reachable_functions, 5,
      `expected 5 reachable_functions (literal dyn resolved), got ${result.reachable_functions}`);
    // dynamic_non_literal must be >= 1 (the import(pkgName) call)
    assert.ok(result.dynamic_non_literal_imports >= 1,
      `expected dynamic_non_literal_imports >= 1, got ${result.dynamic_non_literal_imports}`);
  });
});

// ---------------------------------------------------------------------------
// T7: Builtin + stdlib exclusion (U4 mitigation)
// node:fs, node:path -> builtin_imports, NOT traversed
// JSON.parse -> stdlib function, not a file import -> excluded_stdlib_files_seen unchanged
// emit(1fn); reachable_functions from builtin/stdlib edges = 0
// ---------------------------------------------------------------------------
describe("T7 builtin and stdlib exclusion", () => {
  it("excludes node builtins and stdlib edges from fn counts", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "builtin-stdlib", "emit.mjs"),
    });

    // emit has 1 fn (emitFn); node:fs and node:path are builtins -> excluded
    assert.equal(result.reachable_functions, 1,
      `expected 1 reachable_function (builtins excluded), got ${result.reachable_functions}`);
    // builtin_imports must be >= 2 (node:fs + node:path)
    assert.ok(result.builtin_imports >= 2,
      `expected builtin_imports >= 2, got ${result.builtin_imports}`);
    // No npm surface from builtins
    assert.equal(result.reachable_files, 1,
      `expected 1 reachable_file (only emit), got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T8: package.json#exports resolution
// modern-pkg uses exports map; "import" condition -> dist/esm.mjs (2 fns)
// NOT dist/cjs.js (3 fns)
// emit(1) + esm.mjs(2) = 3
// ---------------------------------------------------------------------------
describe("T8 package.json#exports resolution", () => {
  it("resolves the import condition from exports map", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "exports-map", "emit.mjs"),
    });

    // emit(1) + modern-pkg/dist/esm.mjs(2) = 3
    // If CJS was resolved instead: emit(1) + cjs.js(3) = 4 -> test catches wrong resolution
    assert.equal(result.reachable_functions, 3,
      `expected 3 reachable_functions (exports map resolves to ESM), got ${result.reachable_functions}`);
    assert.equal(result.reachable_files, 2,
      `expected 2 reachable_files, got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T9: Unresolvable import
// emit imports "nonexistent-pkg" which is not in node_modules
// Must land in unresolved_imports[], counted as 0, exit 0
// emit(1fn) reachable
// ---------------------------------------------------------------------------
describe("T9 unresolvable import", () => {
  it("records unresolvable imports and does not throw (conservative under-count)", async () => {
    const measure = await getResolver();
    // Must not throw
    const result = await measure({
      emitPath: join(FIXTURES, "unresolvable", "emit.mjs"),
    });

    // 1 unresolved import for "nonexistent-pkg"
    assert.ok(result.unresolved_imports.length >= 1,
      `expected >=1 unresolved_import, got ${result.unresolved_imports.length}`);
    const unresolved = result.unresolved_imports.find(u => u.specifier === "nonexistent-pkg");
    assert.ok(unresolved, "expected nonexistent-pkg in unresolved_imports");
    // emit's own function still counted
    assert.equal(result.reachable_functions, 1,
      `expected 1 reachable_function (emit only), got ${result.reachable_functions}`);
  });
});

// ---------------------------------------------------------------------------
// T10: Function-counting unit
// emit.mjs has: FunctionDeclaration(1), ArrowFunction(1), FunctionExpression(1),
//               Class with Constructor(1) + Method(1) + GetAccessor(1) + SetAccessor(1)
// Total: 7 body-bearing function nodes
// ---------------------------------------------------------------------------
describe("T10 function-counting unit", () => {
  it("counts exactly the body-bearing function node types", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "fn-counting", "emit.mjs"),
    });

    // 7 body-bearing nodes: declFn + arrowFn + exprFn + constructor + myMethod + get value + set value
    assert.equal(result.reachable_functions, 7,
      `expected 7 reachable_functions (all body-bearing types), got ${result.reachable_functions}`);
    assert.equal(result.reachable_files, 1,
      `expected 1 reachable_file (emit only), got ${result.reachable_files}`);
  });
});

// ---------------------------------------------------------------------------
// T11: npm-audit secondary metric
// vuln-pkg@1.2.3 matches planted advisory (>=1.0.0 <2.0.0)
// safe-pkg@2.0.0 does NOT match
// Expected: cve_pattern_matches=1, audit_source="offline-db"
// ---------------------------------------------------------------------------
describe("T11 npm-audit secondary metric", () => {
  it("matches a known vulnerability against the offline advisory DB", async () => {
    const measure = await getResolver();
    const result = await measure({
      emitPath: join(FIXTURES, "npm-audit", "emit.mjs"),
      audit: true,
    });

    assert.ok(result.npm_audit, "expected npm_audit field in result");
    assert.equal(result.npm_audit.ran, true, "expected npm_audit.ran=true");
    assert.equal(result.npm_audit.audit_source, "offline-db",
      `expected audit_source=offline-db, got ${result.npm_audit.audit_source}`);
    assert.equal(result.npm_audit.cve_pattern_matches, 1,
      `expected 1 cve_pattern_match (vuln-pkg), got ${result.npm_audit.cve_pattern_matches}`);
    const match = result.npm_audit.advisories[0];
    assert.ok(match, "expected at least 1 advisory match");
    assert.equal(match.package, "vuln-pkg", `expected package=vuln-pkg, got ${match.package}`);
    assert.equal(match.version, "1.2.3", `expected version=1.2.3, got ${match.version}`);
    assert.equal(match.cve, "CVE-2024-99999", `expected CVE-2024-99999, got ${match.cve}`);
  });
});


// ---------------------------------------------------------------------------
// T-CVE-DB-1: fixtures/npm-audit-db/advisories.json is the real pinned snapshot
//
// @decision DEC-BENCH-B10-SLICE3-CVE-METRIC-001
// @title S3 replaces synthetic 2-row advisory DB with real pinned snapshot
// @status accepted
// @rationale
//   S3 requirement: "fixtures/npm-audit-db/advisories.json is the real pinned snapshot
//   (NOT the S1 2-row synthetic placeholder); contains entries for the 11 covered packages
//   OR cve_pattern_matches == 0 is independently verifiable from npm audit."
//   This test verifies the DB was regenerated (not stub-edited) by checking:
//   - It is NOT the synthetic 2-row placeholder (no 'vuln-pkg' or 'other-pkg')
//   - It contains at least 1 real advisory with a GHSA ID
//   - All entries have package_name, vulnerable_versions, severity, title fields
//   - lodash is present (the only package with known advisories as of 2026-05-17)
//   Cross-references: plans/wi-512-s3-b10-broaden.md §8.1 T-CVE-DB-1
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from "node:fs";

const CVE_DB_PATH = join(__dirname, "..", "fixtures", "npm-audit-db", "advisories.json");

describe("T-CVE-DB-1: fixtures/npm-audit-db/advisories.json is real pinned snapshot", () => {
  let db;

  it("advisories.json exists", () => {
    assert.ok(existsSync(CVE_DB_PATH), "missing: " + CVE_DB_PATH);
    db = JSON.parse(readFileSync(CVE_DB_PATH, "utf8"));
    assert.ok(Array.isArray(db), "advisories.json must be an array");
  });

  it("does NOT contain synthetic placeholder packages (vuln-pkg, other-pkg)", () => {
    db = db ?? JSON.parse(readFileSync(CVE_DB_PATH, "utf8"));
    const syntheticPkgs = db.filter(
      (e) => e.package_name === "vuln-pkg" || e.package_name === "other-pkg"
    );
    assert.deepEqual(
      syntheticPkgs,
      [],
      "advisories.json still contains synthetic placeholder packages -- was not replaced"
    );
  });

  it("all entries have required fields: id, package_name, vulnerable_versions, severity, title", () => {
    db = db ?? JSON.parse(readFileSync(CVE_DB_PATH, "utf8"));
    for (const entry of db) {
      assert.ok(typeof entry.id === "string" && entry.id.length > 0,
        "entry missing id: " + JSON.stringify(entry).slice(0, 80));
      assert.ok(typeof entry.package_name === "string" && entry.package_name.length > 0,
        "entry missing package_name: " + entry.id);
      assert.ok(typeof entry.vulnerable_versions === "string" && entry.vulnerable_versions.length > 0,
        "entry missing vulnerable_versions: " + entry.id);
      assert.ok(typeof entry.severity === "string",
        "entry missing severity: " + entry.id);
      assert.ok(typeof entry.title === "string" && entry.title.length > 0,
        "entry missing title: " + entry.id);
    }
  });

  it("contains at least one real GHSA advisory (id starts with GHSA-)", () => {
    db = db ?? JSON.parse(readFileSync(CVE_DB_PATH, "utf8"));
    const realAdvisories = db.filter((e) => e.id && e.id.startsWith("GHSA-"));
    assert.ok(
      realAdvisories.length >= 1,
      "Expected at least 1 real GHSA advisory, found: " + db.map((e) => e.id).join(", ")
    );
  });

  it("lodash is present in the DB (lodash@4.17.21 has known advisories)", () => {
    db = db ?? JSON.parse(readFileSync(CVE_DB_PATH, "utf8"));
    const lodashEntries = db.filter((e) => e.package_name === "lodash");
    assert.ok(
      lodashEntries.length >= 1,
      "Expected lodash advisory entries in real pinned DB (npm audit shows 3 for lodash@4.17.21)"
    );
  });
});