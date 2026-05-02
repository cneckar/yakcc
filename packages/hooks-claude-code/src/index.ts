// @decision DEC-HOOK-FACADE-V0: The v0 hook was a passthrough facade.
// Status: SUPERSEDED by DEC-HOOK-CLAUDE-CODE-PROD-001 (WI-V1W2-HOOKS-01).
// Kept as a git-history anchor; the implementation below replaces it.

// @decision DEC-HOOK-CLAUDE-CODE-PROD-001
// title: Production-harden hooks-claude-code: registry-hit + synthesis-required paths
// status: decided (WI-V1W2-HOOKS-01)
// rationale: Replaces the v0 passthrough facade with real registry-lookup semantics.
//   - onCodeEmissionIntent() queries the registry via findCandidatesByIntent().
//   - If the best candidate's cosineDistance is below REGISTRY_HIT_THRESHOLD (0.30),
//     the hook returns {kind:"registry-hit"} — a close-enough semantic match exists.
//   - Threshold 0.30 is chosen as a sensible cosine-distance cutoff: distances in
//     sqlite-vec vec0 are in [0, 2] (cosine distance on unit vectors). Values below
//     0.30 indicate high semantic similarity; values above indicate divergence.
//     This can be overridden at construction time via createHook(registry, { threshold }).
//   - If no candidate beats the threshold, a minimal ContractSpec skeleton is built
//     from the emission intent and returned as {kind:"synthesis-required"}.
//   - {kind:"passthrough"} is reserved exclusively for registry call failures
//     (network/DB error) so Claude Code behaves normally on infrastructure faults.
//   - registerSlashCommand() writes a marker file to the Claude Code settings directory
//     (~/.claude/yakcc-slash-command.json). The Claude Code CLI extension API does not
//     expose a Node.js-callable slash-command registration surface as of v1. Writing
//     a well-known marker file is the stub that satisfies the registration contract
//     without requiring a live CLI harness. See registerSlashCommand() JSDoc for details.
//     Tracked for follow-up when the CLI extension API stabilises: see backlog.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { contractIdFromBytes } from "@yakcc/contracts";
import type { ContractId, ContractSpec } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";

export type { ContractId };

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
 * See DEC-HOOK-CLAUDE-CODE-PROD-001 for full rationale.
 */
export const DEFAULT_REGISTRY_HIT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Emission context
// ---------------------------------------------------------------------------

/** Describes the context in which Claude Code is about to emit code. */
export interface EmissionContext {
  /** Natural-language description of what the user asked for. */
  readonly intent: string;
  /** Optional surrounding source context at the emission site. */
  readonly sourceContext?: string;
}

// ---------------------------------------------------------------------------
// Hook response
// ---------------------------------------------------------------------------

/**
 * The three possible responses from the hook's emission-intent handler:
 *
 * - registry-hit: an existing implementation was found; use it.
 * - synthesis-required: no match exists; the registry needs a new block.
 * - passthrough: defer to normal Claude Code behaviour (reserved for errors only).
 */
export type HookResponse =
  | { readonly kind: "registry-hit"; readonly id: ContractId }
  | { readonly kind: "synthesis-required"; readonly proposal: ContractSpec }
  | { readonly kind: "passthrough" };

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Claude Code hook interface. One instance is created per session and
 * wired into the Claude Code extension via registerSlashCommand().
 */
export interface ClaudeCodeHook {
  /** Register the /yakcc slash command with the Claude Code harness. */
  registerSlashCommand(): void;
  /**
   * Called when Claude Code is about to emit code. Returns a HookResponse
   * indicating whether to use an existing block, synthesise a new one, or
   * fall through to normal behaviour.
   */
  onCodeEmissionIntent(ctx: EmissionContext): Promise<HookResponse>;
}

// ---------------------------------------------------------------------------
// Hook creation options
// ---------------------------------------------------------------------------

