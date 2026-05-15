// SPDX-License-Identifier: MIT
/**
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001
 * title: Module resolver for dependency-following shave engine (WI-510 Slice 1)
 * status: decided
 * rationale:
 *   This module provides the resolver used by the module-graph orchestration
 *   layer (module-graph.ts). It maps an import/require specifier to an
 *   absolute on-disk source file path, respecting:
 *     1. Relative paths (./foo, ../bar) — resolved from the importing file's dir.
 *     2. package.json#exports conditional maps (node, require, import, default).
 *     3. package.json#main fallback.
 *     4. Index file fallback (index.js, index.ts, index.cjs, index.mjs).
 *     5. Extension probing (.js → .ts, .mjs → .mts, etc.) for TypeScript source.
 *   Unresolvable specifiers return the sentinel `UNRESOLVABLE` signal — they
 *   do NOT throw. Best-effort discipline per DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001.
 *
 * @decision DEC-WI510-RECURSION-SCOPE-B-001
 * title: B-scope predicate — isInPackageBoundary
 * status: decided
 * rationale:
 *   The B-scope predicate is a single named function: isInPackageBoundary(resolvedPath, packageRoot).
 *   It returns true iff the resolved absolute path is within the package root directory.
 *   This is the ONLY place the B-scope check is performed — the orchestration layer
 *   calls it at each edge and treats edges outside the boundary as ForeignLeafEntry stubs.
 *   C-track follow-on extends this single predicate; the rest of the engine is unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Project, ScriptKind, SyntaxKind } from "ts-morph";
import type { CallExpression } from "ts-morph";

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

/**
 * Returned by resolveModuleEdge when the specifier cannot be resolved to an
 * on-disk source file. Callers degrade this edge to a ForeignLeafEntry stub.
 *
 * Using a branded symbol sentinel avoids throwing on unresolvable specifiers
 * (best-effort discipline: DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001).
 */
export const UNRESOLVABLE = Symbol("UNRESOLVABLE");
export type UnresolvableSignal = typeof UNRESOLVABLE;

// ---------------------------------------------------------------------------
// Extension probe table
// ---------------------------------------------------------------------------

/** Ordered list of candidate extensions to try when a specifier has no extension. */
const EXTENSION_PROBE_ORDER = [
  ".ts",
  ".js",
  ".mts",
  ".mjs",
  ".cjs",
  ".cts",
  ".tsx",
  ".jsx",
] as const;

/**
 * When a specifier ends in .js or .mjs, also probe the TypeScript equivalent
 * (.ts / .mts) first — TypeScript sources in node_modules may be referenced
 * via their compiled extension by package.json#exports.
 */
