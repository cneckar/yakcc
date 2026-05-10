// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/constants.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3g)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from constants.ts):
//   DEFAULT_MODEL          (CON1.1) — non-empty, format haiku-4-5-YYYYMMDD
//   INTENT_PROMPT_VERSION  (CON1.2) — literal '1'
//   INTENT_SCHEMA_VERSION  (CON1.3) — const 1
//   STATIC_MODEL_TAG       (CON1.4) — literal 'static-ts@1'
//   STATIC_PROMPT_VERSION  (CON1.5) — literal 'static-jsdoc@1'
//   keyFromIntentInputs    (CON1.6) — domain disjointness via cache key
//
// Properties covered (3 atoms, 6 props):
//   (n) DEFAULT_MODEL non-empty, matches haiku-4-5-YYYYMMDD format
//   (o) INTENT_PROMPT_VERSION === '1' literal
//   (p) INTENT_SCHEMA_VERSION === 1 const number
//   (q) STATIC_MODEL_TAG === 'static-ts@1' literal
//   (r) STATIC_PROMPT_VERSION === 'static-jsdoc@1' literal
//   (s) keyFromIntentInputs domain disjointness — STATIC_MODEL_TAG vs Anthropic model id

// ---------------------------------------------------------------------------
// Property-test corpus for intent/constants.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
  STATIC_MODEL_TAG,
  STATIC_PROMPT_VERSION,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace, max 40 chars. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char lowercase hex string (BLAKE3-like, from nibble array). */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

// ---------------------------------------------------------------------------
// CON1.1 / (n): DEFAULT_MODEL is non-empty and matches expected format
// ---------------------------------------------------------------------------

/**
 * prop_constants_DEFAULT_MODEL_is_non_empty
 *
 * DEFAULT_MODEL must be a non-empty string.
 *
 * Invariant (CON1.1, DEC-CONTINUOUS-SHAVE-022): an empty DEFAULT_MODEL would
 * produce an invalid cache key component and potentially break LLM extraction.
 */
export const prop_constants_DEFAULT_MODEL_is_non_empty = fc.property(
  fc.constant(DEFAULT_MODEL),
  (model) => typeof model === "string" && model.length > 0,
);

/**
 * prop_constants_DEFAULT_MODEL_matches_haiku_format
 *
 * DEFAULT_MODEL matches the expected Anthropic Haiku 4.5 model identifier
 * format (claude-haiku-4-5-YYYYMMDD).
 *
 * Invariant (CON1.1, DEC-CONTINUOUS-SHAVE-022): the model identifier must be
 * parseable as a dated Haiku 4.5 model tag. Changing the identifier without
 * bumping the format sentinel invalidates all cached intent entries.
 */
export const prop_constants_DEFAULT_MODEL_matches_haiku_format = fc.property(
  fc.constant(DEFAULT_MODEL),
  (model) => /^claude-haiku-4-5-\d{8}$/.test(model),
);

// ---------------------------------------------------------------------------
// CON1.2 / (o): INTENT_PROMPT_VERSION is the literal string '1'
// ---------------------------------------------------------------------------

/**
 * prop_constants_INTENT_PROMPT_VERSION_is_string_1
 *
 * INTENT_PROMPT_VERSION must be the string literal '1'.
 *
 * Invariant (CON1.2, DEC-CONTINUOUS-SHAVE-022): the prompt version tag is a
 * string used in cache key derivation. Changing its value or type invalidates
 * all existing LLM-path cache entries and must be a deliberate decision.
 */
export const prop_constants_INTENT_PROMPT_VERSION_is_string_1 = fc.property(
  fc.constant(INTENT_PROMPT_VERSION),
  (v) => v === "1",
);

// ---------------------------------------------------------------------------
// CON1.3 / (p): INTENT_SCHEMA_VERSION is the const number 1
// ---------------------------------------------------------------------------

/**
 * prop_constants_INTENT_SCHEMA_VERSION_is_number_1
 *
 * INTENT_SCHEMA_VERSION must be the number 1 (not string "1", not 0, not 2).
 *
 * Invariant (CON1.3, DEC-CONTINUOUS-SHAVE-022): INTENT_SCHEMA_VERSION is used
 * in both cache key derivation and as the schemaVersion discriminant inside
 * IntentCard. It must be exactly the number 1 matching the schemaVersion field
 * accepted by validateIntentCard.
 */
