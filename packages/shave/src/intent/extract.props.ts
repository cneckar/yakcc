// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/extract.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3g)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from extract.ts):
//   parseJsonFence     — internal fence parser (exercised via extractIntent llm path)
//   extractIntent      — main entry point (strategy dispatch, cache, validation)
//   ExtractIntentContext — interface shape
//
// Properties covered (43 atoms across invariants a–l):
//   (a) parseJsonFence happy-path round-trips well-formed <json>...</json> fences
//   (b) parseJsonFence throws IntentCardSchemaError when fences absent
//   (c) parseJsonFence throws IntentCardSchemaError when end <= start
//   (d) parseJsonFence throws IntentCardSchemaError when JSON malformed
//   (e) extractIntent strategy default resolves to 'static'
//   (f) extractIntent strategy='static' uses STATIC_MODEL_TAG/STATIC_PROMPT_VERSION
//   (g) extractIntent strategy='llm' uses ctx.model/ctx.promptVersion
//   (h) extractIntent computes srcHash + cacheKey deterministically
//   (i) extractedAt is truncated to whole-second ISO-8601 from ctx.now
//   (j) strategy='llm' + ctx.offline===true + no cache hit → OfflineCacheMissError
//   (k) strategy='llm' + no ctx.client + no ANTHROPIC_API_KEY → AnthropicApiKeyMissingError
//   (l) strategy='llm' assembles IntentCard from ctx.model/promptVersion/srcHash/extractedAt
//
// Deferred (Path C — see tmp/wi-v2-07-preflight-L3g-deferred-atoms.md):
//   - createDefaultAnthropicClient lazy SDK import path
//   - process.env.ANTHROPIC_API_KEY live read (non-arrange-restorable in property context)

// ---------------------------------------------------------------------------
// Property-test corpus for intent/extract.ts
// ---------------------------------------------------------------------------

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import {
  AnthropicApiKeyMissingError,
  IntentCardSchemaError,
  OfflineCacheMissError,
} from "../errors.js";
import type {
  AnthropicCreateParams,
  AnthropicLikeClient,
  AnthropicMessageResponse,
} from "./anthropic-client.js";
import { INTENT_SCHEMA_VERSION, STATIC_MODEL_TAG, STATIC_PROMPT_VERSION } from "./constants.js";
import { extractIntent } from "./extract.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char lowercase hex string (nibble array). */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Behavior string: non-empty, no newlines, ≤ 200 chars. */
const behaviorArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 150 })
  .filter((s) => s.trim().length > 0 && !/[\n\r]/.test(s));

/** Non-empty TypeScript source string — used as unitSource. */
const unitSourceArb: fc.Arbitrary<string> = fc
  .string({ minLength: 10, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Well-formed IntentCard raw object (unknown-typed, for JSON fence assembly). */
const rawIntentCardArb = fc
  .tuple(behaviorArb, hexHash64, nonEmptyStr, nonEmptyStr)
  .map(([behavior, sourceHash, modelVersion, promptVersion]) => ({
    schemaVersion: 1,
    behavior,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion,
    promptVersion,
    sourceHash,
    extractedAt: "2024-01-01T00:00:00.000Z",
  }));

/** Minimal well-formed JSON fence string wrapping a valid IntentCard. */
const validFencedResponseArb: fc.Arbitrary<{ raw: Record<string, unknown>; fenced: string }> =
  rawIntentCardArb.map((raw) => ({
    raw,
    fenced: `<json>${JSON.stringify(raw)}</json>`,
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allocates an isolated cacheDir under os.tmpdir() for each property run. */
async function isolatedCacheDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `yakcc-ep-${prefix}-`));
}

/** Builds a mock AnthropicLikeClient that returns a fenced IntentCard response. */
function mockClient(responseText: string): AnthropicLikeClient {
  return {
    create(_params: AnthropicCreateParams): Promise<AnthropicMessageResponse> {
      return Promise.resolve({
        content: [{ type: "text", text: responseText }],
      });
    },
  };
}

/** Throws IntentCardSchemaError if extractIntent does not throw it. */
async function assertThrowsSchemaError(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof IntentCardSchemaError;
  }
}

// ---------------------------------------------------------------------------
// (a): parseJsonFence happy-path round-trips well-formed <json>…</json> fences
//
// Exercised via extractIntent LLM path with a mock client returning a valid fence.
// The fence parser is internal; we verify it via the public extractIntent API.
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_happy_path_returns_validated_card
 *
 * When strategy='llm' and the mock client returns a valid <json>…</json> fence,
 * extractIntent returns a validated IntentCard with the expected fields.
 *
 * Invariant (a, DEC-CONTINUOUS-SHAVE-022): parseJsonFence correctly extracts
 * the JSON between well-formed fences and the result passes validateIntentCard.
 */
export const prop_extract_llm_happy_path_returns_validated_card = fc.asyncProperty(
  unitSourceArb,
  validFencedResponseArb,
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, { fenced }, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("llm-happy");
    const card = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    return (
      card.schemaVersion === 1 &&
      typeof card.behavior === "string" &&
      card.behavior.length > 0 &&
      typeof card.sourceHash === "string" &&
      card.sourceHash.length === 64
    );
  },
);

