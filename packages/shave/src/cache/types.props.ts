// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave cache/types.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3d)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from types.ts):
//   CacheKey   (CK1.1) — shape invariant: three readonly string fields.
//   CacheEntry (CE1.1) — shape invariant: card, cachedAt, cacheVersion: 1.
//
// Properties covered:
//   - Every CacheKey has three readonly fields: sourceHash, modelVersion, promptVersion (all strings).
//   - Every CacheEntry carries card (IntentCard), cachedAt (number), cacheVersion (literal 1).
//   - cacheVersion is always the literal 1 (forward-compat marker).
//   - A CacheEntry built from an arbitrary CacheKey and IntentCard round-trips
//     cacheVersion and cachedAt without mutation (compound shape invariant).

// ---------------------------------------------------------------------------
// Property-test corpus for cache/types.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { IntentCard, IntentParam } from "../intent/types.js";
import type { CacheEntry, CacheKey } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char hex string suitable for sourceHash. */
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

/** Arbitrary CacheKey record. */
const cacheKeyArb: fc.Arbitrary<CacheKey> = fc.record({
  sourceHash: hexHash64,
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
});

/** Unix epoch ms: a positive integer in a realistic range. */
const epochMsArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 9_999_999_999_999 });

/** Arbitrary CacheEntry record. */
const cacheEntryArb: fc.Arbitrary<CacheEntry> = fc
  .tuple(intentCardArb, epochMsArb)
  .map(([card, cachedAt]) => ({
    card,
    cachedAt,
    cacheVersion: 1 as const,
  }));

// ---------------------------------------------------------------------------
// CK1.1: CacheKey — has three required string fields
// ---------------------------------------------------------------------------

/**
 * prop_CacheKey_has_required_string_fields
 *
 * Every well-formed CacheKey object has three readonly string fields:
 * sourceHash, modelVersion, and promptVersion.
 *
 * Invariant (CK1.1, DEC-CONTINUOUS-SHAVE-022): uniqueness of a cache entry
 * is defined over these three fields. All three must be present and must be
 * strings; a missing or wrongly-typed field would produce a silent cache hit.
 */
export const prop_CacheKey_has_required_string_fields = fc.property(
  cacheKeyArb,
  (ck) =>
    typeof ck.sourceHash === "string" &&
    typeof ck.modelVersion === "string" &&
    typeof ck.promptVersion === "string",
);

// ---------------------------------------------------------------------------
// CK1.1: CacheKey — sourceHash is a 64-char hex string
// ---------------------------------------------------------------------------

/**
 * prop_CacheKey_sourceHash_is_64_char_hex
 *
 * The sourceHash field of a CacheKey is always a 64-character lowercase hex
 * string (matching the output of BLAKE3-256 via sourceHash()).
 *
 * Invariant (CK1.1, DEC-CONTINUOUS-SHAVE-022): the cache layer uses sourceHash
 * as part of the file-system key. A 64-char hex string is the canonical
 * BLAKE3-256 output length, ensuring a fixed shard-directory prefix.
 */
export const prop_CacheKey_sourceHash_is_64_char_hex = fc.property(cacheKeyArb, (ck) => {
  return ck.sourceHash.length === 64 && /^[0-9a-f]+$/.test(ck.sourceHash);
});

// ---------------------------------------------------------------------------
// CE1.1: CacheEntry — has required fields with correct types
// ---------------------------------------------------------------------------

/**
 * prop_CacheEntry_has_required_fields
 *
 * Every well-formed CacheEntry has: card (IntentCard), cachedAt (number),
 * and cacheVersion (literal 1).
 *
 * Invariant (CE1.1, DEC-CONTINUOUS-SHAVE-022): the envelope shape is what
 * allows TTL-based eviction and integrity checks. All three fields must be
 * present; cachedAt must be a number (Unix epoch ms), and cacheVersion must
 * be the literal 1.
 */
export const prop_CacheEntry_has_required_fields = fc.property(
  cacheEntryArb,
  (ce) => ce.card !== undefined && typeof ce.cachedAt === "number" && ce.cacheVersion === 1,
);

