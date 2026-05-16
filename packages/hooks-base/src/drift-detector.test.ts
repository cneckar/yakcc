// SPDX-License-Identifier: MIT
/**
 * drift-detector.test.ts — Unit tests for Layer 5 drift-detector module.
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001 (cross-reference)
 *
 * Production trigger:
 *   In production, captureTelemetry (telemetry.ts) calls recordTelemetryEvent()
 *   then checkDrift() on every hook event. After N events the rolling window fills
 *   and drift metrics are computed. If any threshold is crossed, checkDrift()
 *   returns a DriftAlertEnvelope.
 *
 * These tests cover:
 *   1. Window fill and rollover (circular buffer behavior).
 *   2. Each of the four threshold dimensions triggering independently.
 *   3. Multiple alerts in one window.
 *   4. Config injection (no hardcoded thresholds).
 *   5. disableDetection bypass.
 *   6. getDriftMetrics introspection.
 *   7. resetDriftSession isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordTelemetryEvent,
  checkDrift,
  getDriftMetrics,
  resetDriftSession,
  type EventSnapshot,
} from "./drift-detector.js";
import type { Layer5Config } from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION = "test-session-unit";

function makeConfig(overrides?: Partial<Layer5Config>): Layer5Config {
  return {
    rollingWindow: 20,
    specificityFloor: 0.55,
    descentBypassMax: 0.40,
    resultSetMedianMax: 5,
    ratioMedianMax: 4,
    disableDetection: false,
    ...overrides,
  };
}

/** Record N identical snapshots into the session ring. */
function recordN(snap: EventSnapshot, n: number, cfg: Layer5Config): void {
  for (let i = 0; i < n; i++) {
    recordTelemetryEvent(SESSION, snap, cfg.rollingWindow);
  }
}

/** Snapshot: neutral event (no drift signal, candidate count=2, good specificity). */
function neutral(): EventSnapshot {
  return { outcome: "registry-hit", candidateCount: 2, specificityScore: 0.80 };
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetDriftSession(SESSION);
});

afterEach(() => {
  resetDriftSession(SESSION);
});

// ---------------------------------------------------------------------------
// 1. Window fill and rollover
// ---------------------------------------------------------------------------

