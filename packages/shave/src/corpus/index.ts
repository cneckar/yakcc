// @decision DEC-CORPUS-001 (see corpus/types.ts)
// title: extractCorpus() implements a three-source priority chain for property-test corpus
// status: decided (WI-016)
// rationale:
//   Priority order: upstream-test (a) > documented-usage (b) > ai-derived (c).
//   The highest-priority source that succeeds (produces non-empty bytes) wins;
//   lower-priority sources are not consulted. This ensures that the cheapest,
//   most deterministic source is always preferred.
//
//   "Succeeds" means: the extractor returns a CorpusResult without throwing.
//   Sources (a) and (b) are pure functions and always succeed (they degrade
//   gracefully to behavior-only stubs). Source (c) returns undefined on a cache
//   miss and is only attempted when cacheDir is provided.
//
//   DEC-SHAVE-002 offline discipline: sources (a) and (b) work without API key.
//   Source (c) reads from cache only in unit tests; live AI calls are never made
//   in the test suite.
//
//   The CorpusResult from whichever source wins is the single artifact referenced
//   by the ProofManifest. Multiple property checks are bundled into one file —
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

import { extractFromAiDerivedCached } from "./ai-derived.js";
import { extractFromDocumentedUsage } from "./documented-usage.js";
import type { CorpusAtomSpec, CorpusExtractionOptions, CorpusResult } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";

/**
 * Extract a property-test corpus for an atom using a three-source priority chain.
 *
 * Priority order (highest to lowest):
 *   (a) upstream-test adaptation — deterministic, derived from IntentCard spec fields.
 *   (b) documented-usage synthesis — deterministic, derived from JSDoc @example blocks.
 *   (c) ai-derived synthesis — cache-backed, requires cacheDir; offline-only in tests.
 *
 * The first source that successfully produces a result wins. Sources (a) and (b) are
 * always attempted because they are pure functions that never fail. Source (c) is
 * only attempted when `atomSpec.cacheDir` is provided and the cache contains a warm
 * entry (no live AI calls are made in unit tests per DEC-SHAVE-002).
 *
 * The returned CorpusResult bundles all property checks into a single fast-check file.
 * This satisfies the L0 manifest constraint of exactly one "property_tests" artifact
 * (validateProofManifestL0).
 *
 * @param atomSpec - Atom description: source text, IntentCard, optional cacheDir.
 * @param options  - Optional source-enable flags. Default: all sources enabled.
 * @returns A CorpusResult from the highest-priority available source.
 * @throws Error if all enabled sources are disabled or all fail (should not happen
 *         in practice because sources (a) and (b) are always available).
 */
export async function extractCorpus(
  atomSpec: CorpusAtomSpec,
  options?: CorpusExtractionOptions,
): Promise<CorpusResult> {
  const enableA = options?.enableUpstreamTest ?? true;
  const enableB = options?.enableDocumentedUsage ?? true;
  const enableC = options?.enableAiDerived ?? true;

  // Source (a): upstream-test adaptation.
  // Always succeeds (pure, deterministic). Attempted first.
  if (enableA) {
    const result = extractFromUpstreamTest(atomSpec.intentCard, atomSpec.source);
    return result;
  }

  // Source (b): documented-usage synthesis.
  // Always succeeds (pure, deterministic). Attempted second.
  if (enableB) {
    const result = extractFromDocumentedUsage(atomSpec.intentCard, atomSpec.source);
    return result;
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
 * Unlike extractCorpus(), which returns the first enabled source immediately, this
 * function implements a true cascade:
 *
 *   if (a enabled and succeeds) → return a
 *   else if (b enabled and succeeds) → return b
 *   else if (c enabled and cache hit) → return c
 *   else throw
 *
 * Sources (a) and (b) always "succeed" (they are pure functions), so in practice
 * the cascade only reaches (c) when (a) and (b) are explicitly disabled.
 *
 * @param atomSpec - Atom description: source text, IntentCard, optional cacheDir.
 * @param options  - Optional source-enable flags. Default: all sources enabled.
 * @returns A CorpusResult from the highest-priority available source.
 */
export async function extractCorpusCascade(
  atomSpec: CorpusAtomSpec,
  options?: CorpusExtractionOptions,
): Promise<CorpusResult> {
  const enableA = options?.enableUpstreamTest ?? true;
  const enableB = options?.enableDocumentedUsage ?? true;
  const enableC = options?.enableAiDerived ?? true;

  // Source (a): upstream-test adaptation (always succeeds when enabled).
  if (enableA) {
    return extractFromUpstreamTest(atomSpec.intentCard, atomSpec.source);
  }

  // Source (b): documented-usage synthesis (always succeeds when enabled).
  if (enableB) {
    return extractFromDocumentedUsage(atomSpec.intentCard, atomSpec.source);
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
