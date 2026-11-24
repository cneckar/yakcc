#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The held-out B13 query set, from documentation instead of code. A model reads one README
// section at a time (never the code, never our names) and writes the needs a programmer
// would have that the section's API fulfils, in the programmer's words. It also names the
// API each need is about, which is used only to grade: it is resolved to the corpus root
// with that name, and a need that mentions the API's name or the package's name is dropped.
//
//   node harness/needs-from-readme.mjs --dry-run
//   CLAUDE_API_KEY=... node harness/needs-from-readme.mjs [--model id] [--max-dollars 2]
//     [--out queries/readme.json]
// Defaults to Haiku 5.5; refuses above the spending cap.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import {
  DEFAULT_MAX_DOLLARS,
  DEFAULT_MODEL,
  checkBudget,
  estimateCost,
  extractJson,
  mapLimit,
  modelClient,
} from "../../B12-need-to-code/harness/model.mjs";
import { buildNames } from "../../B12-need-to-code/harness/names.mjs";
import { FIXTURES } from "../../B12-need-to-code/harness/sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");

export const SYSTEM =
  'You read one section of a JavaScript library\'s documentation. For each distinct capability it documents, write the need a programmer would have, in their own words, as if asking a code library they have never seen: one or two sentences about what they want done, with the inputs and behavior that matter. Never use the library\'s name, its function or class names, or code. Reply with one JSON object: {"needs": [{"need": "...", "api": "the documented function or class name this need is about"}]}. Return {"needs": []} if the section documents no capability (for example installation or licensing).';

/** README sections: split on headings, joined to at most `max` characters each. */
export function sections(text, max = 4000) {
  const parts = text.split(/\n(?=#{1,4} )/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur.length + p.length > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + p.slice(0, max);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The READMEs of the corpus packages. */
export function readmes() {
  const out = [];
  for (const pkg of readdirSync(FIXTURES).sort()) {
    const f = ["README.md", "readme.md", "Readme.md"]
      .map((n) => join(FIXTURES, pkg, n))
      .find((p) => existsSync(p));
    if (f) out.push({ pkg, text: readFileSync(f, "utf8") });
  }
  return out;
}

/** Whether a need leaks the API or package name it should not contain. */
export function leaks(need, api, pkg) {
  const words = [api, ...api.split(/[.#]/), pkg.replace(/-\d[\d.]*$/, "")].filter(
    (w) => w && w.length >= 3,
  );
  return words.some((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(need),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const out = resolve(arg("out", join(benchDir, "queries", "readme.json")));
  const items = readmes().flatMap(({ pkg, text }) =>
    sections(text).map((section) => ({ pkg, section })),
  );
  const estimate = estimateCost(
    items.reduce((n, it) => n + SYSTEM.length + it.section.length, 0),
    items.length * 400,
    items.length,
  );
  if (argv.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        { packages: new Set(items.map((i) => i.pkg)).size, sections: items.length, estimate },
        null,
        2,
      ),
    );
    return;
  }
  const model = arg("model", DEFAULT_MODEL);
  checkBudget(estimate, model, Number(arg("max-dollars", String(DEFAULT_MAX_DOLLARS))));
  const client = await modelClient({ model, maxTokens: 3000 });
  const records = Object.values(buildNames(corpusDefinitions()));
  const replies = await mapLimit(items, Number(arg("concurrency", "6")), async (it) => {
    const r = await client.complete(SYSTEM, it.section);
    const j = extractJson(r.text);
    return Array.isArray(j?.needs) ? j.needs.map((n) => ({ ...n, pkg: it.pkg })) : [];
  });
  const queries = [];
  const dropped = { leak: 0, unresolved: 0, malformed: 0 };
  // Kept for diagnosis (which APIs a naming scheme would have to resolve): never graded.
  const unresolved = [];
  for (const n of replies.flat()) {
    if (typeof n.need !== "string" || typeof n.api !== "string") {
      dropped.malformed++;
      continue;
    }
    if (leaks(n.need, n.api, n.pkg)) {
      dropped.leak++;
      continue;
    }
    // The last identifier of the API, without call arguments: "pLimit(concurrency)" -> pLimit.
    const name = n.api.replace(/\(.*$/, "").split(/[.#]/).filter(Boolean).pop();
    const hits = records.filter((r) => r.pkg === n.pkg && r.name === name);
    if (hits.length === 0) {
      dropped.unresolved++;
      unresolved.push({ pkg: n.pkg, api: n.api, need: n.need });
      continue;
    }
    queries.push({
      id: `readme-${queries.length + 1}`,
      need: n.need,
      api: n.api,
      targets: [`${n.pkg}:*#${name}`],
    });
  }
  writeFileSync(
    out,
    `${JSON.stringify({ set: "readme", model, usage: client.usage, dropped, unresolved, queries }, null, 2)}\n`,
  );
  console.log(
    `wrote ${queries.length} queries; dropped ${JSON.stringify(dropped)}; usage ${JSON.stringify(client.usage)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
