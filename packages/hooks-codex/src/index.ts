// @decision DEC-HOOK-CODEX-001
// title: @yakcc/hooks-codex — Codex CLI hook: interface shape, registration stub, threshold
// status: decided (WI-V1W2-HOOKS-03)
// rationale:
//   (a) Interface mirrors ClaudeCodeHook / CursorHook with a registerCommand() method
//       so all three IDE hooks share a parallel public surface. This makes cross-IDE
//       integration straightforward for Future Implementers and keeps the calling
//       convention consistent across the hooks-* family.
//   (b) registerCommand() writes a well-known marker file
//       (~/.yakcc/yakcc-codex-command.json) because the OpenAI Codex CLI does not
//       expose a stable Node.js extension-registration API as of v1. The marker file
//       approach is the same stub pattern used in hooks-claude-code (DEC-HOOK-CLAUDE-CODE-PROD-001).
//       Tracked for follow-up when the Codex CLI extension API stabilises: see backlog.
//   (c) REGISTRY_HIT_THRESHOLD defaults to 0.30, matching hooks-claude-code and
//       hooks-cursor. Cross-IDE threshold consistency avoids surprising divergence when
//       the same registry is shared across editors.
//   (d) Local type declarations (EmissionContext, HookResponse, HookOptions, ContractSpec)
//       duplicate those in the sister packages. This is intentional for v1 W1; a future
//       work item will consolidate shared types into a @yakcc/hooks-base package.

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
 * Matches hooks-claude-code and hooks-cursor for cross-IDE consistency.
 * See DEC-HOOK-CODEX-001(c).
 */
export const DEFAULT_REGISTRY_HIT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Emission context
// ---------------------------------------------------------------------------

/** Describes the context in which Codex CLI is about to emit code. */
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
 * - passthrough: defer to normal Codex CLI behaviour (reserved for errors only).
 */
export type HookResponse =
  | { readonly kind: "registry-hit"; readonly id: ContractId }
  | { readonly kind: "synthesis-required"; readonly proposal: ContractSpec }
  | { readonly kind: "passthrough" };

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Codex CLI hook interface. One instance is created per session and
 * wired into the Codex CLI extension via registerCommand().
 *
 * Mirrors the ClaudeCodeHook / CursorHook shape (DEC-HOOK-CODEX-001(a)).
 */
export interface CodexHook {
  /** Register the yakcc command with the Codex CLI harness. */
  registerCommand(): void;
  /**
   * Called when Codex CLI is about to emit code. Returns a HookResponse
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
   * Path to the directory where the command marker file is written.
   * Defaults to ~/.yakcc/. Override in tests to avoid touching the home directory.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Command marker file path
// ---------------------------------------------------------------------------

/** Filename for the yakcc command registration marker (Codex CLI). */
export const COMMAND_MARKER_FILENAME = "yakcc-codex-command.json";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CodexHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CODEX-001):
 * - registerCommand() writes ~/.yakcc/yakcc-codex-command.json as a
 *   registration marker for the yakcc command. The Codex CLI extension
 *   API does not expose a direct Node.js registration surface (v1); the marker
 *   file is the stub registration until that API stabilises.
 * - onCodeEmissionIntent() queries the registry via findCandidatesByIntent()
 *   and returns registry-hit, synthesis-required, or passthrough (errors only).
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold and marker directory overrides.
 */
export function createHook(registry: Registry, options?: HookOptions): CodexHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".yakcc");

  return {
    /**
     * Register the yakcc command with the Codex CLI harness.
     *
     * Codex CLI's command registration is not callable from Node.js as of v1 —
     * there is no stable extension registration API surface. This implementation
     * writes a well-known marker file to a Codex-specific directory
     * (~/.yakcc/yakcc-codex-command.json by default). The marker records the
     * command name, description, and registration timestamp.
     *
     * Acceptance: the registration call is defined and the marker file exists
     * after the call. Actual CLI command appearance requires a future Codex CLI
     * extension API (backlog). See DEC-HOOK-CODEX-001(b).
     *
     * NOTE: markerDir is created if it does not exist (idempotent).
     */
    registerCommand(): void {
      if (!existsSync(markerDir)) {
        mkdirSync(markerDir, { recursive: true });
      }
      const marker = {
        command: "yakcc",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      };
      const markerPath = join(markerDir, COMMAND_MARKER_FILENAME);
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf-8");
    },

    /**
     * Determine how to respond to an emission intent.
     *
     * Production sequence (DEC-HOOK-CODEX-001):
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. If no candidate beats threshold → synthesis-required (return skeleton).
     * 5. On registry error → passthrough (preserve normal Codex CLI behaviour).
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
        // Registry error: fall through to passthrough so Codex CLI works normally.
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
