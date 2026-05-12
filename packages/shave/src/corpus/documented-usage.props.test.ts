// SPDX-License-Identifier: MIT
// Vitest harness for documented-usage.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling documented-usage.props.ts (vitest-free, hashable as a manifest artifact).
//
// WI-376 revision: tests updated for loud-refusal contract
// (DEC-PROPTEST-DOCUMENTED-USAGE-001). Removed tests for placeholder behavior
// (signature test, return-true bodies, oneItPerExamplePlusOneSignatureTest, etc.)
// and added tests for the new refusal contract.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_extractFromDocumentedUsage_assertionUsesExpectToEqual,
  prop_extractFromDocumentedUsage_bytesAreUtf8RoundTrip,
  prop_extractFromDocumentedUsage_contentHashIsBlake3HexOf64Chars,
  prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName,
  prop_extractFromDocumentedUsage_describeFallsBackToAtom,
  prop_extractFromDocumentedUsage_determinismGivenSameInputs,
  prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment,
  prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed,
  prop_extractFromDocumentedUsage_exampleLabelIncludesCallExpr,
  prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping,
  prop_extractFromDocumentedUsage_mixedExamplesEmitsOnlyParseable,
  prop_extractFromDocumentedUsage_multilineExamplesReturnUndefined,
  prop_extractFromDocumentedUsage_noExamplesReturnsUndefined,
  prop_extractFromDocumentedUsage_parseableExampleProducesExpectAssertion,
  prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath,
  prop_extractFromDocumentedUsage_returnsDocumentedUsageSource,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayAngle,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayBracket,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_bigint,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_boolean,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_integerOrInt,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_number,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_string,
  prop_extractFromDocumentedUsage_typeHintToArbitrary_unknownFallsBackToAnything,
  prop_extractFromDocumentedUsage_unstructuredExamplesReturnUndefined,
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

it("property: prop_extractFromDocumentedUsage_parseableExampleProducesExpectAssertion", () => {
  fc.assert(prop_extractFromDocumentedUsage_parseableExampleProducesExpectAssertion, opts);
});

it("property: prop_extractFromDocumentedUsage_noExamplesReturnsUndefined", () => {
  fc.assert(prop_extractFromDocumentedUsage_noExamplesReturnsUndefined, opts);
});

it("property: prop_extractFromDocumentedUsage_unstructuredExamplesReturnUndefined", () => {
  fc.assert(prop_extractFromDocumentedUsage_unstructuredExamplesReturnUndefined, opts);
});

it("property: prop_extractFromDocumentedUsage_exampleLabelIncludesCallExpr", () => {
  fc.assert(prop_extractFromDocumentedUsage_exampleLabelIncludesCallExpr, opts);
});

it("property: prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed", () => {
  fc.assert(prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed, opts);
});

it("property: prop_extractFromDocumentedUsage_assertionUsesExpectToEqual", () => {
  fc.assert(prop_extractFromDocumentedUsage_assertionUsesExpectToEqual, opts);
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

it("property: prop_extractFromDocumentedUsage_multilineExamplesReturnUndefined", () => {
  fc.assert(prop_extractFromDocumentedUsage_multilineExamplesReturnUndefined, opts);
});

it("property: prop_extractFromDocumentedUsage_mixedExamplesEmitsOnlyParseable", () => {
  fc.assert(prop_extractFromDocumentedUsage_mixedExamplesEmitsOnlyParseable, opts);
});
