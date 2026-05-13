// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-CANDIDATE-001
// title: assembleCandidate is the compile-time entry point for the
// continuous-shave pipeline (WI-014-05, updated WI-373)
// status: implemented (WI-014-05, WI-373)
// rationale: Composes cleanly with the existing assemble() rather than forking.
// The slicer/license/intent pipeline lives entirely in @yakcc/shave; @yakcc/compile
// stays focused on composition resolution. This is a new entry point — no changes
// to the existing assemble() signature.
//
// Flow (updated WI-373):
//   1. Adapt the full Registry → ShaveRegistryView (null → undefined for getBlock).
//   2. Run universalize(candidate, shaveRegistry, { persist: true, ...shaveOptions }) —
//      license gate runs first (cheap, fail-fast), then intent extraction, decompose,
//      slice, and now step 6 in-pipeline atom persistence (WI-373). persist:true is
//      always forced so novel-glue entries are persisted and their merkleRoot surfaced.
//   3. Resolve the candidate's BlockMerkleRoot via one of three paths:
//      a. PointerEntry-only single-entry slice: the entire candidate matches an
//         existing primitive exactly. Use that BlockMerkleRoot directly.
//      b. NovelGlueEntry single-entry: the candidate is novel. universalize() now
//         persists the atom in-pipeline (WI-373) and surfaces merkleRoot on the
//         entry. resolveToMerkleRoot() lifts that value. No more CandidateNotResolvableError
//         for this case (the TODO comment is deleted).
//      c. Multi-leaf slice (>1 entries): throw CandidateNotResolvableError (follow-up WI).
//   4. Call the existing assemble(merkleRoot, registry, backend, options).
//
// The license gate in universalize() guarantees only permissive sources reach the
// resolver path; LicenseRefusedError propagates unwrapped to the caller.

import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import {
  type ShaveOptions,
  type UniversalizeOptions,
  type UniversalizeResult,
  universalize,
} from "@yakcc/shave";
import type { Artifact, AssembleOptions } from "./assemble.js";
import { assemble } from "./assemble.js";
import type { Backend } from "./ts-backend.js";
import { tsBackend } from "./ts-backend.js";

// ---------------------------------------------------------------------------
// Public error class
// ---------------------------------------------------------------------------

/**
 * Thrown by assembleCandidate() when the universalize() slice plan cannot be
 * reduced to a single BlockMerkleRoot suitable for passing to assemble().
 *
 * Two cases trigger this today:
 *   - A single NovelGlueEntry (the candidate is novel, not yet in the registry).
 *     Atom persistence in the universalize() pipeline is pending; use `yakcc shave`
 *     to persist first, then assemble() directly with the resulting merkleRoot.
 *   - A multi-leaf slice plan (> 1 entries). Multi-leaf assembly is a follow-up
 *     work item (slice plan decomposition must be resolved manually first).
 */
export class CandidateNotResolvableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`assembleCandidate: cannot resolve to a single BlockMerkleRoot — ${reason}`);
    this.name = "CandidateNotResolvableError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Public options type
// ---------------------------------------------------------------------------

/**
 * Options for assembleCandidate().
 *
 * Extends AssembleOptions (forwarded to assemble()) with an optional
 * shaveOptions block forwarded to universalize(). shaveOptions accepts
 * UniversalizeOptions (a strict superset of ShaveOptions) so callers may
 * pass persist:true when they want novel-glue atoms to be persisted in-pipeline.
 *
 * assembleCandidate() always merges { persist: true } into whatever shaveOptions
 * the caller supplies — this is how it wires up the WI-373 persistence path.
 *
 * @decision DEC-UNIVERSALIZE-PERSIST-API-001 (WI-373)
 * @see UniversalizeOptions
 */
export interface AssembleCandidateOptions extends AssembleOptions {
  /**
   * Options forwarded to universalize() for intent extraction tuning
   * (cacheDir, model, offline, recursionOptions) and persistence (persist).
   * assembleCandidate() forces persist:true regardless of what is supplied here.
   */
  readonly shaveOptions?: UniversalizeOptions;
}

// ---------------------------------------------------------------------------
// Internal: adapt Registry → ShaveRegistryView
// ---------------------------------------------------------------------------

/**
 * Adapt a full Registry to the narrower ShaveRegistryView expected by
 * universalize().
 *
 * The only impedance mismatch is getBlock: Registry returns null on miss,
 * ShaveRegistryView expects undefined. We wrap the call to coerce null to
 * undefined so callers of universalize() get graceful degradation on misses.
 *
 * All other methods are structurally compatible and bound directly.
 */
