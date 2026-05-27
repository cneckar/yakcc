// SPDX-License-Identifier: MIT
//
// yakccrc.ts — single-source-of-truth helper for reading/mutating .yakccrc.json
//
// @decision DEC-CLI-YAKCCRC-AUTHORITY-001
// title: All .yakccrc.json read/write + installedHooks mutation goes through this module.
//        No command may read/write .yakccrc.json directly.
// status: accepted (WI-759)
// rationale:
//   Before WI-759, init.ts owned a private readRc/writeRc + inline merge; uninstall.ts
//   owned a parallel private readRc + inline filter; the 6 hooks-<ide>-install.ts modules
//   wrote nothing to .yakccrc.json at all (issue #759). Six new install/uninstall callers
//   need the same mutation. Sacred Practice #12 demands a single canonical authority for
//   the .yakccrc.json file. This module is that authority.
//
//   Field-preservation contract (EC-S2-I3, inherited from uninstall.ts): readers receive
//   the full parsed object; writers preserve every field they did not explicitly mutate.
//   addInstalledHook only touches `installedHooks`; removeInstalledHook only touches
//   `installedHooks`. version stays 1. mode/federation/registry pass through unchanged.
//
// Sub-decisions:
//   @decision DEC-CLI-YAKCCRC-CREATE-ON-INSTALL-001
//   title: If .yakccrc.json does not exist when addInstalledHook is called, the module
//          CREATES a minimal rc with version:1 and installedHooks:[ide].
//   status: accepted (WI-759)
//   rationale: AC3 explicitly requires file creation on standalone install. Refusing to
//     create on standalone install would require the user to run `yakcc init` first.
//
//   @decision DEC-CLI-YAKCCRC-PARSEFAIL-PASSTHROUGH-001
//   title: A corrupt .yakccrc.json (invalid JSON) is treated as absent; addInstalledHook
//          overwrites it with a fresh minimal rc.
//   status: accepted (WI-759)
//   rationale: Matches existing pre-WI-759 behavior in init.ts:122-127 and
//     uninstall.ts:99-103 (catch+null). Preserving swallow-and-overwrite semantics
//     keeps the refactor regression-free.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Config file written at the project root (see DEC-CLI-INIT-001). */
export const RC_FILENAME = ".yakccrc.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Embedding provider configuration stored in .yakccrc.json.
 *
 * Written by `yakcc init` when YAKCC_EMBEDDING_PROVIDER is set at init time.
 * Re-read by CLI commands to determine the active provider without requiring
 * env vars to be set on every invocation.
 *
 * @decision DEC-EMBED-ENV-RESOLUTION-001 (WI-778-BYO-EMBEDDING / issue #778)
 */
export interface YakccEmbeddingConfig {
  /** Provider kind: "openai", "voyage", "openai-compatible", or "local". */
  provider: string;
  /** Model name (e.g. "text-embedding-3-large"). */
  model?: string;
  /** Custom base URL for openai-compatible providers. */
  baseUrl?: string;
  /** Output dimension (required for openai-compatible; optional for others). */
  dimension?: number;
  /** Requested output dimension for OpenAI text-embedding-3-* models. */
  dimensions?: number;
}

/**
 * Flexible rc schema — only the fields this module mutates are typed; the rest
 * are preserved verbatim (EC-S2-I3: version stays 1, additive-only, no removal).
 */
export interface YakccRc {
  version: number;
  installedHooks?: string[];
  embeddings?: YakccEmbeddingConfig;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Read .yakccrc.json from target directory, or return null if absent/corrupt.
 *
 * Parse errors are silently swallowed — matches init.ts:122-127 and
 * uninstall.ts:99-103 pre-WI-759 behavior (DEC-CLI-YAKCCRC-PARSEFAIL-PASSTHROUGH-001).
 */
export function readRc(targetDir: string): YakccRc | null {
  const rcPath = join(targetDir, RC_FILENAME);
  if (!existsSync(rcPath)) return null;
  try {
    return JSON.parse(readFileSync(rcPath, "utf-8")) as YakccRc;
  } catch {
    return null;
  }
}

/**
 * Write .yakccrc.json to target directory (pretty-printed, trailing newline).
 *
 * Throws on filesystem write failure — the caller decides whether to log+continue
 * or propagate as exit-1.
 */
export function writeRc(targetDir: string, rc: YakccRc): void {
  writeFileSync(join(targetDir, RC_FILENAME), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// installedHooks mutations (AUTH-1 gate: only this module may write installedHooks)
// ---------------------------------------------------------------------------

/**
 * Append `ide` to `.yakccrc.json.installedHooks` at `targetDir`, deduplicated.
 *
 * Semantics (DEC-CLI-YAKCCRC-CREATE-ON-INSTALL-001):
 *   - If .yakccrc.json does not exist: CREATE a minimal rc with version=1 and
 *     installedHooks=[ide]. Other fields (mode, registry, federation) are left
 *     absent so `yakcc init` can populate them on next run.
 *   - If .yakccrc.json exists: read, merge ide into installedHooks (Set-dedup),
 *     write back preserving every other field verbatim (EC-S2-I3).
 *   - If .yakccrc.json is corrupt JSON: treat as absent and CREATE a minimal rc.
 *     Matches existing init.ts swallow-and-overwrite behavior
 *     (DEC-CLI-YAKCCRC-PARSEFAIL-PASSTHROUGH-001).
 *
 * Throws on filesystem write failure.
 *
 * @param targetDir - Absolute or relative path to the project root.
 * @param ide       - IDE name to add (e.g. "claude-code", "cursor").
 */
export function addInstalledHook(targetDir: string, ide: string): void {
  const existing = readRc(targetDir);

  let rc: YakccRc;
  if (existing !== null) {
    // Preserve all fields; only mutate installedHooks (EC-S2-I3).
    const currentHooks = Array.isArray(existing.installedHooks) ? existing.installedHooks : [];
    const merged = [...new Set([...currentHooks, ide])];
    rc = { ...existing, installedHooks: merged };
  } else {
    // File absent or corrupt — create minimal rc (DEC-CLI-YAKCCRC-CREATE-ON-INSTALL-001).
    rc = { version: 1, installedHooks: [ide] };
  }

  writeRc(targetDir, rc);
}

/**
 * Write the embedding provider configuration to `.yakccrc.json` at `targetDir`.
 *
 * Semantics (DEC-CLI-YAKCCRC-AUTHORITY-001):
 *   - If .yakccrc.json does not exist: CREATE a minimal rc with version=1 and
 *     the given embeddings config.
 *   - If .yakccrc.json exists: merge the embeddings field, preserving all
 *     other fields verbatim (EC-S2-I3).
 *   - If config is null: remove the embeddings field (resets to local default).
 *
 * @param targetDir - Absolute or relative path to the project root.
 * @param config    - Embedding config to persist, or null to clear.
 */
export function setEmbeddingsConfig(targetDir: string, config: YakccEmbeddingConfig | null): void {
  const existing = readRc(targetDir);
  let rc: YakccRc;
  if (existing !== null) {
    if (config === null) {
      const { embeddings: _dropped, ...rest } = existing;
      rc = rest as YakccRc;
    } else {
      rc = { ...existing, embeddings: config };
    }
  } else {
    rc = config !== null ? { version: 1, embeddings: config } : { version: 1 };
  }
  writeRc(targetDir, rc);
}

/**
 * Remove `ide` from `.yakccrc.json.installedHooks` at `targetDir`.
 *
 * Semantics:
 *   - If .yakccrc.json does not exist: no-op (do not create on uninstall).
 *   - If .yakccrc.json exists and installedHooks is absent or does not contain ide: no-op.
 *   - If .yakccrc.json exists and installedHooks contains ide: filter it out, write back
 *     preserving every other field verbatim (EC-S2-I3).
 *
 * Throws on filesystem write failure.
 *
 * @param targetDir - Absolute or relative path to the project root.
 * @param ide       - IDE name to remove (e.g. "claude-code", "cursor").
 */
export function removeInstalledHook(targetDir: string, ide: string): void {
  const existing = readRc(targetDir);

  // No-op if file absent or corrupt.
  if (existing === null) return;

  const currentHooks = Array.isArray(existing.installedHooks) ? existing.installedHooks : [];

  // No-op if ide not present.
  if (!currentHooks.includes(ide)) return;

  const filtered = currentHooks.filter((h) => h !== ide);
  const rc: YakccRc = { ...existing, installedHooks: filtered };

  writeRc(targetDir, rc);
}
