// @decision DEC-CONTINUOUS-SHAVE-022: Public API entry point for @yakcc/shave.
// Three exported entry points: shave() (one-shot file), universalize()
// (single-block continuous), createIntentExtractionHook() (hookable pipeline).
// extractIntent is intentionally NOT exported — it is an internal detail.
// WI-010-03: universalize is now wired to the live extractIntent path.
// The sentinel IntentCard from WI-010-01 is removed.
// WI-018: seedIntentCache() is a public test-helper that writes an IntentCard
// into the file-system cache via the same key-derivation path as extractIntent.
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
// Re-exports — WI-018 public test-helper surface
// ---------------------------------------------------------------------------

/**
 * @decision DEC-SHAVE-SEED-001
 * title: seedIntentCache is a public test-helper export on the main entry point
 * status: decided (WI-018)
 * rationale:
 *   External consumers (e.g. @yakcc/compile tests) need to pre-populate the
 *   intent-extraction cache for offline testing without calling the Anthropic
 *   API. Before WI-018, tests reached into @yakcc/shave/dist/cache/file-cache.js
 *   directly, which is an unstable internal path not in the package exports map.
 *
 *   Design constraints (from DEC-SHAVE-003, Sacred Practice #12):
 *   - seedIntentCache MUST use the same BLAKE3-based key derivation as
 *     extractIntent (sourceHash → keyFromIntentInputs). It MUST NOT compute the
 *     key itself or accept a pre-computed key.
 *   - seedIntentCache MUST delegate to writeIntent for the actual cache write.
 *     No parallel cache-write logic, no separate cache directory, no alternative
 *     serialization format.
 *   - DEC-SHAVE-002 offline discipline: loading @yakcc/shave and calling
 *     seedIntentCache MUST work in the unit-test runner without an
 *     ANTHROPIC_API_KEY environment variable. This function is offline-only —
 *     it performs no LLM call and MUST NOT trigger the SDK import path.
 *
 *   Placement: on the main entry (not a sub-path like @yakcc/shave/test-helpers)
 *   so there is one public contract for external callers. The function is
 *   clearly named and typed as a test helper; production code should never
 *   call it because it writes to the cache from an externally-supplied card
 *   rather than from a live extraction.
 */

/**
 * Inputs that identify a cache slot for intent extraction.
 *
 * These mirror the ExtractIntentContext fields that feed into key derivation
 * (sourceHash → keyFromIntentInputs). Callers supply `source` (the raw source
 * text) and `cacheDir`; `model` and `promptVersion` default to the package
 * constants so the seeded key matches what extractIntent would produce under
 * the same defaults.
 */
export interface SeedIntentSpec {
  /** The raw source text whose BLAKE3 hash is the first key component. */
  readonly source: string;
  /** Root cache directory — must match the cacheDir used in the test's ShaveOptions. */
  readonly cacheDir: string;
  /** Anthropic model tag. Defaults to DEFAULT_MODEL when omitted. */
  readonly model?: string | undefined;
  /** Prompt version tag. Defaults to INTENT_PROMPT_VERSION when omitted. */
  readonly promptVersion?: string | undefined;
}

/**
 * Write an IntentCard into the file-system intent cache under the key that
 * extractIntent() would produce for the same source+model+promptVersion inputs.
 *
 * **Test-helper only.** Do NOT call from production code. Production intent
 * cards are written exclusively by extractIntent() after a live API round-trip;
 * bypassing that path in production would produce unvalidated cache entries.
 *
 * Key derivation (DEC-SHAVE-003):
 *   cacheKey = BLAKE3(sourceHash || \x00 || modelTag || \x00 || promptVersion || \x00 || schemaVersion)
 * where sourceHash = BLAKE3(normalize(spec.source)).
 * This is identical to the key extractIntent() would derive for the same inputs.
 *
 * @param spec - Source text and cache location; identifies the cache slot.
 * @param card - The IntentCard to write. Must already be validated by the caller
 *               (validateIntentCard is not called here — this is a raw write).
 */
export async function seedIntentCache(spec: SeedIntentSpec, card: IntentCard): Promise<void> {
  // @decision DEC-SHAVE-SEED-001 (see module comment above)
  // Delegate to the same key-derivation functions and writeIntent that
  // extractIntent() uses. No logic is duplicated here.
  //
  // Static imports are used (matching the rest of this file's style). These
  // internal modules (cache/key.js, cache/file-cache.js, intent/constants.js)
  // do NOT import the Anthropic SDK, so DEC-SHAVE-002 offline discipline is
  // preserved: calling seedIntentCache() never triggers the SDK code path.
  const modelTag = spec.model ?? DEFAULT_MODEL;
  const pv = spec.promptVersion ?? INTENT_PROMPT_VERSION;

  const srcHash = _sourceHash(spec.source);
  const cacheKey = _keyFromIntentInputs({
    sourceHash: srcHash,
    modelTag,
    promptVersion: pv,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });

  await _writeIntent(spec.cacheDir, cacheKey, card);
}

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

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeIntent as _writeIntent } from "./cache/file-cache.js";
import {
  keyFromIntentInputs as _keyFromIntentInputs,
  sourceHash as _sourceHash,
} from "./cache/key.js";
import { LicenseRefusedError } from "./errors.js";
import { DEFAULT_MODEL, INTENT_PROMPT_VERSION, INTENT_SCHEMA_VERSION } from "./intent/constants.js";
import { extractIntent } from "./intent/extract.js";
import type { IntentCard } from "./intent/types.js";
import { detectLicense } from "./license/detector.js";
import { licenseGate } from "./license/gate.js";
import { locateProjectRoot } from "./locate-root.js";
import { maybePersistNovelGlueAtom } from "./persist/atom-persist.js";
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
// shave() — one-shot file ingestion (WI-014-01)
// ---------------------------------------------------------------------------

