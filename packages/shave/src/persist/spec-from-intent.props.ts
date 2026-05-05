// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave persist/spec-from-intent.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3c)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from spec-from-intent.ts):
//   specFromIntent (SFI1.1) — maps an IntentCard + canonicalAstHash to a SpecYak.
//
// Private helpers tested transitively via specFromIntent():
//   deriveSpecName  (SFI1.2-priv) — slug derivation: first 30 chars of behavior
//                                   (non-word → "-", strip leading/trailing "-")
//                                   + "-" + last 6 chars of canonicalAstHash.
//   mapParam        (SFI1.3-priv) — IntentParam → SpecYakParameter (typeHint → type).
//
// Properties covered:
//   - For any well-formed IntentCard, specFromIntent does not throw.
//   - The returned SpecYak.level is always "L0".
//   - The returned SpecYak.invariants is always an empty array.
//   - The returned SpecYak.effects is always an empty array.
//   - The SpecYak.name ends with the last 6 chars of canonicalAstHash.
//   - Input parameters round-trip: inputs.length equals intentCard.inputs.length.
//   - Output parameters round-trip: outputs.length equals intentCard.outputs.length.
//   - Each input's type equals the source IntentParam.typeHint.
//   - preconditions round-trips the IntentCard.preconditions array.
//   - postconditions round-trips the IntentCard.postconditions array.
//   - specFromIntent is deterministic: identical inputs produce identical SpecYak.
//   - validateSpecYak does not throw on the returned SpecYak (sanity pass).
//
// Deferred atoms:
//   - Negative-case (malformed IntentCard throwing TypeError) — the existing
//     spec-from-intent.test.ts covers explicit negative cases. Corpus covers
//     the positive invariant domain per deferred-atoms documentation.

// ---------------------------------------------------------------------------
// Property-test corpus for persist/spec-from-intent.ts
// ---------------------------------------------------------------------------

import { validateSpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import type { IntentCard } from "../intent/types.js";
import { specFromIntent } from "./spec-from-intent.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary that produces a non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary that produces a 64-char hex string suitable for a CanonicalAstHash. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Arbitrary for a single IntentParam. */
const intentParamArb = fc.record({
  name: nonEmptyStr,
  typeHint: nonEmptyStr,
  description: fc.string({ minLength: 0, maxLength: 40 }),
});

/** Arbitrary for a well-formed IntentCard (schemaVersion always 1). */
const intentCardArb: fc.Arbitrary<IntentCard> = fc.record({
  schemaVersion: fc.constant(1 as const),
  behavior: nonEmptyStr,
  inputs: fc.array(intentParamArb, { minLength: 0, maxLength: 3 }),
  outputs: fc.array(intentParamArb, { minLength: 0, maxLength: 3 }),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
  sourceHash: hexHash64,
  extractedAt: fc.constant("2024-01-01T00:00:00.000Z"),
});

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — does not throw for well-formed input
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_does_not_throw
 *
 * For any well-formed IntentCard and any 64-char hex canonicalAstHash,
 * specFromIntent() does not throw.
 *
 * Invariant (SFI1.1): the function is total on the well-formed input domain.
 * No runtime IO, no external dependencies — pure computation.
 */
export const prop_specFromIntent_does_not_throw = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    try {
      specFromIntent(card, hash);
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — level is always "L0"
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_level_is_L0
 *
 * The returned SpecYak always has level === "L0".
 *
 * Invariant (SFI1.1, DEC-TRIPLET-L0-ONLY-019): specFromIntent hard-codes "L0"
 * as the level; callers that need L1/L2/L3 require a separate upgrade path.
 */
export const prop_specFromIntent_level_is_L0 = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return spec.level === "L0";
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — invariants is always empty
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_invariants_is_empty
 *
 * The returned SpecYak.invariants is always an empty array.
 *
 * Invariant (SFI1.1): atoms are pure-by-default at L0; invariant derivation
 * is future work (per DEC-ATOM-PERSIST-001 rationale).
 */
export const prop_specFromIntent_invariants_is_empty = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return Array.isArray(spec.invariants) && spec.invariants.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — effects is always empty
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_effects_is_empty
 *
 * The returned SpecYak.effects is always an empty array.
 *
 * Invariant (SFI1.1): atoms are pure-by-default at L0; effect inference is
 * future work (per DEC-ATOM-PERSIST-001 rationale).
 */
export const prop_specFromIntent_effects_is_empty = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return Array.isArray(spec.effects) && spec.effects.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SFI1.2-priv: deriveSpecName — name ends with last 6 chars of hash
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_name_ends_with_hash_suffix
 *
 * The returned SpecYak.name always ends with the last 6 characters of
 * canonicalAstHash, preceded by a hyphen.
 *
 * Invariant (SFI1.2-priv): the name slug is formed as
 * `<slugified-behavior>-<last6>`. The hash suffix disambiguates behaviors
 * that share the same first-30-char prefix, and it is deterministic for
 * identical inputs (required for content-addressed provenance).
 */
export const prop_specFromIntent_name_ends_with_hash_suffix = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    const suffix = hash.slice(-6);
    return spec.name.endsWith(`-${suffix}`);
  },
);

