// SPDX-License-Identifier: MIT
// Vitest harness for substitute.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling substitute.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import {
  prop_candidatesToCombinedScores_deterministic,
  prop_candidatesToCombinedScores_empty_in_empty_out,
  prop_candidatesToCombinedScores_monotone_decreasing,
  prop_candidatesToCombinedScores_range_zero_to_one,
  prop_candidatesToCombinedScores_total,
  prop_decideToSubstitute_below_threshold_is_false,
  prop_decideToSubstitute_deterministic,
  prop_decideToSubstitute_empty_returns_false,
  prop_decideToSubstitute_small_gap_is_false,
  prop_decideToSubstitute_strong_single_candidate_substitutes,
  prop_decideToSubstitute_total,
  prop_renderContractComment_deterministic,
  prop_renderContractComment_hash_truncated_to_8_chars,
  prop_renderContractComment_no_trailing_semicolon_when_no_guarantees,
  prop_renderContractComment_starts_with_at_atom,
  prop_renderContractComment_total,
  prop_renderSubstitution_binding_name_preserved,
  prop_renderSubstitution_deterministic,
  prop_renderSubstitution_import_path_convention,
  prop_renderSubstitution_no_spec_two_lines,
  prop_renderSubstitution_total,
  prop_renderSubstitution_with_spec_three_lines,
} from "../src/substitute.props.js";

// candidatesToCombinedScores properties — pure score conversion
it("property: prop_candidatesToCombinedScores_total", () => {
  if (!prop_candidatesToCombinedScores_total()) throw new Error("property failed");
});

it("property: prop_candidatesToCombinedScores_range_zero_to_one", () => {
  if (!prop_candidatesToCombinedScores_range_zero_to_one()) throw new Error("property failed");
});

it("property: prop_candidatesToCombinedScores_monotone_decreasing", () => {
  if (!prop_candidatesToCombinedScores_monotone_decreasing()) throw new Error("property failed");
});

it("property: prop_candidatesToCombinedScores_deterministic", () => {
  if (!prop_candidatesToCombinedScores_deterministic()) throw new Error("property failed");
});

it("property: prop_candidatesToCombinedScores_empty_in_empty_out", () => {
  if (!prop_candidatesToCombinedScores_empty_in_empty_out()) throw new Error("property failed");
});

// decideToSubstitute properties — D2 auto-accept rule
it("property: prop_decideToSubstitute_total", () => {
  if (!prop_decideToSubstitute_total()) throw new Error("property failed");
});

it("property: prop_decideToSubstitute_deterministic", () => {
  if (!prop_decideToSubstitute_deterministic()) throw new Error("property failed");
});

it("property: prop_decideToSubstitute_empty_returns_false", () => {
  if (!prop_decideToSubstitute_empty_returns_false()) throw new Error("property failed");
});

it("property: prop_decideToSubstitute_strong_single_candidate_substitutes", () => {
  if (!prop_decideToSubstitute_strong_single_candidate_substitutes()) throw new Error("property failed");
});

it("property: prop_decideToSubstitute_below_threshold_is_false", () => {
  if (!prop_decideToSubstitute_below_threshold_is_false()) throw new Error("property failed");
});

it("property: prop_decideToSubstitute_small_gap_is_false", () => {
  if (!prop_decideToSubstitute_small_gap_is_false()) throw new Error("property failed");
});

// renderSubstitution properties — import + binding generation
it("property: prop_renderSubstitution_total", () => {
  if (!prop_renderSubstitution_total()) throw new Error("property failed");
});

it("property: prop_renderSubstitution_deterministic", () => {
  if (!prop_renderSubstitution_deterministic()) throw new Error("property failed");
});

it("property: prop_renderSubstitution_import_path_convention", () => {
  if (!prop_renderSubstitution_import_path_convention()) throw new Error("property failed");
});

it("property: prop_renderSubstitution_binding_name_preserved", () => {
  if (!prop_renderSubstitution_binding_name_preserved()) throw new Error("property failed");
});

it("property: prop_renderSubstitution_no_spec_two_lines", () => {
  if (!prop_renderSubstitution_no_spec_two_lines()) throw new Error("property failed");
});

it("property: prop_renderSubstitution_with_spec_three_lines", () => {
  if (!prop_renderSubstitution_with_spec_three_lines()) throw new Error("property failed");
});

// renderContractComment properties — Phase 3 comment format invariants
it("property: prop_renderContractComment_total", () => {
  if (!prop_renderContractComment_total()) throw new Error("property failed");
});

it("property: prop_renderContractComment_deterministic", () => {
  if (!prop_renderContractComment_deterministic()) throw new Error("property failed");
});

it("property: prop_renderContractComment_starts_with_at_atom", () => {
  if (!prop_renderContractComment_starts_with_at_atom()) throw new Error("property failed");
});

it("property: prop_renderContractComment_hash_truncated_to_8_chars", () => {
  if (!prop_renderContractComment_hash_truncated_to_8_chars()) throw new Error("property failed");
});

it("property: prop_renderContractComment_no_trailing_semicolon_when_no_guarantees", () => {
  if (!prop_renderContractComment_no_trailing_semicolon_when_no_guarantees())
    throw new Error("property failed");
});
