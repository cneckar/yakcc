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

// @decision DEC-HOOK-CURSOR-PHASE4-001
// title: Phase 4 wire-in — cursor adapter calls executeRegistryQueryWithSubstitution
// status: accepted (WI-HOOK-PHASE-4-CURSOR, closes #219)
// rationale:
//   Phase 4 brings hooks-cursor to feature parity with hooks-claude-code post-Phase-3:
//   (A) SUBSTITUTION: onCodeEmissionIntent() now delegates to
//       executeRegistryQueryWithSubstitution() (same as claude-code Phase 2).
//       toolName and originalCode parameters added for the D2 auto-accept gate.
//       toolName maps Cursor's VS Code operations to the telemetry schema:
//         Cursor inline edits     → "Edit"
//         Cursor full-file writes → "Write"
//         Cursor multi-file ops   → "MultiEdit"
//       Mapping documented here because cursor tool names differ from Claude Code
//       tool names, but the shared telemetry schema uses the claude-code names.
//   (B) TELEMETRY: Cursor sessions write to cursor-<session-id>.jsonl to distinguish
//       them from claude-code-<session-id>.jsonl in B3/B4/B5 measurements.
//       resolveCursorSessionId() reads CURSOR_SESSION_ID env var (set by Cursor
//       subprocess environment) and prefixes the result with "cursor-".
//   (C) YAKCC_RESOLVE: Phase 3 yakcc_resolve MCP tool surface is now available in
//       hooks-cursor via the companion yakcc-resolve-tool.ts module (same pattern
//       as hooks-claude-code, cursor-specific markerDir and filename).

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

/** Filename for the yakcc Cursor-command registration marker. */
export const CURSOR_COMMAND_MARKER_FILENAME = "yakcc-cursor-command.json";

// ---------------------------------------------------------------------------
// Cursor-specific options
// ---------------------------------------------------------------------------

/**
 * Options for the Cursor hook, extending the base HookOptions with
 * telemetry overrides needed for test isolation (DEC-HOOK-CURSOR-PHASE4-001-B).
 *
 * sessionId and telemetryDir are forwarded to executeRegistryQueryWithSubstitution()
 * so integration tests can redirect JSONL output to a tmpdir rather than
 * ~/.yakcc/telemetry/. In production these are left undefined and the wrapper
 * falls back to resolveCursorSessionId() / YAKCC_TELEMETRY_DIR env var (or defaults).
 */
export interface CursorHookOptions extends HookOptions {
  /**
   * Override the session ID used for the JSONL telemetry filename.
   * Production leaves this undefined; tests supply a fixed string for assertions.
   * When undefined, resolveCursorSessionId() is used (yields "cursor-<base-id>").
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
 * Process-scoped fallback session ID for cursor, generated once.
 * Mirrors the pattern in @yakcc/hooks-base/telemetry.ts but separate so
 * cursor sessions never share a file with claude-code sessions.
 */
const CURSOR_FALLBACK_SESSION_ID: string = (() => {
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
 * Resolve the session ID for a Cursor hook process, always prefixed with "cursor-".
 *
 * Reads CURSOR_SESSION_ID env var (set by Cursor's subprocess environment when
 * launching hook processes, analogous to CLAUDE_SESSION_ID for Claude Code).
 * Falls back to CURSOR_FALLBACK_SESSION_ID so all events within a process share
 * one file even when the env var is absent (e.g. during development).
 *
 * The "cursor-" prefix distinguishes cursor telemetry files from claude-code files
 * in the shared ~/.yakcc/telemetry/ directory (DEC-HOOK-CURSOR-PHASE4-001-B).
 */
export function resolveCursorSessionId(): string {
  const base = process.env.CURSOR_SESSION_ID ?? CURSOR_FALLBACK_SESSION_ID;
  return `cursor-${base}`;
}

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
 *
 * Phase 4: onCodeEmissionIntent() now accepts toolName and originalCode to
 * enable substitution (Phase 2 parity) and telemetry (Phase 1 parity).
 * toolName maps Cursor operations to the shared telemetry schema tool names.
 */
export interface CursorHook {
  /** Register the yakcc command with the Cursor extension harness. */
  registerCommand(): void;
  /**
   * Called when Cursor is about to emit code. Returns a HookResponseWithSubstitution
   * indicating whether to use an existing block, synthesise a new one, or
   * fall through to normal behaviour. Also captures telemetry per D-HOOK-5.
   *
   * toolName maps the Cursor VS Code operation to the shared telemetry schema:
   *   "Edit"      — inline edit at cursor position (Cursor: tab completion, inline suggest)
   *   "Write"     — full file generation (Cursor: new file from chat)
   *   "MultiEdit" — multi-file operation (Cursor: apply changes across files)
   *
   * originalCode is the agent's emitted code (content from the VS Code edit operation).
   * Phase 2: when provided, the hook attempts substitution per D2 auto-accept rule.
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
 * Create a CursorHook backed by the given registry.
 *
 * Production paths (DEC-HOOK-CURSOR-001, DEC-HOOK-CURSOR-PHASE4-001):
 * - registerCommand() writes ~/.cursor/yakcc-cursor-command.json as a
 *   registration marker for the yakcc command.
 * - onCodeEmissionIntent() delegates to executeRegistryQueryWithSubstitution()
 *   from @yakcc/hooks-base, capturing telemetry to cursor-<session-id>.jsonl
 *   in the telemetry directory.
 *
 * @param registry - Registry instance to consult for matching blocks.
 * @param options  - Optional threshold, marker directory, and telemetry overrides.
 */
export function createHook(registry: Registry, options?: CursorHookOptions): CursorHook {
  const threshold = options?.threshold ?? DEFAULT_REGISTRY_HIT_THRESHOLD;
  const markerDir = options?.markerDir ?? join(homedir(), ".cursor");
  const sessionId = options?.sessionId;
  const telemetryDir = options?.telemetryDir;

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
     * Determine how to respond to an emission intent, attempt Phase 2 substitution,
     * and capture telemetry to cursor-<session-id>.jsonl (DEC-HOOK-CURSOR-PHASE4-001).
     *
     * Delegates to executeRegistryQueryWithSubstitution() from @yakcc/hooks-base.
     * Production sequence:
     * 1. Build an IntentQuery from ctx.intent (+ ctx.sourceContext if present).
     * 2. Call registry.findCandidatesByIntent() with k=2, rerank="structural".
     * 3. If cosineDistance < threshold → registry-hit (return block identity).
     * 4. Apply D2 auto-accept rule: top-1 combinedScore > 0.85 AND gap > 0.15.
     * 5. If D2 passes: extract binding from originalCode, render substitution.
     * 6. If no candidate beats threshold → synthesis-required (return skeleton).
     * 7. On registry error → passthrough (preserve normal Cursor behaviour).
     * 8. Append one TelemetryEvent to <telemetryDir>/cursor-<sessionId>.jsonl (D-HOOK-5).
     *    Cursor prefix distinguishes from claude-code sessions in B3/B4/B5 analysis.
     */
    async onCodeEmissionIntent(
      ctx: EmissionContext,
      toolName: "Edit" | "Write" | "MultiEdit",
      originalCode = "",
    ): Promise<HookResponseWithSubstitution> {
      // Resolve the cursor-prefixed session ID when no override is provided.
      const resolvedSessionId = sessionId ?? resolveCursorSessionId();
      return executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, {
        threshold,
        sessionId: resolvedSessionId,
        ...(telemetryDir !== undefined ? { telemetryDir } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3 L3 — yakcc_resolve MCP tool surface (Cursor adapter)
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
