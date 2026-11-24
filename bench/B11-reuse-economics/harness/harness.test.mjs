// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURES, findDefinition } from "./build-tasks.mjs";
import {
  buildPrompt,
  clientView,
  entryName,
  extractCode,
  loadTasks,
  runArm,
  scoreSolution,
  summarize,
} from "./lib.mjs";
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
      const stub = `export function ${entryName(task)}() { return null; }`;
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

describe("task set (#1272)", () => {
  it("has at least twenty tasks, at least five of them multi-atom compositions", () => {
    assert.ok(tasks.length >= 20, `${tasks.length} tasks`);
    const composed = tasks.filter((t) => t.difficulty?.startsWith("compose"));
    assert.ok(composed.length >= 5, `${composed.length} composition tasks`);
    for (const t of composed) assert.ok(t.atoms.length >= 2, `${t.id} composes ${t.atoms.length}`);
  });
  it("every task has a difficulty class and a unique entry", () => {
    const classes = new Set(["single", "compose-2", "compose-3+"]);
    for (const t of tasks) assert.ok(classes.has(t.difficulty), `${t.id}: ${t.difficulty}`);
    for (const t of tasks.filter((x) => x.difficulty === "compose-2"))
      assert.equal(t.atoms.length, 2);
    for (const t of tasks.filter((x) => x.difficulty === "compose-3+"))
      assert.ok(t.atoms.length >= 3);
  });
  it("each composition task's atoms appear among its slice candidates", () => {
    for (const t of tasks.filter((x) => x.atoms)) {
      for (const atom of t.atoms) {
        const [pkg, rest] = atom.split(":");
        const [file, name] = rest.split("#");
        const hit = t.slice.some((c) => c.ref?.file === `${pkg}/${file}` && c.ref?.name === name);
        assert.ok(hit, `${t.id}: ${atom} is not in the slice`);
      }
    }
  });
  it("every corpus citation names the lines its text came from, unchanged", () => {
    for (const t of tasks) {
      for (const c of t.slice.filter((x) => x.ref)) {
        const file = readFileSync(join(FIXTURES, c.citation.sourceFile), "utf8");
        const span = findDefinition(file, c.ref.name);
        assert.deepEqual(
          [c.citation.lineStart, c.citation.lineEnd],
          [span.lineStart, span.lineEnd],
          `${t.id}/${c.id}`,
        );
        const text = file
          .split("\n")
          .slice(span.lineStart - 1, span.lineEnd)
          .join("\n");
        assert.equal(c.text, text, `${t.id}/${c.id} text`);
        const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
        assert.equal(c.citation.merkleRoot, `unregistered-sha256-${hash}`);
        assert.equal(c.sourcePkg, c.citation.sourceFile.split("/")[0]);
      }
    }
  });
});

describe("held-out isolation", () => {
  it("a client's view of a task has no held-out check", () => {
    for (const t of tasks)
      assert.deepEqual(Object.keys(clientView(t)).sort(), ["id", "reference", "spec"]);
  });
  it("the offline client never reads a held-out check", async () => {
    const guarded = Object.fromEntries(
      tasks.map((t) => {
        const copy = { ...t };
        Object.defineProperty(copy, "heldOut", {
          enumerable: true,
          get() {
            throw new Error(`the client read ${t.id}'s held-out check`);
          },
        });
        return [t.id, copy];
      }),
    );
    const client = offlineClient(guarded);
    for (const task of tasks) {
      const reply = await client.complete(buildPrompt(task, "slice", task.slice));
      assert.match(reply.text, /export function/);
    }
  });
  it("no prompt contains a held-out check", () => {
    for (const t of tasks) {
      for (const arm of ["scratch", "slice", "fallback"]) {
        assert.equal(buildPrompt(t, arm, t.slice).includes(t.heldOut), false, `${t.id}/${arm}`);
      }
    }
  });
  it("a candidate that never returns fails on the timeout instead of hanging the run", () => {
    const r = scoreSolution(byId.clamp, "export function clamp() { for (;;) {} }");
    assert.equal(r.pass, false);
    assert.match(r.error, /timed out/i);
  });
});

describe("held-out checks catch a naive reuse of the corpus atom", () => {
  it("days-between: Date.UTC maps years below 100 to 19xx", () => {
    const naive = `export function daysBetween(a: string, b: string): number {
      const t = (s: string) => { const [y, m, d] = s.split('-').map(Number); if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(s) || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) throw new RangeError(s); return Date.UTC(y, m - 1, d); };
      return Math.round((t(b) - t(a)) / 86400000); }`;
    const r = scoreSolution(byId["days-between"], naive);
    assert.equal(r.pass, false);
    assert.match(r.error, /0050|0000/);
  });
  it("memoize-lru: semver's LRUCache does not store undefined", () => {
    const naive = `class LRU { max: number; map = new Map(); constructor(max: number) { this.max = max; }
      get(k: unknown) { const v = this.map.get(k); if (v === undefined) return undefined; this.map.delete(k); this.map.set(k, v); return v; }
      set(k: unknown, v: unknown) { const had = this.map.delete(k); if (!had && v !== undefined) { if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); this.map.set(k, v); } } }
      export function memoizeLru(fn: (a: unknown) => unknown, max: number) {
        if (!Number.isInteger(max) || max < 1) throw new RangeError('max');
        const c = new LRU(max); const m = (a: unknown) => { const v = c.get(a); if (v !== undefined) return v; const r = fn(a); c.set(a, r); return r; };
        (m as any).size = () => c.map.size; return m; }`;
    const r = scoreSolution(byId["memoize-lru"], naive);
    assert.equal(r.pass, false);
    assert.match(r.error, /undefined is cached/);
  });
  it("suggest-words: closest() returns one match, not the ranked list", () => {
    const naive =
      "export function suggest(w: string, cs: string[], k: number) { return cs.length ? [cs[0]] : []; }";
    assert.equal(scoreSolution(byId["suggest-words"], naive).pass, false);
  });
});
