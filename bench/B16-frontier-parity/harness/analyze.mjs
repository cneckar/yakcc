#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B16 analysis (PROTOCOL.md §5–6): per task and arm, pass@1, dollars per attempt and per correct
// solution; difficulty tiers from Haiku's scratch pass rate; each task's "one-shot model" (the
// cheapest scratch arm that passes at least 80% of attempts); and the preregistered hypotheses,
// with 95% intervals from a bootstrap over tasks (the task is the unit; seeds are averaged
// within a task). Writes results/<run>/report.json and report.md.
//
//   node harness/analyze.mjs --run <name> [--run <name> ...]   (rows of several runs are pooled)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tasks } from "../tasks.mjs";
import { ARMS } from "./arms.mjs";
import { rngFor } from "./rng.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");

export const ONE_SHOT = 0.8;
export const TIERS = { hard: [0, 0.6], medium: [0.6, 1], easy: [1, 1.01] };
const SCRATCH = ARMS.filter((a) => a.strategy === "scratch").map((a) => a.id);
const FRONTIER = ARMS.filter((a) => a.strategy === "scratch" && a.model !== "haiku").map(
  (a) => a.id,
);

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const gmean = (xs) => (xs.length ? Math.exp(mean(xs.map(Math.log))) : null);

/** 95% bootstrap interval of stat(sample) over resampled tasks. */
export function bootstrap(values, stat, n = 10000, seed = "b16") {
  if (values.length === 0) return null;
  const rng = rngFor(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = Array.from({ length: values.length }, () => values[rng.int(values.length)]);
    out.push(stat(s));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * n)], out[Math.floor(0.975 * n)]];
}

/** Per task and arm: attempts, pass@1, dollars per attempt, dollars per correct solution. */
export function cells(rows) {
  const out = {};
  for (const r of rows) {
    out[r.task] ??= {};
    out[r.task][r.arm] ??= {
      n: 0,
      passes: 0,
      dollars: 0,
      caseShare: 0,
      out: 0,
    };
    const c = out[r.task][r.arm];
    c.n++;
    c.passes += r.pass ? 1 : 0;
    c.dollars += r.dollars ?? 0;
    c.caseShare += r.total ? r.passed / r.total : 0;
    c.out += r.outputTokens ?? 0;
  }
  for (const t of Object.values(out))
    for (const c of Object.values(t)) {
      c.pass1 = c.passes / c.n;
      c.perAttempt = c.dollars / c.n;
      c.perCorrect = c.passes ? c.dollars / c.passes : null;
      c.caseShare /= c.n;
      c.meanOutput = c.out / c.n;
    }
  return out;
}

