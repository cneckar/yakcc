#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Which fields of the #1309 names help discovery? Runs the eval with the names as the card
// text: all fields, then each field left out, on the seed and the generated query sets.
// Records the text-only and execution configurations. No model calls.
//   node harness/names-ablation.mjs [--out results/names-ablation.json]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELDS } from "./names.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");
const argv = process.argv.slice(2);
const oi = argv.indexOf("--out");
const out = resolve(oi >= 0 ? argv[oi + 1] : join(bench, "results", "names-ablation.json"));
const tmp = join(bench, ".cache", "ablation");
mkdirSync(tmp, { recursive: true });

const KEEP = ["card-hybrid", "card-hybrid+examples", "+execution"];
const variants = [
  { name: "cards (baseline)", args: [] },
  { name: "names: all fields", args: ["--card-text", "names"] },
  ...FIELDS.map((f) => ({
    name: `names without ${f}`,
    args: ["--card-text", "names", "--fields", FIELDS.filter((x) => x !== f).join(",")],
  })),
];
const sets = [
  { set: "seed", queries: join(bench, "queries", "seed.json") },
  { set: "generated", queries: join(bench, "queries", "generated.json") },
];

const report = { fields: FIELDS, configs: KEEP, results: {} };
for (const s of sets) {
  report.results[s.set] = {};
  for (const v of variants) {
    const file = join(tmp, `${s.set}-${v.name.replace(/\W+/g, "_")}.json`);
    execFileSync(
      process.execPath,
      [join(here, "eval.mjs"), "--queries", s.queries, "--out", file, "--no-exec-all", ...v.args],
      { stdio: "ignore" },
    );
    const r = JSON.parse(readFileSync(file, "utf8"));
    report.results[s.set][v.name] = Object.fromEntries(
      KEEP.map((k) => {
        const x = r.summary[k];
        return [k, { top1: x.recallAt1, top5: x.recallAt5, top50: x.recallAt50, mrr: x.mrr }];
      }),
    );
    console.log(
      s.set,
      v.name,
      JSON.stringify(report.results[s.set][v.name]["card-hybrid+examples"]),
    );
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}`);
