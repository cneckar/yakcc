// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-BASE-001
// title: Extract @yakcc/hooks-base: shared types and logic for IDE hook packages
// status: decided (WI-V1W2-HOOKS-BASE)
// rationale:
//   (a) Consolidates the type and logic duplication that was intentionally deferred
//       in v1 W1/W2. DEC-HOOK-CURSOR-001 (d) and DEC-HOOK-CODEX-001 (d) both
//       flagged the local EmissionContext / HookResponse / HookOptions declarations
//       as temporary. This WI (WI-V1W2-HOOKS-BASE) performed that consolidation.
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
import type { CandidateMatch, Registry } from "@yakcc/registry";

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
 * Internal result shape returned by _executeRegistryQueryInternal().
 *
 * Carries both the public HookResponse and the candidate metadata needed by
 * the telemetry wrapper. Never exported — callers use executeRegistryQuery()
 * or executeRegistryQueryWithTelemetry().
 */
type RegistryQueryInternalResult = {
  readonly response: HookResponse;
  /** Number of candidates returned by findCandidatesByIntent (always 0 or 1 with k=1). */
  readonly candidateCount: number;
  /** Cosine distance of the top candidate, or null if none returned. */
  readonly topScore: number | null;
  /**
   * Full candidate list from findCandidatesByIntent.
   * Phase 1 callers ignore this; Phase 2 substitution uses it for the D2 gap check.
   * Always present (empty array when no candidates).
   */
  readonly candidates: readonly CandidateMatch[];
};

/**
 * Shared implementation of the registry query.
 *
 * Both executeRegistryQuery() and executeRegistryQueryWithTelemetry() delegate
 * here so candidate metadata is available to the telemetry wrapper without
 * duplicating the query logic.
 */
async function _executeRegistryQueryInternal(
  registry: Registry,
  ctx: EmissionContext,
  options: { threshold: number },
): Promise<RegistryQueryInternalResult> {
  const query = buildIntentCardQuery(ctx);

  try {
    // P1a: API-identity migration to symmetric findCandidatesByQuery (#535 / #523 plan).
    // Query card shape unchanged from previous IntentCard — behavior-only with topK:2.
    // Enrichment via queryIntentCardFromSource is P1b's job.
    const result = await registry.findCandidatesByQuery({
      behavior: query.behavior,
      topK: 2,
    });
    const candidates = result.candidates;

    const best = candidates[0];
    if (best !== undefined && best.cosineDistance < options.threshold) {
      // Derive ContractId from the block's canonical spec bytes.
      // The ContractId is the spec-level identity: all blocks satisfying
      // the same spec share this id (DEC-IDENTITY-005).
      const id = contractIdFromBytes(best.block.specCanonicalBytes);
      return {
        response: { kind: "registry-hit", id },
        candidateCount: candidates.length,
        topScore: best.cosineDistance,
        candidates,
      };
    }

    return {
      response: {
        kind: "synthesis-required",
        proposal: buildSkeletonSpec(ctx.intent),
      },
      candidateCount: candidates.length,
      topScore: best !== undefined ? best.cosineDistance : null,
      candidates,
    };
  } catch {
    // Registry error: fall through to passthrough so the IDE works normally.
    return { response: { kind: "passthrough" }, candidateCount: 0, topScore: null, candidates: [] };
  }
}

/**
 * Alias used by executeRegistryQueryWithSubstitution — same as the internal
 * function but the name makes the Phase 2 usage intent explicit.
 */
const _executeRegistryQueryInternalWithCandidates = _executeRegistryQueryInternal;

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
  const { response } = await _executeRegistryQueryInternal(registry, ctx, options);
  return response;
}

