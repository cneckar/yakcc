// SPDX-License-Identifier: MIT
/**
 * discovery-eval-helpers.test.ts — unit tests for D5 metric computation helpers.
 *
 * WI-V3-DISCOVERY-CALIBRATION-FIX (#258) — item 8: "Add discovery-eval-helpers.test.ts
 * per D5 ADR Q3 requirement."
 *
 * These tests exercise the helper functions directly against pre-computed QueryResult
 * fixtures, with no registry or embedding provider involved. They were authored using the
 * scenario reference from tmp/discovery-eval/recovered-pr253-helper-test-scenarios.txt
 * (PR #253 scenarios, translated from the old QueryEvalResult shape to the current
 * QueryResult interface per the note at the top of that file).
 */

import { describe, expect, it } from "vitest";
import {
  assignScoreBand,
  computeBrierPerBand,
  computeHitRate,
  computeMRR,
  computePrecisionAt1,
  computeRecallAtK,
  cosineDistanceToCombinedScore,
} from "./discovery-eval-helpers.js";
import type { QueryResult } from "./discovery-eval-helpers.js";

// ---------------------------------------------------------------------------
// Test fixtures (translated from PR #253 scenarios to current QueryResult interface)
// ---------------------------------------------------------------------------

const ROOT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOT_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

// All correct: 3 results where top-1 is the expected atom, all in the strong band.
const allCorrectStrong: QueryResult[] = [
  {
    entryId: "s1",
    expectedAtom: ROOT_A,
    acceptableAtoms: [],
    top1Score: 0.92,
    top1Atom: ROOT_A,
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: [ROOT_A, ROOT_B],
  },
  {
    entryId: "s2",
    expectedAtom: ROOT_B,
    acceptableAtoms: [],
    top1Score: 0.88,
    top1Atom: ROOT_B,
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: [ROOT_B, ROOT_A],
  },
  {
    entryId: "s3",
    expectedAtom: ROOT_C,
    acceptableAtoms: [],
    top1Score: 0.95,
    top1Atom: ROOT_C,
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: [ROOT_C, ROOT_A],
  },
];

// Mixed: m1 correct (strong), m2 correct via acceptableAtoms (confident),
// m3 wrong top-1 + expected not in results (weak), m4 wrong + expected absent (poor).
const mixedResults: QueryResult[] = [
  {
    entryId: "m1",
    expectedAtom: ROOT_A,
    acceptableAtoms: [],
    top1Score: 0.88,
    top1Atom: ROOT_A,
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: [ROOT_A, ROOT_B],
  },
  {
    entryId: "m2",
    expectedAtom: ROOT_B,
    acceptableAtoms: [ROOT_C],
    top1Score: 0.75,
    top1Atom: ROOT_C,   // correct via acceptableAtoms
    top1Band: "confident",
    top1Correct: true,
    expectedAtomRank: 1, // ROOT_C (acceptable) is at rank-1
    allAtoms: [ROOT_C, ROOT_A],
  },
  {
    entryId: "m3",
    expectedAtom: ROOT_A,
    acceptableAtoms: [],
    top1Score: 0.52,
    top1Atom: ROOT_B,   // miss
    top1Band: "weak",
    top1Correct: false,
    expectedAtomRank: null, // ROOT_A absent from allAtoms
    allAtoms: [ROOT_B, ROOT_C],
  },
  {
    entryId: "m4",
    expectedAtom: ROOT_C,
    acceptableAtoms: [],
    top1Score: 0.45,
    top1Atom: ROOT_A,   // miss, ROOT_C not in results
    top1Band: "poor",
    top1Correct: false,
    expectedAtomRank: null,
    allAtoms: [ROOT_A, ROOT_B],
  },
];

// One positive entry (strong) + one negative-space entry (weak, false hit).
const withNegativeSpace: QueryResult[] = [
  {
    entryId: "pos1",
    expectedAtom: ROOT_A,
    acceptableAtoms: [],
    top1Score: 0.90,
    top1Atom: ROOT_A,
    top1Band: "strong",
    top1Correct: true,
    expectedAtomRank: 1,
    allAtoms: [ROOT_A],
  },
  {
    entryId: "neg1",
    expectedAtom: null, // negative-space
    acceptableAtoms: [],
    top1Score: 0.55,
    top1Atom: ROOT_B,
    top1Band: "weak",
    top1Correct: false, // always false for null expectedAtom
    expectedAtomRank: null,
    allAtoms: [ROOT_B],
  },
];

