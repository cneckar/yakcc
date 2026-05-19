// SPDX-License-Identifier: MIT
//
// hook-intercept.ts - Phase-1 stdin-reading subprocess for yakcc tool-call interception
//
// @decision DEC-CLI-HOOK-INTERCEPT-001
// title: yakcc hook-intercept is a stdin-reading subprocess that captures telemetry
//        per D-HOOK-5 and always exits 0 with empty stdout; no registry query, no substitution
// status: decided (WI-753)
// rationale:
//   The "write side" (IDE hook installers) shipped in WI-656 / #216. This is the "read
//   side" -- the subprocess that Claude Code PreToolUse hook spawns for every
//   Edit/Write/MultiEdit tool call. Phase-1 contract:
//   - Read process.stdin to EOF; best-effort JSON parse.
//   - Extract tool_name, session_id, tool_input.new_string|content.
//   - Append one JSONL line to ~/.yakcc/telemetry/<session-id>.jsonl per D-HOOK-5 schema.
//   - Exit 0 with empty stdout (Claude Code interprets as "allow tool unchanged").
//   - ANY failure inside the handler -> silent exit 0 (DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001).
//
//   Phase-2 (registry query + substitution) is WI-HOOK-PHASE-2-SUBSTITUTION and is NOT
//   implemented here. Sacred Practice #12: appendTelemetryEvent/hashIntent/resolveSessionId/
//   resolveTelemetryDir are consumed from @yakcc/hooks-base, NOT reimplemented here.
//
// @decision DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001
// title: Any exception inside hook-intercept body must be swallowed; process always exits 0
// status: decided (WI-753)
// rationale:
//   Claude Code PreToolUse contract interprets non-zero exit code as "block the tool call".
//   Telemetry-write failure (disk full, permission denied) blocking the user Edit/Write/MultiEdit
//   is a worse failure mode than losing one telemetry line. D-HOOK-3 latency budget and the
//   hook-layer ADR principle "hook must never block tool emission" override Sacred Practice #5
//   (fail loudly) for this specific surface. The override is BOUNDED to hook-intercept only.

import type {
  appendTelemetryEvent as AppendTelemetryEventFn,
  TelemetryEvent,
} from "@yakcc/hooks-base/telemetry.js";
import {
  appendTelemetryEvent,
  hashIntent,
  resolveSessionId,
  resolveTelemetryDir,
} from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Windows-illegal filename character sanitization
// ---------------------------------------------------------------------------

/**
 * Characters that are illegal in Windows file names.
 * Session IDs from Claude Code are UUIDs (colon-free), but we guard anyway
 * because a malformed session_id could contain path-breaking characters.
 *
 * @decision DEC-CLI-HOOK-INTERCEPT-001 (risk mitigation section 10)
 * Reject session IDs containing Windows-illegal filename chars and fall back
 * to resolveSessionId(). This prevents path injection via crafted stdin JSON.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char range for Windows filename safety
const WINDOWS_ILLEGAL_FILENAME_RE = /[<>:"/\\|?*\x00-\x1f]/;

function sanitizeSessionId(raw: string): string | null {
  if (WINDOWS_ILLEGAL_FILENAME_RE.test(raw)) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Tool name allowlist (Phase 1 only intercepts Edit/Write/MultiEdit)
// ---------------------------------------------------------------------------

const ALLOWED_TOOL_NAMES = new Set<string>(["Edit", "Write", "MultiEdit"]);

// ---------------------------------------------------------------------------
// HookInterceptOptions - TEST-ONLY injection seam
// ---------------------------------------------------------------------------

/**
 * Optional injection points for hookIntercept, enabling in-process testing
 * without spawning a subprocess or writing to the real home directory.
 *
 * In production, all defaults resolve to the real implementations.
 * In tests, inject NodeJS.ReadableStream stubs, tmpdir paths, and throwing
 * stubs to prove the silent-fail contract.
 */
