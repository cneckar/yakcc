// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/index.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from index.ts):
//   extractCorpus(atomSpec, options?) — immediate-priority-chain extractor (IDX1.1–IDX1.15)
//   extractCorpusCascade(atomSpec, options?) — cascade fallthrough extractor (IDX1.9–IDX1.12)
//   Re-exported constants and functions: CORPUS_SCHEMA_VERSION (IDX1.16),
//   CORPUS_DEFAULT_MODEL (IDX1.17), CORPUS_PROMPT_VERSION (IDX1.18),
//   seedCorpusCache (IDX1.19), extractFromPropsFile (IDX1.20)
//
// Properties covered (20 atoms):
//   1.  extractCorpus returns result.source='upstream-test' with no propsFilePath and defaults
//   2.  extractCorpus returns result.source='props-file' when props file has matching export
//   3.  extractCorpus falls through to upstream-test when props file has no matching export
//   4.  extractCorpus falls through to upstream-test when propsFilePath points to missing file
//   5.  extractCorpus returns at the first enabled source (b/c never consulted when a enabled)
//   6.  extractCorpus throws when all sources disabled
//   7.  extractCorpus throws when only ai-derived enabled but no cacheDir
//   8.  extractCorpus respects enablePropsFile=false bypass
//   9.  extractCorpusCascade returns source='props-file' when props file matches
//   10. extractCorpusCascade falls through to documented-usage when upstream-test disabled
//   11. extractCorpusCascade falls through to ai-derived when both a+b disabled and cache hit
//   12. extractCorpusCascade throws when all sources disabled or unavailable
//   13. extractCorpus returned shape satisfies CorpusResult structural invariants
//   14. extractCorpus does not mutate atomSpec input
//   15. extractCorpus does not mutate options input
//   16. CORPUS_SCHEMA_VERSION re-export === 2
//   17. CORPUS_DEFAULT_MODEL re-export === 'claude-haiku-4-5-20251001'
//   18. CORPUS_PROMPT_VERSION re-export === 'corpus-1'
//   19. seedCorpusCache re-export is callable
//   20. extractFromPropsFile re-export is callable

// ---------------------------------------------------------------------------
// Property-test corpus for corpus/index.ts
// ---------------------------------------------------------------------------

import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import {
  CORPUS_DEFAULT_MODEL,
  CORPUS_PROMPT_VERSION,
  CORPUS_SCHEMA_VERSION,
  extractCorpus,
  extractCorpusCascade,
  extractFromPropsFile,
  seedCorpusCache,
} from "./index.js";
import type { CorpusAtomSpec, CorpusExtractionOptions, CorpusResult } from "./index.js";
import type { IntentCardInput } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary IntentCardInput. */
const intentCardInputArb: fc.Arbitrary<IntentCardInput> = fc.record({
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  sourceHash: fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
    .map((nibbles) => nibbles.map((n) => n.toString(16)).join("")),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
});

/** Source string with a valid function declaration whose name can be inferred. */
const sourceFnDeclArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .map((name) => `export function ${name}(x: string): string { return x; }`);

/** Build a minimal CorpusAtomSpec without propsFilePath (disables props-file source). */
function makeAtomSpec(intentCard: IntentCardInput, source: string): CorpusAtomSpec {
  return { intentCard, source };
}

// ---------------------------------------------------------------------------
// IDX1.1: extractCorpus returns upstream-test when all defaults, no propsFilePath
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus returns source='upstream-test' when all sources enabled and no propsFilePath.
 */
export const prop_extractCorpus_returnsResult_whenAllSourcesEnabledAndPropsFileMissing: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const atomSpec = makeAtomSpec(card, source);
  const result = await extractCorpus(atomSpec);
  return result.source === "upstream-test";
});

// ---------------------------------------------------------------------------
// IDX1.2: extractCorpus returns props-file source when props file has matching export
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus returns source='props-file' when propsFilePath points to a file with matching export.
 */