export const prop_constants_INTENT_SCHEMA_VERSION_is_number_1 = fc.property(
  fc.constant(INTENT_SCHEMA_VERSION),
  (v) => v === 1 && typeof v === "number",
);

// ---------------------------------------------------------------------------
// CON1.4 / (q): STATIC_MODEL_TAG is the literal 'static-ts@1'
// ---------------------------------------------------------------------------

/**
 * prop_constants_STATIC_MODEL_TAG_is_literal
 *
 * STATIC_MODEL_TAG must be the exact string 'static-ts@1'.
 *
 * Invariant (CON1.4, DEC-INTENT-STATIC-CACHE-001): the '@'-separated versioned
 * tag format ensures it cannot equal any Anthropic model identifier, which
 * guarantees disjoint cache key namespaces by construction.
 */
export const prop_constants_STATIC_MODEL_TAG_is_literal = fc.property(
  fc.constant(STATIC_MODEL_TAG),
  (tag) => tag === "static-ts@1",
);

// ---------------------------------------------------------------------------
// CON1.5 / (r): STATIC_PROMPT_VERSION is the literal 'static-jsdoc@1'
// ---------------------------------------------------------------------------

/**
 * prop_constants_STATIC_PROMPT_VERSION_is_literal
 *
 * STATIC_PROMPT_VERSION must be the exact string 'static-jsdoc@1'.
 *
 * Invariant (CON1.5, DEC-INTENT-STATIC-CACHE-001): same isolation guarantee
 * as STATIC_MODEL_TAG — the '@'-versioned form cannot collide with numeric
 * LLM prompt version strings like '1' or '2'.
 */
export const prop_constants_STATIC_PROMPT_VERSION_is_literal = fc.property(
  fc.constant(STATIC_PROMPT_VERSION),
  (v) => v === "static-jsdoc@1",
);

// ---------------------------------------------------------------------------
// CON1.6 / (s): keyFromIntentInputs domain disjointness
// ---------------------------------------------------------------------------

/**
 * prop_constants_static_and_llm_cache_keys_are_disjoint
 *
 * For the same source text, keyFromIntentInputs with STATIC_MODEL_TAG /
 * STATIC_PROMPT_VERSION always produces a different cache key than with
 * any plausible Anthropic model identifier and numeric prompt version.
 *
 * Invariant (CON1.6, DEC-INTENT-STATIC-CACHE-001): static and LLM cards must
 * land in permanently disjoint cache namespaces. This property verifies the
 * disjointness guarantee for arbitrary source strings and a realistic set of
 * Anthropic model identifiers.
 */
export const prop_constants_static_and_llm_cache_keys_are_disjoint = fc.property(
  nonEmptyStr,
  // Plausible Anthropic model ids (won't contain '@')
  fc
    .string({ minLength: 4, maxLength: 30 })
    .filter((s) => !s.includes("@") && s.trim().length > 0),
  // Numeric prompt version strings
  fc
    .integer({ min: 1, max: 9 })
    .map((n) => String(n)),
  (src, llmModel, llmPromptVersion) => {
    const srcHashVal = sourceHash(src);

    const staticKey = keyFromIntentInputs({
      sourceHash: srcHashVal,
      modelTag: STATIC_MODEL_TAG,
      promptVersion: STATIC_PROMPT_VERSION,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });

    const llmKey = keyFromIntentInputs({
      sourceHash: srcHashVal,
      modelTag: llmModel,
      promptVersion: llmPromptVersion,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });

    return staticKey !== llmKey;
  },
);

/**
 * prop_constants_static_key_is_deterministic
 *
 * keyFromIntentInputs with STATIC_MODEL_TAG / STATIC_PROMPT_VERSION produces
 * the same cache key for the same source string on every invocation.
 *
 * Invariant (CON1.6, DEC-INTENT-STATIC-CACHE-001): the cache key derivation
 * is a pure function of the inputs. Non-determinism would cause spurious cache
 * misses on every call.
 */
export const prop_constants_static_key_is_deterministic = fc.property(hexHash64, (srcHashVal) => {
  const k1 = keyFromIntentInputs({
    sourceHash: srcHashVal,
    modelTag: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });
  const k2 = keyFromIntentInputs({
    sourceHash: srcHashVal,
    modelTag: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });
  return k1 === k2;
});
