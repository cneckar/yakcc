// SPDX-License-Identifier: MIT
/**
 * telemetry.ts — Local-only telemetry capture for the yakcc hook layer (Phase 1 MVP).
 *
 * @decision DEC-HOOK-PHASE-1-001
 * @title Telemetry capture: JSONL append-only writer with BLAKE3 intent hashing
 * @status accepted
 * @rationale
 *   Per D-HOOK-5 (docs/adr/hook-layer-architecture.md):
 *   - Telemetry is local-only by default; written to ~/.yakcc/telemetry/<session-id>.jsonl.
 *   - One TelemetryEvent per emission event; JSONL (newline-delimited JSON) is the storage format
 *     so the file is append-only and trivially readable with standard tools.
 *   - EmissionContext.intent is BLAKE3-hashed before storage (no plaintext intents — privacy
 *     by default). The hash allows "did this exact intent recur?" analysis without storing PII.
 *   - Session ID resolved from CLAUDE_SESSION_ID env var; falls back to a process-scoped UUID
 *     generated once per process so all events from the same process share an ID even when
 *     CLAUDE_SESSION_ID is absent (e.g. in tests or non-Claude IDEs).
 *   - Configurable telemetry dir via YAKCC_TELEMETRY_DIR env var (D-HOOK-5 spec).
 *   - Zero network I/O in this module — append to local file only (B6 air-gap compliance).
 *
 * Cross-reference: DEC-HOOK-LAYER-001 (parent ADR), D-HOOK-5, B6 (#190).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { HookResponse } from "./index.js";

// ---------------------------------------------------------------------------
// TelemetryEvent — schema per D-HOOK-5
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
  readonly outcome: "registry-hit" | "synthesis-required" | "passthrough";
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
 * (b) BLAKE3 is fast (< 1µs for typical intent strings), keeping hash cost negligible
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
 * Extract the outcome string from a HookResponse discriminated union.
 */
export function outcomeFromResponse(
  response: HookResponse,
): "registry-hit" | "synthesis-required" | "passthrough" {
  return response.kind;
}

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

/**
 * Append a single TelemetryEvent as one JSON line to the session's JSONL file.
 *
 * Creates the telemetry directory if it does not exist (idempotent).
 * Appends rather than rewrites: the file grows as a log — never truncated.
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
 * @param opts.intent         - Raw intent text (will be hashed, never stored as-is).
 * @param opts.toolName       - Tool that triggered the intercept.
 * @param opts.response       - The HookResponse from executeRegistryQuery().
 * @param opts.candidateCount - Number of raw candidates the registry returned.
 * @param opts.topScore       - Cosine distance of the top candidate, or null.
 * @param opts.latencyMs      - Elapsed ms from intercept start to now.
 * @param opts.sessionId      - Resolved session ID (default: resolveSessionId()).
 * @param opts.telemetryDir   - Resolved telemetry dir (default: resolveTelemetryDir()).
 */
export function captureTelemetry(opts: {
  intent: string;
  toolName: "Edit" | "Write" | "MultiEdit";
  response: HookResponse;
  candidateCount: number;
  topScore: number | null;
  latencyMs: number;
  sessionId?: string;
  telemetryDir?: string;
}): void {
  const sessionId = opts.sessionId ?? resolveSessionId();
  const dir = opts.telemetryDir ?? resolveTelemetryDir();

  const event: TelemetryEvent = {
    t: Date.now(),
    intentHash: hashIntent(opts.intent),
    toolName: opts.toolName,
    candidateCount: opts.candidateCount,
    topScore: opts.topScore,
    substituted: false, // Phase 1: observe-only; Phase 2 will set this.
    substitutedAtomHash: null, // Phase 1: never substituted.
    latencyMs: opts.latencyMs,
    outcome: outcomeFromResponse(opts.response),
  };

  appendTelemetryEvent(event, sessionId, dir);
}
