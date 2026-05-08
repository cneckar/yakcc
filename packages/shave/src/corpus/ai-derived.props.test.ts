// SPDX-License-Identifier: MIT
// Vitest harness for ai-derived.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling ai-derived.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_corpus_defaultModelIsClaudeHaiku45,
  prop_corpus_promptVersionIsCorpus1,
  prop_corpus_schemaVersionIsLiteral2,
  prop_corpusCacheKey_differsFromIntentKey,
  prop_corpusCacheKey_isDeterministicGivenSameInputs,
  prop_corpusCacheKey_isStringMatching64HexChars,
  prop_corpusCacheKey_modelDefaultIsCorpusDefaultModel,
  prop_corpusCacheKey_promptVersionDefaultIsCorpusPromptVersion,
  prop_extractFromAiDerivedCached_bytesEncodeCachedContent,
  prop_extractFromAiDerivedCached_contentHashMatchesBytes,
  prop_extractFromAiDerivedCached_intentCardIsIgnoredForReturnShape,
  prop_extractFromAiDerivedCached_returnsAiDerivedSourceOnHit,
  prop_extractFromAiDerivedCached_returnsCanonicalArtifactPath,
  prop_extractFromAiDerivedCached_returnsUndefinedOnMiss,
  prop_readCorpusCache_returnsEntryOnHit,
  prop_readCorpusCache_returnsUndefinedOnEmptyContent,
  prop_readCorpusCache_returnsUndefinedOnMiss,
  prop_readCorpusCache_returnsUndefinedOnSchemaVersionMismatch,
  prop_seedCorpusCache_doesNotCallAnthropicSdk,
  prop_seedCorpusCache_writesValidCachedCorpusEntry,
  prop_writeCorpusCache_isAtomicAndReadable,
} from "./ai-derived.props.js";

// Filesystem-touching properties use lower numRuns to keep wall-clock time reasonable.
const pureOpts = { numRuns: 100 };
const fsOpts = { numRuns: 50 };

it("property: prop_corpus_schemaVersionIsLiteral2", () => {
  fc.assert(prop_corpus_schemaVersionIsLiteral2, pureOpts);
});

it("property: prop_corpus_defaultModelIsClaudeHaiku45", () => {
  fc.assert(prop_corpus_defaultModelIsClaudeHaiku45, pureOpts);
});

it("property: prop_corpus_promptVersionIsCorpus1", () => {
  fc.assert(prop_corpus_promptVersionIsCorpus1, pureOpts);
});

it("property: prop_corpusCacheKey_isStringMatching64HexChars", () => {
  fc.assert(prop_corpusCacheKey_isStringMatching64HexChars, pureOpts);
});

it("property: prop_corpusCacheKey_isDeterministicGivenSameInputs", () => {
  fc.assert(prop_corpusCacheKey_isDeterministicGivenSameInputs, pureOpts);
});

it("property: prop_corpusCacheKey_differsFromIntentKey", () => {
  fc.assert(prop_corpusCacheKey_differsFromIntentKey, pureOpts);
});

it("property: prop_corpusCacheKey_modelDefaultIsCorpusDefaultModel", () => {
  fc.assert(prop_corpusCacheKey_modelDefaultIsCorpusDefaultModel, pureOpts);
});

it("property: prop_corpusCacheKey_promptVersionDefaultIsCorpusPromptVersion", () => {
  fc.assert(prop_corpusCacheKey_promptVersionDefaultIsCorpusPromptVersion, pureOpts);
});

it("property: prop_readCorpusCache_returnsUndefinedOnMiss", async () => {
  await fc.assert(prop_readCorpusCache_returnsUndefinedOnMiss, fsOpts);
});

it("property: prop_readCorpusCache_returnsUndefinedOnSchemaVersionMismatch", async () => {
  await fc.assert(prop_readCorpusCache_returnsUndefinedOnSchemaVersionMismatch, fsOpts);
});

it("property: prop_readCorpusCache_returnsUndefinedOnEmptyContent", async () => {
  await fc.assert(prop_readCorpusCache_returnsUndefinedOnEmptyContent, fsOpts);
});

it("property: prop_readCorpusCache_returnsEntryOnHit", async () => {
  await fc.assert(prop_readCorpusCache_returnsEntryOnHit, fsOpts);
});

it("property: prop_writeCorpusCache_isAtomicAndReadable", async () => {
  await fc.assert(prop_writeCorpusCache_isAtomicAndReadable, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_returnsUndefinedOnMiss", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_returnsUndefinedOnMiss, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_returnsAiDerivedSourceOnHit", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_returnsAiDerivedSourceOnHit, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_returnsCanonicalArtifactPath", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_returnsCanonicalArtifactPath, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_bytesEncodeCachedContent", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_bytesEncodeCachedContent, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_contentHashMatchesBytes", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_contentHashMatchesBytes, fsOpts);
});

it("property: prop_extractFromAiDerivedCached_intentCardIsIgnoredForReturnShape", async () => {
  await fc.assert(prop_extractFromAiDerivedCached_intentCardIsIgnoredForReturnShape, fsOpts);
});

it("property: prop_seedCorpusCache_writesValidCachedCorpusEntry", async () => {
  await fc.assert(prop_seedCorpusCache_writesValidCachedCorpusEntry, fsOpts);
});

it("property: prop_seedCorpusCache_doesNotCallAnthropicSdk", async () => {
  await fc.assert(prop_seedCorpusCache_doesNotCallAnthropicSdk, fsOpts);
});
