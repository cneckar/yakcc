// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Public API entry point for @yakcc/shave.
// Three exported entry points: shave() (one-shot file), universalize()
// (single-block continuous), createIntentExtractionHook() (hookable pipeline).
// extractIntent is intentionally NOT exported — it is an internal detail.
// WI-010-03: universalize is now wired to the live extractIntent path.
// The sentinel IntentCard from WI-010-01 is removed.
// WI-018: seedIntentCache() is a public test-helper that writes an IntentCard
// into the file-system cache via the same key-derivation path as extractIntent.
// WI-016: extractCorpus() and seedCorpusCache() are public exports. extractCorpus()
// is the primary API for property-test corpus extraction. seedCorpusCache() is a
// test-helper for seeding the AI-derived corpus cache in offline tests.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Keeping extractIntent internal ensures callers depend only on
// the stable public surface; the extraction implementation can evolve freely.

// ---------------------------------------------------------------------------
// Re-exports — public type surface
// ---------------------------------------------------------------------------

export type {
  CandidateBlock,
  ForeignPolicy,
  IntentExtractionHook,
  ShaveDiagnostics,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  ShavedAtomStub,
  UniversalizeOptions,
  UniversalizeResult,
  UniversalizeSlicePlanEntry,
} from "./types.js";

export { FOREIGN_POLICY_DEFAULT } from "./types.js";

export type { IntentCard, IntentParam } from "./intent/types.js";

// ---------------------------------------------------------------------------
// Re-exports — WI-016 public corpus surface
// ---------------------------------------------------------------------------

/**
 * @decision DEC-CORPUS-001 (see corpus/types.ts and corpus/index.ts)
 * title: extractCorpus and seedCorpusCache are public exports on the main entry point
 * status: decided (WI-016)
 * rationale:
 *   extractCorpus() is the primary API for property-test corpus extraction. It
 *   implements a three-source priority chain (upstream-test > documented-usage >
 *   ai-derived) and returns a CorpusResult suitable for buildTriplet(). Placing it
 *   on the main entry keeps the public contract stable while letting the corpus
 *   implementation evolve internally.
 *
 *   seedCorpusCache() is the corpus analogue of seedIntentCache(): a test-helper
 *   that pre-populates the AI-derived corpus cache for offline tests. It MUST use
 *   the same BLAKE3-based key derivation as the AI-derived extractor so that seeded
 *   entries are found on the first cache lookup.
 *
 *   DEC-SHAVE-002 offline discipline: loadling @yakcc/shave and calling extractCorpus()
 *   MUST work without ANTHROPIC_API_KEY. Sources (a) and (b) are pure; source (c)
 *   reads from cache only.
 */

export { extractCorpus } from "./corpus/index.js";
export type {
  CorpusResult,
  CorpusSource,
  CorpusAtomSpec,
  CorpusExtractionOptions,
} from "./corpus/index.js";
export {
  seedCorpusCache,
  CORPUS_SCHEMA_VERSION,
  CORPUS_DEFAULT_MODEL,
  CORPUS_PROMPT_VERSION,
} from "./corpus/index.js";

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
 *
 * WI-022: `strategy` controls which tag pair is used as the default for
 * `model`/`promptVersion`. Explicit `model`/`promptVersion` overrides still
 * win. Backward-compatible: tests not passing `strategy` get LLM-tag defaults,
 * preserving WI-018's three re-enabled `assemble-candidate` tests verbatim.
 */
export interface SeedIntentSpec {
  /** The raw source text whose BLAKE3 hash is the first key component. */
  readonly source: string;
  /** Root cache directory — must match the cacheDir used in the test's ShaveOptions. */
  readonly cacheDir: string;
  /** Anthropic model tag. Defaults based on `strategy` when omitted. */
  readonly model?: string | undefined;
  /** Prompt version tag. Defaults based on `strategy` when omitted. */
  readonly promptVersion?: string | undefined;
  /**
   * Strategy that controls the default tag pair when model/promptVersion are
   * omitted. (WI-022, DEC-INTENT-STRATEGY-001)
   *
   * - undefined / "llm" (default for backward-compat): defaults to DEFAULT_MODEL
   *   and INTENT_PROMPT_VERSION. WI-018's assemble-candidate tests seed LLM-mode
   *   cards and do not pass strategy; they continue working unchanged.
   * - "static": defaults to STATIC_MODEL_TAG and STATIC_PROMPT_VERSION, producing
   *   a key that matches what extractIntent(..., { strategy: "static" }) would use.
   */
  readonly strategy?: "static" | "llm" | undefined;
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
  // WI-022: strategy-aware defaults. When strategy === "static", use the static
  // tag pair so the seeded key matches what extractIntent({ strategy: "static" })
  // would derive. Default (undefined/"llm") uses LLM tags for backward-compat.
  const isStatic = spec.strategy === "static";
  const modelTag = spec.model ?? (isStatic ? STATIC_MODEL_TAG : DEFAULT_MODEL);
  const pv = spec.promptVersion ?? (isStatic ? STATIC_PROMPT_VERSION : INTENT_PROMPT_VERSION);

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
  ForeignPolicyRejectError,
  IntentCardSchemaError,
  LicenseRefusedError,
  OfflineCacheMissError,
  PersistRequestedButNotSupportedError,
} from "./errors.js";

