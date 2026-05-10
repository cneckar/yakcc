// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave cache/key.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3d)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from key.ts):
//   sourceHash        (SH1.1) — BLAKE3-256 hex of normalized source.
//   IntentKeyInputs   (IK1.1) — shape invariant: four readonly fields.
//   keyFromIntentInputs (KI1.1) — composite BLAKE3 key with NUL delimiters.
//
// Properties covered:
//   - sourceHash returns a 64-char lowercase hex string for any input.
//   - sourceHash is deterministic: same input → same hash.
//   - sourceHash normalizes line endings: sourceHash('a\r\nb') === sourceHash('a\nb').
//   - sourceHash trims outer whitespace (relies on normalizeSource).
//   - IntentKeyInputs shape: four readonly fields present with correct types.
//   - keyFromIntentInputs returns a 64-char lowercase hex string.
//   - keyFromIntentInputs is deterministic: same inputs → same key.
//   - keyFromIntentInputs is collision-resistant across field boundaries (NUL-delimiter property).
//   - keyFromIntentInputs distinct inputs → distinct keys (for reasonable variations).

// ---------------------------------------------------------------------------
// Property-test corpus for cache/key.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { type IntentKeyInputs, keyFromIntentInputs, sourceHash } from "./key.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char hex string (for sourceHash field). */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Arbitrary well-formed IntentKeyInputs. */
const intentKeyInputsArb: fc.Arbitrary<IntentKeyInputs> = fc.record({
  sourceHash: hexHash64,
  modelTag: nonEmptyStr,
  promptVersion: nonEmptyStr,
  schemaVersion: fc.integer({ min: 1, max: 10 }),
});

/** Arbitrary raw source string (may contain CRLF and whitespace). */
const rawSourceArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 200 });

// ---------------------------------------------------------------------------
// SH1.1: sourceHash — returns 64-char lowercase hex
// ---------------------------------------------------------------------------

/**
 * prop_sourceHash_returns_64_char_hex
 *
 * For any input string, sourceHash returns exactly a 64-character string
 * consisting only of lowercase hexadecimal digits [0-9a-f].
 *
 * Invariant (SH1.1, DEC-CONTINUOUS-SHAVE-022): BLAKE3-256 produces a 32-byte
 * digest; bytesToHex encodes it as 64 lowercase hex chars. Any deviation
 * indicates a hash function regression or encoding error.
 */
export const prop_sourceHash_returns_64_char_hex = fc.property(rawSourceArb, (s) => {
  const h = sourceHash(s);
  return h.length === 64 && /^[0-9a-f]+$/.test(h);
});

// ---------------------------------------------------------------------------
// SH1.1: sourceHash — deterministic
// ---------------------------------------------------------------------------

/**
 * prop_sourceHash_is_deterministic
 *
 * Two calls to sourceHash with the same input return the same 64-char hex
 * string.
 *
 * Invariant (SH1.1, DEC-CONTINUOUS-SHAVE-022): sourceHash is a pure function.
 * The underlying BLAKE3 hash is deterministic, and normalizeSource is a pure
 * transform. No random or time-dependent state enters the computation.
 */
export const prop_sourceHash_is_deterministic = fc.property(rawSourceArb, (s) => {
  const h1 = sourceHash(s);
  const h2 = sourceHash(s);
  return h1 === h2;
});

// ---------------------------------------------------------------------------
// SH1.1: sourceHash — CRLF and LF produce identical hash
// ---------------------------------------------------------------------------

/**
 * prop_sourceHash_crlf_lf_equivalence
 *
 * sourceHash('a\r\nb') === sourceHash('a\nb') for any multi-line source.
 *
 * Invariant (SH1.1, DEC-CONTINUOUS-SHAVE-022): the normalizeSource step
 * maps CRLF→LF before hashing. This property verifies that the normalization
 * propagates through the full hash pipeline so editor line-ending settings
 * cannot produce distinct cache keys.
 */
export const prop_sourceHash_crlf_lf_equivalence = fc.property(
  fc
    .array(
      fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("\r")),
      { minLength: 1, maxLength: 6 },
    )
    .map((lines) => lines.join("\n")),
  (lfStr) => {
    const crlfStr = lfStr.replace(/\n/g, "\r\n");
    return sourceHash(lfStr) === sourceHash(crlfStr);
  },
);

// ---------------------------------------------------------------------------
// SH1.1: sourceHash — outer whitespace is trimmed
// ---------------------------------------------------------------------------