const JS_TO_TS_MAP: Record<string, string> = {
  ".js": ".ts",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Probe for an existing file at `base` trying multiple extensions when needed.
 * Returns the first existing normalized path or undefined.
 */
export function probeFile(base: string): string | undefined {
  if (existsSync(base) && !base.endsWith("/") && !base.endsWith("\\")) {
    return normalize(base);
  }

  const ext = extname(base);

  // Try TypeScript twin first (e.g. .js → .ts)
  const tsTwin = JS_TO_TS_MAP[ext];
  if (tsTwin !== undefined) {
    const twin = base.slice(0, -ext.length) + tsTwin;
    if (existsSync(twin)) return normalize(twin);
  }

  // Try without extension → then with each extension in probe order
  if (ext.length === 0) {
    for (const probe of EXTENSION_PROBE_ORDER) {
      const candidate = base + probe;
      if (existsSync(candidate)) return normalize(candidate);
    }
  }

  return undefined;
}

/**
 * Resolve an index file in a directory.
 * Probes index.js, index.ts, index.cjs, index.mjs, index.mts.
 */
export function probeIndex(dir: string): string | undefined {
  for (const ext of EXTENSION_PROBE_ORDER) {
    const candidate = join(dir, `index${ext}`);
    if (existsSync(candidate)) return normalize(candidate);
  }
  return undefined;
}

/**
 * Walk a package.json#exports field to find the best match for a given sub-path.
 * Supports both string values and conditional export maps.
 *
 * @param exportsField - The value of package.json#exports.
 * @param subPath      - The sub-path being imported (e.g. "." or "./lib/foo").
 * @param packageRoot  - Absolute path to the package root directory.
 * @returns Absolute path to the resolved file, or undefined.
 */
export function resolveFromExports(
  exportsField: unknown,
  subPath: string,
  packageRoot: string,
): string | undefined {
  if (typeof exportsField === "string") {
    // exports: "./index.js" — only valid for sub-path "."
    if (subPath !== ".") return undefined;
    return probeFile(join(packageRoot, exportsField));
  }

  if (typeof exportsField !== "object" || exportsField === null) return undefined;

  const exports = exportsField as Record<string, unknown>;

  // Direct sub-path key lookup (e.g. exports["./lib/foo"])
  if (subPath in exports) {
    return resolveExportValue(exports[subPath], packageRoot);
  }

  // For "." (default entry), fall through to conditional map resolution when
  // no sub-path keys (starting with ".") are present in the exports map.
  if (subPath === "." && !Object.keys(exports).some((k) => k.startsWith("."))) {
    // Treat the whole object as a conditional map for "."
    return resolveExportValue(exportsField, packageRoot);
  }

  return undefined;
}

/**
 * Resolve a single exports value — handles string and conditional object maps.
 * Conditions prioritized: node, require, import, default.
 */
export function resolveExportValue(value: unknown, packageRoot: string): string | undefined {
  if (typeof value === "string") {
    return probeFile(join(packageRoot, value));
  }
  if (typeof value === "object" && value !== null) {
    const map = value as Record<string, unknown>;
    // Priority: node → require → import → default
    for (const condition of ["node", "require", "import", "default"]) {
      if (condition in map) {
        const resolved = resolveExportValue(map[condition], packageRoot);
        if (resolved !== undefined) return resolved;
      }
    }
  }
  return undefined;
}

/**
 * Read and parse a package.json file. Returns undefined on any error.
 */
export function readPackageJson(pkgJsonPath: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(pkgJsonPath, "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// B-scope predicate (single authority — DEC-WI510-RECURSION-SCOPE-B-001)
// ---------------------------------------------------------------------------

/**
 * Returns true iff `resolvedPath` is within `packageRoot` (the B-scope predicate).
 *
 * This is the SINGLE named function for the within-package-boundary check.
 * The C-track follow-on extends exactly this predicate — no other sites need
 * to be changed to enable C-scope.
 *
 * @param resolvedPath - Absolute normalized path of the resolved module.
 * @param packageRoot  - Absolute normalized path of the target package root.
 */
export function isInPackageBoundary(resolvedPath: string, packageRoot: string): boolean {
  // Normalize both paths to forward-slashes and lowercase for reliable comparison
  // on Windows (NTFS is case-insensitive; backslash/forward-slash mixing is common).
  // Add a trailing slash to packageRoot to prevent prefix false-positives:
  //   /pkg/root-extra/foo.js must NOT match /pkg/root/
  const normalRoot = `${normalize(packageRoot).replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const normalPath = normalize(resolvedPath).replace(/\\/g, "/");
  return normalPath.toLowerCase().startsWith(normalRoot.toLowerCase());
}

// ---------------------------------------------------------------------------
// Primary resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a module specifier from an importing file to an absolute path.
 *
 * Handles:
 *   - Relative specifiers (./foo, ../bar): resolved from importerDir.
 *   - Bare package specifiers: for B-scope, only resolves when the specifier
 *     is the package's own name (self-reference). External packages return
 *     UNRESOLVABLE and the orchestration layer converts them to ForeignLeafEntry.
 *
 * Returns UNRESOLVABLE when the specifier cannot be resolved — does NOT throw.
 * (Best-effort discipline: DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001)
 *
 * @param specifier   - The module specifier as written in the source.
 * @param importerDir - Absolute directory of the importing file.
 * @param packageRoot - Absolute root of the target package.
 */
export function resolveModuleEdge(
  specifier: string,
  importerDir: string,
  packageRoot: string,
): string | UnresolvableSignal {
  try {
    // ---- Relative import ----
    if (specifier.startsWith(".")) {
      const candidate = resolve(importerDir, specifier);
      const found = probeFile(candidate) ?? probeIndex(candidate);
      return found ?? UNRESOLVABLE;
    }

    // ---- Package import (bare name or scoped) ----
    // For B-scope we only attempt to resolve within the target packageRoot.
    // Non-relative specifiers that refer to external packages fall through
    // to UNRESOLVABLE — the orchestration layer converts them to ForeignLeafEntry.
    // If the specifier IS the package itself (same package name), we resolve
    // via its own package.json.

    const pkgJsonPath = join(packageRoot, "package.json");
    const pkgJson = readPackageJson(pkgJsonPath);
    if (pkgJson === undefined) return UNRESOLVABLE;

    // Only resolve if the specifier matches this package's own name (self-reference)
    const pkgName = pkgJson.name;
    if (specifier !== pkgName) return UNRESOLVABLE;

    // Resolve via exports > main > index
    const exportsField = pkgJson.exports;
    if (exportsField !== undefined) {
      const via = resolveFromExports(exportsField, ".", packageRoot);
      if (via !== undefined) return via;
    }
    const main = pkgJson.main;
    if (typeof main === "string") {
      const mainPath = probeFile(join(packageRoot, main));
      if (mainPath !== undefined) return mainPath;
    }
    const idx = probeIndex(packageRoot);
    return idx ?? UNRESOLVABLE;
  } catch {
    return UNRESOLVABLE;
  }
}

/**
 * Given a package root directory, resolve its entry-point source file.
 * Used by the module-graph orchestration layer to start the walk from the
 * package's own entry point.
 *
 * Priority: package.json#exports["."] → package.json#main → index probe.
 * Returns UNRESOLVABLE when the entry cannot be resolved.
 */
export function resolvePackageEntry(packageRoot: string): string | UnresolvableSignal {
  try {
    const pkgJsonPath = join(packageRoot, "package.json");
    const pkgJson = readPackageJson(pkgJsonPath);
    if (pkgJson === undefined) return UNRESOLVABLE;

    const exportsField = pkgJson.exports;
    if (exportsField !== undefined) {
      const via = resolveFromExports(exportsField, ".", packageRoot);
      if (via !== undefined) return via;
    }
    const main = pkgJson.main;
    if (typeof main === "string") {
      const mainPath = probeFile(join(packageRoot, main));
      if (mainPath !== undefined) return mainPath;
    }
    return probeIndex(packageRoot) ?? UNRESOLVABLE;
  } catch {
    return UNRESOLVABLE;
  }
}

/**
 * Extract require() call specifiers from CommonJS source text using ts-morph AST.
 *
 * Walks the AST looking for `require('<specifier>')` calls and extracts
 * the string literal argument. Returns a deduplicated sorted array of
 * specifiers found in the source.
 *
 * Does NOT throw on unparseable source — returns empty array (best-effort).
 * Sorted for determinism: DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001 point 5.
 *
 * @param source   - Source text (JS or TS).
 * @param filePath - Logical file path (used for ScriptKind detection only).
 */
export function extractRequireSpecifiers(source: string, filePath: string): readonly string[] {
  try {
    const scriptKind = /\.(ts|tsx|mts|cts)$/i.test(filePath) ? ScriptKind.TS : ScriptKind.JS;
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, noEmit: true },
    });
    const sf = project.createSourceFile("__req__.js", source, { scriptKind });

    const specifiers = new Set<string>();
    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node as CallExpression;
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.Identifier) return;
      if (expr.getText() !== "require") return;
      const args = call.getArguments();
      if (args.length !== 1) return;
      const arg = args[0];
      if (arg === undefined) return;
      if (arg.getKind() !== SyntaxKind.StringLiteral) return;
      // Strip surrounding quotes
      const raw = arg.getText();
      const spec = raw.slice(1, -1);
      if (spec.length > 0) specifiers.add(spec);
    });

    // Return sorted for determinism
    return [...specifiers].sort();
  } catch {
    return [];
  }
}

/**
 * Extract ES module import specifiers from TypeScript/JavaScript source using ts-morph.
 *
 * Returns a deduplicated sorted array of specifiers from all static
 * ImportDeclaration nodes in the source. Type-only imports are excluded.
 * Does NOT throw on unparseable source — returns empty array (best-effort).
 */
export function extractImportSpecifiers(source: string, filePath: string): readonly string[] {
  try {
    const scriptKind = /\.(ts|tsx|mts|cts)$/i.test(filePath) ? ScriptKind.TS : ScriptKind.JS;
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, noEmit: true },
    });
    const sf = project.createSourceFile("__imp__.ts", source, { scriptKind });

    const specifiers = new Set<string>();
    for (const decl of sf.getImportDeclarations()) {
      if (decl.isTypeOnly()) continue;
      const spec = decl.getModuleSpecifierValue();
      specifiers.add(spec);
    }
    return [...specifiers].sort();
  } catch {
    return [];
  }
}
