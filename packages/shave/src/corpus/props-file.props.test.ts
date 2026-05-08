// SPDX-License-Identifier: MIT
// Vitest harness for props-file.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling props-file.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_extractFromPropsFile_bytesIsUtf8EncodedContent,
  prop_extractFromPropsFile_contentHashIs64CharHex,
  prop_extractFromPropsFile_doesNotMutateIntentCard,
  prop_extractFromPropsFile_doesNotMutateSource,
  prop_extractFromPropsFile_inferFunctionName_constFallback,
  prop_extractFromPropsFile_inferFunctionName_fnDeclWins,
  prop_extractFromPropsFile_inferFunctionName_undefinedForNoName,
  prop_extractFromPropsFile_resultPathIsAtomNameDotPropsTs,
  prop_extractFromPropsFile_returnsPropsFileSource_whenMatchFound,
  prop_extractFromPropsFile_returnsUndefined_whenFileCannotBeRead,
  prop_extractFromPropsFile_returnsUndefined_whenNoFunctionNameInferable,
  prop_extractFromPropsFile_returnsUndefined_whenNoMatchingExport,
} from "./props-file.props.js";

const opts = { numRuns: 100 };

it("property: prop_extractFromPropsFile_returnsUndefined_whenFileCannotBeRead", async () => {
  await fc.assert(prop_extractFromPropsFile_returnsUndefined_whenFileCannotBeRead, opts);
});

it("property: prop_extractFromPropsFile_returnsUndefined_whenNoFunctionNameInferable", async () => {
  await fc.assert(prop_extractFromPropsFile_returnsUndefined_whenNoFunctionNameInferable, opts);
});

it("property: prop_extractFromPropsFile_returnsUndefined_whenNoMatchingExport", async () => {
  await fc.assert(prop_extractFromPropsFile_returnsUndefined_whenNoMatchingExport, opts);
});

it("property: prop_extractFromPropsFile_returnsPropsFileSource_whenMatchFound", async () => {
  await fc.assert(prop_extractFromPropsFile_returnsPropsFileSource_whenMatchFound, opts);
});

it("property: prop_extractFromPropsFile_bytesIsUtf8EncodedContent", async () => {
  await fc.assert(prop_extractFromPropsFile_bytesIsUtf8EncodedContent, opts);
});

it("property: prop_extractFromPropsFile_contentHashIs64CharHex", async () => {
  await fc.assert(prop_extractFromPropsFile_contentHashIs64CharHex, opts);
});

it("property: prop_extractFromPropsFile_resultPathIsAtomNameDotPropsTs", async () => {
  await fc.assert(prop_extractFromPropsFile_resultPathIsAtomNameDotPropsTs, opts);
});

it("property: prop_extractFromPropsFile_doesNotMutateIntentCard", async () => {
  await fc.assert(prop_extractFromPropsFile_doesNotMutateIntentCard, opts);
});

it("property: prop_extractFromPropsFile_doesNotMutateSource", async () => {
  await fc.assert(prop_extractFromPropsFile_doesNotMutateSource, opts);
});

it("property: prop_extractFromPropsFile_inferFunctionName_fnDeclWins", async () => {
  await fc.assert(prop_extractFromPropsFile_inferFunctionName_fnDeclWins, opts);
});

it("property: prop_extractFromPropsFile_inferFunctionName_constFallback", async () => {
  await fc.assert(prop_extractFromPropsFile_inferFunctionName_constFallback, opts);
});

it("property: prop_extractFromPropsFile_inferFunctionName_undefinedForNoName", async () => {
  await fc.assert(prop_extractFromPropsFile_inferFunctionName_undefinedForNoName, opts);
});
