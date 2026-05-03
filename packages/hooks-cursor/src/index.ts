// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-CURSOR-001
// title: Scaffold @yakcc/hooks-cursor: CursorHook interface + registry-backed emission handler
// status: decided (WI-V1W2-HOOKS-02); shared logic extracted to DEC-HOOK-BASE-001
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
//       as the sister package.
//   (d) EmissionContext, HookResponse, HookOptions, DEFAULT_REGISTRY_HIT_THRESHOLD,
//       executeRegistryQuery, and writeMarkerCommand are now imported from
//       @yakcc/hooks-base (DEC-HOOK-BASE-001). This package retains only the
//       Cursor-specific branding: CursorHook interface, registerCommand method,
//       and the ~/.cursor default markerDir.

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
// Command marker file
// ---------------------------------------------------------------------------

/** Filename for the yakcc Cursor-command registration marker. */
export const CURSOR_COMMAND_MARKER_FILENAME = "yakcc-cursor-command.json";

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
 * - onCodeEmissionIntent() delegates to executeRegistryQuery() from
 *   @yakcc/hooks-base (DEC-HOOK-BASE-001) and returns registry-hit,
 *   synthesis-required, or passthrough (errors only).
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
     * Delegates to writeMarkerCommand() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     */
    registerCommand(): void {
      writeMarkerCommand(markerDir, CURSOR_COMMAND_MARKER_FILENAME, {
        command: "yakcc.lookupOrSynthesize",
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
     * 5. On registry error → passthrough (preserve normal Cursor behaviour).
     */
    async onCodeEmissionIntent(ctx: EmissionContext): Promise<HookResponse> {
      return executeRegistryQuery(registry, ctx, { threshold });
    },
  };
}
