// SPDX-License-Identifier: MIT
//
// @decision DEC-RETRIEVAL-LEXICAL-001 (wi-reuse B3, GH #1260)
// A lexical channel for candidate retrieval. Embedding KNN blurs rare identifiers and
// API names. A BM25 index over intent text and identifiers recovers them. Reciprocal
// rank fusion (RRF) combines the lexical ranking with the embedding ranking without
// needing comparable scores. Pure and dependency-free, so it is testable without a
// registry or a model. Registry wiring is a separate step and is opt-in.
//
// Tokenization keeps the whole identifier (`sanitizeFilename`) and also its parts
// (`sanitize`, `filename`), so a query for either matches. Matching is case-insensitive.

export interface LexicalDoc {
  readonly id: string;
  readonly text: string;
}

export interface Bm25Index {
  readonly docs: readonly LexicalDoc[];
  readonly tokens: readonly (readonly string[])[];
  readonly df: ReadonlyMap<string, number>;
  readonly avgdl: number;
  readonly k1: number;
  readonly b: number;
}

export interface RankedHit {
  readonly id: string;
  readonly score: number;
}

/** Tokenize text into lowercase identifier wholes and their camelCase/snake parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (raw.length === 0) continue;
    const whole = raw.toLowerCase();
    out.push(whole);
    for (const part of raw.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const p = part.toLowerCase();
      if (p.length > 0 && p !== whole) out.push(p);
    }
  }
  return out;
}

/** Build a BM25 index over the documents. */
export function buildBm25(
  docs: readonly LexicalDoc[],
  options: { k1?: number; b?: number } = {},
): Bm25Index {
  const tokens = docs.map((d) => tokenize(d.text));
  const df = new Map<string, number>();
  for (const toks of tokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const totalLen = tokens.reduce((n, t) => n + t.length, 0);
  return {
    docs,
    tokens,
    df,
    avgdl: docs.length === 0 ? 0 : totalLen / docs.length,
    k1: options.k1 ?? 1.2,
    b: options.b ?? 0.75,
  };
}

/**
 * Rank documents for a query by BM25. Documents with no matching term are omitted.
 * Ties keep document order (stable), so the ranking is deterministic.
 */
export function bm25Search(
  index: Bm25Index,
  query: string,
  limit = 10,
  options: { minRelative?: number } = {},
): RankedHit[] {
  const terms = [...new Set(tokenize(query))];
  const n = index.docs.length;
  const scored: { id: string; score: number; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const toks = index.tokens[i] ?? [];
    const dl = toks.length;
    let score = 0;
    for (const term of terms) {
      const tf = toks.filter((t) => t === term).length;
      if (tf === 0) continue;
      const dfTerm = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - dfTerm + 0.5) / (dfTerm + 0.5));
      const norm = index.k1 * (1 - index.b + (index.b * dl) / (index.avgdl || 1));
      score += idf * ((tf * (index.k1 + 1)) / (tf + norm));
    }
    if (score > 0) scored.push({ id: index.docs[i]?.id ?? "", score, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  // Relevance cutoff: a hit must reach `minRelative` of the best score. Without it, a document
  // that matches one generic token ("a", "value") counts as a lexical hit and crowds out the
  // real match in the fusion.
  const top = scored[0]?.score ?? 0;
  const floor = top * (options.minRelative ?? 0);
  return scored
    .filter((h) => h.score >= floor)
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Reciprocal rank fusion: each list contributes 1 / (k + rank) to every item it ranks.
 * Items found by several lists rise. Returns the fused ranking, best first.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k = 60,
): RankedHit[] {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const list of rankings) {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, order++);
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .map(([id, s]) => ({ id, score: s }));
}
