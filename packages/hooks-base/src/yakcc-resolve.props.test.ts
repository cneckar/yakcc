// SPDX-License-Identifier: MIT
// Vitest harness for yakcc-resolve.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling yakcc-resolve.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import {
  prop_evidenceProjection_address_is_8_hex_chars,
  prop_evidenceProjection_field_order_locked,
  prop_evidenceProjection_score_in_zero_one,
  prop_resolveResult_matched_has_at_least_one_candidate,
  prop_resolveResult_no_match_has_empty_candidates,
  prop_resolveResult_status_is_one_of_three_values,
} from "./yakcc-resolve.props.js";

// ResolveResult status invariants
it("property: prop_resolveResult_status_is_one_of_three_values", () => {
  if (!prop_resolveResult_status_is_one_of_three_values()) throw new Error("property failed");
});

it("property: prop_resolveResult_no_match_has_empty_candidates", () => {
  if (!prop_resolveResult_no_match_has_empty_candidates()) throw new Error("property failed");
});

it("property: prop_resolveResult_matched_has_at_least_one_candidate", () => {
  if (!prop_resolveResult_matched_has_at_least_one_candidate()) throw new Error("property failed");
});

// EvidenceProjection invariants
it("property: prop_evidenceProjection_address_is_8_hex_chars", () => {
  if (!prop_evidenceProjection_address_is_8_hex_chars()) throw new Error("property failed");
});

it("property: prop_evidenceProjection_score_in_zero_one", () => {
  if (!prop_evidenceProjection_score_in_zero_one()) throw new Error("property failed");
});

it("property: prop_evidenceProjection_field_order_locked", () => {
  if (!prop_evidenceProjection_field_order_locked()) throw new Error("property failed");
});
