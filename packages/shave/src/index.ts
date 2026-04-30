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
  LicenseRefusedError,
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
// Re-exports — WI-012-04 decomposition recursion public surface
// ---------------------------------------------------------------------------

export {
  decompose,
  DidNotReachAtomError,
  RecursionDepthExceededError,
} from "./universalize/recursion.js";
export type {
  RecursionNode,
  AtomLeaf,
  BranchNode,
  RecursionTree,
  RecursionOptions,
} from "./universalize/types.js";

// ---------------------------------------------------------------------------
// Re-exports — WI-012-05 DFG slicer public surface
// ---------------------------------------------------------------------------

export { slice } from "./universalize/slicer.js";
export type {
  SlicePlan,
  SlicePlanEntry,
  PointerEntry,
  NovelGlueEntry,
} from "./universalize/types.js";

// ---------------------------------------------------------------------------
// Re-exports — WI-013-01 license gate public surface
// ---------------------------------------------------------------------------

export { detectLicense } from "./license/detector.js";
export { licenseGate } from "./license/gate.js";
export type {
  AcceptedLicense,
  LicenseDetection,
  LicenseGateResult,
} from "./license/types.js";

// ---------------------------------------------------------------------------
// Internal imports
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { LicenseRefusedError } from "./errors.js";
import { DEFAULT_MODEL, INTENT_PROMPT_VERSION } from "./intent/constants.js";
import { extractIntent } from "./intent/extract.js";
import { detectLicense } from "./license/detector.js";
import { licenseGate } from "./license/gate.js";
import { locateProjectRoot } from "./locate-root.js";
import type {
  CandidateBlock,
  IntentExtractionHook,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  UniversalizeResult,
} from "./types.js";
import { decompose } from "./universalize/recursion.js";
import { slice } from "./universalize/slicer.js";
import type { NovelGlueEntry, SlicePlanEntry } from "./universalize/types.js";

// ---------------------------------------------------------------------------
// universalize() — wired to extractIntent + decompose + slice (WI-012-06)
// ---------------------------------------------------------------------------

/**
 * @decision DEC-UNIVERSALIZE-WIRING-001
 * title: universalize() wired to decompose() + slice() (WI-012-06)
 * status: decided
 * rationale: WI-012-04 landed decompose() and WI-012-05 landed slice(). This
 * work item replaces the stubs in universalize() with real calls. The pipeline
 * is: extractIntent (for intentCard) → decompose (for RecursionTree) → slice
 * (for SlicePlan). Both decomposition errors (DidNotReachAtomError and
 * RecursionDepthExceededError) are propagated unwrapped — they are load-bearing
 * reviewer-gate failures per DEC-RECURSION-005.
 *
 * Intent card attachment: for single-leaf trees (root is an AtomLeaf), the
 * extracted intent card is attached to the one NovelGlueEntry that covers the
 * root. For multi-leaf trees, per-leaf intent extraction would require calling
 * extractIntent once per leaf — this is deferred to a future work item. Entries
 * for non-root leaves are emitted without an intentCard (the field is optional).
 * TODO(future-WI): call extractIntent per leaf and populate intentCard on each
 * NovelGlueEntry for multi-leaf trees.
 *
 * "decomposition" is removed from diagnostics.stubbed — decomposition is now
 * live. "variance" and "license-gate" remain stubbed (WI-013/014).
 *
 * @decision DEC-LICENSE-WIRING-002
 * title: License gate runs first in universalize() (WI-013-02)
 * status: decided
 * rationale:
 *   - The gate is cheap (pure string scan, no I/O) and fail-fast: refusing a
 *     copyleft candidate before any extractIntent or decompose() call avoids
 *     wasted API quota and computation.
 *   - A single source check on candidate.source covers all leaves: every leaf
 *     produced by decompose() derives from the same source string, so re-checking
 *     per-leaf would be redundant and would not change the gate outcome.
 *   - The gate is the second-line defense; detectLicense() is the first signal.
 *     LicenseRefusedError carries the LicenseDetection so callers can introspect
 *     why the candidate was refused.
 *   - "license-gate" is removed from diagnostics.stubbed now that this gate is live.
 *
 * Process a single candidate block through the universalization pipeline.
 *
 * WI-012-06: wired to decompose() + slice() in addition to extractIntent.
 * WI-013-02: license gate runs before intent extraction (fail-fast, cheap).
 * Requires either:
 *   - ANTHROPIC_API_KEY set in the environment, OR
 *   - options.offline === true with a pre-populated cache entry.
 *
 * Throws LicenseRefusedError if the candidate's source carries a refused license.
 * Throws AnthropicApiKeyMissingError if neither condition is met.
 * Throws OfflineCacheMissError if offline mode is set and the cache has no entry.
 * Throws DidNotReachAtomError if decomposition cannot reach atomic leaves.
 * Throws RecursionDepthExceededError if the source AST exceeds maxDepth.
 *
 * @param candidate - The source block to universalize.
 * @param registry  - Registry view used by decompose() and slice() for
 *                    known-primitive lookups via findByCanonicalAstHash.
 * @param options   - Optional configuration: cacheDir, model, offline.
 */