// ---------------------------------------------------------------------------
// cosineDistanceToCombinedScore
// ---------------------------------------------------------------------------

describe("cosineDistanceToCombinedScore", () => {
  // DEC-V3-DISCOVERY-CALIBRATION-FIX-001: formula is 1 - d²/4 (not 1 - d/2).
  // This maps sqlite-vec L2 distance d ∈ [0, 2] correctly for unit-normalized vectors.

  it("returns 1.0 for d=0 (identical vectors)", () => {
    expect(cosineDistanceToCombinedScore(0)).toBe(1.0);
  });

  it("returns 0.5 for d=√2 (orthogonal vectors, cos_sim=0)", () => {
    expect(cosineDistanceToCombinedScore(Math.sqrt(2))).toBeCloseTo(0.5, 10);
  });

  it("returns 0.0 for d=2 (anti-parallel vectors, cos_sim=-1)", () => {
    expect(cosineDistanceToCombinedScore(2)).toBeCloseTo(0, 10);
  });

  it("returns 0.75 for d=1.0 (cos_sim=0.5)", () => {
    // d=1: cos_sim = 1 - 1/2 = 0.5; score = 1 - 1/4 = 0.75
    expect(cosineDistanceToCombinedScore(1.0)).toBeCloseTo(0.75, 10);
  });

  it("clamps to 0 for d > 2 (numerical safety)", () => {
    expect(cosineDistanceToCombinedScore(3)).toBe(0);
  });

  it("is near 1.0 for small negative d (numerical noise, d²/4 ≈ 0)", () => {
    // d=-0.01: 1 - (0.0001)/4 = 0.999975; Math.min(1,...) doesn't clamp since < 1
    expect(cosineDistanceToCombinedScore(-0.01)).toBeCloseTo(1, 3);
  });

  it("maps d=0.6 to strong band (cos_sim ≈ 0.82, score ≈ 0.91)", () => {
    // cos_sim = 1 - 0.36/2 = 0.82; score = 1 - 0.36/4 = 0.91
    expect(cosineDistanceToCombinedScore(0.6)).toBeCloseTo(0.91, 5);
  });
});

// ---------------------------------------------------------------------------
// assignScoreBand
// ---------------------------------------------------------------------------

describe("assignScoreBand", () => {
  it("assigns strong for score >= 0.85", () => {
    expect(assignScoreBand(1.0)).toBe("strong");
    expect(assignScoreBand(0.85)).toBe("strong");
    expect(assignScoreBand(0.92)).toBe("strong");
  });

  it("assigns confident for score in [0.70, 0.85)", () => {
    expect(assignScoreBand(0.70)).toBe("confident");
    expect(assignScoreBand(0.75)).toBe("confident");
    expect(assignScoreBand(0.84)).toBe("confident");
  });

  it("assigns weak for score in [0.50, 0.70)", () => {
    expect(assignScoreBand(0.50)).toBe("weak");
    expect(assignScoreBand(0.55)).toBe("weak");
    expect(assignScoreBand(0.69)).toBe("weak");
  });

  it("assigns poor for score < 0.50", () => {
    expect(assignScoreBand(0.49)).toBe("poor");
    expect(assignScoreBand(0.0)).toBe("poor");
    expect(assignScoreBand(0.30)).toBe("poor");
  });
});

// ---------------------------------------------------------------------------
// computeHitRate (M1)
// ---------------------------------------------------------------------------

