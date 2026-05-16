// SPDX-License-Identifier: MIT
/**
 * telemetry-wire.ts — Wire envelope schema for the telemetry export pipeline.
 *
 * @decision DEC-TELEMETRY-EXPORT-ENVELOPE-003
 * @title Wire envelope: {schemaVersion:1, sessionId, events[], emittedAt, source}
 * @status accepted
 * @rationale
 *   Schema versioning lives on the envelope, not on individual TelemetryEvents.
 *   Events are already additive per DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001;
 *   the envelope is the new contract surface introduced in Slice 1.
 *   `source` gives the receiver platform/version bucketing without PII.
 *   `schemaVersion` starts at 1; a future bump (e.g. adding a `deployId`) requires
 *   only a new constant here and a corresponding receiver version gate.
 *
 *   DEC-TELEMETRY-EXPORT-PRIVACY-006: The `events` array in the envelope always
 *   carries `intentHash` only — the HTTPS sink path never emits raw `intent` text
 *   in Slice 1, regardless of `YAKCC_TELEMETRY_FULL_INTENT`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelemetryEvent } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Schema version constant
// ---------------------------------------------------------------------------

/**
 * Wire envelope schema version.
 *
 * @decision DEC-TELEMETRY-EXPORT-ENVELOPE-003
 * Bumped when the envelope shape changes incompatibly (e.g. field rename,
 * required field added). Additive optional fields do NOT require a bump.
 * The receiver uses this to route to the correct deserialization path.
 */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Source block
// ---------------------------------------------------------------------------

/**
 * Process/runtime identification block in the wire envelope.
 * No PII — only version strings and platform identifiers.
 */
export type TelemetrySource = {
  /** @yakcc/hooks-base version from package.json, or "unknown". */
  readonly cliVersion: string;
  /** Node.js `process.platform` (e.g. "linux", "darwin", "win32"). */
  readonly platform: string;
  /** Node.js version string (e.g. "v20.11.0"). */
  readonly nodeVersion: string;
};

// ---------------------------------------------------------------------------
// Wire envelope
// ---------------------------------------------------------------------------

/**
 * Schemaful wire envelope posted to the HTTPS endpoint.
 *
 * @decision DEC-TELEMETRY-EXPORT-ENVELOPE-003
 * Immutable once constructed by `buildEnvelope`. The receiver expects
 * this exact shape at `schemaVersion === 1`.
 */
export type TelemetryEnvelope = {
  /** Always === SCHEMA_VERSION (1). Receiver uses this to route deserialization. */
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Session identifier (CLAUDE_SESSION_ID or process-scoped UUID fallback). */
  readonly sessionId: string;
  /** Batch of events being emitted. Non-empty by construction. */
  readonly events: readonly TelemetryEvent[];
  /** Unix timestamp in milliseconds at envelope construction time. */
  readonly emittedAt: number;
  /** Runtime identification (no PII). */
  readonly source: TelemetrySource;
};

// ---------------------------------------------------------------------------
// Source block builder (lazy-resolved at first use)
// ---------------------------------------------------------------------------

let _cachedSource: TelemetrySource | null = null;

/**
 * Build (and cache) the `source` block from package.json + process globals.
 *
 * @decision DEC-TELEMETRY-EXPORT-ENVELOPE-003
 * Reads `@yakcc/hooks-base/package.json` once at first call. Falls back
 * to "unknown" if the file is missing or unparseable (e.g. in tests that
 * run against worktree source without a dist build).
 */
function buildSource(): TelemetrySource {
  if (_cachedSource !== null) return _cachedSource;

  let cliVersion = "unknown";
  try {
    // Resolve package.json relative to this file's location (src/ → package.json)
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = resolve(join(dirname(__filename), "../package.json"));
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cliVersion = typeof pkgJson.version === "string" ? pkgJson.version : "unknown";
  } catch {
    // Fallback: version unresolvable in tests or unusual layouts
  }

  _cachedSource = {
    cliVersion,
    platform: process.platform,
    nodeVersion: process.version,
  };
  return _cachedSource;
}

/**
 * Reset the cached source block.
 * Exposed for testing only — do NOT call in production code.
 * @internal
 */
export function _resetSourceCache(): void {
  _cachedSource = null;
}

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

/**
 * Construct a `TelemetryEnvelope` from a batch of events and a session ID.
 *
 * @param events    - Non-empty array of telemetry events to include.
 * @param sessionId - Resolved session ID (from `resolveSessionId()`).
 * @param now       - Override for `Date.now()`. Injectable for tests.
 * @returns Ready-to-serialize `TelemetryEnvelope`.
 *
 * @decision DEC-TELEMETRY-EXPORT-ENVELOPE-003
 * The envelope always uses `schemaVersion === 1`. Events carry `intentHash`
 * only (DEC-TELEMETRY-EXPORT-PRIVACY-006 — HTTPS path never emits raw intent).
 */
export function buildEnvelope(
  events: readonly TelemetryEvent[],
  sessionId: string,
  now = Date.now(),
): TelemetryEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    events,
    emittedAt: now,
    source: buildSource(),
  };
}
