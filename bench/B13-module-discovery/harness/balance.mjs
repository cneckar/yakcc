#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The README query set is dominated by semver (54 of 78 needs), whose many near-identical
// comparison functions make top-1 hard. This recomputes the B13 results per package, and as
// package-balanced numbers: each package's needs are capped at `--cap` (an even, deterministic
// subset), and a macro-average gives each package equal weight. No model calls: it reads the
// search results (eval-*.json) and the confirm results (confirm-*.json) already written.
//
//   node harness/balance.mjs [--eval results/eval-readme-desc.json]
//     [--confirm results/confirm-readme-desc-k5.json] [--queries queries/readme.json] [--cap 8]
//     [--in-pool]   only needs whose target is a large root (in the searched pool)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");

/** Every k-th of a package's needs, so the cap is deterministic. */
export function capPerPackage(ids, pkgOf, cap) {
  const by = new Map();
  for (const id of ids) {
    const p = pkgOf(id);
    if (!by.has(p)) by.set(p, []);
    by.get(p).push(id);
  }
  const keep = new Set();
  for (const list of by.values()) {
    const step = list.length / Math.min(cap, list.length);
    for (let i = 0; i < Math.min(cap, list.length); i++) keep.add(list[Math.floor(i * step)]);
  }
  return keep;
}

/** Mean of a per-row metric, overall, per package, and macro-averaged over packages. */
export function breakdown(rows, pkgOf, metric) {
  const by = new Map();
  for (const r of rows) {
    const p = pkgOf(r.id);
    if (!by.has(p)) by.set(p, []);
    by.get(p).push(metric(r));
  }
  const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const perPackage = Object.fromEntries(
    [...by.entries()].sort().map(([p, xs]) => [p, { n: xs.length, value: mean(xs) }]),
  );
  return {
    n: rows.length,
    overall: mean(rows.map(metric)),
    macro: mean([...by.values()].map(mean)),
    perPackage,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const cap = Number(arg("cap", "8"));
  const ev = JSON.parse(
    readFileSync(resolve(arg("eval", join(bench, "results", "eval-readme-desc.json"))), "utf8"),
  );
  const cf = JSON.parse(
    readFileSync(
      resolve(arg("confirm", join(bench, "results", "confirm-readme-desc-k5.json"))),
      "utf8",
    ),
  );
  const qs = JSON.parse(
    readFileSync(resolve(arg("queries", join(bench, "queries", "readme.json"))), "utf8"),
  ).queries;
  const pkgOf = new Map(qs.map((q) => [q.id, q.targets[0].split(":")[0]]));
  const pkg = (id) => pkgOf.get(id) ?? "?";
  const keep = capPerPackage(
    qs.map((q) => q.id),
    pkg,
    cap,
  );
  // Needs whose target is a large root: the pool leaves small helpers out on purpose (B12:
  // writing them is cheaper), so a need for one cannot be found here by design.
  const inPool = new Set(ev.rows["large roots"].filter((r) => r.targetInPool).map((r) => r.id));
  const restrict = argv.includes("--in-pool");
  const searchRows = ev.rows["large roots"].filter(
    (r) => r.positive && (!restrict || inPool.has(r.id)),
  );
  const confirmRows = cf.rows.filter((r) => r.positive && (!restrict || inPool.has(r.id)));
  const views = {
    "search top-1": [searchRows, (r) => (r.targetRank === 1 ? 1 : 0)],
    "search top-5": [searchRows, (r) => (r.targetRank !== null && r.targetRank <= 5 ? 1 : 0)],
    "confirm picked the target": [confirmRows, (r) => (r.outcome === "right" ? 1 : 0)],
    "confirm reused something wrong": [confirmRows, (r) => (r.outcome === "wrong-reuse" ? 1 : 0)],
  };
  const report = {
    cap,
    inPoolOnly: restrict,
    targetsInPool: inPool.size,
    packages: [...new Set(qs.map((q) => pkg(q.id)))].sort(),
    all: {},
    capped: {},
  };
  for (const [name, [rows, metric]] of Object.entries(views)) {
    report.all[name] = breakdown(rows, pkg, metric);
    report.capped[name] = breakdown(
      rows.filter((r) => keep.has(r.id)),
      pkg,
      metric,
    );
  }
  const out = join(
    bench,
    "results",
    restrict ? "readme-balanced-in-pool.json" : "readme-balanced.json",
  );
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const f = (x) => (x === null || x === undefined ? "–" : x.toFixed(2));
  console.log(
    `metric                            all(n)       macro   capped≤${cap}(n)  capped macro`,
  );
  for (const name of Object.keys(views))
    console.log(
      `${name.padEnd(33)} ${f(report.all[name].overall)} (${report.all[name].n})   ${f(report.all[name].macro)}    ${f(report.capped[name].overall)} (${report.capped[name].n})     ${f(report.capped[name].macro)}`,
    );
  console.log("per package (all needs), search top-5 / confirm right:");
  for (const p of report.packages)
    console.log(
      `  ${p.padEnd(28)} n=${report.all["search top-5"].perPackage[p]?.n}  ${f(report.all["search top-5"].perPackage[p]?.value)} / ${f(report.all["confirm picked the target"].perPackage[p]?.value)}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