function toShaveRegistryView(registry: Registry) {
  return {
    selectBlocks: registry.selectBlocks.bind(registry),
    getBlock: async (m: BlockMerkleRoot) => {
      const row = await registry.getBlock(m);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash.bind(registry),
    storeBlock: registry.storeBlock.bind(registry),
  };
}

// ---------------------------------------------------------------------------
// Internal: resolve UniversalizeResult → BlockMerkleRoot
// ---------------------------------------------------------------------------

/**
 * Resolve a UniversalizeResult to a single BlockMerkleRoot for passing to
 * assemble(), or throw CandidateNotResolvableError with a clear reason.
 *
 * Resolution rules:
 *   - Empty slicePlan → error (should never happen for valid source).
 *   - Single PointerEntry → use its merkleRoot directly (exact registry match).
 *   - Single NovelGlueEntry → error (atom persistence pending in universalize).
 *   - Multiple entries → error (multi-leaf assembly is a follow-up slice).
 */
function resolveToMerkleRoot(result: UniversalizeResult): BlockMerkleRoot {
  const entries = result.slicePlan;

  if (entries.length === 0) {
    throw new CandidateNotResolvableError("slicePlan is empty");
  }

  if (entries.length > 1) {
    throw new CandidateNotResolvableError(
      `multi-leaf slice (${entries.length} entries) — multi-leaf assembly is a follow-up slice`,
    );
  }

  const only = entries[0];
  if (only === undefined) {
    // TypeScript narrowing safety; cannot happen when entries.length === 1.
    throw new CandidateNotResolvableError("slicePlan[0] is undefined");
  }

  if (only.kind === "pointer") {
    return only.merkleRoot;
  }

  if (only.kind === "novel-glue") {
    // WI-373: universalize({persist:true}) now persists the atom in-pipeline and
    // surfaces the BlockMerkleRoot on the NovelGlueEntry. assembleCandidate()
    // always forces persist:true (see assembleCandidate() below), so by the time
    // we reach this branch the entry should carry a defined merkleRoot.
    //
    // @decision DEC-UNIVERSALIZE-PERSIST-PIPELINE-001 (WI-373)
    // @title resolveToMerkleRoot lifts NovelGlueEntry.merkleRoot after in-pipeline persist
    // @status accepted
    // @rationale
    //   assembleCandidate() merges persist:true into the universalize() call, so
    //   any NovelGlueEntry that had an intentCard will carry a merkleRoot here.
    //   If merkleRoot is still undefined after persist:true (e.g. the entry had no
    //   intentCard — a deep leaf without an extracted card), we throw a clear error
    //   rather than silently returning null. This keeps the loud-fail contract of
    //   Sacred Practice #5 while surfacing a diagnosable message.
    if (only.merkleRoot !== undefined) {
      return only.merkleRoot;
    }
    throw new CandidateNotResolvableError(
      "single novel-glue entry — atom was not persisted (no intentCard on the entry; " +
        "ensure the source passes intent extraction before assembling)",
    );
  }

  // Other single-entry kinds (foreign-leaf, glue) cannot be resolved to a merkleRoot.
  throw new CandidateNotResolvableError(
    `single entry of kind '${only.kind}' cannot be resolved to a BlockMerkleRoot`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile-time entry point for the continuous-shave pipeline.
 *
 * Runs universalize() on the raw candidate source text, resolves the resulting
 * slice plan to a single BlockMerkleRoot, then delegates to the existing
 * assemble() for composition resolution and artifact emission.
 *
 * @param candidateSource - Raw TypeScript source text to compile.
 * @param registry        - Full registry for block lookups and storage.
 * @param backend         - Compilation backend (defaults to tsBackend()).
 * @param options         - Combined AssembleOptions + shaveOptions.
 *
 * @throws LicenseRefusedError        - Candidate carries a refused license (GPL etc.).
 *                                      Propagated unwrapped from universalize().
 * @throws AnthropicApiKeyMissingError - No API key and not in offline mode.
 * @throws OfflineCacheMissError       - offline=true but no cache entry for this source.
 * @throws DidNotReachAtomError        - Decomposition could not reach atomic leaves.
 * @throws RecursionDepthExceededError - Source AST exceeds maxDepth.
 * @throws CandidateNotResolvableError - Slice plan cannot be reduced to one BlockMerkleRoot.
 * @throws ResolutionError             - Composition graph is missing or cyclic.
 *
 * @decision DEC-COMPILE-CANDIDATE-001 — see module-level comment above.
 */
export async function assembleCandidate(
  candidateSource: string,
  registry: Registry,
  backend: Backend = tsBackend(),
  options: AssembleCandidateOptions = {},
): Promise<Artifact> {
  // Step 1: adapt Registry → ShaveRegistryView.
  const shaveRegistry = toShaveRegistryView(registry);

  // Step 2: run universalize() with persist:true — license gate runs first, then
  // intent extraction, decompose, slice, and now in-pipeline atom persistence
  // (step 6, WI-373). persist:true is always forced here so novel-glue entries
  // are persisted in-pipeline and their merkleRoot is surfaced to resolveToMerkleRoot().
  // All universalize() errors propagate unwrapped.
  const universalizeOptions: UniversalizeOptions = {
    ...options.shaveOptions,
    persist: true,
  };
  const result = await universalize(
    { source: candidateSource, hint: { origin: "compile-resolver" } },
    shaveRegistry,
    universalizeOptions,
  );

  // Step 3: resolve to a single BlockMerkleRoot (or throw CandidateNotResolvableError).
  const entryRoot = resolveToMerkleRoot(result);

  // Step 4: delegate to assemble() with the resolved entry root.
  const { shaveOptions: _ignored, ...assembleOptions } = options;
  return assemble(entryRoot, registry, backend, assembleOptions);
}
