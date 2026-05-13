// SPDX-License-Identifier: MIT
// @decision DEC-CORPUS-001 (see corpus/types.ts)
// title: extractCorpus() implements a four-source priority chain for property-test corpus
// status: decided (WI-016, extended WI-V2-07-L8, revised WI-376)
// rationale:
//   Priority order: props-file (0) > upstream-test (a) > documented-usage (b) > ai-derived (c).
//   The highest-priority source that succeeds (produces non-empty bytes) wins;
//   lower-priority sources are not consulted. This ensures that the cheapest,
//   most deterministic source is always preferred.
//
//   Source (0) props-file: hand-authored sibling *.props.ts file. Attempted only when
//   CorpusAtomSpec.propsFilePath is set. Returns undefined when no matching prop_<atom>_*
//   export is found, falling through to source (a).
//
//   "Succeeds" means: the extractor returns a CorpusResult without throwing.
//   Source (a) is a pure function and always succeeds. Source (b) may return
//   undefined (loud refusal per DEC-PROPTEST-DOCUMENTED-USAGE-001) when no
//   parseable @example assertion can be derived; in that case it falls through to (c).
//   Source (c) returns undefined on a cache miss and is only attempted when cacheDir
//   is provided.
//
//   DEC-SHAVE-002 offline discipline: sources (0), (a) and (b) work without API key.
//   Source (c) reads from cache only in unit tests; live AI calls are never made
//   in the test suite.
//
//   The CorpusResult from whichever source wins is the single artifact referenced
//   by the ProofManifest. Multiple property checks are bundled into one file --
//   no multiple manifest entries.

export type {
  CorpusResult,
  CorpusSource,
  CorpusAtomSpec,
  CorpusExtractionOptions,
} from "./types.js";
export {
  seedCorpusCache,
  CORPUS_SCHEMA_VERSION,
  CORPUS_DEFAULT_MODEL,
  CORPUS_PROMPT_VERSION,
} from "./ai-derived.js";

export { extractFromPropsFile } from "./props-file.js";

import { extractFromAiDerivedCached } from "./ai-derived.js";
import { extractFromDocumentedUsage } from "./documented-usage.js";
import { extractFromPropsFile } from "./props-file.js";
import type { CorpusAtomSpec, CorpusExtractionOptions, CorpusResult } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";

/**
 * Extract a property-test corpus for an atom using a four-source priority chain.
 *
 * Priority order (highest to lowest):
 *   (0) props-file — hand-authored sibling *.props.ts (highest priority; optional).
 *   (a) upstream-test adaptation — deterministic, derived from IntentCard spec fields.
 *   (b) documented-usage synthesis — deterministic, derived from JSDoc @example blocks.
 *       Returns undefined (loud refusal) when no parseable assertion can be derived.
 *   (c) ai-derived synthesis — cache-backed, requires cacheDir; offline-only in tests.
 *
 * Source (a) always produces a result. Source (b) may refuse (return undefined) when no
 * @example block in the source is parseable into a real assertion
 * (per DEC-PROPTEST-DOCUMENTED-USAGE-001). When (b) refuses, the chain falls through
 * to (c). This prevents hollow placeholder tests from entering the proof manifest.
 *
 * The returned CorpusResult bundles all property checks into a single fast-check file.
 * This satisfies the L0 manifest constraint of exactly one "property_tests" artifact
 * (validateProofManifestL0).
 *
 * @param atomSpec - Atom description: source text, IntentCard, optional cacheDir.
 * @param options  - Optional source-enable flags. Default: all sources enabled.
 * @returns A CorpusResult from the highest-priority available source.
 * @throws Error if all enabled sources are disabled or all fail.
 */