export interface HookInterceptOptions {
  /**
   * Readable stream to read stdin from.
   * Defaults to process.stdin. Tests inject Readable.from([Buffer]).
   */
  stdin?: NodeJS.ReadableStream;
  /**
   * Directory where JSONL telemetry files are written.
   * Defaults to resolveTelemetryDir(). Tests inject mkdtempSync path.
   */
  telemetryDir?: string;
  /**
   * appendTelemetryEvent implementation.
   * Defaults to the real function from @yakcc/hooks-base.
   * Tests inject a throwing stub to prove DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001.
   */
  appendEvent?: typeof AppendTelemetryEventFn;
  /**
   * Timestamp function.
   * Defaults to Date.now. Tests can pin for deterministic latencyMs.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Phase-1 hook-intercept subprocess handler.
 *
 * Reads stdin to EOF, best-effort parses as JSON, builds a TelemetryEvent
 * per D-HOOK-5 schema, and appends it to the session file.
 *
 * ALWAYS returns 0 -- even on parse failure, permission denied, or any
 * other error. See DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001.
 *
 * @param argv     - Remaining argv (unused in Phase 1; accepted for CLI parity).
 * @param logger   - Output sink. MUST NOT emit anything -- logger.log() is never
 *                   called. Accepted for CLI handler signature parity.
 * @param options  - Optional injection seam for testing. Production callers omit this.
 * @returns Always 0.
 */
export async function hookIntercept(
  argv: readonly string[],
  logger: Logger,
  options?: HookInterceptOptions,
): Promise<number> {
  // Suppress unused variable lint warning -- argv and logger are accepted for
  // signature parity with other CLI handlers; Phase 1 does not use them.
  void argv;
  void logger;

  const stdinStream = options?.stdin ?? process.stdin;
  const telemetryDir = options?.telemetryDir ?? resolveTelemetryDir();
  const appendEvent = options?.appendEvent ?? appendTelemetryEvent;
  const now = options?.now ?? Date.now;

  const start = now();

  try {
    // -----------------------------------------------------------------------
    // Step 1: Read stdin to EOF
    // -----------------------------------------------------------------------
    const chunks: Buffer[] = [];
    for await (const chunk of stdinStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const stdinText = Buffer.concat(chunks).toString("utf-8").trim();

    if (!stdinText) {
      // Empty stdin -- no event to record; exit 0 silently.
      return 0;
    }

    // -----------------------------------------------------------------------
    // Step 2: Best-effort JSON parse
    // -----------------------------------------------------------------------
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdinText);
    } catch {
      // Malformed JSON -- swallow and exit 0 per DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001.
      return 0;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return 0;
    }

    const payload = parsed as Record<string, unknown>;

    // -----------------------------------------------------------------------
    // Step 3: Extract tool_name -- gate on allowed set
    // -----------------------------------------------------------------------
    const toolName = payload.tool_name;
    if (typeof toolName !== "string" || !ALLOWED_TOOL_NAMES.has(toolName)) {
      // tool_name missing, wrong type, or not Edit/Write/MultiEdit -> drop silently.
      return 0;
    }

    // toolName is narrowed to "Edit" | "Write" | "MultiEdit" by the Set check above.
    const validToolName = toolName as "Edit" | "Write" | "MultiEdit";

    // -----------------------------------------------------------------------
    // Step 4: Extract session_id
    // Precedence: payload.session_id > CLAUDE_SESSION_ID env > process-UUID fallback
    // See plan section 2 "Why session ID resolution is delicate".
    // -----------------------------------------------------------------------
    let sessionId: string;
    const payloadSessionId = payload.session_id;
    if (typeof payloadSessionId === "string" && payloadSessionId.length > 0) {
      const sanitized = sanitizeSessionId(payloadSessionId);
      sessionId = sanitized ?? resolveSessionId();
    } else {
      sessionId = resolveSessionId();
    }

    // -----------------------------------------------------------------------
    // Step 5: Extract intent text (plan section 3.2 derivation)
    // new_string -> content -> "" (empty string)
    // -----------------------------------------------------------------------
    const toolInput =
      typeof payload.tool_input === "object" && payload.tool_input !== null
        ? (payload.tool_input as Record<string, unknown>)
        : {};
    const intentText =
      typeof toolInput.new_string === "string"
        ? toolInput.new_string
        : typeof toolInput.content === "string"
          ? toolInput.content
          : "";

    // -----------------------------------------------------------------------
    // Step 6: Build TelemetryEvent per D-HOOK-5 schema (plan section 3)
    // -----------------------------------------------------------------------
    const end = now();
    const event: TelemetryEvent = {
      t: end,
      intentHash: hashIntent(intentText),
      toolName: validToolName,
      candidateCount: 0, // Phase 1: no registry query
      topScore: null, // Phase 1: no registry query
      substituted: false, // Phase 1: never substitutes
      substitutedAtomHash: null, // Phase 1: never substitutes
      latencyMs: end - start,
      outcome: "passthrough", // D-HOOK-5 canonical value per plan section 3
    };

    // -----------------------------------------------------------------------
    // Step 7: Append telemetry event
    // Any exception here is swallowed -- DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001.
    // -----------------------------------------------------------------------
    appendEvent(event, sessionId, telemetryDir);
  } catch {
    // Top-level catch: swallows ANY exception -- stdin read error, JSON parse,
    // hash failure, disk full, permission denied, anything.
    // DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001: the hook must NEVER block the user tool call.
  }

  // ALWAYS exit 0. Claude Code interprets non-zero as "block the tool call".
  return 0;
}
