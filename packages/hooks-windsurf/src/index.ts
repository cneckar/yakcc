// SPDX-License-Identifier: MIT
// @decision DEC-HOOK-WINDSURF-001
// title: Scaffold @yakcc/hooks-windsurf: WindsurfHook interface + registry-backed emission handler
// status: decided (WI-687-S3); mirrors DEC-HOOK-CURSOR-001 / DEC-HOOK-CURSOR-PHASE4-001
// rationale:
//   (a) Interface shape mirrors CursorHook from @yakcc/hooks-cursor but uses
//       registerCommand() with windsurf-specific defaults: markerDir defaults to
//       ~/.windsurf/, marker filename is "yakcc-windsurf-hook.json". This keeps
//       the windsurf marker file distinct from cursor/claude-code markers so all
//       three can coexist in their respective settings directories without collision.
//   (b) registerCommand() writes ~/.windsurf/yakcc-windsurf-hook.json as a stub
//       for command registration. Windsurf's extension API (VS Code-based) does not
//       currently expose a Node.js-callable synchronous tool-call interception
//       surface in v1. The marker-file pattern follows the same convention as
//       hooks-cursor and hooks-claude-code.
//       Backlog: wire to actual VS Code extension activation events once Windsurf
//       exposes a stable Node-callable registration API.
//   (c) onCodeEmissionIntent() threshold is 0.30 (DEFAULT_REGISTRY_HIT_THRESHOLD),
//       matching hooks-cursor and hooks-claude-code for consistency. All three
//       response kinds (registry-hit, synthesis-required, passthrough) map to the
//       same semantics as the sister packages.
//   (d) EmissionContext, HookResponse, HookOptions, DEFAULT_REGISTRY_HIT_THRESHOLD,
//       executeRegistryQueryWithSubstitution, and writeMarkerCommand are imported from
//       @yakcc/hooks-base (DEC-HOOK-BASE-001). This package retains only the
//       Windsurf-specific branding: WindsurfHook interface, registerCommand method,
//       and the ~/.windsurf default markerDir.
//   (e) Telemetry prefix is "windsurf-<session-id>" to distinguish windsurf sessions
//       from cursor-<session-id> and claude-code-<session-id> in B3/B4/B5 analysis.
//       Session ID is read from WINDSURF_SESSION_ID env var (set by Windsurf's
//       subprocess environment, analogous to CURSOR_SESSION_ID for Cursor).

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

/** Filename for the yakcc Windsurf-command registration marker. */
export const WINDSURF_COMMAND_MARKER_FILENAME = "yakcc-windsurf-hook.json";

// ---------------------------------------------------------------------------
// Windsurf-specific options
// ---------------------------------------------------------------------------

/**
 * Options for the Windsurf hook, extending the base HookOptions with
 * telemetry overrides needed for test isolation (DEC-HOOK-WINDSURF-001-e).
 *
 * sessionId and telemetryDir are forwarded to executeRegistryQueryWithSubstitution()
 * so integration tests can redirect JSONL output to a tmpdir rather than
 * ~/.yakcc/telemetry/. In production these are left undefined and the wrapper
 * falls back to resolveWindsurfSessionId() / YAKCC_TELEMETRY_DIR env var (or defaults).
 */
