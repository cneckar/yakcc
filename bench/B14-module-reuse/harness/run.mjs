#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B14 (#1258, re-scoped to module scale): does finding and reusing a large module cost less
// than writing it, at equal or better correctness? Two arms per task, same model, seeds:
//   scratch  the model writes everything (one call)
//   reuse    the model names the capability it needs, the library shows the top 5 modules
//            (@yakcc/discovery-search searchModules over the module index), the model picks one
//            or none, then writes glue around lib.<name> (or everything, if none)
//   routed   the model writes it at once when it is small (one call), else continues as reuse
//            (--arms picks a subset; default all three)
// Scored by held-out tests in a vm sandbox; the reused module is bound in the same realm.
//
//   node harness/run.mjs --dry-run [--seeds 3]          plan and cost, no calls
//   node harness/run.mjs --client offline               validation with reference answers
//   CLAUDE_API_KEY=... node harness/run.mjs --client anthropic [--model id] [--seeds 3]
//     [--max-dollars 2] [--out results/live-<model>.json]
// The index: .cache/module-index-all-builds.json, or --index; build it with
//   node scripts/build-module-index.mjs --all-builds --descriptions bench/B12-need-to-code/results/descriptions.json \
//     --out bench/B14-module-reuse/.cache/module-index-all-builds.json Needs packages built (discovery-search, contracts, shave).
process.env.TZ = "UTC";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_DOLLARS,
  DEFAULT_MODEL,
  PRICES,
  checkBudget,
  estimateCost,
  modelClient,
} from "../../B12-need-to-code/harness/model.mjs";
import { tasks as allTasks } from "../tasks.mjs";
import {
  clientView,
  confirmPrompt,
  gluePrompt,
  isTargetEntry,
  needPrompt,
  routePrompt,
  runReuse,
  runScratch,
  scratchPrompt,
  summarize,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");
const repo = resolve(bench, "..", "..");
const est = (s) => Math.ceil(s.length / 4);

/** The offline client: reference answers, for validating the harness. It never sees the cases. */
export function offlineClient(views) {
  const byPrompt = (p) => views.find((v) => p.includes(v.spec));
  return {
    async complete(prompt) {
      const v = byPrompt(prompt);
      const reply = (text) => ({ text, inputTokens: est(prompt), outputTokens: est(text) });
      if (!v) return reply("NONE");
      // Routed: the offline client writes small tasks at once and searches for the rest.
      if (prompt.includes("If you can write this correctly")) {
        if (v.size === "small" && v.referenceScratch)
          return reply(`\`\`\`ts\n${v.referenceScratch}\n\`\`\``);
        return reply(v.spec.split(". ")[0]);
      }
      if (prompt.includes("say what reusable library module")) return reply(v.spec.split(". ")[0]);
      if (prompt.includes('{"pick": candidate number}')) {
        // The offline client picks the candidate whose name and package match its target.
        const pkg = v.lib.file.split("/")[0].replace(/-\d[\d.]*$/, "");
        const m = [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].find(
          (x) =>
            x[2].startsWith(`${pkg} › `) &&
            (x[2].includes(` ${v.lib.name}(`) ||
              x[2].includes(`› ${v.lib.name}(`) ||
              x[2].includes(`› ${v.lib.name} `)),
        );
        return reply(JSON.stringify({ pick: m ? Number(m[1]) : 0 }));
      }
      if (prompt.includes("is already in scope as"))
        return reply(`\`\`\`ts\n${v.referenceGlue}\n\`\`\``);
      return reply(
        `\`\`\`ts\n${v.referenceScratch ?? "export function solve() { throw new Error('offline: no scratch reference'); }"}\n\`\`\``,
      );
    },
  };
}

/** Search and source lookup over a module index, with the local embedder. */
export async function moduleLibrary(indexFile) {
  const ds = await import(
    pathToFileURL(join(repo, "packages/discovery-search/dist/index.js")).href
  );
  const { createLocalEmbeddingProvider } = await import(
    pathToFileURL(join(repo, "packages/contracts/dist/index.js")).href
  );
  const index = ds.parseModuleIndex(JSON.parse(readFileSync(indexFile, "utf8")));
  const provider = createLocalEmbeddingProvider();
  if (provider.modelId !== index.model)
    throw new Error(`index model ${index.model}, embedder ${provider.modelId}`);
  // Offer only modules that load in the runtime the code will run in (here, the sandbox: no
  // Node built-ins). A module that cannot run is not reusable here, whatever it matches.
  const { freshModule } = await import(
    pathToFileURL(join(repo, "bench/B12-need-to-code/harness/sandbox.mjs")).href
  );
  const loadable = new Map();
  const runs = (e) => {
    if (!loadable.has(e.id)) loadable.set(e.id, freshModule(e.sourceFile, e.name) !== null);
    return loadable.get(e.id);
  };
  return {
    index,
    async search(need, k) {
      const hits = ds.searchModules(index, await provider.embed(need), need, { k: k * 6 });
      // One candidate per package and name: several builds of one module are one choice.
      const seen = new Set();
      return hits
        .map((h) => h.entry)
        .filter(runs)
        .filter((e) => !seen.has(`${e.pkg}#${e.name}`) && seen.add(`${e.pkg}#${e.name}`))
        .slice(0, k);
    },
    rootSourceOf(id) {
      return ds.moduleSource(index, id)?.[0]?.source ?? "";
    },
  };
}

export const ARMS = ["scratch", "reuse", "routed"];

/** The plan and an upper-bound cost: scratch writes the module (its closure tokens). */
export function planRun({ tasks, seeds, index, arms = ARMS }) {
  let chars = 0;
  let out = 0;
  let calls = 0;
  for (const t of tasks) {
    const target = index.entries.find((e) => isTargetEntry(t, e));
    const writeTokens = Math.max(300, target?.closureTokens ?? 300);
    // scratch: one call, writes up to the module
    if (arms.includes("scratch")) {
      chars += scratchPrompt(t).length;
      out += writeTokens;
      calls += 1;
    }
    // reuse and routed: first call, confirm over 5 candidates, glue with the root source (or
    // scratch), upper bound
    const five = index.entries.slice(0, 5);
    for (const arm of ["reuse", "routed"].filter((a) => arms.includes(a))) {
      chars +=
        (arm === "routed" ? routePrompt(t) : needPrompt(t)).length +
        confirmPrompt(t, "x".repeat(200), five).length +
        gluePrompt(t, "f", "x".repeat(4000)).length;
      out += 150 + 100 + writeTokens;
      calls += 3;
    }
  }
  return {
    tasks: tasks.length,
    seeds,
    maxCalls: calls * seeds,
    estimate: estimateCost(chars * seeds, out * seeds, calls * seeds),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const seeds = Number(arg("seeds", "1"));
  const indexFile = resolve(arg("index", join(bench, ".cache", "module-index-all-builds.json")));
  if (!existsSync(indexFile))
    throw new Error(`no module index at ${indexFile}; run scripts/build-module-index.mjs`);
  const only = arg("tasks", null);
  const tasks = only ? allTasks.filter((t) => only.split(",").includes(t.id)) : allTasks;
  const arms = arg("arms", ARMS.join(",")).split(",");
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
  const library = await moduleLibrary(indexFile);
  const plan = planRun({ tasks, seeds, index: library.index, arms });
  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const clientName = arg("client", "offline");
  let client;
  let model;
  if (clientName === "offline") {
    client = offlineClient(tasks.map((t) => ({ ...clientView(t), size: t.size })));
    model = "offline-reference";
  } else if (clientName === "anthropic") {
    model = arg("model", DEFAULT_MODEL);
    checkBudget(plan.estimate, model, Number(arg("max-dollars", String(DEFAULT_MAX_DOLLARS))));
    const c = await modelClient({ model, maxTokens: 16000, effort: arg("effort", "low") });
    client = { complete: (p) => c.complete("", p), usage: c.usage };
  } else throw new Error(`unknown client ${clientName}`);
  const rows = [];
  for (let seed = 0; seed < seeds; seed++)
    for (const task of tasks) {
      if (arms.includes("scratch")) rows.push({ seed, ...(await runScratch({ task, client })) });
      for (const arm of ["reuse", "routed"].filter((a) => arms.includes(a)))
        rows.push({
          seed,
          ...(await runReuse({
            task,
            client,
            search: library.search,
            rootSourceOf: library.rootSourceOf,
            route: arm === "routed",
          })),
        });
    }
  const price = PRICES[model] ?? PRICES[DEFAULT_MODEL];
  const summary = summarize(rows, price);
  const bySize = Object.fromEntries(
    [...new Set(tasks.map((t) => t.size))].map((s) => [
      s,
      summarize(
        rows.filter((r) => tasks.find((t) => t.id === r.task).size === s),
        price,
      ),
    ]),
  );
  const out = resolve(
    arg(
      "out",
      join(
        bench,
        "results",
        `${clientName === "offline" ? "offline-validation" : `live-${model}`}.json`,
      ),
    ),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ client: clientName, model, seeds, tasks: tasks.length, summary, bySize, usage: client.usage ?? null, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ summary, bySize }, null, 2));
  console.log(`wrote ${relative(bench, out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
