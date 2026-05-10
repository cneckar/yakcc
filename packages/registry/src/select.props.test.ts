// SPDX-License-Identifier: MIT
// Vitest harness for select.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling select.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_select_deterministic,
  prop_select_empty_returns_null,
  prop_select_irrelevant_edges_ignored,
  prop_select_lexicographic_fallback_stable,
  prop_select_nf_quality_tiebreak_pure_beats_stateful,
  prop_select_provenance_tiebreak,
  prop_select_singleton_returns_only_match,
  prop_select_strict_candidate_wins,
  prop_select_strict_candidate_wins_reversed_input_order,
  prop_select_total,
} from "./select.props.js";

// select() is a pure in-memory function; 200 runs exercises the arbitrary space well.
const opts = { numRuns: 200 };

it("property: prop_select_total", () => {
  fc.assert(prop_select_total, opts);
});

it("property: prop_select_deterministic", () => {
  fc.assert(prop_select_deterministic, opts);
});

it("property: prop_select_empty_returns_null", () => {
  fc.assert(prop_select_empty_returns_null, opts);
});

it("property: prop_select_singleton_returns_only_match", () => {
  fc.assert(prop_select_singleton_returns_only_match, opts);
});

it("property: prop_select_strict_candidate_wins", () => {
  fc.assert(prop_select_strict_candidate_wins, opts);
});

it("property: prop_select_strict_candidate_wins_reversed_input_order", () => {
  fc.assert(prop_select_strict_candidate_wins_reversed_input_order, opts);
});

it("property: prop_select_nf_quality_tiebreak_pure_beats_stateful", () => {
  fc.assert(prop_select_nf_quality_tiebreak_pure_beats_stateful, opts);
});

it("property: prop_select_lexicographic_fallback_stable", () => {
  fc.assert(prop_select_lexicographic_fallback_stable, opts);
});

it("property: prop_select_irrelevant_edges_ignored", () => {
  fc.assert(prop_select_irrelevant_edges_ignored, opts);
});

it("property: prop_select_provenance_tiebreak", () => {
  fc.assert(prop_select_provenance_tiebreak, opts);
});