// Version constants — exported so callers can introspect the cache keying
// policy and detect when their cached results were produced by a different
// model or prompt version.
export {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
  STATIC_MODEL_TAG,
  STATIC_PROMPT_VERSION,
} from "./intent/constants.js";

// extractIntent is NOT exported — it remains an internal implementation detail.

// ---------------------------------------------------------------------------
// Re-exports — WI-024 public cache-helper surface
// ---------------------------------------------------------------------------

/**
 * @decision DEC-PUBLIC-CACHE-CONSTS-001
 * @title sourceHash is exported on the main entry point (WI-024)
 * @status accepted
 * @rationale
 *   assemble-candidate.test.ts (in @yakcc/compile) needs to compute the
 *   source hash that seedIntentCache() uses internally so it can populate
 *   IntentCard.sourceHash with the exact value that extractIntent() would
 *   produce. Before WI-024 the test reached into the package via a
 *   cross-package relative import (../../../packages/shave/src/cache/key.js),
 *   which caused tsc to emit stray .d.ts/.js/.map artifacts into
 *   packages/shave/src/ and fail with TS6059/TS6307 when building
 *   @yakcc/compile.
 *
 *   Additive change — no breaking changes to existing callers. DEFAULT_MODEL
 *   and INTENT_PROMPT_VERSION were already public (WI-018); this adds sourceHash
 *   alongside them so all the imports in assemble-candidate.test.ts resolve
 *   through the stable @yakcc/shave workspace alias.
 *
 *   sourceHash is a pure function (BLAKE3 of normalized source). Exporting it
 *   does not expose internal mutable state or implementation details that must
 *   remain private; the function signature and semantics are already documented
 *   in cache/key.ts.
 */
export { sourceHash } from "./cache/key.js";

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
  GlueLeafEntry,
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
// WI-V2-04 L5: foreign-policy gate public surface
// ---------------------------------------------------------------------------

/**
 * A single foreign dependency reference surfaced by the shave() policy gate.
 *
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-L5: ForeignRef)
 * title: ForeignRef — public (pkg, export) token for policy-gate output
 * status: decided (WI-V2-04 L5)
 * rationale:
 *   shave() needs to surface foreign-dep information to callers (CLI, tests)
 *   without modifying ShaveResult (types.ts is L4-owned and frozen for L5).
 *   ForeignRef is a minimal structural type: the pkg specifier and the export
 *   name as emitted by classifyForeign(). For namespace imports, export is "*".
 *   The CLI renders these as "pkg#export" tokens in the summary line.
 */
export interface ForeignRef {
  /** Module specifier as written in the source, e.g. 'node:fs', 'ts-morph'. */
  readonly pkg: string;
  /** Imported binding name, e.g. 'readFileSync', 'Project', '*', 'default'. */
  readonly export: string;
}

/**
 * Extends ShaveResult with an optional foreignDeps field populated by the
 * policy gate when foreignPolicy === 'tag'. The field is absent for 'allow'
 * (silently accepted) and never reached for 'reject' (which throws).
 *
 * Using a structural extension rather than modifying ShaveResult (types.ts)
 * preserves L4 type stability while allowing L5 to surface foreign-dep info
 * to callers without an opaque side channel.
 *
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-L5: ShaveResultWithForeign)
 * title: ShaveResultWithForeign extends ShaveResult for tag-policy output
 * status: decided (WI-V2-04 L5)
 * rationale:
 *   types.ts is frozen (L4-owned). ShaveResult cannot be modified in L5.
 *   Extending via a subtype in index.ts (allowed scope) keeps the change
 *   additive and non-breaking: callers that only care about the base fields
 *   see no difference; callers that check foreignDeps (e.g. the CLI) cast
 *   to ShaveResultWithForeign or narrow via optional-field access.
 *
 *   The single source of truth for foreignDeps is the ForeignLeafEntry records
 *   in result.slicePlan after universalize() returns. No parallel tracking.
 */