describe("computeHitRate", () => {
  it("returns 1.0 for all strong-band correct results", () => {
    expect(computeHitRate(allCorrectStrong)).toBe(1.0);
  });

  it("counts 3 hits out of 4 in mixed results (m4 misses at 0.45 < 0.50)", () => {
    // m1(0.88>=0.50 hit), m2(0.75>=0.50 hit), m3(0.52>=0.50 hit), m4(0.45<0.50 miss)
    // 3/4 = 0.75
    expect(computeHitRate(mixedResults)).toBeCloseTo(0.75, 5);
  });

  it("includes negative-space entries in denominator AND as potential hits", () => {
    // pos1(0.90>=0.50 hit) + neg1(0.55>=0.50 hit = false-hit, but still counted)
    // M1 counts ALL entries per D5 ADR Q1; neg1 is a false hit but still a hit.
    // 2/2 = 1.0
    expect(computeHitRate(withNegativeSpace)).toBe(1.0);
  });

  it("returns 0 for empty corpus", () => {
    expect(computeHitRate([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePrecisionAt1 (M2)
// ---------------------------------------------------------------------------

describe("computePrecisionAt1", () => {
  it("returns 1.0 when all top-1 candidates match expectedAtom", () => {
    expect(computePrecisionAt1(allCorrectStrong)).toBe(1.0);
  });

  it("counts acceptableAtoms as correct (m2 correct via ROOT_C alternate)", () => {
    // m1: ROOT_A correct; m2: ROOT_C correct (acceptable); m3: ROOT_B incorrect; m4: ROOT_A incorrect
    // 2/4 = 0.50
    expect(computePrecisionAt1(mixedResults)).toBeCloseTo(0.5, 5);
  });

  it("excludes negative-space entries (null expectedAtom) from denominator", () => {
    // pos1: ROOT_A correct → 1/1 = 1.0 (neg1 excluded — has no expectedAtom to match)
    expect(computePrecisionAt1(withNegativeSpace)).toBe(1.0);
  });

  it("returns 0 for empty corpus", () => {
    expect(computePrecisionAt1([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRecallAtK (M3)
// ---------------------------------------------------------------------------

describe("computeRecallAtK", () => {
  it("returns 1.0 when all expectedAtoms appear in top-K", () => {
    expect(computeRecallAtK(allCorrectStrong)).toBe(1.0);
  });

  it("counts m1 and m2 recalled, m3 and m4 not (2/4 = 0.50)", () => {
    // m1: ROOT_A at rank-1 → recalled.
    // m2: ROOT_B absent but ROOT_C (acceptable) at rank-1 → recalled via alternate.
    // m3: ROOT_A not in allAtoms → not recalled.
    // m4: ROOT_C not in allAtoms → not recalled.
    expect(computeRecallAtK(mixedResults)).toBeCloseTo(0.5, 5);
  });

  it("excludes negative-space entries from denominator", () => {
    // Only pos1 is eligible (neg1 has null expectedAtom); pos1 recalled at rank-1.
    expect(computeRecallAtK(withNegativeSpace)).toBe(1.0);
  });

  it("returns 0 for empty corpus", () => {
    expect(computeRecallAtK([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeMRR (M4)
// ---------------------------------------------------------------------------

describe("computeMRR", () => {
  it("returns 1.0 when all expectedAtoms are rank-1", () => {
    expect(computeMRR(allCorrectStrong)).toBe(1.0);
  });

  it("returns 0 contribution for queries where expectedAtom is absent", () => {
    // m1: rank-1 → RR=1.0; m2: ROOT_C (acceptable) at rank-1 → RR=1.0;
    // m3: ROOT_A absent → RR=0; m4: ROOT_C absent → RR=0.
    // MRR = (1+1+0+0) / 4 = 0.5
    expect(computeMRR(mixedResults)).toBeCloseTo(0.5, 5);
  });

  it("excludes negative-space entries (null expectedAtom)", () => {
    // pos1 at rank-1 (RR=1.0); neg1 excluded → MRR = 1.0
    expect(computeMRR(withNegativeSpace)).toBe(1.0);
  });

  it("returns 0 for empty corpus", () => {
    expect(computeMRR([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBrierPerBand (M5)
// ---------------------------------------------------------------------------

describe("computeBrierPerBand", () => {
  it("computes strong-band Brier from all-correct strong-score results", () => {
    // All 3 results in strong band (scores 0.92, 0.88, 0.95 all ≥ 0.85).
    // strong: N=3, correct=3, P=1.0, midpoint=0.925
    // brier = (1.0 - 0.925)² = 0.005625
    const result = computeBrierPerBand(allCorrectStrong);
    expect(result.strong.N).toBe(3);
    expect(result.strong.correct).toBe(3);
    expect(result.strong.P).toBeCloseTo(1.0, 5);
    expect(result.strong.brier).toBeCloseTo(0.005625, 5);
  });

  it("reports N=0 and brier=null for empty bands", () => {
    // allCorrectStrong has no confident/weak/poor-band entries.
    const result = computeBrierPerBand(allCorrectStrong);
    expect(result.confident.N).toBe(0);
    expect(result.confident.brier).toBeNull();
    expect(result.confident.P).toBeNull();
    expect(result.weak.N).toBe(0);
    expect(result.weak.brier).toBeNull();
    expect(result.poor.N).toBe(0);
    expect(result.poor.brier).toBeNull();
  });

  it("distributes mixed results across all 4 bands correctly", () => {
    // m1(0.88)=strong/correct, m2(0.75)=confident/correct,
    // m3(0.52)=weak/incorrect, m4(0.45)=poor/incorrect
    const result = computeBrierPerBand(mixedResults);
    expect(result.strong.N).toBe(1);
    expect(result.strong.correct).toBe(1);
    expect(result.confident.N).toBe(1);
    expect(result.confident.correct).toBe(1);
    expect(result.weak.N).toBe(1);
    expect(result.weak.correct).toBe(0);
    expect(result.poor.N).toBe(1);
    expect(result.poor.correct).toBe(0);
  });

  it("includes negative-space entries (they are always incorrect)", () => {
    // pos1(0.90) → strong band, correct.
    // neg1(0.55) → weak band, incorrect (null expectedAtom → top1Correct=false always).
    // strong: N=1, correct=1, P=1.0, brier=(1.0-0.925)²=0.005625
    // weak:   N=1, correct=0, P=0.0, brier=(0.0-0.60)²=0.36
    const result = computeBrierPerBand(withNegativeSpace);
    expect(result.strong.N).toBe(1);
    expect(result.strong.correct).toBe(1);
    expect(result.strong.P).toBeCloseTo(1.0, 5);
    expect(result.strong.brier).toBeCloseTo(0.005625, 5);
    expect(result.weak.N).toBe(1);
    expect(result.weak.correct).toBe(0);
    expect(result.weak.P).toBeCloseTo(0.0, 5);
    expect(result.weak.brier).toBeCloseTo(0.36, 5);
  });

  it("total N across bands equals corpus length", () => {
    for (const corpus of [allCorrectStrong, mixedResults, withNegativeSpace]) {
      const result = computeBrierPerBand(corpus);
      const total = result.strong.N + result.confident.N + result.weak.N + result.poor.N;
      expect(total).toBe(corpus.length);
    }
  });

  it("returns all bands with N=0 and null brier for empty corpus", () => {
    const result = computeBrierPerBand([]);
    expect(result.strong.N).toBe(0);
    expect(result.confident.N).toBe(0);
    expect(result.weak.N).toBe(0);
    expect(result.poor.N).toBe(0);
    expect(result.strong.brier).toBeNull();
    expect(result.confident.brier).toBeNull();
    expect(result.weak.brier).toBeNull();
    expect(result.poor.brier).toBeNull();
  });

  it("handles a single no-candidates entry (top1Score=0) in poor band", () => {
    const noResults: QueryResult[] = [
      {
        entryId: "empty",
        expectedAtom: ROOT_A,
        acceptableAtoms: [],
        top1Score: 0,
        top1Atom: null,
        top1Band: "poor",
        top1Correct: false,
        expectedAtomRank: null,
        allAtoms: [],
      },
    ];
    const result = computeBrierPerBand(noResults);
    expect(result.poor.N).toBe(1);
    expect(result.poor.correct).toBe(0);
    expect(result.strong.N).toBe(0);
    expect(result.confident.N).toBe(0);
    expect(result.weak.N).toBe(0);
  });
});
