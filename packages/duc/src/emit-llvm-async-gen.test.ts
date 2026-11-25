// SPDX-License-Identifier: Apache-2.0
/**
 * Async generators in the native runtime (ECMA-262 27.6; Node's library uses them: #1331): each
 * program runs natively and is compared with Node, the job order included.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-agen-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const PROGRAMS: [string, string][] = [
  [
    "awaits and yields; next() calls queued before the first settles; for await over it",
    `export async function f(n) {
      const log = [];
      async function* count(k) {
        for (let i = 0; i < k; i++) {
          const v = await Promise.resolve(i * 10);
          log.push("made " + v);
          yield v + n;
        }
        return "end" + k;
      }
      const g = count(3);
      const p1 = g.next(), p2 = g.next(), p3 = g.next(), p4 = g.next(), p5 = g.next();
      log.push("asked");
      const rs = await Promise.all([p1, p2, p3, p4, p5]);
      const seen = [];
      for await (const x of count(2)) seen.push(x);
      return [log, rs.map((r) => [r.value, r.done]), seen];
    }`,
  ],
  [
    "return() and throw(): before it starts, at a yield (finally runs), after it is done",
    `export async function f(n) {
      const log = [];
      async function* g() {
        try {
          yield 1;
          yield 2;
        } catch (e) {
          log.push("caught " + e);
          yield "after-catch";
        } finally {
          log.push("finally");
        }
      }
      const a = g();
      const r1 = await a.return(n);
      const r2 = await a.next();
      const b = g();
      await b.next();
      const r3 = await b.throw("boom" + n);
      const r4 = await b.next();
      const c = g();
      await c.next();
      const r5 = await c.return("early");
      let r6;
      try { await g().throw(new Error("first")); } catch (e) { r6 = "rejected " + e.message; }
      return [log, [r1, r2, r3, r4, r5].map((r) => [r.value, r.done]), r6];
    }`,
  ],
  [
    "for await with break closes it; an error thrown inside rejects; yield* of a sync iterable",
    `export async function f(n) {
      const log = [];
      async function* g() {
        try {
          yield* [1, Promise.resolve(2), 3];
          yield 4;
        } finally {
          log.push("closed");
        }
      }
      const got = [];
      for await (const x of g()) {
        got.push(x);
        if (x === n) break;
      }
      async function* bad() {
        yield "ok";
        throw new TypeError("bad " + n);
      }
      const b = bad();
      const first = await b.next();
      let err;
      try { await b.next(); } catch (e) { err = e.name + ": " + e.message; }
      const after = await b.next();
      return [got, log, first.value, err, after.done];
    }`,
  ],
  [
    "for await over an object's [Symbol.asyncIterator], and over its [Symbol.iterator]",
    `export async function f(n) {
      const log = [];
      const asyncRange = { [Symbol.asyncIterator]() { let i = 0; return { next: async () => { await null; return i < n ? { value: i++, done: false } : { done: true }; }, return: async () => { log.push("closed"); return { done: true }; } }; } };
      const syncRange = { [Symbol.iterator]() { let i = 0; return { next: () => (i < 3 ? { value: Promise.resolve(i++ * 10), done: false } : { done: true }) }; } };
      const a = [];
      for await (const x of asyncRange) a.push(x);
      for await (const x of asyncRange) { if (x === 1) break; }
      const b = [];
      for await (const x of syncRange) b.push(x);
      return [a, b, log];
    }`,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("async generators, natively", () => {
  for (const [name, source] of PROGRAMS)
    it(name, async () => {
      const inputs = [[2], [3], [9]];
      const ref = new Function(`${source.replace(/^export /, "")}; return f;`)() as (
        ...a: unknown[]
      ) => Promise<unknown>;
      const run = harness(emitLlvmBoxed(liftAtom(source)), work);
      const { results, stderr } = run(inputs);
      expect(results.length, stderr).toBe(inputs.length);
      for (const [i, args] of inputs.entries()) {
        const want = await ref(...args);
        expect(
          same(results[i], want),
          `${JSON.stringify(args)}: native ${JSON.stringify(results[i])}, node ${JSON.stringify(want)}`,
        ).toBe(true);
      }
    }, 300_000);
});