export function analyze(rows) {
  const C = cells(rows);
  const has = (arm) => Object.values(C).some((t) => t[arm]);
  const ids = tasks.map((t) => t.id).filter((id) => C[id]);
  const tierOf = (id) => {
    const p = C[id]["S-haiku"]?.pass1;
    if (p === undefined) return null;
    return Object.entries(TIERS).find(([, [lo, hi]]) => p >= lo && p < hi)[0];
  };
  const oneShot = (id) => {
    const ok = SCRATCH.filter((a) => C[id][a] && C[id][a].pass1 >= ONE_SHOT);
    ok.sort((a, b) => C[id][a].perAttempt - C[id][b].perAttempt);
    return ok[0] ?? null;
  };
  const bestScratch = (id) =>
    Math.max(...SCRATCH.filter((a) => C[id][a]).map((a) => C[id][a].pass1));

  const perTask = ids.map((id) => ({
    task: id,
    family: tasks.find((t) => t.id === id).family,
    tier: tierOf(id),
    oneShot: oneShot(id),
    arms: Object.fromEntries(
      ARMS.filter((a) => C[id][a.id]).map((a) => {
        const c = C[id][a.id];
        return [
          a.id,
          {
            n: c.n,
            pass1: +c.pass1.toFixed(3),
            caseShare: +c.caseShare.toFixed(3),
            perAttempt: +c.perAttempt.toFixed(6),
            perCorrect: c.perCorrect === null ? null : +c.perCorrect.toFixed(6),
            meanOutput: Math.round(c.meanOutput),
          },
        ];
      }),
    ),
  }));

  const arms = Object.fromEntries(
    ARMS.filter((a) => has(a.id)).map((a) => {
      const cs = ids.map((id) => C[id][a.id]).filter(Boolean);
      const dollars = cs.reduce((s, c) => s + c.dollars, 0);
      const passes = cs.reduce((s, c) => s + c.passes, 0);
      return [
        a.id,
        {
          tasks: cs.length,
          meanPass1: +mean(cs.map((c) => c.pass1)).toFixed(3),
          dollars: +dollars.toFixed(4),
          perCorrect: passes ? +(dollars / passes).toFixed(6) : null,
        },
      ];
    }),
  );

  const byTier = (tier) => ids.filter((id) => tierOf(id) === tier);
  const diff = (list, a, bFn) =>
    list.filter((id) => C[id][a]).map((id) => C[id][a].pass1 - bFn(id));
  const H = {};
  // H1 parity: on hard tasks, routed Haiku is within 5 points of the best scratch arm.
  if (has("R-haiku") && FRONTIER.some(has)) {
    const d = diff(byTier("hard"), "R-haiku", bestScratch);
    const ci = bootstrap(d, mean);
    H.H1_parity = {
      tasks: d.length,
      meanDiff: mean(d),
      ci,
      holds: d.length > 0 && mean(d) >= -0.05 && ci[0] > -0.1,
    };
  } else H.H1_parity = "pending: needs phase 2 (frontier scratch arms)";
  // H2 cost: where Haiku cannot one-shot it but a bigger model can, and routed Haiku can.
  if (has("R-haiku") && FRONTIER.some(has)) {
    const pool = ids.filter((id) => {
      const o = oneShot(id);
      return o && FRONTIER.includes(o) && C[id]["R-haiku"]?.pass1 >= ONE_SHOT;
    });
    const ratios = pool.map((id) => C[id]["R-haiku"].perCorrect / C[id][oneShot(id)].perCorrect);
    const ci = bootstrap(ratios, gmean);
    const unsolvedByScratch = ids.filter(
      (id) => !oneShot(id) && C[id]["R-haiku"]?.pass1 >= ONE_SHOT,
    );
    H.H2_cost = {
      tasks: pool.length,
      geoMeanRatio: gmean(ratios),
      ci,
      holds: pool.length > 0 && gmean(ratios) <= 0.2 && ci[1] <= 0.33,
      solvedOnlyByReuse: unsolvedByScratch,
    };
  } else H.H2_cost = "pending: needs phase 2 (frontier scratch arms)";
  // H3 no harm on easy tasks.
  if (has("R-haiku") && has("S-haiku")) {
    const easy = byTier("easy").filter((id) => C[id]["R-haiku"]);
    const d = easy.map((id) => C[id]["R-haiku"].pass1 - C[id]["S-haiku"].pass1);
    const ratios = easy
      .filter((id) => C[id]["R-haiku"].perCorrect && C[id]["S-haiku"].perCorrect)
      .map((id) => C[id]["R-haiku"].perCorrect / C[id]["S-haiku"].perCorrect);
    H.H3_noHarm = {
      tasks: easy.length,
      meanPassDiff: mean(d),
      costRatioGeo: gmean(ratios),
      holds: easy.length > 0 && mean(d) >= -0.05 && gmean(ratios) <= 1.5,
    };
    // H5 lift on hard tasks over Haiku from scratch.
    const hard = byTier("hard").filter((id) => C[id]["R-haiku"]);
    const l = hard.map((id) => C[id]["R-haiku"].pass1 - C[id]["S-haiku"].pass1);
    const lci = bootstrap(l, mean);
    H.H5_lift = {
      tasks: hard.length,
      meanLift: mean(l),
      ci: lci,
      holds: hard.length > 0 && mean(l) >= 0.3 && lci[0] > 0.15,
    };
  }
  // Discovery loss: what the oracle arm passes that the routed arm does not.
  if (has("O-haiku") && has("R-haiku")) {
    const d = ids
      .filter((id) => C[id]["O-haiku"] && C[id]["R-haiku"])
      .map((id) => C[id]["O-haiku"].pass1 - C[id]["R-haiku"].pass1);
    H.discoveryLoss = { tasks: d.length, meanOracleMinusRouted: mean(d), ci: bootstrap(d, mean) };
  }
  // Routing loss (secondary, added after phase 1): what always searching passes that the routed
  // arm does not, on the hard tasks and on all; and the hard tasks' parity for the search arm.
  if (has("A-haiku") && has("R-haiku")) {
    const loss = (pool) => {
      const d = pool
        .filter((id) => C[id]["A-haiku"] && C[id]["R-haiku"])
        .map((id) => C[id]["A-haiku"].pass1 - C[id]["R-haiku"].pass1);
      return { tasks: d.length, meanSearchMinusRouted: mean(d), ci: bootstrap(d, mean) };
    };
    H.routingLoss = { hard: loss(byTier("hard")), all: loss(ids) };
    if (FRONTIER.some(has)) {
      const d = diff(byTier("hard"), "A-haiku", bestScratch);
      const ci = bootstrap(d, mean);
      H.H1_searchArm = {
        tasks: d.length,
        meanDiff: mean(d),
        ci,
        holds: d.length > 0 && mean(d) >= -0.05 && ci[0] > -0.1,
      };
    }
  }
  // The forced arm (secondary, added after phase 1c): its gain over the routed arm, and H1's rule
  // for it.
  if (has("F-haiku") && has("R-haiku")) {
    const gain = (pool) => {
      const d = pool
        .filter((id) => C[id]["F-haiku"] && C[id]["R-haiku"])
        .map((id) => C[id]["F-haiku"].pass1 - C[id]["R-haiku"].pass1);
      return { tasks: d.length, meanForcedMinusRouted: mean(d), ci: bootstrap(d, mean) };
    };
    H.forcedGain = { hard: gain(byTier("hard")), all: gain(ids) };
    if (FRONTIER.some(has)) {
      const d = diff(byTier("hard"), "F-haiku", bestScratch);
      const ci = bootstrap(d, mean);
      H.H1_forcedArm = {
        tasks: d.length,
        meanDiff: mean(d),
        ci,
        holds: d.length > 0 && mean(d) >= -0.05 && ci[0] > -0.1,
      };
    }
  }
  // H4 generality: the parity and cost directions per family (≥ 4 tasks).
  const families = [...new Set(perTask.map((t) => t.family))];
  H.H4_byFamily = Object.fromEntries(
    families.map((f) => {
      const fid = ids.filter((id) => tasks.find((t) => t.id === id).family === f);
      return [
        f,
        {
          tasks: fid.length,
          routedPass1: mean(
            fid.filter((id) => C[id]["R-haiku"]).map((id) => C[id]["R-haiku"].pass1),
          ),
          haikuScratchPass1: mean(
            fid.filter((id) => C[id]["S-haiku"]).map((id) => C[id]["S-haiku"].pass1),
          ),
          bestScratchPass1: mean(fid.map(bestScratch)),
        },
      ];
    }),
  );
  return {
    tiers: Object.fromEntries(Object.keys(TIERS).map((t) => [t, byTier(t)])),
    arms,
    hypotheses: H,
    perTask,
  };
}

