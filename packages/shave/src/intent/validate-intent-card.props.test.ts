// SPDX-License-Identifier: MIT
// Vitest harness for validate-intent-card.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./validate-intent-card.props.js";

describe("validate-intent-card.ts — Path A property corpus", () => {
  it("property: rejects null input", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_null);
  });

  it("property: rejects array input", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_array);
  });

  it("property: rejects string input", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_string);
  });

  it("property: rejects number input", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_number);
  });

  it("property: rejects unknown top-level field", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_unknown_top_level_field);
  });

  it("property: rejects schemaVersion 0", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_schemaVersion_zero);
  });

  it("property: rejects schemaVersion 2", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_schemaVersion_two);
  });

  it("property: rejects schemaVersion as string '1'", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_schemaVersion_string);
  });

  it("property: rejects missing schemaVersion", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_missing_schemaVersion);
  });

  it("property: rejects behavior as empty string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_empty_behavior);
  });

  it("property: rejects behavior with newline character", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_behavior_with_newline);
  });

  it("property: rejects behavior with carriage-return character", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_behavior_with_cr);
  });

  it("property: rejects behavior > 200 chars", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_behavior_over_200_chars);
  });

  it("property: rejects behavior as non-string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_behavior_non_string);
  });

  it("property: rejects inputs as non-array", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_inputs_non_array);
  });

  it("property: rejects outputs as non-array", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_outputs_non_array);
  });

  it("property: rejects preconditions element as non-string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_preconditions_non_string_element);
  });

  it("property: rejects postconditions element as non-string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_postconditions_non_string_element);
  });

  it("property: rejects notes element as non-string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_notes_non_string_element);
  });

  it("property: rejects sourceHash with wrong length", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_sourceHash_wrong_length);
  });

  it("property: rejects sourceHash with uppercase hex chars", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_sourceHash_uppercase);
  });

  it("property: rejects sourceHash with non-hex chars", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_sourceHash_non_hex);
  });

  it("property: rejects extractedAt as empty string", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_empty_extractedAt);
  });

  it("property: rejects IntentParam with unknown key", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_IntentParam_unknown_key);
  });

  it("property: rejects IntentParam missing name", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_IntentParam_missing_name);
  });

  it("property: rejects IntentParam missing typeHint", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_IntentParam_missing_typeHint);
  });

  it("property: rejects IntentParam missing description", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_IntentParam_missing_description);
  });

  it("property: accepts any well-formed IntentCard (happy path)", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_valid_card);
  });

  it("property: accepts behavior exactly 200 chars (boundary)", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_behavior_exactly_200_chars);
  });

  it("property: accepts behavior exactly 1 char (boundary)", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_behavior_exactly_1_char);
  });

  it("property: return value has all required IntentCard fields", () => {
    fc.assert(Props.prop_validateIntentCard_result_has_all_required_fields);
  });

  it("property: return value has schemaVersion === 1", () => {
    fc.assert(Props.prop_validateIntentCard_result_schemaVersion_is_1);
  });

  it("property: return value behavior matches input", () => {
    fc.assert(Props.prop_validateIntentCard_result_behavior_matches_input);
  });

  it("property: return value sourceHash matches input", () => {
    fc.assert(Props.prop_validateIntentCard_result_sourceHash_matches_input);
  });

  it("property: accepts empty arrays for all array fields", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_empty_arrays);
  });

  it("property: accepts multi-element inputs array", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_multi_element_inputs);
  });

  it("property: accepts any non-empty extractedAt string", () => {
    fc.assert(Props.prop_validateIntentCard_accepts_any_non_empty_extractedAt);
  });

  it("property: rejects behavior exactly 201 chars (boundary over)", () => {
    fc.assert(Props.prop_validateIntentCard_rejects_behavior_exactly_201_chars);
  });

  it("property: return value modelVersion and promptVersion match input", () => {
    fc.assert(Props.prop_validateIntentCard_result_model_and_prompt_version_match_input);
  });

  it("property: compound — round-trip identity: validated value passes second validation", () => {
    fc.assert(Props.prop_validateIntentCard_compound_round_trip_idempotent);
  });
});