/**
 * Execute the registry query and capture telemetry for the emission event.
 *
 * @decision DEC-HOOK-PHASE-1-001
 * @title Telemetry wrapper around executeRegistryQuery — observe-don't-mutate
 * @status accepted
 * @rationale
 *   Phase 1 adds telemetry capture without altering the HookResponse shape.
 *   This wrapper:
 *   (1) times the full registry round-trip (D-HOOK-3 latency measurement),
 *   (2) calls _executeRegistryQueryInternal() to obtain both the response and
 *       candidate metadata needed by the D-HOOK-5 TelemetryEvent schema,
 *   (3) writes one TelemetryEvent to ~/.yakcc/telemetry/<session-id>.jsonl
 *       via captureTelemetry() (local-only, zero network I/O — B6 compliance),
 *   (4) returns the HookResponse UNCHANGED — the caller sees exactly what it
 *       would have seen from executeRegistryQuery().
 *
 *   toolName is required here (not in executeRegistryQuery) because D-HOOK-5
 *   captures it per event, and it is only known by the IDE-specific adapter
 *   that calls the wrapper.
 *
 *   Telemetry errors are swallowed: a disk-write failure must never degrade
 *   the hook's primary function. The call is fire-and-forget.
 *
 * Cross-reference: DEC-HOOK-LAYER-001 Phase 1, D-HOOK-5.
 *
 * @param registry   - Registry instance to query.
 * @param ctx        - Emission context from the IDE hook call.
 * @param toolName   - Claude Code tool that triggered this intercept.
 * @param options    - Must include threshold (resolved by the consumer factory).
 *                     Optional sessionId / telemetryDir override for tests.
 */
