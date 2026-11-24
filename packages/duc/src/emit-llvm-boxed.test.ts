// SPDX-License-Identifier: Apache-2.0
// The native lowering beyond the typed subset (#1292, DEC-DUC-NATIVE-RUNTIME-001): NaN-boxed values
// and the runtime. Each program is lifted, lowered to LLVM IR, compiled by llc, linked with the
// runtime (compiled by clang) into a C harness, and run on generated inputs of every value kind
// the slice covers; its results must be the source's, as Node computes them, exactly. One program
// also runs on AArch64, ARMv7 and RISC-V under QEMU.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { LlvmEmitError } from "./emit-llvm.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-boxed-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Every value kind the slice covers, with the awkward ones each coercion has. */
const scalar = fc.oneof(
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1e21,
    1e21,
    0.1,
    1e-7,
    123e-20,
    2 ** 53,
  ),
  fc.string({ maxLength: 6 }),
  fc.string({ unit: "binary", maxLength: 4 }),
  fc.constantFrom(
    "",
    " ",
    " 12 ",
    "0x1F",
    "0b101",
    "0o17",
    "1e3",
    "-0",
    "Infinity",
    "-Infinity",
    "12px",
    ".5",
    "5.",
    "+.5e-3",
    " 12 ",
    "a",
    "abc",
    "ab,c",
  ),
  fc.boolean(),
  fc.constantFrom(null, undefined),
);
const value = fc.oneof(
  { weight: 4, arbitrary: scalar },
  { weight: 1, arbitrary: fc.array(scalar, { maxLength: 4 }) },
);

