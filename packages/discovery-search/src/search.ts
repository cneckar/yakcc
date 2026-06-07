// SPDX-License-Identifier: Apache-2.0
// @decision DEC-1117-PLACEMENT-001
// @title Browser-safe linear cosine rank using kit's pure scoring primitives
// @status decided (MASTER_PLAN.md 2026-06-06)
// @rationale
//   The atom explorer needs to cosine-rank a pre-built embeddings index
//   client-side without any server round-trip. This module provides a pure
//   O(n) linear scan over a typed Float32Array index using the same
//   cosineDistanceToCombinedScore formula the server uses, producing ranked
//   results that feed directly into deriveConfidenceTier.
//
//   Linear scan is correct for the expected corpus size (~5k atoms × 384 dims
//   ≈ 7.5MB Float32 index). HNSW/ANN is deferred — the DEC-1117-INDEX-FORMAT-001
//   decision (Slice 2) pinned Float32 blob format which supports both linear and
//   future HNSW indexing.

import { type ScoreBand, assignScoreBand, cosineDistanceToCombinedScore } from "./score.js";
import { type ConfidenceTier, type ScoredCandidate, deriveConfidenceTier } from "./tier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ranked result from rankCandidates(). */
export interface RankedResult {
  /** Index into the original `atomVectors` array. */
  readonly index: number;
  /** combinedScore in [0, 1], computed via cosineDistanceToCombinedScore. */
  readonly score: number;
  /** D3 score band assigned to the combinedScore. */
  readonly band: ScoreBand;
}

/** Output of rankCandidates() — ranked results plus derived tier. */
export interface RankResult {
  /** All atoms ranked by descending combinedScore. */
  readonly ranked: readonly RankedResult[];
  /** Confidence tier derived from the top candidates. */
  readonly tier: ConfidenceTier;
}

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

/**
 * Cosine-rank a query vector against an array of atom embedding vectors.
 *
 * Each `atomVectors[i]` is a Float32Array of length `queryVec.length`. The
 * function performs an O(n) linear scan, computing cosine similarity for each
 * atom, converting to combinedScore, assigning a score band, then sorting
 * descending by combinedScore.
 *
 * The top-K results (after sorting) are passed to `deriveConfidenceTier` to
 * produce the tier. This mirrors the server's D4 ADR Q5 flow.
 *
 * **Unit-normalized vectors:** if both `queryVec` and `atomVectors[i]` are
 * L2-normalized (as bge-small-en-v1.5 produces with normalize:true), cosine
 * similarity equals the dot product and is already in [−1, 1]. The
 * `cosineDistanceToCombinedScore` formula (`1 − L2²/4`) is applied to the
 * L2 distance derived from the similarity: `L2 = sqrt(2 − 2·sim)`.
 * For normalized vectors this simplifies to `combinedScore = (1 + sim) / 2`.
 *
 * @param queryVec   - Query embedding (Float32Array, length = embedding dim).
 * @param atomVectors - Array of atom embeddings, one per atom.
 * @param topK        - How many top results to return in `ranked` (default: all).
 * @returns RankResult with sorted ranked list and confidence tier.
 */
export function rankCandidates(
  queryVec: Float32Array,
  atomVectors: readonly Float32Array[],
  topK?: number,
): RankResult {
  const dim = queryVec.length;
  const results: RankedResult[] = [];

  for (let i = 0; i < atomVectors.length; i++) {
    const vec = atomVectors[i];
    if (vec === undefined || vec.length !== dim) continue;

    // Compute cosine similarity (dot product for normalized vectors).
    let dot = 0;
    let normQ = 0;
    let normA = 0;
    for (let j = 0; j < dim; j++) {
      const q = queryVec[j] ?? 0;
      const a = vec[j] ?? 0;
      dot += q * a;
      normQ += q * q;
      normA += a * a;
    }
    const denom = Math.sqrt(normQ) * Math.sqrt(normA);
    const sim = denom === 0 ? 0 : dot / denom;

    // Convert cosine similarity to L2 distance, then to combinedScore.
    // For unit-sphere: L2 = sqrt(2 - 2*sim), so L2² = 2 - 2*sim.
    // cosineDistanceToCombinedScore(L2) = 1 - L2²/4 = 1 - (2-2*sim)/4 = (1+sim)/2.
    const l2Sq = Math.max(0, 2 - 2 * sim);
    const l2 = Math.sqrt(l2Sq);
    const score = cosineDistanceToCombinedScore(l2);
    const band = assignScoreBand(score);

    results.push({ index: i, score, band });
  }

  // Sort descending by combinedScore.
  results.sort((a, b) => b.score - a.score);

  const ranked: readonly RankedResult[] = topK !== undefined ? results.slice(0, topK) : results;

  // Derive tier from ALL sorted results (not just topK) to match server semantics.
  const tierCandidates: ScoredCandidate[] = results.map((r) => ({ score: r.score }));
  const tier: ConfidenceTier = deriveConfidenceTier(tierCandidates);

  return { ranked, tier };
}