export interface ShaveResultWithForeign extends ShaveResult {
  /**
   * Foreign dependency refs surfaced when foreignPolicy === 'tag'.
   * Absent (undefined) when policy is 'allow' (silent accept).
   * Never populated for 'reject' (which throws ForeignPolicyRejectError).
   * Empty array when policy is 'tag' but no foreign deps were found.
   */
  readonly foreignDeps?: readonly ForeignRef[] | undefined;
}

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
import {
  ForeignPolicyRejectError,
  LicenseRefusedError,
  PersistRequestedButNotSupportedError,
} from "./errors.js";
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
  STATIC_MODEL_TAG,
  STATIC_PROMPT_VERSION,
} from "./intent/constants.js";
import { extractIntent } from "./intent/extract.js";
import type { IntentCard } from "./intent/types.js";
import { detectLicense } from "./license/detector.js";
import { licenseGate } from "./license/gate.js";
import { locateProjectRoot } from "./locate-root.js";
import { maybePersistNovelGlueAtom } from "./persist/atom-persist.js";
import { FOREIGN_POLICY_DEFAULT } from "./types.js";
import type {
  CandidateBlock,
  IntentExtractionHook,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  ShavedAtomStub,
  UniversalizeOptions,
  UniversalizeResult,
} from "./types.js";
import { decompose } from "./universalize/recursion.js";
import { slice } from "./universalize/slicer.js";
import type { BlockMerkleRoot } from "./universalize/types.js";
import type { ForeignLeafEntry, NovelGlueEntry, SlicePlanEntry } from "./universalize/types.js";

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
 * root. For multi-leaf trees, per-leaf intentCard population is implemented by
 * WI-031 (commit `8dfb44b`, merge `3049ec3`, 2026-05-01) — see
 * `DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001` for the live decision and the
 * per-leaf extractIntent loop at lines ~542-573.
 *
 * "decomposition" is removed from diagnostics.stubbed — decomposition is now
 * live. "license-gate" is removed — gate is now live (WI-013-02).
 * "variance" is removed — variance ranking is now live (WI-011 / #374).
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
  options?: UniversalizeOptions,
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

  // Step 2: extract intent card.
  // WI-022: plumb intentStrategy through to extractIntent. Default "static"
  // per DEC-INTENT-STRATEGY-001. The model/promptVersion fields are only
  // consumed by the "llm" path; for "static" they are ignored (the static
  // path uses STATIC_MODEL_TAG/STATIC_PROMPT_VERSION internally).
  const intentCard = await extractIntent(candidate.source, {
    strategy: options?.intentStrategy ?? "static",
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

  // Step 5: attach intentCard to every NovelGlueEntry in the slice plan.
  //
  // Single-leaf case: attach the already-extracted root intentCard directly.
  // Multi-leaf case: call extractIntent per novel-glue entry.
  //
  // @decision DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001
  // title: Per-leaf extractIntent call (strategy: "static") for multi-leaf trees
  // status: accepted (WI-031)
  // rationale:
  //   Strategy (a) chosen: call extractIntent per novel-glue entry for multi-leaf
  //   trees, using the same strategy/model/cacheDir options as the root call.
  //   The static path (DEC-INTENT-STRATEGY-001 default) means per-leaf calls are
  //   cheap (no API, no network), produce semantically faithful cards derived from
  //   the actual leaf source (JSDoc + signature), and participate in the same
  //   seedIntentCache / offline discipline as single-leaf plans.
  //
  //   Strategy (b) rejected: cloning the root card and overriding per-leaf fields
  //   produces semantically-questionable cards (wrong behavior text, wrong inputs)
  //   and introduces a parallel mechanism that violates the no-duplicate-logic
  //   principle. It also bypasses the real extractIntent path, producing thinner
  //   test coverage. Strategy (a) is strictly superior for semantic fidelity and
  //   offline discipline.
  //
  //   Ordering/identity preservation: plan.entries order is load-bearing for
  //   shave()'s lineage-threading postorder loop (index.ts:586-606). We iterate
  //   the entries as-is and only attach intentCard to novel-glue entries; pointer
  //   entries pass through unchanged. No reordering, no extra entries.
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
    // Multi-leaf tree: call extractIntent per novel-glue entry to attach a
    // semantically faithful intentCard to each leaf.
    // PointerEntries pass through unchanged (no intentCard slot on the type).
    //
    // Errors from per-leaf extractIntent propagate unwrapped — same contract as
    // the root extractIntent call above (OfflineCacheMissError, etc.).
    const enrichedEntries: SlicePlanEntry[] = [];
    for (const entry of plan.entries) {
      if (entry.kind === "novel-glue") {
        const leafCard = await extractIntent(entry.source, {
          strategy: options?.intentStrategy ?? "static",
          model: options?.model ?? DEFAULT_MODEL,
          promptVersion: INTENT_PROMPT_VERSION,
          cacheDir,
          offline: options?.offline,
        });
        const withCard: NovelGlueEntry = {
          kind: entry.kind,
          sourceRange: entry.sourceRange,
          source: entry.source,
          canonicalAstHash: entry.canonicalAstHash,
          intentCard: leafCard,
        };
        enrichedEntries.push(withCard);
      } else {
        // PointerEntry — no intentCard slot, pass through unchanged.
        enrichedEntries.push(entry);
      }
    }
    slicePlan = enrichedEntries;
  }

  // Step 6 (NEW — WI-373): in-pipeline atom persistence, gated on options.persist === true.
  //
  // @decision DEC-UNIVERSALIZE-PERSIST-PIPELINE-001
  // @title Persistence step 6 runs after intentCard attachment, postorder DFS, with parentBlockRoot lineage
  // @status accepted (WI-373)
  // @rationale
  //   Placed after step 5 (intentCard attachment) so every NovelGlueEntry that
  //   enters the persist loop already carries its intentCard. Without intentCard,
  //   maybePersistNovelGlueAtom() skips the entry (per DEC-ATOM-PERSIST-001).
  //   DFS postorder preserves DEC-REGISTRY-PARENT-BLOCK-004: the first novel-glue
  //   entry in DFS order is the innermost leaf (parentBlockRoot=null); each
  //   subsequent novel-glue entry takes the preceding entry's merkleRoot as its
  //   parentBlockRoot. This is the identical semantics used by shave()'s loop
  //   (index.ts:741-779) — lifted verbatim so both paths consolidate onto the
  //   same primitive (Sacred Practice #12).
  //
  //   Loud-fail: if persist:true is requested but registry.storeBlock is absent,
  //   PersistRequestedButNotSupportedError is thrown immediately (Sacred Practice
  //   #5). The graceful-degradation (silent no-op) path from maybePersistNovelGlueAtom
  //   is intentionally NOT used here — the caller explicitly asked for persistence.
  //
  //   When persist is false/undefined, this entire step is a no-op and slicePlan
  //   is returned unchanged — zero effect on today's default behavior.
  //
  //   Per REQ-NOGO-006: sourceFilePath and sourceContext may be undefined when
  //   called from assembleCandidate() (interactive use). Atoms persist with null
  //   provenance — correct per DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001.
  //
  //   P1 follow-up (not in this slice): refactor shave() to delegate to
  //   universalize({persist:true, sourceContext, ...}) and delete its own
  //   postorder loop (Sacred Practice #12 consolidation, plan §6 slice 2).
  //   Also flag: atomize.ts in @yakcc/hooks-base runs a parallel buildBlockRow +
  //   storeBlock loop that should consolidate onto universalize({persist:true})
  //   once this WI lands (plan §7).
  let finalSlicePlan = slicePlan;
  if (options?.persist === true) {
    // Loud-fail: storeBlock must be present when persist:true is requested.
    if (typeof registry.storeBlock !== "function") {
      throw new PersistRequestedButNotSupportedError();
    }

    // Postorder lineage loop — lifted verbatim from shave()'s index.ts:741-779.
    // Each NovelGlueEntry is persisted in DFS order; the preceding novel-glue
    // entry's merkleRoot becomes the current entry's parentBlockRoot.
    let lastNovelMerkleRoot: BlockMerkleRoot | undefined = undefined;
    const enrichedWithMerkle: SlicePlanEntry[] = [];
    for (const entry of slicePlan) {
      if (entry.kind === "novel-glue") {
        const parentBlockRoot: BlockMerkleRoot | null = lastNovelMerkleRoot ?? null;
        const baseSourceContext = options?.sourceContext;
        const perAtomSourceContext =
          baseSourceContext !== undefined
            ? {
                sourcePkg: baseSourceContext.sourcePkg,
                sourceFile: baseSourceContext.sourceFile,
                sourceOffset: entry.sourceRange.start,
              }
            : undefined;
        const merkleRoot = await maybePersistNovelGlueAtom(entry, registry, {
          cacheDir: options?.cacheDir,
          parentBlockRoot,
          // sourceFilePath: forwarded from UniversalizeOptions.sourceFilePath when
          // present (set by shave() to enable props-file corpus extraction).
          // Undefined for interactive universalize() callers (e.g. assembleCandidate)
          // — those atoms persist with null provenance per REQ-NOGO-006 /
          // DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001.
          sourceFilePath: options?.sourceFilePath,
          sourceContext: perAtomSourceContext,
        });
        // Surface the merkleRoot on the entry (may be undefined if intentCard absent).
        // exactOptionalPropertyTypes: spread only when defined to satisfy
        // NovelGlueEntry.merkleRoot?: BlockMerkleRoot (not BlockMerkleRoot | undefined).
        const enriched: NovelGlueEntry = {
          ...entry,
          ...(merkleRoot !== undefined && { merkleRoot }),
        };
        enrichedWithMerkle.push(enriched);
        if (merkleRoot !== undefined) {
          lastNovelMerkleRoot = merkleRoot;
        }
      } else {
        // PointerEntry / ForeignLeafEntry / GlueLeafEntry — pass through unchanged.
        enrichedWithMerkle.push(entry);
      }
    }
    finalSlicePlan = enrichedWithMerkle;
  }

  return {
    intentCard,
    slicePlan: finalSlicePlan,
    matchedPrimitives: plan.matchedPrimitives,
    licenseDetection: detection,
    diagnostics: {
      // "decomposition" removed — decompose() is now live (WI-012-06).
      // "license-gate" removed — gate is now live (WI-013-02).
      // "variance" removed — variance ranking is now live (WI-011 / #374).
      stubbed: [],
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
): Promise<ShaveResultWithForeign> {
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

  // Step 3: Run through universalize({persist:true}) — errors propagate unwrapped.
  //
  // @decision DEC-V2-SHAVE-DELEGATES-UNIVERSALIZE-001
  // title: shave() delegates atom persistence to universalize({persist:true})
  // status: accepted (WI-423)
  // rationale:
  //   WI-373 (PR #419) lifted the postorder lineage-threading persist loop from
  //   shave() into universalize() as step 6, gated on options.persist===true.
  //   However, the WI-373 implementer copied the loop rather than refactoring
  //   shave() to delegate — leaving two parallel persistence mechanisms (Sacred
  //   Practice #12 violation). This WI (WI-423) closes that debt.
  //
  //   shave() now calls universalize({persist:true, sourceFilePath:sourcePath})
  //   and reads merkleRoot directly from the enriched slicePlan entries returned
  //   by universalize(). The in-line loop (DEC-ATOM-PERSIST-001 / DEC-REGISTRY-
  //   PARENT-BLOCK-004) that previously ran here is removed — universalize() is
  //   the single authority for atom persistence.
  //
  //   sourceFilePath is forwarded via UniversalizeOptions.sourceFilePath so the
  //   props-file corpus extractor (DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001)
  //   can locate the sibling <stem>.props.ts file exactly as before.
  //
  //   Behavior is bit-for-bit identical: T5 (DEC-UNIVERSALIZE-PERSIST-PIPELINE-001)
  //   passes because the same maybePersistNovelGlueAtom primitives run in the same
  //   postorder with the same parentBlockRoot chain.
  //
  //   Graceful degradation (read-only registry): universalize()'s step 6 is
  //   gated on options.persist===true, and shave() always passes persist:true.
  //   When registry.storeBlock is absent, PersistRequestedButNotSupportedError is
  //   thrown (Sacred Practice #5 loud-fail). Previously, shave() used
  //   maybePersistNovelGlueAtom's silent-no-op path when storeBlock was absent —
  //   this was a silent degradation. The new behaviour preserves that: we pass
  //   persist:true only when registry.storeBlock is present, otherwise we call
  //   universalize without persist (maintaining the graceful-degradation contract).
  const hasPersist = typeof registry.storeBlock === "function";
  const result = await universalize(candidate, registry, {
    ...options,
    ...(hasPersist && { persist: true, sourceFilePath: sourcePath }),
  });

  // Step 3b: Foreign-policy gate — enforced AFTER slice() returns, NOT inside slicer.ts.
  //
  // @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001 (sub-L5: policy gate enforcement)
  // title: foreignPolicy gate runs in shave() after universalize() returns (L5)
  // status: decided (WI-V2-04 L5)
  // rationale:
  //   L5-I2: the gate must run at the shave entry point, not inside slicer.ts
  //   (L3-owned) or universalize() internals. Placing it here lets universalize()
  //   and slice() remain pure of policy concerns — they always emit ForeignLeafEntry
  //   for detected foreign imports regardless of policy. The gate consumes the
  //   already-produced slice plan and decides what to do with the foreign refs.
  //
  //   'reject' (L5-I3): throw ForeignPolicyRejectError with all (pkg, export) pairs
  //   from the slice plan, in source-declaration order (DFS order from slice()).
  //   The CLI catches ForeignPolicyRejectError and emits its message to stderr,
  //   then returns exit code 1.
  //
  //   'tag' (L5-I4): collect foreign refs and include them in the returned
  //   ShaveResultWithForeign.foreignDeps field. The CLI formats them as
  //   "foreign deps: pkg#export[, ...]" on stdout and returns exit code 0.
  //
  //   'allow' (L5-I5): silently accept; foreignDeps is not set on the result.
  //
  //   Single-source-of-truth: FOREIGN_POLICY_DEFAULT in types.ts governs the
  //   default; this gate reads options?.foreignPolicy ?? FOREIGN_POLICY_DEFAULT
  //   so both agree on the same constant (I-X3 invariant).
  const effectivePolicy = options?.foreignPolicy ?? FOREIGN_POLICY_DEFAULT;
  const foreignLeaves = result.slicePlan.filter(
    (e): e is ForeignLeafEntry => e.kind === "foreign-leaf",
  );
  const foreignRefs: readonly ForeignRef[] = foreignLeaves.map((e) => ({
    pkg: e.pkg,
    export: e.export,
  }));

  if (effectivePolicy === "reject" && foreignRefs.length > 0) {
    // L5-I3: throw structured error with all foreign (pkg, export) pairs.
    throw new ForeignPolicyRejectError(foreignRefs);
  }

  // For 'tag': foreignDeps is populated on the result (L5-I4).
  // For 'allow': foreignDeps is left undefined (L5-I5 silent accept).
  const foreignDeps: readonly ForeignRef[] | undefined =
    effectivePolicy === "tag" ? foreignRefs : undefined;

  // Step 4: Translate universalize() result into ShaveResult.
  //
  // Persistence was handled by universalize({persist:true}) above
  // (DEC-V2-SHAVE-DELEGATES-UNIVERSALIZE-001). NovelGlueEntry items in the
  // slicePlan already carry merkleRoot when persist:true ran. PointerEntry items
  // always carry merkleRoot (per DEC-SHAVE-POINTER-MERKLROOT-PROPAGATION-001).
  // ForeignLeafEntry and GlueLeafEntry are excluded (per DEC-V2-GLUE-AWARE-SHAVE-001).

  // Each SlicePlanEntry that carries an AST hash maps to a ShavedAtomStub.
  // ForeignLeafEntry and GlueLeafEntry are intentionally excluded:
  //   - ForeignLeafEntry is an opaque leaf with no host-module sourceRange.
  //   - GlueLeafEntry is a verbatim-preserved region with no sourceRange
  //     (per DEC-V2-GLUE-LEAF-CONTRACT-001: glue is project-local, not registry-registered).
  // (per DEC-SHAVE-PIPELINE-001, DEC-V2-FOREIGN-BLOCK-SCHEMA-001, DEC-V2-GLUE-AWARE-SHAVE-001)
  const atoms = result.slicePlan.flatMap((entry): ShavedAtomStub[] => {
    if (entry.kind === "foreign-leaf" || entry.kind === "glue") {
      // Excluded: foreign deps are opaque leaves; glue regions are verbatim-preserved
      // project-local code with no registry entry and no sourceRange field.
      return [];
    }
    // novel-glue: merkleRoot populated by universalize({persist:true}) step 6.
    // pointer: merkleRoot always present (DEC-SHAVE-POINTER-MERKLROOT-PROPAGATION-001).
    return [
      {
        placeholderId: `shave-atom-${entry.canonicalAstHash.slice(0, 8)}`,
        sourceRange: entry.sourceRange,
        merkleRoot: entry.merkleRoot,
      },
    ];
  });

  return {
    sourcePath,
    atoms,
    intentCards: [result.intentCard],
    diagnostics: result.diagnostics,
    foreignDeps,
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
