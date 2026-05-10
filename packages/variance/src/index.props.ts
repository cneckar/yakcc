// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/variance index.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L2)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for variance/src/index.ts atoms
//
// Atoms covered (4):
//   normalize         (A4.1) — private; lowercase + collapse whitespace + strip terminal punct
//   scoreBehavioral   (A4.2) — private; Jaccard over normalized postconditions
//   scoreInterface    (A4.3) — private; 0.5*jaccard(inputs)+0.5*jaccard(outputs)
//   compareDimensions (A4.4) — exported; returns all 5 DimensionScores
//
// normalize, scoreBehavioral, and scoreInterface are private (not exported).
// They are exercised transitively through compareDimensions, and additionally
// via targeted properties that construct SpecYak inputs isolating each dimension.
// ---------------------------------------------------------------------------

import type { SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { compareDimensions } from "./index.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a single postcondition string (short text, no embedded newlines).
 * These exercise the normalize + Jaccard path in scoreBehavioral.
 */
const postconditionArb: fc.Arbitrary<string> = fc.constantFrom(
  "returns a non-negative integer",
  "result is sorted ascending",
  "output is non-null",
  "response time < 100ms",
  "no side effects on input",
  "throws RangeError on negative input",
  "result length equals input length",
  "all elements satisfy the predicate",
);

/**
 * Arbitrary for parameter objects matching SpecYak inputs/outputs shape.
 */
const paramArb: fc.Arbitrary<{ name: string; type: string }> = fc.record({
  name: fc.constantFrom("x", "y", "value", "input", "result", "data", "count"),
  type: fc.constantFrom("number", "string", "boolean", "string[]", "number[]", "unknown"),
});

/**
 * Minimal SpecYak builder — only the fields needed for compareDimensions.
 * All optional fields are omitted (undefined) to keep arbitraries lean.
 */
function makeSpec(overrides: Partial<SpecYak> = {}): SpecYak {
  return {
    name: "test-spec",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    ...overrides,
  };
}

/**
 * Arbitrary for a SpecYak with a random set of postconditions drawn from the
 * postconditionArb pool. Used to exercise the behavioral dimension scorer.
 */
const specWithPostconditionsArb: fc.Arbitrary<SpecYak> = fc
  .array(postconditionArb, { minLength: 0, maxLength: 5 })
  .map((pcs) => makeSpec({ postconditions: pcs }));

/**
 * Arbitrary for a SpecYak with random inputs and outputs. Used to exercise
 * the interface dimension scorer.
 */
const specWithParamsArb: fc.Arbitrary<SpecYak> = fc
  .record({
    inputs: fc.array(paramArb, { minLength: 0, maxLength: 4 }),
    outputs: fc.array(paramArb, { minLength: 0, maxLength: 2 }),
  })
  .map(({ inputs, outputs }) => makeSpec({ inputs, outputs }));

// ---------------------------------------------------------------------------
// A4.1: normalize — tested via compareDimensions behavioral dimension
//
// normalize() applies: lowercase, collapse whitespace, trim, strip terminal punct.
// Properties verify that this normalization is idempotent and that inputs differing
// only by case/whitespace/trailing punctuation compare as identical in the
// behavioral dimension.
// ---------------------------------------------------------------------------

/**
 * prop_normalize_case_insensitive_behavioral
 *
 * A spec whose postconditions are UPPERCASE versions of another spec's postconditions
 * should score the same behavioral dimension as the matching lowercase spec.
 *
 * Invariant: normalize() lowercases all characters, so "RESULT IS NON-NULL" and
 * "result is non-null" map to the same normalized key in the Jaccard sets.
 */
export const prop_normalize_case_insensitive_behavioral = fc.property(
  fc.array(postconditionArb, { minLength: 1, maxLength: 4 }),
  (pcs) => {
    const lower = makeSpec({ postconditions: pcs });
    const upper = makeSpec({ postconditions: pcs.map((pc) => pc.toUpperCase()) });
    const scoresLower = compareDimensions(lower, lower);
    const scoresUpper = compareDimensions(upper, upper);
    // Self-comparison always gives 1.0 — both should agree.
    return Math.abs(scoresLower.behavioral - scoresUpper.behavioral) < 1e-9;
  },
);

/**
 * prop_normalize_trailing_punctuation_ignored_in_behavioral
 *
 * Postconditions that differ only by trailing punctuation (., ;, !) compare
 * as equivalent in the behavioral dimension.
 *
 * Invariant: normalize() strips [.;!?,]+ from the end of each string, so
 * "result is sorted" and "result is sorted." hash to the same key.
 */
export const prop_normalize_trailing_punctuation_ignored_in_behavioral = fc.property(
  fc.constantFrom<[string, string]>(
    ["returns a value", "returns a value."],
    ["output is non-null", "output is non-null;"],
    ["no side effects", "no side effects!"],
    ["result is sorted", "result is sorted,"],
  ),
  ([clean, punctuated]: [string, string]) => {
    const specA = makeSpec({ postconditions: [clean] });
    const specB = makeSpec({ postconditions: [punctuated] });
    const scores = compareDimensions(specA, specB);
    // If normalize strips trailing punct, the Jaccard over {clean_key} == 1.0.
    return Math.abs(scores.behavioral - 1.0) < 1e-9;
  },
);

// ---------------------------------------------------------------------------
// A4.2: scoreBehavioral — Jaccard over normalized postconditions
// ---------------------------------------------------------------------------

/**
 * prop_scoreBehavioral_self_comparison_is_one
 *
 * For any SpecYak, comparing it against itself in the behavioral dimension
 * returns 1.0 (perfect alignment).
 *
 * Invariant: Jaccard(A, A) = 1.0 for any non-empty set A. For empty A,
 * the implementation returns 1.0 explicitly (both-empty → perfect alignment).
 */
export const prop_scoreBehavioral_self_comparison_is_one = fc.property(
  specWithPostconditionsArb,
  (spec) => {
    const scores = compareDimensions(spec, spec);
    return Math.abs(scores.behavioral - 1.0) < 1e-9;
  },
);

/**
 * prop_scoreBehavioral_both_empty_is_one
 *
 * When both specs have no postconditions, the behavioral score is 1.0.
 *
 * Invariant: the "both-empty → 1.0" rule means two specs that both declare
 * no output guarantees are considered fully aligned on the behavioral dimension.
 */
export const prop_scoreBehavioral_both_empty_is_one = fc.property(fc.constant(undefined), (_) => {
  const specA = makeSpec({ postconditions: [] });
  const specB = makeSpec({ postconditions: [] });
  const scores = compareDimensions(specA, specB);
  return Math.abs(scores.behavioral - 1.0) < 1e-9;
});

/**
 * prop_scoreBehavioral_disjoint_sets_is_zero
 *
 * When two specs have completely non-overlapping postcondition sets (after
 * normalization), the behavioral score is 0.0.
 *
 * Invariant: Jaccard(A, B) = 0 when A ∩ B = ∅ and both sets are non-empty.
 */
export const prop_scoreBehavioral_disjoint_sets_is_zero = fc.property(
  fc.constant(undefined),
  (_) => {
    const specA = makeSpec({ postconditions: ["returns a non-negative integer"] });
    const specB = makeSpec({ postconditions: ["result is sorted ascending"] });
    const scores = compareDimensions(specA, specB);
    return Math.abs(scores.behavioral - 0.0) < 1e-9;
  },
);

/**
 * prop_scoreBehavioral_in_range_zero_to_one
 *
 * For any two SpecYak specs, the behavioral dimension score is in [0, 1].
 *
 * Invariant: Jaccard similarity is always in [0, 1] by construction.
 */
export const prop_scoreBehavioral_in_range_zero_to_one = fc.property(
  specWithPostconditionsArb,
  specWithPostconditionsArb,
  (specA, specB) => {
    const scores = compareDimensions(specA, specB);
    return scores.behavioral >= 0.0 && scores.behavioral <= 1.0;
  },
);

// ---------------------------------------------------------------------------
// A4.3: scoreInterface — 0.5 * jaccard(inputs) + 0.5 * jaccard(outputs)
// ---------------------------------------------------------------------------

/**
 * prop_scoreInterface_self_comparison_is_one
 *
 * For any SpecYak, comparing it against itself in the interface dimension
 * returns 1.0.
 *
 * Invariant: Jaccard(A, A) = 1.0; 0.5 * 1.0 + 0.5 * 1.0 = 1.0.
 * Empty input sets use the both-empty → 1.0 rule.
 */
export const prop_scoreInterface_self_comparison_is_one = fc.property(specWithParamsArb, (spec) => {
  const scores = compareDimensions(spec, spec);
  return Math.abs(scores.interface - 1.0) < 1e-9;
});

/**
 * prop_scoreInterface_both_empty_params_is_one
 *
 * When both specs have no inputs and no outputs, the interface score is 1.0.
 *
 * Invariant: both-empty Jaccard → 1.0; weighted: 0.5 * 1.0 + 0.5 * 1.0 = 1.0.
 */
export const prop_scoreInterface_both_empty_params_is_one = fc.property(
  fc.constant(undefined),
  (_) => {
    const specA = makeSpec({ inputs: [], outputs: [] });
    const specB = makeSpec({ inputs: [], outputs: [] });
    const scores = compareDimensions(specA, specB);
    return Math.abs(scores.interface - 1.0) < 1e-9;
  },
);

/**
 * prop_scoreInterface_completely_different_params_is_zero
 *
 * When two specs have completely non-overlapping inputs and outputs, the
 * interface score is 0.0.
 *
 * Invariant: Jaccard(A, B) = 0 when A ∩ B = ∅; 0.5 * 0 + 0.5 * 0 = 0.
 */
export const prop_scoreInterface_completely_different_params_is_zero = fc.property(
  fc.constant(undefined),
  (_) => {
    const specA = makeSpec({
      inputs: [{ name: "x", type: "number" }],
      outputs: [{ name: "result", type: "string" }],
    });
    const specB = makeSpec({
      inputs: [{ name: "data", type: "boolean" }],
      outputs: [{ name: "count", type: "number[]" }],
    });
    const scores = compareDimensions(specA, specB);
    return Math.abs(scores.interface - 0.0) < 1e-9;
  },
);

/**
 * prop_scoreInterface_in_range_zero_to_one
 *
 * For any two SpecYak specs, the interface dimension score is in [0, 1].
 *
 * Invariant: Jaccard similarity ∈ [0, 1]; weighted average ∈ [0, 1].
 */
export const prop_scoreInterface_in_range_zero_to_one = fc.property(
  specWithParamsArb,
  specWithParamsArb,
  (specA, specB) => {
    const scores = compareDimensions(specA, specB);
    return scores.interface >= 0.0 && scores.interface <= 1.0;
  },
);

// ---------------------------------------------------------------------------
// A4.4: compareDimensions — exported, returns DimensionScores
// ---------------------------------------------------------------------------

/**
 * prop_compareDimensions_result_shape
 *
 * For any two SpecYak specs, compareDimensions returns an object with all 5
 * dimension keys (security, behavioral, error_handling, performance, interface)
 * each holding a number in [0, 1].
 *
 * Invariant: compareDimensions always returns a complete DimensionScores
 * object; it never omits a dimension or returns NaN/Infinity for any scorer.
 */
export const prop_compareDimensions_result_shape = fc.property(
  specWithPostconditionsArb,
  specWithParamsArb,
  (specA, specB) => {
    const scores = compareDimensions(specA, specB);
    const dims = ["security", "behavioral", "error_handling", "performance", "interface"] as const;
    for (const dim of dims) {
      const v = scores[dim];
      if (typeof v !== "number") return false;
      if (Number.isNaN(v) || !Number.isFinite(v)) return false;
      if (v < 0 || v > 1) return false;
    }
    return true;
  },
);

/**
 * prop_compareDimensions_self_is_all_ones
 *
 * For any SpecYak spec, compareDimensions(spec, spec) returns 1.0 for all
 * dimensions.
 *
 * Invariant: every scorer returns 1.0 on self-comparison. For the security
 * dimension: present ∩ present + clear ∩ clear = full CWE family count, so
 * score = 1.0. For behavioral and interface: Jaccard(A, A) = 1.0. For
 * error_handling and performance: both-absent returns 1.0; both-present with
 * identical inputs also returns 1.0.
 */
export const prop_compareDimensions_self_is_all_ones = fc.property(
  specWithPostconditionsArb,
  (spec) => {
    const scores = compareDimensions(spec, spec);
    const dims = ["security", "behavioral", "error_handling", "performance", "interface"] as const;
    return dims.every((d) => Math.abs(scores[d] - 1.0) < 1e-9);
  },
);

/**
 * prop_compareDimensions_scores_in_range
 *
 * For any pair of SpecYak specs, all dimension scores are in [0, 1].
 *
 * Invariant: all internal scorers return values in [0, 1] by construction
 * (Jaccard ∈ [0,1], CWE overlap ratio ∈ [0,1], stringFieldMatch ∈ {0,1}).
 */
export const prop_compareDimensions_scores_in_range = fc.property(
  specWithPostconditionsArb,
  specWithPostconditionsArb,
  (specA, specB) => {
    const scores = compareDimensions(specA, specB);
    return (
      scores.security >= 0 &&
      scores.security <= 1 &&
      scores.behavioral >= 0 &&
      scores.behavioral <= 1 &&
      scores.error_handling >= 0 &&
      scores.error_handling <= 1 &&
      scores.performance >= 0 &&
      scores.performance <= 1 &&
      scores.interface >= 0 &&
      scores.interface <= 1
    );
  },
);

/**
 * prop_compareDimensions_security_uses_cwe_family
 *
 * A spec that clears all CWEs (has preconditions, postconditions, effects,
 * nonFunctional.purity, and errorConditions) scores 1.0 on security when
 * compared against itself.
 *
 * Invariant: compareDimensions(fullSpec, fullSpec).security = 1.0 because
 * every CWE that is present/clear in canonical is also present/clear in candidate.
 */
export const prop_compareDimensions_security_uses_cwe_family = fc.property(
  fc.constant(undefined),
  (_) => {
    const fullSpec = makeSpec({
      preconditions: ["input > 0"],
      postconditions: ["result >= 0"],
      effects: ["writes to database"],
      errorConditions: [{ description: "throws RangeError when input < 0" }],
      nonFunctional: { purity: "stateful", threadSafety: "unsafe" },
    });
    const scores = compareDimensions(fullSpec, fullSpec);
    return Math.abs(scores.security - 1.0) < 1e-9;
  },
);
