// SPDX-License-Identifier: MIT
// From a query card (an LLM's description of the function it needs) to a ranked list of
// corpus definitions, in stages:
//   1. recall: text channels (dense embedding similarity, BM25) fused by reciprocal rank,
//      optionally capped per source package and reordered by signature compatibility;
//   2. execution: each callable candidate in the shortlist is run on the query's example
//      calls, and candidates that reproduce every example move to the front;
//   3. decision: whether to reuse the top candidate.
// Pure functions over precomputed scores, so every stage can be measured on its own.
import { callTagged, resolveCallable, taggedEqual } from "./sandbox.mjs";

/** Parse "pkg:file#name" ("*" as file = any file in the package). */
export function parseTarget(t) {
  const [pkg, rest] = t.split(":");
  const [file, name] = rest.split("#");
  return { pkg, file, name };
}

/** Whether a card is one of a query's acceptable implementations. */
export function isTarget(card, query) {
  return query.targets.some((t) => {
    const { pkg, file, name } = parseTarget(t);
    if (card.pkg !== pkg) return false;
    if (file !== "*" && card.sourceFile !== `${pkg}/${file}`) {
      // A class whose span holds the target method covers it (see B11's covers()).
      return false;
    }
    return card.name === name;
  });
}

/** Run a query's examples on a card's callable. */
export function runExamples(card, examples) {
  if (!card.callable) return { executable: false, reason: card.reason };
  if (examples.length === 0) return { executable: false, reason: "query has no examples" };
  const c = resolveCallable(card.sourceFile, card.name);
  if (!c.callable) return { executable: false, reason: c.reason };
  let passed = 0;
  for (const ex of examples) {
    const r = callTagged(c, ex.args);
    if (
      ex.throws === true ? !r.ok && r.error !== "timeout" : r.ok && taggedEqual(r.value, ex.returns)
    )
      passed++;
  }
  return { executable: true, passed, total: examples.length };
}

/** Reciprocal rank fusion over ranked id lists (k = 60, as the registry uses). */
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists)
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}

/** Keep at most `perPackage` ids from each package, in order. */
export function capPerPackage(ids, pkgOf, perPackage) {
  const seen = new Map();
  return ids.filter((id) => {
    const p = pkgOf(id);
    const n = seen.get(p) ?? 0;
    if (n >= perPackage) return false;
    seen.set(p, n + 1);
    return true;
  });
}

const TYPE_ALIASES = [
  [/^(string|text)$/i, "string"],
  [/^(number|int|integer|float)$/i, "number"],
  [/^bool(ean)?$/i, "boolean"],
  [/\[\]$|^array/i, "array"],
  [/^date$/i, "date"],
  [/^(uint8array|bytes)$/i, "bytes"],
  [/^map</i, "map"],
  [/^set</i, "set"],
  [/=>/, "function"],
  [/^(object|record<.*)$/i, "object"],
];

/** A query type written by a model, as one of the sandbox's type names (or null: unknown). */
export function normalizeType(t) {
  const s = String(t).trim();
  for (const [re, name] of TYPE_ALIASES) if (re.test(s)) return name;
  return null;
}

/**
 * Signature compatibility of a card with a query, in [0, 1], or null when nothing is known.
 * Arity: the card must accept at least as many parameters as the query passes. Types: the
 * share of query input types (and the output type) that the card was observed to take.
 */
export function signatureScore(card, query) {
  if (query.inputs.length === 0 || card.params === undefined) return null;
  const n = Math.max(card.params.length, card.arity ?? 0);
  if (n < query.inputs.length) return 0;
  const arity = n === query.inputs.length ? 1 : 0.75;
  const obs = card.observed;
  if (!obs || obs.returns.length === 0) return arity * 0.5;
  let hits = 0;
  let known = 0;
  query.inputs.forEach((p, i) => {
    const t = normalizeType(p.type);
    if (t === null || obs.params[i] === undefined) return;
    known++;
    if (obs.params[i].includes(t)) hits++;
  });
  const out = (query.output ?? "").split("|").map(normalizeType).filter(Boolean);
  if (out.length > 0) {
    known++;
    if (out.some((t) => obs.returns.includes(t))) hits++;
  }
  return arity * (known === 0 ? 0.5 : 0.5 + 0.5 * (hits / known));
}

/**
 * Stage 2: reorder a shortlist by execution. Tiers: every example reproduced; not
 * executable (unknown); some examples; none. Stage-1 order within a tier.
 */
export function executionRerank(shortlist, cardOf, query) {
  const results = new Map();
  for (const id of shortlist) results.set(id, runExamples(cardOf(id), query.examples));
  const tier = (id) => {
    const r = results.get(id);
    if (!r.executable) return 1;
    if (r.passed === r.total) return 0;
    return r.passed > 0 ? 2 : 3;
  };
  const ordered = shortlist
    .map((id, i) => ({ id, i, t: tier(id) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.id);
  return { ordered, results };
}

/**
 * Stage 3: reuse the top candidate only when it reproduced every example and the query gave
 * at least `minExamples` of them. Everything else is a gap (write it, or look further).
 */
export function decide(topId, results, query, minExamples = 2) {
  const r = topId === undefined ? undefined : results?.get(topId);
  const accept =
    r?.executable === true && r.passed === r.total && query.examples.length >= minExamples;
  return {
    accept,
    reason: accept ? "examples-reproduced" : r?.executable ? "examples-failed" : "unverified",
  };
}
