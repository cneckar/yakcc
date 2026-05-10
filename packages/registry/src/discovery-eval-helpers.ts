// SPDX-License-Identifier: MIT
// @decision DEC-V3-DISCOVERY-D5-HARNESS-001
// title: discovery-eval-helpers are pure functions operating on pre-computed QueryEvalResult[].
// status: decided (WI-V3-DISCOVERY-D5-HARNESS, #200)
// rationale: Keeping metric computation pure (no Registry dependency) makes the helpers
// unit-testable in isolation without needing a live registry. The harness test file
// drives the registry queries and assembles QueryEvalResult[]; helpers never call
// findCandidatesByIntent directly. This mirrors the D5 ADR Q3 separation of concerns.
// Empty-band handling: N_b = 0 yields brier = 0 (no calibration information) and a
// warning is logged so corpus authors know to add coverage for that band.

// ---------------------------------------------------------------------------
// Corpus schema types (D5 ADR Q2, locked)
// ---------------------------------------------------------------------------

/**
 * A single query/answer pair in a benchmark corpus file.
 * Schema is locked by DEC-V3-DISCOVERY-D5-001.
 */
export interface BenchmarkEntry {
  /** Stable identifier; must be unique within the file. */
  readonly id: string;

  /** Source label; must match the file name. */
  readonly source: "seed-derived" | "synthetic-tasks" | "captured-sessions";

  /**
   * The query the LLM (or harness) would issue.
   * Uses the IntentQuery shape for baseline single-vector evaluation
   * (findCandidatesByIntent); QueryIntentCard for future multi-dim evaluation.
   */
  readonly query: {
    readonly behavior: string;
    readonly inputs?: readonly { readonly name: string; readonly typeHint: string }[];
    readonly outputs?: readonly { readonly name: string; readonly typeHint: string }[];
  };

  /**
   * Expected top-1 atom by BlockMerkleRoot.
   * null = negative-space query (no atom is correct; system should emit no_match).
   */
  readonly expectedAtom: string | null;

  /**
   * Optional list of acceptable alternates for Recall@K.
   * If omitted, only expectedAtom counts as correct.
   */
  readonly acceptableAtoms?: readonly string[];

  /** Free-form rationale for why this entry exists. */
  readonly rationale: string;
}

/**
 * Envelope for a benchmark corpus JSON file.
 * Schema is locked by DEC-V3-DISCOVERY-D5-001.
 */
export interface BenchmarkFile {
  readonly version: 1;
  readonly source: BenchmarkEntry["source"];
  readonly lastUpdated: string;
  readonly entries: readonly BenchmarkEntry[];
}

/**
 * A pending coverage gap entry.
 * Schema is locked by DEC-V3-DISCOVERY-D5-001.
 */
export interface PendingEntry {
  readonly id: string;
  readonly query: BenchmarkEntry["query"];
  readonly returnedCandidates: readonly {
    readonly blockMerkleRoot: string;
    readonly combinedScore: number;
    readonly band: "strong" | "confident" | "weak" | "poor";
    readonly perDimensionScores?: Record<string, number>;
  }[];
  readonly nearMisses: readonly {
    readonly blockMerkleRoot: string;
    readonly failedAtLayer: "structural" | "strictness" | "property_test" | "min_score";
    readonly failureReason: string;
  }[];
  readonly diagnosis: string;
  readonly proposedAction: string;
  readonly addedAt: string;
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation result type (internal harness shape)
// ---------------------------------------------------------------------------

/**
 * The result of running a single corpus entry through findCandidatesByIntent.
 * Pure data; no Registry dependency. The harness test assembles these from
 * registry query results; helpers operate on this type only.
 */
export interface QueryEvalResult {
  /** The corpus entry id (for diagnostics). */
  readonly entryId: string;

  /**
   * Expected top-1 BlockMerkleRoot, or null for negative-space entries.
   */
  readonly expectedAtom: string | null;

  /** Acceptable alternates (empty array if none). */
  readonly acceptableAtoms: readonly string[];