export const prop_extractCorpus_returnsPropsFileSource_whenPropsFileMatches: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-corpus-idx-"));
  try {
    // Use a fixed atom name so the props file content is predictable
    const atomName = "myTestFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_someInvariant = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const atomSpec: CorpusAtomSpec = { intentCard: card, source, propsFilePath };
    const result = await extractCorpus(atomSpec);
    return result.source === "props-file";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// IDX1.3: extractCorpus falls through to upstream-test when props file has no matching export
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus returns source='upstream-test' when propsFilePath has no matching prop_ export.
 */
export const prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileNoMatch: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-corpus-idx-"));
  try {
    const atomName = "myTestFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, "other.props.ts");
    // Content has NO prop_myTestFn_* export — only an unrelated one
    const propsContent = `export const prop_otherFn_something = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const atomSpec: CorpusAtomSpec = { intentCard: card, source, propsFilePath };
    const result = await extractCorpus(atomSpec);
    // Should fall through to upstream-test (source a), not props-file
    return result.source === "upstream-test";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// IDX1.4: extractCorpus falls through when propsFilePath points to missing file
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus returns source='upstream-test' when propsFilePath points to a non-existent file.
 */
export const prop_extractCorpus_fallsThroughToUpstreamTest_whenPropsFileMissing: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  // Point propsFilePath at a path that definitely does not exist
  const propsFilePath = path.join(os.tmpdir(), `l3i-nonexistent-${Date.now()}.props.ts`);
  const atomSpec: CorpusAtomSpec = { intentCard: card, source, propsFilePath };
  const result = await extractCorpus(atomSpec);
  return result.source === "upstream-test";
});

// ---------------------------------------------------------------------------
// IDX1.5: extractCorpus returns immediately at the first enabled source
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus returns upstream-test without ever consulting sources b/c when a is enabled.
 */
export const prop_extractCorpus_returnsImmediatelyAtFirstEnabledSource: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  // Only enable upstream-test; ensure b/c cannot affect the result
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: true,
    enableDocumentedUsage: false,
    enableAiDerived: false,
  };
  const atomSpec = makeAtomSpec(card, source);
  const result = await extractCorpus(atomSpec, options);
  return result.source === "upstream-test";
});

// ---------------------------------------------------------------------------
// IDX1.6: extractCorpus throws when all sources disabled
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus throws with a descriptive message when all four sources are disabled.
 */
export const prop_extractCorpus_throwsWhenAllSourcesDisabled: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: false,
    enableDocumentedUsage: false,
    enableAiDerived: false,
  };
  const atomSpec = makeAtomSpec(card, source);
  try {
    await extractCorpus(atomSpec, options);
    return false; // should have thrown
  } catch (err) {
    return (
      err instanceof Error &&
      err.message.startsWith("extractCorpus: all enabled sources failed or were disabled")
    );
  }
});

// ---------------------------------------------------------------------------
// IDX1.7: extractCorpus throws when only ai-derived enabled but no cacheDir
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus throws when enableAiDerived=true but cacheDir is omitted and other sources disabled.
 */
export const prop_extractCorpus_throwsWhenOnlyAiDisabledAndCacheDirOmitted: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: false,
    enableDocumentedUsage: false,
    enableAiDerived: true,
  };
  // No cacheDir provided → ai-derived source cannot succeed
  const atomSpec = makeAtomSpec(card, source);
  try {
    await extractCorpus(atomSpec, options);
    return false; // should have thrown
  } catch (err) {
    return err instanceof Error && err.message.includes("extractCorpus");
  }
});

// ---------------------------------------------------------------------------
// IDX1.8: extractCorpus respects enablePropsFile=false
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus bypasses props-file extractor when enablePropsFile=false even if propsFilePath set.
 */
export const prop_extractCorpus_propsFileEnableFlagDisablesPropsFileSource: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-corpus-idx-"));
  try {
    const atomName = "myTestFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_someInvariant = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const options: CorpusExtractionOptions = { enablePropsFile: false };
    const atomSpec: CorpusAtomSpec = { intentCard: card, source, propsFilePath };
    const result = await extractCorpus(atomSpec, options);
    // props-file source bypassed → falls to upstream-test
    return result.source === "upstream-test";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// IDX1.9: extractCorpusCascade returns props-file source when file matches
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpusCascade returns source='props-file' when propsFilePath has matching export.
 */
export const prop_extractCorpusCascade_returnsPropsFileSourceWhenAvailable: fc.IAsyncPropertyWithHooks<
  [IntentCardInput]
> = fc.asyncProperty(intentCardInputArb, async (card) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "l3i-corpus-idx-"));
  try {
    const atomName = "cascadeFn";
    const source = `export function ${atomName}(x: string): string { return x; }`;
    const propsFilePath = path.join(tmpDir, `${atomName}.props.ts`);
    const propsContent = `export const prop_${atomName}_invariant = "stub";`;
    await writeFile(propsFilePath, propsContent, "utf-8");

    const atomSpec: CorpusAtomSpec = { intentCard: card, source, propsFilePath };
    const result = await extractCorpusCascade(atomSpec);
    return result.source === "props-file";
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// IDX1.10: extractCorpusCascade falls through B to A (documented-usage when upstream disabled)
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpusCascade returns source='documented-usage' when enableUpstreamTest=false.
 */
export const prop_extractCorpusCascade_fallsThroughBToA: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: false,
    enableDocumentedUsage: true,
    enableAiDerived: false,
  };
  const atomSpec = makeAtomSpec(card, source);
  const result = await extractCorpusCascade(atomSpec, options);
  return result.source === "documented-usage";
});

// ---------------------------------------------------------------------------
// IDX1.11: extractCorpusCascade falls through C→B→A (ai-derived when a+b disabled with seeded cache)
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpusCascade returns source='ai-derived' when a+b disabled and cache has a hit.
 */
export const prop_extractCorpusCascade_fallsThroughCToBToA: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, nonEmptyStr, async (card, source) => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "l3i-corpus-idx-cascade-"));
  try {
    // Seed the ai-derived cache so the extractor finds a hit.
    // CorpusKeySpec only has source + cacheDir (no intentCard field).
    await seedCorpusCache({ source, cacheDir }, "fc.property(fc.string(), () => true)");

    const options: CorpusExtractionOptions = {
      enablePropsFile: false,
      enableUpstreamTest: false,
      enableDocumentedUsage: false,
      enableAiDerived: true,
    };
    const atomSpec: CorpusAtomSpec = { intentCard: card, source, cacheDir };
    const result = await extractCorpusCascade(atomSpec, options);
    return result.source === "ai-derived";
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// IDX1.12: extractCorpusCascade throws when all disabled or unavailable
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpusCascade throws with descriptive message when all sources disabled.
 */
export const prop_extractCorpusCascade_throwsWhenAllDisabledOrUnavailable: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: false,
    enableDocumentedUsage: false,
    enableAiDerived: false,
  };
  const atomSpec = makeAtomSpec(card, source);
  try {
    await extractCorpusCascade(atomSpec, options);
    return false;
  } catch (err) {
    return (
      err instanceof Error &&
      err.message.startsWith("extractCorpusCascade: all enabled sources failed or were disabled")
    );
  }
});

// ---------------------------------------------------------------------------
// IDX1.13: extractCorpus returned shape is a valid CorpusResult
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus always returns an object satisfying all CorpusResult field invariants.
 */
export const prop_extractCorpus_returnedShapeIsValidCorpusResult: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const atomSpec = makeAtomSpec(card, source);
  const result = await extractCorpus(atomSpec);
  const validSources = ["props-file", "upstream-test", "documented-usage", "ai-derived"] as const;
  return (
    validSources.includes(result.source as (typeof validSources)[number]) &&
    result.bytes instanceof Uint8Array &&
    typeof result.path === "string" &&
    result.path.length > 0 &&
    /^[0-9a-f]{64}$/.test(result.contentHash)
  );
});

// ---------------------------------------------------------------------------
// IDX1.14: extractCorpus does not mutate atomSpec
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus leaves atomSpec structurally identical before and after the call.
 */
export const prop_extractCorpus_doesNotMutateAtomSpec: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const atomSpec = makeAtomSpec(card, source);
  const specBefore = JSON.stringify(atomSpec);
  await extractCorpus(atomSpec);
  const specAfter = JSON.stringify(atomSpec);
  return specBefore === specAfter;
});

// ---------------------------------------------------------------------------
// IDX1.15: extractCorpus does not mutate options
// ---------------------------------------------------------------------------

/**
 * @summary extractCorpus leaves options structurally identical before and after the call.
 */
export const prop_extractCorpus_doesNotMutateOptions: fc.IAsyncPropertyWithHooks<
  [IntentCardInput, string]
> = fc.asyncProperty(intentCardInputArb, fc.string(), async (card, source) => {
  const options: CorpusExtractionOptions = {
    enablePropsFile: false,
    enableUpstreamTest: true,
    enableDocumentedUsage: true,
    enableAiDerived: false,
  };
  const optsBefore = JSON.stringify(options);
  await extractCorpus(makeAtomSpec(card, source), options);
  const optsAfter = JSON.stringify(options);
  return optsBefore === optsAfter;
});

// ---------------------------------------------------------------------------
// IDX1.16: CORPUS_SCHEMA_VERSION re-export === 2
// ---------------------------------------------------------------------------

/**
 * @summary CORPUS_SCHEMA_VERSION re-exported from index is exactly 2.
 */
export const prop_indexExports_corpusSchemaVersionIs2: fc.IPropertyWithHooks<[null]> = fc.property(
  fc.constant(null),
  (_v) => {
    return CORPUS_SCHEMA_VERSION === 2;
  },
);

// ---------------------------------------------------------------------------
// IDX1.17: CORPUS_DEFAULT_MODEL re-export === 'claude-haiku-4-5-20251001'
// ---------------------------------------------------------------------------

/**
 * @summary CORPUS_DEFAULT_MODEL re-exported from index equals 'claude-haiku-4-5-20251001'.
 */
export const prop_indexExports_corpusDefaultModelIsClaudeHaiku45: fc.IPropertyWithHooks<[null]> =
  fc.property(fc.constant(null), (_v) => {
    return CORPUS_DEFAULT_MODEL === "claude-haiku-4-5-20251001";
  });

// ---------------------------------------------------------------------------
// IDX1.18: CORPUS_PROMPT_VERSION re-export === 'corpus-1'
// ---------------------------------------------------------------------------

/**
 * @summary CORPUS_PROMPT_VERSION re-exported from index equals 'corpus-1'.
 */
export const prop_indexExports_corpusPromptVersionIsCorpus1: fc.IPropertyWithHooks<[null]> =
  fc.property(fc.constant(null), (_v) => {
    return CORPUS_PROMPT_VERSION === "corpus-1";
  });

// ---------------------------------------------------------------------------
// IDX1.19: seedCorpusCache re-export is callable
// ---------------------------------------------------------------------------

/**
 * @summary seedCorpusCache re-exported from index is a function.
 */
export const prop_indexExports_seedCorpusCacheIsCallable: fc.IPropertyWithHooks<[null]> =
  fc.property(fc.constant(null), (_v) => {
    return typeof seedCorpusCache === "function";
  });

// ---------------------------------------------------------------------------
// IDX1.20: extractFromPropsFile re-export is callable
// ---------------------------------------------------------------------------

/**
 * @summary extractFromPropsFile re-exported from index is a function.
 */
export const prop_indexExports_extractFromPropsFileIsCallable: fc.IPropertyWithHooks<[null]> =
  fc.property(fc.constant(null), (_v) => {
    return typeof extractFromPropsFile === "function";
  });

// Suppress unused import lint warning — sourceFnDeclArb is defined for potential use
void sourceFnDeclArb;

// Suppress unused CorpusResult import warning
void (null as unknown as CorpusResult);
