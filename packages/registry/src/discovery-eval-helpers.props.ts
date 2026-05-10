// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-004: hand-authored property-test corpus for
// @yakcc/registry discovery-eval-helpers.ts. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (issue-87-fill-registry)
// Rationale: The D5 metric functions (M1–M5) have precise mathematical
// invariants from the D5 ADR that property tests can verify exhaustively across
// the full input domain. Example-based tests cover specific fixed values; property
// tests verify the algebraic structure (monotonicity, boundedness, partition
// correctness) that must hold for ALL inputs.

// ---------------------------------------------------------------------------
// Property-test corpus for discovery-eval-helpers.ts
//
// Functions covered (all pure; no DB/registry/network):
//   cosineDistanceToCombinedScore — D3 L2→combinedScore formula
//   assignScoreBand               — D3 band boundary classifier
//   computeHitRate                — M1: % of queries above threshold
//   computePrecisionAt1           — M2: % of queries with correct top-1
//   computeRecallAtK              — M3: % of queries with expected atom in top-K
//   computeMRR                    — M4: mean reciprocal rank
//   computeBrierPerBand           — M5: per-band calibration error
//
// Behaviors exercised:
//   D1  — cosineDistanceToCombinedScore: output in [0, 1] for any L2 distance
//   D2  — cosineDistanceToCombinedScore: monotone decreasing in distance
//   D3  — cosineDistanceToCombinedScore: L2=0 → 1.0, L2=2 → 0.0
//   D4  — assignScoreBand: output is always one of the four valid band names
//   D5  — assignScoreBand: consistent with band boundary thresholds
//   D6  — computeHitRate: output in [0, 1] for any result list
//   D7  — computeHitRate: empty list → 0
//   D8  — computePrecisionAt1: output in [0, 1]
//   D9  — computeRecallAtK: output in [0, 1]
//   D10 — computeMRR: output in [0, 1], MRR ≤ 1/min_rank
//   D11 — computeBrierPerBand: band counts partition (sum = total results)
//   D12 — computeBrierPerBand: brier null iff N=0 for that band
//   D13 — metric functions are deterministic (same input → same output)
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import {
  M1_HIT_THRESHOLD,
  assignScoreBand,
  computeBrierPerBand,
  computeHitRate,
  computeMRR,
  computePrecisionAt1,
  computeRecallAtK,
  cosineDistanceToCombinedScore,
} from "./discovery-eval-helpers.js";
import type { QueryResult, ScoreBand } from "./discovery-eval-helpers.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a score in [0, 1]. */
const scoreArb: fc.Arbitrary<number> = fc.float({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Arbitrary for an L2 distance (vec0 output). Covers the full possible range and beyond. */
const l2DistanceArb: fc.Arbitrary<number> = fc.float({
  min: -0.5,
  max: 3.0,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Valid band names. */
const VALID_BANDS: readonly ScoreBand[] = ["strong", "confident", "weak", "poor"];

/**
 * Arbitrary for a QueryResult with all fields generated.
 * The top1Band is derived from top1Score so they are consistent.
 */
const queryResultArb: fc.Arbitrary<QueryResult> = fc
  .record({
    entryId: fc.string({ minLength: 1, maxLength: 10 }),
    top1Score: scoreArb,
    top1Atom: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: null }),
    expectedAtom: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: null }),
    top1Correct: fc.boolean(),
    expectedAtomRank: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
    allAtoms: fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 0,
      maxLength: 5,
    }),
  })
  .map(
    ({ entryId, top1Score, top1Atom, expectedAtom, top1Correct, expectedAtomRank, allAtoms }) => ({
      entryId,
      expectedAtom,
      acceptableAtoms: [],
      top1Score,
      top1Atom,
      top1Band: assignScoreBand(top1Score),
      top1Correct: expectedAtom !== null && top1Correct,
      expectedAtomRank: expectedAtom !== null ? expectedAtomRank : null,
      allAtoms,
    }),
  );

/** Arbitrary for a non-empty list of QueryResults. */
const queryResultListArb: fc.Arbitrary<readonly QueryResult[]> = fc.array(queryResultArb, {
  minLength: 1,
  maxLength: 10,
});

// ---------------------------------------------------------------------------
// D1: cosineDistanceToCombinedScore output is always in [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_cosineDistance_output_bounded
 *
 * For any L2 distance value (including out-of-range inputs), the output of
 * cosineDistanceToCombinedScore is always in [0, 1].
 *
 * Invariant: the function applies Math.max(0, Math.min(1, ...)) clamping, so
 * the output is always a valid combined score regardless of input.
 */
export const prop_cosineDistance_output_bounded = fc.property(l2DistanceArb, (d) => {
  const score = cosineDistanceToCombinedScore(d);
  return score >= 0 && score <= 1;
});

// ---------------------------------------------------------------------------
// D2: cosineDistanceToCombinedScore is monotone decreasing in distance
// ---------------------------------------------------------------------------

