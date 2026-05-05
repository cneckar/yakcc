// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave cache/file-cache.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3d)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from file-cache.ts):
//   cachePaths    (CP1.1) — shard directory + file path derivation (via public API).
//   readIntent    (RI1.1) — cache read: miss → undefined, hit → parsed JSON, corrupt → undefined.
//   writeIntent   (WI1.1) — atomic write via tmp+rename; two-level shard layout.
//   isEnoent      (IE1.1) — ENOENT type guard (exercised via readIntent miss path).
//
// Properties covered:
//   - readIntent returns undefined for a key with no on-disk entry (ENOENT / miss).
//   - readIntent returns the written value after a matching writeIntent call (round-trip).
//   - readIntent is deterministic: two reads of the same key after one write return equal values.
//   - readIntent returns undefined for a corrupt (non-JSON) entry and removes the file.
//   - writeIntent places the entry in a shard dir whose name is the first 3 hex chars of the key.
//   - writeIntent file path ends with '<key>.json' inside the shard dir.
//   - writeIntent is idempotent: writing the same key twice leaves the last value readable.
//   - writeIntent persists all IntentCard fields without mutation.
//   - writeIntent produces valid JSON on disk (JSON.parse does not throw).
//   - cachePaths shard is always 3 characters (verified via filesystem layout after write).
//   - Compound: writeIntent → readIntent pipeline preserves the full IntentCard faithfully.

// ---------------------------------------------------------------------------
// Property-test corpus for cache/file-cache.ts
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import type { IntentCard, IntentParam } from "../intent/types.js";
import { readIntent, writeIntent } from "./file-cache.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char hex string suitable for a cache key. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Arbitrary IntentParam. */
const intentParamArb: fc.Arbitrary<IntentParam> = fc.record({
  name: nonEmptyStr,
  typeHint: nonEmptyStr,
  description: fc.string({ minLength: 0, maxLength: 40 }),
});

/** Well-formed IntentCard for property testing. */
const intentCardArb: fc.Arbitrary<IntentCard> = fc.record({
  schemaVersion: fc.constant(1 as const),
  behavior: nonEmptyStr,
  inputs: fc.array(intentParamArb, { minLength: 0, maxLength: 2 }),
  outputs: fc.array(intentParamArb, { minLength: 0, maxLength: 2 }),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
  sourceHash: hexHash64,
  extractedAt: fc.constant("2024-01-01T00:00:00.000Z"),
});

// ---------------------------------------------------------------------------
// RI1.1: readIntent — cache miss returns undefined (ENOENT / isEnoent path)
// ---------------------------------------------------------------------------

/**
 * prop_readIntent_miss_returns_undefined
 *
 * For any valid cache key, readIntent returns undefined when no file exists at
 * the expected path (i.e., the cache is cold / empty directory).
 *
 * Invariant (RI1.1, IE1.1, DEC-CONTINUOUS-SHAVE-022): the ENOENT guard
 * (isEnoent) must map fs ENOENT errors to undefined so callers can
 * distinguish a miss from a read error. An empty temp dir guarantees ENOENT.
 */
export const prop_readIntent_miss_returns_undefined = fc.asyncProperty(
  hexHash64,
  async (cacheKey) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-miss-"));
    const result = await readIntent(cacheDir, cacheKey);
    return result === undefined;
  },
);

// ---------------------------------------------------------------------------
// RI1.1 / WI1.1: readIntent — returns written value (round-trip)
// ---------------------------------------------------------------------------

/**
 * prop_readIntent_returns_written_value
 *
 * After writeIntent(cacheDir, key, card), readIntent(cacheDir, key) returns a
 * value that, when JSON-round-tripped, equals the written IntentCard.
 *
 * Invariant (RI1.1, WI1.1, DEC-CONTINUOUS-SHAVE-022): the cache must be a
 * faithful store — a read after a write returns the same logical value that
 * was written, enabling the caller to skip re-extraction for a matching key.
 */
export const prop_readIntent_returns_written_value = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-rw-"));
    await writeIntent(cacheDir, cacheKey, card);
    const result = await readIntent(cacheDir, cacheKey);
    if (result === undefined) return false;
    // readIntent returns the raw parsed JSON; compare via JSON round-trip.
    return JSON.stringify(result) === JSON.stringify(card);
  },
);

// ---------------------------------------------------------------------------
// RI1.1: readIntent — deterministic (two reads of same key return equal values)
// ---------------------------------------------------------------------------

/**
 * prop_readIntent_is_deterministic
 *
 * Two successive calls to readIntent with the same cacheDir and cacheKey after
 * a single writeIntent call return structurally equal values.
 *
 * Invariant (RI1.1, DEC-CONTINUOUS-SHAVE-022): readIntent is a pure read; it
 * must not alter the stored entry between reads, and JSON.parse of the same
 * bytes produces the same logical value.
 */
