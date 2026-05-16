// SPDX-License-Identifier: MIT
// @mock-exempt: Registry is an external service boundary (@yakcc/registry wraps sqlite-vec).
// Using a plain in-memory stub object (no vi.fn()) following the makeCountingRegistryStub()
// pattern from intent-specificity-integration.test.ts.
/**
 * result-set-size-integration.test.ts — Layer 2 integration tests.
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 * title: Layer 2 integration — full hook path with counting registry stub
 * status: decided (wi-590-s2-layer2)
 * rationale:
 *   Unit tests in result-set-size.test.ts verify scoreResultSetSize() in isolation.
 *   These integration tests verify Layer 2 is correctly wired inside
 *   executeRegistryQueryWithSubstitution() — the production hook entry point.
 *
 *   Production sequence exercised:
 *     1. executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, opts)
 *     2. Layer 1 gate runs (intent must pass — we use a specific enough intent)
 *     3. Registry stub returns many/few candidates with controlled cosine distances
 *     4. Layer 2 runs scoreResultSetSize(candidates)
 *     5a. Many confident → passthrough + resultSetRejectEnvelope
 *     5b. Few candidates → proceeds normally (synthesis-required)
 *
 *   Compound-interaction test requirement satisfied: exercises Layer 1 gate →
 *   registry stub → Layer 2 gate → response envelope in one production sequence.
 *
 *   Registry stub is a plain in-memory object (not vi.fn()) following the
 *   makeCountingRegistryStub() pattern from intent-specificity-integration.test.ts.
 *   Registry is an external boundary (@yakcc/registry wraps sqlite-vec) — the stub
 *   is the minimal injectable boundary, not a mock of internal code.
 *
 * Production trigger: pnpm --filter @yakcc/hooks-base test
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CandidateMatch } from "@yakcc/registry";
import { resetConfigOverride, setConfigOverride, getDefaults, loadEnforcementConfig } from "../src/enforcement-config.js";
import {
  type EmissionContext,
  type HookResponseWithSubstitution,
  executeRegistryQueryWithSubstitution,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Registry stub helpers
// ---------------------------------------------------------------------------

/**
 * Build a confident CandidateMatch stub.
 *
 * cosineDistance=0.5:
 *   combinedScore = 1 - 0.25/4 = 0.9375 >= confidentThreshold=0.70 → "confident"
 *   0.5 > DEFAULT_REGISTRY_HIT_THRESHOLD=0.30 → NOT a registry hit (no D2 substitution)
 *
 * This puts candidates in the confident band for Layer 2 but avoids the D2 auto-accept
 * path, so Layer 2 is the decisive gate in these tests.
 */
function makeConfidentCandidate(): CandidateMatch {
  return {
    cosineDistance: 0.5,
    block: {
      specCanonicalBytes: new Uint8Array(32).fill(1),
      spec: {
        behavior: "stub confident",
        inputs: [],
        outputs: [],
        guarantees: [],
        errorConditions: [],
        nonFunctional: { purity: "pure", threadSafety: "safe" },
        propertyTests: [],
      },
    },
  } as unknown as CandidateMatch;
}

/**
 * Build a weak CandidateMatch stub.
 *
 * cosineDistance=1.2:
 *   combinedScore = 1 - 1.44/4 = 0.64 < confidentThreshold=0.70 → "weak" (not confident)
 */
function makeWeakCandidate(): CandidateMatch {
  return {
    cosineDistance: 1.2,
    block: {
      specCanonicalBytes: new Uint8Array(32).fill(2),
      spec: {
        behavior: "stub weak",
        inputs: [],
        outputs: [],
        guarantees: [],
        errorConditions: [],
        nonFunctional: { purity: "pure", threadSafety: "safe" },
        propertyTests: [],
      },
    },
  } as unknown as CandidateMatch;
}

/**
 * Build a plain in-memory Registry stub that returns a fixed candidate list.
 * Also records how many times findCandidatesByQuery was called (for assert-not-called).
 *
 * Uses the same pattern as makeCountingRegistryStub() in intent-specificity-integration.test.ts.
 */
