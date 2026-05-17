// SPDX-License-Identifier: MIT
/**
 * telemetry.ts â€" Local-only telemetry capture for the yakcc hook layer (Phase 1 MVP).
 *
 * @decision DEC-HOOK-PHASE-1-001
 * @title Telemetry capture: JSONL append-only writer with BLAKE3 intent hashing
 * @status accepted
 * @rationale
 *   Per D-HOOK-5 (docs/adr/hook-layer-architecture.md):
 *   - Telemetry is local-only by default; written to ~/.yakcc/telemetry/<session-id>.jsonl.
 *   - One TelemetryEvent per emission event; JSONL (newline-delimited JSON) is the storage format
 *     so the file is append-only and trivially readable with standard tools.
 *   - EmissionContext.intent is BLAKE3-hashed before storage (no plaintext intents â€” privacy
 *     by default). The hash allows “did this exact intent recur?” analysis without storing PII.
 *   - Session ID resolved from CLAUDE_SESSION_ID env var; falls back to a process-scoped UUID
 *     generated once per process so all events from the same process share an ID even when
 *     CLAUDE_SESSION_ID is absent (e.g. in tests or non-Claude IDEs).
 *   - Configurable telemetry dir via YAKCC_TELEMETRY_DIR env var (D-HOOK-5 spec).
 *   - Zero network I/O in this module â€" append to local file only (B6 air-gap compliance).
 *
 * Cross-reference: DEC-HOOK-LAYER-001 (parent ADR), D-HOOK-5, B6 (#190).
 *
 * WI-546 Slice 1 addition:
 * @decision DEC-TELEMETRY-EXPORT-SINK-001
 * @title Sink dispatcher hooks appendTelemetryEvent â€” single dispatch point
 * @status accepted
 * @rationale
 *   After the existing JSONL append, `appendTelemetryEvent` now calls
 *   `selectSink().send(event)` to fan out to the configured export sinks
 *   (NoOp, File, HttpsBatcher, or Composite). The JSONL write is never removed
 *   or bypassed â€” the sink dispatch is ADDITIVE. Errors from the sink are
 *   caught at the sink boundary (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005) and
 *   the existing try/catch at call sites in index.ts is the outer safety net.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { HookResponse } from "./index.js";
import { selectSink } from "./telemetry-sink.js";
import { getEnforcementConfig } from "./enforcement-config.js";
import {
  recordTelemetryEvent,
  checkDrift,
  type EventSnapshot,
} from "./drift-detector.js";

// ---------------------------------------------------------------------------
// TelemetryEvent â€" schema per D-HOOK-5
// ---------------------------------------------------------------------------

/**
 * One telemetry record per emission event.
 *
 * Schema is verbatim from D-HOOK-5 in docs/adr/hook-layer-architecture.md.
 * Every field is required; null values are explicit (never undefined).
 */
