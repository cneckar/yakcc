// SPDX-License-Identifier: MIT
// Tests for the runner: arms, the gap-gated fallback (#1263), the fill on and off (#1271), and
// the run plan and break-even report (#1258). Needs @yakcc/shave built, like run.mjs.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { breakEven, closureHoles, loadTasks, tallyTriggers } from "./lib.mjs";
import { offlineClient } from "./offline-client.mjs";
import { ARMS, DEFAULTS, planRun, runAll, selectionFor } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tasks = loadTasks(join(here, "..", "tasks"));
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

/** A client that answers from a script and records every prompt. */
function scripted(replies) {
  const prompts = [];
  return {
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      const r = replies[Math.min(prompts.length - 1, replies.length - 1)];
      return { inputTokens: 10, outputTokens: 5, stopReason: "end_turn", ...r };
    },
  };
}
const fenced = (code) => `\`\`\`ts\n${code}\n\`\`\``;

describe("gap-gated fallback arm (#1263)", () => {
  // clamp's best slice score is below the strong threshold; add-durations' is above it.
  const nearMiss = byId.clamp;
  const strong = byId["add-durations"];

  it("the fixtures cover both sides of the threshold", () => {
    assert.ok(Math.max(...nearMiss.slice.map((c) => c.score)) < DEFAULTS.strongThreshold);
    assert.ok(Math.max(...strong.slice.map((c) => c.score)) >= DEFAULTS.strongThreshold);
  });

  it("near-miss only: synthesizes from the spec alone, and logs the reason", async () => {
    const client = scripted([{ text: fenced(nearMiss.reference) }]);
    const { rows, triggers } = await runAll({
      tasks: [nearMiss],
      client,
      options: { arms: ["fallback"] },
    });
    assert.equal(rows[0].turns, 1);
    assert.equal(rows[0].pass, true);
    assert.equal(rows[0].decision, "synthesize");
    assert.equal(client.prompts[0].includes("Kept work"), false);
    assert.deepEqual(triggers, [
      { task: "clamp", seed: 0, reason: "near-miss-only", bestScore: 0.4 },
    ]);
  });

  it("a strong match composes from the slice, and a clean reply triggers nothing", async () => {
    const client = scripted([{ text: fenced(strong.reference) }]);
    const { rows, triggers } = await runAll({
      tasks: [strong],
      client,
      options: { arms: ["fallback"] },
    });
    assert.equal(rows[0].turns, 1);
    assert.equal(rows[0].decision, "compose");
    assert.equal(rows[0].trigger, null);
    assert.match(client.prompts[0], /Kept work/);
    assert.deepEqual(triggers, []);
  });

  it("a closure hole triggers one repair turn that names the missing names", async () => {
    const holed =
      "export function addDurations(a: string, b: string): string { return fmtShort(parse(a) + parse(b)); }";
    const client = scripted([{ text: fenced(holed) }, { text: fenced(strong.reference) }]);
    const { rows, triggers, triggerCounts } = await runAll({
      tasks: [strong],
      client,
      options: { arms: ["fallback"] },
    });
    assert.equal(rows[0].turns, 2);
    assert.equal(rows[0].pass, true);
    assert.equal(rows[0].inputTokens, 20);
    assert.deepEqual(triggers[0].holes, ["fmtShort", "parse"]);
    assert.equal(triggers[0].reason, "unexplained-residual");
    assert.match(client.prompts[1], /uses names that nothing defines: fmtShort, parse/);
    assert.deepEqual(triggerCounts.byReason, { "unexplained-residual": 1 });
  });

  it("a refusal or a truncated reply fails with its stop reason and is not read as a hole", async () => {
    for (const stopReason of ["refusal", "max_tokens"]) {
      const client = scripted([{ text: "export function addDurations(", stopReason }]);
      const { rows } = await runAll({
        tasks: [strong],
        client,
        options: { arms: ["fallback", "slice"] },
      });
      for (const r of rows) {
        assert.equal(r.pass, false);
        assert.equal(r.error, `stop_reason: ${stopReason}`);
        assert.equal(r.turns, 1);
      }
    }
  });

  it("the gap is measured without the held-out check", () => {
    assert.deepEqual(closureHoles(strong.reference), []);
    assert.deepEqual(closureHoles("export const f = () => helper(Buffer)"), ["Buffer", "helper"]);
  });

  it("trigger counts add up to the fallback rows", () => {
    const rows = [
      { arm: "fallback", trigger: null },
      { arm: "fallback", trigger: { reason: "near-miss-only" } },
      { arm: "fallback", trigger: { reason: "unexplained-residual" } },
      { arm: "slice", trigger: undefined },
    ];
    assert.deepEqual(tallyTriggers(rows), {
      rows: 3,
      byReason: { none: 1, "near-miss-only": 1, "unexplained-residual": 1 },
      synthesisRate: 2 / 3,
    });
  });
});

