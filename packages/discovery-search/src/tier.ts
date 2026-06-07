// SPDX-License-Identifier: Apache-2.0
// @decision DEC-1117-AUTHORITY-001
// @title deriveConfidenceTier lifted verbatim from resolve.ts; byte-parity asserted
// @status decided (MASTER_PLAN.md 2026-06-06)
// @rationale
//   deriveConfidenceTier is a private function in
//   packages/mcp-registry/src/tools/resolve.ts — there is no clean re-export
//   surface without pulling MCP/hooks-base deps into the browser bundle.
//   It is lifted verbatim here (same logic, same constants from score.ts).
//   tier.test.ts asserts value-equality of the tier derivation against the
//   resolve.ts semantics: top>0.92 ⇒ auto_accept; top>0.85 & gap>0.05 ⇒
//   auto_accept; empty ⇒ no_candidates; else candidate_list.
//
// @decision DEC-1117-PLACEMENT-001
//   Browser-clean: imports only from score.ts (no node deps).

import {
  AUTO_ACCEPT_GAP_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  HYBRID_AUTO_ACCEPT_THRESHOLD,
} from "./score.js";

// ---------------------------------------------------------------------------
// Confidence tier type
// ---------------------------------------------------------------------------

/**
 * Three-valued confidence tier derived from a ranked candidate list.
 *
 * Source authority: ConfidenceTier type in
 * packages/mcp-registry/src/tools/resolve.ts (D4 ADR Q5 hybrid mode).
 *
 *   auto_accept:    top score > HIGH_CONFIDENCE_THRESHOLD (0.92), gap waived
 *                   OR top score > HYBRID_AUTO_ACCEPT_THRESHOLD (0.85)
 *                      AND gap to second > AUTO_ACCEPT_GAP_THRESHOLD (0.05)
 *   candidate_list: has candidates but not auto_accept
 *   no_candidates:  no candidates at all
 */
export type ConfidenceTier = "auto_accept" | "candidate_list" | "no_candidates";

// ---------------------------------------------------------------------------
// Scored candidate shape
// ---------------------------------------------------------------------------

/**
 * Minimal scored candidate shape for deriveConfidenceTier.
 *
 * The full server-side type is EvidenceProjection (hooks-base/src/yakcc-resolve.ts),
 * which has additional fields (address, behavior, signature, etc.). The kit only
 * needs the `score` field for tier derivation; extra fields are permitted by
 * structural typing.
 */
export interface ScoredCandidate {
  readonly score: number;
}

// ---------------------------------------------------------------------------
// deriveConfidenceTier (verbatim from resolve.ts)
// ---------------------------------------------------------------------------

/**
 * Map a ranked candidate list to one of three D4 ADR Q5 confidence tiers.
 *
 * Logic is byte-identical to the private `deriveConfidenceTier()` in
 * packages/mcp-registry/src/tools/resolve.ts. tier.test.ts asserts this.
 *
 * @param candidates - Ranked list of scored candidates, highest score first.
 *                     Accepts any object with a numeric `score` field
 *                     (structural superset of EvidenceProjection).
 *
 * Rules (source: DEC-1009-THRESHOLD-RETUNE-001, DEC-1029-HIGH-CONF-OVERRIDE-001):
 *   1. Empty array → "no_candidates"
 *   2. top.score > 0.92 → "auto_accept" (gap waived — high-confidence override)
 *   3. top.score > 0.85 AND gap > 0.05 → "auto_accept"
 *   4. Otherwise → "candidate_list"
 */
export function deriveConfidenceTier(candidates: readonly ScoredCandidate[]): ConfidenceTier {
  if (candidates.length === 0) {
    return "no_candidates";
  }
  const top = candidates[0];
  if (top === undefined) return "no_candidates";

  const topScore = top.score;
  const secondScore = candidates[1]?.score ?? 0;
  const gap = topScore - secondScore;

  // High-confidence override — drop the gap requirement when top is very strong.
  if (topScore > HIGH_CONFIDENCE_THRESHOLD) {
    return "auto_accept";
  }

  if (topScore > HYBRID_AUTO_ACCEPT_THRESHOLD && gap > AUTO_ACCEPT_GAP_THRESHOLD) {
    return "auto_accept";
  }

  return "candidate_list";
}
