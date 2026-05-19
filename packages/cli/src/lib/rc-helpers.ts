// SPDX-License-Identifier: MIT
//
// rc-helpers.ts — shared helpers for reading/writing .yakccrc.json installedHooks
//
// @decision DEC-CLI-RC-BOOKKEEPING-001
// title: Shared updateInstalledHooks/removeInstalledHooks helpers so standalone
//        hooks-*-install commands update .yakccrc.json consistently with `yakcc init`
// status: accepted (closes #759)
// rationale:
//   The standalone install commands (hooks-install.ts, hooks-cursor-install.ts,
//   hooks-windsurf-install.ts, hooks-cline-install.ts, hooks-continue-install.ts,
//   hooks-aider-install.ts) previously never read or wrote .yakccrc.json, leaving
//   installedHooks stale when hooks were installed outside `yakcc init`.
//   A shared helper avoids six copy-pasted merge loops and keeps the rc format
//   consistent with what init.ts already writes.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RC_FILENAME = ".yakccrc.json";

interface RcFile {
  version: number;
  installedHooks?: string[];
  [key: string]: unknown;
}

function readRcFile(targetDir: string): RcFile | null {
  const p = join(targetDir, RC_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as RcFile;
  } catch {
    return null;
  }
}

function writeRcFile(targetDir: string, rc: RcFile): void {
  writeFileSync(join(targetDir, RC_FILENAME), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

/**
 * Idempotently adds ide names to .yakccrc.json installedHooks in targetDir.
 * Creates a minimal rc file if none exists. Non-fatal on write error.
 */
export function updateInstalledHooks(targetDir: string, idesToAdd: string[]): void {
  if (idesToAdd.length === 0) return;
  const rc = readRcFile(targetDir);
  try {
    if (rc === null) {
      writeRcFile(targetDir, {
        version: 1,
        registry: { path: ".yakcc/registry.sqlite" },
        installedHooks: [...new Set(idesToAdd)],
      });
    } else {
      const existing = rc.installedHooks ?? [];
      writeRcFile(targetDir, {
        ...rc,
        installedHooks: [...new Set([...existing, ...idesToAdd])],
      });
    }
  } catch {
    // Non-fatal: the IDE-specific install already succeeded; rc update is best-effort.
  }
}

/**
 * Removes ide names from .yakccrc.json installedHooks in targetDir.
 * No-op if no rc file exists. Non-fatal on write error.
 */
export function removeInstalledHooks(targetDir: string, idesToRemove: string[]): void {
  if (idesToRemove.length === 0) return;
  const rc = readRcFile(targetDir);
  if (rc === null) return;
  const existing = rc.installedHooks ?? [];
  const filtered = existing.filter((h) => !idesToRemove.includes(h));
  try {
    writeRcFile(targetDir, { ...rc, installedHooks: filtered });
  } catch {
    // Non-fatal.
  }
}
