// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: The intent cache uses a two-level
// directory structure (<cacheDir>/<key[0..2]>/<key>.json) to avoid filesystem
// performance degradation with large numbers of files in a single directory.
// Writes are atomic: content goes to a .tmp.<random> file then renamed into
// place, so a concurrent reader never sees a partial write.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Atomic rename is the standard POSIX durability pattern. The
// two-level sharding mirrors content-addressable stores like Git's object DB.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntentCard } from "../intent/types.js";
import { renameWithRetry } from "./atomic-write.js";

/**
 * Compute the shard directory (first 3 hex chars of the key) and full file
 * path for a given cache key.
 */
function cachePaths(cacheDir: string, cacheKey: string): { shardDir: string; filePath: string } {
  const shard = cacheKey.slice(0, 3);
  const shardDir = join(cacheDir, shard);
  const filePath = join(shardDir, `${cacheKey}.json`);
  return { shardDir, filePath };
}

/**
 * Read a cached intent card from disk.
 *
 * Returns the raw parsed JSON value (unvalidated) on a cache hit, or
 * `undefined` on a miss (ENOENT). If the file exists but cannot be parsed,
 * logs a warning, deletes the corrupt entry, and returns `undefined`.
 *
 * Validation against the IntentCard schema is the caller's responsibility
 * (extractIntent calls validateIntentCard after readIntent returns).
 *
 * @param cacheDir - Root cache directory (e.g. <projectRoot>/.yakcc/shave-cache/intent/).
 * @param cacheKey - 64-char hex key produced by keyFromIntentInputs().
 * @returns Parsed JSON value, or undefined on miss.
 */
export async function readIntent(cacheDir: string, cacheKey: string): Promise<unknown | undefined> {
  const { filePath } = cachePaths(cacheDir, cacheKey);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    // Stat or permission error — treat as miss; warn.
    console.warn(`[shave cache] Failed to read cache file ${filePath}:`, err);
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    console.warn(`[shave cache] Corrupt cache entry at ${filePath}; deleting.`);
    await unlink(filePath).catch(() => {
      // Best-effort delete; ignore failures.
    });
    return undefined;
  }
}

/**
 * Atomically write an IntentCard to the cache.
 *
 * Steps:
 *   1. Ensure the shard directory exists (mkdir -p).
 *   2. Write JSON to `<key>.json.tmp.<random>`.
 *   3. Rename the tmp file to `<key>.json`.
 *   4. On rename failure, attempt to unlink the tmp file and rethrow.
 *
 * Concurrent readers will see either the old file or the new file, never a
 * partial write.
 *
 * @param cacheDir - Root cache directory.
 * @param cacheKey - 64-char hex key.
 * @param value - Validated IntentCard to persist.
 */
export async function writeIntent(
  cacheDir: string,
  cacheKey: string,
  value: IntentCard,
): Promise<void> {
  const { shardDir, filePath } = cachePaths(cacheDir, cacheKey);

  await mkdir(shardDir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${Math.random().toString(36).slice(2)}`;
  const json = JSON.stringify(value, null, 2);

  await writeFile(tmpPath, json, "utf-8");

  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    // Rename failed — clean up the tmp file to avoid orphaned partials.
    await unlink(tmpPath).catch(() => {
      // Best-effort; ignore cleanup failures.
    });
    throw err;
  }
}

/** Type guard for ENOENT errors from Node.js fs operations. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
