// SPDX-License-Identifier: MIT
// Vitest harness for discovery-eval-helpers.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling discovery-eval-helpers.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_assignScoreBand_consistent_with_m1_threshold,
  prop_assignScoreBand_output_is_valid,
  prop_assignScoreBand_poor_lt_050,
  prop_assignScoreBand_strong_ge_085,
  prop_brierPerBand_deterministic,
  prop_computeBrierPerBand_brier_null_iff_empty,
  prop_computeBrierPerBand_counts_partition,
  prop_computeHitRate_bounded,
  prop_computeHitRate_empty_is_zero,
  prop_computeMRR_bounded,
  prop_computePrecisionAt1_bounded,
  prop_computeRecallAtK_bounded,
  prop_cosineDistance_monotone_decreasing,
  prop_cosineDistance_output_bounded,
  prop_cosineDistance_two_maps_to_zero,
  prop_cosineDistance_zero_maps_to_one,
  prop_metrics_deterministic,
} from "./discovery-eval-helpers.props.js";

// All functions are pure in-memory computation — no DB or network.
// 200 runs provides strong coverage of the arbitrary space.
const opts = { numRuns: 200 };

it("property: prop_cosineDistance_output_bounded", () => {
  fc.assert(prop_cosineDistance_output_bounded, opts);
});

it("property: prop_cosineDistance_monotone_decreasing", () => {
  fc.assert(prop_cosineDistance_monotone_decreasing, opts);
});

it("property: prop_cosineDistance_zero_maps_to_one", () => {
  fc.assert(prop_cosineDistance_zero_maps_to_one, opts);
});

it("property: prop_cosineDistance_two_maps_to_zero", () => {
  fc.assert(prop_cosineDistance_two_maps_to_zero, opts);
});

it("property: prop_assignScoreBand_output_is_valid", () => {
  fc.assert(prop_assignScoreBand_output_is_valid, opts);
});

it("property: prop_assignScoreBand_strong_ge_085", () => {
  fc.assert(prop_assignScoreBand_strong_ge_085, opts);
});

it("property: prop_assignScoreBand_poor_lt_050", () => {
  fc.assert(prop_assignScoreBand_poor_lt_050, opts);
});

it("property: prop_assignScoreBand_consistent_with_m1_threshold", () => {
  fc.assert(prop_assignScoreBand_consistent_with_m1_threshold, opts);
});

it("property: prop_computeHitRate_bounded", () => {
  fc.assert(prop_computeHitRate_bounded, opts);
});

it("property: prop_computeHitRate_empty_is_zero", () => {
  fc.assert(prop_computeHitRate_empty_is_zero, opts);
});

it("property: prop_computePrecisionAt1_bounded", () => {
  fc.assert(prop_computePrecisionAt1_bounded, opts);
});

it("property: prop_computeRecallAtK_bounded", () => {
  fc.assert(prop_computeRecallAtK_bounded, opts);
});

it("property: prop_computeMRR_bounded", () => {
  fc.assert(prop_computeMRR_bounded, opts);
});

it("property: prop_computeBrierPerBand_counts_partition", () => {
  fc.assert(prop_computeBrierPerBand_counts_partition, opts);
});

it("property: prop_computeBrierPerBand_brier_null_iff_empty", () => {
  fc.assert(prop_computeBrierPerBand_brier_null_iff_empty, opts);
});

it("property: prop_metrics_deterministic", () => {
  fc.assert(prop_metrics_deterministic, opts);
});

it("property: prop_brierPerBand_deterministic", () => {
  fc.assert(prop_brierPerBand_deterministic, opts);
});
