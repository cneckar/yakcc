// SPDX-License-Identifier: MIT
//
// hook-intercept.ts - Phase-2 stdin-reading subprocess for yakcc tool-call interception
//
// @decision DEC-CLI-HOOK-INTERCEPT-001
// title: yakcc hook-intercept delegates to executeRegistryQueryWithSubstitution; no direct telemetry write
// status: updated (WI-831) — Phase-1 contract superseded by Phase-2 substrate delegation.
// rationale:
//   Phase-1 (WI-753) hard-coded five TelemetryEvent fields with placeholder values and
//   appended the event directly from the CLI seam. Phase-2 (WI-831) replaces those five
//   lines with a single substrate call: executeRegistryQueryWithSubstitution() already
//   calls captureTelemetry() internally (packages/hooks-base/src/index.ts:640-657).
//   Sacred Practice #12 (one telemetry writer): the CLI no longer constructs or appends
//   a TelemetryEvent. The substrate is the single JSONL write site.
//   Phase-1 historical record preserved in MASTER_PLAN.md for archeology.
//   See DEC-WI831-WIRE-001 below.
//
// @decision DEC-WI831-WIRE-001
// title: hook-intercept Phase-2 — delegates to executeRegistryQueryWithSubstitution; telemetry-only delivery
// status: decided (WI-831)
// rationale:
//   The CLI seam opens the registry, builds an EmissionContext from intentText, and calls
//   executeRegistryQueryWithSubstitution(). The substrate handles:
//     - Registry query (findCandidatesByIntent KNN via sqlite-vec)
//     - Substitution decision (D2 auto-accept: combinedScore > 0.85 AND gap > 0.15)
//     - Enforcement layers L1-L4
//     - captureTelemetry() with real atomHash, candidateCount, topScore, substituted, outcome
//   The hook returns 0 with empty stdout regardless of substitution result (DEC-WI831-006:
//   inline injection is a separate WI). The 500ms hard cap (DEC-WI831-002) uses Promise.race
//   with a configurable timer seam (HookInterceptOptions.schedulerFn) for test control.
//
// @decision DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001
// title: Any exception inside hook-intercept body must be swallowed; process always exits 0
// status: decided (WI-753), preserved (WI-831)
// rationale:
//   Claude Code PreToolUse contract interprets non-zero exit code as "block the tool call".
//   Telemetry-write failure (disk full, permission denied) blocking the user Edit/Write/MultiEdit
//   is a worse failure mode than losing one telemetry line. D-HOOK-3 latency budget and the
//   hook-layer ADR principle "hook must never block tool emission" override Sacred Practice #5
//   (fail loudly) for this specific surface. The override is BOUNDED to hook-intercept only.

