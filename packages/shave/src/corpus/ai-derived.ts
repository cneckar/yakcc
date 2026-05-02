// SPDX-License-Identifier: MIT
// @decision DEC-CORPUS-002
// title: AI-derived corpus uses the same file-cache.ts surface with corpus-v1 schemaVersion
// status: decided (WI-016)
// rationale:
//   DEC-SHAVE-003 mandates a single file-cache authority. The corpus AI path reuses
//   file-cache.ts (readIntent/writeIntent) and key.ts (keyFromIntentInputs/sourceHash)
//   with a distinct schemaVersion constant ("corpus-v1" numeric equivalent) so that
//   corpus and intent cache entries cannot collide. No parallel cache directory, no
//   alternative serialization format.
//
//   DEC-SHAVE-002 offline discipline: the AI-derived path works without ANTHROPIC_API_KEY
//   when the cache is warm. The actual Anthropic SDK call is never made in unit tests.
//   Integration tests that exercise the live path are gated by the YAKCC_CORPUS_AI_TEST
//   env flag and default OFF in CI.
//
//   Cache key domain separation: CORPUS_SCHEMA_VERSION = 2 (distinct from
//   INTENT_SCHEMA_VERSION = 1) ensures intent and corpus entries never collide even
//   if the same source text is processed by both pipelines.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { readIntent, writeIntent } from "../cache/file-cache.js";
import { sourceHash as computeSourceHash, keyFromIntentInputs } from "../cache/key.js";
import type { CorpusResult, IntentCardInput } from "./types.js";

const encoder = new TextEncoder();

/**
 * Canonical artifact path for AI-derived property-test files.
 */
const AI_DERIVED_PATH = "property-tests.fast-check.ts";

/**
 * Schema version discriminant for corpus cache entries.
 *
 * Must be different from INTENT_SCHEMA_VERSION (1) to prevent collisions.
 * Corpus entries and intent entries share the same cache directory layout
 * (file-cache.ts two-level sharding) but are distinguished by this version.
 *
 * @decision DEC-CORPUS-002: value = 2 (intent = 1, corpus = 2)
 */
export const CORPUS_SCHEMA_VERSION = 2 as const;

/**
 * Model tag used for corpus AI extraction.
 * Defaults to the same DEFAULT_MODEL as intent extraction for consistency.
 */
export const CORPUS_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Prompt version for the corpus extraction prompt template.
 * Bump when the corpus generation prompt changes to invalidate stale cache entries.
 */
export const CORPUS_PROMPT_VERSION = "corpus-1";

/**
 * Inputs for AI-derived corpus cache key derivation.
 *
 * These mirror IntentKeyInputs from cache/key.ts — the same keyFromIntentInputs()
 * function is reused with CORPUS_SCHEMA_VERSION so entries cannot collide.
 */
export interface CorpusKeySpec {
  readonly source: string;
  readonly cacheDir: string;
  readonly model?: string | undefined;
  readonly promptVersion?: string | undefined;
}

/**
 * Derive the cache key for a corpus entry.
 *
 * Uses the same BLAKE3-based derivation as intent extraction
 * (keyFromIntentInputs) but with CORPUS_SCHEMA_VERSION = 2.
 */
export function corpusCacheKey(spec: CorpusKeySpec): string {
  const model = spec.model ?? CORPUS_DEFAULT_MODEL;
  const pv = spec.promptVersion ?? CORPUS_PROMPT_VERSION;
  const sh = computeSourceHash(spec.source);
  return keyFromIntentInputs({
    sourceHash: sh,
    modelTag: model,
    promptVersion: pv,
    schemaVersion: CORPUS_SCHEMA_VERSION,
  });
}

/**
 * A cached corpus entry as stored in the file cache.
 *
 * The `content` field is the fast-check property-test file content (UTF-8 string).
 * The `schemaVersion` discriminant must match CORPUS_SCHEMA_VERSION for the entry
 * to be considered valid.
 */
export interface CachedCorpusEntry {
  readonly schemaVersion: typeof CORPUS_SCHEMA_VERSION;
  readonly content: string;
  readonly sourceHash: string;
  readonly generatedAt: string;
}

/**
 * Type guard for a valid CachedCorpusEntry.
 */