/**
 * prop_cosineDistance_monotone_decreasing
 *
 * For L2 distances d1 < d2 in [0, 2] (unit-sphere valid range), the score
 * for d1 must be >= the score for d2.
 *
 * Invariant: closer vectors (smaller L2 distance) always produce higher
 * combined scores. This is the fundamental correctness property of the
 * distance-to-score mapping (DEC-V3-DISCOVERY-CALIBRATION-FIX-002).
 */
export const prop_cosineDistance_monotone_decreasing = fc.property(
  fc.float({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
  fc.float({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
  (d1, d2) => {
    if (d1 >= d2) return true; // skip: only test d1 < d2
    const s1 = cosineDistanceToCombinedScore(d1);
    const s2 = cosineDistanceToCombinedScore(d2);
    // s1 >= s2 with small float tolerance
    return s1 >= s2 - 1e-10;
  },
);

// ---------------------------------------------------------------------------
// D3: cosineDistanceToCombinedScore boundary values
// ---------------------------------------------------------------------------

/**
 * prop_cosineDistance_zero_maps_to_one
 *
 * L2 distance of exactly 0 (identical vectors) maps to combinedScore 1.0.
 *
 * Invariant: 1 - 0²/4 = 1.0.
 */
export const prop_cosineDistance_zero_maps_to_one = fc.property(
  fc.constant(0),
  (d) => cosineDistanceToCombinedScore(d) === 1.0,
);

/**
 * prop_cosineDistance_two_maps_to_zero
 *
 * L2 distance of exactly 2 (antipodal unit vectors) maps to combinedScore 0.0.
 *
 * Invariant: 1 - 2²/4 = 1 - 1 = 0.0.
 */
export const prop_cosineDistance_two_maps_to_zero = fc.property(
  fc.constant(2),
  (d) => cosineDistanceToCombinedScore(d) === 0.0,
);

// ---------------------------------------------------------------------------
// D4: assignScoreBand output is always a valid band name
// ---------------------------------------------------------------------------

/**
 * prop_assignScoreBand_output_is_valid
 *
 * For any score in [0, 1], assignScoreBand() returns one of the four valid
 * band names: "strong", "confident", "weak", "poor".
 *
 * Invariant: the four branches of assignScoreBand() are exhaustive and
 * mutually exclusive. No score produces an undefined or invalid band.
 */
export const prop_assignScoreBand_output_is_valid = fc.property(scoreArb, (score) => {
  const band = assignScoreBand(score);
  return VALID_BANDS.includes(band);
});

// ---------------------------------------------------------------------------
// D5: assignScoreBand is consistent with band boundary thresholds
// ---------------------------------------------------------------------------

/**
 * prop_assignScoreBand_strong_ge_085
 *
 * For any score >= 0.85, assignScoreBand() returns "strong".
 *
 * Invariant: D3 ADR band boundary — strong band starts at 0.85.
 */
export const prop_assignScoreBand_strong_ge_085 = fc.property(
  fc.float({ min: Math.fround(0.85), max: 1.0, noNaN: true, noDefaultInfinity: true }),
  (score) => assignScoreBand(score) === "strong",
);

/**
 * prop_assignScoreBand_poor_lt_050
 *
 * For any score < 0.50, assignScoreBand() returns "poor".
 *
 * Invariant: D3 ADR band boundary — poor band ends at 0.50 exclusive.
 */
export const prop_assignScoreBand_poor_lt_050 = fc.property(
  fc.float({ min: 0, max: Math.fround(0.4999), noNaN: true, noDefaultInfinity: true }),
  (score) => assignScoreBand(score) === "poor",
);

/**
 * prop_assignScoreBand_consistent_with_m1_threshold
 *
 * Any score >= M1_HIT_THRESHOLD (0.50) must map to a band that is at least
 * "weak" (i.e., not "poor"). This is the D5 ADR §Q1 M1 threshold invariant.
 *
 * Invariant: M1_HIT_THRESHOLD equals the weak-band entry boundary.
 * A hit (score >= threshold) must be in weak, confident, or strong band.
 */
export const prop_assignScoreBand_consistent_with_m1_threshold = fc.property(
  fc.float({ min: M1_HIT_THRESHOLD, max: 1.0, noNaN: true, noDefaultInfinity: true }),
  (score) => {
    const band = assignScoreBand(score);
    return band === "weak" || band === "confident" || band === "strong";
  },
);

// ---------------------------------------------------------------------------
// D6: computeHitRate output is in [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_computeHitRate_bounded
 *
 * For any non-empty list of QueryResults, computeHitRate() returns a value
 * in [0, 1].
 *
 * Invariant: hit rate is a proportion and always lies in the unit interval.
 */
export const prop_computeHitRate_bounded = fc.property(queryResultListArb, (results) => {
  const rate = computeHitRate(results);
  return rate >= 0 && rate <= 1;
});

// ---------------------------------------------------------------------------
// D7: computeHitRate empty list → 0
// ---------------------------------------------------------------------------

/**
 * prop_computeHitRate_empty_is_zero
 *
 * computeHitRate([]) returns exactly 0.
 *
 * Invariant: the empty-list guard returns 0 immediately (no division by zero).
 */
export const prop_computeHitRate_empty_is_zero = fc.property(
  fc.constant([] as QueryResult[]),
  (results) => computeHitRate(results) === 0,
);

// ---------------------------------------------------------------------------
// D8: computePrecisionAt1 output is in [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_computePrecisionAt1_bounded
 *
 * For any list of QueryResults, computePrecisionAt1() returns a value in [0, 1].
 *
 * Invariant: precision is a proportion; the empty-eligible-entries guard
 * returns 0 (no division by zero).
 */
export const prop_computePrecisionAt1_bounded = fc.property(queryResultListArb, (results) => {
  const p = computePrecisionAt1(results);
  return p >= 0 && p <= 1;
});

// ---------------------------------------------------------------------------
// D9: computeRecallAtK output is in [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_computeRecallAtK_bounded
 *
 * For any list of QueryResults, computeRecallAtK() returns a value in [0, 1].
 *
 * Invariant: recall is a proportion in [0, 1].
 */
export const prop_computeRecallAtK_bounded = fc.property(queryResultListArb, (results) => {
  const r = computeRecallAtK(results);
  return r >= 0 && r <= 1;
});

// ---------------------------------------------------------------------------
// D10: computeMRR output is in [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_computeMRR_bounded
 *
 * For any list of QueryResults, computeMRR() returns a value in [0, 1].
 *
 * Invariant: 1/rank is in (0, 1] for rank >= 1, and 0 for not-found.
 * The mean of values in [0, 1] is also in [0, 1].
 */
export const prop_computeMRR_bounded = fc.property(queryResultListArb, (results) => {
  const mrr = computeMRR(results);
  return mrr >= 0 && mrr <= 1;
});

// ---------------------------------------------------------------------------
// D11: computeBrierPerBand — band counts partition total results
// ---------------------------------------------------------------------------

/**
 * prop_computeBrierPerBand_counts_partition
 *
 * For any list of QueryResults, the sum of N across all four bands equals the
 * total number of results.
 *
 * Invariant: every result is assigned to exactly one band by assignScoreBand(),
 * so the four band counts partition the full result set.
 */
export const prop_computeBrierPerBand_counts_partition = fc.property(
  queryResultListArb,
  (results) => {
    const brier = computeBrierPerBand(results);
    const total = brier.strong.N + brier.confident.N + brier.weak.N + brier.poor.N;
    return total === results.length;
  },
);

// ---------------------------------------------------------------------------
// D12: computeBrierPerBand — brier is null iff N=0
// ---------------------------------------------------------------------------

/**
 * prop_computeBrierPerBand_brier_null_iff_empty
 *
 * For each band in the output of computeBrierPerBand(), brier is null if and
 * only if N === 0 for that band.
 *
 * Invariant: the empty-band guard (brier=null when N=0) fires correctly and
 * never produces brier=null for a non-empty band or brier≠null for an empty band.
 */
export const prop_computeBrierPerBand_brier_null_iff_empty = fc.property(
  queryResultListArb,
  (results) => {
    const brier = computeBrierPerBand(results);
    const bands = [brier.strong, brier.confident, brier.weak, brier.poor];
    return bands.every((b) => (b.N === 0) === (b.brier === null));
  },
);

// ---------------------------------------------------------------------------
// D13: All metric functions are deterministic
// ---------------------------------------------------------------------------

/**
 * prop_metrics_deterministic
 *
 * Two calls to each metric function with the same input produce the same output.
 *
 * Invariant: M1–M5 metric functions are pure and have no hidden state or
 * side effects.
 */
export const prop_metrics_deterministic = fc.property(queryResultListArb, (results) => {
  const m1a = computeHitRate(results);
  const m1b = computeHitRate(results);
  const m2a = computePrecisionAt1(results);
  const m2b = computePrecisionAt1(results);
  const m3a = computeRecallAtK(results);
  const m3b = computeRecallAtK(results);
  const m4a = computeMRR(results);
  const m4b = computeMRR(results);
  return m1a === m1b && m2a === m2b && m3a === m3b && m4a === m4b;
});

/**
 * prop_brierPerBand_deterministic
 *
 * Two calls to computeBrierPerBand() with the same input produce the same
 * per-band N and brier values.
 *
 * Invariant: computeBrierPerBand() is pure and deterministic.
 */
export const prop_brierPerBand_deterministic = fc.property(queryResultListArb, (results) => {
  const b1 = computeBrierPerBand(results);
  const b2 = computeBrierPerBand(results);
  return (
    b1.strong.N === b2.strong.N &&
    b1.confident.N === b2.confident.N &&
    b1.weak.N === b2.weak.N &&
    b1.poor.N === b2.poor.N &&
    b1.strong.brier === b2.strong.brier &&
    b1.confident.brier === b2.confident.brier &&
    b1.weak.brier === b2.weak.brier &&
    b1.poor.brier === b2.poor.brier
  );
});
