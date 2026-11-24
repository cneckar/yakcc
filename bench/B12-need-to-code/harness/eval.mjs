#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B12: from an LLM's description of a needed function to the corpus code that implements it.
// Runs every query through a ladder of configurations, each adding one stage, and reports
// recall, ranking, the reuse decision, and whether the confidence separates right from wrong.
//
//   node harness/eval.mjs [--queries queries/seed.json] [--out results/eval-seed.json]
//                         [--descriptions results/descriptions.json] [--no-exec-all] [--rebuild-cards]
// Offline: the local embedding model (cached after the first download) and the vm sandbox.
// No model API calls.
process.env.TZ = "UTC"; // date examples are written in UTC

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { buildCard, cardText } from "./cards.mjs";
import { capPerPackage, decide, executionRerank, isTarget, rrf, signatureScore } from "./match.mjs";
import { auroc, summarizeConfig } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");
const repo = resolve(benchDir, "..", "..");
const CACHE = join(benchDir, ".cache");
const dist = (p) => pathToFileURL(join(repo, p)).href;

/** Shortlist size after stage 1. */
export const SHORTLIST = 50;
/** Per-package cap in the capped configurations. */
export const PER_PACKAGE = 5;

/** The text a query is embedded and searched by. */
export function queryText(q, variant = "plain") {
  const parts = [q.need];
  if (q.inputs.length > 0)
    parts.push(`takes ${q.inputs.map((p) => `${p.name}: ${p.type}`).join(", ")}`);
  if (q.output) parts.push(`returns ${q.output}`);
  if (variant === "examples")
    for (const e of q.examples.slice(0, 3))
      parts.push(
        `f(${e.args.map((a) => JSON.stringify(a)).join(", ")}) = ${e.throws ? "throws" : JSON.stringify(e.returns)}`,
      );
  return parts.join("\n");
}