/**
 * Process a source file through the full shave pipeline.
 *
 * Reads the source file at `sourcePath`, wraps it in a CandidateBlock, and
 * runs it through universalize() (license gate → intent extraction →
 * decompose → slice). Returns a ShaveResult with atoms derived from the
 * SlicePlan, the extracted intent card, and forwarded diagnostics.
 *
 * Throws a plain Error (mentioning the path) if the file is not found.
 * All universalize() errors (LicenseRefusedError, AnthropicApiKeyMissingError,
 * OfflineCacheMissError, DidNotReachAtomError, RecursionDepthExceededError)
 * propagate unwrapped.
 *
 * @param sourcePath - Absolute path to the source file to process.
 * @param registry   - Registry view used for block lookups.
 * @param options    - Optional configuration overrides.
 */
export async function shave(
  sourcePath: string,
  registry: ShaveRegistryView,
  options?: ShaveOptions,
): Promise<ShaveResult> {
  // @decision DEC-SHAVE-PIPELINE-001
  // title: shave() reads file, wraps as CandidateBlock, delegates to universalize()
  // status: decided
  // rationale:
  //   shave() is a thin file-ingestion adapter over universalize(). All pipeline
  //   logic (license gate, intent extraction, decompose, slice) lives in
  //   universalize(). This keeps shave() focused on I/O concerns: file reading
  //   and result shape translation.
  //
  //   PlaceholderId format: "shave-atom-" + canonicalAstHash.slice(0, 8).
  //   A deterministic id keyed on the canonical AST hash ensures that two runs
  //   over identical source produce identical placeholder arrays, which is a
  //   prerequisite for content-addressable provenance tracking (WI-014-02).
  //   Using a slice of canonicalAstHash rather than a random UUID or
  //   sequential counter avoids non-determinism while remaining collision-free
  //   in practice for the v0 demo corpus (< 100 atoms per file).
  //
  //   Source file not found: we throw a plain Error with a human-readable
  //   message including the path. We do not introduce a new SourceFileNotFoundError
  //   class in this slice (that would require modifying errors.ts, which is
  //   out of scope for WI-014-01). The fs ENOENT code is preserved in the
  //   error chain via the `cause` field so callers can inspect it programmatically.

  // Step 1: Read source file.
  let source: string;
  try {
    source = await readFile(sourcePath, "utf-8");
  } catch (err) {
    throw new Error(`shave: source file not found: ${sourcePath}`, { cause: err });
  }

  // Step 2: Wrap in a CandidateBlock with a hint derived from the file name.
  const candidate: CandidateBlock = {
    source,
    hint: { name: basename(sourcePath), origin: "user" },
  };

  // Step 3: Run through universalize() — errors propagate unwrapped.
  const result = await universalize(candidate, registry, options);

  // Step 4: Persist novel atoms and translate UniversalizeResult into ShaveResult.
  //
  // @decision DEC-ATOM-PERSIST-001
  // title: shave() persists NovelGlueEntries with intentCard via maybePersistNovelGlueAtom
  // status: decided
  // rationale:
  //   - Persistence is opt-in: maybePersistNovelGlueAtom checks for registry.storeBlock
  //     before doing anything. Callers with a read-only ShaveRegistryView get silent
  //     no-ops; callers with a full Registry get atoms stored automatically.
  //   - Only NovelGlueEntries with an intentCard persist; PointerEntries reference
  //     existing blocks and do not produce new rows.
  //   - Entries without intentCard (deep leaves in multi-leaf trees) return undefined
  //     from maybePersistNovelGlueAtom; their ShavedAtomStub has no merkleRoot.
  //   - PointerEntries do not have an intentCard slot; their stub also has no merkleRoot
  //     (the pointer's existing registry merkleRoot is carried on the PointerEntry
  //     itself, not propagated to ShavedAtomStub in this slice).
  //   - property-test corpus is empty at L0 bootstrap (deferred to WI-013-03).
  //   - effect declaration is empty (atoms pure-by-default; effect inference future).

  // Persist all novel-glue entries in parallel. Pointer entries are left as undefined.
  const merkleRoots = await Promise.all(
    result.slicePlan.map((entry) => {
      if (entry.kind === "novel-glue") {
        return maybePersistNovelGlueAtom(entry, registry);
      }
      return Promise.resolve(undefined);
    }),
  );

  // Each SlicePlanEntry maps to a ShavedAtomStub. The placeholderId is a
  // deterministic "shave-atom-" prefix + 8-char truncation of canonicalAstHash
  // (per DEC-SHAVE-PIPELINE-001 rationale above).
  const atoms = result.slicePlan.map((entry, i) => ({
    placeholderId: `shave-atom-${entry.canonicalAstHash.slice(0, 8)}`,
    sourceRange: entry.sourceRange,
    merkleRoot: merkleRoots[i],
  }));

  return {
    sourcePath,
    atoms,
    intentCards: [result.intentCard],
    diagnostics: result.diagnostics,
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
