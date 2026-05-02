// @decision DEC-HOOK-CURSOR-001
// title: Scaffold @yakcc/hooks-cursor: CursorHook interface + registry-backed emission handler
// status: decided (WI-V1W2-HOOKS-02)
// rationale:
//   (a) Interface shape mirrors ClaudeCodeHook from @yakcc/hooks-claude-code but uses
//       registerCommand() instead of registerSlashCommand() because Cursor's command
//       UX is different: commands in Cursor are registered as VS Code-style extension
//       contributions in package.json, not slash-commands in a chat harness. The name
//       change makes the distinction explicit so callers cannot accidentally swap the two.
//   (b) registerCommand() writes a marker file (~/.cursor/yakcc-cursor-command.json by
//       default) as a stub for command registration. The Cursor extension API is not
//       directly callable from Node.js — there is no stable Node registration surface
//       in v1. The marker-file pattern follows the same convention as hooks-claude-code.
//       Backlog: wire to actual VS Code extension activation events once Cursor exposes
//       a stable Node-callable registration API.
//   (c) onCodeEmissionIntent() threshold is 0.30 (DEFAULT_REGISTRY_HIT_THRESHOLD),
//       matching hooks-claude-code for consistency. All three response kinds
//       (registry-hit, synthesis-required, passthrough) map to the same semantics
//       as the sister package. A future consolidation WI may lift shared types into
//       a @yakcc/hooks-base package; for now duplication is acceptable per the plan.
//   (d) EmissionContext, HookResponse, and HookOptions are declared locally. The
//       dispatch task explicitly forbids importing from @yakcc/hooks-claude-code to
//       avoid creating sister-package dependency cycles. Structural type compatibility
//       with the sister package is maintained by intent (same field names/types).

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
 * Values > 0.70 indicate divergence. Values ≈ 1.0 are orthogonal.
 *
 * Matches hooks-claude-code threshold for cross-IDE consistency
 * (DEC-HOOK-CURSOR-001-c).
 */
export const DEFAULT_REGISTRY_HIT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Emission context
// ---------------------------------------------------------------------------

/** Describes the context in which Cursor is about to emit code. */
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
 * - passthrough: defer to normal Cursor behaviour (reserved for errors only).
 */
export type HookResponse =
  | { readonly kind: "registry-hit"; readonly id: ContractId }
  | { readonly kind: "synthesis-required"; readonly proposal: ContractSpec }
  | { readonly kind: "passthrough" };

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Cursor hook interface. One instance is created per session and wired
 * into the Cursor extension via registerCommand().
 *
 * Note: registerCommand() is named differently from hooks-claude-code's
 * registerSlashCommand() because Cursor's command registration model is
 * VS Code extension-based, not slash-command based (DEC-HOOK-CURSOR-001-a).
 */
export interface CursorHook {
  /** Register the yakcc command with the Cursor extension harness. */
  registerCommand(): void;
  /**
   * Called when Cursor is about to emit code. Returns a HookResponse
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
   * Path to the directory where the command-registration marker file is written.
   * Defaults to ~/.cursor/. Override in tests to avoid touching the home directory.
   */
  readonly markerDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Command marker file
// ---------------------------------------------------------------------------

/** Filename for the yakcc Cursor-command registration marker. */
export const CURSOR_COMMAND_MARKER_FILENAME = "yakcc-cursor-command.json";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CursorHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CURSOR-001):
 * - registerCommand() writes ~/.cursor/yakcc-cursor-command.json as a
 *   registration marker for the yakcc command. The Cursor extension API does
 *   not expose a direct Node.js registration surface (v1); the marker file is
 *   the stub registration until that API stabilises (DEC-HOOK-CURSOR-001-b).
 * - onCodeEmissionIntent() queries the registry via findCandidatesByIntent()
 *   and returns registry-hit, synthesis-required, or passthrough (errors only).
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold and marker directory overrides.
 */
export function createHook(registry: Registry, options?: HookOptions): CursorHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".cursor");

  return {
    /**
     * Register the yakcc command with the Cursor extension harness.
     *
     * Cursor's extension command registration is VS Code-based — commands are
     * declared in the extension manifest and activated via extension host events.
     * There is no stable Node.js-callable registration surface in v1 of the
     * Cursor extension API. This implementation writes a well-known marker file
     * to the Cursor settings directory (~/.cursor/yakcc-cursor-command.json by
     * default). The marker records the command id, description, and registration
     * timestamp.
     *
     * Acceptance: the registration call is defined and the marker file exists
     * after the call. Actual command appearance in Cursor requires wiring via
     * VS Code extension activation events (backlog — DEC-HOOK-CURSOR-001-b).
     *
     * NOTE: markerDir is created if it does not exist (idempotent).
     */
    registerCommand(): void {
      if (!existsSync(markerDir)) {
        mkdirSync(markerDir, { recursive: true });
      }
      const marker = {
        command: "yakcc.lookupOrSynthesize",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      };
      const markerPath = join(markerDir, CURSOR_COMMAND_MARKER_FILENAME);
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf-8");
    },

    /**
     * Determine how to respond to an emission intent.
     *
     * Production sequence (DEC-HOOK-CURSOR-001):
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. If no candidate beats threshold → synthesis-required (return skeleton).
     * 5. On registry error → passthrough (preserve normal Cursor behaviour).
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
        // Registry error: fall through to passthrough so Cursor works normally.
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
