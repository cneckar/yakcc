// SPDX-License-Identifier: MIT
// Vitest harness for index.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling index.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_extractCorpusCascade_fallsThroughBToA,
  prop_extractCorpusCascade_fallsThroughCToBToA,
  prop_extractCorpusCascade_returnsPropsFileSourceWhenAvailable,
  prop_extractCorpusCascade_throwsWhenAllDisabledOrUnavailable,
  prop_extractCorpus_doesNotMutateAtomSpec,
  prop_extractCorpus_doesNotMutateOptions,
  prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileMissing,
  prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileNoMatch,
  prop_extractCorpus_propsFileEnableFlagDisablesPropsFileSource,
  prop_extractCorpus_returnedShapeIsValidCorpusResult,
  prop_extractCorpus_returnsImmediatelyAtFirstEnabledSource,
  prop_extractCorpus_returnsPropsFileSource_whenPropsFileMatches,
  prop_extractCorpus_returnsResult_whenAllSourcesEnabledAndPropsFileMissing,
  prop_extractCorpus_throwsWhenAllSourcesDisabled,
  prop_extractCorpus_throwsWhenOnlyAiDisabledAndCacheDirOmitted,
  prop_indexExports_corpusDefaultModelIsClaudeHaiku45,
  prop_indexExports_corpusPromptVersionIsCorpus1,
  prop_indexExports_corpusSchemaVersionIs2,
  prop_indexExports_extractFromPropsFileIsCallable,
  prop_indexExports_seedCorpusCacheIsCallable,
} from "./index.props.js";

// Pure-string properties: higher numRuns is fine
const opts = { numRuns: 100 };
// Filesystem-touching async properties: lower numRuns to keep wall-clock in budget
const fsOpts = { numRuns: 50 };

it("property: prop_extractCorpus_returnsResult_whenAllSourcesEnabledAndPropsFileMissing", async () => {
  await fc.assert(prop_extractCorpus_returnsResult_whenAllSourcesEnabledAndPropsFileMissing, opts);
});

it("property: prop_extractCorpus_returnsPropsFileSource_whenPropsFileMatches", async () => {
  await fc.assert(prop_extractCorpus_returnsPropsFileSource_whenPropsFileMatches, fsOpts);
});

it("property: prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileNoMatch", async () => {
  await fc.assert(prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileNoMatch, fsOpts);
});

it("property: prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileMissing", async () => {
  await fc.assert(prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileMissing, opts);
});

it("property: prop_extractCorpus_returnsImmediatelyAtFirstEnabledSource", async () => {
  await fc.assert(prop_extractCorpus_returnsImmediatelyAtFirstEnabledSource, opts);
});

it("property: prop_extractCorpus_throwsWhenAllSourcesDisabled", async () => {
  await fc.assert(prop_extractCorpus_throwsWhenAllSourcesDisabled, opts);
});

it("property: prop_extractCorpus_throwsWhenOnlyAiDisabledAndCacheDirOmitted", async () => {
  await fc.assert(prop_extractCorpus_throwsWhenOnlyAiDisabledAndCacheDirOmitted, opts);
});

it("property: prop_extractCorpus_propsFileEnableFlagDisablesPropsFileSource", async () => {
  await fc.assert(prop_extractCorpus_propsFileEnableFlagDisablesPropsFileSource, fsOpts);
});

it("property: prop_extractCorpusCascade_returnsPropsFileSourceWhenAvailable", async () => {
  await fc.assert(prop_extractCorpusCascade_returnsPropsFileSourceWhenAvailable, fsOpts);
});

it("property: prop_extractCorpusCascade_fallsThroughBToA", async () => {
  await fc.assert(prop_extractCorpusCascade_fallsThroughBToA, opts);
});

it("property: prop_extractCorpusCascade_fallsThroughCToBToA", async () => {
  await fc.assert(prop_extractCorpusCascade_fallsThroughCToBToA, fsOpts);
});

it("property: prop_extractCorpusCascade_throwsWhenAllDisabledOrUnavailable", async () => {
  await fc.assert(prop_extractCorpusCascade_throwsWhenAllDisabledOrUnavailable, opts);
});

it("property: prop_extractCorpus_returnedShapeIsValidCorpusResult", async () => {
  await fc.assert(prop_extractCorpus_returnedShapeIsValidCorpusResult, opts);
});

it("property: prop_extractCorpus_doesNotMutateAtomSpec", async () => {
  await fc.assert(prop_extractCorpus_doesNotMutateAtomSpec, opts);
});

it("property: prop_extractCorpus_doesNotMutateOptions", async () => {
  await fc.assert(prop_extractCorpus_doesNotMutateOptions, opts);
});

it("property: prop_indexExports_corpusSchemaVersionIs2", () => {
  fc.assert(prop_indexExports_corpusSchemaVersionIs2, opts);
});

it("property: prop_indexExports_corpusDefaultModelIsClaudeHaiku45", () => {
  fc.assert(prop_indexExports_corpusDefaultModelIsClaudeHaiku45, opts);
});

it("property: prop_indexExports_corpusPromptVersionIsCorpus1", () => {
  fc.assert(prop_indexExports_corpusPromptVersionIsCorpus1, opts);
});

it("property: prop_indexExports_seedCorpusCacheIsCallable", () => {
  fc.assert(prop_indexExports_seedCorpusCacheIsCallable, opts);
});

it("property: prop_indexExports_extractFromPropsFileIsCallable", () => {
  fc.assert(prop_indexExports_extractFromPropsFileIsCallable, opts);
});