  /**
   * Top-K candidates returned by the registry, ordered by ascending cosineDistance.
   * combinedScore = 1 - cosineDistance (single-vector baseline).
   */
  readonly candidates: readonly {
    readonly blockMerkleRoot: string;
    readonly combinedScore: number;
  }[];
}

// ---------------------------------------------------------------------------
// Band calibration types (M5)
// ---------------------------------------------------------------------------

/** One band's calibration statistics for M5. */
export interface BrierBandStat {
  /** Number of queries whose top-1 combinedScore falls in this band. */
  readonly N: number;
  /** Number of those queries that are "correct" (top-1 hash match). */
  readonly correct: number;
  /** Observed precision in band (correct/N), or null when N = 0. */
  readonly P: number | null;
  /** Band midpoint (from D5 ADR Q1). */
  readonly midpoint: number;
  /** Squared deviation (P - midpoint)², or 0 when N = 0. */
  readonly brier: number;
}

/** Per-band Brier statistics for M5. */
export interface BrierPerBandResult {
  readonly strong: BrierBandStat;
  readonly confident: BrierBandStat;
  readonly weak: BrierBandStat;
  readonly poor: BrierBandStat;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Band boundaries from D3 §Q5. */
const BAND_MIDPOINTS = {
  strong: 0.925, // midpoint of [0.85, 1.00]
  confident: 0.775, // midpoint of [0.70, 0.85]
  weak: 0.60, // midpoint of [0.50, 0.70]
  poor: 0.25, // midpoint of [0.00, 0.50]
} as const;

/** Classify a combinedScore into a D3 band. */
function scoreToBand(score: number): "strong" | "confident" | "weak" | "poor" {
  if (score >= 0.85) return "strong";
  if (score >= 0.70) return "confident";
  if (score >= 0.50) return "weak";
  return "poor";
}

/** Check whether a candidate root matches the expected atom (or its alternates). */
function isCorrect(root: string, expected: string | null, alternates: readonly string[]): boolean {
  if (expected === null) return false;
  if (root === expected) return true;
  return alternates.includes(root);
}

// ---------------------------------------------------------------------------
// M1 — Hit rate
// ---------------------------------------------------------------------------

/**
 * M1: percentage of queries where top-1 combinedScore >= 0.50 (D3 "weak" band entry).
 *
 * Negative-space entries (expectedAtom === null) are EXCLUDED from the denominator
 * because there is no correct atom to surface; their absence from the "hit" count
 * is expected behavior, not a miss.
 *
 * Returns 1.0 for empty corpus (no positive entries → no misses possible).
 */
export function computeHitRate(results: readonly QueryEvalResult[]): number {
  const positiveResults = results.filter((r) => r.expectedAtom !== null);
  if (positiveResults.length === 0) return 1.0;

  const hits = positiveResults.filter((r) => {
    const top1 = r.candidates[0];
    return top1 !== undefined && top1.combinedScore >= 0.5;
  });

  return hits.length / positiveResults.length;
}

// ---------------------------------------------------------------------------
// M2 — Precision@1
// ---------------------------------------------------------------------------

/**
 * M2: percentage of queries where the top-1 candidate's BlockMerkleRoot equals
 * expectedAtom (or is in acceptableAtoms).
 *
 * Negative-space entries are excluded (expectedAtom === null cannot match).
 * Returns 1.0 for empty corpus.
 */
export function computePrecisionAt1(results: readonly QueryEvalResult[]): number {
  const positiveResults = results.filter((r) => r.expectedAtom !== null);
  if (positiveResults.length === 0) return 1.0;

  const correct = positiveResults.filter((r) => {
    const top1 = r.candidates[0];
    return (
      top1 !== undefined && isCorrect(top1.blockMerkleRoot, r.expectedAtom, r.acceptableAtoms)
    );
  });

  return correct.length / positiveResults.length;
}

// ---------------------------------------------------------------------------
// M3 — Recall@K
// ---------------------------------------------------------------------------

/**
 * M3: percentage of queries where expectedAtom appears anywhere in the top-K candidates.
 *
 * Negative-space entries are excluded.
 * Returns 1.0 for empty corpus.
 */
export function computeRecallAtK(results: readonly QueryEvalResult[], k: number): number {
  const positiveResults = results.filter((r) => r.expectedAtom !== null);
  if (positiveResults.length === 0) return 1.0;

  const recalled = positiveResults.filter((r) => {
    const topK = r.candidates.slice(0, k);
    return topK.some((c) => isCorrect(c.blockMerkleRoot, r.expectedAtom, r.acceptableAtoms));
  });

  return recalled.length / positiveResults.length;
}

// ---------------------------------------------------------------------------
// M4 — MRR
// ---------------------------------------------------------------------------

/**
 * M4: Mean Reciprocal Rank.
 * For each query, the reciprocal rank is 1/rank if expectedAtom appears in
 * the candidate list, or 0 if absent. Averaged over all positive corpus entries.
 *
 * Negative-space entries are excluded.
 * Returns 1.0 for empty corpus.
 */
export function computeMRR(results: readonly QueryEvalResult[]): number {
  const positiveResults = results.filter((r) => r.expectedAtom !== null);
  if (positiveResults.length === 0) return 1.0;

  let sum = 0;
  for (const r of positiveResults) {
    const rank = r.candidates.findIndex((c) =>
      isCorrect(c.blockMerkleRoot, r.expectedAtom, r.acceptableAtoms),
    );
    if (rank >= 0) {
      sum += 1 / (rank + 1);
    }
  }

  return sum / positiveResults.length;
}

// ---------------------------------------------------------------------------
// M5 — Score calibration (per-band Brier)
// ---------------------------------------------------------------------------

/**
 * M5: Per-band Brier score measuring (P_b - midpoint_b)² for each D3 band.
 *
 * All results (including negative-space entries) contribute to band counts:
 * a result is "correct" iff its top-1 candidate matches expectedAtom.
 * Negative-space entries with expectedAtom === null are always "incorrect".
 *
 * Empty bands (N_b = 0) contribute brier = 0 and a warning is logged.
 */
export function computeBrierPerBand(results: readonly QueryEvalResult[]): BrierPerBandResult {
  const bands = {
    strong: { N: 0, correct: 0 },
    confident: { N: 0, correct: 0 },
    weak: { N: 0, correct: 0 },
    poor: { N: 0, correct: 0 },
  };

  for (const r of results) {
    const top1 = r.candidates[0];
    if (top1 === undefined) continue;

    const band = scoreToBand(top1.combinedScore);
    bands[band].N++;
    if (isCorrect(top1.blockMerkleRoot, r.expectedAtom, r.acceptableAtoms)) {
      bands[band].correct++;
    }
  }

  function buildStat(
    band: "strong" | "confident" | "weak" | "poor",
  ): BrierBandStat {
    const { N, correct } = bands[band];
    const midpoint = BAND_MIDPOINTS[band];
    if (N === 0) {
      console.warn(
        `[discovery-eval] M5 warning: ${band} band has N=0; add ${band}-band corpus entries`,
      );
      return { N: 0, correct: 0, P: null, midpoint, brier: 0 };
    }
    const P = correct / N;
    const brier = (P - midpoint) ** 2;
    return { N, correct, P, midpoint, brier };
  }

  return {
    strong: buildStat("strong"),
    confident: buildStat("confident"),
    weak: buildStat("weak"),
    poor: buildStat("poor"),
  };
}