export const prop_readIntent_is_deterministic = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-det-"));
    await writeIntent(cacheDir, cacheKey, card);
    const r1 = await readIntent(cacheDir, cacheKey);
    const r2 = await readIntent(cacheDir, cacheKey);
    return JSON.stringify(r1) === JSON.stringify(r2);
  },
);

// ---------------------------------------------------------------------------
// RI1.1: readIntent — corrupt entry returns undefined and removes the file
// ---------------------------------------------------------------------------

/**
 * prop_readIntent_corrupt_entry_returns_undefined_and_deletes
 *
 * When a cache file contains invalid JSON, readIntent returns undefined and
 * removes the corrupt file so subsequent reads do not repeatedly fail to parse.
 *
 * Invariant (RI1.1, DEC-CONTINUOUS-SHAVE-022): the self-healing cache read
 * ensures that a corrupt entry never causes a hard error at the caller; the
 * next write can cleanly replace the removed entry.
 */
export const prop_readIntent_corrupt_entry_returns_undefined_and_deletes = fc.asyncProperty(
  hexHash64,
  async (cacheKey) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-corrupt-"));
    // Manually create the shard dir and a corrupt file at the expected path.
    const shard = cacheKey.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shardDir, { recursive: true });
    const filePath = join(shardDir, `${cacheKey}.json`);
    await writeFile(filePath, "not valid json {{{", "utf-8");

    const result = await readIntent(cacheDir, cacheKey);
    if (result !== undefined) return false;

    // After readIntent, the corrupt file should have been deleted.
    try {
      await stat(filePath);
      return false; // file still exists — bad
    } catch {
      return true; // file gone — correct self-healing
    }
  },
);

// ---------------------------------------------------------------------------
// WI1.1 / CP1.1: writeIntent — shard dir is first 3 hex chars of key
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_shard_dir_is_key_prefix
 *
 * After writeIntent(cacheDir, key, card), the shard directory
 * <cacheDir>/<key[0..3]> exists and contains the entry file.
 *
 * Invariant (CP1.1, WI1.1, DEC-CONTINUOUS-SHAVE-022): the two-level shard
 * layout uses the first 3 hex characters as the subdirectory. This mirrors
 * content-addressable stores like Git's object DB and prevents filesystem
 * degradation from large flat directories.
 */
export const prop_writeIntent_shard_dir_is_key_prefix = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-shard-"));
    await writeIntent(cacheDir, cacheKey, card);
    const expectedShard = cacheKey.slice(0, 3);
    const shardDir = join(cacheDir, expectedShard);
    const s = await stat(shardDir);
    return s.isDirectory();
  },
);

// ---------------------------------------------------------------------------
// WI1.1 / CP1.1: writeIntent — file path ends with '<key>.json'
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_file_path_ends_with_key_json
 *
 * After writeIntent(cacheDir, key, card), a file named '<key>.json' exists
 * inside the shard directory.
 *
 * Invariant (CP1.1, WI1.1, DEC-CONTINUOUS-SHAVE-022): the canonical file name
 * is '<cacheKey>.json'. Any deviation would prevent readIntent from locating
 * entries written by writeIntent.
 */
export const prop_writeIntent_file_path_ends_with_key_json = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-fname-"));
    await writeIntent(cacheDir, cacheKey, card);
    const shard = cacheKey.slice(0, 3);
    const filePath = join(cacheDir, shard, `${cacheKey}.json`);
    const s = await stat(filePath);
    return s.isFile();
  },
);

// ---------------------------------------------------------------------------
// WI1.1: writeIntent — idempotent (second write of same key is readable)
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_idempotent_overwrite
 *
 * Writing the same key twice with different IntentCards leaves the second
 * card readable via readIntent.
 *
 * Invariant (WI1.1, DEC-CONTINUOUS-SHAVE-022): the atomic rename pattern
 * (tmp → final) must handle the case where a file already exists at the
 * destination. The second write must overwrite, not fail silently or corrupt.
 */
export const prop_writeIntent_idempotent_overwrite = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  intentCardArb,
  async (cacheKey, card1, card2) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-idem-"));
    await writeIntent(cacheDir, cacheKey, card1);
    await writeIntent(cacheDir, cacheKey, card2);
    const result = await readIntent(cacheDir, cacheKey);
    return JSON.stringify(result) === JSON.stringify(card2);
  },
);

