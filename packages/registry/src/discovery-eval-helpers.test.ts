// SPDX-License-Identifier: MIT
/**
 * discovery-eval-helpers.test.ts — Unit tests for D5 evaluation harness helpers.
 *
 * Per D5 ADR Q3: "Helpers are unit-tested in discovery-eval-helpers.test.ts"
 * Per issue #256: This file was missing from WI-V3-DISCOVERY-D5-HARNESS deliverables.
 *
 * PURPOSE:
 *   Pure unit tests for M1..M5 metric computation functions and supporting helpers.
 *   No provider, no registry, no corpus loading — only metric math verified against
 *   known fixed inputs and expected outputs derived from the ADR specifications.
 *
 *   These tests catch metric-computation regressions independent of corpus or provider
 *   behavior. If any formula drifts from the ADR specification, these tests fail loudly.
 *
 * COVERAGE (per D5 ADR Q3 requirement):
 *   - cosineDistanceToCombinedScore (D3 formula)
 *   - assignScoreBand (D3 band boundaries)
 *   - M1_HIT_THRESHOLD constant (DEC-V3-DISCOVERY-CALIBRATION-FIX-001)
 *   - computeHitRate (M1)
 *   - computePrecisionAt1 (M2)
 *   - computeRecallAtK (M3)
 *   - computeMRR (M4)
 *   - computeBrierPerBand (M5)
 *   - computeReliabilityDiagram
 *   - buildBaselineMeasurement (computeBaseline)
 *   - worstHitRateEntries, worstPrecisionAt1Entries, worstRecallEntries, worstMRREntries
 */

import { describe, expect, it } from "vitest";
import {
  BAND_MIDPOINTS,
  M1_HIT_THRESHOLD,
  assignScoreBand,
  computeBaseline,
  computeBrierPerBand,
  computeHitRate,
  computeMRR,
  computePrecisionAt1,
  computeRecallAtK,
  computeReliabilityDiagram,
  cosineDistanceToCombinedScore,
  worstHitRateEntries,
  worstMRREntries,
  worstPrecisionAt1Entries,
  worstRecallEntries,
} from "./discovery-eval-helpers.js";
import type { BenchmarkEntry, QueryResult } from "./discovery-eval-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures — small fixed QueryResult sets for deterministic metric math
// ---------------------------------------------------------------------------

/**
 * Build a minimal QueryResult for testing.
 * All fields can be overridden via the partial second argument.
 */
