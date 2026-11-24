#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The confirm step at module scale: the composing model sends only its need; the library
// shows the top K roots from b13.mjs's search (their rendered #1309-style names, plus a
// description when one exists); the model picks one or none. Records the outcome and the
// real tokens of the turn, so leverage uses measured, not estimated, find costs.
//
//   node harness/confirm-roots.mjs --dry-run [--eval results/eval-seed.json] [--pool "large roots"]
//   CLAUDE_API_KEY=... node harness/confirm-roots.mjs [--model id] [--k 5] [--max-dollars 2]
// Defaults to Haiku 5.5; refuses above the spending cap.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { scorePick, summarizePicks } from "../../B12-need-to-code/harness/confirm.mjs";
import {
  DEFAULT_MAX_DOLLARS,
  DEFAULT_MODEL,
  PRICES,
  checkBudget,
  estimateCost,
  extractJson,
  mapLimit,
  modelClient,
} from "../../B12-need-to-code/harness/model.mjs";
import { buildNames, renderName } from "../../B12-need-to-code/harness/names.mjs";
import { leverage } from "./b13.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");

export const SYSTEM =
  'You are composing a program and need one capability. A code library has shown you candidate modules, each with a structured description of what it is, what it calls, and its properties. Pick the candidate that implements what you need; pick 0 if none does. Reply with one JSON object: {"pick": number, "reason": "a few words"}.';

/** The confirm prompt: the need, then the numbered candidate roots. */
export function rootsPrompt(need, shown) {
  return [
    "What I need:",
    need,
    "",
    "Candidates:",
    ...shown.map((s, i) => `${i + 1}. ${s.text.split("\n").join("\n   ")}`),
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const K = Number(arg("k", "5"));
  const pool = arg("pool", "large roots");
  const evalFile = resolve(arg("eval", join(benchDir, "results", "eval-seed.json")));
  const queriesFile = resolve(arg("queries", join(benchDir, "queries", "seed.json")));
  const out = resolve(
    arg(
      "out",
      join(
        benchDir,
        "results",
        `confirm-${evalFile
          .split("/")
          .pop()
          .replace(/^eval-|\.json$/g, "")}-k${K}.json`,
      ),
    ),
  );
  const descFile = arg("descriptions", null);
  const descriptions = descFile
    ? JSON.parse(readFileSync(resolve(descFile), "utf8")).descriptions
    : {};
  const ev = JSON.parse(readFileSync(evalFile, "utf8"));
  const { set, queries } = JSON.parse(readFileSync(queriesFile, "utf8"));
  const records = buildNames(corpusDefinitions());
  const textOf = (r) =>
    [renderName(r), ...(descriptions[r.id] && !r.doc ? [descriptions[r.id]] : [])].join("\n");
  // b13.mjs records the top 3 per query; rerank is not needed: re-derive the top K from its rows.
  const rowsById = new Map(ev.rows[pool].map((r) => [r.id, r]));
  const items = queries.map((q) => {
    const row = rowsById.get(q.id);
    const ids = row.topK ?? row.top3;
    const shown = ids.slice(0, K).map((id) => ({ r: records[id], text: textOf(records[id]) }));
    return { q, shown, prompt: rootsPrompt(q.need, shown), writeTokens: row.writeTokens };
  });
  const estimate = estimateCost(
    items.reduce((n, it) => n + SYSTEM.length + it.prompt.length, 0),
    items.length * 200,
    items.length,
  );
  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify({ set, pool, k: K, queries: items.length, estimate }, null, 2));
    console.log(`\nexample prompt (${items[0].q.id}):\n${items[0].prompt}`);
    return;
  }
  const model = arg("model", DEFAULT_MODEL);
  checkBudget(estimate, model, Number(arg("max-dollars", String(DEFAULT_MAX_DOLLARS))));
  const client = await modelClient({ model, maxTokens: 1500, effort: arg("effort", "low") });
  const rows = await mapLimit(
    items,
    Number(arg("concurrency", "6")),
    async ({ q, shown, prompt, writeTokens }) => {
      const r = await client.complete(SYSTEM, prompt);
      const j = extractJson(r.text);
      const n = Number(j?.pick);
      const pick = j?.pick !== null && j?.pick !== undefined && Number.isInteger(n) ? n : -1;
      const cards = shown.map((s) => s.r);
      const scored =
        pick < 0 ? { outcome: "invalid", reachable: false } : scorePick(q, cards, pick);
      const requestTokens = await client.countTokens(q.need);
      const usage = { writeTokens, requestTokens, confirmInputTokens: r.inputTokens };
      return {
        id: q.id,
        positive: q.targets.length > 0,
        pick,
        picked: pick > 0 ? (cards[pick - 1]?.id ?? null) : null,
        reason: j?.reason ?? null,
        ...scored,
        tokens: {
          request: requestTokens,
          confirmInput: r.inputTokens,
          confirmOutput: r.outputTokens,
        },
        // Measured find cost; the output tokens of the pick replace the CONFIRM_OUTPUT estimate.
        leverage: q.targets.length
          ? leverage(
              { ...usage, requestTokens: requestTokens + r.outputTokens - 60 },
              PRICES[model],
            )
          : null,
      };
    },
  );
  const result = {
    set,
    pool,
    model,
    k: K,
    usage: client.usage,
    summary: summarizePicks(rows),
    rows,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ summary: result.summary, usage: result.usage }, null, 2));
  console.log(`wrote ${relative(benchDir, out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
