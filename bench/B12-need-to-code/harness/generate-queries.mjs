#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Generate the held-out query set with a model: how an LLM would ask for each sampled
// corpus function, written without seeing its name or its code.
//
// Two calls per function, so the query cannot copy the code:
//   1. describe: a model reads the code, with the function's own name masked, and writes
//      what it does, in prose, with no identifiers.
//   2. ask: a fresh call sees only that description and writes the query card a composing
//      model would send: the need, the parameter types, and example calls with results.
// Then the target is run on the query's examples. A query whose examples the target does not
// reproduce is kept but marked, since the description, or the model's examples, are wrong;
// the eval reports those separately. A need that contains the function's name is rejected.
//
//   node harness/generate-queries.mjs --dry-run [--limit 300]
//   ANTHROPIC_API_KEY=... node harness/generate-queries.mjs [--limit 300] [--model id]
//     [--out queries/generated.json]
// Needs approved spend. --dry-run prints the plan and cost at each model's price.
process.env.TZ = "UTC";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { buildCard } from "./cards.mjs";
import { runExamples } from "./match.mjs";
import { DEFAULT_MODEL, estimateCost, extractJson, maskName, modelClient } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");

export const DESCRIBE_SYSTEM =
  "You read one JavaScript or TypeScript function and say what it does. Write plain prose: what it takes, what it returns, and how it treats edge cases and errors. Do not use any identifier from the code, and do not quote the code.";
export const ASK_SYSTEM =
  'You are a programmer composing a program. You need a function that behaves as described, and you are asking a code library for it. You have not seen the library. Reply with one JSON object: {"need": one or two sentences in your own words, "inputs": [{"name", "type"}], "output": a type, "examples": [{"args": [...], "returns": value} or {"args": [...], "throws": true}]}. Give two to four examples that pin the behavior down, including an edge case. Use JSON values; write a Date as {"$date": ISO string}, bytes as {"$bytes": [..]}, undefined as {"$type": "undefined"}.';

/**
 * The functions to ask about: callable, deterministic, with at least one probe example, and
 * at most `perPackage` from any package so no package dominates the set. Deterministic order.
 */
export function sample(cards, limit, perPackage = 25) {
  const byPkg = new Map();
  for (const c of cards) {
    if (!c.callable || !c.deterministic || c.examples.length === 0) continue;
    if (c.name.startsWith("#") || c.name.length < 3) continue;
    const list = byPkg.get(c.pkg) ?? [];
    if (list.length < perPackage) list.push(c);
    byPkg.set(c.pkg, list);
  }
  // Round-robin across packages, so a small limit still spans the corpus.
  const lists = [...byPkg.values()];
  const out = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const limit = Number(arg("limit", "300"));
  const out = resolve(arg("out", join(benchDir, "queries", "generated.json")));
  const cacheFile = join(benchDir, ".cache", "cards.json");
  const defs = corpusDefinitions();
  const cards = existsSync(cacheFile)
    ? JSON.parse(readFileSync(cacheFile, "utf8"))
    : defs.map(buildCard);
  const textOf = new Map(defs.map((d) => [`${d.sourceFile}#${d.name}@${d.lineStart}`, d.text]));
  const chosen = sample(cards, limit);

  if (argv.includes("--dry-run")) {
    const chars = chosen.reduce(
      (n, c) =>
        n + DESCRIBE_SYSTEM.length + (textOf.get(c.id)?.length ?? 0) + ASK_SYSTEM.length + 800,
      0,
    );
    console.log(
      JSON.stringify(
        {
          functions: chosen.length,
          packages: new Set(chosen.map((c) => c.pkg)).size,
          estimate: estimateCost(chars, chosen.length * 2 * 700, chosen.length * 2),
        },
        null,
        2,
      ),
    );
    return;
  }

  const model = arg("model", DEFAULT_MODEL);
  const client = await modelClient({ model });
  const queries = [];
  for (const c of chosen) {
    const code = maskName(textOf.get(c.id) ?? "", c.name);
    const d = await client.complete(DESCRIBE_SYSTEM, code);
    if (d.stopReason !== "end_turn") continue;
    const a = await client.complete(ASK_SYSTEM, d.text);
    const q = extractJson(a.text);
    if (!q || typeof q.need !== "string" || !Array.isArray(q.examples)) continue;
    if (/[A-Z_$\d]/.test(c.name.slice(1)) && q.need.includes(c.name)) continue; // leaked name
    const target = `${c.pkg}:${c.sourceFile.slice(c.pkg.length + 1)}#${c.name}`;
    const query = {
      id: `gen-${queries.length + 1}`,
      origin: `generated:${model}`,
      need: q.need,
      inputs: Array.isArray(q.inputs) ? q.inputs : [],
      output: typeof q.output === "string" ? q.output : "",
      examples: q.examples,
      targets: [target],
      description: d.text,
    };
    const r = runExamples(c, query.examples);
    query.targetReproduces = r.executable ? r.passed === r.total : null;
    queries.push(query);
  }
  writeFileSync(
    out,
    `${JSON.stringify({ set: "generated", model, usage: client.usage, queries }, null, 2)}\n`,
  );
  console.log(`wrote ${queries.length} queries to ${out}; usage ${JSON.stringify(client.usage)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