// ---------------------------------------------------------------------------
// (b): parseJsonFence throws IntentCardSchemaError when fences absent
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_no_fence_throws_schema_error
 *
 * When strategy='llm' and the mock client returns a response without
 * <json>…</json> fences, extractIntent throws IntentCardSchemaError.
 *
 * Invariant (b, DEC-CONTINUOUS-SHAVE-022): absence of fences means the model
 * produced unexpected output; the caller must surface this immediately rather
 * than silently storing a corrupt entry.
 */
export const prop_extract_llm_no_fence_throws_schema_error = fc.asyncProperty(
  unitSourceArb,
  // String that contains neither <json> nor </json>
  fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => !s.includes("<json>")),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, noFenceText, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("no-fence");
    return assertThrowsSchemaError(() =>
      extractIntent(unitSource, {
        strategy: "llm",
        model,
        promptVersion,
        cacheDir,
        client: mockClient(noFenceText),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// (c): parseJsonFence throws IntentCardSchemaError when end <= start
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_inverted_fences_throws_schema_error
 *
 * When strategy='llm' and the response has </json> before <json>,
 * extractIntent throws IntentCardSchemaError (end <= start).
 *
 * Invariant (c, DEC-CONTINUOUS-SHAVE-022): the fence parser checks
 * end <= start and throws immediately rather than slicing a negative range.
 */
export const prop_extract_llm_inverted_fences_throws_schema_error = fc.asyncProperty(
  unitSourceArb,
  fc.string({ minLength: 0, maxLength: 40 }),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, middle, model, promptVersion) => {
    // Put </json> before <json> so end <= start in the source.
    const invertedFence = `</json>${middle}<json>`;
    const cacheDir = await isolatedCacheDir("inverted");
    return assertThrowsSchemaError(() =>
      extractIntent(unitSource, {
        strategy: "llm",
        model,
        promptVersion,
        cacheDir,
        client: mockClient(invertedFence),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// (d): parseJsonFence throws IntentCardSchemaError when JSON malformed
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_malformed_json_in_fence_throws_schema_error
 *
 * When strategy='llm' and the response wraps malformed JSON in <json>…</json>,
 * extractIntent throws IntentCardSchemaError.
 *
 * Invariant (d, DEC-CONTINUOUS-SHAVE-022): the JSON.parse call inside
 * parseJsonFence throws on malformed input; the catch block must re-throw
 * as IntentCardSchemaError, not as a generic SyntaxError.
 */
export const prop_extract_llm_malformed_json_in_fence_throws_schema_error = fc.asyncProperty(
  unitSourceArb,
  // String that is not valid JSON when used as fence content
  fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => {
      try {
        JSON.parse(s);
        return false; // skip valid JSON
      } catch {
        return true;
      }
    }),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, malformedJson, model, promptVersion) => {
    const fenced = `<json>${malformedJson}</json>`;
    const cacheDir = await isolatedCacheDir("malformed-json");
    return assertThrowsSchemaError(() =>
      extractIntent(unitSource, {
        strategy: "llm",
        model,
        promptVersion,
        cacheDir,
        client: mockClient(fenced),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// (e): extractIntent strategy default resolves to 'static'
// ---------------------------------------------------------------------------

/**
 * prop_extract_strategy_default_is_static
 *
 * When ctx.strategy is omitted, extractIntent behaves as strategy='static':
 * it succeeds without a client and without ANTHROPIC_API_KEY, and does not
 * throw AnthropicApiKeyMissingError.
 *
 * Invariant (e, DEC-INTENT-STRATEGY-001): default strategy is "static" per
 * DEC-INTENT-STRATEGY-001. The common case must never require network access.
 */
export const prop_extract_strategy_default_is_static = fc.asyncProperty(
  // Minimal TypeScript source with a JSDoc comment so staticExtract returns a card
  fc.constant(
    `/**
 * Adds two numbers.
 * @param a - First number
 * @param b - Second number
 * @returns Sum
 */
export function add(a: number, b: number): number { return a + b; }`,
  ),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("default-static");
    try {
      const card = await extractIntent(unitSource, {
        // strategy omitted — must default to "static"
        model,
        promptVersion,
        cacheDir,
        // No client, no API key — static must not require either
      });
      return card.schemaVersion === 1 && typeof card.behavior === "string";
    } catch {
      // Static path must not throw for well-formed source
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// (f): strategy='static' uses STATIC_MODEL_TAG / STATIC_PROMPT_VERSION
// ---------------------------------------------------------------------------

/**
 * prop_extract_static_strategy_uses_static_tags
 *
 * When strategy='static', the returned IntentCard has modelVersion===STATIC_MODEL_TAG
 * and promptVersion===STATIC_PROMPT_VERSION (the static cache namespace tags).
 *
 * Invariant (f, DEC-INTENT-STRATEGY-001, DEC-INTENT-STATIC-CACHE-001):
 * static and LLM cards must occupy disjoint cache namespaces. The model/prompt
 * version tags in the returned card are the authority for cache key derivation;
 * they must be the static constants, not ctx.model / ctx.promptVersion.
 */
export const prop_extract_static_strategy_uses_static_tags = fc.asyncProperty(
  fc.constant(
    `/**
 * Multiplies two numbers.
 * @param x - First factor
 * @param y - Second factor
 * @returns Product
 */
export function multiply(x: number, y: number): number { return x * y; }`,
  ),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("static-tags");
    const card = await extractIntent(unitSource, {
      strategy: "static",
      model,
      promptVersion,
      cacheDir,
    });
    return card.modelVersion === STATIC_MODEL_TAG && card.promptVersion === STATIC_PROMPT_VERSION;
  },
);

// ---------------------------------------------------------------------------
// (g): strategy='llm' uses ctx.model / ctx.promptVersion as cache-key components
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_strategy_uses_ctx_model_and_prompt_version
 *
 * When strategy='llm', the returned IntentCard has modelVersion===ctx.model
 * and promptVersion===ctx.promptVersion (from the assembled card in step 4e).
 *
 * Invariant (g, DEC-CONTINUOUS-SHAVE-022): the LLM path overwrites
 * modelVersion and promptVersion on the assembled card so the cache key
 * components are always the values from ctx, not whatever the model returned
 * in the JSON fence. This prevents cache pollution from model-generated values.
 */
export const prop_extract_llm_strategy_uses_ctx_model_and_prompt_version = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async (unitSource, model, promptVersion, { fenced }) => {
    const cacheDir = await isolatedCacheDir("llm-model-pv");
    const card = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    return card.modelVersion === model && card.promptVersion === promptVersion;
  },
);

// ---------------------------------------------------------------------------
// (h): extractIntent computes srcHash via computeSourceHash deterministically
// ---------------------------------------------------------------------------

/**
 * prop_extract_srcHash_is_deterministic
 *
 * Two calls to extractIntent with the same unitSource produce IntentCards
 * with the same sourceHash.
 *
 * Invariant (h, DEC-CONTINUOUS-SHAVE-022): sourceHash is the BLAKE3 of
 * the normalized source text. It must be deterministic so the cache key
 * derivation produces the same key for the same source on every run.
 */
export const prop_extract_srcHash_is_deterministic = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async (unitSource, model, promptVersion, { fenced }) => {
    const cacheDir = await isolatedCacheDir("srchash-det");
    // First call — miss path.
    const card1 = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    // Second call — cache hit path (same cacheDir, same source).
    const card2 = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    return card1.sourceHash === card2.sourceHash && card1.sourceHash.length === 64;
  },
);

/**
 * prop_extract_srcHash_differs_for_different_sources
 *
 * Different unitSource strings (that differ after normalization) produce
 * different sourceHash values in the returned IntentCard.
 *
 * Invariant (h, DEC-CONTINUOUS-SHAVE-022): the hash function is injective
 * over the normalized source domain. Collisions would cause incorrect
 * cache hits across different source units.
 */
export const prop_extract_srcHash_differs_for_different_sources = fc.asyncProperty(
  // Two distinct source strings (not equal after trimming)
  fc
    .tuple(unitSourceArb, unitSourceArb)
    .filter(([a, b]) => a.trim() !== b.trim()),
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async ([src1, src2], model, promptVersion, { fenced }) => {
    const cacheDir1 = await isolatedCacheDir("srchash-diff1");
    const cacheDir2 = await isolatedCacheDir("srchash-diff2");
    const card1 = await extractIntent(src1, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir: cacheDir1,
      client: mockClient(fenced),
    });
    const card2 = await extractIntent(src2, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir: cacheDir2,
      client: mockClient(fenced),
    });
    return card1.sourceHash !== card2.sourceHash;
  },
);

// ---------------------------------------------------------------------------
// (i): extractedAt is truncated to whole-second ISO-8601 from ctx.now
// ---------------------------------------------------------------------------

/**
 * prop_extract_extractedAt_is_whole_second_iso8601
 *
 * When ctx.now returns a Date with sub-second precision, the returned
 * IntentCard.extractedAt is the same timestamp truncated to the whole second
 * (milliseconds === 0) in ISO-8601 format.
 *
 * Invariant (i, DEC-CONTINUOUS-SHAVE-022): the truncation formula is
 * new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(). This
 * ensures extractedAt is always a clean second boundary, preventing millisecond
 * drift from causing cache key mismatches in time-sensitive tests.
 */
export const prop_extract_extractedAt_is_whole_second_iso8601 = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  // A timestamp with arbitrary sub-second component.
  fc
    .integer({ min: 0, max: 999 })
    .map((ms) => {
      const base = new Date("2024-06-15T12:34:56.000Z").getTime();
      return new Date(base + ms);
    }),
  async (unitSource, model, promptVersion, { fenced }, nowDate) => {
    const cacheDir = await isolatedCacheDir("extractedAt");
    const card = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
      now: () => nowDate,
    });

    // extractedAt must end with .000Z (milliseconds truncated).
    if (!card.extractedAt.endsWith(".000Z")) return false;

    // The whole-second timestamp must match the truncated now.
    const expectedMs = Math.floor(nowDate.getTime() / 1000) * 1000;
    const expected = new Date(expectedMs).toISOString();
    return card.extractedAt === expected;
  },
);

// ---------------------------------------------------------------------------
// (j): strategy='llm' + ctx.offline===true + no cache hit → OfflineCacheMissError
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_offline_cache_miss_throws_OfflineCacheMissError
 *
 * When strategy='llm', ctx.offline===true, and the cache is cold (empty dir),
 * extractIntent throws OfflineCacheMissError.
 *
 * Invariant (j, DEC-CONTINUOUS-SHAVE-022): offline mode must never make API
 * calls. On a cold cache it must throw OfflineCacheMissError rather than
 * silently returning undefined or calling the client.
 */
export const prop_extract_llm_offline_cache_miss_throws_OfflineCacheMissError = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("offline-miss");
    try {
      await extractIntent(unitSource, {
        strategy: "llm",
        model,
        promptVersion,
        cacheDir,
        offline: true,
        // No client — must not reach the API check anyway.
      });
      return false;
    } catch (err) {
      return err instanceof OfflineCacheMissError;
    }
  },
);

/**
 * prop_extract_llm_offline_cache_hit_returns_card
 *
 * When strategy='llm', ctx.offline===true, but the cache already has an entry
 * for the given source+model+promptVersion, extractIntent returns the cached card.
 *
 * Invariant (j, DEC-CONTINUOUS-SHAVE-022): the offline guard only fires on
 * cache misses. A pre-populated cache entry must be returned even in offline mode.
 * This verifies the ordering: step 3 (cache lookup) runs before step 4a (offline check).
 */
export const prop_extract_llm_offline_cache_hit_returns_card = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async (unitSource, model, promptVersion, { fenced }) => {
    const cacheDir = await isolatedCacheDir("offline-hit");
    // Warm the cache with an online call first.
    await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    // Now call offline — must return the cached card, not throw.
    try {
      const card = await extractIntent(unitSource, {
        strategy: "llm",
        model,
        promptVersion,
        cacheDir,
        offline: true,
      });
      return card.schemaVersion === 1;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// (k): strategy='llm' + no ctx.client + no ANTHROPIC_API_KEY →
//      AnthropicApiKeyMissingError
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_no_client_no_key_throws_AnthropicApiKeyMissingError
 *
 * When strategy='llm', ctx.client is undefined, and ANTHROPIC_API_KEY is not
 * set (or is empty), extractIntent throws AnthropicApiKeyMissingError.
 *
 * Invariant (k, DEC-CONTINUOUS-SHAVE-022): the API-key guard (step 4b) must
 * fire before any SDK import or network call. The error class is
 * AnthropicApiKeyMissingError, not a generic Error or a network error.
 *
 * @decision DEC-V2-PROPTEST-PATH-A-001: process.env.ANTHROPIC_API_KEY is
 * temporarily cleared inside an arrange-act-restore bracket. This is the only
 * Path A mechanism available without SDK mocking. The restore is synchronous
 * (the await completes before the restore) — safe in single-threaded Node.
 */
export const prop_extract_llm_no_client_no_key_throws_AnthropicApiKeyMissingError =
  fc.asyncProperty(
    unitSourceArb,
    nonEmptyStr,
    nonEmptyStr,
    async (unitSource, model, promptVersion) => {
      const cacheDir = await isolatedCacheDir("no-key");
      const saved = process.env.ANTHROPIC_API_KEY;
      // biome-ignore lint/performance/noDelete: arrange-restore bracket — only safe way to unset env var
      delete process.env.ANTHROPIC_API_KEY;
      try {
        await extractIntent(unitSource, {
          strategy: "llm",
          model,
          promptVersion,
          cacheDir,
          // No client — must hit the API-key guard.
        });
        return false;
      } catch (err) {
        return err instanceof AnthropicApiKeyMissingError;
      } finally {
        if (saved !== undefined) {
          process.env.ANTHROPIC_API_KEY = saved;
        }
      }
    },
  );

// ---------------------------------------------------------------------------
// (l): strategy='llm' assembles IntentCard from ctx.model / promptVersion /
//      srcHash / extractedAt fields and validates via validateIntentCard
// ---------------------------------------------------------------------------

/**
 * prop_extract_llm_card_fields_come_from_ctx
 *
 * When strategy='llm' succeeds, the returned IntentCard has:
 *   modelVersion  === ctx.model
 *   promptVersion === ctx.promptVersion
 *   sourceHash    is a 64-char lowercase hex (BLAKE3 of source)
 *   extractedAt   is a non-empty ISO-8601 string truncated to the whole second
 *   schemaVersion === INTENT_SCHEMA_VERSION (1)
 *
 * Invariant (l, DEC-CONTINUOUS-SHAVE-022): extractIntent assembles the card
 * in step 4e by spreading the parsed JSON and then overwriting modelVersion,
 * promptVersion, sourceHash, extractedAt. This property verifies each field
 * comes from the correct authority: ctx for model/prompt, BLAKE3 for hash,
 * ctx.now for timestamp.
 */
export const prop_extract_llm_card_fields_come_from_ctx = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  fc.integer({ min: 0, max: 999 }).map((ms) => {
    const base = new Date("2025-03-01T10:00:00.000Z").getTime();
    return new Date(base + ms);
  }),
  async (unitSource, model, promptVersion, { fenced }, nowDate) => {
    const cacheDir = await isolatedCacheDir("card-fields");
    const card = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
      now: () => nowDate,
    });
    const expectedExtractedAt = new Date(Math.floor(nowDate.getTime() / 1000) * 1000).toISOString();

    return (
      card.schemaVersion === INTENT_SCHEMA_VERSION &&
      card.modelVersion === model &&
      card.promptVersion === promptVersion &&
      /^[0-9a-f]{64}$/.test(card.sourceHash) &&
      card.extractedAt === expectedExtractedAt
    );
  },
);

/**
 * prop_extract_llm_result_passes_validateIntentCard
 *
 * The value returned by extractIntent (strategy='llm') is a fully valid
 * IntentCard that passes a second call to validateIntentCard.
 *
 * Invariant (l, DEC-CONTINUOUS-SHAVE-022): extractIntent calls
 * validateIntentCard (step 4f) before writing to cache and returning.
 * The returned value must be validate-idempotent — validateIntentCard on the
 * result must not throw.
 */
export const prop_extract_llm_result_passes_validateIntentCard = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async (unitSource, model, promptVersion, { fenced }) => {
    const cacheDir = await isolatedCacheDir("validate-idem");
    const card = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });
    // Re-validate — must not throw.
    try {
      const { validateIntentCard } = await import("./validate-intent-card.js");
      validateIntentCard(card);
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: full extractIntent static pipeline (cache miss → write → hit)
//
// Production sequence:
//   1. extractIntent(src, ctx) — cold cache: miss → staticExtract → validate → write
//   2. extractIntent(src, ctx) — warm cache: hit → validate → return
// This crosses the boundaries of extractIntent, file-cache (readIntent/writeIntent),
// computeSourceHash, keyFromIntentInputs, staticExtract, and validateIntentCard.
// ---------------------------------------------------------------------------

/**
 * prop_extract_static_compound_miss_then_hit
 *
 * The first call to extractIntent(strategy='static') on a cold cache succeeds
 * (miss path: AST extract → validate → write). The second call returns the
 * same card from cache (hit path: readIntent → validate → return).
 *
 * This is the canonical compound-interaction property for extract.ts: it
 * exercises the real production sequence — miss → write → hit — crossing
 * multiple internal component boundaries. Both calls must return cards with
 * the same sourceHash, modelVersion, and behavior.
 *
 * Invariant (h, f, DEC-INTENT-STRATEGY-001, DEC-CONTINUOUS-SHAVE-022):
 * the cache write/read cycle must be round-trip faithful and the second call
 * must not re-run extraction (it reads from cache). The deterministic sourceHash
 * and static tags guarantee cache key stability across calls.
 */
export const prop_extract_static_compound_miss_then_hit = fc.asyncProperty(
  fc.constant(
    `/**
 * Returns the absolute value of a number.
 * @param n - The input number
 * @returns Absolute value
 */
export function abs(n: number): number { return n < 0 ? -n : n; }`,
  ),
  nonEmptyStr,
  nonEmptyStr,
  async (unitSource, model, promptVersion) => {
    const cacheDir = await isolatedCacheDir("compound-miss-hit");

    // First call: cold cache → static extraction path.
    const card1 = await extractIntent(unitSource, {
      strategy: "static",
      model,
      promptVersion,
      cacheDir,
    });

    // Second call: warm cache → cache hit path (must not re-run staticExtract).
    const card2 = await extractIntent(unitSource, {
      strategy: "static",
      model,
      promptVersion,
      cacheDir,
    });

    // Both must agree on all cache-validity fields.
    return (
      card1.sourceHash === card2.sourceHash &&
      card1.modelVersion === card2.modelVersion &&
      card1.promptVersion === card2.promptVersion &&
      card1.schemaVersion === card2.schemaVersion &&
      card1.behavior === card2.behavior &&
      card1.modelVersion === STATIC_MODEL_TAG &&
      card1.promptVersion === STATIC_PROMPT_VERSION
    );
  },
);

/**
 * prop_extract_llm_compound_miss_then_hit
 *
 * The first call to extractIntent(strategy='llm') on a cold cache triggers
 * the mock client and writes to cache. The second call returns the cached card
 * without calling the client again.
 *
 * Invariant (h, g, DEC-CONTINUOUS-SHAVE-022): same round-trip guarantee as the
 * static compound property but for the LLM path. The client call count is
 * verified indirectly: a null client on the second call (offline=true) must
 * succeed, proving the cache was written on the first call.
 */
export const prop_extract_llm_compound_miss_then_hit = fc.asyncProperty(
  unitSourceArb,
  nonEmptyStr,
  nonEmptyStr,
  validFencedResponseArb,
  async (unitSource, model, promptVersion, { fenced }) => {
    const cacheDir = await isolatedCacheDir("llm-compound");

    // First call: miss → client → validate → write.
    const card1 = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client: mockClient(fenced),
    });

    // Second call: hit → validate → return (offline=true confirms no client needed).
    const card2 = await extractIntent(unitSource, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      offline: true,
    });

    return (
      card1.sourceHash === card2.sourceHash &&
      card1.modelVersion === card2.modelVersion &&
      card1.promptVersion === card2.promptVersion &&
      card1.behavior === card2.behavior
    );
  },
);