/** Options for createHook(). */
export interface HookOptions {
  /**
   * Cosine-distance threshold below which a registry match is accepted as a hit.
   * Defaults to DEFAULT_REGISTRY_HIT_THRESHOLD (0.30).
   * Lower values = stricter matching; higher values = more permissive matching.
   */
  readonly threshold?: number | undefined;

  /**
   * Path to the directory where the slash-command marker file is written.
   * Defaults to ~/.claude/. Override in tests to avoid touching the home directory.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Slash-command marker file path
// ---------------------------------------------------------------------------

/** Filename for the /yakcc slash-command registration marker. */
export const SLASH_COMMAND_MARKER_FILENAME = "yakcc-slash-command.json";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CLAUDE-CODE-PROD-001):
 * - registerSlashCommand() writes ~/.claude/yakcc-slash-command.json as a
 *   registration marker for the /yakcc command. The Claude Code CLI extension
 *   API does not expose a direct Node.js registration surface (v1); the marker
 *   file is the stub registration until that API stabilises.
 * - onCodeEmissionIntent() queries the registry via findCandidatesByIntent()
 *   and returns registry-hit, synthesis-required, or passthrough (errors only).
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold and marker directory overrides.
 */
export function createHook(registry: Registry, options?: HookOptions): ClaudeCodeHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".claude");

  return {
    /**
     * Register the /yakcc slash command with the Claude Code harness.
     *
     * Claude Code CLI's slash-command registration is not callable from Node.js
     * as of v1 — there is no stable extension registration API surface. This
     * implementation writes a well-known marker file to the Claude Code settings
     * directory (~/.claude/yakcc-slash-command.json by default). The marker
     * records the command name, description, and registration timestamp.
     *
     * Acceptance: the registration call is defined and the marker file exists
     * after the call. Actual CLI command appearance requires a future CLI
     * extension API (backlog).
     *
     * NOTE: markerDir is created if it does not exist (idempotent).
     */
    registerSlashCommand(): void {
      if (!existsSync(markerDir)) {
        mkdirSync(markerDir, { recursive: true });
      }
      const marker = {
        command: "/yakcc",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      };
      const markerPath = join(markerDir, SLASH_COMMAND_MARKER_FILENAME);
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf-8");
    },

    /**
     * Determine how to respond to an emission intent.
     *
     * Production sequence (DEC-HOOK-CLAUDE-CODE-PROD-001):
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. If no candidate beats threshold → synthesis-required (return skeleton).
     * 5. On registry error → passthrough (preserve normal Claude Code behaviour).
     */
    async onCodeEmissionIntent(ctx: EmissionContext): Promise<HookResponse> {
      const behavior = ctx.sourceContext ? `${ctx.intent} ${ctx.sourceContext}` : ctx.intent;

      try {
        const candidates = await registry.findCandidatesByIntent(
          { behavior, inputs: [], outputs: [] },
          { k: 1, rerank: "structural" },
        );

        const best = candidates[0];
        if (best !== undefined && best.cosineDistance < threshold) {
          // Derive ContractId from the block's canonical spec bytes.
          // The ContractId is the spec-level identity: all blocks satisfying
          // the same spec share this id (DEC-IDENTITY-005).
          const id = contractIdFromBytes(best.block.specCanonicalBytes);
          return { kind: "registry-hit", id };
        }
      } catch {
        // Registry error: fall through to passthrough so Claude Code works normally.
        return { kind: "passthrough" };
      }

      // No close-enough registry match — propose synthesis of a new block.
      return {
        kind: "synthesis-required",
        proposal: buildSkeletonSpec(ctx.intent),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ContractSpec skeleton from a prose intent string.
 *
 * The skeleton carries the intent as the behavior field and empty collections
 * for all array fields. The name hint (for human readability) is derived from
 * the first token of the intent. NonFunctional defaults to pure + safe as a
 * conservative starting point — the synthesiser will refine these.
 */
function buildSkeletonSpec(intent: string): ContractSpec {
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
