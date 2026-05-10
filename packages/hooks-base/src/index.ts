// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-BASE-001
// title: Extract @yakcc/hooks-base: shared types and logic for IDE hook packages
// status: decided (WI-V1W2-HOOKS-BASE)
// rationale:
//   (a) Consolidates the type and logic duplication that was intentionally deferred
//       in v1 W1/W2. DEC-HOOK-CURSOR-001 (d) and DEC-HOOK-CODEX-001 (d) both
//       flagged the local EmissionContext / HookResponse / HookOptions declarations
//       as temporary, with a note that a future WI would consolidate them into a
//       @yakcc/hooks-base package. This is that WI.
//   (b) Public surface mirrors exactly what was duplicated in the three consumer
//       packages (hooks-claude-code, hooks-cursor, hooks-codex): the shared types,
//       the DEFAULT_REGISTRY_HIT_THRESHOLD constant, the buildSkeletonSpec helper,
//       the buildIntentCardQuery helper, the writeMarkerCommand helper, and the
//       load-bearing executeRegistryQuery logic that performs the findCandidatesByIntent
//       call and maps results to the three response kinds.
//   (c) Consumer hooks now compose by importing the shared logic from @yakcc/hooks-base
//       and adding only IDE-specific branding: interface name (ClaudeCodeHook /
//       CursorHook / CodexHook), registration method name (registerSlashCommand vs
//       registerCommand), and the default markerDir path (~/.claude, ~/.cursor, ~/.yakcc).
//   (d) The three consumer packages depend on @yakcc/hooks-base (workspace:*).
//       No circular dependency risk: hooks-base depends only on @yakcc/contracts and
//       @yakcc/registry, which are leaf packages that no hook package feeds back into.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractIdFromBytes } from "@yakcc/contracts";
import type { ContractId, ContractSpec } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";

export type { ContractId, ContractSpec };

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

/**
 * Default cosine-distance cutoff for a registry hit.
 *
 * sqlite-vec cosine distances are in [0, 2] for unit-norm vectors.
 * Values < 0.30 indicate high semantic similarity.
 * Values > 0.70 indicate divergence.
 * Values ≈ 1.0 are orthogonal.
 *
 * Shared across all three IDE hook packages for cross-IDE consistency.
 * See DEC-HOOK-BASE-001(b).
 */
export const DEFAULT_REGISTRY_HIT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Describes the context in which an IDE is about to emit code.
 *
 * Shared across @yakcc/hooks-claude-code, @yakcc/hooks-cursor, and
 * @yakcc/hooks-codex. Structurally identical to the local declarations
 * those packages previously carried (DEC-HOOK-BASE-001-a).
 */
export interface EmissionContext {
  /** Natural-language description of what the user asked for. */
  readonly intent: string;
  /** Optional surrounding source context at the emission site. */
  readonly sourceContext?: string;
}

/**
 * The three possible responses from the hook's emission-intent handler:
 *
 * - registry-hit: an existing implementation was found; use it.
 * - synthesis-required: no match exists; the registry needs a new block.
 * - passthrough: defer to normal IDE behaviour (reserved for errors only).
 */
export type HookResponse =
  | { readonly kind: "registry-hit"; readonly id: ContractId }
  | { readonly kind: "synthesis-required"; readonly proposal: ContractSpec }
  | { readonly kind: "passthrough" };

/**
 * Options accepted by all createHook() factories.
 *
 * Each consumer package passes these through to the shared helpers below.
 */
export interface HookOptions {
  /**
   * Cosine-distance threshold below which a registry match is accepted as a hit.
   * Defaults to DEFAULT_REGISTRY_HIT_THRESHOLD (0.30).
   * Lower values = stricter matching; higher values = more permissive matching.
   */
  readonly threshold?: number | undefined;

