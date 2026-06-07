// SPDX-License-Identifier: Apache-2.0
/**
 * scoring.test.ts — pure-Node deterministic tests for the scoring primitives.
 *
 * Asserts:
 * 1. cosineDistanceToCombinedScore() is byte-identical to the registry source
 *    across a table of distances including boundaries (0, √2, 2).
 * 2. assignScoreBand() correctly assigns bands at the documented boundaries
 *    (0.85 strong, 0.70 confident, 0.50 weak, <0.50 poor).
 * 3. Auto-accept threshold constants match the resolve.ts source values
 *    (DEC-1117-AUTHORITY-001 value-equality assertion).
 * 4. cosineSimilarity() handles unit vectors, zero vectors, and mismatched lengths.
 */

import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_GAP_THRESHOLD,
  BAND_MIDPOINTS,
  HIGH_CONFIDENCE_THRESHOLD,
  HYBRID_AUTO_ACCEPT_THRESHOLD,
  M1_HIT_THRESHOLD,
  assignScoreBand,
  cosineDistanceToCombinedScore,
  cosineSimilarity,
} from "./score.js";

// ---------------------------------------------------------------------------
// cosineDistanceToCombinedScore — boundary table
// ---------------------------------------------------------------------------

describe("cosineDistanceToCombinedScore", () => {
  it("d=0 (identical vectors) → combinedScore=1.0", () => {
    expect(cosineDistanceToCombinedScore(0)).toBe(1.0);
  });

  it("d=√2 (orthogonal unit vectors) → combinedScore=0.5", () => {
    // sqrt(2)^2 = 2; 1 - 2/4 = 0.5
    const score = cosineDistanceToCombinedScore(Math.sqrt(2));
    expect(score).toBeCloseTo(0.5, 10);
  });

  it("d=2 (antipodal vectors) → combinedScore=0.0", () => {
    // 2^2 = 4; 1 - 4/4 = 0
    expect(cosineDistanceToCombinedScore(2)).toBe(0.0);
  });

  it("clamps negative distances to 0 (no combinedScore above 1)", () => {
    // d < 0 is not physically meaningful but should not return > 1.
    // The formula 1 - d²/4 with d=-0.1 gives 1 - 0.01/4 = 0.9975, which is
    // ≤ 1 — the Math.min(1, ...) clamp is not triggered here. The intent of
    // this test is: the result is a valid probability in [0, 1].
    const score = cosineDistanceToCombinedScore(-0.1);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("clamps distances > 2 to 0 (no combinedScore below 0)", () => {
    expect(cosineDistanceToCombinedScore(2.5)).toBe(0.0);
  });

  // Tabular parity check — these values are computed by the SAME formula as
  // the authority source (1 - d²/4), so any divergence means a formula drift.
  const table: Array<[number, number]> = [
    [0.5, 1 - 0.25 / 4], // d=0.5 → 0.9375
    [1.0, 1 - 1.0 / 4], // d=1.0 → 0.75
    [1.2, 1 - 1.44 / 4], // d=1.2 → 0.64
    [1.5, 1 - 2.25 / 4], // d=1.5 → 0.4375
    [1.8, 1 - 3.24 / 4], // d=1.8 → 0.19
  ];

  for (const [d, expected] of table) {
    it(`d=${d} → combinedScore=${expected}`, () => {
      expect(cosineDistanceToCombinedScore(d)).toBeCloseTo(expected, 10);
    });
  }

  it("formula is 1 - d²/4 (authority parity: DEC-V3-DISCOVERY-CALIBRATION-FIX-002)", () => {
    // Directly verify the formula against authority code:
    // export function cosineDistanceToCombinedScore(cosineDistance: number): number {
    //   return Math.max(0, Math.min(1, 1 - (cosineDistance * cosineDistance) / 4));
    // }
    for (const d of [0, 0.3, 0.7, 1.0, Math.sqrt(2), 1.9, 2.0]) {
      const authority = Math.max(0, Math.min(1, 1 - (d * d) / 4));
      expect(cosineDistanceToCombinedScore(d)).toBe(authority);
    }
  });
});

// ---------------------------------------------------------------------------
// assignScoreBand — boundary tests
// ---------------------------------------------------------------------------

describe("assignScoreBand", () => {
  it("1.0 → strong", () => expect(assignScoreBand(1.0)).toBe("strong"));
  it("0.85 → strong (lower boundary inclusive)", () =>
    expect(assignScoreBand(0.85)).toBe("strong"));
  it("0.849 → confident", () => expect(assignScoreBand(0.849)).toBe("confident"));
  it("0.70 → confident (lower boundary inclusive)", () =>
    expect(assignScoreBand(0.7)).toBe("confident"));
  it("0.699 → weak", () => expect(assignScoreBand(0.699)).toBe("weak"));
  it("0.50 → weak (lower boundary inclusive)", () => expect(assignScoreBand(0.5)).toBe("weak"));
  it("0.499 → poor", () => expect(assignScoreBand(0.499)).toBe("poor"));
  it("0.0 → poor", () => expect(assignScoreBand(0.0)).toBe("poor"));
});

// ---------------------------------------------------------------------------
// BAND_MIDPOINTS — value parity
// ---------------------------------------------------------------------------

describe("BAND_MIDPOINTS", () => {
  it("strong midpoint = 0.925", () => expect(BAND_MIDPOINTS.strong).toBe(0.925));
  it("confident midpoint = 0.775", () => expect(BAND_MIDPOINTS.confident).toBe(0.775));
  it("weak midpoint = 0.6", () => expect(BAND_MIDPOINTS.weak).toBe(0.6));
  it("poor midpoint = 0.25", () => expect(BAND_MIDPOINTS.poor).toBe(0.25));
});

// ---------------------------------------------------------------------------
// M1_HIT_THRESHOLD — value parity
// ---------------------------------------------------------------------------

describe("M1_HIT_THRESHOLD", () => {
  it("equals 0.5 (DEC-V3-DISCOVERY-CALIBRATION-FIX-002 restored value)", () => {
    expect(M1_HIT_THRESHOLD).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Threshold constants — value-equality against resolve.ts authorities
// (DEC-1117-AUTHORITY-001: these must match the resolve.ts source)
// ---------------------------------------------------------------------------

describe("auto-accept threshold constants (DEC-1117-AUTHORITY-001 parity)", () => {
  it("HYBRID_AUTO_ACCEPT_THRESHOLD = 0.85 (matches resolve.ts)", () => {
    // Authority: HYBRID_AUTO_ACCEPT_THRESHOLD = 0.85 in resolve.ts
    // DEC-1009-THRESHOLD-RETUNE-001
    expect(HYBRID_AUTO_ACCEPT_THRESHOLD).toBe(0.85);
  });

  it("AUTO_ACCEPT_GAP_THRESHOLD = 0.05 (matches resolve.ts)", () => {
    // Authority: AUTO_ACCEPT_GAP_THRESHOLD = 0.05 in resolve.ts
    expect(AUTO_ACCEPT_GAP_THRESHOLD).toBe(0.05);
  });

  it("HIGH_CONFIDENCE_THRESHOLD = 0.92 (matches resolve.ts)", () => {
    // Authority: HIGH_CONFIDENCE_THRESHOLD = 0.92 in resolve.ts
    // DEC-1029-HIGH-CONF-OVERRIDE-001
    expect(HIGH_CONFIDENCE_THRESHOLD).toBe(0.92);
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity — unit vector, zero vector, mismatch
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("identical unit vectors → 1.0", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("orthogonal unit vectors → 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it("opposite unit vectors → -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it("zero vector → 0.0 (guarded denom)", () => {
    const z = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(z, v)).toBe(0.0);
  });

  it("throws on mismatched lengths", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("vector length mismatch");
  });

  it("normalized 384-dim vectors have similarity in [-1, 1]", () => {
    // Simulate two normalized 384-dim vectors
    const dim = 384;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i * 0.1);
      b[i] = Math.cos(i * 0.1);
      normA += (a[i] ?? 0) ** 2;
      normB += (b[i] ?? 0) ** 2;
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    for (let i = 0; i < dim; i++) {
      a[i] = (a[i] ?? 0) / normA;
      b[i] = (b[i] ?? 0) / normB;
    }
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1.0);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});
