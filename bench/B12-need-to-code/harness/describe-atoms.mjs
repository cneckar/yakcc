#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Library side, with a model: a one-line behavior description for each corpus definition
// that has no JSDoc (most of them), so its card says what it does and not just its name.
// The eval reads the file with --descriptions and uses a description wherever a card has no
// doc.
//
//   node harness/describe-atoms.mjs --dry-run
//   ANTHROPIC_API_KEY=... node harness/describe-atoms.mjs [--model id] [--limit N]
//     [--out queries/../results/descriptions.json]
// Needs approved spend. --dry-run prints the plan and cost at each model's price.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { buildCard } from "./cards.mjs";
import { DEFAULT_MODEL, estimateCost, mapLimit, modelClient } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");

export const SYSTEM =
  "Describe what this function does in one sentence of at most 30 words: what it takes and what it returns. Plain prose, no code, no identifiers from the code.";

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const out = resolve(arg("out", join(benchDir, "results", "descriptions.json")));
  const cacheFile = join(benchDir, ".cache", "cards.json");
  const defs = corpusDefinitions();
  const cards = existsSync(cacheFile)
    ? JSON.parse(readFileSync(cacheFile, "utf8"))
    : defs.map(buildCard);
  const textOf = new Map(defs.map((d) => [`${d.sourceFile}#${d.name}@${d.lineStart}`, d.text]));
  const todo = cards.filter((c) => !c.doc).slice(0, Number(arg("limit", String(cards.length))));

  if (argv.includes("--dry-run")) {
    // Long definitions are cut to 6,000 characters for the description.
    const chars = todo.reduce(
      (n, c) => n + SYSTEM.length + Math.min(6000, textOf.get(c.id)?.length ?? 0),
      0,
    );
    console.log(
      JSON.stringify(
        { definitions: todo.length, estimate: estimateCost(chars, todo.length * 120, todo.length) },
        null,
        2,
      ),
    );
    return;
  }
  const model = arg("model", DEFAULT_MODEL);
  const client = await modelClient({ model, maxTokens: 1000 });
  const descriptions = {};
  await mapLimit(todo, Number(arg("concurrency", "8")), async (c) => {
    const r = await client.complete(SYSTEM, (textOf.get(c.id) ?? "").slice(0, 6000));
    if (r.stopReason === "end_turn") descriptions[c.id] = r.text.trim().replace(/\s+/g, " ");
  });
  writeFileSync(out, `${JSON.stringify({ model, usage: client.usage, descriptions }, null, 2)}\n`);
  console.log(
    `wrote ${Object.keys(descriptions).length} descriptions; usage ${JSON.stringify(client.usage)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
