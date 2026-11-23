#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B11 reuse-economics runner (#1258). Arms per task, one model client, held-out scoring.
//   node harness/run.mjs --client offline --out results/offline-validation.json
//   node harness/run.mjs --dry-run                     (plan and cost estimate; no calls)
//   ANTHROPIC_API_KEY=... node harness/run.mjs --client anthropic --model <id> --seeds 3 \
//     [--effort low|medium|high] --out results/<run>.json
// The live client calls the Messages API, which costs money. Run it only with approval.
// Needs @yakcc/shave built (pnpm --filter @yakcc/shave build): the slice selection and the
// fallback policy are shave's own code, imported from its dist.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  breakEven,
  buildPrompt,
  clientView,
  loadTasks,
  runArm,
  runFallbackArm,
  summarize,
  summarizeBy,
  tallyTriggers,
  tokensByModel,
} from "./lib.mjs";
import { offlineClient } from "./offline-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const { selectCompositionContext } = await import(
  pathToFileURL(join(repo, "packages/shave/dist/retrieval/context.js")).href
);
const { decideFallback } = await import(
  pathToFileURL(join(repo, "packages/shave/dist/retrieval/fallback.js")).href
);

export const DEFAULTS = Object.freeze({
  // Strong-match threshold for the fallback arm.
  strongThreshold: 0.8,
  // Token budget for the retrieved slice. The corpus tasks cite real source spans (a parser
  // is ~270 estimated tokens), so 400 could not hold two atoms. At 1200 the rank and fill
  // selections agree on every task; at 600 they differ on five (results/fill-selections.json).
  tokenBudget: 1200,
  // Max share of the budget per source package in the fill's first pass (#1271).
  maxPackageShare: 0.5,
  seeds: 1,
});

/**
 * The arms (#1258, #1271):
 *   scratch     the spec only
 *   slice       the spec and the slice in rank order (the default composition context)
 *   slice-fill  the spec and the slice under the source-spread fill (#1271)
 *   fallback    gap-gated: compose from the rank-order slice, synthesize only on a measured
 *               gap, and log the reason (#1263)
 */
export const ARMS = Object.freeze(["scratch", "slice", "slice-fill", "fallback"]);

/**
 * The composition context for a task: its candidates through selectCompositionContext,
 * in rank order (`fill: false`) or under the source-spread fill (`fill: true`).
 */
export function selectionFor(task, { fill, tokenBudget, maxPackageShare }) {
  const candidates = task.slice.map(({ id, sourcePkg, score, text, citation }) => ({
    id,
    sourcePkg,
    score,
    text,
    citation,
  }));
  const ctx = selectCompositionContext(candidates, {
    tokenBudget,
    ...(fill ? { sourceSpread: { maxPackageShare } } : {}),
  });
  return {
    ctx,
    slice: ctx.selected.map((s) => task.slice.find((c) => c.id === s.id)),
  };
}

/** The recorded candidate set of a selection: what reached composition and what did not. */
export function describeSelection(ctx) {
  return {
    mode: ctx.mode,
    maxPackageShare: ctx.maxPackageShare,
    selected: ctx.selected.map((c) => c.id),
    dropped: ctx.dropped,
    tokens: ctx.tokens,
    byPackage: ctx.byPackage,
  };
}

