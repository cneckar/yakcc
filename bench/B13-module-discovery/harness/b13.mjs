#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B13: discovery of large modules. Can a composing model's description of a complex
// capability (parse CSV, match a version range, a bounded cache with TTL) find the graph
// root that implements it, and does finding it cost less than writing it?
//
// Pool: corpus definitions with their #1309-style deterministic names (B12 names.mjs). Two
// pools are searched: every definition, and only the large roots (an entry point or shared
// core whose closure is at least LARGE_NODES AST nodes). Search is dense + BM25 over the
// rendered names, fused by reciprocal rank, optionally with model-written descriptions.
//
// Leverage: what writing the target would cost (its closure's source, in output tokens)
// against what finding it costs (the request and a confirm pick, in output tokens, plus
// reading K candidate names, in input tokens), both priced at a model's list price.
//
//   node harness/b13.mjs [--queries queries/seed.json] [--out results/eval-seed.json]
//     [--descriptions ../B12-need-to-code/results/descriptions.json] [--k 5]
// Offline: the local embedding model. No model API calls.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { denseRanking, embedder } from "../../B12-need-to-code/harness/eval.mjs";
import { isTarget, rrf } from "../../B12-need-to-code/harness/match.mjs";
import { auroc } from "../../B12-need-to-code/harness/metrics.mjs";
import { PRICES } from "../../B12-need-to-code/harness/model.mjs";
import { buildNames, renderName } from "../../B12-need-to-code/harness/names.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");
const repo = resolve(benchDir, "..", "..");

/** A large root: an entry point, or a core shared by two or more callers, with a big closure. */
export const LARGE_NODES = 400;
export function isLargeRoot(r) {
  return (r.exported || r.fanIn >= 2) && r.closureNodes >= LARGE_NODES;
}

/** Tokens, estimated as characters / 4 (a budget bound, not a tokenizer). */
export const est = (chars) => Math.ceil(chars / 4);

/** Output tokens a confirm pick writes (a number and a few words). */
export const CONFIRM_OUTPUT = 60;

/**
 * Leverage of reusing a target found by search: the cost of writing it divided by the cost
 * of finding it, at a model's (input, output) price per token. Above 1, reuse is cheaper.
 */