export type TelemetryEvent = {
  /** Unix timestamp in milliseconds at the moment of telemetry capture. */
  readonly t: number;
  /** BLAKE3 hex digest of EmissionContext.intent (NOT the intent text). */
  readonly intentHash: string;
  /** Tool name that triggered the hook intercept. */
  readonly toolName: "Edit" | "Write" | "MultiEdit";
  /** Number of candidates returned by the registry query. */
  readonly candidateCount: number;
  /** Top candidate's cosine distance, or null if candidateCount === 0. */
  readonly topScore: number | null;
  /** Whether the hook substituted a registry atom for the emitted code. Phase 1: always false. */
  readonly substituted: boolean;
  /** BlockMerkleRoot[:8] hex string of the substituted atom, or null if not substituted. */
  readonly substitutedAtomHash: string | null;
  /** End-to-end latency in milliseconds from intercept start to response. */
  readonly latencyMs: number;
  /** Outcome of the hook decision. */
  //
  // @decision DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001
  // title: Three new outcome values added for Slice 2 shave-on-miss telemetry
  // status: decided (WI-508 Slice 2)
  // rationale:
  //   Backward-compatible additive expansion. Old JSONL consumers see the new values
  //   as unrecognized strings; new consumers can branch on them. Downstream telemetry-
  //   export WI (#546) cross-references this slice for the new event shapes.
  //   "shave-on-miss-enqueued": first occurrence miss, background shave started.
  //   "shave-on-miss-completed": background shave finished, atoms created.
  //   "shave-on-miss-error": background shave failed (entry-path, engine, or persist error).
  readonly outcome:
    | "registry-hit"
    | "synthesis-required"
    | "passthrough"
    | "atomized"
    | "shave-on-miss-enqueued"
    | "shave-on-miss-completed"
    | "shave-on-miss-error"
    // @decision DEC-HOOK-ENF-LAYER1-TELEMETRY-001
    // title: "intent-too-broad" additive outcome for Layer 1 intent-specificity gate (wi-579 S1)
    // status: decided (wi-579-hook-enforcement S1)
    // rationale:
    //   Additive expansion following the #569/#574 shave-on-miss pattern (Sacred Practice 12).
    //   Emitted via outcomeOverride="intent-too-broad" at the Layer 1 gate in
    //   executeRegistryQueryWithSubstitution (index.ts). outcomeFromResponse() unchanged.
    //   Cross-reference: plans/wi-579-hook-enforcement-architecture.md ��7.6
    | "intent-too-broad" // S1 additive (DEC-HOOK-ENF-LAYER1-TELEMETRY-001)
    // @decision DEC-HOOK-ENF-LAYER2-TELEMETRY-001
    // title: "result-set-too-large" additive outcome for Layer 2 result-set size gate (wi-590 S2)
    // status: decided (wi-590-s2-layer2)
    // rationale:
    //   Additive expansion following the Layer 1 pattern (DEC-HOOK-ENF-LAYER1-TELEMETRY-001).
    //   Emitted via outcomeOverride="result-set-too-large" at the Layer 2 gate in
    //   executeRegistryQueryWithSubstitution (index.ts). outcomeFromResponse() unchanged.
    //   Cross-reference: plans/wi-579-s2-layer2-result-set-size.md
    | "result-set-too-large" // S2 additive (DEC-HOOK-ENF-LAYER2-TELEMETRY-001)
    // @decision DEC-HOOK-ENF-LAYER3-TELEMETRY-001
    // title: "atom-size-too-large" additive outcome for Layer 3 atom-size ratio gate (wi-591 S3)
    // status: decided (wi-591-s3-layer3)
    // rationale:
    //   Additive expansion following the Layer 2 pattern (DEC-HOOK-ENF-LAYER2-TELEMETRY-001).
    //   Emitted via outcomeOverride="atom-size-too-large" at the Layer 3 gate in
    //   executeSubstitution (substitute.ts). outcomeFromResponse() unchanged.
    //   Cross-reference: plans/wi-579-s3-layer3-atom-size-ratio.md
    | "atom-size-too-large" // S3 additive (DEC-HOOK-ENF-LAYER3-TELEMETRY-001)
    // @decision DEC-HOOK-ENF-LAYER4-TELEMETRY-001
    // title: "descent-bypass-warning" additive outcome for Layer 4 descent-depth tracker (wi-592 S4)
    // status: decided (wi-592-s4-layer4)
    // rationale:
    //   Additive expansion following the Layer 3 pattern (DEC-HOOK-ENF-LAYER3-TELEMETRY-001).
    //   Emitted alongside a successful substitution when Layer 4 attaches a DescentBypassWarning.
    //   The outcome signals that the substitution succeeded but a depth advisory was triggered.
    //   outcomeFromResponse() unchanged — this override is passed explicitly by substitute.ts
    //   when descentBypassWarning is non-null.
    //   Cross-reference: plans/wi-579-s4-layer4-descent-tracker.md
    | "descent-bypass-warning" // S4 additive (DEC-HOOK-ENF-LAYER4-TELEMETRY-001)
    // @decision DEC-HOOK-ENF-LAYER5-TELEMETRY-001
    // title: "drift-alert" additive outcome for Layer 5 drift detection (wi-593 S5)
    // status: decided (wi-593-s5-layer5)
    // rationale:
    //   Additive expansion following the Layer 4 pattern (DEC-HOOK-ENF-LAYER4-TELEMETRY-001).
    //   Emitted as a second telemetry event alongside the original event when the Layer 5
    //   rolling-window drift detector crosses a threshold. The original event is always
    //   written first; the drift-alert event is written after, carrying driftMetric details
    //   in the intentHash field (encoded as "drift:<metric>:<sessionId>") and the suggestion
    //   in a structured way via candidateCount=-1 sentinel.
    //   captureTelemetry callers are NEVER blocked — drift detection is non-invasive.
    //   outcomeFromResponse() unchanged — this outcome is emitted via a second direct call
    //   to appendTelemetryEvent with an explicit outcome, not via outcomeOverride.
    //   Cross-reference: plans/wi-579-s5-layer5-drift-detection.md §5.6
    | "drift-alert"; // S5 additive (DEC-HOOK-ENF-LAYER5-TELEMETRY-001)
  // ---------------------------------------------------------------------------
  // Phase 2 additions â€" additive fields (backwards-compatible per #217 spec).
  // Old telemetry consumers see these as optional (undefined in Phase 1 events).
  // Phase 2 events always populate all four fields.
  // ---------------------------------------------------------------------------
  /**
   * Time spent in the substitution pipeline (AST extraction + rendering) in ms.
   * Null when substitution was not attempted or was disabled.
   * Phase 1 events: undefined (not present).
   */
  readonly substitutionLatencyMs?: number | null;
  /**
   * D3 combinedScore of the top-1 candidate (1 - dÂ²/4, per DEC-V3-DISCOVERY-CALIBRATION-FIX-002).
   * Null when no candidates were returned.
   * Phase 1 events: undefined (not present).
   */
  readonly top1Score?: number | null;
  /**
   * Gap between top-1 and top-2 combinedScore.
   * 0 when fewer than 2 candidates were returned.
   * Null when no candidates were returned.
   * Phase 1 events: undefined (not present).
   */
  readonly top1Gap?: number | null;
  /**
   * Whether the D-HOOK-3 latency budget (200ms) was exceeded.
   * True triggers a LATENCY_BUDGET_EXCEEDED event in the telemetry stream.
   * Phase 1 events: undefined (not present).
   */
  readonly latencyBudgetExceeded?: boolean;
  // ---------------------------------------------------------------------------
  // Phase 3 / atomize additions â€" additive fields (D-HOOK-7, issue #362).
  // Old telemetry consumers see these as optional (undefined in prior events).
  // Atomized events always populate atomsCreated; prior events omit it.
  // ---------------------------------------------------------------------------
  /**
   * BlockMerkleRoot[:8] prefixes of atoms created during atomization.
   * Non-empty only when outcome === "atomized".
   * Additive field: Phase 1/2 events do not carry this field (undefined).
   *
   * @decision DEC-HOOK-ATOM-CAPTURE-001 (additive telemetry â€" D-HOOK-7)
   * Adding atomsCreated as an optional field preserves backward compatibility:
   * old telemetry consumers see it as absent (undefined), while new consumers
   * can check outcome === "atomized" before reading atomsCreated.
   */
  readonly atomsCreated?: readonly string[];
};

