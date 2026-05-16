// SPDX-License-Identifier: MIT
/**
 * telemetry-wire.test.ts — Unit tests for TelemetryEnvelope / buildEnvelope.
 *
 * Covers:
 *   - SCHEMA_VERSION === 1 (DEC-TELEMETRY-EXPORT-ENVELOPE-003)
 *   - buildEnvelope shape: all required fields present with correct types
 *   - source block populated: cliVersion (string), platform, nodeVersion
 *   - emittedAt is injectable (now param) — deterministic in tests
 *   - events array is preserved verbatim
 *   - _resetSourceCache() clears the singleton so each test is isolated
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEMA_VERSION,
  type TelemetryEnvelope,
  _resetSourceCache,
  buildEnvelope,
} from "../src/telemetry-wire.js";
import type { TelemetryEvent } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    t: 1_000,
    intentHash: "a".repeat(64),
    toolName: "Edit",
    candidateCount: 0,
    topScore: null,
    substituted: false,
    substitutedAtomHash: null,
    latencyMs: 10,
    outcome: "passthrough",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset cache between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetSourceCache();
});

afterEach(() => {
  _resetSourceCache();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// SCHEMA_VERSION constant
// ---------------------------------------------------------------------------

describe("SCHEMA_VERSION", () => {
  it("equals 1 (DEC-TELEMETRY-EXPORT-ENVELOPE-003)", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("is a numeric literal (not a string)", () => {
    expect(typeof SCHEMA_VERSION).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope — shape correctness
// ---------------------------------------------------------------------------

describe("buildEnvelope — envelope shape", () => {
  const SESSION = "test-session-wire";
  const NOW = 1_700_000_000_000;

  it("returns an object with all required fields", () => {
    const events = [makeEvent()];
    const env: TelemetryEnvelope = buildEnvelope(events, SESSION, NOW);

    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.sessionId).toBe(SESSION);
    expect(env.emittedAt).toBe(NOW);
    expect(Array.isArray(env.events)).toBe(true);
    expect(typeof env.source).toBe("object");
    expect(env.source).not.toBeNull();
  });

  it("schemaVersion is always === SCHEMA_VERSION (1)", () => {
    const env = buildEnvelope([makeEvent()], SESSION, NOW);
    expect(env.schemaVersion).toBe(1);
  });

  it("emittedAt defaults to Date.now() when not injected", () => {
    const before = Date.now();
    const env = buildEnvelope([makeEvent()], SESSION);
    const after = Date.now();
    expect(env.emittedAt).toBeGreaterThanOrEqual(before);
    expect(env.emittedAt).toBeLessThanOrEqual(after);
  });

  it("preserves the events array verbatim", () => {
    const e1 = makeEvent({ outcome: "registry-hit", candidateCount: 1 });
    const e2 = makeEvent({ outcome: "synthesis-required", toolName: "Write" });
    const env = buildEnvelope([e1, e2], SESSION, NOW);

    expect(env.events).toHaveLength(2);
    expect(env.events[0]).toStrictEqual(e1);
    expect(env.events[1]).toStrictEqual(e2);
  });

  it("sessionId is passed through verbatim", () => {
    const id = "custom-session-xyz-789";
    const env = buildEnvelope([makeEvent()], id, NOW);
    expect(env.sessionId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope — source block
// ---------------------------------------------------------------------------

describe("buildEnvelope — source block", () => {
  const SESSION = "test-session-source";
  const NOW = 1_700_000_001_000;

  it("source.cliVersion is a non-empty string", () => {
    const env = buildEnvelope([makeEvent()], SESSION, NOW);
    expect(typeof env.source.cliVersion).toBe("string");
    expect(env.source.cliVersion.length).toBeGreaterThan(0);
  });

  it("source.platform matches process.platform", () => {
    const env = buildEnvelope([makeEvent()], SESSION, NOW);
    expect(env.source.platform).toBe(process.platform);
  });

  it("source.nodeVersion matches process.version", () => {
    const env = buildEnvelope([makeEvent()], SESSION, NOW);
    expect(env.source.nodeVersion).toBe(process.version);
  });

  it("source.cliVersion is a semver-shaped string or 'unknown'", () => {
    const env = buildEnvelope([makeEvent()], SESSION, NOW);
    // Either 'unknown' (package.json unreadable in worktree source context)
    // or a semver string like '0.0.1'
    const isUnknown = env.source.cliVersion === "unknown";
    const isSemver = /^\d+\.\d+\.\d+/.test(env.source.cliVersion);
    expect(isUnknown || isSemver).toBe(true);
  });

  it("source is cached — same reference on repeated calls (lazy singleton)", () => {
    const env1 = buildEnvelope([makeEvent()], SESSION, NOW);
    const env2 = buildEnvelope([makeEvent()], SESSION, NOW + 1);
    // source block is the same object reference (singleton)
    expect(env1.source).toBe(env2.source);
  });

  it("_resetSourceCache() clears the singleton so next call re-reads source", () => {
    const env1 = buildEnvelope([makeEvent()], SESSION, NOW);
    _resetSourceCache();
    const env2 = buildEnvelope([makeEvent()], SESSION, NOW + 1);
    // After reset, a new source object is constructed (different reference)
    // but the values should still be valid
    expect(typeof env2.source.cliVersion).toBe("string");
    expect(env2.source.platform).toBe(process.platform);
    // They should be equal in value even if not the same reference
    expect(env2.source.cliVersion).toBe(env1.source.cliVersion);
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope — JSON round-trip (wire safety)
// ---------------------------------------------------------------------------

describe("buildEnvelope — JSON round-trip", () => {
  it("envelope serializes and deserializes without data loss", () => {
    const event = makeEvent({
      t: 1_700_000_002_000,
      intentHash: "b3".repeat(32),
      toolName: "Write",
      candidateCount: 3,
      topScore: 0.42,
      latencyMs: 55,
      outcome: "registry-hit",
    });
    const env = buildEnvelope([event], "session-roundtrip", 1_700_000_002_500);
    const json = JSON.stringify(env);
    const parsed = JSON.parse(json) as TelemetryEnvelope;

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sessionId).toBe("session-roundtrip");
    expect(parsed.emittedAt).toBe(1_700_000_002_500);
    expect(parsed.events[0]?.outcome).toBe("registry-hit");
    expect(parsed.source.platform).toBe(process.platform);
  });
});