export function leverage({ writeTokens, requestTokens, confirmInputTokens }, [pin, pout]) {
  const write = writeTokens * pout;
  const find = (requestTokens + CONFIRM_OUTPUT) * pout + confirmInputTokens * pin;
  return find === 0 ? null : write / find;
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const K = Number(arg("k", "5"));
  const queriesFile = resolve(arg("queries", join(benchDir, "queries", "seed.json")));
  const out = resolve(arg("out", join(benchDir, "results", "eval-seed.json")));
  const descFile = arg("descriptions", null);
  const descriptions = descFile
    ? JSON.parse(readFileSync(resolve(descFile), "utf8")).descriptions
    : {};
  const { set, queries } = JSON.parse(readFileSync(queriesFile, "utf8"));

  const records = Object.values(buildNames(corpusDefinitions()));
  const textOf = (r) =>
    [renderName(r), ...(descriptions[r.id] && !r.doc ? [descriptions[r.id]] : [])].join("\n");
  const pools = {
    all: records,
    "large roots": records.filter(isLargeRoot),
  };
  const emb = await embedder();
  const lexical = await import(pathToFileURL(join(repo, "packages/registry/dist/lexical.js")).href);
  const index = {};
  for (const [name, pool] of Object.entries(pools)) {
    const texts = pool.map(textOf);
    const vecs = [];
    for (const t of texts) vecs.push(await emb.embed(t));
    index[name] = {
      pool,
      texts,
      vecs,
      ids: pool.map((r) => r.id),
      bm25: lexical.buildBm25(pool.map((r, i) => ({ id: r.id, text: texts[i] }))),
      byId: new Map(pool.map((r, i) => [r.id, { r, text: texts[i] }])),
    };
  }

  const rows = {};
  for (const [name, ix] of Object.entries(index)) {
    rows[name] = [];
    for (const q of queries) {
      const qv = await emb.embed(q.need);
      const dense = denseRanking(qv, ix.vecs, ix.ids);
      const sim = new Map(dense.map((x) => [x.id, x.s]));
      const lex = lexical.bm25Search(ix.bm25, q.need, 200, { minRelative: 0.2 }).map((h) => h.id);
      const ranked = rrf([dense.slice(0, 200).map((x) => x.id), lex]);
      const rankOf = ranked.findIndex((id) => isTarget(ix.byId.get(id).r, q));
      const target = records.find((r) => isTarget(r, q));
      const shown = ranked.slice(0, K).map((id) => ix.byId.get(id));
      const usage = {
        writeTokens: target ? est(target.closureChars) : 0,
        requestTokens: est(q.need.length),
        confirmInputTokens: est(shown.reduce((n, s) => n + s.text.length, 0)),
      };
      rows[name].push({
        id: q.id,
        positive: q.targets.length > 0,
        targetInPool: q.targets.length > 0 ? ix.pool.some((r) => isTarget(r, q)) : null,
        targetRank: rankOf < 0 ? null : rankOf + 1,
        top3: ranked.slice(0, 3),
        topK: ranked.slice(0, 10),
        topSimilarity: sim.get(ranked[0]) ?? null,
        top1Correct: rankOf === 0,
        ...usage,
        leverage: Object.fromEntries(
          Object.entries(PRICES).map(([m, p]) => [m, q.targets.length ? leverage(usage, p) : null]),
        ),
      });
    }
  }
  emb.save();

  const summarize = (rs) => {
    const pos = rs.filter((r) => r.positive);
    const at = (k) =>
      pos.filter((r) => r.targetRank !== null && r.targetRank <= k).length / pos.length;
    const found = pos.filter((r) => r.targetRank !== null && r.targetRank <= K);
    return {
      positives: pos.length,
      negatives: rs.length - pos.length,
      targetInPool: pos.filter((r) => r.targetInPool).length / pos.length,
      top1: at(1),
      top5: at(5),
      top10: at(10),
      mrr: pos.reduce((s, r) => s + (r.targetRank ? 1 / r.targetRank : 0), 0) / pos.length,
      // Does the top similarity separate a right top-1 from a wrong one (negatives included)?
      auroc: auroc(
        rs.map((r) => r.topSimilarity ?? 0),
        rs.map((r) => r.top1Correct),
      ),
      medianWriteTokens: median(pos.map((r) => r.writeTokens)),
      medianLeverage: Object.fromEntries(
        Object.keys(PRICES).map((m) => [m, median(pos.map((r) => r.leverage[m]))]),
      ),
      // Found within the K shown, and cheaper to reuse than to write (Haiku prices).
      foundAndPays:
        found.filter((r) => (r.leverage["claude-haiku-5-5"] ?? 0) > 1).length / pos.length,
    };
  };
  const result = {
    set,
    k: K,
    largeNodes: LARGE_NODES,
    descriptions: Object.keys(descriptions).length,
    pools: Object.fromEntries(Object.entries(pools).map(([n, p]) => [n, p.length])),
    summary: Object.fromEntries(Object.entries(rows).map(([n, rs]) => [n, summarize(rs)])),
    rows,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const f = (x) => (x === null || x === undefined ? "–" : x >= 10 ? x.toFixed(0) : x.toFixed(2));
  console.log(`set=${set} queries=${queries.length} pools=${JSON.stringify(result.pools)} K=${K}`);
  console.log(
    "pool          in-pool top1  top5  top10 MRR   AUROC write(median) leverage(haiku/opus) found&pays",
  );
  for (const [n, s] of Object.entries(result.summary))
    console.log(
      `${n.padEnd(13)} ${f(s.targetInPool)}    ${f(s.top1)}  ${f(s.top5)}  ${f(s.top10)}  ${f(s.mrr)}  ${f(s.auroc)}  ${String(s.medianWriteTokens).padEnd(12)} ${f(s.medianLeverage["claude-haiku-5-5"])}/${f(s.medianLeverage["claude-opus-5-5"])}          ${f(s.foundAndPays)}`,
    );
  console.log(`wrote ${relative(benchDir, out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