// ---------------------------------------------------------------------------
// Session ID resolution
// ---------------------------------------------------------------------------

/**
 * Process-scoped fallback session ID, generated once.
 *
 * @decision DEC-HOOK-PHASE-1-001
 * Used when CLAUDE_SESSION_ID is absent so all events within a process share
 * one file. crypto.randomUUID() is available in Node 14.17.0+ (baseline for yakcc).
 */
const FALLBACK_SESSION_ID: string = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node < 19 polyfill: produce a UUID-shaped string using Math.random.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
})();

/**
 * Resolve the session ID for the current hook process.
 *
 * Prefers CLAUDE_SESSION_ID (set by Claude Code per its hook subprocess contract)
 * so telemetry files align with actual Claude Code sessions. Falls back to the
 * process-scoped FALLBACK_SESSION_ID.
 */
export function resolveSessionId(): string {
  return process.env.CLAUDE_SESSION_ID ?? FALLBACK_SESSION_ID;
}

// ---------------------------------------------------------------------------
// Telemetry directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the directory where telemetry JSONL files are written.
 *
 * Prefers YAKCC_TELEMETRY_DIR env var (D-HOOK-5 configurable path).
 * Falls back to ~/.yakcc/telemetry/.
 */
export function resolveTelemetryDir(): string {
  return process.env.YAKCC_TELEMETRY_DIR ?? join(homedir(), ".yakcc", "telemetry");
}

