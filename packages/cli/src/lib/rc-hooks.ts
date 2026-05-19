// SPDX-License-Identifier: MIT
//
// rc-hooks.ts — shared helpers for updating installedHooks in .yakccrc.json
//
// Called by standalone hooks-*-install.ts commands so the rc file reflects
// actual IDE hook state whether the install was done via `yakcc init` or
// directly via `yakcc hooks <ide> install`.
//
// Both helpers are idempotent: addInstalledHook deduplicates; removeInstalledHook
// is a no-op if the IDE name is absent or the rc file does not exist.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RC_FILENAME = ".yakccrc.json";
const DEFAULT_REGISTRY_SUBPATH = ".yakcc/registry.sqlite";

interface RcWithHooks {
  version: 1;
  registry: { path: string };
  installedHooks: string[];
  [key: string]: unknown;
}

function readRc(targetDir: string): RcWithHooks | null {
  const rcPath = join(targetDir, RC_FILENAME);
  if (!existsSync(rcPath)) return null;
  try {
    return JSON.parse(readFileSync(rcPath, "utf-8")) as RcWithHooks;
  } catch {
    return null;
  }
}

function writeRc(targetDir: string, rc: RcWithHooks): void {
  writeFileSync(join(targetDir, RC_FILENAME), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

/**
 * Add an IDE name to .yakccrc.json installedHooks (idempotent, deduped).
 *
 * @param createIfAbsent - When true (default), creates the rc file with minimal
 *   defaults if it does not exist. Pass false for global IDE installers
 *   (cline/continue/aider) when --target was not explicitly given, to avoid
 *   writing project config to an implicit working directory.
 */
export function addInstalledHook(
  targetDir: string,
  ideName: string,
  opts: { createIfAbsent?: boolean } = {},
): void {
  const createIfAbsent = opts.createIfAbsent !== false;
  const existing = readRc(targetDir);
  if (existing !== null) {
    existing.installedHooks = [...new Set([...(existing.installedHooks ?? []), ideName])];
    writeRc(targetDir, existing);
  } else if (createIfAbsent) {
    writeRc(targetDir, {
      version: 1,
      registry: { path: DEFAULT_REGISTRY_SUBPATH },
      installedHooks: [ideName],
    });
  }
}

/**
 * Remove an IDE name from .yakccrc.json installedHooks.
 * No-op when the rc file does not exist or the IDE name is absent.
 */
export function removeInstalledHook(targetDir: string, ideName: string): void {
  const existing = readRc(targetDir);
  if (existing === null) return;
  existing.installedHooks = (existing.installedHooks ?? []).filter((h) => h !== ideName);
  writeRc(targetDir, existing);
}
