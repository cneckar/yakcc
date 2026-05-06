// SPDX-License-Identifier: MIT
// Vitest harness for constants.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./constants.props.js";

describe("constants.ts — Path A property corpus", () => {
  it("property: DEFAULT_MODEL is non-empty", () => {
    fc.assert(Props.prop_constants_DEFAULT_MODEL_is_non_empty);
  });

  it("property: DEFAULT_MODEL matches haiku-4-5-YYYYMMDD format", () => {
    fc.assert(Props.prop_constants_DEFAULT_MODEL_matches_haiku_format);
  });

  it("property: INTENT_PROMPT_VERSION is string '1'", () => {
    fc.assert(Props.prop_constants_INTENT_PROMPT_VERSION_is_string_1);
  });

  it("property: INTENT_SCHEMA_VERSION is number 1", () => {
    fc.assert(Props.prop_constants_INTENT_SCHEMA_VERSION_is_number_1);
  });

  it("property: STATIC_MODEL_TAG is literal 'static-ts@1'", () => {
    fc.assert(Props.prop_constants_STATIC_MODEL_TAG_is_literal);
  });

  it("property: STATIC_PROMPT_VERSION is literal 'static-jsdoc@1'", () => {
    fc.assert(Props.prop_constants_STATIC_PROMPT_VERSION_is_literal);
  });

  it("property: static and LLM cache keys are disjoint for same source", () => {
    fc.assert(Props.prop_constants_static_and_llm_cache_keys_are_disjoint);
  });

  it("property: static cache key is deterministic", () => {
    fc.assert(Props.prop_constants_static_key_is_deterministic);
  });
});
