// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-CLINE-001
// title: Scaffold @yakcc/hooks-cline: ClineHook interface + registry-backed emission handler
// status: decided (wi-687-s2-cline); mirrors DEC-HOOK-CURSOR-001 with cline-specific deltas
// rationale:
//   (a) Interface shape mirrors CursorHook from @yakcc/hooks-cursor. Both adapters use
//       registerCommand() because neither Cursor nor Cline exposes a slash-command
//       registration surface — both use VS Code extension-style commands.
//       The shared name makes the parallel explicit for callers who use both adapters.
//   (b) registerCommand() writes a marker file (~/.config/cline/yakcc-cline-command.json
//       by default) as a stub for command registration. The Cline extension API is not
//       directly callable from Node.js. The marker-file pattern follows the same
//       convention as hooks-cursor.
//       Two-marker cohabitation: the CLI-install command writes a separate marker
//       "yakcc-cline-hook.json" (DEC-HOOK-CLINE-MARKER-NAMESPACE). These are distinct
//       files in the same directory and must not collide.
//   (c) onCodeEmissionIntent() threshold is 0.30 (DEFAULT_REGISTRY_HIT_THRESHOLD),
//       matching hooks-cursor for cross-IDE consistency.
//   (d) EmissionContext, HookResponse, HookOptions, DEFAULT_REGISTRY_HIT_THRESHOLD,
//       executeRegistryQueryWithSubstitution, and writeMarkerCommand are imported from
//       @yakcc/hooks-base (DEC-HOOK-BASE-001). This package retains only the
//       Cline-specific branding: ClineHook interface, registerCommand method,
//       ~/.config/cline default markerDir, and CLINE_SESSION_ID telemetry prefix.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  type EmissionContext,
  type HookOptions,
  type HookResponse,
  type HookResponseWithSubstitution,
  executeRegistryQueryWithSubstitution,
  writeMarkerCommand,
} from "@yakcc/hooks-base";
import type { Registry } from "@yakcc/registry";

export type { EmissionContext, HookOptions, HookResponse, HookResponseWithSubstitution };
export { DEFAULT_REGISTRY_HIT_THRESHOLD };

export type { ContractId } from "@yakcc/hooks-base";

// ---------------------------------------------------------------------------
// Command marker file
// ---------------------------------------------------------------------------

/**
 * Filename for the yakcc Cline-command registration marker.
 *
 * Distinct from the CLI-install marker "yakcc-cline-hook.json"
 * (DEC-HOOK-CLINE-MARKER-NAMESPACE). Both files live in ~/.config/cline/ and
 * must not collide.
 */
export const CLINE_COMMAND_MARKER_FILENAME = "yakcc-cline-command.json";

// ---------------------------------------------------------------------------
// Cline-specific options
// ---------------------------------------------------------------------------

/**
 * Options for the Cline hook, extending the base HookOptions with
 * telemetry overrides needed for test isolation.
 *
 * sessionId and telemetryDir are forwarded to executeRegistryQueryWithSubstitution()
 * so integration tests can redirect JSONL output to a tmpdir rather than
 * ~/.yakcc/telemetry/. In production these are left undefined and the wrapper
 * falls back to resolveClineSessionId() / YAKCC_TELEMETRY_DIR env var (or defaults).
 */
export interface ClineHookOptions extends HookOptions {
  /**
   * Override the session ID used for the JSONL telemetry filename.
   * Production leaves this undefined; tests supply a fixed string for assertions.
   * When undefined, resolveClineSessionId() is used (yields "cline-<base-id>").
   */
  readonly sessionId?: string | undefined;
  /**
   * Override the directory where JSONL telemetry files are written.
   * Production leaves this undefined; tests supply a tmpdir path.
   */
  readonly telemetryDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Session ID resolution (per-IDE prefix)
// ---------------------------------------------------------------------------

/**
 * Process-scoped fallback session ID for cline, generated once.
 * Mirrors the pattern in @yakcc/hooks-cursor but separate so cline sessions
 * never share a file with cursor or claude-code sessions.
 */
const CLINE_FALLBACK_SESSION_ID: string = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
})();

/**
 * Resolve the session ID for a Cline hook process, always prefixed with "cline-".
 *
 * Reads CLINE_SESSION_ID env var (set by Cline's subprocess environment when
 * launching hook processes, analogous to CURSOR_SESSION_ID for Cursor).
 * Falls back to CLINE_FALLBACK_SESSION_ID so all events within a process share
 * one file even when the env var is absent (e.g. during development).
 *
 * The "cline-" prefix distinguishes cline telemetry files from cursor and
 * claude-code files in the shared ~/.yakcc/telemetry/ directory.
 */
