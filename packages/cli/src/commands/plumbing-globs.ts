// SPDX-License-Identifier: MIT
// plumbing-globs.ts — Single-authority glob set for workspace plumbing capture.
//
// @decision DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001
// @title Bootstrap captures plumbing files via a single named glob set
// @status decided (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale The set of files that constitute "workspace plumbing" (non-atom
//   files needed to make a recompiled workspace pnpm-installable and buildable)
//   must be declared in exactly one place. Hand-curating individual file paths
//   would silently break recompilation when new packages or config files are
//   added. A named glob set in this dedicated module is the single authority.
//
//   Included files: package.json (root + per-package + per-example),
//   tsconfig*.json, pnpm-workspace.yaml, pnpm-lock.yaml, .npmrc, biome.json,
//   vitest.config.ts (root + per-package), README.md in packages/ and examples/.
//
//   Explicitly excluded: node_modules/, dist/, .git/, .worktrees/, tmp/,
//   coverage/, bootstrap/ (self-reference avoidance — bootstrap/expected-roots.json
//   is the comparison target, not a plumbing file).
//
//   Also excluded per R7 (Risk 7 in plan.md): packages/*/src/foreign/**/*.ts
//   wrapper files that are not atoms must be captured separately. However,
//   in the current corpus, foreign wrappers ARE shaved atoms and appear in
//   the blocks table. If a file is both a TS source and a plumbing file the
//   TS source wins (atoms/ directory reconstruction covers it).
//
//   The reviewer verifies: (a) this is the only module that declares plumbing
//   inclusion; (b) after bootstrap, workspace_plumbing has zero rows matching
//   bootstrap/, node_modules/, dist/, .git/, .worktrees/, tmp/, coverage/.

/**
 * Glob patterns for files to include in workspace_plumbing capture.
 *
 * Evaluated relative to the workspace root using micromatch / picomatch
 * semantics. Each pattern is a workspace-relative glob.
 *
 * SINGLE AUTHORITY: no other module may declare a plumbing-inclusion rule.
 * Adding a new bootable non-atom file type? Add it here.
 */
export const PLUMBING_INCLUDE_GLOBS: readonly string[] = [
  // Root-level config files
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "biome.json",
  "vitest.config.ts",
  ".npmrc",
  // Per-package and per-example config files
  "packages/*/package.json",
  "packages/*/tsconfig.json",
  "packages/*/tsconfig.*.json",
  "packages/*/vitest.config.ts",
  "packages/*/biome.json",
  "packages/*/.npmrc",
  "examples/*/package.json",
  "examples/*/tsconfig.json",
  "examples/*/tsconfig.*.json",
  "examples/*/vitest.config.ts",
  "examples/*/biome.json",
  "examples/*/.npmrc",
  // README files (not bootable, but useful for workspace context)
  // NOTE: deliberately omitted per plan.md §DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001:
  //   "packages/*/README.md is NOT captured (not bootable; documentation only)."
];

/**
 * Path segments and prefixes to exclude from workspace_plumbing capture.
 *
 * A captured file path (workspace-relative, forward-slash-separated) is
 * excluded if it contains ANY of these segments as a path component.
 * This is a fast O(n) segment-based filter rather than glob matching.
 *
 * SINGLE AUTHORITY: add new exclusions here, not in the bootstrap walker.
 */
export const PLUMBING_EXCLUDE_SEGMENTS: readonly string[] = [
  "node_modules",
  "dist",
  ".git",
  ".worktrees",
  "tmp",
  "coverage",
  ".nyc_output",
];

/**
 * Path prefixes that disqualify a file from capture.
 *
 * A captured file whose workspace-relative path starts with any of these
 * prefixes is excluded. Used to prevent self-referential capture.
 */
export const PLUMBING_EXCLUDE_PREFIXES: readonly string[] = [
  "bootstrap/", // self-reference avoidance (R6 in plan.md): the registry and
  // expected-roots.json live here; capturing them would be circular.
];

/**
 * Returns true if the workspace-relative path passes the plumbing exclusion rules.
 * A file that passes may still be filtered by PLUMBING_INCLUDE_GLOBS.
 */
export function plumbingPathAllowed(workspaceRelPath: string): boolean {
  const normalized = workspaceRelPath.replace(/\\/g, "/");

  // Reject excluded prefixes (bootstrap/, etc.).
  for (const prefix of PLUMBING_EXCLUDE_PREFIXES) {
    if (normalized.startsWith(prefix)) return false;
  }

  // Reject paths containing excluded segments.
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (PLUMBING_EXCLUDE_SEGMENTS.includes(segment)) return false;
  }

  return true;
}
