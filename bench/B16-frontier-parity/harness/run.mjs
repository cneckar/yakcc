#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B16 runner (PROTOCOL.md). Runs arms × tasks × seeds and appends one JSON line per attempt to
// results/<run>/rows.jsonl as it goes, so a stopped run loses nothing and resumes where it
// left off (attempts already in the file are skipped). Spending is tracked from the usage the
// API reports and the run stops before an attempt once the cap is reached.
//
//   node harness/run.mjs --dry-run [--phase 1|2|all] [--seeds 5]   plan and estimated cost
//   node harness/run.mjs --client offline                           harness validation
//   CLAUDE_API_KEY=... node harness/run.mjs --client anthropic --phase 1 --seeds 5 \
//     --run <name> --max-dollars 3 [--arms S-haiku,R-haiku] [--tasks id,id] [--concurrency 6]
// Phase 2 (Sonnet, Opus, Fable) spends real money: run it only after the go-ahead.
process.env.TZ = "UTC";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRICES, mapLimit, modelClient } from "../../B12-need-to-code/harness/model.mjs";
import { clientView } from "../../B14-module-reuse/harness/lib.mjs";
import { moduleLibrary, offlineClient } from "../../B14-module-reuse/harness/run.mjs";
import { tasks as allTasks } from "../tasks.mjs";
import { ARMS, MODELS, runArm } from "./arms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");

/**
 * Planning estimate of output tokens per attempt (thinking included), by model. From B14's
 * Haiku runs (about 3k at low effort on module-scale tasks, more at high effort) and a
 * deliberately generous allowance for the larger models at high effort; the cap enforces the
 * real spend.
 */
export const EST_OUTPUT = { haiku: 6000, sonnet: 8000, opus: 7000, fable: 10000 };
const EST_INPUT = 1500;

export const costOf = (model, inputTokens, outputTokens) => {
  const [pi, po] = PRICES[MODELS[model]];
  return (inputTokens * pi + outputTokens * po) / 1e6;
};

/** The planned attempts and an estimate of their cost. */
export function plan({ arms, tasks, seeds }) {
  const attempts = [];
  for (let seed = 0; seed < seeds; seed++)
    for (const arm of arms) for (const task of tasks) attempts.push({ arm, task, seed });
  const byArm = Object.fromEntries(
    arms.map((a) => {
      const n = tasks.length * seeds;
      // Reuse arms make up to three calls but write less; count them as one scratch-sized call.
      return [
        a.id,
        { attempts: n, dollars: +(n * costOf(a.model, EST_INPUT, EST_OUTPUT[a.model])).toFixed(2) },
      ];
    }),
  );
  const dollars = +Object.values(byArm)
    .reduce((s, x) => s + x.dollars, 0)
    .toFixed(2);
  return { attempts, byArm, dollars };
}

const keyOf = (r) => `${r.arm}|${r.task}|${r.seed}`;

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const seeds = Number(arg("seeds", "5"));
  const phase = arg("phase", "1");
  let arms = ARMS.filter((a) => phase === "all" || String(a.phase) === phase);
  if (arg("arms", null)) arms = ARMS.filter((a) => arg("arms").split(",").includes(a.id));
  const tasks = arg("tasks", null)
    ? allTasks.filter((t) => arg("tasks").split(",").includes(t.id))
    : allTasks;
  const p = plan({ arms, tasks, seeds });
  if (argv.includes("--dry-run")) {
    console.log(
      JSON.stringify({ tasks: tasks.length, seeds, byArm: p.byArm, dollars: p.dollars }, null, 2),
    );
    return;
  }
  const clientName = arg("client", "offline");
  const runName = arg("run", clientName === "offline" ? "offline-validation" : null);
  if (!runName) throw new Error("--run <name> is required for a live run");
  const dir = join(bench, "results", runName);
  mkdirSync(dir, { recursive: true });
  const rowsFile = join(dir, "rows.jsonl");
  const done = new Set(
    existsSync(rowsFile)
      ? readFileSync(rowsFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => keyOf(JSON.parse(l)))
      : [],
  );
  const library = await moduleLibrary(
    resolve(arg("index", join(bench, ".cache", "module-index-min150.json"))),
  );
  const maxDollars = Number(arg("max-dollars", "3"));
  let spent = 0;
  const clients = {};
  const clientFor = async (arm) => {
    if (clientName === "offline") {
      clients.offline ??= offlineClient(
        tasks.map((t) => ({ ...clientView(t), size: "large" })),
      );
      return clients.offline;
    }
    const key = `${arm.model}|${arm.effort}`;
    if (!clients[key]) {
      const c = await modelClient({
        model: MODELS[arm.model],
        maxTokens: 32000,
        effort: arm.effort,
        stream: true,
      });
      clients[key] = { complete: (prompt) => c.complete("", prompt) };
    }
    return clients[key];
  };
  const todo = p.attempts.filter((a) => !done.has(`${a.arm.id}|${a.task.id}|${a.seed}`));
  console.log(
    `${todo.length} attempts to run (${p.attempts.length - todo.length} already done); cap $${maxDollars}`,
  );
  let stopped = false;
  await mapLimit(todo, Number(arg("concurrency", "6")), async ({ arm, task, seed }) => {
    if (spent >= maxDollars) {
      stopped = true;
      return;
    }
    let row;
    try {
      row = await runArm({ arm, task, client: await clientFor(arm), library });
    } catch (err) {
      row = {
        arm: arm.id,
        task: task.id,
        pass: false,
        passed: 0,
        total: 0,
        error: `call failed: ${String(err?.message ?? err).slice(0, 200)}`,
        inputTokens: 0,
        outputTokens: 0,
        failedCall: true,
      };
    }
    const dollars =
      clientName === "offline" ? 0 : costOf(arm.model, row.inputTokens, row.outputTokens);
    spent += dollars;
    if (row.failedCall) return; // not recorded: a retry of the run will attempt it again
    appendFileSync(
      rowsFile,
      `${JSON.stringify({ ...row, seed, model: MODELS[arm.model], effort: arm.effort, dollars })}\n`,
    );
  });
  console.log(
    `spent $${spent.toFixed(3)} this run${stopped ? " (stopped at the cap)" : ""}; rows in ${rowsFile}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