export function resolveClineSessionId(): string {
  const base = process.env.CLINE_SESSION_ID ?? CLINE_FALLBACK_SESSION_ID;
  return `cline-${base}`;
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Cline hook interface. One instance is created per session and wired
 * into the Cline extension via registerCommand().
 *
 * Note: registerCommand() is named the same as hooks-cursor because Cline's
 * command registration model is also VS Code extension-based, not
 * slash-command based (DEC-HOOK-CLINE-001-a).
 *
 * onCodeEmissionIntent() accepts toolName and originalCode to enable
 * substitution and telemetry, matching hooks-cursor Phase 4 parity.
 * toolName maps Cline operations to the shared telemetry schema tool names.
 */
export interface ClineHook {
  /** Register the yakcc command with the Cline extension harness. */
  registerCommand(): void;
  /**
   * Called when Cline is about to emit code. Returns a HookResponseWithSubstitution
   * indicating whether to use an existing block, synthesise a new one, or
   * fall through to normal behaviour. Also captures telemetry per D-HOOK-5.
   *
   * toolName maps the Cline VS Code operation to the shared telemetry schema:
   *   "Edit"      — inline edit at cursor position
   *   "Write"     — full file generation
   *   "MultiEdit" — multi-file operation
   *
   * originalCode is the agent's emitted code (content from the VS Code edit operation).
   * When provided, the hook attempts substitution per D2 auto-accept rule.
   * Omitting originalCode skips substitution gracefully (substituted=false).
   *
   * Check result.substituted to determine if substitution occurred:
   *   result.substituted === true  → use result.substitutedCode instead of originalCode
   *   result.substituted === false → use originalCode unchanged
   */
  onCodeEmissionIntent(
    ctx: EmissionContext,
    toolName: "Edit" | "Write" | "MultiEdit",
    originalCode?: string,
  ): Promise<HookResponseWithSubstitution>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ClineHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CLINE-001):
 * - registerCommand() writes ~/.config/cline/yakcc-cline-command.json as a
 *   registration marker for the yakcc command.
 * - onCodeEmissionIntent() delegates to executeRegistryQueryWithSubstitution()
 *   from @yakcc/hooks-base, capturing telemetry to cline-<session-id>.jsonl
 *   in the telemetry directory.
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold, marker directory, and telemetry overrides.
 */
export function createHook(registry: Registry, options?: ClineHookOptions): ClineHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".config", "cline");
  const sessionId = options?.sessionId;
  const telemetryDir = options?.telemetryDir;

  return {
    /**
     * Register the yakcc command with the Cline extension harness.
     *
     * Cline's extension command registration is VS Code-based. There is no
     * stable Node.js-callable registration surface. This implementation writes
     * a well-known marker file to the Cline settings directory
     * (~/.config/cline/yakcc-cline-command.json by default). The marker records
     * the command id, description, and registration timestamp.
     *
     * NOTE: markerDir is created if it does not exist (idempotent).
     * Delegates to writeMarkerCommand() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     * See DEC-HOOK-CLINE-MARKER-NAMESPACE for the two-marker cohabitation contract.
     */
    registerCommand(): void {
      writeMarkerCommand(markerDir, CLINE_COMMAND_MARKER_FILENAME, {
        command: "yakcc.lookupOrSynthesize",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      });
    },

    /**
     * Determine how to respond to an emission intent, attempt Phase 2 substitution,
     * and capture telemetry to cline-<session-id>.jsonl.
     *
     * Delegates to executeRegistryQueryWithSubstitution() from @yakcc/hooks-base.
     * Production sequence:
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=2, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. Apply D2 auto-accept rule: top-1 combinedScore > 0.85 AND gap > 0.15.
     * 5. If D2 passes: extract binding from originalCode, render substitution.
     * 6. If no candidate beats threshold → synthesis-required (return skeleton).
     * 7. On registry error → passthrough (preserve normal Cline behaviour).
     * 8. Append one TelemetryEvent to <telemetryDir>/cline-<sessionId>.jsonl (D-HOOK-5).
     *    Cline prefix distinguishes from cursor/claude-code sessions in B3/B4/B5 analysis.
     */
    async onCodeEmissionIntent(
      ctx: EmissionContext,
      toolName: "Edit" | "Write" | "MultiEdit",
      originalCode = "",
    ): Promise<HookResponseWithSubstitution> {
      const resolvedSessionId = sessionId ?? resolveClineSessionId();
      return executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, {
        threshold,
        sessionId: resolvedSessionId,
        ...(telemetryDir !== undefined ? { telemetryDir } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// yakcc_resolve MCP tool surface (Cline adapter)
// ---------------------------------------------------------------------------

export {
  createYakccResolveTool,
  type YakccResolveTool,
  type YakccResolveToolArgs,
  type CreateYakccResolveToolOptions,
  RESOLVE_TOOL_MARKER_FILENAME,
  DEFAULT_REGISTRY_PATH,
  SYSTEM_PROMPT_PATH,
} from "./yakcc-resolve-tool.js";