function makeRegistryStub(candidates: CandidateMatch[]): {
  registry: Parameters<typeof executeRegistryQueryWithSubstitution>[0];
  callCount: () => number;
} {
  let calls = 0;
  const registry = {
    findCandidatesByQuery: async (_card: unknown) => {
      calls++;
      return { candidates };
    },
    findCandidatesByIntent: async () => ({ candidates }),
    storeBlock: async () => {
      throw new Error("storeBlock not expected in Layer 2 gate tests");
    },
    close: async () => {},
  } as unknown as Parameters<typeof executeRegistryQueryWithSubstitution>[0];
  return { registry, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * A specific intent that passes Layer 1.
 * "parse ISO 8601 date string to UTC timestamp" — has action verb + 9 words + I/O specifics.
 */
const SPECIFIC_INTENT = "parse ISO 8601 date string to UTC timestamp";
const PASSTHROUGH_CODE = "// placeholder code";
const TOOL_NAME = "Write" as const;

function makeTelemetryOpts(): { sessionId: string; telemetryDir: string } {
  const sessionId = `test-layer2-integration-${Date.now()}`;
  const telemetryDir = join(tmpdir(), "yakcc-test-telemetry-layer2");
  return { sessionId, telemetryDir };
}

const BASE_OPTIONS = {
  threshold: 0.3,
  ...makeTelemetryOpts(),
};

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetConfigOverride();
  savedEnv = {
    YAKCC_HOOK_DISABLE_SUBSTITUTE: process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE,
    YAKCC_HOOK_DISABLE_ATOMIZE: process.env.YAKCC_HOOK_DISABLE_ATOMIZE,
    YAKCC_HOOK_DISABLE_RESULT_SET_GATE: process.env.YAKCC_HOOK_DISABLE_RESULT_SET_GATE,
    YAKCC_HOOK_DISABLE_INTENT_GATE: process.env.YAKCC_HOOK_DISABLE_INTENT_GATE,
  };
  // Disable substitute + atomize so Layer 2 is the decisive gate.
  process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE = "1";
  process.env.YAKCC_HOOK_DISABLE_ATOMIZE = "1";
  delete process.env.YAKCC_HOOK_DISABLE_RESULT_SET_GATE;
  delete process.env.YAKCC_HOOK_DISABLE_INTENT_GATE;
});

