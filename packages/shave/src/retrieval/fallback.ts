// SPDX-License-Identifier: MIT
//
// @decision DEC-RETRIEVAL-GAP-GATE-001 (wi-reuse B6, GH #1263)
// Gap-gated fallback. Unconditional synthesis after a retrieval miss spends tokens for
// little gain (the SEAM deck: slice plus unconditional fallback cost twice the tokens
// for one fewer fact). Fallback is triggered only by a measured gap:
//   - reuse:       a candidate scores at or above the strong threshold. Compose by
//                  reference, with no synthesis.
//   - synthesize:  no candidate is strong (only near-misses). Gap: near-miss only.
//   - synthesize:  a reused composition leaves unexplained references (DUC unexplained
//                  set non-empty). Gap: residual to explain.
// Every decision records its reason, and `tallyDecisions` counts them. The reasons are
// emitted so the rate of each kind of fallback can be measured, not guessed.
//
// Pure. The wiring into shave's pipeline and the B1 evaluation arm consume this.

export interface GapInput {
  /** Candidate scores, in any order. */
  readonly scores: readonly number[];
  /** A score at or above this counts as a strong match. */
  readonly strongThreshold: number;
  /** Unexplained references in the composed output (DUC gate). Zero when none, or not yet measured. */
  readonly unexplainedCount: number;
}

export type FallbackDecision =
  | { readonly action: "reuse"; readonly reason: "strong-match"; readonly candidateIndex: number }
  | { readonly action: "synthesize"; readonly reason: "near-miss-only" }
  | {
      readonly action: "synthesize";
      readonly reason: "unexplained-residual";
      readonly candidateIndex: number;
    };

/** Decide whether to reuse a candidate or synthesize, from the measured gap. */
export function decideFallback(input: GapInput): FallbackDecision {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  input.scores.forEach((score, index) => {
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  if (best < 0 || bestScore < input.strongThreshold) {
    return { action: "synthesize", reason: "near-miss-only" };
  }
  if (input.unexplainedCount > 0) {
    return { action: "synthesize", reason: "unexplained-residual", candidateIndex: best };
  }
  return { action: "reuse", reason: "strong-match", candidateIndex: best };
}

export interface DecisionTally {
  readonly reuse: number;
  readonly synthesizeNearMiss: number;
  readonly synthesizeResidual: number;
  /** Fraction of decisions that synthesized, in [0, 1]. 0 when there are no decisions. */
  readonly synthesisRate: number;
}

/** Count decisions by kind, so the fallback rate and its causes can be reported. */
export function tallyDecisions(decisions: readonly FallbackDecision[]): DecisionTally {
  let reuse = 0;
  let nearMiss = 0;
  let residual = 0;
  for (const d of decisions) {
    if (d.action === "reuse") reuse++;
    else if (d.reason === "near-miss-only") nearMiss++;
    else residual++;
  }
  const total = decisions.length;
  return {
    reuse,
    synthesizeNearMiss: nearMiss,
    synthesizeResidual: residual,
    synthesisRate: total === 0 ? 0 : (nearMiss + residual) / total,
  };
}
