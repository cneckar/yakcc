// @decision DEC-CONTINUOUS-SHAVE-022: Public API entry point for @yakcc/shave.
// Three exported entry points: shave() (one-shot file), universalize()
// (single-block continuous), createIntentExtractionHook() (hookable pipeline).
// extractIntent is intentionally NOT exported — it is an internal detail.
// WI-010-03: universalize is now wired to the live extractIntent path.
// The sentinel IntentCard from WI-010-01 is removed.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Keeping extractIntent internal ensures callers depend only on
// the stable public surface; the extraction implementation can evolve freely.

// ---------------------------------------------------------------------------
// Re-exports — public type surface
// ---------------------------------------------------------------------------

export type {
  CandidateBlock,
  IntentExtractionHook,
  ShaveDiagnostics,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  ShavedAtomStub,
  UniversalizeResult,
  UniversalizeSlicePlanEntry,
} from "./types.js";

export type { IntentCard, IntentParam } from "./intent/types.js";

// ---------------------------------------------------------------------------
// Re-exports — WI-010-02 public surface
// ---------------------------------------------------------------------------

// Validator — callers that receive an IntentCard from an external source can
// call this to verify it conforms to the current schema before use.
export { validateIntentCard } from "./intent/validate-intent-card.js";

// Error classes — exported as named classes so callers can use instanceof.
export {
  AnthropicApiKeyMissingError,
  IntentCardSchemaError,
  OfflineCacheMissError,
} from "./errors.js";

// Version constants — exported so callers can introspect the cache keying
// policy and detect when their cached results were produced by a different
// model or prompt version.
export { DEFAULT_MODEL, INTENT_PROMPT_VERSION, INTENT_SCHEMA_VERSION } from "./intent/constants.js";

// extractIntent is NOT exported — it remains an internal implementation detail.

// ---------------------------------------------------------------------------
// Re-exports — WI-012-03 atom-test public surface
// ---------------------------------------------------------------------------

// isAtom predicate — the gate for the WI-012 universalizer recursion.
export { isAtom } from "./universalize/atom-test.js";
export type { AtomTestOptions, AtomTestResult, AtomTestReason } from "./universalize/types.js";

// ---------------------------------------------------------------------------
// Internal imports
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { DEFAULT_MODEL, INTENT_PROMPT_VERSION } from "./intent/constants.js";
import { extractIntent } from "./intent/extract.js";
import { locateProjectRoot } from "./locate-root.js";
import type {
  CandidateBlock,
  IntentExtractionHook,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  UniversalizeResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// universalize() — wired to extractIntent (WI-010-03)
// ---------------------------------------------------------------------------

/**
 * Process a single candidate block through the universalization pipeline.
 *
 * WI-010-03: wired to the live extractIntent path. Requires either:
 *   - ANTHROPIC_API_KEY set in the environment, OR
 *   - options.offline === true with a pre-populated cache entry.
 *
 * Throws AnthropicApiKeyMissingError if neither condition is met.
 * Throws OfflineCacheMissError if offline mode is set and the cache has no entry.
 *
 * slicePlan and matchedPrimitives remain empty stubs until WI-012 and WI-011
 * respectively.
 *
 * @param candidate - The source block to universalize.
 * @param _registry - Registry view (unused until WI-011 variance scoring).
 * @param options - Optional configuration: cacheDir, model, offline.
 */
export async function universalize(
  candidate: CandidateBlock,
  _registry: ShaveRegistryView,
  options?: ShaveOptions,
): Promise<UniversalizeResult> {
  const projectRoot = await locateProjectRoot();
  const cacheDir = options?.cacheDir ?? join(projectRoot, ".yakcc", "shave-cache", "intent");

  const intentCard = await extractIntent(candidate.source, {
    model: options?.model ?? DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    cacheDir,
    offline: options?.offline,
  });

  return {
    intentCard,
    slicePlan: [],
    matchedPrimitives: [],
    diagnostics: {
      stubbed: ["decomposition", "variance", "license-gate"],
      cacheHits: 0,
      cacheMisses: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// shave() — one-shot file stub
// ---------------------------------------------------------------------------

/**
 * Process a source file through the full shave pipeline.
 *
 * WI-010-01 stub: returns empty atoms and intent cards. The diagnostics
 * `stubbed` field lists all capabilities pending implementation.
 *
 * @param sourcePath - Absolute path to the source file to process.
 * @param _registry - Registry view used for block lookups.
 * @param _options - Optional configuration overrides.
 */
export async function shave(
  sourcePath: string,
  _registry: ShaveRegistryView,
  _options?: ShaveOptions,
): Promise<ShaveResult> {
  return {
    sourcePath,
    atoms: [],
    intentCards: [],
    diagnostics: {
      stubbed: ["decomposition", "variance", "license-gate"],
      cacheHits: 0,
      cacheMisses: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// createIntentExtractionHook() — factory
// ---------------------------------------------------------------------------

/**
 * Create the default IntentExtractionHook.
 *
 * The hook's `intercept` method delegates to universalize(), which in
 * WI-010-03 is wired to the live extractIntent path.
 */
export function createIntentExtractionHook(_options?: ShaveOptions): IntentExtractionHook {
  return {
    id: "yakcc.shave.default",
    intercept: (candidate: CandidateBlock, registry: ShaveRegistryView, options?: ShaveOptions) =>
      universalize(candidate, registry, options),
  };
}
