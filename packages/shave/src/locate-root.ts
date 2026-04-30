// Locate the project root by walking up the directory tree looking for
// pnpm-workspace.yaml. This file is present in the root of every pnpm
// monorepo, making it a reliable anchor for the project root regardless of
// which package the calling code lives in.
//
// Rule: walk up from `start` until a directory containing pnpm-workspace.yaml
// is found. If none is found (reached filesystem root), fall back to `start`.
// This means the cache directory degrades gracefully in non-monorepo contexts
// (e.g. unit tests, isolated package installations).

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Walk up the directory tree from `start` (default: process.cwd()) looking
 * for a directory that contains `pnpm-workspace.yaml`.
 *
 * Returns the first matching ancestor directory. Falls back to `start` if no
 * workspace file is found (e.g. standalone package installation or test env).
 *
 * @param start - Starting directory for the upward walk. Defaults to process.cwd().
 * @returns Absolute path of the project root directory.
 */
export async function locateProjectRoot(start?: string): Promise<string> {
  const origin = start ?? process.cwd();
  let current = origin;

  for (;;) {
    const candidate = join(current, "pnpm-workspace.yaml");
    try {
      await access(candidate);
      // File exists — this is the project root.
      return current;
    } catch {
      // Not found here; walk up.
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding the workspace file.
      // Fall back to the starting directory.
      return origin;
    }
    current = parent;
  }
}
