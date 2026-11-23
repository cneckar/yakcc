import assert from "node:assert/strict";
import { dirname, join } from "node:path";
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt, extractCode, loadTasks, runArm, scoreSolution, summarize } from "./lib.mjs";
import { offlineClient } from "./offline-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tasks = loadTasks(join(here, "..", "tasks"));
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

describe("held-out scoring", () => {
  for (const task of tasks) {
    it(`the reference solution passes ${task.id}`, () => {
      assert.equal(scoreSolution(task, task.reference).pass, true);
    });
  }
  it("a wrong solution fails", () => {
    const wrong = "export function chunk(items, size) { return [items]; }";
    assert.equal(scoreSolution(byId.chunk, wrong).pass, false);
  });
  it("a solution that does not transpile fails with a reason", () => {
    const r = scoreSolution(byId.clamp, "export function clamp( {");
    assert.equal(r.pass, false);
    assert.match(r.error, /transpile|load/);
  });
  it("a solution missing the entry name fails", () => {
    assert.match(
      scoreSolution(byId["safe-filename"], "export function other() {}").error,
      /no exported function/,
    );
  });
  it("the sandbox has no access to the host process", () => {
    const probe =
      "export function clamp(v, lo, hi) { if (typeof process !== 'undefined') throw new Error('host visible'); return v; }";
    assert.doesNotMatch(scoreSolution(byId.clamp, probe).error ?? "", /host visible/);
  });
});

describe("every task rejects a trivially wrong answer", () => {
  for (const task of tasks) {
    it(`${task.id} rejects a stub that returns null`, () => {
      const stub = `export function ${task.entry}() { return null; }`;
      assert.equal(scoreSolution(task, stub).pass, false);
    });
  }
});

describe("prompting and extraction", () => {
  it("the scratch arm gets no retrieved context", () => {
    const p = buildPrompt(byId.clamp, "scratch", byId.clamp.slice);
    assert.equal(p.includes("Kept work"), false);
  });
  it("the slice arm lists each candidate with its citation", () => {
    const p = buildPrompt(byId.clamp, "slice", byId.clamp.slice);
    assert.match(p, /shadow-utils\/numbers\.ts:2-2/);
  });
  it("extractCode takes the fenced block, or the whole text when unfenced", () => {
    assert.equal(extractCode("here\n```ts\nexport const a = 1;\n```\nbye"), "export const a = 1;");
    assert.equal(extractCode("export const b = 2;"), "export const b = 2;");
  });
});

describe("arms and aggregation", () => {
  it("the offline client round-trips every task through every arm", async () => {
    const client = offlineClient(byId);
    for (const task of tasks) {
      const row = await runArm({ arm: "scratch", task, client, slice: [] });
      assert.equal(row.pass, true, `${task.id}: ${row.error}`);
      assert.ok(row.inputTokens > 0 && row.outputTokens > 0);
    }
  });
  it("summarize aggregates pass rate and mean tokens per arm", () => {
    const s = summarize([
      { arm: "a", pass: true, inputTokens: 10, outputTokens: 2, ms: 4 },
      { arm: "a", pass: false, inputTokens: 6, outputTokens: 2, ms: 2 },
    ]);
    assert.equal(s.a.passRate, 0.5);
    assert.equal(s.a.meanTokens, 10);
    assert.equal(s.a.meanMs, 3);
  });
});
