// SPDX-License-Identifier: Apache-2.0
/**
 * The native runtime's collector (#1361 P1): programs that allocate far more than they keep, run
 * natively with a collection every 64 KiB (YK_GC_STRESS), must give Node's results. A value the
 * collector's roots miss (a stack, a suspended coroutine's stack, a register, a global, a buffer
 * the runtime keeps) is freed while it is in use, and shows as a wrong result or a crash.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-gc-"));
const saved = { stress: process.env.YK_GC_STRESS, stats: process.env.YK_GC_STATS };
beforeAll(() => {
  process.env.YK_GC_STRESS = "1";
  process.env.YK_GC_STATS = "1";
});
afterAll(() => {
  if (saved.stress === undefined) Reflect.deleteProperty(process.env, "YK_GC_STRESS");
  else process.env.YK_GC_STRESS = saved.stress;
  if (saved.stats === undefined) Reflect.deleteProperty(process.env, "YK_GC_STATS");
  else process.env.YK_GC_STATS = saved.stats;
  rmSync(work, { recursive: true, force: true });
});

const PROGRAMS: [string, string, unknown[][]][] = [
  [
    "generators resumed from the main stack while it holds values in callee-saved registers (its loops' iterators and results)",
    `export function f(n) {
      const log = [];
      function* inner(k) { try { for (let i = 0; i < k; i++) yield { i, s: "v" + i }; } finally { log.push("inner " + k); } }
      function* outer(k) { try { yield* inner(k); } finally { log.push("outer " + k); } }
      const out = [];
      for (let round = 0; round < n; round++) {
        const it = inner(4);
        let r = it.next();
        while (!r.done) { out.push(r.value.s); r = it.next(); }
        for (const x of outer(3)) { out.push(x.i); if (!(x.i < 1)) break; }
      }
      return [out.length, out.slice(0, 12), log.slice(0, 6), log.length];
    }`,
    [[40], [200]],
  ],
  [
    "objects, strings, arrays, maps and sets made and dropped; a comparator that allocates",
    `export function f(n) {
      const keep = [];
      const seen = new Map();
      const tags = new Set();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const o = { id: i, name: "item-" + i, parts: [i, i * 2, "p" + (i % 7)], nested: { deep: [String(i)] } };
        const s = JSON.stringify(o);
        const back = JSON.parse(s);
        total += back.parts[1] + back.name.length + back.nested.deep[0].length;
        if (i % 97 === 0) keep.push(back);
        seen.set("k" + (i % 50), o);
        tags.add(o.parts[2]);
      }
      keep.sort((a, b) => (("" + b.name) < ("" + a.name) ? -1 : ("" + b.name) > ("" + a.name) ? 1 : a.id - b.id));
      const words = keep.map((o) => o.name.slice(5) + ":" + o.parts.join("-"));
      return [total, keep.length, words.slice(0, 5), seen.size, [...tags].sort(), seen.get("k3").name];
    }`,
    [[3000], [12000]],
  ],
  [
    "closures and classes with private fields, kept and dropped",
    `export function f(n) {
      class Box {
        #v;
        constructor(v) { this.#v = { v, label: "box" + v }; this.tag = [v]; }
        get v() { return this.#v.v; }
        label() { return this.#v.label + "/" + this.tag.join(","); }
      }
      const makers = [];
      for (let i = 0; i < 40; i++) {
        const base = { start: i, notes: ["n" + i] };
        makers.push((k) => new Box(base.start * 1000 + k));
      }
      let sum = 0;
      const out = [];
      for (let i = 0; i < n; i++) {
        const b = makers[i % 40](i);
        sum += b.v;
        if (i % 500 === 0) out.push(b.label());
      }
      return [sum, out];
    }`,
    [[5000], [20000]],
  ],
  [
    "generators suspended while the heap is collected",
    `export function f(n) {
      function* gen(k) {
        const held = { k, items: [] };
        for (let i = 0; i < n; i++) {
          held.items.push("g" + k + ":" + i);
          if (held.items.length > 8) held.items.shift();
          yield { at: i, last: held.items[held.items.length - 1], copy: held.items.slice() };
        }
        return held.items.join("|");
      }
      const gens = [];
      for (let k = 0; k < 12; k++) gens.push(gen(k));
      const trace = [];
      let done = 0;
      while (done < gens.length) {
        done = 0;
        for (const g of gens) {
          const r = g.next();
          if (r.done) { done++; continue; }
          if (r.value.at % 250 === 0) trace.push(r.value.last + "#" + r.value.copy.length);
        }
      }
      return trace;
    }`,
    [[600], [3000]],
  ],
  [
    "async functions and promises holding values across collections",
    `export async function f(n) {
      const log = [];
      async function step(i) {
        const v = await Promise.resolve({ i, text: "v" + i, list: [i, i + 1] });
        const w = await new Promise((res) => res(v.list.map((x) => "w" + x).join(",")));
        if (i % 100 === 0) log.push(v.text + "=" + w);
        return v.i;
      }
      let chain = Promise.resolve(0);
      for (let i = 0; i < n; i++) chain = chain.then((acc) => step(i).then((x) => acc + x));
      log.push("total " + (await chain));
      return log;
    }`,
    [[800], [2500]],
  ],
  [
    "regular expressions and string building",
    `export function f(n) {
      const re = /([a-z]+)-(\\d+)/g;
      let text = "";
      for (let i = 0; i < n; i++) text += "w" + "abcdefghijklmnopqrstuvwxyz"[i % 26] + "-" + i + " ";
      const found = [];
      let m;
      let count = 0;
      while ((m = re.exec(text)) !== null) {
        count++;
        if (count % 400 === 0) found.push(m[1] + "/" + m[2]);
      }
      return [count, found, text.split(" ").filter((w) => w.endsWith("7")).length];
    }`,
    [[2000], [6000]],
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("the collector, natively under stress (#1361)", () => {
  for (const [name, source, inputs] of PROGRAMS)
    it(name, async () => {
      const ref = new Function(`${source.replace(/^export /, "")}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const run = harness(emitLlvmBoxed(liftAtom(source)), work);
      const { results, stderr } = run(inputs);
      expect(results.length, stderr).toBe(inputs.length);
      for (const [i, args] of inputs.entries()) {
        const want = await ref(...args);
        expect(
          same(results[i], want),
          `${JSON.stringify(args)}: ${JSON.stringify(results[i])}`,
        ).toBe(true);
      }
      // The collector ran, many times.
      const collections = Number(/yk gc: (\d+) collections/.exec(stderr)?.[1] ?? "0");
      expect(collections).toBeGreaterThan(10);
    }, 600_000);
});