export async function executeRegistryQueryWithTelemetry(
  registry: Registry,
  ctx: EmissionContext,
  toolName: "Edit" | "Write" | "MultiEdit",
  options: {
    threshold: number;
    sessionId?: string | undefined;
    telemetryDir?: string | undefined;
  },
): Promise<HookResponse> {
  const start = Date.now();
  const { response, candidateCount, topScore } = await _executeRegistryQueryInternal(
    registry,
    ctx,
    options,
  );
  const latencyMs = Date.now() - start;

  try {
    // Import lazily to avoid circular references in tests that import only index.ts.
    const { captureTelemetry } = await import("./telemetry.js");
    // Spread only defined overrides — exactOptionalPropertyTypes rejects `key: undefined`
    // assignments to `key?: string` properties.
    captureTelemetry({
      intent: ctx.intent,
      toolName,
      response,
      candidateCount,
      topScore,
      latencyMs,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
  } catch {
    // Telemetry write failure must NOT affect the hook outcome (observe-don't-mutate).
  }

  return response;
}

// ---------------------------------------------------------------------------
// D-HOOK-3 latency budget constant
// ---------------------------------------------------------------------------

/**
 * Maximum end-to-end hook latency in milliseconds per D-HOOK-3.
 * When the full pipeline (discovery + substitution) exceeds this, the hook
 * falls through to the original code and emits a LATENCY_BUDGET_EXCEEDED
 * telemetry event.
 */
export const HOOK_LATENCY_BUDGET_MS = 200;

// ---------------------------------------------------------------------------
// executeRegistryQueryWithSubstitution (Phase 2 — L3)
// ---------------------------------------------------------------------------

/**
 * Execute the registry query, attempt Phase 2 substitution, and capture telemetry.
 *
 * @decision DEC-HOOK-PHASE-2-001
 * @title Phase 2 hook wrapper: substitution + telemetry extension
 * @status accepted
 * @rationale
 *   This wrapper extends executeRegistryQueryWithTelemetry (Phase 1) with:
 *   (1) Substitution attempt when the registry returns a high-confidence candidate
 *       per D2 auto-accept rule (combinedScore > 0.85 AND gap > 0.15).
 *   (2) Extended telemetry fields: substitutionLatencyMs, top1Score, top1Gap,
 *       latencyBudgetExceeded — added to the Phase 1 TelemetryEvent schema
 *       (backwards-compatible; old consumers see them as optional).
 *   (3) YAKCC_HOOK_DISABLE_SUBSTITUTE=1 escape hatch: bypasses substitution,
 *       falls through to Phase 1 observe-only behaviour.
 *   (4) D-HOOK-3 latency budget: when total pipeline time exceeds 200ms,
 *       latencyBudgetExceeded=true is recorded in telemetry AND the hook
 *       falls through to the original code (no async escape; the violation is
 *       a discovery-side bug per D-HOOK-3). The latency check happens after
 *       the substitution attempt so we always have a result to return.
 *
 *   @decision DEC-HOOK-ATOM-CAPTURE-001 (Phase 3 atomize extension)
 *   When substitution is NOT fired, this wrapper now attempts atomization:
 *   (5) atomizeEmission(originalCode, registry) — shape filter → shave pipeline
 *       → registry.storeBlock. B6-safe (static strategy, offline, no network).
 *   (6) If atomized: prepend `// @atom-new: <BMR[:8]> — yakcc:<name>` above the
 *       original code in the returned result (same placement as D-HOOK-4 contract
 *       comment). The ORIGINAL code is still used unchanged — only the comment is
 *       prepended. No substitution occurs.
 *   (7) Telemetry captures outcome="atomized" + atomsCreated=[BMR prefixes].
 *
 *   Observe-don't-mutate is preserved: substitution/atomize failure at any stage
 *   returns the original HookResponse unchanged; only successful substitution or
 *   atomization returns the modified response.
 *
 *   Cross-reference:
 *     DEC-HOOK-PHASE-1-001 (Phase 1 telemetry wrapper)
 *     DEC-HOOK-LAYER-001 (D-HOOK-2 tool-call rewrite, D-HOOK-3 latency)
 *     DEC-V3-DISCOVERY-D2-001 (auto-accept rule)
 *     DEC-V3-DISCOVERY-D3-001 (cornerstone #4: structural filter is binary)
 *     DEC-HOOK-ATOM-CAPTURE-001 (D-HOOK-7: atom-creation-on-emission)
 *
 * @param registry     - Registry instance to query.
 * @param ctx          - Emission context from the IDE hook call.
 * @param originalCode - The agent's emitted code (from the tool call new_string / content).
 * @param toolName     - Claude Code tool that triggered this intercept.
 * @param options      - threshold + optional sessionId / telemetryDir for tests.
 * @returns HookResponse (unchanged from Phase 1 shape) PLUS optional substitutedCode
 *          field when substitution occurred — callers must check for this field.
 */
export async function executeRegistryQueryWithSubstitution(
  registry: Registry,
  ctx: EmissionContext,
  originalCode: string,
  toolName: "Edit" | "Write" | "MultiEdit",
  options: {
    threshold: number;
    sessionId?: string | undefined;
    telemetryDir?: string | undefined;
  },
): Promise<HookResponseWithSubstitution> {
  const start = Date.now();

  // Run the registry query (rerank="structural" so structural filter gates candidates).
  const { response, candidateCount, topScore, candidates } =
    await _executeRegistryQueryInternalWithCandidates(registry, ctx, options);

  // Attempt substitution if not disabled.
  let substitutionResult: import("./substitute.js").SubstitutionResult | null = null;
  let substitutionLatencyMs: number | null = null;

  if (process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE !== "1") {
    const subStart = Date.now();
    try {
      const { executeSubstitution } = await import("./substitute.js");
      substitutionResult = await executeSubstitution(candidates, originalCode);
    } catch {
      // Substitution failure must not affect the hook outcome.
      substitutionResult = null;
    }
    substitutionLatencyMs = Date.now() - subStart;
  }

  const latencyMs = Date.now() - start;
  const latencyBudgetExceeded = latencyMs > HOOK_LATENCY_BUDGET_MS;

  // Build the output response — carry substituted bytes when substitution succeeded.
  const substituted = substitutionResult?.substituted === true;
  const atomHash = substituted && substitutionResult?.substituted
    ? (substitutionResult as import("./substitute.js").SubstitutionResult & { substituted: true }).atomHash
    : null;

  // ── Phase 3 / D-HOOK-7: atomize path ─────────────────────────────────────
  // When substitution did not fire, attempt to atomize the emission.
  // The atomize path is ADDITIVE — it never changes the response when it fails.
  // @decision DEC-HOOK-ATOM-CAPTURE-001
  let atomizeResult: import("./atomize.js").AtomizeResult | null = null;
  if (!substituted && originalCode.trim().length > 0 && process.env.YAKCC_HOOK_DISABLE_ATOMIZE !== "1") {
    try {
      const { atomizeEmission } = await import("./atomize.js");
      atomizeResult = await atomizeEmission({ emittedCode: originalCode, toolName, registry });
    } catch {
      // Atomize failure must not affect the hook outcome (observe-don't-mutate).
      atomizeResult = null;
    }
  }

  // Capture telemetry (fire-and-forget; errors swallowed).
  try {
    const { captureTelemetry } = await import("./telemetry.js");
    const { candidatesToCombinedScores } = await import("./substitute.js");
    const scores = candidatesToCombinedScores(candidates);
    const top1Score = scores[0] ?? null;
    const top2Score = scores[1] ?? 0;
    const top1Gap = top1Score !== null ? top1Score - top2Score : null;

    const didAtomize = atomizeResult?.atomized === true;
    const atomsBmrPrefixes = didAtomize && atomizeResult !== null
      ? atomizeResult.atomsCreated.map((a) => a.blockMerkleRoot.slice(0, 8))
      : undefined;

    captureTelemetry({
      intent: ctx.intent,
      toolName,
      response,
      candidateCount,
      topScore,
      latencyMs,
      substituted,
      substitutedAtomHash: atomHash,
      substitutionLatencyMs,
      top1Score,
      top1Gap,
      latencyBudgetExceeded,
      ...(didAtomize ? { outcomeOverride: "atomized" as const } : {}),
      ...(atomsBmrPrefixes !== undefined ? { atomsCreated: atomsBmrPrefixes } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.telemetryDir !== undefined ? { telemetryDir: options.telemetryDir } : {}),
    });
  } catch {
    // Telemetry write failure must NOT affect the hook outcome.
  }

  if (
    substituted &&
    substitutionResult !== null &&
    substitutionResult.substituted === true &&
    !latencyBudgetExceeded
  ) {
    return {
      ...response,
      substituted: true,
      substitutedCode: substitutionResult.substitutedCode,
      atomHash: substitutionResult.atomHash,
    };
  }

  // If atomization fired, prepend the @atom-new comment above the original code.
  // The original code is unchanged — the comment is purely informational for the agent.
  // @decision DEC-HOOK-ATOM-CAPTURE-001 (@atom-new comment placement)
  if (atomizeResult?.atomized === true && atomizeResult.atomsCreated.length > 0) {
    try {
      const { renderAtomNewComment } = await import("./atomize.js");
      const firstAtom = atomizeResult.atomsCreated[0];
      if (firstAtom !== undefined) {
        const comment = renderAtomNewComment(firstAtom.blockMerkleRoot, firstAtom.atomName);
        return {
          ...response,
          substituted: false,
          atomizedCode: `${comment}\n${originalCode}`,
          atomsCreated: atomizeResult.atomsCreated,
        };
      }
    } catch {
      // Comment rendering failure is non-fatal — fall through to plain passthrough.
    }
  }

  return { ...response, substituted: false };
}

/**
 * HookResponse extended with Phase 2 substitution and Phase 3 atomize information.
 *
 * The base HookResponse fields are unchanged (registry-hit | synthesis-required | passthrough).
 * Phase 2 adds substituted + optional substitutedCode + atomHash.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (additive atomize fields)
 * Phase 3 (D-HOOK-7) adds atomizedCode + atomsCreated to the non-substituted branch.
 * When atomized === false AND atomizedCode is undefined, the original code is used
 * unchanged (Phase 1 passthrough). When atomizedCode is defined, the caller should
 * prepend the @atom-new comment to the written output.
 *
 * Callers check `result.substituted` first; if true, `result.substitutedCode` contains
 * the rendered substitution. If false, check `result.atomizedCode` — if defined, the
 * @atom-new comment has been prepended; if undefined, passthrough (original code unchanged).
 */
export type HookResponseWithSubstitution = HookResponse & (
  | {
      readonly substituted: false;
      /** Present when the emission was atomized into the local registry (D-HOOK-7). */
      readonly atomizedCode?: string;
      /** Atoms created during atomization. Non-empty when atomizedCode is defined. */
      readonly atomsCreated?: ReadonlyArray<{
        readonly blockMerkleRoot: string;
        readonly atomName: string;
        readonly spec: { readonly name: string; readonly behavior: string };
      }>;
    }
  | { readonly substituted: true; readonly substitutedCode: string; readonly atomHash: string }
);

// ---------------------------------------------------------------------------
// Phase 3 L3 — yakccResolve MCP tool surface (D-HOOK-6 embedded library call)
// ---------------------------------------------------------------------------

export {
  yakccResolve,
  type ResolveResult,
  type EvidenceProjection,
  type DisambiguationHint,
  type HashLookup,
  STRONG_THRESHOLD,
  CONFIDENT_THRESHOLD,
  WEAK_THRESHOLD,
  HYBRID_AUTO_ACCEPT_THRESHOLD,
  AUTO_ACCEPT_GAP_THRESHOLD,
  DISAMBIGUATION_MIN_TIES,
  TIEBREAKER_EPSILON,
} from "./yakcc-resolve.js";

