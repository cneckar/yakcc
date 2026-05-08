// SPDX-License-Identifier: MIT
// Vitest harness for upstream-test.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling upstream-test.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_extractFromUpstreamTest_behaviorLabelTruncatedTo80,
  prop_extractFromUpstreamTest_bytesIsUtf8EncodedContent,
  prop_extractFromUpstreamTest_contentHashIsBlake3HexOf64Chars,
  prop_extractFromUpstreamTest_describeFallsBackToAtom,
  prop_extractFromUpstreamTest_describeBlockUsesInferredFnName,
  prop_extractFromUpstreamTest_determinismGivenSameInputs,
  prop_extractFromUpstreamTest_doNotEditMarkerPresent,
  prop_extractFromUpstreamTest_emptyPreconditionsStillEmitsBehavior,
  prop_extractFromUpstreamTest_importsFastCheckAndVitest,
  prop_extractFromUpstreamTest_inferFunctionName_constMatchFallback,
  prop_extractFromUpstreamTest_inferFunctionName_functionDeclWins,
  prop_extractFromUpstreamTest_inferFunctionName_undefinedFallsBackToAtom,
  prop_extractFromUpstreamTest_inputCommentsRenderedWhenInputsPresent,
  prop_extractFromUpstreamTest_oneItPerPrecondition,
  prop_extractFromUpstreamTest_outputCommentsRenderedWhenOutputsPresent,
  prop_extractFromUpstreamTest_postconditionLabelsAreJsonStringified,
  prop_extractFromUpstreamTest_preconditionLabelsAreJsonStringified,
  prop_extractFromUpstreamTest_returnsCanonicalArtifactPath,
  prop_extractFromUpstreamTest_returnsUpstreamTestSource,
} from "./upstream-test.props.js";

const opts = { numRuns: 100 };

it("property: prop_extractFromUpstreamTest_returnsUpstreamTestSource", () => {
  fc.assert(prop_extractFromUpstreamTest_returnsUpstreamTestSource, opts);
});

it("property: prop_extractFromUpstreamTest_returnsCanonicalArtifactPath", () => {
  fc.assert(prop_extractFromUpstreamTest_returnsCanonicalArtifactPath, opts);
});

it("property: prop_extractFromUpstreamTest_bytesIsUtf8EncodedContent", () => {
  fc.assert(prop_extractFromUpstreamTest_bytesIsUtf8EncodedContent, opts);
});

it("property: prop_extractFromUpstreamTest_contentHashIsBlake3HexOf64Chars", () => {
  fc.assert(prop_extractFromUpstreamTest_contentHashIsBlake3HexOf64Chars, opts);
});

it("property: prop_extractFromUpstreamTest_determinismGivenSameInputs", () => {
  fc.assert(prop_extractFromUpstreamTest_determinismGivenSameInputs, opts);
});

it("property: prop_extractFromUpstreamTest_describeBlockUsesInferredFnName", () => {
  fc.assert(prop_extractFromUpstreamTest_describeBlockUsesInferredFnName, opts);
});

it("property: prop_extractFromUpstreamTest_describeFallsBackToAtom", () => {
  fc.assert(prop_extractFromUpstreamTest_describeFallsBackToAtom, opts);
});

it("property: prop_extractFromUpstreamTest_oneItPerPrecondition", () => {
  fc.assert(prop_extractFromUpstreamTest_oneItPerPrecondition, opts);
});

it("property: prop_extractFromUpstreamTest_emptyPreconditionsStillEmitsBehavior", () => {
  fc.assert(prop_extractFromUpstreamTest_emptyPreconditionsStillEmitsBehavior, opts);
});

it("property: prop_extractFromUpstreamTest_preconditionLabelsAreJsonStringified", () => {
  fc.assert(prop_extractFromUpstreamTest_preconditionLabelsAreJsonStringified, opts);
});

it("property: prop_extractFromUpstreamTest_postconditionLabelsAreJsonStringified", () => {
  fc.assert(prop_extractFromUpstreamTest_postconditionLabelsAreJsonStringified, opts);
});

it("property: prop_extractFromUpstreamTest_behaviorLabelTruncatedTo80", () => {
  fc.assert(prop_extractFromUpstreamTest_behaviorLabelTruncatedTo80, opts);
});

it("property: prop_extractFromUpstreamTest_inputCommentsRenderedWhenInputsPresent", () => {
  fc.assert(prop_extractFromUpstreamTest_inputCommentsRenderedWhenInputsPresent, opts);
});

it("property: prop_extractFromUpstreamTest_outputCommentsRenderedWhenOutputsPresent", () => {
  fc.assert(prop_extractFromUpstreamTest_outputCommentsRenderedWhenOutputsPresent, opts);
});

it("property: prop_extractFromUpstreamTest_importsFastCheckAndVitest", () => {
  fc.assert(prop_extractFromUpstreamTest_importsFastCheckAndVitest, opts);
});

it("property: prop_extractFromUpstreamTest_doNotEditMarkerPresent", () => {
  fc.assert(prop_extractFromUpstreamTest_doNotEditMarkerPresent, opts);
});

it("property: prop_extractFromUpstreamTest_inferFunctionName_functionDeclWins", () => {
  fc.assert(prop_extractFromUpstreamTest_inferFunctionName_functionDeclWins, opts);
});

it("property: prop_extractFromUpstreamTest_inferFunctionName_constMatchFallback", () => {
  fc.assert(prop_extractFromUpstreamTest_inferFunctionName_constMatchFallback, opts);
});

it("property: prop_extractFromUpstreamTest_inferFunctionName_undefinedFallsBackToAtom", () => {
  fc.assert(prop_extractFromUpstreamTest_inferFunctionName_undefinedFallsBackToAtom, opts);
});
