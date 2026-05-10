// SPDX-License-Identifier: MIT
// Vitest harness for search.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling search.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_structuralMatch_deterministic,
  prop_structuralMatch_extra_candidate_error_returns_false,
  prop_structuralMatch_input_count_mismatch_returns_false,
  prop_structuralMatch_monotone_error_relaxation,
  prop_structuralMatch_monotone_nf_relaxation,
  prop_structuralMatch_output_count_mismatch_returns_false,
  prop_structuralMatch_reasons_nonempty_on_false,
  prop_structuralMatch_reflexive,
  prop_structuralMatch_total,
} from "./search.props.js";
import { prop_structuralMatch_error_subset_matches } from "./search.props.js";

// structuralMatch() is a pure in-memory function.
// 200 runs gives good coverage of the arbitrary domain.
const opts = { numRuns: 200 };

it("property: prop_structuralMatch_total", () => {
  fc.assert(prop_structuralMatch_total, opts);
});

it("property: prop_structuralMatch_deterministic", () => {
  fc.assert(prop_structuralMatch_deterministic, opts);
});

it("property: prop_structuralMatch_reflexive", () => {
  fc.assert(prop_structuralMatch_reflexive, opts);
});

it("property: prop_structuralMatch_input_count_mismatch_returns_false", () => {
  fc.assert(prop_structuralMatch_input_count_mismatch_returns_false, opts);
});

it("property: prop_structuralMatch_output_count_mismatch_returns_false", () => {
  fc.assert(prop_structuralMatch_output_count_mismatch_returns_false, opts);
});

it("property: prop_structuralMatch_error_subset_matches", () => {
  fc.assert(prop_structuralMatch_error_subset_matches, opts);
});

it("property: prop_structuralMatch_extra_candidate_error_returns_false", () => {
  fc.assert(prop_structuralMatch_extra_candidate_error_returns_false, opts);
});

it("property: prop_structuralMatch_monotone_error_relaxation", () => {
  fc.assert(prop_structuralMatch_monotone_error_relaxation, opts);
});

it("property: prop_structuralMatch_monotone_nf_relaxation", () => {
  fc.assert(prop_structuralMatch_monotone_nf_relaxation, opts);
});

it("property: prop_structuralMatch_reasons_nonempty_on_false", () => {
  fc.assert(prop_structuralMatch_reasons_nonempty_on_false, opts);
});
