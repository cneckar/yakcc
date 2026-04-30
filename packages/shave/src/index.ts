// @decision DEC-CONTINUOUS-SHAVE-022: Public API entry point for @yakcc/shave.
// Three exported entry points: shave() (one-shot file), universalize()
// (single-block continuous), createIntentExtractionHook() (hookable pipeline).
// extractIntent is intentionally NOT exported — it is an internal detail
// that WI-010-02 will wire to the Anthropic SDK.
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
// Sentinel IntentCard used by WI-010-01 stubs
// ---------------------------------------------------------------------------

// These imports are type-only; actual values are assembled below.
import type {
  CandidateBlock,
  IntentExtractionHook,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  UniversalizeResult,
} from "./types.js";

/** @internal Sentinel IntentCard returned by stubs until WI-010-02 lands. */
function makeSentinelIntentCard() {
  return {
    schemaVersion: 1 as const,
    behavior: "<wi-010-02 stub: extractIntent not yet wired>",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["This sentinel is returned by the WI-010-01 skeleton stub."],
    modelVersion: "stub",
    promptVersion: "stub",
    sourceHash: "0".repeat(64),
    extractedAt: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// universalize() — single-block stub
// ---------------------------------------------------------------------------

/**
 * Process a single candidate block through the universalization pipeline.
 *
 * WI-010-01 stub: returns an empty slice plan and no matched primitives.
 * The intentCard is a sentinel value; WI-010-02 wires the real extractIntent.
 */
export async function universalize(
  candidate: CandidateBlock,
  _registry: ShaveRegistryView,
  _options?: ShaveOptions,
): Promise<UniversalizeResult> {
  return {
    intentCard: makeSentinelIntentCard(),
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
 * @param registry - Registry view used for block lookups.
 * @param options - Optional configuration overrides.
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
// createIntentExtractionHook() — factory stub
// ---------------------------------------------------------------------------

/**
 * Create the default IntentExtractionHook.
 *
 * WI-010-01 stub: the hook's `intercept` method delegates to universalize(),
 * which itself returns a sentinel. WI-010-02 replaces the inner universalize
 * call with a real extractIntent invocation backed by the Anthropic SDK.
 */
export function createIntentExtractionHook(_options?: ShaveOptions): IntentExtractionHook {
  return {
    id: "yakcc.shave.default",
    intercept: (candidate: CandidateBlock, registry: ShaveRegistryView, options?: ShaveOptions) =>
      universalize(candidate, registry, options),
  };
}