function isCachedCorpusEntry(value: unknown): value is CachedCorpusEntry {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === CORPUS_SCHEMA_VERSION &&
    typeof obj.content === "string" &&
    obj.content.length > 0 &&
    typeof obj.sourceHash === "string" &&
    typeof obj.generatedAt === "string"
  );
}

/**
 * Read a cached corpus entry from disk.
 *
 * Returns the CachedCorpusEntry on a cache hit, or undefined on a miss or
 * invalid/stale entry (schemaVersion mismatch counts as a miss).
 */
export async function readCorpusCache(
  cacheDir: string,
  key: string,
): Promise<CachedCorpusEntry | undefined> {
  // readIntent returns unknown | undefined; we validate shape ourselves.
  // This reuse is intentional: same file-cache.ts, same two-level sharding,
  // same atomic write protocol. The only difference is the schemaVersion.
  const raw = await (readIntent as (dir: string, key: string) => Promise<unknown>)(cacheDir, key);
  if (raw === undefined) return undefined;
  if (isCachedCorpusEntry(raw)) return raw;
  // Wrong schema version or corrupted entry — treat as miss.
  return undefined;
}

/**
 * Write a corpus entry to the file cache.
 *
 * Uses writeIntent() with a CachedCorpusEntry cast to IntentCard — the cache
 * is content-agnostic (stores JSON) so the type cast is safe at the storage level.
 * The schemaVersion discriminant prevents cross-domain reads.
 */
export async function writeCorpusCache(
  cacheDir: string,
  key: string,
  entry: CachedCorpusEntry,
): Promise<void> {
  // writeIntent accepts IntentCard; we cast because the cache is JSON-agnostic.
  // The CORPUS_SCHEMA_VERSION discriminant ensures a corpus entry is never
  // mistakenly read by the intent extraction path (schemaVersion=1 check fails).
  await (writeIntent as (dir: string, key: string, value: unknown) => Promise<void>)(
    cacheDir,
    key,
    entry,
  );
}

/**
 * Attempt AI-derived corpus extraction from the file cache (offline path).
 *
 * Returns a CorpusResult with source="ai-derived" on a cache hit, or undefined
 * on a miss. Does NOT call the Anthropic SDK — that path is handled by the
 * integration test helper (seedCorpusCache) and the live extraction path
 * (not wired in unit tests per DEC-SHAVE-002).
 *
 * @param intentCard - The extracted intent card for this atom.
 * @param source     - The raw source text of the atom.
 * @param cacheDir   - Root cache directory.
 * @param model      - Optional model tag override (defaults to CORPUS_DEFAULT_MODEL).
 * @param promptVersion - Optional prompt version override (defaults to CORPUS_PROMPT_VERSION).
 * @returns CorpusResult on cache hit, undefined on miss.
 */
export async function extractFromAiDerivedCached(
  intentCard: IntentCardInput,
  source: string,
  cacheDir: string,
  model?: string,
  promptVersion?: string,
): Promise<CorpusResult | undefined> {
  const key = corpusCacheKey({ source, cacheDir, model, promptVersion });
  const cached = await readCorpusCache(cacheDir, key);
  if (cached === undefined) return undefined;

  const bytes = encoder.encode(cached.content);
  const contentHash = bytesToHex(blake3(bytes));

  // Attach intentCard reference for provenance (unused in return value but
  // accessible via closure for future diagnostics).
  void intentCard;

  return {
    source: "ai-derived",
    bytes,
    path: AI_DERIVED_PATH,
    contentHash,
  };
}

/**
 * Write a fast-check corpus string into the AI-derived corpus cache.
 *
 * **Test-helper only.** Do NOT call from production code. Production corpus
 * entries are written by the live AI extraction path (not wired in unit tests).
 *
 * This function is the corpus analogue of seedIntentCache() from index.ts.
 * It uses the same key derivation as extractFromAiDerivedCached() so that
 * a seeded entry is found on the first cache lookup.
 *
 * @param spec    - Source text and cache location; identifies the cache slot.
 * @param content - The fast-check file content to store.
 */
export async function seedCorpusCache(spec: CorpusKeySpec, content: string): Promise<void> {
  const key = corpusCacheKey(spec);
  const sh = computeSourceHash(spec.source);
  const entry: CachedCorpusEntry = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    content,
    sourceHash: sh,
    generatedAt: new Date().toISOString(),
  };
  await writeCorpusCache(spec.cacheDir, key, entry);
}