  /**
   * Path to the directory where the marker file is written.
   * Override in tests to avoid touching the home directory.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Shape returned by buildIntentCardQuery() — the IntentQuery card fields derived from an EmissionContext.
 *
 * Named to give the return type a single-token representation; the static intent extractor uses the
 * function's return-type annotation as the behavior fallback when no JSDoc summary is present in the
 * leaf source. A named type avoids a multi-line object literal in that fallback string.
 */
export type IntentCardQuery = { behavior: string; inputs: never[]; outputs: never[] };

/**
 * Build the behavior string for the intent query passed to findCandidatesByIntent().
 *
 * Concatenates intent and sourceContext when the latter is present, matching
 * the query construction that was previously inlined in all three consumer hooks.
 */
export function buildIntentCardQuery(ctx: EmissionContext): IntentCardQuery {
  const behavior = ctx.sourceContext ? `${ctx.intent} ${ctx.sourceContext}` : ctx.intent;
  return { behavior, inputs: [], outputs: [] };
}

/**
 * Build a minimal ContractSpec skeleton from a prose intent string.
 *
 * The skeleton carries the intent as the behavior field and empty collections
 * for all array fields. NonFunctional defaults to pure + safe as a conservative
 * starting point — the synthesiser will refine these. This helper was previously
 * duplicated as an internal `buildSkeletonSpec` in all three consumer hooks.
 */
export function buildSkeletonSpec(intent: string): ContractSpec {
  return {
    inputs: [],
    outputs: [],
    behavior: intent,
    guarantees: [],
    errorConditions: [],
    nonFunctional: {
      purity: "pure",
      threadSafety: "safe",
    },
    propertyTests: [],
  };
}

/**
 * Write a JSON marker file to markerDir/filename.
 *
 * Creates markerDir if it does not exist (idempotent). This is the
 * single implementation of the marker-write logic that was previously
 * duplicated verbatim in registerSlashCommand() / registerCommand()
 * across all three consumer hooks (DEC-HOOK-BASE-001-b).
 *
 * @param markerDir - Directory to write the marker file into.
 * @param filename  - Marker filename (e.g. "yakcc-slash-command.json").
 * @param payload   - JSON-serialisable object to write.
 */
export function writeMarkerCommand(markerDir: string, filename: string, payload: object): void {
  if (!existsSync(markerDir)) {
    mkdirSync(markerDir, { recursive: true });
  }
  const markerPath = join(markerDir, filename);
  writeFileSync(markerPath, JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * Execute the registry query and return the appropriate HookResponse.
 *
 * This is the load-bearing logic that was previously duplicated inside
 * onCodeEmissionIntent() in all three consumer hooks. Each consumer now
 * calls this function and wraps the result in its own flavoured interface.
 *
 * Production sequence (DEC-HOOK-BASE-001-b):
 * 1. Build an IntentQuery from ctx via buildIntentCardQuery().
 * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
 * 3. If cosineDistance < threshold → registry-hit (return block identity).
 * 4. If no candidate beats threshold → synthesis-required (return skeleton).
 * 5. On registry error → passthrough (preserve normal IDE behaviour).
 *
 * @param registry  - Registry instance to query.
 * @param ctx       - Emission context from the IDE hook call.
 * @param options   - Must include threshold (resolved by the consumer factory).
 */
export async function executeRegistryQuery(
  registry: Registry,
  ctx: EmissionContext,
  options: { threshold: number },
): Promise<HookResponse> {
  const query = buildIntentCardQuery(ctx);

  try {
    const candidates = await registry.findCandidatesByIntent(query, { k: 1, rerank: "structural" });

    const best = candidates[0];
    if (best !== undefined && best.cosineDistance < options.threshold) {
      // Derive ContractId from the block's canonical spec bytes.
      // The ContractId is the spec-level identity: all blocks satisfying
      // the same spec share this id (DEC-IDENTITY-005).
      const id = contractIdFromBytes(best.block.specCanonicalBytes);
      return { kind: "registry-hit", id };
    }
  } catch {
    // Registry error: fall through to passthrough so the IDE works normally.
    return { kind: "passthrough" };
  }

  // No close-enough registry match — propose synthesis of a new block.
  return {
    kind: "synthesis-required",
    proposal: buildSkeletonSpec(ctx.intent),
  };
}
