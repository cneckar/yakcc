#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B15 inputs: a model writes each B12 query's function from scratch, the way an agent would
// before upserting it. Each query's need, signature and examples are the new block's spec; the
// corpus definition the query was written from is the stored neighbor the upsert check should
// find. Saves results/impls.json. Bulk work: Haiku by default, with a spending cap.
//
//   node harness/write-impls.mjs [--dry-run] [--sample N] [--max-dollars 1] [--model ...]
process.env.TZ = "UTC";

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractCode } from "../../B14-module-reuse/harness/lib.mjs";
import {
  DEFAULT_MODEL,
  checkBudget,
  estimateCost,
  evenSample,
  mapLimit,
  modelClient,
} from "../../B12-need-to-code/harness/model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");
const b12 = resolve(bench, "..", "B12-need-to-code");

/** The query sets the benchmark uses, with their targets. */
export function loadQueries() {
  const read = (f) => JSON.parse(readFileSync(join(b12, "queries", f), "utf8")).queries;
  return [...read("seed.json"), ...read("generated.json")].filter((q) => q.targets?.length > 0);
}

/** A function name for a query id: "duration-to-ms" → "durationToMs". */
export function fnName(id) {
  const n = id.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
  return /^[A-Za-z_]/.test(n) ? n : `f${n}`;
}

export const SYSTEM =
  "You write one self-contained TypeScript function. Return only the code in one fenced block. Use only the ECMAScript standard library: no imports, no Node or browser APIs.";

export function implPrompt(q) {
  const sig = `${fnName(q.id)}(${q.inputs.map((p) => `${p.name}: ${p.type}`).join(", ")}): ${q.output || "unknown"}`;
  const ex = q.examples
    .map(
      (e) =>
        `${fnName(q.id)}(${e.args.map((a) => JSON.stringify(a)).join(", ")}) → ${e.throws ? "throws" : JSON.stringify(e.returns)}`,
    )
    .join("\n");
  return `Write \`export function ${sig}\`.\n\n${q.need}\n\nExamples (values in tagged JSON: {"$type":"undefined"} is undefined, {"$date":...} a Date):\n${ex}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  let queries = loadQueries();
  if (arg("sample", null)) queries = evenSample(queries, Number(arg("sample")));
  const chars = queries.reduce((n, q) => n + SYSTEM.length + implPrompt(q).length, 0);
  // Output: code plus low-effort thinking, about 1,500 tokens each.
  const estimate = estimateCost(chars, queries.length * 1500, queries.length);
  if (argv.includes("--dry-run")) {
    console.log(JSON.stringify({ queries: queries.length, estimate: estimate[DEFAULT_MODEL] }));
    return;
  }
  const model = arg("model", DEFAULT_MODEL);
  checkBudget(estimate, model, Number(arg("max-dollars", "1")));
  const client = await modelClient({ model, maxTokens: 6000 });
  const impls = {};
  await mapLimit(queries, Number(arg("concurrency", "8")), async (q) => {
    const r = await client.complete(SYSTEM, implPrompt(q));
    impls[q.id] = {
      name: fnName(q.id),
      code: extractCode(r.text),
      stopReason: r.stopReason,
      outputTokens: r.outputTokens,
    };
  });
  const out = join(bench, "results", "impls.json");
  writeFileSync(out, `${JSON.stringify({ model, usage: client.usage, impls }, null, 2)}\n`);
  console.log(`wrote ${Object.keys(impls).length} implementations; usage ${JSON.stringify(client.usage)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