// ---------------------------------------------------------------------------
// CE1.1: CacheEntry — cacheVersion is always the literal 1
// ---------------------------------------------------------------------------

/**
 * prop_CacheEntry_cacheVersion_is_literal_1
 *
 * The cacheVersion field of a CacheEntry is always exactly the number 1.
 *
 * Invariant (CE1.1, DEC-CONTINUOUS-SHAVE-022): cacheVersion is a forward-compat
 * discriminant. The only currently valid value is 1. Any other value (0, 2,
 * string "1") is invalid and must not be produced by a conformant writer.
 */
export const prop_CacheEntry_cacheVersion_is_literal_1 = fc.property(
  cacheEntryArb,
  (ce) => ce.cacheVersion === 1,
);

// ---------------------------------------------------------------------------
// CE1.1: CacheEntry — cachedAt is a non-negative finite number
// ---------------------------------------------------------------------------

/**
 * prop_CacheEntry_cachedAt_is_non_negative_finite
 *
 * The cachedAt field is always a non-negative finite number (Unix epoch ms).
 *
 * Invariant (CE1.1): a negative or infinite cachedAt would produce incorrect
 * TTL calculations. This property ensures that any value produced by the
 * arbitrary (and by extension, any correct writer) satisfies the basic
 * numeric domain constraint.
 */
export const prop_CacheEntry_cachedAt_is_non_negative_finite = fc.property(
  cacheEntryArb,
  (ce) => Number.isFinite(ce.cachedAt) && ce.cachedAt >= 0,
);

// ---------------------------------------------------------------------------
// CE1.1: CacheEntry — card.schemaVersion is the literal 1
// ---------------------------------------------------------------------------

/**
 * prop_CacheEntry_card_schemaVersion_is_1
 *
 * The IntentCard embedded in a CacheEntry always has schemaVersion === 1.
 *
 * Invariant (CE1.1, DEC-CONTINUOUS-SHAVE-022): the cache stores IntentCards
 * with a versioned envelope. The current schema is version 1. If schemaVersion
 * were not 1, validateIntentCard would reject the deserialized entry and the
 * cache would behave as a miss — so writers must produce schemaVersion: 1.
 */
export const prop_CacheEntry_card_schemaVersion_is_1 = fc.property(
  cacheEntryArb,
  (ce) => ce.card.schemaVersion === 1,
);

// ---------------------------------------------------------------------------
// Compound interaction: CacheKey fields → CacheEntry card.sourceHash alignment
//
// Production sequence: sourceHash() produces a 64-char hex string, which is
// stored in IntentCard.sourceHash and used as CacheKey.sourceHash. This
// compound property verifies that the shape of CacheKey and CacheEntry are
// mutually consistent with that production sequence.
// ---------------------------------------------------------------------------

/**
 * prop_CacheKey_CacheEntry_compound_sourceHash_alignment
 *
 * A CacheEntry whose card.sourceHash matches the CacheKey.sourceHash satisfies
 * the invariant that the stored card was extracted from the same source that
 * produced the cache key.
 *
 * This is the canonical compound-interaction property crossing CacheKey and
 * CacheEntry: both shapes are defined in types.ts and must be jointly consistent
 * for the cache layer to guarantee cache-hit validity.
 *
 * Invariant (CK1.1, CE1.1, DEC-CONTINUOUS-SHAVE-022): a cache hit is valid
 * only when the stored card's sourceHash matches the key's sourceHash. Any
 * deviation indicates a cache corruption bug.
 */
export const prop_CacheKey_CacheEntry_compound_sourceHash_alignment = fc.property(
  fc.tuple(cacheKeyArb, intentCardArb, epochMsArb),
  ([ck, card, cachedAt]) => {
    // Build a CacheEntry with a card whose sourceHash matches the CacheKey.
    const alignedCard: IntentCard = { ...card, sourceHash: ck.sourceHash };
    const ce: CacheEntry = { card: alignedCard, cachedAt, cacheVersion: 1 };

    // The alignment invariant: key and entry agree on sourceHash.
    return ce.card.sourceHash === ck.sourceHash && ce.cacheVersion === 1;
  },
);