export interface WindsurfHookOptions extends HookOptions {
  /**
   * Override the session ID used for the JSONL telemetry filename.
   * Production leaves this undefined; tests supply a fixed string for assertions.
   * When undefined, resolveWindsurfSessionId() is used (yields "windsurf-<base-id>").
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
 * Process-scoped fallback session ID for windsurf, generated once.
 * Mirrors the pattern in @yakcc/hooks-cursor but separate so
 * windsurf sessions never share a file with cursor or claude-code sessions.
 */
const WINDSURF_FALLBACK_SESSION_ID: string = (() => {
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
 * Resolve the session ID for a Windsurf hook process, always prefixed with "windsurf-".
 *
 * Reads WINDSURF_SESSION_ID env var (set by Windsurf's subprocess environment when
 * launching hook processes, analogous to CURSOR_SESSION_ID for Cursor).
 * Falls back to WINDSURF_FALLBACK_SESSION_ID so all events within a process share
 * one file even when the env var is absent (e.g. during development).
 *
 * The "windsurf-" prefix distinguishes windsurf telemetry files from cursor and
 * claude-code files in the shared ~/.yakcc/telemetry/ directory (DEC-HOOK-WINDSURF-001-e).
 */
export function resolveWindsurfSessionId(): string {
  const base = process.env.WINDSURF_SESSION_ID ?? WINDSURF_FALLBACK_SESSION_ID;
  return `windsurf-${base}`;
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

/**
 * The Windsurf hook interface. One instance is created per session and wired
 * into the Windsurf extension via registerCommand().
 *
 * Note: registerCommand() mirrors the Cursor adapter's API — Windsurf's command
 * registration model is also VS Code extension-based (DEC-HOOK-WINDSURF-001-a).
 *
 * onCodeEmissionIntent() accepts toolName and originalCode to enable substitution
 * and telemetry, matching the Cursor adapter's Phase 4 parity surface.
 * toolName maps Windsurf operations to the shared telemetry schema tool names.
 */
export interface WindsurfHook {
  /** Register the yakcc command with the Windsurf extension harness. */
  registerCommand(): void;
  /**
   * Called when Windsurf is about to emit code. Returns a HookResponseWithSubstitution
   * indicating whether to use an existing block, synthesise a new one, or
   * fall through to normal behaviour. Also captures telemetry per D-HOOK-5.
   *
   * toolName maps the Windsurf VS Code operation to the shared telemetry schema:
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
 * Create a WindsurfHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-WINDSURF-001):
 * - registerCommand() writes ~/.windsurf/yakcc-windsurf-hook.json as a
 *   registration marker for the yakcc command.
 * - onCodeEmissionIntent() delegates to executeRegistryQueryWithSubstitution()
 *   from @yakcc/hooks-base, capturing telemetry to windsurf-<session-id>.jsonl
 *   in the telemetry directory.
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold, marker directory, and telemetry overrides.
 */
export function createHook(registry: Registry, options?: WindsurfHookOptions): WindsurfHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".windsurf");
  const sessionId = options?.sessionId;
  const telemetryDir = options?.telemetryDir;

  return {
    /**
     * Register the yakcc command with the Windsurf extension harness.
     *
     * Windsurf's extension command registration is VS Code-based — commands are
     * declared in the extension manifest and activated via extension host events.
     * There is no stable Node.js-callable registration surface in v1 of the
     * Windsurf extension API. This implementation writes a well-known marker file
     * to the Windsurf settings directory (~/.windsurf/yakcc-windsurf-hook.json by
     * default). The marker records the command id, description, and registration
     * timestamp.
     *
     * NOTE: markerDir is created if it does not exist (idempotent).
     * Delegates to writeMarkerCommand() from @yakcc/hooks-base (DEC-HOOK-BASE-001).
     */
    registerCommand(): void {
      writeMarkerCommand(markerDir, WINDSURF_COMMAND_MARKER_FILENAME, {
        command: "yakcc.lookupOrSynthesize",
        description: "Look up or synthesise a yakcc contract block for the current intent",
        registeredAt: new Date().toISOString(),
      });
    },

    /**
     * Determine how to respond to an emission intent, attempt substitution,
     * and capture telemetry to windsurf-<session-id>.jsonl (DEC-HOOK-WINDSURF-001-e).
     *
     * Delegates to executeRegistryQueryWithSubstitution() from @yakcc/hooks-base.
     * Production sequence:
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=2, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. Apply D2 auto-accept rule: top-1 combinedScore > 0.85 AND gap > 0.15.
     * 5. If D2 passes: extract binding from originalCode, render substitution.
     * 6. If no candidate beats threshold → synthesis-required (return skeleton).
     * 7. On registry error → passthrough (preserve normal Windsurf behaviour).
     * 8. Append one TelemetryEvent to <telemetryDir>/windsurf-<sessionId>.jsonl (D-HOOK-5).
     *    Windsurf prefix distinguishes from cursor and claude-code sessions in
     *    B3/B4/B5 analysis.
     */
    async onCodeEmissionIntent(
      ctx: EmissionContext,
      toolName: "Edit" | "Write" | "MultiEdit",
      originalCode = "",
    ): Promise<HookResponseWithSubstitution> {
      // Resolve the windsurf-prefixed session ID when no override is provided.
      const resolvedSessionId = sessionId ?? resolveWindsurfSessionId();
      return executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, {
        threshold,
        sessionId: resolvedSessionId,
        ...(telemetryDir !== undefined ? { telemetryDir } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// yakcc_resolve MCP tool surface (Windsurf adapter)
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
