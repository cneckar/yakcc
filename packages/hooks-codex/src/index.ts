// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-CODEX-001
// title: @yakcc/hooks-codex — Codex CLI hook: interface shape, registration stub, threshold
// status: decided (WI-V1W2-HOOKS-03); shared logic extracted to DEC-HOOK-BASE-001
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
//   (d) EmissionContext, HookResponse, HookOptions, DEFAULT_REGISTRY_HIT_THRESHOLD,
//       executeRegistryQuery, and writeMarkerCommand are now imported from
//       @yakcc/hooks-base (DEC-HOOK-BASE-001). This package retains only the
//       Codex-specific branding: CodexHook interface, registerCommand method,
//       and the ~/.yakcc default markerDir.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  type EmissionContext,
  type HookOptions,
  type HookResponse,
  executeRegistryQuery,
  writeMarkerCommand,
} from "@yakcc/hooks-base";
import type { Registry } from "@yakcc/registry";

export type { EmissionContext, HookOptions, HookResponse };
export { DEFAULT_REGISTRY_HIT_THRESHOLD };

export type { ContractId } from "@yakcc/hooks-base";

// ---------------------------------------------------------------------------
// Command marker file path
// ---------------------------------------------------------------------------

/** Filename for the yakcc command registration marker (Codex CLI). */
export const COMMAND_MARKER_FILENAME = "yakcc-codex-command.json";

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
 * - onCodeEmissionIntent() delegates to executeRegistryQuery() from
 *   @yakcc/hooks-base (DEC-HOOK-BASE-001) and returns registry-hit,
 *   synthesis-required, or passthrough (errors only).
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
     * Delegates to writeMarkerCommand() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     */
    registerCommand(): void {
      writeMarkerCommand(markerDir, COMMAND_MARKER_FILENAME, {
        command: "yakcc",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      });
    },

    /**
     * Determine how to respond to an emission intent.
     *
     * Delegates to executeRegistryQuery() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     * Production sequence:
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=1, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. If no candidate beats threshold → synthesis-required (return skeleton).
     * 5. On registry error → passthrough (preserve normal Codex CLI behaviour).
     */
    async onCodeEmissionIntent(ctx: EmissionContext): Promise<HookResponse> {
      return executeRegistryQuery(registry, ctx, { threshold });
    },
  };
}