/** The source as Node runs it. */
function reference(source: string): (...a: unknown[]) => unknown {
  return new Function(`${source.replace(/^export /, "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
}

/** Runs the program natively and in Node on the same inputs; returns the disagreements. */
function disagreements(
  source: string,
  inputs: readonly unknown[][],
  target = "x86_64-linux",
): string[] {
  const run = harness(emitLlvmBoxed(liftAtom(source)), work, target);
  // The reference may throw (a method on a value without it): those inputs are not compared here.
  const ref = reference(source);
  const kept: { args: unknown[]; want: unknown }[] = [];
  for (const args of inputs) {
    try {
      kept.push({ args: structuredClone(args), want: ref(...structuredClone(args)) });
    } catch {}
  }
  const { results, stderr } = run(kept.map((k) => k.args));
  if (results.length !== kept.length) return [`ran ${results.length} of ${kept.length}: ${stderr}`];
  return kept.flatMap((k, i) =>
    same(results[i], k.want)
      ? []
      : [
          `${JSON.stringify(k.args)} → native ${JSON.stringify(results[i])}, node ${JSON.stringify(k.want)}`,
        ],
  );
}

const PROGRAMS: [string, string, number][] = [
  // + with ToPrimitive, string concatenation and Number::toString's shortest digits.
  ["+ on every pair of kinds", "export function f(a, b) { return a + b; }", 2],
  [
    "the other operators and their coercions",
    "export function f(a, b) { return [a == b, a === b, a != b, a < b, a >= b, a > b, a <= b, typeof a, !a, a - b, a * b, a / b, a % b, -a, +b, a && b, a || b]; }",
    2,
  ],
  [
    "template literals and number formatting",
    "export function f(a, b) { return `${a}|${b}|${a / 3}|${b * 1e21}|${a * 1e-7}`; }",
    2,
  ],
  [
    "strings: length, index, charCodeAt, slice, indexOf",
    "export function f(s, i) { if (typeof s !== 'string') return null; return [s.length, s[i], s.charCodeAt(i), s.slice(i), s.slice(-2, i), s.indexOf('a', i), s.indexOf(s.slice(1))]; }",
    2,
  ],
  [
    "arrays: a loop, push, index, join, indexOf, slice",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const out = []; let i = 0; while (i < xs.length) { out.push(xs[i] + v); i = i + 1; } out.push(xs.length); return [out.join('|'), out.indexOf(v), out.slice(-2), out[0], out[99], xs.join()]; }",
    2,
  ],
  [
    "the exact Math on any value",
    "export function f(a, b) { return [Math.floor(a), Math.round(a), Math.sign(b), Math.min(a, b), Math.max(a, b, -0), Math.abs(a), Math.trunc(b), Math.sqrt(a)]; }",
    2,
  ],
  [
    "objects: literals, computed keys, reads and writes, own methods with this",
    "export function f(a, b) { const k = typeof a === 'string' ? a : 'z'; const o = { x: a, [k]: b, n: 0, bump() { this.n = this.n + 1; return this; } }; o.y = o.x + b; o[b] = 1; o.bump().bump(); return [o, o.n, o.missing, o[k], o.y == a + b]; }",
    2,
  ],
  [
    "closures: captures, a counter cell, recursion, functions as values",
    "export function f(a, b) { let count = 0; const add = (x) => { count = count + 1; return x + a; }; const fact = (n) => (n > 1 ? n * fact(n - 1) : 1); const pick = typeof b === 'number' ? add : fact; return [add(b), add(add(1)), count, fact(6), pick(3), typeof pick, add]; }",
    2,
  ],
  [
    "array callbacks: map, filter, reduce, some, every, find, findIndex, includes, sort",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const ns = xs.map((x, i) => (typeof x === 'number' && x === x ? x : i)); return [ns.filter((x) => x > 0), ns.reduce((s, x) => s + x, v), ns.some((x) => x === v), ns.every((x) => x === x), ns.find((x) => x < 0), ns.findIndex((x) => x > 1), xs.includes(v), ns.slice().sort((p, q) => p - q), xs.map(String).sort()]; }",
    2,
  ],
  [
    "strings: split, includes, startsWith, endsWith, trim",
    "export function f(s, t) { if (typeof s !== 'string') return null; const u = typeof t === 'string' ? t : 'a'; return [s.split(u), s.split(''), s.split(), s.includes(u), s.startsWith(u), s.endsWith(u), s.trim(), s.split(u).join('+')]; }",
    2,
  ],
  [
    "valueOf and toString an object defines",
    "export function f(a, b) { const v = { valueOf() { return a; } }; const t = { toString() { return 'T' + b; } }; return [v + 1, `${t}`, t + '', v == a, v < 5, String(1) + t]; }",
    2,
  ],
  [
    "classes: constructor, methods, getters and setters, statics, class-self, instanceof",
    "export function f(a, b) { class Acc { constructor(x) { this.x = x; this.log = []; } get twice() { return this.x * 2; } set twice(v) { this.x = v / 2; } add(y) { this.x = this.x + y; this.log.push(y); return this; } static of(v) { return new Acc(v); } } const acc = Acc.of(typeof a === 'number' ? a : 1).add(1).add(2); acc.twice = 10; return [acc.x, acc.twice, acc.log, acc instanceof Acc, typeof Acc, Object.keys(acc)]; }",
    2,
  ],
  [
    "ES5 constructors and prototypes",
    "export function f(a, b) { function Pt(x, y) { this.x = x; this.y = y; } Pt.prototype.sum = function () { return this.x + this.y; }; Pt.prototype.kind = 'pt'; const p = new Pt(a, b); return [p.sum(), p.kind, p instanceof Pt, Object.keys(p), p.missing]; }",
    2,
  ],
  [
    "spread: arrays, calls, objects; accessors in literals; delete",
    "export function f(a, b) { const xs = [a, ...(typeof b === 'string' ? b : [b]), a]; const join = (...parts) => parts.join('/'); const o = { first: 1, ...(typeof b === 'object' && b !== null ? b : {}), last: a, get both() { return [this.first, this.last]; } }; delete o.first; delete o['nope']; return [xs, join(...xs), xs.length, Object.keys(o), o.both, Math.max(...xs.filter((x) => typeof x === 'number'), -1)]; }",
    2,
  ],
  [
    "derived classes: super calls, super getters, static super, super in an arrow, default constructors (#1294)",
    "export function f(a, b) { class Shape { constructor(n) { this.n = n; } area() { return 0; } describe() { return this.n + ':' + this.area(); } get label() { return 'shape ' + this.n; } static make(n) { return new this(n); } } class Sq extends Shape { constructor(s) { super('sq'); this.s = s; } area() { return this.s * this.s; } describe() { return '[' + super.describe() + ']'; } get label() { return super.label + '!'; } static make(s) { return super.make(s * 2); } } class Big extends Sq { area() { const up = () => super.area() * 10; return up(); } } class Plain extends Shape {} const q = new Sq(a); const g = new Big(b); const p = new Plain(a); return [q.describe(), q.label, g.describe(), g.label, g instanceof Sq, g instanceof Shape, q instanceof Big, Sq.make(3).s, Big.make(2).area(), Object.keys(g), p.n, p.describe(), p instanceof Shape]; }",
    2,
  ],
  [
    "regular expressions: test, replace, match, split (the matcher read as ECMAScript, #1310)",
    "export function f(a, b) { const s = typeof a === 'string' ? a : String(a); const t = typeof b === 'string' ? b : 'x, y,z'; return [/^[0-9a-f]+$/.test(s), s.replace(/\\s+/g, ' ').trim(), s.replace(/[^A-Za-z0-9_]/g, '_'), (s.match(/[a-z]+/g) || []).length, t.split(/,\\s*/), -s.length]; }",
    2,
  ],
  [
    "an Error subclass: thrown, caught, its name, message and instanceof (#1294)",
    "export function f(a, b) { class Bad extends Error { constructor(m, code) { super(m); this.name = 'Bad'; this.code = code; } } class Worse extends Bad {} try { if (typeof a === 'number' && a > 0) throw new Worse('too big: ' + a, b); throw new Bad(String(a), 1); } catch (e) { return [e.message, e.name, e.code, e instanceof Bad, e instanceof Worse, e instanceof Error, e instanceof TypeError, String(e)]; } }",
    2,
  ],
  [
    "class fields, static fields and blocks, computed names, field order in a derived class (#1330)",
    "export function f(a, b) { const k = 'm' + typeof a; class P { base = 'p'; constructor(n) { this.n = n; } } class A extends P { x = 1; y = this.x + this.n; static z = 3; static { this.z = this.z + 10; } static after = A.z * 2; [k]() { return this.y; } get ['g' + 1]() { return this.base; } static ['s' + 1] = 4; ['a-b'] = 5; 7() { return 7; } constructor(n) { super(n === undefined ? 0 : String(n).length); this.c = this.y + 1; } } class B extends A { d = this.c * 10; } const o = new A(a); const q = new B(b); return [o[k](), o.g1, A.z, A.after, A.s1, o['a-b'], o[7](), Object.keys(o), Object.keys(q), q.d]; }",
    2,
  ],
  [
    "keys are evaluated at definition, in member order; initializers when an instance is made (#1330)",
    "export function f(a) { const log = []; class G { [(log.push('a'), 'a')] = log.push('init' + typeof a); static [(log.push('b'), 'b')] = log.push('static'); } const before = [...log]; new G(); return [before, log]; }",
    1,
  ],
  [
    "super[key], read and called, and o[k](..) with o as its receiver (#1330)",
    "export function f(a, b) { const kA = 'k' + typeof a; class P { [kA](n) { return n + this.base; } get g() { return 'pk' + this.base; } } class C extends P { constructor() { super(); this.base = typeof b; } [kA](n) { return super[kA](n) + '!'; } read(k) { return [super[k], (() => super[kA](1))()]; } } const c = new C(); const o = { base: 5, m(n) { return n + this.base; } }; const m = 'm'; return [c[kA](1), c.read('g'), o[m](1), o?.[m](2)]; }",
    2,
  ],
  [
    "a spread is copied where it is in order, before what follows writes the array (#1330)",
    "export function f(a, b) { const log = [a]; const before = [...log]; log.push(b); const after = [...log]; log.push(3); function* g() { yield a; yield b; } return [before, after, log.length, [0, ...g()], [...'ab']]; }",
    2,
  ],
  [
    "a try that yields, in a generator: next, throw and return reach its blocks, yield* passes them on (#1330)",
    "export function f(a, b) { const log = []; function* g(n) { try { for (let i = 0; i < n; i++) { const got = yield i; log.push('got ' + got); if (i === 2) throw new Error('two'); } } catch (e) { log.push('caught ' + e.message); yield -1; } finally { log.push('finally'); } return 'end'; } const k = typeof a === 'number' && a >= 0 && a < 6 ? Math.floor(a) : 4; const it = g(k); const out = []; let r = it.next(); while (!r.done) { out.push(r.value); r = it.next(b); } function* h() { try { yield 1; return 'early'; } catch (e) { yield 'c:' + e; } } const t = h(); const thrown = [t.next(), t.throw(b), t.next()]; function* inner() { try { yield 1; yield 2; } finally { log.push('inner done'); } } function* outer() { try { yield* inner(); } finally { log.push('outer done'); } } const o = outer(); o.next(); const ret = o.return(b); const brk = []; for (const x of outer()) { brk.push(x); break; } return [out, r.value, log, thrown, ret, brk]; }",
    2,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("boxed values, natively on this host (#1292)", () => {
  for (const [name, source, arity] of PROGRAMS) {
    it(`computes what Node computes: ${name}`, () => {
      const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
        numRuns: 500,
        seed: 1292,
      });
      expect(disagreements(source, inputs)).toEqual([]);
    }, 180_000);
  }
});

/** The async programs (#1295): Node's result awaited, a rejection as ["rejected", String(reason)]. */
const ASYNC_PROGRAMS: [string, string, number][] = [
  [
    "job order: interleaved awaits, then chains, queueMicrotask, all, allSettled, race, finally, a caught rejection",
    "export async function f(a, b) { const log = []; const t = async (name, n) => { log.push(name + 0); for (let i = 1; i <= n; i++) { await null; log.push(name + i); } return name; }; const p1 = t('a', typeof a === 'number' ? ((a % 3) + 3) % 3 : 1); const p2 = t('b', 2); Promise.resolve(1).then(() => log.push('then1')).then(() => log.push('then2')); queueMicrotask(() => log.push('micro')); const both = await Promise.all([p1, p2, 7]); const settled = await Promise.allSettled([Promise.reject(new Error('x' + b)), Promise.resolve(b)]); const raced = await Promise.race([new Promise((r) => r('slow')), 'fast']); const fin = await Promise.resolve(5).finally(() => log.push('fin')); let caught; try { await Promise.reject(new TypeError('no ' + b)); } catch (e) { caught = String(e); } return [log, both, settled.map((x) => x.status + ':' + (x.status === 'fulfilled' ? x.value : String(x.reason))), raced, fin, caught]; }",
    2,
  ],
  [
    "thenables and an async function returning a promise take the jobs the specification gives them",
    "export async function f(a) { const log = []; const inner = async () => { log.push('in'); return Promise.resolve(a); }; const thenable = { then(res) { log.push('thenable'); res(typeof a); } }; const p = inner().then((v) => log.push('inner:' + v)); const q = (async () => { const v = await thenable; log.push('after ' + v); })(); Promise.resolve().then(() => log.push('t1')).then(() => log.push('t2')).then(() => log.push('t3')).then(() => log.push('t4')); await Promise.all([p, q]); return log; }",
    1,
  ],
  [
    "a rejection: thrown in an async function, before and after an await",
    "export async function f(a) { const early = async () => { throw new RangeError('early ' + a); }; const late = async () => { await 1; throw new Error('late ' + typeof a); }; const r1 = await early().catch((e) => 'caught ' + e.message); if (typeof a === 'number' && a > 0) await late(); return r1; }",
    1,
  ],
  [
    "for await over a sync iterable: each element awaited; a rejection caught; a break closes a generator (#1330)",
    "export async function f(a, b) { const log = []; Promise.resolve().then(() => log.push('tick')); for await (const x of [Promise.resolve(a), b, new Promise((r) => r('three'))]) log.push(x); try { for await (const x of [1, Promise.reject(new Error('no ' + typeof a))]) log.push(x); } catch (e) { log.push(e.message); } function* g() { try { yield 1; yield Promise.resolve(2); yield 3; } finally { log.push('closed'); } } let n = 0; for await (const x of g()) { if (x === 3) break; n += x; } return [log, n]; }",
    2,
  ],
  [
    "a limiter in the style of p-limit: tasks queued past the concurrency, started as others finish",
    "export async function f(c, n) { const concurrency = typeof c === 'number' && c >= 1 && c < 5 ? Math.floor(c) : 2; const count = typeof n === 'number' && n >= 0 && n < 8 ? Math.floor(n) : 4; const log = []; const queue = []; let active = 0; const next = () => { active--; if (queue.length > 0) queue.shift()(); }; const run = async (fn, resolve) => { active++; const result = (async () => fn())(); resolve(result); await result.then(() => {}, () => {}); next(); }; const limit = (fn) => new Promise((resolve) => { const go = () => run(fn, resolve); if (active < concurrency) go(); else queue.push(go); }); const job = (i) => limit(async () => { log.push('start' + i); for (let k = 0; k < (i % 3) + 1; k++) await null; log.push('end' + i); if (i === 2) throw new Error('job' + i); return i * 10; }); const all = []; for (let i = 0; i < count; i++) all.push(job(i)); const settled = await Promise.allSettled(all); return [log, settled.map((x) => (x.status === 'fulfilled' ? x.value : x.reason.message))]; }",
    2,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("async functions and promises, natively (#1295)", () => {
  for (const [name, source, arity] of ASYNC_PROGRAMS) {
    it(`computes what Node computes: ${name}`, async () => {
      const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
        numRuns: 200,
        seed: 1295,
      });
      const run = harness(emitLlvmBoxed(liftAtom(source)), work);
      const ref = reference(source);
      const wants: unknown[] = [];
      for (const args of inputs) {
        try {
          wants.push(await (ref(...structuredClone(args)) as Promise<unknown>));
        } catch (e) {
          wants.push(["rejected", String(e)]);
        }
      }
      const { results, stderr } = run(inputs.map((args) => structuredClone(args)));
      expect(stderr).toBe("");
      const bad = inputs.flatMap((args, i) =>
        same(results[i], wants[i])
          ? []
          : [
              `${JSON.stringify(args)} → native ${JSON.stringify(results[i])}, node ${JSON.stringify(wants[i])}`,
            ],
      );
      expect(bad).toEqual([]);
    }, 180_000);
  }

  it("computes what Node computes: generators, yield*, next(v), return(), throw(), spread and Array.from", () => {
    const source =
      "export function f(n, s) { function* range(k) { for (let i = 0; i < k; i++) { const back = yield i * 2; if (back === 'stop') return 'stopped'; } return 'done'; } function* outer() { const r = yield* range(3); yield r; yield* ['x', 'y']; } const k = typeof n === 'number' && n >= 0 && n < 20 ? Math.floor(n) : 2; const g = range(k); const steps = []; let r = g.next(); while (!r.done) { steps.push(r.value); r = g.next(r.value > 2 ? 'stop' : s); } steps.push(r.value); const h = range(5); h.next(); const ret = h.return('early'); const after = h.next(); const t = range(5); t.next(); let threw; try { t.throw(new Error('boom')); } catch (e) { threw = e.message; } const fresh = range(2); const unstarted = fresh.return('never'); return [steps, [...range(k)], [...outer()], ret, after, threw, Array.from(range(3)), unstarted, fresh.next()]; }";
    const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
      numRuns: 300,
      seed: 1295,
    });
    expect(disagreements(source, inputs)).toEqual([]);
  }, 180_000);
});

describe("boxed values on other architectures, under QEMU (#1292)", () => {
  const source = PROGRAMS[4]?.[1] as string;
  for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"])
    it.skipIf(!canRun(target))(
      `${target}: the array program computes what Node computes`,
      () => {
        const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
          numRuns: 150,
          seed: 7,
        });
        expect(disagreements(source, inputs, target)).toEqual([]);
      },
      180_000,
    );
  for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"])
    it.skipIf(!canRun(target))(
      `${target}: async functions run as coroutines, in Node's job order (#1295)`,
      async () => {
        const source = ASYNC_PROGRAMS[0]?.[1] as string;
        const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
          numRuns: 40,
          seed: 9,
        });
        const run = harness(emitLlvmBoxed(liftAtom(source)), work, target);
        const ref = reference(source);
        const wants: unknown[] = [];
        for (const args of inputs)
          wants.push(await (ref(...structuredClone(args)) as Promise<unknown>));
        const { results, stderr } = run(inputs.map((args) => structuredClone(args)));
        expect(stderr).toBe("");
        expect(results.every((r, i) => same(r, wants[i]))).toBe(true);
      },
      180_000,
    );
});

describe("what the boxed lowering refuses, for now (#1292)", () => {
  const refusal = (source: string): string => {
    try {
      emitLlvmBoxed(liftAtom(source));
    } catch (e) {
      if (e instanceof LlvmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("free names, new, async generators, private names, array holes, approximated Math", () => {
    expect(refusal("export function f(x) { return helper(x); }")).toMatch(
      /"helper" is not in the native base set/,
    );
    expect(refusal("export function f(x) { return new Date(); }")).toMatch(
      /not in the native base set|not in the subset/,
    );
    expect(refusal("export function f(x) { async function* g() { yield x; } return g; }")).toMatch(
      /not in the subset/,
    );
    expect(
      refusal(
        "export function f(x) { class A { #y = 1; get y() { return this.#y; } } return new A().y + x; }",
      ),
    ).toMatch(/private name.*#y.*is not in the native subset yet/);
    expect(refusal("export function f(x) { return [, x]; }")).toMatch(/an array with holes/);
    expect(refusal("export function f(x) { return Math.sin(x); }")).toMatch(
      /implementation-approximated/,
    );
  });
});