/** Run the chosen arms on every task, `seeds` times. */
export async function runAll({ tasks, client, model, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const arms = o.arms ?? ARMS;
  const rows = [];
  const selections = [];
  for (const task of tasks) {
    const rank = selectionFor(task, { ...o, fill: false });
    const filled = selectionFor(task, { ...o, fill: true });
    selections.push({
      task: task.id,
      rank: describeSelection(rank.ctx),
      fill: describeSelection(filled.ctx),
      differs:
        rank.ctx.selected.map((c) => c.id).join() !== filled.ctx.selected.map((c) => c.id).join(),
    });
    for (let seed = 0; seed < o.seeds; seed++) {
      const tag = (row) => ({ ...row, seed });
      if (arms.includes("scratch"))
        rows.push(tag(await runArm({ arm: "scratch", task, client, slice: [], model })));
      if (arms.includes("slice"))
        rows.push(
          tag({
            ...(await runArm({ arm: "slice", task, client, slice: rank.slice, model })),
            selection: "rank",
          }),
        );
      if (arms.includes("slice-fill"))
        rows.push(
          tag({
            ...(await runArm({ arm: "slice-fill", task, client, slice: filled.slice, model })),
            selection: "fill",
          }),
        );
      if (arms.includes("fallback"))
        rows.push(
          tag({
            ...(await runFallbackArm({
              task,
              client,
              slice: rank.slice,
              strongThreshold: o.strongThreshold,
              decide: decideFallback,
              model,
            })),
            selection: "rank",
          }),
        );
    }
  }
  // Every fallback trigger, with its reason (#1263).
  const triggers = rows
    .filter((r) => r.arm === "fallback" && r.trigger !== null)
    .map((r) => ({ task: r.task, seed: r.seed, ...r.trigger }));
  const difficulty = Object.fromEntries(tasks.map((t) => [t.id, t.difficulty ?? "single"]));
  const summary = summarize(rows);
  return {
    options: { ...o, arms },
    rows,
    selections,
    triggers,
    triggerCounts: tallyTriggers(rows),
    summary,
    byDifficulty: summarizeBy(rows, (r) => difficulty[r.task]),
    tokensByModel: tokensByModel(rows),
    breakEven: breakEven(summary),
  };
}

/**
 * The plan of a run without making it: calls per arm and an input-token estimate from the
 * prompts (ceil(chars / 4)). Output tokens (thinking included) and fallback second turns are
 * not known in advance, so the estimate takes `outputTokensPerCall` per call and a second turn
 * on every fallback row that composes: an upper bound.
 */
export function planRun({ tasks, options = {}, outputTokensPerCall = 2000 }) {
  const o = { ...DEFAULTS, ...options };
  const arms = o.arms ?? ARMS;
  const est = (s) => Math.ceil(s.length / 4);
  let calls = 0;
  let inputTokens = 0;
  for (const task of tasks) {
    const rank = selectionFor(task, { ...o, fill: false }).slice;
    const filled = selectionFor(task, { ...o, fill: true }).slice;
    const strong = Math.max(...task.slice.map((c) => c.score)) >= o.strongThreshold;
    const prompts = [];
    if (arms.includes("scratch")) prompts.push(buildPrompt(task, "scratch", []));
    if (arms.includes("slice")) prompts.push(buildPrompt(task, "slice", rank));
    if (arms.includes("slice-fill")) prompts.push(buildPrompt(task, "slice", filled));
    if (arms.includes("fallback")) {
      const p = strong ? buildPrompt(task, "slice", rank) : buildPrompt(task, "scratch", []);
      prompts.push(p);
      // Upper bound: a repair turn repeats the prompt with the reply.
      if (strong) prompts.push(p + "x".repeat(outputTokensPerCall * 4));
    }
    calls += prompts.length * o.seeds;
    inputTokens += prompts.reduce((n, p) => n + est(p), 0) * o.seeds;
  }
  return {
    tasks: tasks.length,
    arms,
    seeds: o.seeds,
    maxCalls: calls,
    maxInputTokens: inputTokens,
    maxOutputTokens: calls * outputTokensPerCall,
  };
}

/**
 * The live client: the Anthropic SDK (the version @yakcc/shave pins), one Messages call per
 * turn. Thinking is left at the model's default (adaptive on current models), and its tokens
 * are billed as output, so `max_tokens` is set well above what the code needs. No server-side
 * model fallback: every arm must run on the same model, so a refusal is recorded as a failed
 * row with its stop reason instead of being retried on another model.
 */
export async function anthropicClient({ model, apiKey, maxTokens = 16000, effort }) {
  const require = createRequire(join(repo, "packages/shave/package.json"));
  const { default: Anthropic } = await import(
    pathToFileURL(require.resolve("@anthropic-ai/sdk")).href
  );
  const client = new Anthropic({ apiKey });
  return {
    async complete(prompt) {
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        ...(effort !== undefined ? { output_config: { effort } } : {}),
      });
      return {
        text: message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        stopReason: message.stop_reason,
      };
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(join(here, "..", "tasks"));
  const options = {
    ...(args.seeds ? { seeds: Number(args.seeds) } : {}),
    ...(args.budget ? { tokenBudget: Number(args.budget) } : {}),
    ...(args.share ? { maxPackageShare: Number(args.share) } : {}),
    ...(args.arms ? { arms: args.arms.split(",") } : {}),
  };
  for (const a of options.arms ?? []) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
  if (args["dry-run"] === "true") {
    console.log(JSON.stringify(planRun({ tasks, options }), null, 2));
    return;
  }
  const clientName = args.client ?? "offline";
  let client;
  let model;
  if (clientName === "offline") {
    // The offline client gets each task's client view: never the held-out check.
    client = offlineClient(Object.fromEntries(tasks.map((t) => [t.id, clientView(t)])));
    model = "offline-reference";
  } else if (clientName === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        "ANTHROPIC_API_KEY is not set; the live client needs a key and approved spend",
      );
    model = args.model ?? "claude-sonnet-5-5";
    client = await anthropicClient({ model, apiKey, effort: args.effort });
  } else {
    throw new Error(`unknown client ${clientName}`);
  }
  const result = await runAll({ tasks, client, model, options });
  const out = args.out ?? join(here, "..", "results", "run.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ client: clientName, model, tasks: tasks.length, ...result }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ summary: result.summary, triggerCounts: result.triggerCounts }, null, 2),
  );
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
