// SPDX-License-Identifier: MIT
// Vitest harness for errors.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./errors.props.js";

describe("errors.ts — Path A property corpus", () => {
  it("property: AnthropicApiKeyMissingError — message includes ANTHROPIC_API_KEY guidance", () => {
    fc.assert(Props.prop_AnthropicApiKeyMissingError_message_contains_guidance);
  });

  it("property: AnthropicApiKeyMissingError — name and instanceof invariants", () => {
    fc.assert(Props.prop_AnthropicApiKeyMissingError_name_and_instanceof);
  });

  it("property: OfflineCacheMissError — message contains the cacheKey", () => {
    fc.assert(Props.prop_OfflineCacheMissError_message_contains_cache_key);
  });

  it("property: OfflineCacheMissError — name and instanceof invariants", () => {
    fc.assert(Props.prop_OfflineCacheMissError_name_and_instanceof);
  });

  it("property: IntentCardSchemaError — message contains the detail", () => {
    fc.assert(Props.prop_IntentCardSchemaError_message_contains_detail);
  });

  it("property: IntentCardSchemaError — name and instanceof invariants", () => {
    fc.assert(Props.prop_IntentCardSchemaError_name_and_instanceof);
  });

  it("property: LicenseRefusedError — message contains reason", () => {
    fc.assert(Props.prop_LicenseRefusedError_message_contains_reason);
  });

  it("property: LicenseRefusedError — detection field matches constructor arg", () => {
    fc.assert(Props.prop_LicenseRefusedError_detection_field_matches_arg);
  });

  it("property: LicenseRefusedError — name and instanceof invariants", () => {
    fc.assert(Props.prop_LicenseRefusedError_name_and_instanceof);
  });

  it("property: ForeignPolicyRejectError — message includes all pkg#export pairs", () => {
    fc.assert(Props.prop_ForeignPolicyRejectError_message_includes_all_refs);
  });

  it("property: ForeignPolicyRejectError — foreignRefs array matches constructor arg", () => {
    fc.assert(Props.prop_ForeignPolicyRejectError_foreignRefs_matches_arg);
  });

  it("property: ForeignPolicyRejectError — name and instanceof invariants", () => {
    fc.assert(Props.prop_ForeignPolicyRejectError_name_and_instanceof);
  });

  it("property: ForeignPolicyRejectError + message — compound: message and refs jointly consistent", () => {
    fc.assert(Props.prop_ForeignPolicyRejectError_compound_message_and_refs_consistent);
  });
});
