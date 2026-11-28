// SPDX-License-Identifier: MIT
// B16 self-test: every task's reference passes all its held-out cases with the module bound and
// a stub fails; the cases on disk are what build-cases produces (deterministic) and agree with
// the published vectors; scratch code cannot reach a module; prompts never carry held-out
// values; the analysis computes tiers, the one-shot model and the hypotheses on known rows.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  gluePrompt,
  needPrompt,
  routePrompt,
  scratchPrompt,
} from "../../B14-module-reuse/harness/lib.mjs";
import { tasks } from "../tasks.mjs";
import { analyze, bootstrap } from "./analyze.mjs";
import { ARMS } from "./arms.mjs";
import { buildCases } from "./build-cases.mjs";
import { plan } from "./run.mjs";
import { CASES_DIR, casesOf, scoreSolution } from "./score.mjs";

describe("held-out cases", () => {
  for (const t of tasks) {
    it(`${t.id}: the reference passes every case; a stub does not`, () => {
      const r = scoreSolution(t, t.referenceGlue, t.lib);
      assert.equal(r.pass, true, r.error);
      if (!t.check) assert.ok(r.total >= 10, `${t.id} has only ${r.total} cases`);
      assert.equal(scoreSolution(t, "export function solve() { return null; }").pass, false);
    });
  }
  it("built cases are deterministic and match the files on disk", () => {
    for (const t of tasks.filter((x) => x.inputs || x.gen || x.vectors)) {
      const onDisk = JSON.parse(readFileSync(join(CASES_DIR, `${t.id}.json`), "utf8")).cases;
      assert.deepEqual(buildCases(t), onDisk, t.id);
    }
  });
  it("a published vector the reference disagrees with stops the build", () => {
    const t = tasks.find((x) => x.id === "sha1-hex");
    assert.throws(
      () =>
        buildCases({
          ...t,
          vectors: [{ args: ["abc"], returns: "0".repeat(40), source: "wrong" }],
        }),
      /disagrees with wrong/,
    );
  });
  it("boolean tasks have at least 4 cases of each answer", () => {
    for (const t of tasks) {
      const cs = casesOf(t);
      const yes = cs.filter((c) => c.returns === true).length;
      const no = cs.filter((c) => c.returns === false).length;
      if (yes + no > 0) assert.ok(yes >= 4 && no >= 4, `${t.id}: ${yes} true, ${no} false`);
    }
  });
  it("scratch code cannot reach a module (no lib in a bare context)", () => {
    const t = tasks.find((x) => x.id === "iban-valid");
    assert.match(scoreSolution(t, t.referenceGlue).error, /lib is not defined/);
  });
});

describe("prompts", () => {
  it("never carry a held-out expected value", () => {
    for (const t of tasks) {
      const prompts = [
        scratchPrompt(t),
        needPrompt(t),
        routePrompt(t),
        gluePrompt(t, "f", "function f() {}"),
      ];
      for (const c of casesOf(t)) {
        const v = JSON.stringify(c.returns);
        if (v === undefined || v.length <= 12) continue;
        for (const p of prompts) assert.equal(p.includes(v), false, `${t.id} leaks ${v}`);
      }
    }
  });
});

describe("analysis", () => {
  const row = (arm, task, pass, dollars) => ({
    arm,
    task,
    pass,
    passed: pass ? 1 : 0,
    total: 1,
    dollars,
    outputTokens: 100,
  });
  const rows = [];
  // md5-hex: hard for Haiku, Opus one-shots it, routed Haiku passes cheaply.
  for (let s = 0; s < 5; s++) {
    rows.push(row("S-haiku", "md5-hex", s === 0, 0.001));
    rows.push(row("S-opus", "md5-hex", true, 0.1));
    rows.push(row("R-haiku", "md5-hex", true, 0.002));
    rows.push(row("S-haiku", "build-order", true, 0.001));
    rows.push(row("S-opus", "build-order", true, 0.05));
    rows.push(row("R-haiku", "build-order", true, 0.001));
  }
  const rep = analyze(rows);
  it("tiers, one-shot model, hypotheses", () => {
    assert.deepEqual(rep.tiers.hard, ["md5-hex"]);
    assert.deepEqual(rep.tiers.easy, ["build-order"]);
    const md5 = rep.perTask.find((t) => t.task === "md5-hex");
    assert.equal(md5.oneShot, "S-opus");
    assert.equal(rep.hypotheses.H1_parity.meanDiff, 0);
    assert.ok(Math.abs(rep.hypotheses.H2_cost.geoMeanRatio - 0.02) < 1e-9);
    assert.equal(rep.hypotheses.H2_cost.holds, true);
    assert.equal(rep.hypotheses.H3_noHarm.holds, true);
    assert.ok(Math.abs(rep.hypotheses.H5_lift.meanLift - 0.8) < 1e-9);
  });
  it("the bootstrap is seeded and brackets the mean", () => {
    const xs = [0, 1, 0.5, 0.25, 0.75];
    const m = (s) => s.reduce((a, b) => a + b, 0) / s.length;
    assert.deepEqual(bootstrap(xs, m, 1000), bootstrap(xs, m, 1000));
    const [lo, hi] = bootstrap(xs, m, 1000);
    assert.ok(lo <= 0.5 && hi >= 0.5);
  });
  it("the plan covers arms × tasks × seeds and prices phase 2 higher than phase 1", () => {
    const p1 = plan({ arms: ARMS.filter((a) => a.phase === 1), tasks, seeds: 5 });
    const p2 = plan({ arms: ARMS.filter((a) => a.phase === 2), tasks, seeds: 5 });
    assert.equal(p1.attempts.length, 6 * tasks.length * 5);
    assert.ok(p2.dollars > 10 * p1.dollars);
  });
});
