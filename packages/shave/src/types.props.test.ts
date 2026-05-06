// SPDX-License-Identifier: MIT
// Vitest harness for types.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./types.props.js";

describe("types.ts — Path A property corpus", () => {
  it("property: FOREIGN_POLICY_DEFAULT — value is 'tag' and satisfies ForeignPolicy", () => {
    fc.assert(Props.prop_FOREIGN_POLICY_DEFAULT_is_tag);
  });

  it("property: ShaveOptions — optional fields accepted and retained", () => {
    fc.assert(Props.prop_ShaveOptions_optional_fields_accepted);
  });

  it("property: ShaveOptions — empty object satisfies the interface", () => {
    fc.assert(Props.prop_ShaveOptions_empty_object_accepted);
  });

  it("property: ShaveDiagnostics — cache counters are non-negative", () => {
    fc.assert(Props.prop_ShaveDiagnostics_cache_counters_nonnegative);
  });

  it("property: ShaveDiagnostics — stubbed contains only known literals", () => {
    fc.assert(Props.prop_ShaveDiagnostics_stubbed_contains_only_known_literals);
  });

  it("property: ShavedAtomStub — sourceRange.start <= sourceRange.end", () => {
    fc.assert(Props.prop_ShavedAtomStub_sourceRange_start_le_end);
  });

  it("property: ShavedAtomStub — placeholderId is non-empty", () => {
    fc.assert(Props.prop_ShavedAtomStub_placeholderId_nonempty);
  });

  it("property: ShaveResult — sourcePath is non-empty", () => {
    fc.assert(Props.prop_ShaveResult_sourcePath_nonempty);
  });

  it("property: ShaveResult — atoms and intentCards are arrays", () => {
    fc.assert(Props.prop_ShaveResult_arrays_are_arrays);
  });

  it("property: CandidateBlock — source field is a string", () => {
    fc.assert(Props.prop_CandidateBlock_source_is_string);
  });

  it("property: CandidateBlock — hint field is optional (absent when omitted)", () => {
    fc.assert(Props.prop_CandidateBlock_hint_is_optional);
  });

  it("property: ShaveRegistryView — selectBlocks resolves to an array", async () => {
    await fc.assert(Props.prop_ShaveRegistryView_selectBlocks_returns_array, { numRuns: 10 });
  });

  it("property: IntentExtractionHook — id is a non-empty string", () => {
    fc.assert(Props.prop_IntentExtractionHook_id_is_nonempty);
  });

  it("property: UniversalizeSlicePlanEntry — kind is a known discriminant", () => {
    fc.assert(Props.prop_UniversalizeSlicePlanEntry_kind_is_known_discriminant);
  });

  it("property: UniversalizeResult — matchedPrimitives and slicePlan are arrays", () => {
    fc.assert(Props.prop_UniversalizeResult_matchedPrimitives_is_array);
  });

  it("property: ShaveResult + ShaveDiagnostics — compound: diagnostics fields jointly consistent", () => {
    fc.assert(Props.prop_ShaveResult_compound_diagnostics_consistent);
  });
});
