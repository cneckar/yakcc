// SPDX-License-Identifier: MIT
//
// @decision DEC-RETRIEVAL-FILL-001 (wi-reuse B4, GH #1261)
// Budgeted, source-spread, cited fill (SEAM "Rank / Fill / Cite"). Retrieval returns
// ranked candidates. Fill chooses a subset that fits a token budget, spreads it across
// source packages so one package cannot dominate the composition context, and keeps a
// citation on every item. It is deterministic and needs no model.
//
// Two passes, so spreading never leaves budget unused:
//   1. Greedy by score. A package may use at most `maxPackageShare` of the budget.
//   2. Fill the remaining budget with any candidate that still fits, ignoring the share.
// Ties in score keep their input order (stable), so the result is reproducible.
//
// Tokens are estimated as ceil(chars / 4) unless a counter is supplied. The estimate
// is a budget bound, not a tokenizer.

/** A cited span of source a candidate refers to. */
export interface FillCitation {
  readonly merkleRoot: string;
  readonly sourceFile: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** A ranked candidate eligible for fill. */
export interface FillCandidate {
  readonly id: string;
  readonly sourcePkg: string;
  readonly score: number;
  readonly text: string;
  readonly citation: FillCitation;
}

export interface FillOptions {
  /** Maximum total tokens (estimated) to select. */
  readonly tokenBudget: number;
  /** Maximum fraction of the budget one source package may take in pass 1, in (0, 1]. */
  readonly maxPackageShare: number;
  /** Optional tokenizer. Defaults to ceil(chars / 4). */
  readonly countTokens?: (text: string) => number;
}

export interface FillResult {
  readonly selected: readonly FillCandidate[];
  readonly tokens: number;
  /** Tokens used per source package. */
  readonly byPackage: Readonly<Record<string, number>>;
}

const defaultCount = (text: string): number => Math.ceil(text.length / 4);

/**
 * Select candidates within the token budget, spread across source packages, each with
 * its citation. Output order is the selection order (score descending).
 */
export function fill(candidates: readonly FillCandidate[], options: FillOptions): FillResult {
  if (!(options.maxPackageShare > 0 && options.maxPackageShare <= 1)) {
    throw new RangeError("maxPackageShare must be in (0, 1]");
  }
  if (!(options.tokenBudget >= 0)) throw new RangeError("tokenBudget must be >= 0");
  const count = options.countTokens ?? defaultCount;
  const cap = options.tokenBudget * options.maxPackageShare;

  // Stable sort by score, descending; input order breaks ties.
  const ordered = candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.score - a.c.score || a.index - b.index)
    .map(({ c }) => c);

  const chosen = new Set<FillCandidate>();
  const byPackage: Record<string, number> = {};
  let tokens = 0;

  const take = (c: FillCandidate, t: number): void => {
    chosen.add(c);
    tokens += t;
    byPackage[c.sourcePkg] = (byPackage[c.sourcePkg] ?? 0) + t;
  };

  // Pass 1: respect the per-package share.
  for (const c of ordered) {
    const t = count(c.text);
    if (tokens + t > options.tokenBudget) continue;
    if ((byPackage[c.sourcePkg] ?? 0) + t > cap) continue;
    take(c, t);
  }
  // Pass 2: spend what is left, ignoring the share.
  for (const c of ordered) {
    if (chosen.has(c)) continue;
    const t = count(c.text);
    if (tokens + t > options.tokenBudget) continue;
    take(c, t);
  }

  const selected = ordered.filter((c) => chosen.has(c));
  return { selected, tokens, byPackage };
}