/**
 * prop_sourceHash_trims_outer_whitespace
 *
 * sourceHash('  content  ') === sourceHash('content') when both strings have
 * the same inner content after trimming.
 *
 * Invariant (SH1.1, DEC-CONTINUOUS-SHAVE-022): trailing newlines and leading
 * indentation must not produce distinct cache keys for the same logical content.
 */
export const prop_sourceHash_trims_outer_whitespace = fc.property(
  fc
    .string({ minLength: 1, maxLength: 80 })
    .filter((s) => s.trim().length > 0 && !s.includes("\r")),
  (inner) => {
    return sourceHash(`   ${inner}   `) === sourceHash(inner.trim());
  },
);

// ---------------------------------------------------------------------------
// IK1.1: IntentKeyInputs — shape invariant
// ---------------------------------------------------------------------------

/**
 * prop_IntentKeyInputs_has_required_fields
 *
 * Every well-formed IntentKeyInputs object has four readonly fields:
 * sourceHash (string), modelTag (string), promptVersion (string),
 * and schemaVersion (number).
 *
 * Invariant (IK1.1, DEC-CONTINUOUS-SHAVE-022): the composite cache key
 * encodes all four fields so that any change in any dimension (source,
 * model, prompt, schema) produces a distinct key and a cache miss.
 */
export const prop_IntentKeyInputs_has_required_fields = fc.property(
  intentKeyInputsArb,
  (inputs) =>
    typeof inputs.sourceHash === "string" &&
    typeof inputs.modelTag === "string" &&
    typeof inputs.promptVersion === "string" &&
    typeof inputs.schemaVersion === "number",
);

// ---------------------------------------------------------------------------
// KI1.1: keyFromIntentInputs — returns 64-char lowercase hex
// ---------------------------------------------------------------------------

/**
 * prop_keyFromIntentInputs_returns_64_char_hex
 *
 * For any well-typed IntentKeyInputs, keyFromIntentInputs returns exactly a
 * 64-character lowercase hex string.
 *
 * Invariant (KI1.1, DEC-CONTINUOUS-SHAVE-022): the composite key is
 * BLAKE3-256 of the NUL-delimited concatenation. The 64-char hex output
 * is the fixed-length cache filename stem.
 */
export const prop_keyFromIntentInputs_returns_64_char_hex = fc.property(
  intentKeyInputsArb,
  (inputs) => {
    const k = keyFromIntentInputs(inputs);
    return k.length === 64 && /^[0-9a-f]+$/.test(k);
  },
);

// ---------------------------------------------------------------------------
// KI1.1: keyFromIntentInputs — deterministic
// ---------------------------------------------------------------------------

/**
 * prop_keyFromIntentInputs_is_deterministic
 *
 * Two calls to keyFromIntentInputs with the same IntentKeyInputs return the
 * same 64-char hex key.
 *
 * Invariant (KI1.1, DEC-CONTINUOUS-SHAVE-022): the composite key must be
 * reproducible across runs so the cache can locate entries written in a
 * previous session.
 */
export const prop_keyFromIntentInputs_is_deterministic = fc.property(
  intentKeyInputsArb,
  (inputs) => {
    const k1 = keyFromIntentInputs(inputs);
    const k2 = keyFromIntentInputs(inputs);
    return k1 === k2;
  },
);

// ---------------------------------------------------------------------------
// KI1.1: keyFromIntentInputs — collision-resistant across field boundaries
// ---------------------------------------------------------------------------

/**
 * prop_keyFromIntentInputs_nul_delimiter_prevents_prefix_collision
 *
 * Two IntentKeyInputs records that differ only in how a value is split
 * across two adjacent fields produce distinct keys.
 *
 * Example: { sourceHash: "ab", modelTag: "cd" } vs
 *          { sourceHash: "a",  modelTag: "bcd" }
 *
 * Without NUL delimiters, both would hash "abcd" and collide. With NUL
 * delimiters ("ab\x00cd\x00..." vs "a\x00bcd\x00..."), they diverge.
 *
 * Invariant (KI1.1, DEC-CONTINUOUS-SHAVE-022): "NUL delimiters prevent
 * collisions where one field's value is a prefix of another." This property
 * exercises the pathological prefix case directly.
 */