describe("source-spread fill on and off (#1271)", () => {
  it("records both candidate sets for every task", async () => {
    const { selections, rows } = await runAll({
      tasks,
      client: offlineClient(byId),
      options: { arms: ["slice", "slice-fill"] },
    });
    assert.equal(selections.length, tasks.length);
    for (const s of selections) {
      assert.equal(s.rank.mode, "rank");
      assert.equal(s.fill.mode, "fill");
    }
    assert.deepEqual(new Set(rows.map((r) => r.selection)), new Set(["rank", "fill"]));
  });

  it("build-order at a 600-token budget: the fill caps toposort and admits another package", () => {
    const task = byId["build-order"];
    const o = { tokenBudget: 600, maxPackageShare: 0.5 };
    const rank = selectionFor(task, { ...o, fill: false }).ctx;
    const fill = selectionFor(task, { ...o, fill: true }).ctx;
    assert.deepEqual(Object.keys(rank.byPackage), ["toposort-2.0.2"]);
    assert.ok(rank.selected.some((c) => c.id === "topo-toposort"));
    assert.ok(fill.byPackage["toposort-2.0.2"] <= 300);
    assert.ok(fill.selected.some((c) => c.sourcePkg !== "toposort-2.0.2"));
    // The cost of spreading here: the needed atom that does the sorting is dropped.
    assert.ok(fill.dropped.includes("topo-toposort"));
  });

  it("at the default budget the two selections agree on every task", () => {
    for (const task of tasks) {
      const a = selectionFor(task, { ...DEFAULTS, fill: false }).ctx.selected.map((c) => c.id);
      const b = selectionFor(task, { ...DEFAULTS, fill: true }).ctx.selected.map((c) => c.id);
      assert.deepEqual(b, a, task.id);
    }
  });
});

describe("run plan and break-even (#1258)", () => {
  it("the dry-run plan counts calls per arm and seed", () => {
    const one = planRun({ tasks, options: { arms: ["scratch"], seeds: 1 } });
    const three = planRun({ tasks, options: { arms: ["scratch"], seeds: 3 } });
    assert.equal(one.maxCalls, tasks.length);
    assert.equal(three.maxCalls, 3 * tasks.length);
    assert.deepEqual(planRun({ tasks }).arms, [...ARMS]);
  });

  it("seeds repeat every arm and are tagged", async () => {
    const { rows } = await runAll({
      tasks: [byId.clamp],
      client: offlineClient(byId),
      options: { seeds: 3 },
    });
    assert.equal(rows.length, 3 * ARMS.length);
    assert.deepEqual([...new Set(rows.map((r) => r.seed))], [0, 1, 2]);
  });

  it("break-even: n* = ceil(S / saving), and never when an arm costs more", () => {
    const summary = {
      scratch: { meanTokens: 100, passRate: 0.5, passes: 1, inputTokens: 150, outputTokens: 50 },
      slice: { meanTokens: 60, passRate: 1, passes: 2, inputTokens: 100, outputTokens: 20 },
      worse: { meanTokens: 150, passRate: 1, passes: 2, inputTokens: 250, outputTokens: 50 },
    };
    const be = breakEven(summary, { setupGrid: [0, 100, 1000] });
    assert.equal(be.slice.savingPerTask, 40);
    assert.deepEqual(be.slice.nStarByTask, { 0: 0, 100: 3, 1000: 25 });
    // Per passing task: scratch 200, slice 60.
    assert.equal(be.slice.savingPerPass, 140);
    assert.deepEqual(be.worse.nStarByTask, { 0: null, 100: null, 1000: null });
  });
});
