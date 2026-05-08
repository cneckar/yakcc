// SPDX-License-Identifier: MIT
// Vitest harness for types.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling types.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_types_corpusAtomSpec_optionalCacheDirOmittedNotUndefined,
  prop_types_corpusExtractionOptions_allFieldsOptionalBoolean,
  prop_types_corpusResult_readonlyFieldsPresent,
  prop_types_corpusSource_literalUnionShape,
  prop_types_intentCardInput_arrayFieldsAreReadonlyArrays,
} from "./types.props.js";

const opts = { numRuns: 100 };

it("property: prop_types_corpusSource_literalUnionShape", () => {
  fc.assert(prop_types_corpusSource_literalUnionShape, opts);
});

it("property: prop_types_corpusResult_readonlyFieldsPresent", () => {
  fc.assert(prop_types_corpusResult_readonlyFieldsPresent, opts);
});

it("property: prop_types_corpusAtomSpec_optionalCacheDirOmittedNotUndefined", () => {
  fc.assert(prop_types_corpusAtomSpec_optionalCacheDirOmittedNotUndefined, opts);
});

it("property: prop_types_intentCardInput_arrayFieldsAreReadonlyArrays", () => {
  fc.assert(prop_types_intentCardInput_arrayFieldsAreReadonlyArrays, opts);
});

it("property: prop_types_corpusExtractionOptions_allFieldsOptionalBoolean", () => {
  fc.assert(prop_types_corpusExtractionOptions_allFieldsOptionalBoolean, opts);
});
