// SPDX-License-Identifier: Apache-2.0
/**
 * node-isolation.test.ts — assert the browser entry has no node-only deps.
 *
 * Why this matters: @yakcc/discovery-search is meant to be consumed by the
 * registry.yakcc.com browser explorer. Any transitive import of better-sqlite3,
 * ts-morph, sqlite-vec, or other Node-native modules would make the package
 * unbundleable in a browser context (DEC-1117-PLACEMENT-001).
 *
 * Approach: static source-text scan.
 *   - Read src/index.ts (the public barrel) and all files it re-exports from.
 *   - Assert none of those source texts import forbidden specifiers.
 *
 * This is a *real, failing-if-violated assertion* — not a comment. If a
 * future implementer adds `import ... from "better-sqlite3"` to any file in
 * the source graph rooted at src/index.ts, this test will catch it.
 *
 * The forbidden list mirrors the node-only deps confirmed present in
 * @yakcc/registry's full transitive closure (which includes better-sqlite3,
 * sqlite-vec, and ts-morph via @yakcc/contracts' deep barrel).
 *
 * @decision DEC-1117-PLACEMENT-001
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Source files in the package that form the browser entry's import graph.
// Index re-exports from embedder, score, tier, and search — those four files
// plus index itself constitute the full surface that ships to browsers.
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(__dirname, ".");
const BROWSER_SURFACE_FILES = [
  "index.ts",
  "embedder.ts",
  "score.ts",
  "tier.ts",
  "search.ts",
] as const;

// ---------------------------------------------------------------------------
// Forbidden node-only module specifiers
// ---------------------------------------------------------------------------

const FORBIDDEN_SPECIFIERS = [
  // Node-native packages — unbundleable in a browser context.
  "better-sqlite3",
  "sqlite-vec",
  "ts-morph",
  "node:child_process",
  "node:worker_threads",
  "node:os",
  "node:net",
  "node:http",
  "node:https",
  "node:crypto",
  "node:stream",
  "node:buffer",
  "node:process",
  // @yakcc/* barrel specifiers — both pull node-only transitive deps
  // (@yakcc/registry → better-sqlite3 + sqlite-vec;
  //  @yakcc/contracts → ts-morph via its deep barrel).
  // Test files are excluded from this scan (see BROWSER_SURFACE_FILES);
  // this only guards the shipped browser surface.
  "@yakcc/contracts",
  "@yakcc/registry",
] as const;

// ---------------------------------------------------------------------------
// Helper: collect all regex matches (avoids while-assign-in-expression)
// ---------------------------------------------------------------------------

function collectMatches(re: RegExp, text: string): string[] {
  const results: string[] = [];
  let lastIndex = 0;
  for (;;) {
    re.lastIndex = lastIndex;
    const m = re.exec(text);
    if (m === null) break;
    if (m[1] !== undefined) results.push(m[1]);
    // Advance past the match to avoid infinite loops on zero-length matches.
    lastIndex = re.lastIndex > lastIndex ? re.lastIndex : re.lastIndex + 1;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helper: read source text and scan for a forbidden specifier
// ---------------------------------------------------------------------------

function readSourceText(file: string): string {
  return readFileSync(resolve(SRC_DIR, file), "utf-8");
}

function findForbiddenImports(sourceText: string): string[] {
  const found: string[] = [];
  for (const spec of FORBIDDEN_SPECIFIERS) {
    // Match both static imports (import ... from "spec") and dynamic imports
    // (import("spec")) and require("spec") calls.
    const patterns = [
      new RegExp(`from\\s+["']${spec}["']`),
      new RegExp(`import\\(["']${spec}["']\\)`),
      new RegExp(`require\\(["']${spec}["']\\)`),
    ];
    if (patterns.some((re) => re.test(sourceText))) {
      found.push(spec);
    }
  }
  // Also catch any "node:" prefix not covered by the explicit list above.
  const nodeSpecifiers = [
    ...collectMatches(/from\s+["'](node:[a-z_/]+)["']/g, sourceText),
    ...collectMatches(/import\(["'](node:[a-z_/]+)["']\)/g, sourceText),
  ];
  for (const spec of nodeSpecifiers) {
    if (!found.includes(spec)) {
      found.push(spec);
    }
  }
  return found;
}

function collectImportSpecifiers(sourceText: string): string[] {
  return collectMatches(/from\s+["']([^"']+)["']/g, sourceText);
}

function collectAllImportSpecifiers(sourceText: string): string[] {
  return [
    ...collectMatches(/from\s+["']([^"']+)["']/g, sourceText),
    ...collectMatches(/import\(\s*["']([^"']+)["']\s*\)/g, sourceText),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("browser surface node-dep isolation (DEC-1117-PLACEMENT-001)", () => {
  for (const file of BROWSER_SURFACE_FILES) {
    it(`${file} imports no forbidden node-only specifiers`, () => {
      const source = readSourceText(file);
      const violations = findForbiddenImports(source);
      expect(violations).toEqual([]);
    });
  }

  it("score.ts has zero imports (pure module — no dependencies at all)", () => {
    // score.ts is documented as having no deps — verify statically.
    const source = readSourceText("score.ts");
    const hasImport = /^import\s/m.test(source);
    expect(hasImport).toBe(false);
  });

  it("tier.ts imports only from relative siblings (no external packages)", () => {
    const source = readSourceText("tier.ts");
    const specifiers = collectImportSpecifiers(source);
    // Every specifier must be a relative sibling (starts with "./" or "../")
    for (const spec of specifiers) {
      expect(spec, `tier.ts must not import external package: "${spec}"`).toMatch(/^\.\.?\//);
    }
  });

  it("search.ts imports only from relative siblings (no external node packages)", () => {
    const source = readSourceText("search.ts");
    const specifiers = collectImportSpecifiers(source);
    for (const spec of specifiers) {
      expect(spec, `search.ts must not import external package: "${spec}"`).toMatch(/^\.\.?\//);
    }
  });

  it("embedder.ts only uses @xenova/transformers as its external dep", () => {
    const source = readSourceText("embedder.ts");
    const specifiers = collectAllImportSpecifiers(source);
    // All specifiers must be either relative or @xenova/transformers
    for (const spec of specifiers) {
      const ok = spec.startsWith("./") || spec.startsWith("../") || spec === "@xenova/transformers";
      expect(ok, `unexpected import specifier in embedder.ts: "${spec}"`).toBe(true);
    }
  });
});