afterEach(() => {
  resetConfigOverride();
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ---------------------------------------------------------------------------
// Integration: Layer 2 fires on oversized confident result set
//
// Compound-interaction test: exercises Layer 1 → registry stub → Layer 2 → envelope.
// ---------------------------------------------------------------------------

describe("Layer 2 integration — oversized confident result set rejected by hook", () => {
  it("returns passthrough + resultSetRejectEnvelope when 12 confident candidates returned", async () => {
    const candidates = Array.from({ length: 12 }, () => makeConfidentCandidate());
    const { registry, callCount } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    // Registry WAS queried (Layer 1 passed, Layer 2 is the decision point).
    expect(callCount(), "registry must be queried — Layer 1 passed").toBeGreaterThan(0);

    // Layer 2 fires: response kind is passthrough.
    expect(result.kind).toBe("passthrough");
    expect(result.substituted).toBe(false);

    // resultSetRejectEnvelope must be present.
    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "resultSetRejectEnvelope must be set by Layer 2").toBeDefined();
    if (r.resultSetRejectEnvelope !== undefined) {
      expect(r.resultSetRejectEnvelope.layer).toBe(2);
      expect(r.resultSetRejectEnvelope.status).toBe("result_set_too_large");
      expect(r.resultSetRejectEnvelope.reasons).toContain("too_many_confident");
      expect(r.resultSetRejectEnvelope.confidentCount).toBe(12);
      expect(r.resultSetRejectEnvelope.totalCount).toBe(12);
      expect(r.resultSetRejectEnvelope.maxConfident).toBe(3); // default
      expect(typeof r.resultSetRejectEnvelope.suggestion).toBe("string");
      expect(r.resultSetRejectEnvelope.suggestion.length).toBeGreaterThan(0);
    }

    // intentRejectEnvelope must NOT be set (Layer 1 passed).
    expect(r.intentRejectEnvelope, "intentRejectEnvelope must be absent — Layer 1 passed").toBeUndefined();
  });

  it("returns passthrough + resultSetRejectEnvelope when 4 confident candidates (boundary+1)", async () => {
    // 4 > maxConfident=3
    const candidates = Array.from({ length: 4 }, () => makeConfidentCandidate());
    const { registry } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    expect(result.kind).toBe("passthrough");
    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "Layer 2 must reject 4 confident").toBeDefined();
    if (r.resultSetRejectEnvelope !== undefined) {
      expect(r.resultSetRejectEnvelope.reasons).toContain("too_many_confident");
      expect(r.resultSetRejectEnvelope.confidentCount).toBe(4);
      expect(r.resultSetRejectEnvelope.maxConfident).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Layer 2 does NOT fire when result set within limits
// ---------------------------------------------------------------------------

describe("Layer 2 integration — within-limit result set passes through", () => {
  it("does NOT set resultSetRejectEnvelope when exactly 3 confident candidates (at boundary)", async () => {
    const candidates = Array.from({ length: 3 }, () => makeConfidentCandidate());
    const { registry, callCount } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    expect(callCount()).toBeGreaterThan(0);

    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "Layer 2 must not fire at exactly maxConfident=3").toBeUndefined();

    // cosineDistance=0.5 > threshold=0.3 → no registry hit → synthesis-required.
    expect(result.kind).toBe("synthesis-required");
  });

  it("does NOT set resultSetRejectEnvelope with 0 confident + 5 weak candidates", async () => {
    const candidates = Array.from({ length: 5 }, () => makeWeakCandidate());
    const { registry } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "Layer 2 must not fire for weak-only band").toBeUndefined();
    expect(result.kind).toBe("synthesis-required");
  });

  it("does NOT set resultSetRejectEnvelope with empty candidate list", async () => {
    const { registry } = makeRegistryStub([]);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope).toBeUndefined();
    expect(result.kind).toBe("synthesis-required");
  });
});

// ---------------------------------------------------------------------------
// Integration: YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1 escape hatch
// ---------------------------------------------------------------------------

describe("Layer 2 integration — YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1 escape hatch", () => {
  it("bypasses Layer 2 when escape hatch is set, even with 12 confident candidates", async () => {
    process.env.YAKCC_HOOK_DISABLE_RESULT_SET_GATE = "1";

    const candidates = Array.from({ length: 12 }, () => makeConfidentCandidate());
    const { registry, callCount } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    // Registry was still queried (Layer 1 passed, Layer 2 bypassed).
    expect(callCount()).toBeGreaterThan(0);

    // Layer 2 bypassed — no reject envelope.
    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "Layer 2 must be bypassed by escape hatch").toBeUndefined();

    // 12 candidates at d=0.5 > threshold=0.3 → synthesis-required.
    expect(result.kind).toBe("synthesis-required");
  });
});

// ---------------------------------------------------------------------------
// Integration: config override drives the threshold in the hook path
// ---------------------------------------------------------------------------

describe("Layer 2 integration — config override propagates through hook path", () => {
  it("maxConfident=10 override: 9 confident candidates → no Layer 2 rejection", async () => {
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 10, maxOverall: 50, confidentThreshold: 0.7 },
    });

    const candidates = Array.from({ length: 9 }, () => makeConfidentCandidate());
    const { registry } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "maxConfident=10 config must not reject 9 candidates").toBeUndefined();
    expect(result.kind).toBe("synthesis-required");
  });

  it("maxConfident=1 override: 2 confident candidates → Layer 2 fires", async () => {
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 1, maxOverall: 10, confidentThreshold: 0.7 },
    });

    const candidates = [makeConfidentCandidate(), makeConfidentCandidate()];
    const { registry } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: SPECIFIC_INTENT };

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    expect(result.kind).toBe("passthrough");
    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.resultSetRejectEnvelope, "maxConfident=1 config must reject 2 candidates").toBeDefined();
    if (r.resultSetRejectEnvelope !== undefined) {
      expect(r.resultSetRejectEnvelope.maxConfident).toBe(1);
      expect(r.resultSetRejectEnvelope.confidentCount).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Layer 1 rejects before Layer 2 can run
// (compound-interaction: Layer 1 → Layer 2 priority ordering)
// ---------------------------------------------------------------------------

describe("Layer 2 integration — Layer 1 takes priority over Layer 2", () => {
  it("vague intent rejected by Layer 1; registry never called, Layer 2 does NOT set envelope", async () => {
    // Use 12 confident candidates — if Layer 2 ran, it would reject. But Layer 1 should fire first.
    const candidates = Array.from({ length: 12 }, () => makeConfidentCandidate());
    const { registry, callCount } = makeRegistryStub(candidates);
    const ctx: EmissionContext = { intent: "utility handler stuff" }; // vague — Layer 1 rejects

    const result = await executeRegistryQueryWithSubstitution(
      registry,
      ctx,
      PASSTHROUGH_CODE,
      TOOL_NAME,
      { threshold: 0.3, ...makeTelemetryOpts() },
    );

    // Registry was NOT queried — Layer 1 short-circuited.
    expect(callCount(), "registry must not be queried when Layer 1 rejects").toBe(0);

    // Response is passthrough with Layer 1 envelope, NOT Layer 2 envelope.
    expect(result.kind).toBe("passthrough");
    const r = result as HookResponseWithSubstitution & { substituted: false };
    expect(r.intentRejectEnvelope, "Layer 1 envelope must be present").toBeDefined();
    expect(r.resultSetRejectEnvelope, "Layer 2 envelope must be absent when Layer 1 fires").toBeUndefined();
  });
});