function makeResult(id: string, overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    entryId: id,
    expectedAtom: "expected-hash-abc",
    acceptableAtoms: [],
    top1Score: 0.8,
    top1Atom: "expected-hash-abc",
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: ["expected-hash-abc"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cosineDistanceToCombinedScore — D3 formula: 1 - d/2, clamped to [0, 1]
// ---------------------------------------------------------------------------

describe("cosineDistanceToCombinedScore", () => {
  it("distance 0 → score 1.0 (identical vectors)", () => {
    expect(cosineDistanceToCombinedScore(0)).toBe(1.0);
  });

  it("distance 1 → score 0.5 (orthogonal vectors)", () => {
    expect(cosineDistanceToCombinedScore(1)).toBe(0.5);
  });

  it("distance 2 → score 0.0 (anti-parallel vectors)", () => {
    expect(cosineDistanceToCombinedScore(2)).toBe(0.0);
  });

  it("distance 1.2 → score 0.4 (calibration boundary — DEC-V3-DISCOVERY-CALIBRATION-FIX-001)", () => {
    expect(cosineDistanceToCombinedScore(1.2)).toBeCloseTo(0.4, 10);
  });

  it("distance > 2 is clamped to 0", () => {
    expect(cosineDistanceToCombinedScore(2.5)).toBe(0.0);
  });

  it("distance < 0 is clamped to 1", () => {
    // Negative cosine distances should not occur but are clamped for robustness.
    expect(cosineDistanceToCombinedScore(-0.5)).toBe(1.0);
  });

  it("distance 0.3 → score 0.85 (strong band entry)", () => {
    expect(cosineDistanceToCombinedScore(0.3)).toBeCloseTo(0.85, 10);
  });

  it("distance 0.6 → score 0.7 (confident band entry)", () => {
    expect(cosineDistanceToCombinedScore(0.6)).toBeCloseTo(0.7, 10);
  });

  it("distance 1.0 → score 0.5 (weak band entry — original D5 threshold)", () => {
    expect(cosineDistanceToCombinedScore(1.0)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// assignScoreBand — D3 band boundaries: strong >= 0.85, confident >= 0.70,
//                   weak >= 0.50, poor < 0.50
// ---------------------------------------------------------------------------

describe("assignScoreBand", () => {
  it("score 1.0 → strong", () => {
    expect(assignScoreBand(1.0)).toBe("strong");
  });

  it("score 0.85 → strong (boundary)", () => {
    expect(assignScoreBand(0.85)).toBe("strong");
  });

  it("score 0.84 → confident (just below strong)", () => {
    expect(assignScoreBand(0.84)).toBe("confident");
  });

  it("score 0.70 → confident (boundary)", () => {
    expect(assignScoreBand(0.7)).toBe("confident");
  });

  it("score 0.69 → weak (just below confident)", () => {
    expect(assignScoreBand(0.69)).toBe("weak");
  });

  it("score 0.50 → weak (boundary)", () => {
    expect(assignScoreBand(0.5)).toBe("weak");
  });

  it("score 0.49 → poor (just below weak)", () => {
    expect(assignScoreBand(0.49)).toBe("poor");
  });

  it("score 0.0 → poor", () => {
    expect(assignScoreBand(0.0)).toBe("poor");
  });
});

// ---------------------------------------------------------------------------
// M1_HIT_THRESHOLD — calibration constant
// ---------------------------------------------------------------------------

describe("M1_HIT_THRESHOLD", () => {
  it("is 0.40 (DEC-V3-DISCOVERY-CALIBRATION-FIX-001)", () => {
    expect(M1_HIT_THRESHOLD).toBe(0.4);
  });

  it("is below the D3 weak-band entry (0.50)", () => {
    expect(M1_HIT_THRESHOLD).toBeLessThan(0.5);
  });

  it("corresponds to cosineDistance 1.2 via the D3 formula", () => {
    // M1_HIT_THRESHOLD = 1 - 1.2/2 = 0.4
    expect(cosineDistanceToCombinedScore(1.2)).toBeCloseTo(M1_HIT_THRESHOLD, 10);
  });
});

// ---------------------------------------------------------------------------
// BAND_MIDPOINTS — D5 ADR Q1/Q4 constants
// ---------------------------------------------------------------------------

describe("BAND_MIDPOINTS", () => {
  it("strong midpoint is 0.925 (midpoint of [0.85, 1.00])", () => {
    expect(BAND_MIDPOINTS.strong).toBe(0.925);
  });

  it("confident midpoint is 0.775 (midpoint of [0.70, 0.85])", () => {
    expect(BAND_MIDPOINTS.confident).toBe(0.775);
  });

  it("weak midpoint is 0.6 (midpoint of [0.50, 0.70])", () => {
    expect(BAND_MIDPOINTS.weak).toBe(0.6);
  });

  it("poor midpoint is 0.25 (midpoint of [0.00, 0.50])", () => {
    expect(BAND_MIDPOINTS.poor).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// computeHitRate (M1) — uses M1_HIT_THRESHOLD, not the old 0.50
// ---------------------------------------------------------------------------

describe("computeHitRate (M1)", () => {
  it("empty results → 0", () => {
    expect(computeHitRate([])).toBe(0);
  });

  it("all results above M1_HIT_THRESHOLD → 1.0", () => {
    const results = [
      makeResult("a", { top1Score: 0.8 }),
      makeResult("b", { top1Score: 0.6 }),
      makeResult("c", { top1Score: 0.45 }), // above 0.40
    ];
    expect(computeHitRate(results)).toBe(1.0);
  });

  it("all results below M1_HIT_THRESHOLD → 0.0", () => {
    const results = [
      makeResult("a", { top1Score: 0.38 }),
      makeResult("b", { top1Score: 0.2 }),
      makeResult("c", { top1Score: 0.0 }),
    ];
    expect(computeHitRate(results)).toBe(0.0);
  });

  it("mixed: 3/5 above threshold → 0.6", () => {
    const results = [
      makeResult("a", { top1Score: 0.8 }),
      makeResult("b", { top1Score: 0.42 }),
      makeResult("c", { top1Score: 0.49 }),
      makeResult("d", { top1Score: 0.38 }), // below
      makeResult("e", { top1Score: 0.0 }), // below
    ];
    expect(computeHitRate(results)).toBe(0.6);
  });

  it("score exactly at M1_HIT_THRESHOLD (0.40) counts as a hit", () => {
    const results = [makeResult("a", { top1Score: 0.4 })];
    expect(computeHitRate(results)).toBe(1.0);
  });

  it("score just below M1_HIT_THRESHOLD (0.3999) does NOT count as hit", () => {
    const results = [makeResult("a", { top1Score: 0.3999 })];
    expect(computeHitRate(results)).toBe(0.0);
  });

  it("includes negative-space entries (expectedAtom=null) in hit count", () => {
    const results = [
      makeResult("pos", { top1Score: 0.8, expectedAtom: "some-hash" }),
      makeResult("neg", { top1Score: 0.45, expectedAtom: null, top1Correct: false }),
    ];
    // Both score above M1_HIT_THRESHOLD → hit rate = 1.0
    // (negative-space entry with score >= threshold is a false hit, still counted)
    expect(computeHitRate(results)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computePrecisionAt1 (M2) — skips null expectedAtom
// ---------------------------------------------------------------------------

describe("computePrecisionAt1 (M2)", () => {
  it("empty results → 0", () => {
    expect(computePrecisionAt1([])).toBe(0);
  });

  it("all null expectedAtom → 0 (no eligible entries)", () => {
    const results = [makeResult("a", { expectedAtom: null, top1Correct: false })];
    expect(computePrecisionAt1(results)).toBe(0);
  });

  it("all eligible entries correct → 1.0", () => {
    const results = [
      makeResult("a", { top1Correct: true }),
      makeResult("b", { top1Correct: true }),
    ];
    expect(computePrecisionAt1(results)).toBe(1.0);
  });

  it("half eligible correct → 0.5", () => {
    const results = [
      makeResult("a", { top1Correct: true }),
      makeResult("b", { top1Correct: false }),
      makeResult("c", { expectedAtom: null, top1Correct: false }), // skipped
    ];
    // 1 correct / 2 eligible = 0.5
    expect(computePrecisionAt1(results)).toBe(0.5);
  });

  it("null expectedAtom entries are excluded from eligible count", () => {
    const results = [
      makeResult("pos1", { top1Correct: true }),
      makeResult("neg1", { expectedAtom: null, top1Correct: false }),
      makeResult("neg2", { expectedAtom: null, top1Correct: false }),
    ];
    // 1 correct / 1 eligible = 1.0 (2 null entries excluded)
    expect(computePrecisionAt1(results)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeRecallAtK (M3) — expectedAtom found in top-K results
// ---------------------------------------------------------------------------

describe("computeRecallAtK (M3)", () => {
  it("empty results → 0", () => {
    expect(computeRecallAtK([])).toBe(0);
  });

  it("all eligible entries have expectedAtomRank set → 1.0", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }),
      makeResult("b", { expectedAtomRank: 5 }),
    ];
    expect(computeRecallAtK(results)).toBe(1.0);
  });

  it("none found → 0.0", () => {
    const results = [
      makeResult("a", { expectedAtomRank: null }),
      makeResult("b", { expectedAtomRank: null }),
    ];
    expect(computeRecallAtK(results)).toBe(0.0);
  });

  it("1 of 2 found → 0.5", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 3 }),
      makeResult("b", { expectedAtomRank: null }),
    ];
    expect(computeRecallAtK(results)).toBe(0.5);
  });

  it("null expectedAtom entries are excluded", () => {
    const results = [
      makeResult("pos", { expectedAtomRank: 7 }),
      makeResult("neg", { expectedAtom: null, expectedAtomRank: null }),
    ];
    expect(computeRecallAtK(results)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeMRR (M4) — mean of 1/rank
// ---------------------------------------------------------------------------

describe("computeMRR (M4)", () => {
  it("empty results → 0", () => {
    expect(computeMRR([])).toBe(0);
  });

  it("all at rank 1 → 1.0", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }),
      makeResult("b", { expectedAtomRank: 1 }),
    ];
    expect(computeMRR(results)).toBe(1.0);
  });

  it("rank 2 → 0.5", () => {
    const results = [makeResult("a", { expectedAtomRank: 2 })];
    expect(computeMRR(results)).toBe(0.5);
  });

  it("not found → 0 contribution", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }),
      makeResult("b", { expectedAtomRank: null }),
    ];
    // (1/1 + 0) / 2 = 0.5
    expect(computeMRR(results)).toBe(0.5);
  });

  it("ranks 1 and 5 → MRR = (1 + 0.2) / 2 = 0.6", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }),
      makeResult("b", { expectedAtomRank: 5 }),
    ];
    expect(computeMRR(results)).toBeCloseTo(0.6, 10);
  });

  it("null expectedAtom entries are excluded from MRR computation", () => {
    const results = [
      makeResult("pos", { expectedAtomRank: 1 }),
      makeResult("neg", { expectedAtom: null, expectedAtomRank: null }),
    ];
    expect(computeMRR(results)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeBrierPerBand (M5) — per-band Brier: (P_b - m_b)^2
// ---------------------------------------------------------------------------

describe("computeBrierPerBand (M5)", () => {
  it("empty results → all bands have N=0, brier=null", () => {
    const brier = computeBrierPerBand([]);
    expect(brier.strong.N).toBe(0);
    expect(brier.strong.brier).toBeNull();
    expect(brier.confident.N).toBe(0);
    expect(brier.weak.N).toBe(0);
    expect(brier.poor.N).toBe(0);
  });

  it("all results in strong band, all correct → P=1.0, brier=(1.0-0.925)^2=0.005625", () => {
    const results = [
      makeResult("a", { top1Band: "strong", top1Correct: true }),
      makeResult("b", { top1Band: "strong", top1Correct: true }),
    ];
    const brier = computeBrierPerBand(results);
    expect(brier.strong.N).toBe(2);
    expect(brier.strong.correct).toBe(2);
    expect(brier.strong.P).toBe(1.0);
    expect(brier.strong.brier).toBeCloseTo((1.0 - 0.925) ** 2, 10);
    // Other bands empty
    expect(brier.confident.N).toBe(0);
    expect(brier.weak.N).toBe(0);
    expect(brier.poor.N).toBe(0);
  });

  it("poor band: N=4, correct=1 → P=0.25, brier=(0.25-0.25)^2=0", () => {
    const results = [
      makeResult("a", { top1Band: "poor", top1Correct: true }),
      makeResult("b", { top1Band: "poor", top1Correct: false }),
      makeResult("c", { top1Band: "poor", top1Correct: false }),
      makeResult("d", { top1Band: "poor", top1Correct: false }),
    ];
    const brier = computeBrierPerBand(results);
    expect(brier.poor.N).toBe(4);
    expect(brier.poor.correct).toBe(1);
    expect(brier.poor.P).toBe(0.25);
    // Band midpoint is 0.25, P is 0.25 → brier = 0
    expect(brier.poor.brier).toBeCloseTo(0, 10);
  });

  it("weak band: N=1, correct=0 → P=0, brier=(0-0.6)^2=0.36", () => {
    const results = [makeResult("a", { top1Band: "weak", top1Correct: false })];
    const brier = computeBrierPerBand(results);
    expect(brier.weak.N).toBe(1);
    expect(brier.weak.P).toBe(0.0);
    expect(brier.weak.brier).toBeCloseTo((0.0 - 0.6) ** 2, 10); // 0.36
  });

  it("null expectedAtom entries contribute to band N but are never correct", () => {
    const results = [
      makeResult("neg", {
        expectedAtom: null,
        top1Band: "poor",
        top1Correct: false,
        top1Score: 0.3,
      }),
    ];
    const brier = computeBrierPerBand(results);
    expect(brier.poor.N).toBe(1);
    expect(brier.poor.correct).toBe(0); // null expectedAtom → never correct
    expect(brier.poor.P).toBe(0.0);
  });

  it("total N across all bands equals number of results", () => {
    const results = [
      makeResult("a", { top1Band: "strong" }),
      makeResult("b", { top1Band: "confident" }),
      makeResult("c", { top1Band: "weak" }),
      makeResult("d", { top1Band: "poor" }),
      makeResult("e", { top1Band: "poor" }),
    ];
    const brier = computeBrierPerBand(results);
    const total = brier.strong.N + brier.confident.N + brier.weak.N + brier.poor.N;
    expect(total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// computeReliabilityDiagram — structural shape test
// ---------------------------------------------------------------------------

describe("computeReliabilityDiagram", () => {
  it("produces a well-formed diagram with required fields", () => {
    const results = [
      makeResult("a", { top1Band: "strong", top1Correct: true }),
      makeResult("b", { top1Band: "poor", top1Correct: false }),
    ];
    const diagram = computeReliabilityDiagram("test-corpus", results, "test-sha", "test-model");
    expect(diagram.corpus).toBe("test-corpus");
    expect(diagram.head_sha).toBe("test-sha");
    expect(diagram.provider).toBe("test-model");
    expect(diagram.generated_at).toBeDefined();
    expect(diagram.bands.strong.N).toBe(1);
    expect(diagram.bands.poor.N).toBe(1);
    expect(diagram.bands.confident.N).toBe(0);
    expect(diagram.bands.weak.N).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBaseline — structural shape + metric wiring
// ---------------------------------------------------------------------------

describe("computeBaseline", () => {
  const corpus: readonly BenchmarkEntry[] = [
    {
      id: "test-001",
      source: "seed-derived",
      query: { behavior: "test behavior" },
      expectedAtom: "hash-abc",
      rationale: "test",
    },
    {
      id: "test-002",
      source: "synthetic-tasks",
      query: { behavior: "another test" },
      expectedAtom: null,
      rationale: "test",
    },
  ];

  it("produces version=1 with required shape", () => {
    const results: readonly QueryResult[] = [
      makeResult("test-001", { top1Score: 0.45, top1Band: "poor", top1Correct: true }),
      makeResult("test-002", {
        expectedAtom: null,
        top1Score: 0.3,
        top1Band: "poor",
        top1Correct: false,
      }),
    ];
    const baseline = computeBaseline("test-corpus", corpus, results, "test-sha", "test-model");
    expect(baseline.version).toBe(1);
    expect(baseline.corpus_source).toBe("test-corpus");
    expect(baseline.corpus_entries).toBe(2);
    expect(baseline.head_sha).toBe("test-sha");
    expect(baseline.provider).toBe("test-model");
    expect(baseline.m5_corpus).toBe("full");
    expect(typeof baseline.metrics.M1_hit_rate).toBe("number");
    expect(typeof baseline.metrics.M2_precision_at_1).toBe("number");
    expect(typeof baseline.metrics.M3_recall_at_10).toBe("number");
    expect(typeof baseline.metrics.M4_mrr).toBe("number");
  });

  it("M1 target is 0.8, M2 target is 0.7, M3 target is 0.9, M4 target is 0.7", () => {
    const results: readonly QueryResult[] = [makeResult("test-001")];
    const baseline = computeBaseline("c", corpus, results, "sha", "model");
    expect(baseline.metrics.M1_target).toBe(0.8);
    expect(baseline.metrics.M2_target).toBe(0.7);
    expect(baseline.metrics.M3_target).toBe(0.9);
    expect(baseline.metrics.M4_target).toBe(0.7);
    expect(baseline.metrics.M5_target).toBe(0.1);
  });

  it("M1_pass reflects M1_HIT_THRESHOLD (0.40), not original 0.50", () => {
    // Score 0.45: above M1_HIT_THRESHOLD (0.40), so hit rate = 1.0 → M1_pass = true
    const results: readonly QueryResult[] = [
      makeResult("test-001", { top1Score: 0.45, top1Band: "poor" }),
    ];
    const baseline = computeBaseline("c", corpus.slice(0, 1), results, "sha", "model");
    expect(baseline.metrics.M1_hit_rate).toBeCloseTo(1.0, 10);
    expect(baseline.metrics.M1_pass).toBe(true);
  });

  it("m5_corpus is always 'full' (DEC-V3-DISCOVERY-CALIBRATION-FIX-001 / issue #255)", () => {
    const results: readonly QueryResult[] = [makeResult("test-001")];
    const baseline = computeBaseline("c", corpus, results, "sha", "model");
    expect(baseline.m5_corpus).toBe("full");
  });

  it("provider_note is included when provided", () => {
    const results: readonly QueryResult[] = [makeResult("test-001")];
    const baseline = computeBaseline("c", corpus, results, "sha", "model", "test note");
    expect(baseline.provider_note).toBe("test note");
  });

  it("provider_note is absent when not provided", () => {
    const results: readonly QueryResult[] = [makeResult("test-001")];
    const baseline = computeBaseline("c", corpus, results, "sha", "model");
    expect(baseline.provider_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Worst-entry helpers — sort correctness
// ---------------------------------------------------------------------------

describe("worstHitRateEntries", () => {
  it("returns the N entries with lowest top1Score", () => {
    const results = [
      makeResult("a", { top1Score: 0.9 }),
      makeResult("b", { top1Score: 0.3 }),
      makeResult("c", { top1Score: 0.5 }),
      makeResult("d", { top1Score: 0.1 }),
    ];
    const worst = worstHitRateEntries(results, 2);
    expect(worst.map((r) => r.entryId)).toEqual(["d", "b"]);
  });

  it("default n=3", () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult(`e${i}`, { top1Score: (i + 1) * 0.1 }),
    );
    expect(worstHitRateEntries(results)).toHaveLength(3);
  });
});

describe("worstPrecisionAt1Entries", () => {
  it("returns only incorrect eligible entries, sorted by top1Score", () => {
    const results = [
      makeResult("a", { top1Correct: true }), // correct → excluded
      makeResult("b", { top1Correct: false, top1Score: 0.6 }), // included
      makeResult("c", { top1Correct: false, top1Score: 0.4 }), // included
      makeResult("d", { expectedAtom: null, top1Correct: false }), // no expectedAtom → excluded
    ];
    const worst = worstPrecisionAt1Entries(results, 3);
    expect(worst.map((r) => r.entryId)).toEqual(["c", "b"]);
  });
});

describe("worstRecallEntries", () => {
  it("returns only entries where expectedAtom was not in top-K", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }), // found → excluded
      makeResult("b", { expectedAtomRank: null }), // not found → included
      makeResult("c", { expectedAtom: null }), // no expected → excluded
    ];
    const worst = worstRecallEntries(results, 3);
    expect(worst.map((r) => r.entryId)).toEqual(["b"]);
  });
});

describe("worstMRREntries", () => {
  it("returns eligible entries sorted by ascending RR (worst first)", () => {
    const results = [
      makeResult("a", { expectedAtomRank: 1 }), // RR=1.0
      makeResult("b", { expectedAtomRank: 10 }), // RR=0.1
      makeResult("c", { expectedAtomRank: null }), // RR=0 (worst)
      makeResult("d", { expectedAtom: null }), // excluded
    ];
    const worst = worstMRREntries(results, 3);
    // c (RR=0) < b (RR=0.1) < a (RR=1.0)
    expect(worst.map((r) => r.entryId)).toEqual(["c", "b", "a"]);
  });
});
