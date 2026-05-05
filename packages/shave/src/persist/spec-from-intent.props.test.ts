// SPDX-License-Identifier: MIT
// Vitest harness for spec-from-intent.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling spec-from-intent.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_specFromIntent_does_not_throw,
  prop_specFromIntent_effects_is_empty,
  prop_specFromIntent_input_type_equals_typehint,
  prop_specFromIntent_inputs_length_matches,
  prop_specFromIntent_invariants_is_empty,
  prop_specFromIntent_is_deterministic,
  prop_specFromIntent_level_is_L0,
  prop_specFromIntent_name_ends_with_hash_suffix,
  prop_specFromIntent_output_passes_validateSpecYak,
  prop_specFromIntent_outputs_length_matches,
  prop_specFromIntent_postconditions_roundtrip,
  prop_specFromIntent_preconditions_roundtrip,
} from "./spec-from-intent.props.js";

// specFromIntent() is a pure function — no IO, no ts-morph, no registry.
// numRuns: 50 is affordable given the low runtime cost.
const opts = { numRuns: 50 };

it("property: prop_specFromIntent_does_not_throw", () => {
  fc.assert(prop_specFromIntent_does_not_throw, opts);
});

it("property: prop_specFromIntent_level_is_L0", () => {
  fc.assert(prop_specFromIntent_level_is_L0, opts);
});

it("property: prop_specFromIntent_invariants_is_empty", () => {
  fc.assert(prop_specFromIntent_invariants_is_empty, opts);
});

it("property: prop_specFromIntent_effects_is_empty", () => {
  fc.assert(prop_specFromIntent_effects_is_empty, opts);
});

it("property: prop_specFromIntent_name_ends_with_hash_suffix", () => {
  fc.assert(prop_specFromIntent_name_ends_with_hash_suffix, opts);
});

it("property: prop_specFromIntent_inputs_length_matches", () => {
  fc.assert(prop_specFromIntent_inputs_length_matches, opts);
});

it("property: prop_specFromIntent_outputs_length_matches", () => {
  fc.assert(prop_specFromIntent_outputs_length_matches, opts);
});

it("property: prop_specFromIntent_input_type_equals_typehint", () => {
  fc.assert(prop_specFromIntent_input_type_equals_typehint, opts);
});

it("property: prop_specFromIntent_preconditions_roundtrip", () => {
  fc.assert(prop_specFromIntent_preconditions_roundtrip, opts);
});

it("property: prop_specFromIntent_postconditions_roundtrip", () => {
  fc.assert(prop_specFromIntent_postconditions_roundtrip, opts);
});

it("property: prop_specFromIntent_is_deterministic", () => {
  fc.assert(prop_specFromIntent_is_deterministic, opts);
});

it("property: prop_specFromIntent_output_passes_validateSpecYak", () => {
  fc.assert(prop_specFromIntent_output_passes_validateSpecYak, opts);
});
