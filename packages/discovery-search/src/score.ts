// SPDX-License-Identifier: Apache-2.0
// @decision DEC-1117-AUTHORITY-001
// @title Kit re-exposes canonical scoring/tier logic; does NOT fork it
// @status decided (MASTER_PLAN.md 2026-06-06)
// @rationale
//   cosineDistanceToCombinedScore, assignScoreBand, BAND_MIDPOINTS, M1_HIT_THRESHOLD
//   are authoritative in @yakcc/registry/src/discovery-eval-helpers.ts.
//   The auto-accept thresholds (0.85/0.05/0.92) are authoritative in
//   packages/mcp-registry/src/tools/resolve.ts.
//
//   These functions are lifted verbatim here because:
//   (a) @yakcc/registry's only package export is its barrel (dist/index.js),
//       which transitively imports better-sqlite3 — a node-native dep that would
//       break any browser bundle consuming this kit (DEC-1117-PLACEMENT-001).
//   (b) @yakcc/registry has no narrow per-file exports declared.
//   (c) packages/registry/package.json is outside the allowed scope for this slice.
//
//   "Verbatim" means byte-identical logic, not approximate. The scoring.test.ts
//   asserts value-equality against the authority across boundary inputs
//   (DEC-1117-AUTHORITY-001 enforcement). Future Implementers: if the authority
//   values change, update here AND the test table — the test will catch drift.
//
// @decision DEC-1117-PLACEMENT-001
//   Browser-clean: no imports. All functions are pure with no deps.

// ---------------------------------------------------------------------------
// Score band type
// ---------------------------------------------------------------------------

/**
 * Score band names as defined in D3 ADR.
 * Source authority: @yakcc/registry/src/discovery-eval-helpers.ts
 */
export type ScoreBand = "strong" | "confident" | "weak" | "poor";

// ---------------------------------------------------------------------------
// cosineDistanceToCombinedScore (verbatim from discovery-eval-helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Convert a vec0 distance value to D3's combinedScore.
 *
 * @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (source authority:
 *   @yakcc/registry/src/discovery-eval-helpers.ts)
 * @rationale sqlite-vec vec0 returns L2 Euclidean distance. For unit-normalized
 *   vectors, the correct mapping is 1 - L2²/4 = (1 + cos(θ)) / 2.
 *   d=0 → 1.0 (identical), d=√2 → 0.5 (orthogonal), d=2 → 0.0 (antipodal).
 *
 * AUTHORITY NOTE: this formula is identical to the source. scoring.test.ts
 * asserts byte-equal outputs across a table of distances incl. boundaries.
 */
export function cosineDistanceToCombinedScore(cosineDistance: number): number {
  return Math.max(0, Math.min(1, 1 - (cosineDistance * cosineDistance) / 4));
}

// ---------------------------------------------------------------------------
// assignScoreBand (verbatim from discovery-eval-helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Assign a D3 score band to a combinedScore.
 *
 * Band boundaries (D3 ADR §Q5):
 *   strong:    combinedScore in [0.85, 1.00]
 *   confident: combinedScore in [0.70, 0.85)
 *   weak:      combinedScore in [0.50, 0.70)
 *   poor:      combinedScore in [0.00, 0.50)
 *
 * Source authority: @yakcc/registry/src/discovery-eval-helpers.ts
 */
export function assignScoreBand(combinedScore: number): ScoreBand {
  if (combinedScore >= 0.85) return "strong";
  if (combinedScore >= 0.7) return "confident";
  if (combinedScore >= 0.5) return "weak";
  return "poor";
}

/** Band midpoints as defined in D5 ADR Q1/Q4.
 *  Source authority: @yakcc/registry/src/discovery-eval-helpers.ts
 */
export const BAND_MIDPOINTS: Record<ScoreBand, number> = {
  strong: 0.925,
  confident: 0.775,
  weak: 0.6,
  poor: 0.25,
};

/**
 * M1 hit-rate threshold — combinedScore at or above which a query is a "hit".
 * Source authority: @yakcc/registry/src/discovery-eval-helpers.ts
 * (DEC-V3-DISCOVERY-CALIBRATION-FIX-002 restored this to 0.50)
 */
export const M1_HIT_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Auto-accept threshold constants (verbatim from resolve.ts)
// ---------------------------------------------------------------------------

/**
 * Hybrid auto-accept threshold: top score must exceed this for auto-accept.
 *
 * Source authority: HYBRID_AUTO_ACCEPT_THRESHOLD in
 * packages/mcp-registry/src/tools/resolve.ts (DEC-1009-THRESHOLD-RETUNE-001).
 * Value-equality is asserted in scoring.test.ts.
 */
export const HYBRID_AUTO_ACCEPT_THRESHOLD = 0.85;

/**
 * Auto-accept gap threshold: gap between top-1 and top-2 score must exceed this.
 *
 * Source authority: AUTO_ACCEPT_GAP_THRESHOLD in
 * packages/mcp-registry/src/tools/resolve.ts.
 * Value-equality is asserted in scoring.test.ts.
 */
export const AUTO_ACCEPT_GAP_THRESHOLD = 0.05;

/**
 * High-confidence override threshold: top score above this waives the gap
 * requirement (issue #1029, DEC-1029-HIGH-CONF-OVERRIDE-001).
 *
 * Source authority: HIGH_CONFIDENCE_THRESHOLD in
 * packages/mcp-registry/src/tools/resolve.ts.
 * Value-equality is asserted in scoring.test.ts.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.92;

// ---------------------------------------------------------------------------
// Cosine similarity helper (pure browser utility)
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two Float32Arrays of the same length.
 *
 * Returns a value in [-1, 1]: 1 = identical direction, 0 = orthogonal,
 * -1 = opposite. For unit-normalized vectors (bge-small-en-v1.5 with
 * normalize:true), equivalent to the dot product.
 *
 * Throws if the arrays have different lengths.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