// ---------------------------------------------------------------------------
// BLAKE3 intent hashing
// ---------------------------------------------------------------------------

/**
 * Compute the BLAKE3 hex digest of an intent string.
 *
 * @decision DEC-HOOK-PHASE-1-001
 * Intent text is hashed before storage so no plaintext natural-language descriptions
 * of user work are written to disk. BLAKE3 (256-bit default) is used because:
 * (a) @noble/hashes is already a transitive dependency via @yakcc/contracts,
 *     so no new dependency is needed.
 * (b) BLAKE3 is fast (< 1Âµs for typical intent strings), keeping hash cost negligible
 *     relative to the 200ms D-HOOK-3 latency budget.
 * (c) BLAKE3 produces deterministic output for identical input, enabling
 *     "did this exact intent recur?" analysis across sessions.
 *
 * @param intentText - Raw intent string from EmissionContext.intent.
 * @returns 64-character lowercase hex string (BLAKE3-256).
 */
export function hashIntent(intentText: string): string {
  const encoded = new TextEncoder().encode(intentText);
  const digest = blake3(encoded);
  return bytesToHex(digest);
}

// ---------------------------------------------------------------------------
// Outcome extraction
// ---------------------------------------------------------------------------

/**
 * Outcome values returned by outcomeFromResponse().
 *
 * Subset of TelemetryEvent.outcome: excludes shave-on-miss-* and drift-alert
 * values that are emitted via direct appendTelemetryEvent calls, not via
 * outcomeFromResponse(). Extracted as a named alias so the function signature
 * stays within the 200-char behavior limit.
 *
 * @decision DEC-634-OUTCOME-ALIAS-001
 * @title TelemetryOutcome type alias keeps outcomeFromResponse signature ≤200 chars
 * @status accepted
 * @rationale
 *   Without this alias, buildSignatureString() produces a 222-char behavior for
 *   the outcomeFromResponse leaf (the full inline union is 160 chars in the return
 *   position). Extracting the union as TelemetryOutcome reduces the signature to
 *   ~75 chars, satisfying the IntentCard 200-char validator without altering the
 *   public contract. This is the fix for #634.
 */
export type TelemetryOutcome =
  | "registry-hit"
  | "synthesis-required"
  | "passthrough"
  | "atomized"
  | "intent-too-broad"
  | "result-set-too-large"
  | "atom-size-too-large"
  | "descent-bypass-warning";

/**
 * Extract the outcome string from a HookResponse discriminated union.
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001 (D-HOOK-7 additive outcome)
 * The "atomized" outcome cannot be derived from a HookResponse (which only
 * carries registry-hit | synthesis-required | passthrough). The atomize path
 * sets outcome explicitly. This overload accepts an explicit override so the
 * telemetry wrapper can pass "atomized" when the atomize path fires.
 */
export function outcomeFromResponse(
  response: HookResponse,
  outcomeOverride?: "atomized" | "intent-too-broad" | "result-set-too-large" | "atom-size-too-large" | "descent-bypass-warning",
): TelemetryOutcome {
  // Note: shave-on-miss outcome values are emitted directly via appendTelemetryEvent
  // from shave-on-miss.ts, not via this function. This function handles only the
  // four standard outcomes plus the override values.
  if (outcomeOverride !== undefined) return outcomeOverride;
  return response.kind;
}

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

