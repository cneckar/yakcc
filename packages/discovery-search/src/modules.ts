// SPDX-License-Identifier: Apache-2.0
// @decision DEC-DISCOVERY-MODULES-001
// @title Module discovery: hybrid search over large graph roots, for a composing model to confirm
// @status decided (lane:reuse; evidence in bench/B12-need-to-code and bench/B13-module-discovery)
// @rationale
//   A composing model should reuse whole modules (a CSV parser, a version-range matcher), not
//   look up small helpers: B12 measured that finding a ~60-token helper costs more than writing
//   it, while B13 measured a median 6.4x saving for large roots with real tokens. B13 also
//   measured how to find them: dense embeddings over the roots' descriptive names and one-line
//   descriptions, fused with BM25 by reciprocal rank, over large roots only (top-5 0.82 on
//   needs written from READMEs). The decision stays with the composing model: it reads the top
//   few candidates and picks one or none (B13: 0.95 right when the target was shown; "none"
//   every time it was not). Scores are returned for ordering only; B11 showed retrieval
//   scores do not separate relevant from irrelevant, so no threshold accepts a module here.
//
//   Browser-safe and dependency-free like the rest of this kit: the index is plain data
//   (built offline by scripts/build-module-index.mjs), and the caller supplies the query
//   embedding from the same model the index was built with.
//
//   BM25 is a small local copy of the registry's lexical channel (DEC-RETRIEVAL-LEXICAL-001,
//   packages/registry/src/lexical.ts): importing @yakcc/registry would pull node-only
//   dependencies into this browser-safe kit. Same tokenization, same k1 and b, same 20%
//   relevance floor and the same reciprocal-rank constant (60).

/** One searchable module root in a module index. */
export interface ModuleEntry {
  /** Stable id: "<sourceFile>#<name>@<line>". */
  readonly id: string;
  readonly pkg: string;
  readonly sourceFile: string;
  readonly name: string;
  /** The text the entry is searched by: its descriptive name, plus a description if any. */
  readonly text: string;
  /** Estimated tokens to write the root and its closure (source characters / 4). */
  readonly closureTokens: number;
  /** Ids of the definitions in the root's closure, the root first. */
  readonly closure: readonly string[];
}

/** A module index: entries, their vectors, and the model that produced the vectors. */
export interface ModuleIndex {
  readonly version: number;
  /** Embedding model id; a query must be embedded with the same model. */
  readonly model: string;
  readonly entries: readonly ModuleEntry[];
  /** One vector per entry, in entry order. */
  readonly vectors: readonly Float32Array[];
  /** Source text by definition id, for every definition in some entry's closure. */
  readonly sources: Readonly<Record<string, string>>;
}

export interface ModuleHit {
  readonly entry: ModuleEntry;
  /** Rank fusion score: for ordering only, not a confidence. */
  readonly score: number;
  /** Which channels found it. */
  readonly channels: readonly ("dense" | "lexical")[];
}

/** Tokenize as the registry's lexical channel does: identifier wholes plus their parts. */
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

/** BM25 ranking of entry indexes for a query (k1 1.2, b 0.75, hits below 20% of the best dropped). */
export function bm25Rank(texts: readonly string[], query: string): number[] {
  const docs = texts.map(tokenize);
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = n === 0 ? 0 : docs.reduce((s, d) => s + d.length, 0) / n;
  const terms = [...new Set(tokenize(query))];
  const scored: { i: number; s: number }[] = [];
  docs.forEach((d, i) => {
    let s = 0;
    for (const term of terms) {
      const tf = d.filter((t) => t === term).length;
      if (tf === 0) continue;
      const dfT = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
      s += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + (0.75 * d.length) / (avgdl || 1))));
    }
    if (s > 0) scored.push({ i, s });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const floor = (scored[0]?.s ?? 0) * 0.2;
  return scored.filter((x) => x.s >= floor).map((x) => x.i);
}

/** Dense ranking of entry indexes by dot product (vectors are unit-normalized). */
export function denseRank(query: Float32Array, vectors: readonly Float32Array[]): number[] {
  return vectors
    .map((v, i) => {
      let dot = 0;
      for (let j = 0; j < query.length; j++) dot += (query[j] ?? 0) * (v[j] ?? 0);
      return { i, dot };
    })
    .sort((a, b) => b.dot - a.dot || a.i - b.i)
    .map((x) => x.i);
}

/**
 * The top `k` modules for a need: dense (the query vector) and BM25 (the query text) over the
 * entries' text, fused by reciprocal rank (constant 60, the registry's), best first.
 */
export function searchModules(
  index: ModuleIndex,
  queryVector: Float32Array,
  queryText: string,
  options: { readonly k?: number; readonly depth?: number } = {},
): ModuleHit[] {
  const k = options.k ?? 5;
  const depth = options.depth ?? 200;
  const dense = denseRank(queryVector, index.vectors).slice(0, depth);
  const lexical = bm25Rank(
    index.entries.map((e) => e.text),
    queryText,
  ).slice(0, depth);
  const score = new Map<number, number>();
  const channels = new Map<number, Set<"dense" | "lexical">>();
  const add = (list: number[], ch: "dense" | "lexical") =>
    list.forEach((i, rank) => {
      score.set(i, (score.get(i) ?? 0) + 1 / (60 + rank + 1));
      if (!channels.has(i)) channels.set(i, new Set());
      channels.get(i)?.add(ch);
    });
  add(dense, "dense");
  add(lexical, "lexical");
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k)
    .map(([i, s]) => ({
      entry: index.entries[i] as ModuleEntry,
      score: s,
      channels: [...(channels.get(i) ?? [])].sort(),
    }));
}

/** A module's source: the root's definition and the rest of its closure, root first. */
export function moduleSource(
  index: ModuleIndex,
  id: string,
): { id: string; source: string }[] | null {
  const entry = index.entries.find((e) => e.id === id);
  if (entry === undefined) return null;
  return entry.closure
    .filter((cid) => index.sources[cid] !== undefined)
    .map((cid) => ({ id: cid, source: index.sources[cid] as string }));
}

/** Parse a serialized index (vectors as arrays of numbers) into a ModuleIndex. */
export function parseModuleIndex(json: unknown): ModuleIndex {
  const o = json as {
    version?: unknown;
    model?: unknown;
    entries?: unknown;
    vectors?: unknown;
    sources?: unknown;
  };
  if (typeof o?.model !== "string" || !Array.isArray(o.entries) || !Array.isArray(o.vectors))
    throw new TypeError("not a module index: needs model, entries and vectors");
  if (o.entries.length !== o.vectors.length)
    throw new TypeError("module index: entries and vectors differ in length");
  return {
    version: typeof o.version === "number" ? o.version : 1,
    model: o.model,
    entries: o.entries as ModuleEntry[],
    vectors: (o.vectors as number[][]).map((v) => Float32Array.from(v)),
    sources: (o.sources ?? {}) as Record<string, string>,
  };
}
