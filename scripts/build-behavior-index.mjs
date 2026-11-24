#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build the behavior index that yakcc_check_duplicates reads (DEC-MCP-BEHAVIOR-001): for each
// callable corpus definition, its outputs on the fixed probe inputs for its arity and on its own
// examples, recorded once, so the check runs only the new code. Uses B12's probed cards (which
// say which definitions are callable and give their examples) and B12's sandbox to run them;
// the probes and output keys come from @yakcc/mcp-registry's behavior module, so the tool
// compares like with like. Descriptions (JSDoc, else B12's generated ones) feed text search.
//
// With the stored code (default; --no-code leaves it out), the tool can also run stored
// definitions on the caller's examples, which carry most verdicts (B15).
//
//   node scripts/build-behavior-index.mjs [--out .cache/behavior-index.json] [--no-code]
// Needs: packages/mcp-registry built; bench/B12-need-to-code/.cache/cards.json (run B12's eval
// once to create it).
process.env.TZ = "UTC";

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const b12 = join(repo, "bench", "B12-need-to-code");

/** A tagged result from B12's sandbox as a Run in the tool's format. */
export function toRun(r, behavior) {
  return r.ok
    ? { ok: true, key: behavior.outputKey(r.value), informative: !behavior.degenerate(r.value) }
    : { ok: false, error: r.error };
}

const FIXTURES = join(repo, "packages/shave/src/__fixtures__/module-graph");

/** Resolve a relative require inside a fixture package (as B12's sandbox does), or null. */
export function resolveInPackage(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const pkgRoot = join(FIXTURES, relative(FIXTURES, fromFile).split("/")[0]);
  if (relative(pkgRoot, base).startsWith("..")) return null;
  const tsTwin = base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : null;
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.ts`,
    join(base, "index.js"),
    join(base, "index.ts"),
  ];
  if (tsTwin) candidates.push(tsTwin);
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/**
 * The stored code of the given source files and everything they require: CommonJS, ending with
 * the pick of their top-level bindings, with each relative require resolved. Keys are paths
 * relative to the fixture root (as card.sourceFile is).
 */
export async function storedFiles(sourceFiles) {
  const ts = createRequire(join(repo, "packages/shave/package.json"))("typescript");
  const { topLevelNames } = await import(pathToFileURL(join(b12, "harness", "sandbox.mjs")).href);
  const files = {};
  const todo = [...sourceFiles];
  while (todo.length > 0) {
    const rel = todo.pop();
    if (files[rel]) continue;
    const abs = join(FIXTURES, rel);
    const source = readFileSync(abs, "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        allowJs: true,
        esModuleInterop: true,
      },
    }).outputText;
    const pick = topLevelNames(source)
      .map(
        (n) =>
          `${JSON.stringify(n)}: (function(){ try { return ${n}; } catch (e) { return undefined; } })()`,
      )
      .join(",");
    const deps = {};
    for (const m of js.matchAll(/require\((["'])([^"']+)\1\)/g)) {
      const target = resolveInPackage(abs, m[2]);
      if (target) {
        deps[m[2]] = relative(FIXTURES, target);
        todo.push(deps[m[2]]);
      }
    }
    files[rel] = { js: `${js}\n;module.__picked = {${pick}};`, deps };
  }
  return files;
}

export async function buildBehaviorIndex({ cards, descriptions = {}, withCode = true }) {
  const behavior = await import(
    pathToFileURL(join(repo, "packages/mcp-registry/dist/behavior.js")).href
  );
  const { resolveCallable, callTagged } = await import(
    pathToFileURL(join(b12, "harness", "sandbox.mjs")).href
  );
  const entries = [];
  for (const card of cards) {
    if (!card.callable) continue;
    const c = resolveCallable(card.sourceFile, card.name);
    if (!c.callable) continue;
    const run = (args) => toRun(callTagged(c, args), behavior);
    entries.push({
      id: card.id,
      pkg: card.pkg,
      name: card.name,
      sourceFile: card.sourceFile,
      arity: card.arity,
      text: card.doc ?? descriptions[card.id] ?? "",
      probes: behavior.probeArgs(card.arity).map(run),
      examples: (card.examples ?? []).map((e) => ({ args: e.args, run: run(e.args) })),
    });
  }
  const files = withCode
    ? await storedFiles([...new Set(entries.map((e) => e.sourceFile))])
    : undefined;
  return { version: 1, entries, ...(files ? { files } : {}) };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = resolve(i >= 0 ? argv[i + 1] : join(repo, ".cache", "behavior-index.json"));
  const cardsFile = join(b12, ".cache", "cards.json");
  if (!existsSync(cardsFile))
    throw new Error(`no ${cardsFile}; run bench/B12-need-to-code/harness/eval.mjs once`);
  const cards = JSON.parse(readFileSync(cardsFile, "utf8"));
  const descriptions = JSON.parse(
    readFileSync(join(b12, "results", "descriptions.json"), "utf8"),
  ).descriptions;
  const index = await buildBehaviorIndex({
    cards,
    descriptions,
    withCode: !argv.includes("--no-code"),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(index));
  console.log(`wrote ${index.entries.length} entries to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