/**
 * Append a single TelemetryEvent as one JSON line to the session's JSONL file.
 *
 * Creates the telemetry directory if it does not exist (idempotent).
 * Appends rather than rewrites: the file grows as a log â€" never truncated.
 *
 * @decision DEC-HOOK-PHASE-1-001
 * Append-only JSONL ensures: (a) no event is lost to a write race (atomic append
 * in POSIX), (b) partial writes from abrupt process termination produce at most
 * one incomplete line (easy to detect and skip during analysis), (c) the format
 * is trivially consumable with `jq` or `jsonl` tooling.
 *
 * @param event     - The telemetry record to append.
 * @param sessionId - Resolved session ID (determines filename).
 * @param dir       - Resolved telemetry directory path.
 */
export function appendTelemetryEvent(event: TelemetryEvent, sessionId: string, dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${sessionId}.jsonl`);
  // One JSON object per line; newline-terminated for JSONL compliance.
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");

  // @decision DEC-TELEMETRY-EXPORT-SINK-001
  // Dispatch to the configured export sink (NoOp/File/HttpsBatcher/Composite).
  // This is ADDITIVE — the JSONL write above is never removed or bypassed.
  // Errors are caught at the sink boundary (DEC-TELEMETRY-EXPORT-FAIL-SILENT-005);
  // the try/catch at call sites in index.ts is the outer safety net.
  try {
    selectSink().send(event);
  } catch {
    // Backstop: sink implementations should catch their own errors, but if one
    // throws anyway we swallow here so the JSONL write is never affected.
  }
}

// ---------------------------------------------------------------------------
// High-level capture helper
// ---------------------------------------------------------------------------

/**
 * Capture telemetry for a single emission event.
 *
 * This is the function called by the hook adapter after executeRegistryQuery()
 * returns. It computes all derived fields, builds the TelemetryEvent, and
 * appends it to the session file.
 *
 * @param opts.intent                - Raw intent text (will be hashed, never stored as-is).
 * @param opts.toolName              - Tool that triggered the intercept.
 * @param opts.response              - The HookResponse from executeRegistryQuery().
 * @param opts.candidateCount        - Number of raw candidates the registry returned.
 * @param opts.topScore              - Cosine distance of the top candidate, or null.
 * @param opts.latencyMs             - Elapsed ms from intercept start to now.
 * @param opts.substituted           - Whether Phase 2 substitution occurred (default: false).
 * @param opts.substitutedAtomHash   - BlockMerkleRoot of substituted atom, or null.
 * @param opts.substitutionLatencyMs - Time spent in substitution pipeline, or null.
 * @param opts.top1Score             - combinedScore of top-1 candidate, or null.
 * @param opts.top1Gap               - Gap to top-2 combinedScore, or null.
 * @param opts.latencyBudgetExceeded - Whether the 200ms D-HOOK-3 budget was exceeded.
 * @param opts.sessionId             - Resolved session ID (default: resolveSessionId()).
 * @param opts.telemetryDir          - Resolved telemetry dir (default: resolveTelemetryDir()).
 */
export function captureTelemetry(opts: {
  intent: string;
  toolName: "Edit" | "Write" | "MultiEdit";
  response: HookResponse;
  candidateCount: number;
  topScore: number | null;
  latencyMs: number;
  // Phase 2 additions â€" all optional so Phase 1 callers need no changes.
  substituted?: boolean;
  substitutedAtomHash?: string | null;
  substitutionLatencyMs?: number | null;
  top1Score?: number | null;
  top1Gap?: number | null;
  latencyBudgetExceeded?: boolean;
  // Phase 3 / D-HOOK-7 additions â€" additive, all optional.
  /** Explicit outcome override â€" used by the atomize path to set "atomized". */
  /**
   * Explicit outcome override. Used by the atomize path to set "atomized",
   * by the Layer 1 gate to set "intent-too-broad" (DEC-HOOK-ENF-LAYER1-TELEMETRY-001),
   * and by the Layer 2 gate to set "result-set-too-large" (DEC-HOOK-ENF-LAYER2-TELEMETRY-001).
   */
  outcomeOverride?: "atomized" | "intent-too-broad" | "result-set-too-large" | "atom-size-too-large" | "descent-bypass-warning";
  /** BMR prefixes of atoms created. Non-empty only for outcome === "atomized". */
  atomsCreated?: readonly string[];
  sessionId?: string;
  telemetryDir?: string;
}): void {
  const sessionId = opts.sessionId ?? resolveSessionId();
  const dir = opts.telemetryDir ?? resolveTelemetryDir();
  const resolvedOutcome = outcomeFromResponse(opts.response, opts.outcomeOverride);

  const event: TelemetryEvent = {
    t: Date.now(),
    intentHash: hashIntent(opts.intent),
    toolName: opts.toolName,
    candidateCount: opts.candidateCount,
    topScore: opts.topScore,
    substituted: opts.substituted ?? false,
    substitutedAtomHash: opts.substitutedAtomHash ?? null,
    latencyMs: opts.latencyMs,
    outcome: resolvedOutcome,
    // Phase 2 fields — spread only when defined so Phase 1 JSONL lines stay lean.
    ...(opts.substitutionLatencyMs !== undefined
      ? { substitutionLatencyMs: opts.substitutionLatencyMs }
      : {}),
    ...(opts.top1Score !== undefined ? { top1Score: opts.top1Score } : {}),
    ...(opts.top1Gap !== undefined ? { top1Gap: opts.top1Gap } : {}),
    ...(opts.latencyBudgetExceeded !== undefined
      ? { latencyBudgetExceeded: opts.latencyBudgetExceeded }
      : {}),
    // D-HOOK-7 / atomize fields — present only for outcome === "atomized".
    ...(opts.atomsCreated !== undefined ? { atomsCreated: opts.atomsCreated } : {}),
  };

  // Write the primary event first (non-invasive: drift detection never delays this).
  appendTelemetryEvent(event, sessionId, dir);

  // ---------------------------------------------------------------------------
  // Layer 5: non-invasive drift detection wrap
  //
  // @decision DEC-HOOK-ENF-LAYER5-TELEMETRY-001
  // Record the event snapshot in the session rolling window, then check whether
  // any drift threshold has been crossed. If an alert fires, emit a second
  // "drift-alert" telemetry event additively (does not replace or modify the
  // original event). All drift work happens AFTER the primary append so that
  // captureTelemetry callers are never blocked by drift detection errors.
  // ---------------------------------------------------------------------------
  try {
    const cfg = getEnforcementConfig().layer5;
    if (!cfg.disableDetection) {
      // Build a compact EventSnapshot from the resolved event fields.
      // specificityScore is approximated from topScore (cosine distance):
      //   score = 1 - topScore/2 maps [0,2] distance to [1,0] score.
      // Layer 1 "intent-too-broad" events have no meaningful registry score
      // so specificityScore is omitted for those outcomes.
      const snap: EventSnapshot = {
        outcome: resolvedOutcome,
        candidateCount: opts.candidateCount,
        ...(opts.topScore !== null &&
          opts.topScore !== undefined &&
          resolvedOutcome !== "intent-too-broad"
          ? { specificityScore: 1 - opts.topScore / 2 }
          : {}),
      };

      recordTelemetryEvent(sessionId, snap, cfg.rollingWindow);

      const driftResult = checkDrift(sessionId, cfg);
      if (driftResult.status === "drift_alert") {
        // Emit an additive drift-alert event. candidateCount = -1 is the
        // sentinel distinguishing drift-alert events from real registry events.
        const alertEvent: TelemetryEvent = {
          t: Date.now(),
          intentHash: `drift:${driftResult.driftMetric}:${sessionId.slice(0, 8)}`,
          toolName: opts.toolName,
          candidateCount: -1,
          topScore: null,
          substituted: false,
          substitutedAtomHash: null,
          latencyMs: 0,
          outcome: "drift-alert",
        };
        appendTelemetryEvent(alertEvent, sessionId, dir);
      }
    }
  } catch {
    // Drift detection errors must NEVER propagate to callers.
    // captureTelemetry is called in hot paths; a drift detector bug must not
    // affect hook behavior. Errors are silently swallowed here per
    // DEC-HOOK-ENF-LAYER5-TELEMETRY-001 (non-invasive wrap contract).
  }
}
