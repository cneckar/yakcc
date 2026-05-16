// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
// title: Layer 2 result-set size enforcement — config-driven ambiguity gate
// status: decided (wi-590-s2-layer2)
// rationale:
//   Layer 2 runs AFTER the registry query returns candidates and BEFORE results are
//   returned to the caller. It prevents ambiguous, overloaded result sets from
//   propagating to the consumer — a large "confident" band means the intent is too
//   broad for the registry to discriminate reliably.
//
//   Two checks are applied:
//     (a) confidentCount > maxConfident: too many candidates in the confident band
//         (combinedScore >= confidentThreshold). This signals that multiple registry
//         atoms match the intent with high confidence — decompose further.
//     (b) totalCount > maxOverall: even in the weak band, a very large result set
//         means the intent is not discriminating. This is a backstop for unusual
//         embedding distributions.
//
//   Configuration is ENTIRELY driven by getEnforcementConfig().layer2 (DEC-HOOK-ENF-CONFIG-001).
//   No threshold is hardcoded here. Defaults (maxConfident=3, maxOverall=10,
//   confidentThreshold=0.70) match the CONFIDENT_THRESHOLD already used in
//   yakcc-resolve.ts, so no behavior change occurs when no config file is present.
//
//   The function is pure (no I/O, no async). It is safe to call synchronously in the
//   hot hook path after registry.findCandidatesByQuery() resolves.
//
//   Escape hatch: not defined for Layer 2 (use a config override with high thresholds
//   instead, or disable the gate entirely via YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1).
//
//   Cross-reference:
//     enforcement-config.ts — threshold authority (DEC-HOOK-ENF-CONFIG-001)
//     enforcement-types.ts  — ResultSetSizeResult, ResultSetAcceptEnvelope, ResultSetRejectEnvelope
//     index.ts              — wire point (executeRegistryQueryWithSubstitution)
//     docs/enforcement-config.md — tuning guide
//     plans/wi-579-s2-layer2-result-set-size.md

import type { CandidateMatch } from "@yakcc/registry";
import type { ResultSetSizeResult } from "./enforcement-types.js";
import { getEnforcementConfig } from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// Suggestion text surfaced to the LLM on reject
// ---------------------------------------------------------------------------

const SUGGESTION_TEXT =
  "RESULT_SET_TOO_LARGE: intent matched too many registry candidates.\n" +
  "Refusing to return an ambiguous result set. Per docs/system-prompts/yakcc-discovery.md,\n" +
  "decompose this into more specific sub-intents and resubmit each separately.\n" +
  'Example: "encode string" -> "encodeURIComponent (percent-encoding)", "btoa (base64 ASCII)",\n' +
  '"TextEncoder UTF-8 encode to Uint8Array".';

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------

/**
 * Compute the combined score for a candidate using the same formula as yakcc-resolve.ts.
 *
 * combinedScore = 1 - cosineDistance^2 / 4
 *
 * The formula converts a cosine distance in [0, 2] to a score in [0, 1] where
 * 1.0 = perfect match and 0.0 = maximally distant. This matches CONFIDENT_THRESHOLD
 * (0.70) usage in yakcc-resolve.ts.
 *
 * @decision DEC-HOOK-ENF-LAYER2-SCORE-FORMULA-001
 * title: Combined-score formula matches yakcc-resolve.ts (1 - d^2/4)
 * status: decided (wi-590-s2-layer2)
 * rationale:
 *   Reusing the same formula ensures that the Layer 2 "confident band" aligns exactly
 *   with what yakcc-resolve.ts classifies as "matched" (score >= CONFIDENT_THRESHOLD=0.70).
 *   A separate formula would create inconsistency between Layer 2 and the resolve layer.
 */
function candidateToCombinedScore(candidate: CandidateMatch): number {
  const d = candidate.cosineDistance;
  return 1 - (d * d) / 4;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score and gate a candidate list through Layer 2 result-set size rules.
 *
 * Returns a ResultSetSizeResult discriminated union:
 *   - { layer: 2, status: "ok", confidentCount, totalCount }
 *       — result set is within bounds; proceed.
 *   - { layer: 2, status: "result_set_too_large", reasons, ..., suggestion }
 *       — result set is ambiguous; do NOT return to consumer.
 *
 * This function is pure (no I/O, no async). It is safe to call synchronously
 * in the hot hook path after the registry query resolves.
 *
 * All thresholds are read from getEnforcementConfig().layer2 at call time
 * (DEC-HOOK-ENF-CONFIG-001). Tests may use setConfigOverride() / resetConfigOverride()
 * from enforcement-config.ts to inject controlled configs.
 *
 * Escape hatch: YAKCC_HOOK_DISABLE_RESULT_SET_GATE=1 bypasses this layer at the
 * call site in index.ts; this function itself does NOT check the env var.
 *
 * @param candidates - The full candidate list from registry.findCandidatesByQuery().
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 */
export function scoreResultSetSize(candidates: readonly CandidateMatch[]): ResultSetSizeResult {
  const cfg = getEnforcementConfig().layer2;
  const { maxConfident, maxOverall, confidentThreshold } = cfg;

  const totalCount = candidates.length;
  const confidentCount = candidates.filter(
    (c) => candidateToCombinedScore(c) >= confidentThreshold,
  ).length;

  const reasons: Array<import("./enforcement-types.js").ResultSetRejectReason> = [];

  if (confidentCount > maxConfident) {
    reasons.push("too_many_confident");
  }
  if (totalCount > maxOverall) {
    reasons.push("too_many_overall");
  }

  if (reasons.length > 0) {
    return {
      layer: 2,
      status: "result_set_too_large",
      reasons: reasons as readonly import("./enforcement-types.js").ResultSetRejectReason[],
      confidentCount,
      totalCount,
      maxConfident,
      maxOverall,
      suggestion: SUGGESTION_TEXT,
    };
  }

  return {
    layer: 2,
    status: "ok",
    confidentCount,
    totalCount,
  };
}

/**
 * Convenience predicate: returns true when the result set passes the size gate.
 *
 * Equivalent to `scoreResultSetSize(candidates).status === "ok"`.
 */
export function isResultSetSizeOk(candidates: readonly CandidateMatch[]): boolean {
  return scoreResultSetSize(candidates).status === "ok";
}