export const prop_keyFromIntentInputs_nul_delimiter_prevents_prefix_collision = fc.property(
  fc
    .tuple(nonEmptyStr, nonEmptyStr)
    .filter(([a, b]) => a.length > 1 && !a.includes("\x00") && !b.includes("\x00")),
  ([combined, modelTag]) => {
    // Construct two inputs where sourceHash+modelTag boundary differs.
    const splitAt = Math.floor(combined.length / 2);
    const inputsA: IntentKeyInputs = {
      sourceHash: combined.slice(0, splitAt),
      modelTag: combined.slice(splitAt) + modelTag,
      promptVersion: "v1",
      schemaVersion: 1,
    };
    const inputsB: IntentKeyInputs = {
      sourceHash: combined.slice(0, splitAt + 1),
      modelTag: combined.slice(splitAt + 1) + modelTag,
      promptVersion: "v1",
      schemaVersion: 1,
    };
    // If inputs are different, keys must be different.
    if (inputsA.sourceHash === inputsB.sourceHash && inputsA.modelTag === inputsB.modelTag) {
      return true; // trivially consistent (no split diff)
    }
    return keyFromIntentInputs(inputsA) !== keyFromIntentInputs(inputsB);
  },
);

// ---------------------------------------------------------------------------
// KI1.1: keyFromIntentInputs — any field change yields distinct key
// ---------------------------------------------------------------------------

/**
 * prop_keyFromIntentInputs_distinct_inputs_yield_distinct_keys
 *
 * Two IntentKeyInputs that differ in at least one field (modelTag changed)
 * produce distinct keys.
 *
 * Invariant (KI1.1, DEC-CONTINUOUS-SHAVE-022): the composite key must encode
 * all four fields so that changing any single field causes a cache miss. This
 * property verifies the modelTag dimension.
 */
export const prop_keyFromIntentInputs_distinct_inputs_yield_distinct_keys = fc.property(
  fc
    .tuple(intentKeyInputsArb, nonEmptyStr)
    .filter(([inputs, altTag]) => inputs.modelTag !== altTag),
  ([inputs, altTag]) => {
    const modified: IntentKeyInputs = { ...inputs, modelTag: altTag };
    return keyFromIntentInputs(inputs) !== keyFromIntentInputs(modified);
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: sourceHash → keyFromIntentInputs (end-to-end pipeline)
//
// Production sequence: raw source → sourceHash() → IntentKeyInputs.sourceHash
// → keyFromIntentInputs() → cache filename.
// This exercises the full cache-key derivation pipeline crossing key.ts
// and the normalizeSource dependency.
// ---------------------------------------------------------------------------

/**
 * prop_sourceHash_to_keyFromIntentInputs_compound_pipeline
 *
 * Given a raw source string and model/prompt/schema context, computing
 * sourceHash(raw) and feeding it into keyFromIntentInputs produces a
 * deterministic 64-char hex composite key that is stable under CRLF
 * normalization.
 *
 * This is the canonical compound-interaction property crossing:
 *   raw source → sourceHash() → IntentKeyInputs → keyFromIntentInputs()
 *   → 64-char hex composite cache key
 *
 * Invariant (SH1.1, KI1.1, DEC-CONTINUOUS-SHAVE-022): the full key-derivation
 * pipeline must be deterministic and CRLF-invariant end-to-end. Two runs with
 * the same source (regardless of CRLF vs LF) must produce the identical
 * composite cache key so cache lookups succeed across platforms.
 */
export const prop_sourceHash_to_keyFromIntentInputs_compound_pipeline = fc.property(
  fc
    .array(
      fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("\r")),
      { minLength: 1, maxLength: 5 },
    )
    .map((lines) => lines.join("\n")),
  nonEmptyStr,
  nonEmptyStr,
  fc.integer({ min: 1, max: 5 }),
  (lfSource, modelTag, promptVersion, schemaVersion) => {
    const crlfSource = lfSource.replace(/\n/g, "\r\n");

    const shLf = sourceHash(lfSource);
    const shCrlf = sourceHash(crlfSource);

    // sourceHash must be CRLF-invariant.
    if (shLf !== shCrlf) return false;

    const inputsLf: IntentKeyInputs = {
      sourceHash: shLf,
      modelTag,
      promptVersion,
      schemaVersion,
    };
    const inputsCrlf: IntentKeyInputs = {
      sourceHash: shCrlf,
      modelTag,
      promptVersion,
      schemaVersion,
    };

    const keyLf = keyFromIntentInputs(inputsLf);
    const keyCrlf = keyFromIntentInputs(inputsCrlf);

    // Composite keys must be equal and be 64-char hex.
    return keyLf === keyCrlf && keyLf.length === 64 && /^[0-9a-f]+$/.test(keyLf);
  },
);
