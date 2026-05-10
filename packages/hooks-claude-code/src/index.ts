// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-FACADE-V0: The v0 hook was a passthrough facade.
// Status: SUPERSEDED by DEC-HOOK-CLAUDE-CODE-PROD-001 (WI-V1W2-HOOKS-01).
// Kept as a git-history anchor; the implementation below replaces it.

// @decision DEC-HOOK-CLAUDE-CODE-PROD-001
// title: Production-harden hooks-claude-code: registry-hit + synthesis-required paths
// status: decided (WI-V1W2-HOOKS-01); shared logic extracted to DEC-HOOK-BASE-001
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
//   - Shared types (EmissionContext, HookResponse, HookOptions, DEFAULT_REGISTRY_HIT_THRESHOLD)
//     and logic (executeRegistryQueryWithTelemetry, buildSkeletonSpec, writeMarkerCommand) are
//     now imported from @yakcc/hooks-base (DEC-HOOK-BASE-001). This package retains only the
//     Claude Code-specific branding: ClaudeCodeHook interface, registerSlashCommand method,
//     and the ~/.claude default markerDir.
//
// @decision DEC-HOOK-PHASE-1-001 (cross-reference)
// title: Telemetry wire-in — adapter calls executeRegistryQueryWithTelemetry
// status: accepted (WI-HOOK-PHASE-1 layer 2, closes #216 / #260)
// rationale:
//   Layer 1 (#216 layer 1) shipped executeRegistryQueryWithTelemetry in @yakcc/hooks-base
//   as a dormant wrapper. Layer 2 (this commit) re-points onCodeEmissionIntent() from the
//   bare executeRegistryQuery to executeRegistryQueryWithTelemetry so real Claude Code
//   sessions produce JSONL telemetry per D-HOOK-5.
//
//   The wrapper's signature differs from executeRegistryQuery in two ways:
//   (a) It requires toolName ("Edit" | "Write" | "MultiEdit") — a Claude Code-specific
//       concept that only this adapter knows. toolName is therefore threaded through
//       onCodeEmissionIntent(ctx, toolName) as a required argument.
//   (b) It accepts optional sessionId / telemetryDir in its options object for test
//       isolation. These are forwarded from ClaudeCodeHookOptions (extends HookOptions)
//       so tests can point telemetry at a tmpdir without touching ~/.yakcc/telemetry/.
//
//   Telemetry errors inside the wrapper are swallowed by the wrapper itself (observe-
//   don't-mutate guarantee from DEC-HOOK-PHASE-1-001). The adapter does not need to
//   handle them — if the wrapper throws for any other reason, the adapter propagates it
//   as a passthrough-equivalent failure, consistent with the error handling already
//   present for registry failures.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  type EmissionContext,
  type HookOptions,
  type HookResponse,
  executeRegistryQueryWithTelemetry,
  writeMarkerCommand,
} from "@yakcc/hooks-base";
import type { Registry } from "@yakcc/registry";

export type { EmissionContext, HookOptions, HookResponse };
export { DEFAULT_REGISTRY_HIT_THRESHOLD };

export type { ContractId } from "@yakcc/hooks-base";

// ---------------------------------------------------------------------------
// Slash-command marker file path
// ---------------------------------------------------------------------------

/** Filename for the /yakcc slash-command registration marker. */
export const SLASH_COMMAND_MARKER_FILENAME = "yakcc-slash-command.json";

// ---------------------------------------------------------------------------
// Claude Code-specific options
// ---------------------------------------------------------------------------

/**
 * Options for the Claude Code hook, extending the base HookOptions with
 * telemetry overrides needed for test isolation (DEC-HOOK-PHASE-1-001).
 *
 * sessionId and telemetryDir are forwarded to executeRegistryQueryWithTelemetry()
 * so integration tests can redirect JSONL output to a tmpdir rather than
 * ~/.yakcc/telemetry/. In production these are left undefined and the wrapper
 * falls back to CLAUDE_SESSION_ID / YAKCC_TELEMETRY_DIR env vars (or defaults).
 */
export interface ClaudeCodeHookOptions extends HookOptions {
  /**
   * Override the session ID used for the JSONL telemetry filename.
   * Production leaves this undefined; tests supply a fixed string for assertions.
   */
  readonly sessionId?: string | undefined;
  /**
   * Override the directory where JSONL telemetry files are written.
   * Production leaves this undefined; tests supply a tmpdir path.
   */
  readonly telemetryDir?: string | undefined;
}

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
   *
   * toolName identifies which Claude Code tool triggered the intercept
   * (Edit | Write | MultiEdit). It is required by executeRegistryQueryWithTelemetry
   * for D-HOOK-5 telemetry (DEC-HOOK-PHASE-1-001).
   */
  onCodeEmissionIntent(
    ctx: EmissionContext,
    toolName: "Edit" | "Write" | "MultiEdit",
  ): Promise<HookResponse>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ClaudeCodeHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CLAUDE-CODE-PROD-001, DEC-HOOK-PHASE-1-001):
 * - registerSlashCommand() writes ~/.claude/yakcc-slash-command.json as a
 *   registration marker for the /yakcc command. The Claude Code CLI extension
 *   API does not expose a direct Node.js registration surface (v1); the marker
 *   file is the stub registration until that API stabilises.
 * - onCodeEmissionIntent() delegates to executeRegistryQueryWithTelemetry() from
 *   @yakcc/hooks-base (DEC-HOOK-BASE-001, DEC-HOOK-PHASE-1-001) and returns
 *   registry-hit, synthesis-required, or passthrough (errors only).
 *   Each call also writes one TelemetryEvent to the session JSONL file (D-HOOK-5).
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold, marker directory, and telemetry overrides.
 */
export function createHook(registry: Registry, options?: ClaudeCodeHookOptions): ClaudeCodeHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".claude");
  const sessionId = options?.sessionId;
  const telemetryDir = options?.telemetryDir;

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
     * Delegates to writeMarkerCommand() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     */
    registerSlashCommand(): void {
      writeMarkerCommand(markerDir, SLASH_COMMAND_MARKER_FILENAME, {
        command: "/yakcc",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      });
    },

    /**
     * Determine how to respond to an emission intent and capture telemetry.
     *
     * Delegates to executeRegistryQueryWithTelemetry() from @yakcc/hooks-base
     * (DEC-HOOK-PHASE-1-001). Production sequence:
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. If no candidate beats threshold → synthesis-required (return skeleton).
     * 5. On registry error → passthrough (preserve normal Claude Code behaviour).
     * 6. Append one TelemetryEvent to <telemetryDir>/<sessionId>.jsonl (D-HOOK-5).
     *    Telemetry write failures are swallowed — observe-don't-mutate invariant.
     *
     * toolName is required because D-HOOK-5 captures it per event, and it is
     * known only by the IDE-specific adapter (DEC-HOOK-PHASE-1-001).
     */
    async onCodeEmissionIntent(
      ctx: EmissionContext,
      toolName: "Edit" | "Write" | "MultiEdit",
    ): Promise<HookResponse> {
      return executeRegistryQueryWithTelemetry(registry, ctx, toolName, {
        threshold,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(telemetryDir !== undefined ? { telemetryDir } : {}),
      });
    },
  };
}