export async function extractCorpus(
  atomSpec: CorpusAtomSpec,
  options?: CorpusExtractionOptions,
): Promise<CorpusResult> {
  const enableProps = options?.enablePropsFile ?? true;
  const enableA = options?.enableUpstreamTest ?? true;
  const enableB = options?.enableDocumentedUsage ?? true;
  const enableC = options?.enableAiDerived ?? true;

  // Source (0): props-file -- hand-authored sibling *.props.ts corpus.
  // Highest priority. Only attempted when propsFilePath is provided.
  // Returns undefined when no matching prop_<atom>_* export is found,
  // in which case the chain falls through to source (a).
  if (enableProps && atomSpec.propsFilePath !== undefined) {
    const result = await extractFromPropsFile(
      atomSpec.propsFilePath,
      atomSpec.intentCard,
      atomSpec.source,
    );
    if (result !== undefined) {
      return result;
    }
  }

  // Source (a): upstream-test adaptation.
  // Always succeeds (pure, deterministic). Attempted first among generated sources.
  if (enableA) {
    const result = extractFromUpstreamTest(atomSpec.intentCard, atomSpec.source);
    return result;
  }

  // Source (b): documented-usage synthesis.
  // May return undefined (loud refusal) when no @example block is parseable into a
  // real assertion (DEC-PROPTEST-DOCUMENTED-USAGE-001). Fall through to (c) on refusal.
  if (enableB) {
    const result = extractFromDocumentedUsage(atomSpec.intentCard, atomSpec.source);
    if (result !== undefined) {
      return result;
    }
  }

  // Source (c): AI-derived synthesis.
  // Only attempted when cacheDir is provided. Returns undefined on cache miss.
  if (enableC && atomSpec.cacheDir !== undefined) {
    const result = await extractFromAiDerivedCached(
      atomSpec.intentCard,
      atomSpec.source,
      atomSpec.cacheDir,
    );
    if (result !== undefined) {
      return result;
    }
  }

  throw new Error(
    "extractCorpus: all enabled sources failed or were disabled. " +
      "Ensure at least one of enableUpstreamTest, enableDocumentedUsage, or enableAiDerived is true " +
      "and that cacheDir is provided for the ai-derived source.",
  );
}

/**
 * Extract corpus using the full priority chain including fallback from (a) to (b) to (c).
 *
 * This variant attempts all enabled sources in priority order and falls through to the
 * next source when a higher-priority source is explicitly disabled or unavailable.
 *
 * Source (b) may now also refuse (return undefined per DEC-PROPTEST-DOCUMENTED-USAGE-001)
 * when no @example block is parseable; in that case the cascade continues to (c).
 *
 * True cascade behaviour:
 *   if (props-file enabled and matches) -> return props-file
 *   else if (a enabled) -> return a
 *   else if (b enabled and produces real assertions) -> return b
 *   else if (c enabled and cache hit) -> return c
 *   else throw
 *
 * @param atomSpec - Atom description: source text, IntentCard, optional cacheDir.
 * @param options  - Optional source-enable flags. Default: all sources enabled.
 * @returns A CorpusResult from the highest-priority available source.
 */
export async function extractCorpusCascade(
  atomSpec: CorpusAtomSpec,
  options?: CorpusExtractionOptions,
): Promise<CorpusResult> {
  const enableProps = options?.enablePropsFile ?? true;
  const enableA = options?.enableUpstreamTest ?? true;
  const enableB = options?.enableDocumentedUsage ?? true;
  const enableC = options?.enableAiDerived ?? true;

  // Source (0): props-file -- highest priority when propsFilePath is set.
  if (enableProps && atomSpec.propsFilePath !== undefined) {
    const result = await extractFromPropsFile(
      atomSpec.propsFilePath,
      atomSpec.intentCard,
      atomSpec.source,
    );
    if (result !== undefined) {
      return result;
    }
  }

  // Source (a): upstream-test adaptation (always succeeds when enabled).
  if (enableA) {
    return extractFromUpstreamTest(atomSpec.intentCard, atomSpec.source);
  }

  // Source (b): documented-usage synthesis.
  // May return undefined (loud refusal per DEC-PROPTEST-DOCUMENTED-USAGE-001).
  if (enableB) {
    const result = extractFromDocumentedUsage(atomSpec.intentCard, atomSpec.source);
    if (result !== undefined) {
      return result;
    }
  }

  // Source (c): AI-derived synthesis (cache-only in tests).
  if (enableC && atomSpec.cacheDir !== undefined) {
    const result = await extractFromAiDerivedCached(
      atomSpec.intentCard,
      atomSpec.source,
      atomSpec.cacheDir,
    );
    if (result !== undefined) {
      return result;
    }
  }

  throw new Error(
    "extractCorpusCascade: all enabled sources failed or were disabled. " +
      "Ensure at least one source is enabled and available.",
  );
}