// ---------------------------------------------------------------------------
// SFI1.3-priv: mapParam — inputs length round-trip
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_inputs_length_matches
 *
 * spec.inputs.length === intentCard.inputs.length for all well-formed inputs.
 *
 * Invariant (SFI1.3-priv): mapParam is applied uniformly via Array.map;
 * no inputs are dropped or duplicated during the mapping.
 */
export const prop_specFromIntent_inputs_length_matches = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return spec.inputs.length === card.inputs.length;
  },
);

// ---------------------------------------------------------------------------
// SFI1.3-priv: mapParam — outputs length round-trip
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_outputs_length_matches
 *
 * spec.outputs.length === intentCard.outputs.length for all well-formed inputs.
 *
 * Invariant (SFI1.3-priv): outputs array is mapped the same way as inputs;
 * the result length is always equal to the source array.
 */
export const prop_specFromIntent_outputs_length_matches = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return spec.outputs.length === card.outputs.length;
  },
);

// ---------------------------------------------------------------------------
// SFI1.3-priv: mapParam — typeHint maps to type field
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_input_type_equals_typehint
 *
 * For every input parameter, spec.inputs[i].type === intentCard.inputs[i].typeHint.
 *
 * Invariant (SFI1.3-priv): mapParam renames typeHint → type; all other fields
 * are forwarded verbatim. No inputs array means the property trivially holds.
 */
export const prop_specFromIntent_input_type_equals_typehint = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    return card.inputs.every((param, i) => spec.inputs[i]?.type === param.typeHint);
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — preconditions round-trip
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_preconditions_roundtrip
 *
 * spec.preconditions contains the same strings as intentCard.preconditions,
 * in the same order.
 *
 * Invariant (SFI1.1): preconditions are copied verbatim via Array.from();
 * no transformation is applied.
 */
export const prop_specFromIntent_preconditions_roundtrip = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    if (spec.preconditions.length !== card.preconditions.length) return false;
    return card.preconditions.every((cond, i) => spec.preconditions[i] === cond);
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — postconditions round-trip
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_postconditions_roundtrip
 *
 * spec.postconditions contains the same strings as intentCard.postconditions,
 * in the same order.
 *
 * Invariant (SFI1.1): postconditions are copied verbatim via Array.from();
 * no transformation is applied.
 */
export const prop_specFromIntent_postconditions_roundtrip = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const spec = specFromIntent(card, hash);
    if (spec.postconditions.length !== card.postconditions.length) return false;
    return card.postconditions.every((cond, i) => spec.postconditions[i] === cond);
  },
);

// ---------------------------------------------------------------------------
// SFI1.1: specFromIntent — determinism
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_is_deterministic
 *
 * Two calls to specFromIntent() with identical inputs return SpecYak values
 * with identical names, levels, and array lengths.
 *
 * Invariant (SFI1.1): specFromIntent is a pure function — no timestamps,
 * random bytes, or counters in the derivation. The name slug is deterministic
 * by construction (deriveSpecName uses only the behavior text and hash suffix).
 */
export const prop_specFromIntent_is_deterministic = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    const s1 = specFromIntent(card, hash);
    const s2 = specFromIntent(card, hash);
    return (
      s1.name === s2.name &&
      s1.level === s2.level &&
      s1.inputs.length === s2.inputs.length &&
      s1.outputs.length === s2.outputs.length &&
      s1.preconditions.length === s2.preconditions.length &&
      s1.postconditions.length === s2.postconditions.length
    );
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: specFromIntent → validateSpecYak (end-to-end)
//
// Production sequence: IntentCard + canonicalAstHash → specFromIntent()
// → SpecYak → validateSpecYak() (called inside specFromIntent and here again).
// This crosses the boundary of specFromIntent + the contracts validator.
// ---------------------------------------------------------------------------

/**
 * prop_specFromIntent_output_passes_validateSpecYak
 *
 * The SpecYak returned by specFromIntent() is always valid per validateSpecYak(),
 * called independently after the fact.
 *
 * This is the canonical compound-interaction property crossing:
 *   specFromIntent() → mapParam() + deriveSpecName() → SpecYak shape
 *   → validateSpecYak() from @yakcc/contracts
 *
 * Invariant (SFI1.1 + DEC-TRIPLET-IDENTITY-020): every SpecYak produced by
 * the mapping satisfies the contracts validator's required-field and level checks.
 */
export const prop_specFromIntent_output_passes_validateSpecYak = fc.property(
  intentCardArb,
  hexHash64,
  (card, hash) => {
    try {
      const spec = specFromIntent(card, hash);
      validateSpecYak(spec);
      return true;
    } catch {
      return false;
    }
  },
);