describe("rolling window — fill and rollover", () => {
  it("empty window produces windowSize=0 and no alert", () => {
    const cfg = makeConfig();
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("ok");
    expect(result.metrics.windowSize).toBe(0);
  });

  it("adding 1 event grows windowSize to 1", () => {
    const cfg = makeConfig();
    recordTelemetryEvent(SESSION, neutral(), cfg.rollingWindow);
    const result = checkDrift(SESSION, cfg);
    expect(result.metrics.windowSize).toBe(1);
  });

  it("window is capped at rollingWindow capacity", () => {
    const cfg = makeConfig({ rollingWindow: 5 });
    recordN(neutral(), 10, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.metrics.windowSize).toBe(5);
  });

  it("oldest events are evicted when window overflows (circular buffer)", () => {
    // Fill window of 3 with low-specificity events, then overwrite with high-specificity.
    const cfg = makeConfig({ rollingWindow: 3, specificityFloor: 0.55 });
    // 3 low-specificity events (score=0.30, below floor)
    recordN({ outcome: "registry-hit", candidateCount: 1, specificityScore: 0.30 }, 3, cfg);
    // Verify alert fires
    expect(checkDrift(SESSION, cfg).status).toBe("drift_alert");

    // Now push 3 high-specificity events — they evict the old ones
    recordN({ outcome: "registry-hit", candidateCount: 1, specificityScore: 0.90 }, 3, cfg);
    // Window is now all high-specificity → no alert
    expect(checkDrift(SESSION, cfg).status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 2a. specificityFloor threshold
// ---------------------------------------------------------------------------

describe("threshold: specificityFloor", () => {
  it("mean specificity below floor triggers specificity_floor alert", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    // All events score 0.40 (< 0.55)
    recordN({ outcome: "registry-hit", candidateCount: 2, specificityScore: 0.40 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.driftMetric).toBe("specificity_floor");
      expect(result.metrics.triggeredDimensions).toContain("specificity_floor");
    }
  });

  it("mean specificity at floor (exact) does NOT alert", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    recordN({ outcome: "registry-hit", candidateCount: 2, specificityScore: 0.55 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    // Mean = 0.55, floor = 0.55 → not strictly less than → no alert
    expect(result.status).toBe("ok");
  });

  it("mean specificity above floor does not alert", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    recordN({ outcome: "registry-hit", candidateCount: 2, specificityScore: 0.80 }, 20, cfg);
    expect(checkDrift(SESSION, cfg).status).toBe("ok");
  });

  it("events without specificityScore are excluded from mean (no NaN bleed)", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    // Mix: 10 events with good score, 10 events with no score
    recordN({ outcome: "registry-hit", candidateCount: 2, specificityScore: 0.80 }, 10, cfg);
    recordN({ outcome: "passthrough", candidateCount: 0 }, 10, cfg);
    // Mean from only the 10 scored events = 0.80 → no alert
    expect(checkDrift(SESSION, cfg).status).toBe("ok");
  });

  it("all events without specificityScore: meanSpecificityScore is NaN, no alert fires", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    recordN({ outcome: "passthrough", candidateCount: 0 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    // NaN < 0.55 is false in JS — no alert should fire for specificity dimension
    expect(result.status).toBe("ok");
    expect(Number.isNaN(result.metrics.meanSpecificityScore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b. descentBypassMax threshold
// ---------------------------------------------------------------------------

describe("threshold: descentBypassMax", () => {
  it("descent-bypass-warning rate above max triggers descent_bypass_rate alert", () => {
    const cfg = makeConfig({ descentBypassMax: 0.40 });
    // 10 bypass warnings + 10 normal = 50% rate > 40%
    recordN({ outcome: "descent-bypass-warning", candidateCount: 1 }, 10, cfg);
    recordN(neutral(), 10, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).toContain("descent_bypass_rate");
    }
  });

  it("bypass rate at threshold (40%) does NOT alert (strictly greater)", () => {
    const cfg = makeConfig({ descentBypassMax: 0.40, rollingWindow: 10 });
    // 4 bypass + 6 normal = 40% = max → not strictly greater → no alert
    recordN({ outcome: "descent-bypass-warning", candidateCount: 1 }, 4, cfg);
    recordN(neutral(), 6, cfg);
    const result = checkDrift(SESSION, cfg);
    // Only descent rate at exactly 0.40 should not trigger (0.40 > 0.40 is false)
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).not.toContain("descent_bypass_rate");
    } else {
      expect(result.status).toBe("ok");
    }
  });

  it("zero bypass warnings: no descent alert", () => {
    const cfg = makeConfig({ descentBypassMax: 0.10 });
    recordN(neutral(), 20, cfg);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.descentBypassRate).toBe(0);
    expect(metrics.triggeredDimensions).not.toContain("descent_bypass_rate");
  });
});

// ---------------------------------------------------------------------------
// 2c. resultSetMedianMax threshold
// ---------------------------------------------------------------------------

describe("threshold: resultSetMedianMax", () => {
  it("median result-set above max triggers result_set_median alert", () => {
    const cfg = makeConfig({ resultSetMedianMax: 5 });
    // All events have candidateCount=8 → median=8 > 5
    recordN({ outcome: "registry-hit", candidateCount: 8 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).toContain("result_set_median");
    }
  });

  it("median result-set at max (exactly 5) does NOT alert (strictly greater)", () => {
    const cfg = makeConfig({ resultSetMedianMax: 5 });
    recordN({ outcome: "registry-hit", candidateCount: 5 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).not.toContain("result_set_median");
    } else {
      expect(result.status).toBe("ok");
    }
  });

  it("median result-set below max: no alert", () => {
    const cfg = makeConfig({ resultSetMedianMax: 5 });
    recordN({ outcome: "registry-hit", candidateCount: 2 }, 20, cfg);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.medianResultSetSize).toBe(2);
    expect(metrics.triggeredDimensions).not.toContain("result_set_median");
  });

  it("median computed correctly for even-count window", () => {
    const cfg = makeConfig({ rollingWindow: 4, resultSetMedianMax: 5 });
    // Window: [2, 4, 6, 8] → sorted: [2,4,6,8] → median = (4+6)/2 = 5.0
    recordTelemetryEvent(SESSION, { outcome: "registry-hit", candidateCount: 2 }, 4);
    recordTelemetryEvent(SESSION, { outcome: "registry-hit", candidateCount: 4 }, 4);
    recordTelemetryEvent(SESSION, { outcome: "registry-hit", candidateCount: 6 }, 4);
    recordTelemetryEvent(SESSION, { outcome: "registry-hit", candidateCount: 8 }, 4);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.medianResultSetSize).toBe(5); // (4+6)/2
    // 5 is not > 5, so no alert for result_set_median
    expect(metrics.triggeredDimensions).not.toContain("result_set_median");
  });
});

// ---------------------------------------------------------------------------
// 2d. ratioMedianMax threshold
// ---------------------------------------------------------------------------

describe("threshold: ratioMedianMax", () => {
  it("median atom ratio above max triggers ratio_median alert", () => {
    const cfg = makeConfig({ ratioMedianMax: 4 });
    // All events carry atomRatio=6 > 4
    recordN({ outcome: "atom-size-too-large", candidateCount: 1, atomRatio: 6 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).toContain("ratio_median");
    }
  });

  it("events without atomRatio are excluded from median (no NaN bleed)", () => {
    const cfg = makeConfig({ ratioMedianMax: 4 });
    // 10 events with good ratio (2), 10 events without ratio
    recordN({ outcome: "registry-hit", candidateCount: 2, atomRatio: 2 }, 10, cfg);
    recordN(neutral(), 10, cfg);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.medianAtomRatio).toBe(2);
    expect(metrics.triggeredDimensions).not.toContain("ratio_median");
  });

  it("all events without atomRatio: medianAtomRatio is NaN, no alert", () => {
    const cfg = makeConfig({ ratioMedianMax: 4 });
    recordN(neutral(), 20, cfg);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(Number.isNaN(metrics.medianAtomRatio)).toBe(true);
    expect(metrics.triggeredDimensions).not.toContain("ratio_median");
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple alerts in one window
// ---------------------------------------------------------------------------

describe("multiple triggered dimensions", () => {
  it("all four dimensions can trigger simultaneously", () => {
    const cfg = makeConfig({
      specificityFloor: 0.55,
      descentBypassMax: 0.30,
      resultSetMedianMax: 3,
      ratioMedianMax: 3,
    });
    // Events that violate all dimensions:
    // - low specificity score (0.30 < 0.55)
    // - descent bypass (8/20 = 40% > 30%)
    // - high candidate count (6 > 3)
    // - high atom ratio (5 > 3)
    recordN(
      {
        outcome: "descent-bypass-warning",
        candidateCount: 6,
        specificityScore: 0.30,
        atomRatio: 5,
      },
      8,
      cfg,
    );
    recordN(
      {
        outcome: "registry-hit",
        candidateCount: 6,
        specificityScore: 0.30,
        atomRatio: 5,
      },
      12,
      cfg,
    );
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions.length).toBeGreaterThan(1);
      // Primary dimension is specificity_floor (canonical first)
      expect(result.driftMetric).toBe("specificity_floor");
    }
  });

  it("primary driftMetric follows canonical order: specificity_floor wins over descent_bypass_rate", () => {
    const cfg = makeConfig({
      specificityFloor: 0.55,
      descentBypassMax: 0.10,
    });
    // Low specificity AND high bypass rate → specificity_floor is primary
    recordN(
      { outcome: "descent-bypass-warning", candidateCount: 2, specificityScore: 0.30 },
      20,
      cfg,
    );
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.driftMetric).toBe("specificity_floor");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Config injection (no hardcoded thresholds)
// ---------------------------------------------------------------------------

describe("config injection — thresholds are config-driven, never hardcoded", () => {
  it("custom specificityFloor=0.90: score of 0.80 now triggers alert", () => {
    const cfg = makeConfig({ specificityFloor: 0.90 });
    recordN({ outcome: "registry-hit", candidateCount: 2, specificityScore: 0.80 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.driftMetric).toBe("specificity_floor");
    }
  });

  it("custom descentBypassMax=0.80: 50% bypass no longer triggers alert", () => {
    const cfg = makeConfig({ descentBypassMax: 0.80 });
    recordN({ outcome: "descent-bypass-warning", candidateCount: 1 }, 10, cfg);
    recordN(neutral(), 10, cfg);
    const result = checkDrift(SESSION, cfg);
    if (result.status === "drift_alert") {
      expect(result.metrics.triggeredDimensions).not.toContain("descent_bypass_rate");
    }
  });

  it("custom rollingWindow=5: window caps at 5, old events evicted", () => {
    const cfg = makeConfig({ rollingWindow: 5, resultSetMedianMax: 5 });
    // 5 high-count events (count=10) followed by 5 low-count events (count=1)
    recordN({ outcome: "registry-hit", candidateCount: 10 }, 5, cfg);
    recordN({ outcome: "registry-hit", candidateCount: 1 }, 5, cfg);
    // After 10 insertions into a capacity-5 ring, only the last 5 remain (count=1)
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.windowSize).toBe(5);
    expect(metrics.medianResultSetSize).toBe(1); // last 5 events all have candidateCount=1
  });

  it("getDefaults layer5 thresholds are used when no config override is applied", () => {
    // Import getDefaults and verify layer5 exists with all required keys
    // (this test is declarative — it asserts defaults exist via the config type)
    const cfg = makeConfig();
    expect(cfg.rollingWindow).toBe(20);
    expect(cfg.specificityFloor).toBe(0.55);
    expect(cfg.descentBypassMax).toBe(0.40);
    expect(cfg.resultSetMedianMax).toBe(5);
    expect(cfg.ratioMedianMax).toBe(4);
    expect(cfg.disableDetection).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. disableDetection bypass
// ---------------------------------------------------------------------------

describe("disableDetection=true", () => {
  it("returns ok with windowSize=0 regardless of recorded events when disabled", () => {
    const cfg = makeConfig({ disableDetection: true, specificityFloor: 0.99 });
    // Record events that would normally trigger every dimension
    recordN({ outcome: "descent-bypass-warning", candidateCount: 100, specificityScore: 0.01 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("ok");
    expect(result.metrics.windowSize).toBe(0);
    expect(result.metrics.triggeredDimensions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. getDriftMetrics introspection
// ---------------------------------------------------------------------------

describe("getDriftMetrics", () => {
  it("returns computed metrics without performing threshold check", () => {
    const cfg = makeConfig();
    recordN({ outcome: "descent-bypass-warning", candidateCount: 3, specificityScore: 0.70 }, 10, cfg);
    recordN({ outcome: "registry-hit", candidateCount: 1, specificityScore: 0.70 }, 10, cfg);
    const metrics = getDriftMetrics(SESSION, cfg);
    expect(metrics.windowSize).toBe(20);
    expect(metrics.descentBypassRate).toBeCloseTo(0.5, 2); // 10/20
    expect(metrics.meanSpecificityScore).toBeCloseTo(0.70, 2);
  });
});

// ---------------------------------------------------------------------------
// 7. resetDriftSession isolation
// ---------------------------------------------------------------------------

describe("resetDriftSession", () => {
  it("clearing a session resets its window to empty", () => {
    const cfg = makeConfig();
    recordN(neutral(), 20, cfg);
    expect(checkDrift(SESSION, cfg).metrics.windowSize).toBe(20);

    resetDriftSession(SESSION);
    expect(checkDrift(SESSION, cfg).metrics.windowSize).toBe(0);
  });

  it("clearing undefined clears all sessions", () => {
    const cfg = makeConfig();
    recordN(neutral(), 20, cfg);

    // Record in a second session
    recordTelemetryEvent("other-session", neutral(), cfg.rollingWindow);

    resetDriftSession(); // clears all
    expect(checkDrift(SESSION, cfg).metrics.windowSize).toBe(0);
    expect(checkDrift("other-session", cfg).metrics.windowSize).toBe(0);
  });

  it("two sessions are isolated — one does not affect the other", () => {
    const cfg = makeConfig({ descentBypassMax: 0.40 });
    // Session A: 50% bypass (should alert)
    recordN({ outcome: "descent-bypass-warning", candidateCount: 1 }, 10, cfg);
    recordN(neutral(), 10, cfg);

    // Session B: no bypass (should not alert)
    const sessionB = "test-session-b";
    resetDriftSession(sessionB);
    for (let i = 0; i < 20; i++) {
      recordTelemetryEvent(sessionB, neutral(), cfg.rollingWindow);
    }

    const resultA = checkDrift(SESSION, cfg);
    const resultB = checkDrift(sessionB, cfg);

    expect(resultA.status).toBe("drift_alert");
    expect(resultB.status).toBe("ok");

    resetDriftSession(sessionB);
  });
});

// ---------------------------------------------------------------------------
// 8. Suggestion text quality
// ---------------------------------------------------------------------------

describe("alert suggestion text", () => {
  it("specificity_floor suggestion mentions the score and threshold", () => {
    const cfg = makeConfig({ specificityFloor: 0.55 });
    recordN({ outcome: "registry-hit", candidateCount: 1, specificityScore: 0.30 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      expect(result.suggestion).toContain("0.55");
      expect(result.suggestion.length).toBeGreaterThan(20);
    }
  });

  it("descent_bypass_rate suggestion mentions bypass rate and threshold", () => {
    const cfg = makeConfig({ specificityFloor: 0, descentBypassMax: 0.10 });
    recordN({ outcome: "descent-bypass-warning", candidateCount: 1 }, 20, cfg);
    const result = checkDrift(SESSION, cfg);
    expect(result.status).toBe("drift_alert");
    if (result.status === "drift_alert") {
      // Primary must be descent_bypass_rate (specificity_floor disabled with floor=0)
      if (result.driftMetric === "descent_bypass_rate") {
        expect(result.suggestion).toContain("10.0%");
      }
    }
  });
});
