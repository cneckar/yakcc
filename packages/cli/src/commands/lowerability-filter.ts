// SPDX-License-Identifier: MIT
// @decision DEC-DISCOVERY-D2-LANGUAGE-001
// title: applyLowerabilityFilter — post-retrieval output-target filter
// status: accepted (WI-784)
// rationale: The lowerability filter is a post-retrieval pass: candidates are
//   retrieved from the KNN index as usual, then filtered by whether their
//   IR AST can be lowered to the requested target language. This design keeps
//   the storage schema untouched (no language column in the DB) and makes
//   the filter cost proportional to the result set (top-K), not the index size.
//
//   Placement: packages/cli — not packages/registry. @yakcc/compile-python
//   already depends on @yakcc/registry, so importing compile-python INTO
//   registry would create a circular dependency. The CLI layer is the right
//   host because it can import both packages without circularity.
//
//   Go/Rust adapters: not yet shipped. language="go"|"rs" → all candidates
//   returned with lowerability="unknown". No candidate dropped. No error thrown.
//
//   Default (undefined/"ts"): pass-through. No annotation. Output is
//   byte-identical to pre-filter behavior — existing callers unaffected.
//
//   References: packages/compile-python/src/can-lower-to.ts (DEC-POLYGLOT-CANLOWER-PY-001)
//              packages/contracts/src/canonicalize.ts (DEC-DISCOVERY-D2-LANGUAGE-001)

import { canLowerTo } from "@yakcc/compile-python";
import type { CandidateMatch } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lowerability annotation on a candidate.
 *
 * - "yes":     canLowerTo returned true — adapter confirms it can lower this atom.
 * - "unknown": adapter returned "unknown" — retained with annotation, not dropped.
 * - "no":      canLowerTo returned false — atom dropped from results (not included).
 */
export type Lowerability = "yes" | "unknown" | "no";

/**
 * A CandidateMatch annotated with lowerability state.
 *
 * Present only when a non-ts language filter was applied. When the language
 * filter is not active (undefined/"ts"), candidates are returned as plain
 * CandidateMatch without this annotation (backward-compatible).
 */
export interface AnnotatedCandidateMatch extends CandidateMatch {
  /** Lowerability verdict for the requested target language. */
  readonly lowerability: Lowerability;
}

/**
 * Result of applyLowerabilityFilter.
 *
 * When language is undefined/"ts", returns the input candidates unchanged
 * (no annotation, same reference types) for backward compatibility.
 * When language is a non-ts target, returns AnnotatedCandidateMatch[].
 */
export type LowerabilityFilterResult =
  | { readonly filtered: false; readonly candidates: readonly CandidateMatch[] }
  | { readonly filtered: true; readonly candidates: readonly AnnotatedCandidateMatch[] };

// ---------------------------------------------------------------------------
// Valid target language values (matches QueryIntentCard.language)
// ---------------------------------------------------------------------------
const VALID_LANGUAGES = ["ts", "py", "go", "rs"] as const;
export type TargetLanguage = (typeof VALID_LANGUAGES)[number];

/**
 * Validate and narrow a string to TargetLanguage.
 * Returns the narrowed value or undefined if invalid.
 */
export function parseTargetLanguage(value: string): TargetLanguage | undefined {
  return (VALID_LANGUAGES as readonly string[]).includes(value)
    ? (value as TargetLanguage)
    : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post-retrieval lowerability filter for discovery query results.
 *
 * Given a set of KNN candidates and a target language, applies the appropriate
 * compile adapter's canLowerTo gate to annotate and/or drop candidates.
 *
 * Production sequence (called from the query path after KNN retrieval):
 *   1. findCandidatesByIntent retrieves top-K candidates
 *   2. applyLowerabilityFilter is called with the candidates + language
 *   3. Candidates where canLowerTo returns false are dropped
 *   4. Candidates where canLowerTo returns "unknown" are retained with annotation
 *   5. Candidates where canLowerTo returns true are retained with lowerability="yes"
 *
 * When language is undefined or "ts": returns candidates unchanged (filtered=false).
 * This preserves byte-identical behavior for all existing callers.
 *
 * @param candidates - CandidateMatch array from findCandidatesByIntent (post-rerank).
 * @param language   - Output-target language, or undefined for pass-through.
 * @returns LowerabilityFilterResult — filtered=false means pass-through.
 */
export function applyLowerabilityFilter(
  candidates: readonly CandidateMatch[],
  language: TargetLanguage | undefined,
): LowerabilityFilterResult {
  // Default case: undefined or "ts" → pass-through, no annotation, no filter.
  // This preserves byte-identical backward-compatible behavior.
  if (language === undefined || language === "ts") {
    return { filtered: false, candidates };
  }

  // Go/Rust: no adapter shipped yet.
  // Return all candidates with lowerability="unknown" — none dropped.
  if (language === "go" || language === "rs") {
    const annotated: AnnotatedCandidateMatch[] = candidates.map((c) => ({
      ...c,
      lowerability: "unknown" as Lowerability,
    }));
    return { filtered: true, candidates: annotated };
  }

  // Python ("py"): call canLowerTo from @yakcc/compile-python.
  // Candidates returning false are dropped; "unknown" and true are kept with annotation.
  const annotated: AnnotatedCandidateMatch[] = [];
  for (const candidate of candidates) {
    const result = canLowerTo(candidate.block, "py");
    if (result === false) {
      // Definitively not lowerable to Python — drop from results
      continue;
    }
    const lowerability: Lowerability = result === true ? "yes" : "unknown";
    annotated.push({ ...candidate, lowerability });
  }

  return { filtered: true, candidates: annotated };
}
