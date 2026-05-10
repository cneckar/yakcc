// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave locate-root.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest
// harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3e)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from locate-root.ts):
//   locateProjectRoot (LR1.1) — async walk-up to find pnpm-workspace.yaml.
//
// Properties covered:
//   - Walk-up termination: returns a string within finite depth; never loops.
//   - Finds project root when pnpm-workspace.yaml exists at or above start.
//   - Fallback: returns `start` verbatim when no workspace file exists anywhere.
//   - Idempotent: root detected at start returns start itself (no extra traversal).
//   - Compound: multi-level walk finds the correct ancestor and the result is an
//     ancestor of (or equal to) the start path.

// ---------------------------------------------------------------------------
// Property-test corpus for locate-root.ts
// ---------------------------------------------------------------------------

import { mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { locateProjectRoot } from "./locate-root.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temporary directory prefix for one property run.
 *
 * Uses a random 10-char alphanumeric suffix so parallel property runs can't
 * collide on-disk.
 */
function makeTmpPrefix(): string {
  return join(os.tmpdir(), `locate-root-props-${Math.random().toString(36).slice(2, 12)}`);
}

/**
 * Build a chain of nested directories under `base`: base/seg[0]/seg[1]/...
 *
 * Returns the full path to the deepest directory after creating it.
 */
async function mkdirChain(base: string, segments: string[]): Promise<string> {
  let current = base;
  for (const seg of segments) {
    current = join(current, seg);
  }
  await mkdir(current, { recursive: true });
  return current;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A non-empty path segment that is valid on all POSIX platforms. */
const safeSegArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((s) => /^[a-z0-9_-]+$/i.test(s) && s !== "." && s !== "..");

/** A non-empty array of safe path segments (1-4 levels of nesting). */
const segmentsArb: fc.Arbitrary<string[]> = fc.array(safeSegArb, {
  minLength: 1,
  maxLength: 4,
});

// ---------------------------------------------------------------------------
// LR1.1: locateProjectRoot — fallback returns start when no workspace file found
// ---------------------------------------------------------------------------

/**
 * prop_locateProjectRoot_fallback_returns_start
 *
 * When no ancestor directory contains `pnpm-workspace.yaml`, locateProjectRoot
 * returns the `start` path verbatim (as a graceful degradation path for
 * standalone package installations and isolated test environments).
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): the fallback must be the
 * original `start`, not some synthetic path, so the cache directory degrades
 * to a writable location that the caller can still use.
 *
 * Production sequence: universalize() calls locateProjectRoot(process.cwd()) to
 * derive cacheDir; in a standalone package install with no workspace file, the
 * function must not throw and must return a usable path.
 */
export const prop_locateProjectRoot_fallback_returns_start = fc.asyncProperty(
  segmentsArb,
  async (segments) => {
    const base = makeTmpPrefix();
    let deepDir: string | undefined;
    try {
      deepDir = await mkdirChain(base, segments);
      // No pnpm-workspace.yaml written anywhere.
      const result = await locateProjectRoot(deepDir);
      return result === deepDir;
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// LR1.1: locateProjectRoot — detects workspace file at start itself
// ---------------------------------------------------------------------------

/**
 * prop_locateProjectRoot_detects_root_at_start
 *
 * When `pnpm-workspace.yaml` exists in the `start` directory itself,
 * locateProjectRoot returns `start` without any upward traversal.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): the in-place check happens
 * first in the loop. Returning the start directory immediately avoids
 * unnecessarily walking up to the filesystem root.
 */
export const prop_locateProjectRoot_detects_root_at_start = fc.asyncProperty(
  safeSegArb,
  async (dirName) => {
    const base = join(makeTmpPrefix(), dirName);
    try {
      await mkdir(base, { recursive: true });
      await writeFile(join(base, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      const result = await locateProjectRoot(base);
      return result === base;
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// LR1.1: locateProjectRoot — finds ancestor containing workspace file
// ---------------------------------------------------------------------------

/**
 * prop_locateProjectRoot_finds_ancestor_with_workspace_file
 *
 * When `pnpm-workspace.yaml` exists at an ancestor directory (not at start),
 * locateProjectRoot returns that ancestor directory, not the start directory.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): the function must walk up past
 * the start directory and stop at the first ancestor that contains the workspace
 * file — this is the correct project root.
 */
export const prop_locateProjectRoot_finds_ancestor_with_workspace_file = fc.asyncProperty(
  segmentsArb,
  async (segments) => {
    const rootDir = makeTmpPrefix();
    try {
      // Place workspace file at rootDir.
      await mkdir(rootDir, { recursive: true });
      await writeFile(join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      // Start from a deeply nested subdirectory.
      const deepDir = await mkdirChain(rootDir, segments);
      const result = await locateProjectRoot(deepDir);
      return result === rootDir;
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// LR1.1: locateProjectRoot — result is always a string
// ---------------------------------------------------------------------------

/**
 * prop_locateProjectRoot_returns_string
 *
 * locateProjectRoot always resolves to a non-empty string regardless of the
 * filesystem layout (workspace file present or absent).
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): the return type is Promise<string>
 * with no undefined branch. callers may store the result immediately as a path
 * without null-checking.
 */
export const prop_locateProjectRoot_returns_string = fc.asyncProperty(
  segmentsArb,
  async (segments) => {
    const base = makeTmpPrefix();
    let deepDir: string | undefined;
    try {
      deepDir = await mkdirChain(base, segments);
      const result = await locateProjectRoot(deepDir);
      return typeof result === "string" && result.length > 0;
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// Compound: result is always an ancestor of (or equal to) the start path
//
// Production sequence: universalize() passes a package sub-directory as `start`.
// The returned root is then used to construct the default cacheDir by joining
// `.yakcc-cache`. The result must therefore be an ancestor of start or start
// itself — a sibling or descendant path would produce an incorrect cache location.
// ---------------------------------------------------------------------------

/**
 * prop_locateProjectRoot_compound_result_is_ancestor_of_start
 *
 * For any filesystem layout (with or without pnpm-workspace.yaml), the result of
 * locateProjectRoot(start) is either `start` itself or an ancestor of `start`.
 * It is never a sibling directory, a descendant of `start`, or an unrelated path.
 *
 * This is the canonical compound-interaction property for locateProjectRoot: it
 * crosses the walk-up logic and the fallback behavior, verifying that both paths
 * satisfy the geometric invariant required by the cache directory derivation step.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): if the result is not an ancestor
 * of start, the downstream cache directory would be placed outside the project
 * tree — causing cache misses and potentially littering unrelated directories.
 */
export const prop_locateProjectRoot_compound_result_is_ancestor_of_start = fc.asyncProperty(
  segmentsArb,
  fc.boolean(),
  async (segments, placeWorkspaceFile) => {
    const rootDir = makeTmpPrefix();
    try {
      await mkdir(rootDir, { recursive: true });
      if (placeWorkspaceFile) {
        await writeFile(join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      }
      const deepDir = await mkdirChain(rootDir, segments);
      const result = await locateProjectRoot(deepDir);

      // The result must be a prefix of deepDir (ancestor or equal).
      // On POSIX, every ancestor of /a/b/c starts with /a (inclusive).
      // We add a trailing separator to avoid false prefix matches like
      // '/foo-bar' being a prefix of '/foo-bar-baz'.
      const resultNorm = result.endsWith("/") ? result : `${result}/`;
      const deepNorm = deepDir.endsWith("/") ? deepDir : `${deepDir}/`;
      return deepNorm.startsWith(resultNorm);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
