// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for canonicalize.ts atoms.
// Atoms covered: canonicalize (A1.3), canonicalizeText (A1.4)

import * as fc from "fast-check";
import { canonicalize, canonicalizeText } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Shared arbitrary for ContractSpec (reused across both canonicalize atoms)
// ---------------------------------------------------------------------------

const purityArb = fc.constantFrom("pure", "io", "stateful", "nondeterministic") as fc.Arbitrary<
  "pure" | "io" | "stateful" | "nondeterministic"
>;
const threadSafetyArb = fc.constantFrom("safe", "unsafe", "sequential") as fc.Arbitrary<
  "safe" | "unsafe" | "sequential"
>;

const typeSignatureArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 32 }),
  type: fc.string({ minLength: 1, maxLength: 64 }),
  description: fc.option(fc.string({ maxLength: 128 }), { nil: undefined }),
});

const behavioralGuaranteeArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  description: fc.string({ minLength: 1, maxLength: 256 }),
});

const errorConditionArb = fc.record({
  description: fc.string({ minLength: 1, maxLength: 256 }),
  errorType: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
});

const propertyTestCaseArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  description: fc.string({ minLength: 1, maxLength: 256 }),
  arbitraries: fc.option(fc.array(fc.string({ maxLength: 64 })), { nil: undefined }),
});

export const contractSpecArb: fc.Arbitrary<ContractSpec> = fc.record({
  inputs: fc.array(typeSignatureArb, { maxLength: 6 }),
  outputs: fc.array(typeSignatureArb, { maxLength: 4 }),
  behavior: fc.string({ minLength: 1, maxLength: 256 }),
  guarantees: fc.array(behavioralGuaranteeArb, { maxLength: 6 }),
  errorConditions: fc.array(errorConditionArb, { maxLength: 6 }),
  nonFunctional: fc.record({
    purity: purityArb,
    threadSafety: threadSafetyArb,
    time: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
    space: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
  }),
  propertyTests: fc.array(propertyTestCaseArb, { maxLength: 6 }),
});

// ---------------------------------------------------------------------------
// A1.3: canonicalize properties
// ---------------------------------------------------------------------------

/**
 * prop_canonicalize_deterministic
 *
 * For every ContractSpec, two calls to canonicalize produce byte-equal Uint8Arrays.
 * Invariant: canonicalize is a pure, deterministic function.
 */
export const prop_canonicalize_deterministic = fc.property(contractSpecArb, (spec) => {
  const a = canonicalize(spec);
  const b = canonicalize(spec);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
});

/**
 * prop_canonicalize_field_order_invariant
 *
 * Permuting object key insertion order in the input spec produces identical bytes.
 * Uses a fixed set of re-ordered spec literals to verify key-sorting is applied.
 * Invariant: the canonical form sorts keys lexicographically regardless of insertion order.
 */
export const prop_canonicalize_field_order_invariant = fc.property(contractSpecArb, (spec) => {
  // Re-create the spec with keys in reversed order to exercise key-sorting.
  const reversed: ContractSpec = {
    propertyTests: spec.propertyTests,
    nonFunctional: {
      space: spec.nonFunctional.space,
      time: spec.nonFunctional.time,
      threadSafety: spec.nonFunctional.threadSafety,
      purity: spec.nonFunctional.purity,
    },
    errorConditions: spec.errorConditions,
    guarantees: spec.guarantees,
    behavior: spec.behavior,
    outputs: spec.outputs,
    inputs: spec.inputs,
  };
  const a = canonicalize(spec);
  const b = canonicalize(reversed);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
});

/**
 * prop_canonicalize_array_order_sensitive
 *
 * Swapping two distinct elements in the inputs array produces different bytes.
 * Invariant: array element order is preserved in the canonical form (not sorted).
 * Guards against accidental sorting of array fields.
 */
export const prop_canonicalize_array_order_sensitive = fc.property(
  contractSpecArb.filter((spec) => spec.inputs.length >= 2),
  (spec) => {
    const [a, b, ...rest] = spec.inputs;
    if (!a || !b) return true; // guard — filter should prevent this
    if (JSON.stringify(a) === JSON.stringify(b)) return true; // identical inputs — skip

    const swapped: ContractSpec = {
      ...spec,
      inputs: [b, a, ...rest],
    };
    const canonical1 = canonicalize(spec);
    const canonical2 = canonicalize(swapped);
    // Swapping distinct elements must produce different bytes.
    if (canonical1.length !== canonical2.length) return true;
    for (let i = 0; i < canonical1.length; i++) {
      if (canonical1[i] !== canonical2[i]) return true;
    }
    return false; // all bytes identical — property violated
  },
);

/**
 * prop_canonicalize_utf8_decodable
 *
 * For every ContractSpec, the output bytes round-trip cleanly through
 * TextDecoder("utf-8", { fatal: true }) — i.e. the bytes are valid UTF-8.
 * Invariant: the canonical form is well-formed UTF-8 JSON.
 */
export const prop_canonicalize_utf8_decodable = fc.property(contractSpecArb, (spec) => {
  const bytes = canonicalize(spec);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const text = decoder.decode(bytes);
    return typeof text === "string" && text.length > 0;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// A1.4: canonicalizeText properties
// ---------------------------------------------------------------------------

/**
 * prop_canonicalizeText_matches_canonicalize
 *
 * For every ContractSpec, canonicalizeText(s) equals
 * new TextDecoder().decode(canonicalize(s)).
 * Invariant: canonicalizeText is exactly canonicalize decoded as UTF-8.
 */
export const prop_canonicalizeText_matches_canonicalize = fc.property(contractSpecArb, (spec) => {
  const textFromBytes = new TextDecoder().decode(canonicalize(spec));
  const directText = canonicalizeText(spec);
  return textFromBytes === directText;
});

/**
 * prop_canonicalizeText_deterministic
 *
 * For every ContractSpec, two calls to canonicalizeText return identical strings.
 * Invariant: canonicalizeText is a pure, deterministic function.
 */
export const prop_canonicalizeText_deterministic = fc.property(contractSpecArb, (spec) => {
  const t1 = canonicalizeText(spec);
  const t2 = canonicalizeText(spec);
  return t1 === t2;
});
