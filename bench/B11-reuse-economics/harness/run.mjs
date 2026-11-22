#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B11 reuse-economics runner. Three arms per task, one model client, held-out scoring.
//   node harness/run.mjs --client offline --out results/offline-validation.json
//   ANTHROPIC_API_KEY=... node harness/run.mjs --client anthropic --model <id> --out results/<run>.json
// The live client calls the Messages API, which costs money. Run it only with approval.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTasks, runArm, summarize } from "./lib.mjs";
import { offlineClient } from "./offline-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const { fill } = await import(
  pathToFileURL(join(repo, "packages/shave/dist/retrieval/fill.js")).href
);
const { decideFallback } = await import(
  pathToFileURL(join(repo, "packages/shave/dist/retrieval/fallback.js")).href
);

const STRONG = 0.8; // strong-match threshold for the fallback arm
const BUDGET = 400; // token budget for the retrieved slice
const SHARE = 0.5; // max share per source package in pass 1

export function anthropicClient({ model, apiKey, maxTokens = 2000 }) {
  return {
    async complete(prompt) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const body = await res.json();
      return {
        text: body.content.map((b) => b.text ?? "").join(""),
        inputTokens: body.usage.input_tokens,
        outputTokens: body.usage.output_tokens,
      };
    },
  };
}

/** The slice an arm is given: the fill of the task's retrieved candidates. */
export function sliceFor(task) {
  const candidates = task.slice.map((c) => ({ ...c, sourcePkg: c.sourcePkg }));
  const filled = fill(
    candidates.map((c) => ({
      id: c.id,
      sourcePkg: c.sourcePkg,
      score: c.score,
      text: c.text,
      citation: c.citation,
    })),
    { tokenBudget: BUDGET, maxPackageShare: SHARE },
  );
  return filled.selected.map((f) => task.slice.find((c) => c.id === f.id));
}

/** Run every arm on every task. The fallback arm records its decision reason. */
export async function runAll({ tasks, client }) {
  const rows = [];
  const decisions = [];
  for (const task of tasks) {
    const slice = sliceFor(task);
    rows.push(await runArm({ arm: "scratch", task, client, slice: [] }));
    rows.push(await runArm({ arm: "slice", task, client, slice }));
    const decision = decideFallback({
      scores: task.slice.map((c) => c.score),
      strongThreshold: STRONG,
      unexplainedCount: 0,
    });
    decisions.push({ task: task.id, ...decision });
    // A reused block would carry its implementation. None of the seed blocks has one, so a
    // reuse decision here is recorded and the arm falls back to synthesis with the slice.
    rows.push(await runArm({ arm: "fallback", task, client, slice }));
  }
  return { rows, decisions, summary: summarize(rows) };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => {
      if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] ?? "true"]);
      return acc;
    }, []),
  );
  const tasks = loadTasks(join(here, "..", "tasks"));
  let client;
  if ((args.client ?? "offline") === "offline") {
    client = offlineClient(Object.fromEntries(tasks.map((t) => [t.id, t])));
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        "ANTHROPIC_API_KEY is not set; the live client needs a key and approved spend",
      );
    client = anthropicClient({ model: args.model ?? "claude-sonnet-5-5", apiKey });
  }
  const result = await runAll({ tasks, client });
  const out = args.out ?? join(here, "..", "results", "run.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ client: args.client ?? "offline", tasks: tasks.length, ...result }, null, 2) +
      "\n",
  );
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