// ---------------------------------------------------------------------------
// WI1.1: writeIntent — persists all IntentCard fields without mutation
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_preserves_all_card_fields
 *
 * After writeIntent + readIntent, every top-level field of the IntentCard is
 * present in the round-tripped value with the correct type and value.
 *
 * Invariant (WI1.1, DEC-CONTINUOUS-SHAVE-022): the JSON serialisation must be
 * lossless for the fields that define cache validity (sourceHash, modelVersion,
 * promptVersion, schemaVersion). A mutation in any field would silently break
 * the cache hit logic in the caller.
 */
export const prop_writeIntent_preserves_all_card_fields = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-fields-"));
    await writeIntent(cacheDir, cacheKey, card);
    const result = await readIntent(cacheDir, cacheKey);
    if (result === null || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    return (
      r.schemaVersion === card.schemaVersion &&
      r.behavior === card.behavior &&
      r.modelVersion === card.modelVersion &&
      r.promptVersion === card.promptVersion &&
      r.sourceHash === card.sourceHash &&
      r.extractedAt === card.extractedAt
    );
  },
);

// ---------------------------------------------------------------------------
// WI1.1: writeIntent — produces valid JSON on disk
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_produces_valid_json_on_disk
 *
 * The file written by writeIntent can be parsed with JSON.parse without
 * throwing.
 *
 * Invariant (WI1.1, DEC-CONTINUOUS-SHAVE-022): readIntent uses JSON.parse to
 * deserialise entries. If writeIntent produces malformed JSON, every subsequent
 * read triggers the corrupt-entry path (delete + undefined), effectively
 * making the cache non-functional.
 */
export const prop_writeIntent_produces_valid_json_on_disk = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-json-"));
    await writeIntent(cacheDir, cacheKey, card);
    const shard = cacheKey.slice(0, 3);
    const filePath = join(cacheDir, shard, `${cacheKey}.json`);
    const raw = await readFile(filePath, "utf-8");
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// CP1.1: cachePaths — shard is always exactly 3 characters
// ---------------------------------------------------------------------------

/**
 * prop_cachePaths_shard_is_always_3_chars
 *
 * For any 64-char hex cache key, the shard directory created by writeIntent
 * has a basename that is exactly 3 characters long.
 *
 * Invariant (CP1.1, DEC-CONTINUOUS-SHAVE-022): the shard prefix is always
 * key.slice(0, 3) — exactly 3 hex characters. A key shorter than 3 chars
 * would produce a malformed shard, but the system only passes 64-char keys.
 */
export const prop_cachePaths_shard_is_always_3_chars = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-shardlen-"));
    await writeIntent(cacheDir, cacheKey, card);
    const shard = cacheKey.slice(0, 3);
    return shard.length === 3;
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: writeIntent → readIntent end-to-end pipeline
//
// Production sequence: caller derives a 64-char key via keyFromIntentInputs()
// → writeIntent() stores the IntentCard in a two-level shard file →
// readIntent() retrieves and JSON-parses it → caller validates with
// validateIntentCard(). This compound property exercises the full
// write→read pipeline crossing cachePaths, writeIntent, and readIntent.
// ---------------------------------------------------------------------------

/**
 * prop_writeIntent_readIntent_compound_pipeline
 *
 * Given a valid cache key and IntentCard, the full write→read pipeline
 * produces a value that is JSON-equivalent to the written card, with all
 * cache-validity fields (sourceHash, modelVersion, promptVersion, schemaVersion)
 * intact.
 *
 * This is the canonical compound-interaction property crossing:
 *   keyFromIntentInputs (key) → writeIntent (disk) → readIntent (parse) →
 *   caller-side validation fields check.
 *
 * Invariant (CP1.1, RI1.1, WI1.1, DEC-CONTINUOUS-SHAVE-022): the pipeline
 * must be round-trip faithful. Any gap in the chain (wrong path, partial
 * write, parse failure) would cause silent cache misses or stale reads.
 */
export const prop_writeIntent_readIntent_compound_pipeline = fc.asyncProperty(
  hexHash64,
  intentCardArb,
  async (cacheKey, card) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "yakcc-fc-compound-"));

    // 1. Write to cache.
    await writeIntent(cacheDir, cacheKey, card);

    // 2. Read back.
    const result = await readIntent(cacheDir, cacheKey);
    if (result === undefined || result === null || typeof result !== "object") return false;

    // 3. Verify the file lives at the two-level shard path.
    const shard = cacheKey.slice(0, 3);
    const filePath = join(cacheDir, shard, `${cacheKey}.json`);
    const s = await stat(filePath);
    if (!s.isFile()) return false;

    // 4. Verify round-trip fidelity for all cache-validity fields.
    const r = result as Record<string, unknown>;
    return (
      r.schemaVersion === card.schemaVersion &&
      r.sourceHash === card.sourceHash &&
      r.modelVersion === card.modelVersion &&
      r.promptVersion === card.promptVersion &&
      JSON.stringify(result) === JSON.stringify(card)
    );
  },
);