export async function universalize(
  candidate: CandidateBlock,
  registry: ShaveRegistryView,
  options?: ShaveOptions,
): Promise<UniversalizeResult> {
  const projectRoot = await locateProjectRoot();
  const cacheDir = options?.cacheDir ?? join(projectRoot, ".yakcc", "shave-cache", "intent");

  // Step 1: license gate — cheap, fail-fast, runs before any I/O.
  // Per DEC-LICENSE-WIRING-002: one check on the full source string covers all
  // leaves because every leaf derives from the same source text.
  const detection = detectLicense(candidate.source);
  const gateResult = licenseGate(detection);
  if (!gateResult.accepted) {
    throw new LicenseRefusedError(gateResult.reason, detection);
  }

  // Step 2: extract intent card (unchanged from WI-010-03).
  const intentCard = await extractIntent(candidate.source, {
    model: options?.model ?? DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    cacheDir,
    offline: options?.offline,
  });

  // Step 3: decompose source into a RecursionTree.
  // DidNotReachAtomError and RecursionDepthExceededError propagate unwrapped —
  // per DEC-RECURSION-005, these are load-bearing reviewer-gate failures.
  const tree = await decompose(candidate.source, registry, options?.recursionOptions);

  // Step 4: slice the RecursionTree into a SlicePlan.
  const plan = await slice(tree, registry);

  // Step 5: attach intentCard to root NovelGlueEntry for single-leaf trees.
  // For multi-leaf trees, per-leaf intent extraction is deferred (see @decision
  // DEC-UNIVERSALIZE-WIRING-001 above). The intentCard field on NovelGlueEntry
  // is optional, so entries for non-root leaves are emitted as-is.
  let slicePlan: readonly SlicePlanEntry[];
  const firstEntry = plan.entries[0];
  if (tree.leafCount === 1 && plan.entries.length === 1 && firstEntry !== undefined) {
    if (firstEntry.kind === "novel-glue") {
      // Single AtomLeaf, no registry match: attach the root intentCard.
      const withCard: NovelGlueEntry = {
        kind: firstEntry.kind,
        sourceRange: firstEntry.sourceRange,
        source: firstEntry.source,
        canonicalAstHash: firstEntry.canonicalAstHash,
        intentCard,
      };
      slicePlan = [withCard];
    } else {
      // Single AtomLeaf matched the registry (PointerEntry) — no intentCard slot.
      slicePlan = plan.entries;
    }
  } else {
    // Multi-leaf tree: pass entries through unchanged.
    // Per-leaf intentCard attachment is future work (see @decision above).
    slicePlan = plan.entries;
  }

  return {
    intentCard,
    slicePlan,
    matchedPrimitives: plan.matchedPrimitives,
    licenseDetection: detection,
    diagnostics: {
      // "decomposition" removed — decompose() is now live (WI-012-06).
      // "license-gate" removed — gate is now live (WI-013-02).
      // "variance" remains stubbed (WI-014).
      stubbed: ["variance"],
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
