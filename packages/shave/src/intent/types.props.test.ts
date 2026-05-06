// SPDX-License-Identifier: MIT
// Vitest harness for types.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./types.props.js";

describe("types.ts — Path A property corpus", () => {
  it("property: IntentParam shape conformance", () => {
    fc.assert(Props.prop_types_IntentParam_shape_conformance);
  });

  it("property: IntentParam all fields are strings", () => {
    fc.assert(Props.prop_types_IntentParam_all_fields_are_strings);
  });

  it("property: IntentCard schemaVersion is literal 1", () => {
    fc.assert(Props.prop_types_IntentCard_schemaVersion_is_literal_1);
  });

  it("property: IntentCard round-trip through validateIntentCard", () => {
    fc.assert(Props.prop_types_IntentCard_round_trip_through_validator);
  });
});