import { existsSync } from "node:fs";
import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  HOOK_LATENCY_BUDGET_MS,
  executeRegistryQueryWithSubstitution,
} from "@yakcc/hooks-base";
import type { EmissionContext } from "@yakcc/hooks-base";
import { resolveSessionId, resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";
import { openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

// ---------------------------------------------------------------------------
// Latency budget constants
// ---------------------------------------------------------------------------

/**
 * Soft budget (from substrate) — substrate's own HOOK_LATENCY_BUDGET_MS is 200ms.
 * Retained here for documentary visibility; the substrate enforces this internally.
 *
 * @decision DEC-WI831-002 (latency budget § substrate soft budget)
 */
const _SUBSTRATE_SOFT_BUDGET_MS = HOOK_LATENCY_BUDGET_MS;
void _SUBSTRATE_SOFT_BUDGET_MS; // consumed for documentation only

/**
 * Hard cap imposed at the CLI seam. If the substrate call does not resolve
 * within 500ms, the timer wins, the hook exits 0 with no telemetry written.
 *
 * @decision DEC-WI831-002 (latency budget § hard cap)
 */
export const CLI_HOOK_LATENCY_HARD_CAP_MS = 500;

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
// Tool name allowlist (intercepts Edit/Write/MultiEdit)
// ---------------------------------------------------------------------------

const ALLOWED_TOOL_NAMES = new Set<string>(["Edit", "Write", "MultiEdit"]);

// ---------------------------------------------------------------------------
// SchedulerFn — injectable timer abstraction for tests
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves after `ms` milliseconds using the provided
 * scheduler function. In production, uses `globalThis.setTimeout`. In tests,
 * the `schedulerFn` is replaced with a zero-delay or never-resolving stub.
 *
 * @decision DEC-WI831-002 (latency budget § timer injection seam)
 */
type SchedulerFn = (ms: number) => Promise<void>;

const DEFAULT_SCHEDULER: SchedulerFn = (ms: number) =>
  new Promise<void>((resolve) => {
    const id = globalThis.setTimeout(resolve, ms);
    // Unref so the timer doesn't keep the process alive past the tool call.
    if (typeof (id as unknown as { unref?: () => void }).unref === "function") {
      (id as unknown as { unref: () => void }).unref();
    }
  });

// ---------------------------------------------------------------------------
// HookInterceptOptions - TEST-ONLY injection seam
// ---------------------------------------------------------------------------

/**
 * Optional injection points for hookIntercept, enabling in-process testing
 * without spawning a subprocess or writing to the real home directory.
 *
 * In production, all defaults resolve to the real implementations.
 * In tests, inject NodeJS.ReadableStream stubs, tmpdir paths, substrate stubs,
 * and timer stubs to prove the silent-fail and latency-cap contracts.
 *
 * @decision DEC-WI831-002 (schedulerFn seam for timeout enforcement tests)
 * @decision DEC-WI831-003 (telemetryDir / registryPath injection for missing-registry tests)
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
   * This value is passed through to the substrate's captureTelemetry call.
   */
  telemetryDir?: string;
  /**
   * Path to the SQLite registry file.
   * Defaults to DEFAULT_REGISTRY_PATH (".yakcc/registry.sqlite", cwd-relative).
   * Tests inject a path to a fixture registry or a nonexistent path.
   * @decision DEC-WI831-003 (registry resolution)
   */
  registryPath?: string;
  /**
   * Timestamp function.
   * Defaults to Date.now. Tests can pin for deterministic latencyMs.
   */
  now?: () => number;
  /**
   * Timer scheduler for the 500ms hard cap (DEC-WI831-002).
   * Defaults to globalThis.setTimeout-based DEFAULT_SCHEDULER.
   * Tests inject a zero-delay scheduler (fast timeout) or never-resolving scheduler.
   */
  schedulerFn?: SchedulerFn;
  /**
   * executeRegistryQueryWithSubstitution implementation.
   * Defaults to the real function from @yakcc/hooks-base.
   * Tests inject a stub that resolves/rejects/hangs to prove substrate-delegation,
   * fail-silent, and timeout-enforcement contracts.
   *
   * NOTE: The injectable is typed to match the real substrate signature so callers
   * cannot accidentally pass an incompatible stub.
   */
  executeSubstrateFn?: typeof executeRegistryQueryWithSubstitution;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Phase-2 hook-intercept subprocess handler.
 *
 * Reads stdin to EOF, parses the PreToolUse JSON, builds an EmissionContext,
 * opens the local registry, and delegates to executeRegistryQueryWithSubstitution.
 * The substrate writes telemetry internally. The hook always exits 0 with empty
 * stdout — substituted code is NOT injected (DEC-WI831-006; telemetry-only delivery).
 *
 * ALWAYS returns 0 -- even on parse failure, missing registry, substrate error, or
 * any other exception. See DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001.
 *
 * @param argv     - Remaining argv (unused; accepted for CLI handler parity).
 * @param logger   - Output sink. MUST NOT emit anything — logger is never called.
 *                   Accepted for CLI handler signature parity.
 * @param options  - Optional injection seam for testing. Production callers omit this.
 * @returns Always 0.
 */
export async function hookIntercept(
  argv: readonly string[],
  logger: Logger,
  options?: HookInterceptOptions,
): Promise<number> {
  // Suppress unused variable lint warning — argv and logger are accepted for
  // signature parity with other CLI handlers; the hook does not use them.
  void argv;
  void logger;

  const stdinStream = options?.stdin ?? process.stdin;
  const telemetryDir = options?.telemetryDir ?? resolveTelemetryDir();
  const registryPath = options?.registryPath ?? DEFAULT_REGISTRY_PATH;
  const now = options?.now ?? Date.now;
  const schedulerFn = options?.schedulerFn ?? DEFAULT_SCHEDULER;
  const executeSubstrate = options?.executeSubstrateFn ?? executeRegistryQueryWithSubstitution;

  void now; // `now` available for future latency measurements at CLI seam

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
    // Step 5: Extract intent text (derivation: new_string -> content -> "")
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
    // Step 6: Gate on registry existence (DEC-WI831-003)
    // If the registry file does not exist, exit 0 with no telemetry write.
    // The top-level catch would handle the openRegistry throw too, but an
    // explicit existsSync gate makes the behavior observable in tests.
    // -----------------------------------------------------------------------
    if (!existsSync(registryPath)) {
      // DEC-WI831-003: absent registry → silent no-op; no telemetry event written.
      return 0;
    }

    // -----------------------------------------------------------------------
    // Step 7 NEW: Open registry + delegate to substrate with 500ms hard cap
    // (DEC-WI831-002, DEC-WI831-003, DEC-WI831-004)
    //
    // The substrate (executeRegistryQueryWithSubstitution) handles:
    //   - KNN query via sqlite-vec
    //   - Enforcement layers L1-L4
    //   - Substitution decision (D2 auto-accept)
    //   - captureTelemetry() with real atomHash, candidateCount, topScore,
    //     substituted, outcome (Sacred Practice #12: single JSONL writer)
    //
    // DEC-WI831-006: we do NOT inspect the return value or write substituted
    // code to stdout. Telemetry-only delivery. The hook always exits 0.
    // -----------------------------------------------------------------------
    const registry = await openRegistry(registryPath);
    // DEC-WI831-004: no explicit embeddings option; substrate default resolution.

    const ctx: EmissionContext = { intent: intentText };
    const originalCode = intentText;

    const substrateCall = executeSubstrate(registry, ctx, originalCode, validToolName, {
      threshold: DEFAULT_REGISTRY_HIT_THRESHOLD,
      sessionId,
      telemetryDir,
    });

    // 500ms hard cap: if the substrate doesn't resolve in time, the timer fires.
    // Either branch resolves to undefined; we don't inspect the substrate's return.
    // On timeout, the substrate's in-flight work is orphaned but harmless — it
    // will finish writing its own telemetry whenever it completes.
    // No duplicate hook-side write can occur (there is no hook-side write).
    await Promise.race([substrateCall, schedulerFn(CLI_HOOK_LATENCY_HARD_CAP_MS)]);
  } catch {
    // Top-level catch: swallows ANY exception — stdin read error, JSON parse,
    // openRegistry failure (missing file, corrupt DB), substrate error, anything.
    // DEC-CLI-HOOK-INTERCEPT-FAIL-SILENT-001: the hook must NEVER block the user tool call.
  }

  // ALWAYS exit 0. Claude Code interprets non-zero as "block the tool call".
  return 0;
}
