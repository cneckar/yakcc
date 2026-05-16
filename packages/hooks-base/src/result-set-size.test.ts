// SPDX-License-Identifier: MIT
/**
 * result-set-size.test.ts — Unit tests for Layer 2 result-set size enforcement.
 *
 * Production trigger: scoreResultSetSize() is called synchronously inside
 * executeRegistryQueryWithSubstitution() (index.ts) AFTER the registry query
 * resolves and BEFORE candidates are returned to the consumer.
 *
 * These tests verify:
 *   1. Default config — accept when confidentCount <= 3 AND totalCount <= 10.
 *   2. Reject when confidentCount > maxConfident (too_many_confident).
 *   3. Reject when totalCount > maxOverall (too_many_overall).
 *   4. Accept/reject boundaries are exact (=limit → accept, limit+1 → reject).
 *   5. Config overrides drive threshold changes (no hardcoded constants in module).
 *   6. isResultSetSizeOk() convenience predicate mirrors status.
 *   7. Reject envelope carries correct counts and thresholds for telemetry.
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CandidateMatch } from "@yakcc/registry";
import { getDefaults, resetConfigOverride, setConfigOverride } from "./enforcement-config.js";
import { isResultSetSizeOk, scoreResultSetSize } from "./result-set-size.js";

// ---------------------------------------------------------------------------
// Helpers — build minimal CandidateMatch objects
// ---------------------------------------------------------------------------

/**
 * Build a minimal CandidateMatch-shaped stub with the given cosine distance.
 *
 * combinedScore = 1 - d^2/4.
 * CONFIDENT_THRESHOLD = 0.70 → cosineDistance <= sqrt((1-0.70)*4) = sqrt(1.2) ~= 1.095.
 *
 * Quick reference:
 *   d=0.0   → score=1.00  (confident)
 *   d=0.5   → score=0.9375 (confident)
 *   d=1.0   → score=0.75   (confident)
 *   d=1.095 → score=0.70   (confident, at threshold)
 *   d=1.1   → score=0.6975 (NOT confident)
 *   d=1.5   → score=0.4375 (NOT confident)
 *   d=2.0   → score=0.00   (maximally distant)
 */
function makeCandidate(cosineDistance: number): CandidateMatch {
  return {
    cosineDistance,
    block: {
      specCanonicalBytes: new Uint8Array(0),
      spec: {
        behavior: "stub",
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

/** Build N confident candidates (score >= 0.70, d=0.5). */
function makeConfidentCandidates(n: number): CandidateMatch[] {
  return Array.from({ length: n }, () => makeCandidate(0.5));
}

/** Build N weak candidates (score < 0.70, d=1.2). */
function makeWeakCandidates(n: number): CandidateMatch[] {
  return Array.from({ length: n }, () => makeCandidate(1.2));
}

// ---------------------------------------------------------------------------
// Setup / teardown — reset config between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
});

afterEach(() => {
  resetConfigOverride();
});

// ---------------------------------------------------------------------------
// 1. Default config — accept paths
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — accept paths (default config)", () => {
  it("accepts empty candidate list", () => {
    const result = scoreResultSetSize([]);
    expect(result.status).toBe("ok");
    expect(result.layer).toBe(2);
    if (result.status === "ok") {
      expect(result.confidentCount).toBe(0);
      expect(result.totalCount).toBe(0);
    }
  });

  it("accepts exactly maxConfident=3 confident candidates", () => {
    const candidates = makeConfidentCandidates(3);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.confidentCount).toBe(3);
      expect(result.totalCount).toBe(3);
    }
  });

  it("accepts mix of confident + weak within limits", () => {
    // 2 confident + 5 weak = 7 total, 2 confident — all within defaults
    const candidates = [...makeConfidentCandidates(2), ...makeWeakCandidates(5)];
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("ok");
  });

  it("accepts exactly maxOverall=10 total candidates (0 confident)", () => {
    const candidates = makeWeakCandidates(10);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.confidentCount).toBe(0);
      expect(result.totalCount).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. too_many_confident rejections
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — too_many_confident rejections", () => {
  it("rejects when confidentCount = maxConfident + 1 (4 confident, default max=3)", () => {
    const candidates = makeConfidentCandidates(4);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    expect(result.layer).toBe(2);
    if (result.status === "result_set_too_large") {
      expect(result.reasons).toContain("too_many_confident");
      expect(result.confidentCount).toBe(4);
      expect(result.totalCount).toBe(4);
      expect(result.maxConfident).toBe(3);
      expect(typeof result.suggestion).toBe("string");
      expect(result.suggestion.length).toBeGreaterThan(0);
    }
  });

  it("rejects 10 confident candidates — only too_many_confident reason (total=10 at limit)", () => {
    const candidates = makeConfidentCandidates(10);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.reasons).toContain("too_many_confident");
      // total=10 equals maxOverall=10, so too_many_overall NOT triggered
      expect(result.reasons).not.toContain("too_many_overall");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. too_many_overall rejections
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — too_many_overall rejections", () => {
  it("rejects when totalCount = maxOverall + 1 (11 weak, default max=10)", () => {
    const candidates = makeWeakCandidates(11);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.reasons).toContain("too_many_overall");
      expect(result.reasons).not.toContain("too_many_confident");
      expect(result.totalCount).toBe(11);
      expect(result.maxOverall).toBe(10);
    }
  });

  it("rejects with both reasons when both limits exceeded", () => {
    // 5 confident + 8 weak = 13 total; 5 > maxConfident=3 AND 13 > maxOverall=10
    const candidates = [...makeConfidentCandidates(5), ...makeWeakCandidates(8)];
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.reasons).toContain("too_many_confident");
      expect(result.reasons).toContain("too_many_overall");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Exact boundary: limit → accept; limit+1 → reject
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — boundary precision", () => {
  it("confident boundary: exactly maxConfident accepts, maxConfident+1 rejects", () => {
    const atLimit = makeConfidentCandidates(3); // default maxConfident=3
    expect(scoreResultSetSize(atLimit).status).toBe("ok");

    const overLimit = makeConfidentCandidates(4);
    expect(scoreResultSetSize(overLimit).status).toBe("result_set_too_large");
  });

  it("overall boundary: exactly maxOverall accepts, maxOverall+1 rejects", () => {
    const atLimit = makeWeakCandidates(10); // default maxOverall=10
    expect(scoreResultSetSize(atLimit).status).toBe("ok");

    const overLimit = makeWeakCandidates(11);
    expect(scoreResultSetSize(overLimit).status).toBe("result_set_too_large");
  });
});