const fmt = (x, d = 2) =>
  x === null || x === undefined ? "–" : typeof x === "number" ? x.toFixed(d) : String(x);

export function markdown(rep) {
  const armIds = ARMS.map((a) => a.id).filter((a) => rep.arms[a]);
  const lines = [
    `| Task | Family | Tier | One-shot | ${armIds.join(" | ")} |`,
    `|${"---|".repeat(4 + armIds.length)}`,
    ...rep.perTask.map(
      (t) =>
        `| ${t.task} | ${t.family} | ${t.tier ?? "–"} | ${t.oneShot ?? "none"} | ${armIds.map((a) => (t.arms[a] ? `${fmt(t.arms[a].pass1)} · $${fmt(t.arms[a].perAttempt, 5)}` : "–")).join(" | ")} |`,
    ),
    "",
    "| Arm | Tasks | Mean pass@1 | Dollars | Dollars per correct |",
    "|---|---|---|---|---|",
    ...armIds.map(
      (a) =>
        `| ${a} | ${rep.arms[a].tasks} | ${fmt(rep.arms[a].meanPass1)} | $${fmt(rep.arms[a].dollars, 3)} | $${fmt(rep.arms[a].perCorrect, 5)} |`,
    ),
    "",
    "```json",
    JSON.stringify(rep.hypotheses, null, 2),
    "```",
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const runs = argv.flatMap((a, i) => (a === "--run" ? [argv[i + 1]] : []));
  if (runs.length === 0) throw new Error("--run <name> is required");
  const rows = runs.flatMap((r) =>
    readFileSync(join(bench, "results", r, "rows.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
  const rep = analyze(rows);
  const dir = join(bench, "results", runs.at(-1));
  writeFileSync(join(dir, "report.json"), `${JSON.stringify({ runs, ...rep }, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), markdown(rep));
  console.log(markdown(rep));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
