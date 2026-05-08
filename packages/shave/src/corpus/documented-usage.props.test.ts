// SPDX-License-Identifier: MIT
// Vitest harness for documented-usage.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling documented-usage.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_extractFromDocumentedUsage_arbListJoinedByCommaSpace,
  prop_extractFromDocumentedUsage_bytesAreUtf8RoundTrip,
  prop_extractFromDocumentedUsage_contentHashIsBlake3HexOf64Chars,
  prop_extractFromDocumentedUsage_describeFallsBackToAtom,
  prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName,
  prop_extractFromDocumentedUsage_determinismGivenSameInputs,
  prop_extractFromDocumentedUsage_emptyExamplesStillEmitsSignatureTest,
  prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment,
  prop_extractFromDocumentedUsage_emptyInputsUseAnythingFallback,
  prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed,
  prop_extractFromDocumentedUsage_exampleLabelsAreJsonStringified,
  prop_extractFromDocumentedUsage_extractJsDocExamples_emptySourceReturnsEmptyArray,
  prop_extractFromDocumentedUsage_inputArbitraryPrefixesAreUnderscored,
  prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping,
  prop_extractFromDocumentedUsage_oneItPerExamplePlusOneSignatureTest,
  prop_extractFromDocumentedUsage_postconditionsAreCommentedInSignatureTest,
  prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath,
  prop_extractFromDocumentedUsage_returnsDocumentedUsageSource,
  prop_extractFromDocumentedUsage_signatureTestLabelTruncatedTo60,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayAngle,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayBracket,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_bigint,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_boolean,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_integerOrInt,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_number,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_string,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_unknownFallsBackToAnything,
} from "./documented-usage.props.js";

const opts = { numRuns: 100 };

it("property: prop_extractFromDocumentedUsage_returnsDocumentedUsageSource", () => {
  fc.assert(prop_extractFromDocumentedUsage_returnsDocumentedUsageSource, opts);
});

it("property: prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath", () => {
  fc.assert(prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath, opts);
});

it("property: prop_extractFromDocumentedUsage_bytesAreUtf8RoundTrip", () => {
  fc.assert(prop_extractFromDocumentedUsage_bytesAreUtf8RoundTrip, opts);
});

it("property: prop_extractFromDocumentedUsage_contentHashIsBlake3HexOf64Chars", () => {
  fc.assert(prop_extractFromDocumentedUsage_contentHashIsBlake3HexOf64Chars, opts);
});

it("property: prop_extractFromDocumentedUsage_determinismGivenSameInputs", () => {
  fc.assert(prop_extractFromDocumentedUsage_determinismGivenSameInputs, opts);
});

it("property: prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName", () => {
  fc.assert(prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName, opts);
});

it("property: prop_extractFromDocumentedUsage_describeFallsBackToAtom", () => {
  fc.assert(prop_extractFromDocumentedUsage_describeFallsBackToAtom, opts);
});

it("property: prop_extractFromDocumentedUsage_oneItPerExamplePlusOneSignatureTest", () => {
  fc.assert(prop_extractFromDocumentedUsage_oneItPerExamplePlusOneSignatureTest, opts);
});

it("property: prop_extractFromDocumentedUsage_emptyExamplesStillEmitsSignatureTest", () => {
  fc.assert(prop_extractFromDocumentedUsage_emptyExamplesStillEmitsSignatureTest, opts);
});

it("property: prop_extractFromDocumentedUsage_exampleLabelsAreJsonStringified", () => {
  fc.assert(prop_extractFromDocumentedUsage_exampleLabelsAreJsonStringified, opts);
});

it("property: prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed", () => {
  fc.assert(prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed, opts);
});

it("property: prop_extractFromDocumentedUsage_signatureTestLabelTruncatedTo60", () => {
  fc.assert(prop_extractFromDocumentedUsage_signatureTestLabelTruncatedTo60, opts);
});

it("property: prop_extractFromDocumentedUsage_postconditionsAreCommentedInSignatureTest", () => {
  fc.assert(prop_extractFromDocumentedUsage_postconditionsAreCommentedInSignatureTest, opts);
});

it("property: prop_extractFromDocumentedUsage_inputArbitraryPrefixesAreUnderscored", () => {
  fc.assert(prop_extractFromDocumentedUsage_inputArbitraryPrefixesAreUnderscored, opts);
});

it("property: prop_extractFromDocumentedUsage_arbListJoinedByCommaSpace", () => {
  fc.assert(prop_extractFromDocumentedUsage_arbListJoinedByCommaSpace, opts);
});

it("property: prop_extractFromDocumentedUsage_emptyInputsUseAnythingFallback", () => {
  fc.assert(prop_extractFromDocumentedUsage_emptyInputsUseAnythingFallback, opts);
});

it("property: prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping", () => {
  fc.assert(prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping, opts);
});

it("property: prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment", () => {
  fc.assert(prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_string", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_string, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_number", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_number, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_integerOrInt", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_integerOrInt, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_boolean", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_boolean, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_bigint", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_bigint, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayBracket", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayBracket, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayAngle", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayAngle, opts);
});

it("property: prop_extractFromDocumentedUsage_typeHintToArbitrary_unknownFallsBackToAnything", () => {
  fc.assert(prop_extractFromDocumentedUsage_typeHintToArbitrary_unknownFallsBackToAnything, opts);
});

it("property: prop_extractFromDocumentedUsage_extractJsDocExamples_emptySourceReturnsEmptyArray", () => {
  fc.assert(
    prop_extractFromDocumentedUsage_extractJsDocExamples_emptySourceReturnsEmptyArray,
    opts,
  );
});