// ---------------------------------------------------------------------------
// 5. Config overrides drive threshold changes
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — config overrides (no hardcoded constants)", () => {
  it("tighter config: maxConfident=1 rejects 2 confident", () => {
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 1, maxOverall: 10, confidentThreshold: 0.7 },
    });
    const candidates = makeConfidentCandidates(2);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.reasons).toContain("too_many_confident");
      expect(result.maxConfident).toBe(1);
    }
  });

  it("looser config: maxConfident=10 accepts 9 confident", () => {
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 10, maxOverall: 50, confidentThreshold: 0.7 },
    });
    const candidates = makeConfidentCandidates(9);
    expect(scoreResultSetSize(candidates).status).toBe("ok");
  });

  it("confidentThreshold override changes which candidates are 'confident'", () => {
    // Raise threshold to 0.95 — d=0.5 gives score=0.9375 < 0.95, NOT confident
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 1, maxOverall: 10, confidentThreshold: 0.95 },
    });
    // 3 candidates with d=0.5 (score=0.9375) — not confident at threshold=0.95
    const candidates = makeConfidentCandidates(3); // d=0.5, score=0.9375
    // 0.9375 < 0.95, so confidentCount=0, which is <= maxConfident=1 → accept
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.confidentCount).toBe(0);
    }
  });

  it("env-var YAKCC_RESULT_SET_MAX override applies (maxConfident=1)", () => {
    // Simulate what loadEnforcementConfig({ env: { YAKCC_RESULT_SET_MAX: "1" } }) produces.
    // Using setConfigOverride avoids async dynamic import in a sync test body.
    setConfigOverride({
      ...getDefaults(),
      layer2: { maxConfident: 1, maxOverall: 10, confidentThreshold: 0.7 },
    });
    const result = scoreResultSetSize(makeConfidentCandidates(2));
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.maxConfident).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. isResultSetSizeOk() convenience predicate
// ---------------------------------------------------------------------------

describe("isResultSetSizeOk()", () => {
  it("returns true for accepted candidate list", () => {
    expect(isResultSetSizeOk(makeConfidentCandidates(2))).toBe(true);
  });

  it("returns false for rejected candidate list", () => {
    expect(isResultSetSizeOk(makeConfidentCandidates(4))).toBe(false);
  });

  it("returns true for empty list", () => {
    expect(isResultSetSizeOk([])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Reject envelope shape verification (telemetry coverage)
// ---------------------------------------------------------------------------

describe("scoreResultSetSize() — reject envelope completeness", () => {
  it("reject envelope has all required fields for telemetry", () => {
    const candidates = makeConfidentCandidates(5);
    const result = scoreResultSetSize(candidates);
    expect(result.status).toBe("result_set_too_large");
    if (result.status === "result_set_too_large") {
      expect(result.layer).toBe(2);
      expect(Array.isArray(result.reasons)).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(typeof result.confidentCount).toBe("number");
      expect(typeof result.totalCount).toBe("number");
      expect(typeof result.maxConfident).toBe("number");
      expect(typeof result.maxOverall).toBe("number");
      expect(typeof result.suggestion).toBe("string");
    }
  });

  it("accept envelope has layer=2 and numeric counts", () => {
    const result = scoreResultSetSize(makeConfidentCandidates(2));
    expect(result.layer).toBe(2);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(typeof result.confidentCount).toBe("number");
      expect(typeof result.totalCount).toBe("number");
    }
  });
});
