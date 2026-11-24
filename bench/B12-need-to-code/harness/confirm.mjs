#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The "library shows, the model confirms" step. The composing model sends only a
// description of what it needs (no code, no examples). The library searches (card text,
// dense + BM25), shows the top K candidates with their observed behavior (example calls from
// the library cards), and the model picks one or says none fits. The model reads; it does
// not write code or invent examples.
//
// It reports, per request style, what the model writes and reads (tokens), and how often
// the pick is right, how often it reuses something wrong, and how often it correctly says
// none.
//
//   node harness/confirm.mjs --dry-run [--queries ...] [--eval results/eval-seed.json] [--k 5]
//   CLAUDE_API_KEY=... node harness/confirm.mjs [--model id] [--k 5] [--out results/confirm-seed.json]
// The eval file supplies each query's text-only shortlist (the card-hybrid configuration,
// built from the description alone). Needs approved spend unless --dry-run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isTarget } from "./match.mjs";
import { DEFAULT_MODEL, estimateCost, extractJson, mapLimit, modelClient } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");

export const SYSTEM =
  'You are composing a program and need one function. A code library has shown you candidates, each with example calls observed by running it. Pick the candidate whose behavior matches what you need, judging by the examples more than by the name. If none matches, pick 0. Reply with one JSON object: {"pick": number, "reason": "a few words"}.';

