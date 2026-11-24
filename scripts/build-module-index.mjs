#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build a module index for @yakcc/discovery-search's searchModules and the MCP tools
// yakcc_find_modules / yakcc_get_module (DEC-DISCOVERY-MODULES-001).
//
// Entries are the corpus's large roots: an entry point, or a core shared by two or more
// callers, whose closure has at least 400 AST nodes (bench/B13). Each entry is searched by its
// descriptive name (the #1309 prototype in bench/B12-need-to-code/harness/names.mjs), plus a
// one-line description when a descriptions file is given. Vectors come from the local
// embedding provider (bge-small), so a query must use the same model. Closure sources are
// stored once per definition, so yakcc_get_module can return the code.
//
// Interim: the names come from the bench prototype over the shave fixture corpus until #1309
// lands in shave; then this builder should read shave's stored names instead.
//
//   node scripts/build-module-index.mjs --out <index.json>
//     [--descriptions bench/B12-need-to-code/results/descriptions.json] [--min-nodes 400]
// Needs packages/contracts built and the embedding model (downloaded once, then cached).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const imp = (p) => import(pathToFileURL(join(repo, p)).href);

export const INDEX_VERSION = 1;

/** Build the index data (vectors as arrays) from name records and an embedder. */
export async function buildModuleIndex({ records, defsByKey, embed, model, descriptions = {}, minNodes = 400 }) {
  const roots = records.filter((r) => (r.exported || r.fanIn >= 2) && r.closureNodes >= minNodes);
  const { renderName } = await imp("bench/B12-need-to-code/harness/names.mjs");
  const sources = {};
  const entries = [];
  const vectors = [];
  for (const r of roots) {
    const closure = [r.id];
    for (const key of r.closureKeys ?? []) {
      const d = defsByKey.get(key);
      if (d && d.id !== r.id) closure.push(d.id);
    }
    for (const id of closure) {
      const d = defsByKey.get(id) ?? defsByKey.get(`id:${id}`);
      if (d) sources[id] = d.text;
    }
    const text = [renderName(r), ...(descriptions[r.id] && !r.doc ? [descriptions[r.id]] : [])].join("\n");
    entries.push({
      id: r.id,
      pkg: r.pkg,
      sourceFile: r.sourceFile,
      name: r.name,
      text,
      closureTokens: Math.ceil(r.closureChars / 4),
      closure,
    });
    vectors.push(Array.from(await embed(text)));
  }
  return { version: INDEX_VERSION, model, minNodes, entries, vectors, sources };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const out = resolve(arg("out", join(repo, "bench", "B13-module-discovery", ".cache", "module-index.json")));
  const descFile = arg("descriptions", null);
  const descriptions = descFile ? JSON.parse(readFileSync(resolve(descFile), "utf8")).descriptions : {};
  const { corpusDefinitions } = await imp("bench/B11-reuse-economics/harness/retrieve.mjs");
  const { buildNames } = await imp("bench/B12-need-to-code/harness/names.mjs");
  const { createLocalEmbeddingProvider } = await imp("packages/contracts/dist/index.js");
  const defs = corpusDefinitions();
  const defsByKey = new Map();
  for (const d of defs) {
    const id = `${d.sourceFile}#${d.name}@${d.lineStart}`;
    const def = { ...d, id };
    defsByKey.set(`id:${id}`, def);
    // First definition wins for a "file#name" key (the top-level one comes first in source order).
    if (!defsByKey.has(`${d.sourceFile}#${d.name}`)) defsByKey.set(`${d.sourceFile}#${d.name}`, def);
  }
  const provider = createLocalEmbeddingProvider();
  const index = await buildModuleIndex({
    records: Object.values(buildNames(defs)),
    defsByKey,
    embed: (t) => provider.embed(t),
    model: provider.modelId,
    descriptions,
    minNodes: Number(arg("min-nodes", "400")),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(index));
  console.log(
    `wrote ${index.entries.length} modules, ${Object.keys(index.sources).length} sources, model ${index.model} -> ${out}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