export async function embedder() {
  const contracts = await import(dist("packages/contracts/dist/index.js"));
  const provider = contracts.createLocalEmbeddingProvider();
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `embeddings-${provider.modelId.replace(/\W+/g, "_")}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let dirty = 0;
  const embed = async (text) => {
    const key = createHash("sha256").update(text).digest("hex");
    if (!cache[key]) {
      cache[key] = Array.from(await provider.embed(text));
      dirty++;
    }
    return cache[key];
  };
  const save = () => {
    if (dirty > 0) writeFileSync(file, JSON.stringify(cache));
  };
  return { modelId: provider.modelId, embed, save };
}

/** The canonical spec text the registry embeds for a definition (production path), or null. */
async function specTexts(defs) {
  const contracts = await import(dist("packages/contracts/dist/index.js"));
  const { staticExtract } = await import(dist("packages/shave/dist/intent/static-extract.js"));
  const { validateIntentCard } = await import(
    dist("packages/shave/dist/intent/validate-intent-card.js")
  );
  const { specFromIntent } = await import(dist("packages/shave/dist/persist/spec-from-intent.js"));
  return defs.map((d) => {
    try {
      const card = validateIntentCard(
        staticExtract(d.text, {
          sourceHash: createHash("sha256").update(d.text).digest("hex"),
          modelVersion: "static",
          promptVersion: "static",
          extractedAt: "1970-01-01T00:00:00.000Z",
        }),
      );
      return contracts.canonicalizeText(specFromIntent(card, contracts.canonicalAstHash(d.text)));
    } catch {
      return null;
    }
  });
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function denseRanking(qvec, vecs, ids) {
  return ids
    .map((id, i) => ({ id, s: vecs[i] ? dot(qvec, vecs[i]) : Number.NEGATIVE_INFINITY }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const queriesFile = resolve(arg("queries", join(benchDir, "queries", "seed.json")));
  const out = resolve(arg("out", join(benchDir, "results", "eval-seed.json")));
  const { set, queries } = JSON.parse(readFileSync(queriesFile, "utf8"));
  const t0 = Date.now();

  // Library side.
  const defs = corpusDefinitions();
  const cardsFile = join(CACHE, "cards.json");
  let cards;
  if (!argv.includes("--rebuild-cards") && existsSync(cardsFile))
    cards = JSON.parse(readFileSync(cardsFile, "utf8"));
  else {
    cards = defs.map(buildCard);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cardsFile, JSON.stringify(cards));
  }
  const ids = cards.map((c) => c.id);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const cardOf = (id) => byId.get(id);
  const pkgOf = (id) => byId.get(id).pkg;
  const tCards = Date.now();

  const emb = await embedder();
  const lexical = await import(dist("packages/registry/dist/lexical.js"));
  const specs = await specTexts(defs);
  // Model-written descriptions (harness/describe-atoms.mjs) stand in for a missing JSDoc.
  const descFile = arg("descriptions", null);
  const descriptions = descFile
    ? JSON.parse(readFileSync(resolve(descFile), "utf8")).descriptions
    : {};
  const withDesc = (c) => (c.doc || !descriptions[c.id] ? c : { ...c, doc: descriptions[c.id] });
  // --card-text names: index the deterministic names (harness/names.mjs, the #1309
  // prototype) instead of the card text. --fields picks which name fields to render.
  const cardTextSource = arg("card-text", "card");
  let nameText = null;
  if (cardTextSource === "names") {
    const { buildNames, renderName, FIELDS } = await import("./names.mjs");
    const fields = arg("fields", FIELDS.join(",")).split(",");
    const records = buildNames(defs);
    nameText = (c) => {
      const r = records[c.id];
      const desc = descriptions[c.id];
      return [renderName(r, fields), ...(desc && !r.doc ? [desc] : [])].join("\n");
    };
  } else if (cardTextSource !== "card") throw new Error(`unknown --card-text ${cardTextSource}`);
  const exampleLines = (c) =>
    cardText({ ...c, doc: null, params: c.params, observed: null }, "card+examples")
      .split("\n")
      .slice(1);
  const texts = {
    spec: specs,
    card: cards.map((c) => (nameText ? nameText(c) : cardText(withDesc(c), "card"))),
    cardEx: cards.map((c) =>
      nameText
        ? [nameText(c), ...exampleLines(c)].join("\n")
        : cardText(withDesc(c), "card+examples"),
    ),
  };
  const vecs = {};
  for (const [k, list] of Object.entries(texts)) {
    vecs[k] = [];
    for (const t of list) vecs[k].push(t === null ? null : await emb.embed(t));
  }
  const bm25 = {};
  for (const [k, list] of Object.entries(texts))
    bm25[k] = lexical.buildBm25(
      list.map((t, i) => ({ id: ids[i], text: t ?? "" })).filter((d) => d.text !== ""),
    );
  const lex = (k, text) =>
    lexical.bm25Search(bm25[k], text, 4 * SHORTLIST, { minRelative: 0.2 }).map((h) => h.id);
  const tIndex = Date.now();

  // The configurations. Stage 1 only: each adds one thing to the one before. Then execution
  // on the best stage-1 shortlist, and two variants of what precedes it. exec-all stands apart.
  const CONFIGS = [
    { name: "registry-spec", note: "production path: canonical spec text, dense + BM25" },
    { name: "card-dense", note: "card text, dense only" },
    { name: "card-hybrid", note: "card text, dense + BM25" },
    { name: "card-hybrid+examples", note: "card and query texts include example calls" },
    {
      name: "+execution",
      note: "card-hybrid+examples shortlist, reordered by reproducing the examples",
    },
    {
      name: "+execution (package cap)",
      note: `as +execution, at most ${PER_PACKAGE} per package in the shortlist`,
    },
    {
      name: "+execution (signature)",
      note: "as +execution, shortlist first reordered by signature compatibility",
    },
  ];
  if (!argv.includes("--no-exec-all"))
    CONFIGS.push({
      name: "exec-all",
      note: "no retrieval: run the examples on every callable card",
    });
  const rows = Object.fromEntries(CONFIGS.map((c) => [c.name, []]));
  const timing = {};
  for (const q of queries) {
    const qPlain = await emb.embed(queryText(q, "plain"));
    const qEx = await emb.embed(queryText(q, "examples"));
    const denseSpec = denseRanking(qPlain, vecs.spec, ids);
    const denseCard = denseRanking(qPlain, vecs.card, ids);
    const denseCardEx = denseRanking(qEx, vecs.cardEx, ids);
    const sim = {
      spec: new Map(denseSpec.map((x) => [x.id, x.s])),
      card: new Map(denseCard.map((x) => [x.id, x.s])),
      cardEx: new Map(denseCardEx.map((x) => [x.id, x.s])),
    };
    const top = (list) => list.slice(0, 4 * SHORTLIST).map((x) => x.id);
    const lists = {
      "registry-spec": { ids: rrf([top(denseSpec), lex("spec", queryText(q))]), sim: sim.spec },
      "card-dense": { ids: top(denseCard), sim: sim.card },
      "card-hybrid": { ids: rrf([top(denseCard), lex("card", queryText(q))]), sim: sim.card },
      "card-hybrid+examples": {
        ids: rrf([top(denseCardEx), lex("cardEx", queryText(q, "examples"))]),
        sim: sim.cardEx,
      },
    };
    const hybrid = lists["card-hybrid+examples"].ids.slice(0, SHORTLIST);
    const capped = capPerPackage(lists["card-hybrid+examples"].ids, pkgOf, PER_PACKAGE).slice(
      0,
      SHORTLIST,
    );
    const sig = hybrid
      .map((id, i) => ({ id, i, s: signatureScore(cardOf(id), q) }))
      .sort((a, b) => (b.s ?? 0.5) - (a.s ?? 0.5) || a.i - b.i)
      .map((x) => x.id);
    for (const [name, shortlist] of [
      ["+execution", hybrid],
      ["+execution (package cap)", capped],
      ["+execution (signature)", sig],
    ]) {
      const te = Date.now();
      const exec = executionRerank(shortlist, cardOf, q);
      timing[name] = (timing[name] ?? 0) + (Date.now() - te);
      lists[name] = { ids: exec.ordered, sim: sim.cardEx, exec: exec.results, stage1: shortlist };
    }
    if (rows["exec-all"]) {
      const ta = Date.now();
      const pool = q.examples.length === 0 ? [] : ids.filter((id) => cardOf(id).callable);
      const all = executionRerank(pool, cardOf, q);
      timing["exec-all"] = (timing["exec-all"] ?? 0) + (Date.now() - ta);
      const passing = all.ordered.filter((id) => {
        const r = all.results.get(id);
        return r.executable && r.passed === r.total;
      });
      lists["exec-all"] = { ids: passing, sim: sim.cardEx, exec: all.results, stage1: pool };
    }

    for (const cfg of CONFIGS) {
      const L = lists[cfg.name];
      const final = L.ids.slice(0, SHORTLIST);
      const rankOf = (list) => {
        const i = list.findIndex((id) => isTarget(cardOf(id), q));
        return i < 0 ? null : i + 1;
      };
      const d = decide(final[0], L.exec, q);
      // How many distinct candidates reproduced every example: more than one is ambiguous.
      const passingCount = L.exec
        ? final.filter((id) => {
            const r = L.exec.get(id);
            return r?.executable && r.passed === r.total;
          }).length
        : 0;
      const topExec = L.exec?.get(final[0]);
      const tier =
        topExec === undefined
          ? null
          : !topExec.executable
            ? 1
            : topExec.passed === topExec.total
              ? 0
              : 2;
      // Confidence in the top candidate: its similarity, lifted by execution tier when known.
      const confidence =
        (final[0] === undefined ? 0 : (L.sim.get(final[0]) ?? 0)) +
        (tier === 0 ? 2 : tier === 1 ? 1 : 0);
      const alternatives = L.exec
        ? final.filter((id) => {
            const r = L.exec.get(id);
            return r?.executable && r.passed === r.total && !isTarget(cardOf(id), q);
          })
        : [];
      rows[cfg.name].push({
        id: q.id,
        positive: q.targets.length > 0,
        targetRank: rankOf(final),
        shortlistRank: rankOf((L.stage1 ?? L.ids).slice(0, L.stage1 ? undefined : SHORTLIST)),
        top3: final.slice(0, 3),
        // The first ten, for the confirm step (harness/confirm.mjs), on text-only configs.
        ...(L.exec ? {} : { top10: final.slice(0, 10) }),
        top1Correct: final[0] !== undefined && isTarget(cardOf(final[0]), q),
        confidence,
        accept: d.accept,
        acceptUnique: d.accept && passingCount === 1,
        passingCount,
        decision: d.reason,
        alternatives: alternatives.slice(0, 5),
      });
    }
  }
  emb.save();

  const summary = Object.fromEntries(
    CONFIGS.map((c) => [
      c.name,
      { note: c.note, ...summarizeConfig(rows[c.name]), ms: timing[c.name] },
    ]),
  );
  const result = {
    set,
    queries: queries.length,
    positives: queries.filter((q) => q.targets.length > 0).length,
    negatives: queries.filter((q) => q.targets.length === 0).length,
    embeddingModel: emb.modelId,
    descriptions: descFile ? Object.keys(descriptions).length : 0,
    cardText: cardTextSource,
    fields: cardTextSource === "names" ? arg("fields", "all") : null,
    shortlist: SHORTLIST,
    corpus: {
      definitions: cards.length,
      callable: cards.filter((c) => c.callable).length,
      withExamples: cards.filter((c) => c.examples?.length > 0).length,
      withDoc: cards.filter((c) => c.doc).length,
      withSpec: specs.filter(Boolean).length,
    },
    // Execution times include loading each corpus module the first time it is called, so the
    // first configuration to execute pays for loading; compare them with that in mind.
    seconds: {
      cards: (tCards - t0) / 1000,
      index: (tIndex - tCards) / 1000,
      total: (Date.now() - t0) / 1000,
    },
    summary,
    rows,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const fmt = (x) =>
    x === null || x === undefined ? "–" : typeof x === "number" ? x.toFixed(2) : String(x);
  console.log(
    `set=${set} queries=${queries.length} (positives ${result.positives}, negatives ${result.negatives})`,
  );
  console.log(
    "config                     R@1   R@5   R@50  MRR   short  accept(prec/rec/false)  unique(prec/rec/false)  AUROC  ms",
  );
  for (const [name, s] of Object.entries(summary))
    console.log(
      `${name.padEnd(26)} ${fmt(s.recallAt1)}  ${fmt(s.recallAt5)}  ${fmt(s.recallAt50)}  ${fmt(s.mrr)}  ${fmt(s.shortlistRecall)}   ${fmt(s.acceptPrecision)}/${fmt(s.acceptRecall)}/${fmt(s.falseAcceptRate)}          ${fmt(s.uniquePrecision)}/${fmt(s.uniqueRecall)}/${fmt(s.uniqueFalseAccept)}          ${fmt(s.auroc)}   ${s.ms ?? ""}`,
    );
  console.log(`wrote ${relative(benchDir, out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { auroc };