const show = (v) => {
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

/** The request a composing model sends: the need and the types, nothing else. */
export function requestText(q) {
  const lines = [q.need];
  if (q.inputs.length > 0)
    lines.push(`Inputs: ${q.inputs.map((p) => `${p.name}: ${p.type}`).join(", ")}`);
  if (q.output) lines.push(`Output: ${q.output}`);
  return lines.join("\n");
}

/** The examples a composing model would add in the examples style (for token accounting). */
export function examplesText(q) {
  return q.examples
    .map(
      (e) =>
        `f(${e.args.map((a) => JSON.stringify(a)).join(", ")}) = ${e.throws ? "throws" : JSON.stringify(e.returns)}`,
    )
    .join("\n");
}

/** One candidate as the model sees it: name, package, doc, and up to three example calls. */
export function candidateBlock(card, n, descriptions = {}) {
  const lines = [`${n}. ${card.name}(${card.params.join(", ")}) from ${card.pkg}`];
  const doc = card.doc ?? descriptions[card.id];
  if (doc) lines.push(`   ${doc}`);
  const ex = card.examples ?? [];
  if (ex.length === 0) lines.push("   (no example calls: it could not be run on sample inputs)");
  for (const e of ex.slice(0, 3))
    lines.push(`   ${card.name}(${e.args.map(show).join(", ")}) = ${show(e.returns)}`);
  return lines.join("\n");
}

/** The confirm prompt: the request, then the numbered candidates. */
export function confirmPrompt(q, cards, descriptions) {
  return [
    "What I need:",
    requestText(q),
    "",
    "Candidates:",
    ...cards.map((c, i) => candidateBlock(c, i + 1, descriptions)),
  ].join("\n");
}

/** Score one pick: right, wrong reuse, correct none, or missed reuse. */
export function scorePick(q, cards, pick) {
  const targetIndex = cards.findIndex((c) => isTarget(c, q));
  const reachable = targetIndex >= 0;
  if (pick === 0) return { outcome: reachable ? "missed" : "correct-none", reachable };
  const chosen = cards[pick - 1];
  if (chosen === undefined) return { outcome: "invalid", reachable };
  return { outcome: isTarget(chosen, q) ? "right" : "wrong-reuse", reachable };
}

/** Summary over scored rows. */
export function summarizePicks(rows) {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  const reused = rows.filter((r) => r.outcome === "right" || r.outcome === "wrong-reuse");
  const count = (list, o) => list.filter((r) => r.outcome === o).length;
  return {
    queries: rows.length,
    targetShown: pos.length === 0 ? null : pos.filter((r) => r.reachable).length / pos.length,
    rightOfPositives: pos.length === 0 ? null : count(pos, "right") / pos.length,
    rightWhenShown: (() => {
      const shown = pos.filter((r) => r.reachable);
      return shown.length === 0 ? null : count(shown, "right") / shown.length;
    })(),
    reusePrecision: reused.length === 0 ? null : count(reused, "right") / reused.length,
    wrongReuseOnNegatives: neg.length === 0 ? null : count(neg, "wrong-reuse") / neg.length,
    correctNoneOnNegatives: neg.length === 0 ? null : count(neg, "correct-none") / neg.length,
    invalid: count(rows, "invalid"),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const K = Number(arg("k", "5"));
  const queriesFile = resolve(arg("queries", join(benchDir, "queries", "seed.json")));
  const evalFile = resolve(arg("eval", join(benchDir, "results", "eval-seed.json")));
  const out = resolve(
    arg("out", join(benchDir, "results", `confirm-${basenameOf(queriesFile)}-k${K}.json`)),
  );
  const descFile = arg("descriptions", null);
  const descriptions = descFile
    ? JSON.parse(readFileSync(resolve(descFile), "utf8")).descriptions
    : {};
  const { set, queries } = JSON.parse(readFileSync(queriesFile, "utf8"));
  const ev = JSON.parse(readFileSync(evalFile, "utf8"));
  const shortlistOf = new Map(ev.rows["card-hybrid"].map((r) => [r.id, r.top10]));
  const cardsFile = join(benchDir, ".cache", "cards.json");
  if (!existsSync(cardsFile))
    throw new Error("run harness/eval.mjs first (it builds .cache/cards.json)");
  const byId = new Map(JSON.parse(readFileSync(cardsFile, "utf8")).map((c) => [c.id, c]));

  const items = queries.map((q) => {
    const ids = shortlistOf.get(q.id);
    if (!ids) throw new Error(`no shortlist for ${q.id} in ${evalFile}; rerun eval.mjs`);
    const cards = ids.slice(0, K).map((id) => byId.get(id));
    return { q, cards, prompt: confirmPrompt(q, cards, descriptions) };
  });

  if (argv.includes("--dry-run")) {
    const chars = items.reduce((n, it) => n + SYSTEM.length + it.prompt.length, 0);
    console.log(
      JSON.stringify(
        {
          set,
          k: K,
          queries: items.length,
          estimate: estimateCost(chars, items.length * 300, items.length),
        },
        null,
        2,
      ),
    );
    console.log(`\nexample prompt (${items[0].q.id}):\n${items[0].prompt}`);
    return;
  }

  const model = arg("model", DEFAULT_MODEL);
  const client = await modelClient({ model, maxTokens: 2000, effort: arg("effort", "medium") });
  const rows = await mapLimit(
    items,
    Number(arg("concurrency", "6")),
    async ({ q, cards, prompt }) => {
      const r = await client.complete(SYSTEM, prompt);
      const parsed = extractJson(r.text);
      // A pick may come back as a number or a numeric string.
      const n = Number(parsed?.pick);
      const pick =
        parsed?.pick !== null && parsed?.pick !== undefined && Number.isInteger(n) ? n : -1;
      const scored =
        pick < 0
          ? { outcome: "invalid", reachable: cards.some((c) => isTarget(c, q)) }
          : scorePick(q, cards, pick);
      return {
        id: q.id,
        positive: q.targets.length > 0,
        pick,
        picked: pick > 0 ? (cards[pick - 1]?.id ?? null) : null,
        reason: parsed?.reason ?? null,
        ...(pick < 0 ? { raw: r.text.slice(0, 500), stopReason: r.stopReason } : {}),
        ...scored,
        // What each request style costs the composing model, in tokens (real tokenizer).
        tokens: {
          request: await client.countTokens(requestText(q)),
          examples: q.examples.length === 0 ? 0 : await client.countTokens(examplesText(q)),
          confirmInput: r.inputTokens,
          confirmOutput: r.outputTokens,
        },
      };
    },
  );
  const mean = (f) => rows.reduce((n, r) => n + f(r), 0) / rows.length;
  const result = {
    set,
    model,
    k: K,
    descriptions: Object.keys(descriptions).length,
    usage: client.usage,
    summary: summarizePicks(rows),
    meanTokens: {
      request: mean((r) => r.tokens.request),
      examples: mean((r) => r.tokens.examples),
      confirmInput: mean((r) => r.tokens.confirmInput),
      confirmOutput: mean((r) => r.tokens.confirmOutput),
    },
    rows,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { summary: result.summary, meanTokens: result.meanTokens, usage: result.usage },
      null,
      2,
    ),
  );
  console.log(`wrote ${relative(benchDir, out)}`);
}

function basenameOf(file) {
  return file
    .split("/")
    .pop()
    .replace(/\.json$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
