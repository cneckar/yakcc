// SPDX-License-Identifier: MIT
// Vitest harness for index.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling index.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_compareDimensions_result_shape,
  prop_compareDimensions_scores_in_range,
  prop_compareDimensions_security_uses_cwe_family,
  prop_compareDimensions_self_is_all_ones,
  prop_normalize_case_insensitive_behavioral,
  prop_normalize_trailing_punctuation_ignored_in_behavioral,
  prop_scoreBehavioral_both_empty_is_one,
  prop_scoreBehavioral_disjoint_sets_is_zero,
  prop_scoreBehavioral_in_range_zero_to_one,
  prop_scoreBehavioral_self_comparison_is_one,
  prop_scoreInterface_both_empty_params_is_one,
  prop_scoreInterface_completely_different_params_is_zero,
  prop_scoreInterface_in_range_zero_to_one,
  prop_scoreInterface_self_comparison_is_one,
} from "./index.props.js";

// compareDimensions is a pure function with no I/O; 100 runs is appropriate.
const opts = { numRuns: 100 };

it("property: prop_normalize_case_insensitive_behavioral", () => {
  fc.assert(prop_normalize_case_insensitive_behavioral, opts);
});

it("property: prop_normalize_trailing_punctuation_ignored_in_behavioral", () => {
  fc.assert(prop_normalize_trailing_punctuation_ignored_in_behavioral, opts);
});

it("property: prop_scoreBehavioral_self_comparison_is_one", () => {
  fc.assert(prop_scoreBehavioral_self_comparison_is_one, opts);
});

it("property: prop_scoreBehavioral_both_empty_is_one", () => {
  fc.assert(prop_scoreBehavioral_both_empty_is_one, opts);
});

it("property: prop_scoreBehavioral_disjoint_sets_is_zero", () => {
  fc.assert(prop_scoreBehavioral_disjoint_sets_is_zero, opts);
});

it("property: prop_scoreBehavioral_in_range_zero_to_one", () => {
  fc.assert(prop_scoreBehavioral_in_range_zero_to_one, opts);
});

it("property: prop_scoreInterface_self_comparison_is_one", () => {
  fc.assert(prop_scoreInterface_self_comparison_is_one, opts);
});

it("property: prop_scoreInterface_both_empty_params_is_one", () => {
  fc.assert(prop_scoreInterface_both_empty_params_is_one, opts);
});

it("property: prop_scoreInterface_completely_different_params_is_zero", () => {
  fc.assert(prop_scoreInterface_completely_different_params_is_zero, opts);
});

it("property: prop_scoreInterface_in_range_zero_to_one", () => {
  fc.assert(prop_scoreInterface_in_range_zero_to_one, opts);
});

it("property: prop_compareDimensions_result_shape", () => {
  fc.assert(prop_compareDimensions_result_shape, opts);
});

it("property: prop_compareDimensions_self_is_all_ones", () => {
  fc.assert(prop_compareDimensions_self_is_all_ones, opts);
});

it("property: prop_compareDimensions_scores_in_range", () => {
  fc.assert(prop_compareDimensions_scores_in_range, opts);
});

it("property: prop_compareDimensions_security_uses_cwe_family", () => {
  fc.assert(prop_compareDimensions_security_uses_cwe_family, opts);
});
