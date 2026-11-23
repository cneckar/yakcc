// SPDX-License-Identifier: MIT
//
// @decision DEC-RETRIEVAL-CONTEXT-001 (wi-reuse B7, GH #1271)
// The composition context: the retrieved candidates a composing model is shown. Retrieval
// ranks candidates; this step chooses which of them reach composition, under a token budget.
//
//   - Default (`sourceSpread` absent): rank order alone. Greedy by score within the budget,
//     the selection composition had before the fill was wired in. It is exactly `fill` with
//     `maxPackageShare: 1`, so both modes share one implementation.
//   - `sourceSpread: { maxPackageShare }`: the budgeted source-spread fill
//     (DEC-RETRIEVAL-FILL-001). In its first pass one package may take at most that share of
//     the budget, so it cannot crowd out candidates from other packages. Its second pass
//     spends what is left.
//
// The fill is opt-in, so the default composition context is unchanged. Every selection
// reports its mode, what it dropped, and tokens per package, so a run can record the
// candidate set with the fill on and off.
//
// Candidates come from either retrieval channel. Intent-embedding and lexical candidates are
// already FillCandidates. Graph-search candidates (#1280) carry structure, not provenance, so
// `graphSearchCandidates` adapts them using a provenance lookup the caller supplies. A graph
// with no provenance has no citation, and is reported as uncited instead of being selected.

import { type FillCandidate, type FillCitation, fill } from "./fill.js";

export interface SourceSpread {
  /** Maximum share of the budget one source package may take in the fill's first pass, in (0, 1]. */
  readonly maxPackageShare: number;
}

export interface CompositionContextOptions {
  /** Maximum total tokens (estimated) to show the composing model. */
  readonly tokenBudget: number;
  /** Turn on the source-spread fill. Absent: rank order alone (the default). */
  readonly sourceSpread?: SourceSpread;
  /** Optional tokenizer. Defaults to ceil(chars / 4). */
  readonly countTokens?: (text: string) => number;
}

export interface CompositionContext {
  /** "rank": score order within the budget. "fill": the source-spread fill. */
  readonly mode: "rank" | "fill";
  /** The share cap in effect: 1 for rank order. */
  readonly maxPackageShare: number;
  /** Candidates that reach composition, best score first, each with its citation. */
  readonly selected: readonly FillCandidate[];
  /** Ids of candidates that were not selected, in input order. */
  readonly dropped: readonly string[];
  readonly tokens: number;
  readonly byPackage: Readonly<Record<string, number>>;
}

/** Choose the candidates a composing model is shown (DEC-RETRIEVAL-CONTEXT-001). */
export function selectCompositionContext(
  candidates: readonly FillCandidate[],
  options: CompositionContextOptions,
): CompositionContext {
  const share = options.sourceSpread?.maxPackageShare ?? 1;
  const result = fill(candidates, {
    tokenBudget: options.tokenBudget,
    maxPackageShare: share,
    ...(options.countTokens !== undefined ? { countTokens: options.countTokens } : {}),
  });
  const chosen = new Set(result.selected);
  return {
    mode: options.sourceSpread === undefined ? "rank" : "fill",
    maxPackageShare: share,
    selected: result.selected,
    dropped: candidates.filter((c) => !chosen.has(c)).map((c) => c.id),
    tokens: result.tokens,
    byPackage: result.byPackage,
  };
}

/** The fields of a graph-search result (`searchGraphs`, @yakcc/compile) the adapter reads. */
export interface GraphSearchHit {
  readonly graphIdentity: string;
  readonly exact: boolean;
  /** 0 for the same structural bags, 1 for disjoint ones. */
  readonly structuralDistance: number;
  readonly lineForm: string;
}

/** Where a stored graph came from: its source package and the span it was shaved from. */
export interface GraphProvenance {
  readonly sourcePkg: string;
  readonly citation: FillCitation;
}

export interface GraphCandidates {
  readonly candidates: readonly FillCandidate[];
  /** Graph identities with no provenance. They have no citation and are not candidates. */
  readonly uncited: readonly string[];
}

/**
 * Adapt graph-search results to fill candidates. The score is the structural similarity:
 * 1 for an exact match, otherwise one minus the structural distance, so the fill ranks graph
 * candidates the way the search selected them. The text is the graph's line form.
 */
export function graphSearchCandidates(
  hits: readonly GraphSearchHit[],
  provenanceOf: (graphIdentity: string) => GraphProvenance | undefined,
): GraphCandidates {
  const candidates: FillCandidate[] = [];
  const uncited: string[] = [];
  for (const h of hits) {
    const p = provenanceOf(h.graphIdentity);
    if (p === undefined) {
      uncited.push(h.graphIdentity);
      continue;
    }
    candidates.push({
      id: h.graphIdentity,
      sourcePkg: p.sourcePkg,
      score: h.exact ? 1 : 1 - h.structuralDistance,
      text: h.lineForm,
      citation: p.citation,
    });
  }
  return { candidates, uncited };
}
