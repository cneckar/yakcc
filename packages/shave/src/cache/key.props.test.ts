// SPDX-License-Identifier: MIT
// Vitest harness for cache/key.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./key.props.js";

describe("cache/key.ts — Path A property corpus", () => {
  it("property: sourceHash — returns 64-char lowercase hex string", () => {
    fc.assert(Props.prop_sourceHash_returns_64_char_hex);
  });

  it("property: sourceHash — deterministic (same input, same hash)", () => {
    fc.assert(Props.prop_sourceHash_is_deterministic);
  });

  it("property: sourceHash — CRLF and LF produce identical hash", () => {
    fc.assert(Props.prop_sourceHash_crlf_lf_equivalence);
  });

  it("property: sourceHash — outer whitespace is trimmed before hashing", () => {
    fc.assert(Props.prop_sourceHash_trims_outer_whitespace);
  });

  it("property: IntentKeyInputs — has four required fields with correct types", () => {
    fc.assert(Props.prop_IntentKeyInputs_has_required_fields);
  });

  it("property: keyFromIntentInputs — returns 64-char lowercase hex string", () => {
    fc.assert(Props.prop_keyFromIntentInputs_returns_64_char_hex);
  });

  it("property: keyFromIntentInputs — deterministic (same inputs, same key)", () => {
    fc.assert(Props.prop_keyFromIntentInputs_is_deterministic);
  });

  it("property: keyFromIntentInputs — NUL delimiter prevents prefix-boundary collision", () => {
    fc.assert(Props.prop_keyFromIntentInputs_nul_delimiter_prevents_prefix_collision);
  });

  it("property: keyFromIntentInputs — distinct modelTag yields distinct key", () => {
    fc.assert(Props.prop_keyFromIntentInputs_distinct_inputs_yield_distinct_keys);
  });

  it("property: sourceHash → keyFromIntentInputs — compound: full pipeline is CRLF-invariant", () => {
    fc.assert(Props.prop_sourceHash_to_keyFromIntentInputs_compound_pipeline);
  });
});
