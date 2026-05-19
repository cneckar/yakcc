// SPDX-License-Identifier: MIT
//
// Shared helpers for reading and writing .yakccrc.json.
//
// @decision DEC-CLI-RC-HELPERS-001
// title: rc.ts is the single source of truth for YakccRc I/O; consumers import
//        readRc, writeRc, and updateInstalledHooks instead of duplicating them
// status: accepted (closes #759)
// rationale:
//   init.ts and uninstall.ts each duplicated readRc/writeRc/YakccRc locally.
//   Six standalone hooks-*-install.ts commands had no rc access at all, so
//   .yakccrc.json silently lied about installedHooks after a standalone install.
//   Extracting to lib/rc.ts fixes the duplication and gives every install command
//   a single import to update the rc file correctly.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RC_FILENAME = ".yakccrc.json";
const DEFAULT_REGISTRY_SUBPATH = ".yakcc/registry.sqlite";

/** Shape of .yakccrc.json (version 1, additive-only per DEC-CLI-INIT-002). */
export interface YakccRc {
  version: 1;
  mode?: string;
  registry: { path: string };
  federation?: { peers: string[] };
  installedHooks?: string[];
  [key: string]: unknown;
}

/** Read .yakccrc.json from targetDir, or return null if absent/corrupt. */
export function readRc(targetDir: string): YakccRc | null {
  const rcPath = join(targetDir, RC_FILENAME);
  if (!existsSync(rcPath)) return null;
  try {
    return JSON.parse(readFileSync(rcPath, "utf-8")) as YakccRc;
  } catch {
    return null;
  }
}

/** Write .yakccrc.json to targetDir. */
export function writeRc(targetDir: string, rc: YakccRc): void {
  writeFileSync(join(targetDir, RC_FILENAME), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

/**
 * Add or remove an IDE name from .yakccrc.json installedHooks.
 *
 * "add": merges ideName into the array (idempotent, deduped).
 *        Creates a minimal rc if the file doesn't exist yet.
 * "remove": removes ideName from the array (idempotent).
 *           No-ops when the rc file is absent.
 *
 * Write errors are swallowed — the caller's primary install already succeeded,
 * and uninstall.ts Tier 3 detection recovers from a stale rc.
 */
export function updateInstalledHooks(
  targetDir: string,
  ideName: string,
  op: "add" | "remove",
): void {
  try {
    const existing = readRc(targetDir);
    if (op === "add") {
      if (existing !== null) {
        const hooks = existing.installedHooks ?? [];
        if (hooks.includes(ideName)) return;
        writeRc(targetDir, { ...existing, installedHooks: [...hooks, ideName] });
      } else {
        writeRc(targetDir, {
          version: 1,
          registry: { path: DEFAULT_REGISTRY_SUBPATH },
          installedHooks: [ideName],
        });
      }
    } else {
      if (existing === null) return;
      const hooks = existing.installedHooks ?? [];
      if (!hooks.includes(ideName)) return;
      writeRc(targetDir, { ...existing, installedHooks: hooks.filter((h) => h !== ideName) });
    }
  } catch {
    // Non-fatal — Tier 3 filesystem detection in uninstall.ts provides fallback coverage.
  }
}
