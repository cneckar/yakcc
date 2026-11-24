// SPDX-License-Identifier: Apache-2.0
/**
 * Function forms Node's library uses (#1330): `arguments`, read in a function or captured by an
 * arrow inside one. Each lifts with no opaque summary, its TypeScript lowering computes what the
 * source computes, and the round trip holds.
 */
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { packGraph, unpackGraph } from "./store.js";
import type { DucGraph } from "./types.js";

/** Opaque summaries, and loops with no body the graph expresses. */
const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.kind === "loop" && n.loop === undefined ? [`loop ${n.id} with no body`] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

const run = (code: string): unknown =>
  (new Function(`${code.replace(/^export /m, "")}; return f;`)() as (...a: unknown[]) => unknown)(
    1,
    2,
    3,
  );

const CASES: [string, string][] = [
  [
    "the atom's own arguments",
    "export function f(a) { return [arguments.length, arguments[2], a]; }",
  ],
  [
    "a function expression's arguments, passed on",
    "export function f() { const g = function () { return Array.prototype.slice.call(arguments).join('-'); }; return g(4, 5, 6); }",
  ],
  [
    "an arrow reads the enclosing function's arguments",
    "export function f(a, b) { const h = () => arguments.length + a; return h(); }",
  ],
  [
    "a nested function has its own arguments",
    "export function f() { function inner() { return arguments.length; } return [inner(1, 2), arguments.length]; }",
  ],
  [
    "a method forwards its arguments with Reflect.apply, as Node's library does",
    "export function f() { const o = { m() { return Reflect.apply(Math.max, this, arguments); } }; return o.m(3, 9, 4); }",
  ],
];

describe("arguments (#1330)", () => {
  for (const [name, source] of CASES) {
    it(name, () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      expect(run(code), code).toEqual(run(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  it("a local named arguments is a local", () => {
    const g = liftAtom(
      "export function f() { const arguments_ = 1; let x = 2; return x + arguments_; }",
    );
    expect(opaque(g)).toEqual([]);
  });
});

describe("a return inside a switch inside a loop (#1330)", () => {
  const LOOPS: [string, string, unknown][] = [
    [
      "for, as Node's extname is written",
      "export function f(s) { for (let i = s.length - 1; i > 0; i--) { switch (s.charCodeAt(i)) { case 47: return ''; case 46: return s.slice(i); } } return ''; }",
      "a/b.txt",
    ],
    [
      "while",
      "export function f(s) { let i = 0; while (i < s.length) { switch (s[i]) { case 'a': return i; } i++; } return -1; }",
      "xxa",
    ],
    [
      "for-of, with a break that leaves the switch",
      "export function f(xs) { let n = 0; for (const x of xs) { switch (x) { case 1: n = n + 100; break; case 2: return n; } n = n + 1; } return n; }",
      [1, 1, 3, 2, 9],
    ],
    [
      "a return under an if inside a case, with statements after it in the case and after the switch",
      "export function f(t) { const out = []; for (let i = 0; i < t; i++) { switch (i % 3) { case 0: out.push('a'); break; case 1: if (i > 3) return out; out.push('b'); break; default: out.push('c'); } out.push(i); } return out; }",
      7,
    ],
  ];
  for (const [name, source, input] of LOOPS) {
    it(name, () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = (c: string): unknown =>
        (new Function(`${c.replace(/^export /m, "")}; return f;`)() as (x: unknown) => unknown)(
          input,
        );
      expect(go(code), code).toEqual(go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }
});

describe("a try with a return inside a loop (#1330)", () => {
  const LOOPS: [string, string, unknown][] = [
    [
      "a retry loop: return from the try, rethrow from the handler on the last pass",
      "export function f(t) { const tries = []; for (let i = 1; i <= t; i++) { try { tries.push(i); if (i < 3) throw new Error('again'); return [i * 2, tries]; } catch (e) { if (i === t) throw e; } } }",
      4,
    ],
    [
      "for-of: a return from the try, a handler that recovers, statements after the try",
      "export function f(xs) { let n = 0; for (const x of xs) { try { if (x < 0) return 'neg'; n += JSON.parse(x); } catch (e) { n += 100; } n++; } return n; }",
      ["1", "x", "2"],
    ],
    [
      "for-of, the return taken",
      "export function f(xs) { let n = 0; for (const x of xs) { try { if (x < 0) return 'neg'; n += JSON.parse(x); } catch (e) { n += 100; } n++; } return n; }",
      ["1", -1, "2"],
    ],
    [
      "while: a return from the handler",
      "export function f(t) { let i = 0; while (i < t) { i++; try { if (i === 2) throw new Error('two'); } catch (e) { return e.message + i; } } return 'none'; }",
      5,
    ],
    [
      "a finally that runs on the return",
      "export function f(t) { const log = []; for (let i = 0; i < t; i++) { try { if (i === 1) return log; log.push('t' + i); } finally { log.push('f' + i); } } return log; }",
      3,
    ],
  ];
  for (const [name, source, input] of LOOPS) {
    it(name, () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = (c: string): unknown =>
        (
          new Function(`${runnable(c).replace(/^export /m, "")}; return f;`)() as (
            x: unknown,
          ) => unknown
        )(input);
      expect(go(code), code).toEqual(go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  it("a break that leaves the try is not lifted yet", () => {
    const g = liftAtom(
      "export function f(xs) { let n = 0; for (const x of xs) { try { if (x) break; n++; } catch (e) {} } return n; }",
    );
    expect(opaque(g).length).toBeGreaterThan(0);
  });
});

describe("closures over a for loop's per-pass binding, and destructuring in a try (#1330)", () => {
  const CASES: [string, string, unknown][] = [
    [
      "each closure holds its own pass's value",
      "export function f(t) { const fs = []; for (let i = 0; i < t; i++) { fs.push(() => i); } return fs.map((g) => g()); }",
      3,
    ],
    [
      "a callback in the body, as Node's SafePromiseAllReturnArrayLike writes it",
      "export function f(xs) { const out = []; for (let i = 0; i < xs.length; i++) { const x = xs[i]; xs.forEach((y) => { out[i] = (out[i] ?? 0) + x * y; }); } return out; }",
      [1, 2],
    ],
    [
      "two header bindings, and a continue",
      "export function f(t) { const fs = []; for (let i = 0, j = 10; i < t; i++, j--) { if (i === 1) continue; fs.push(() => [i, j]); } return fs.map((g) => g()); }",
      4,
    ],
    [
      "a destructuring assignment of an outer name inside a try",
      "export function f(o) { let s; try { ({ source: s } = o); } catch { s = 'none'; } return s; }",
      { source: "v" },
    ],
  ];
  for (const [name, source, input] of CASES) {
    it(name, () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = (c: string): unknown =>
        (
          new Function(`${runnable(c).replace(/^export /m, "")}; return f;`)() as (
            x: unknown,
          ) => unknown
        )(input);
      expect(go(code), code).toEqual(go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  it("a write to the binding in the body, a var header, or a write in the closure stays a summary", () => {
    for (const source of [
      "export function f(t) { const fs = []; for (let i = 0; i < t; i++) { fs.push(() => i); i++; } return fs; }",
      "export function f(t) { const fs = []; for (var i = 0; i < t; i++) { fs.push(() => i); } return fs; }",
      "export function f(t) { const fs = []; for (let i = 0; i < t; i++) { fs.push(() => i++); } return fs; }",
    ])
      expect(opaque(liftAtom(source)).length, source).toBeGreaterThan(0);
  });
});

describe("a try that yields, in a generator (#1330)", () => {
  // Each returns what a consumer saw, so the source and its lowering are compared by behaviour.
  const CASES: [string, string][] = [
    [
      "next sends into the try; a throw inside is caught; the finally runs",
      "export function f() { const log = []; function* g(n) { try { for (let i = 0; i < n; i++) { const got = yield i; log.push('got ' + got); if (i === 2) throw new Error('two'); } } catch (e) { log.push('caught ' + e.message); yield -1; } finally { log.push('finally'); } return 'end'; } const it = g(5); const out = [it.next().value, it.next('a').value, it.next('b').value, it.next('c').value, it.next('d')]; return [out, log]; }",
    ],
    [
      "a consumer that stops early runs the finally",
      "export function f() { const log = []; function* g() { try { yield 1; yield 2; yield 3; } finally { log.push('cleanup'); } } const out = []; for (const x of g()) { out.push(x); if (x === 2) break; } return [out, log]; }",
    ],
    [
      "throw() reaches the handler; a return inside the try returns",
      "export function f() { function* g() { try { yield 1; return 'early'; } catch (e) { yield 'c:' + e; } } const it = g(); return [it.next(), it.throw('boom'), it.next()]; }",
    ],
    [
      "a finally that yields",
      "export function f() { function* g() { try { yield 1; return 'early'; } finally { yield 'f'; } } return [...g()]; }",
    ],
    [
      "an async generator, as Node's stream iterators write it",
      "export async function f() { const log = []; async function* g(xs) { let error; try { while (true) { const x = xs.shift(); if (x === undefined) return; if (x === 'bad') throw new Error('bad'); yield await Promise.resolve(x); } } catch (e) { error = e.message; throw e; } finally { log.push('done ' + error); } } const out = []; try { for await (const x of g(['a', 'b', 'bad', 'c'])) out.push(x); } catch (e) { out.push('outer ' + e.message); } for await (const x of g(['z'])) out.push(x); return [out, log]; }",
    ],
  ];
  for (const [name, source] of CASES) {
    it(name, async () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = async (c: string): Promise<unknown> =>
        await (
          new Function(`${runnable(c).replace(/^export /m, "")}; return f;`)() as () => unknown
        )();
      expect(await go(code), code).toEqual(await go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  it("a try that yields and reads the receiver stays a summary", () => {
    const g = liftAtom(
      "export function f() { const o = { *g() { try { yield this.x; } finally {} }, x: 1 }; return [...o.g()]; }",
    );
    expect(opaque(g).length).toBeGreaterThan(0);
  });
});

describe("array holes (#1330)", () => {
  it("a hole is no element: its position, the length and the keys are kept", () => {
    for (const [source, input] of [
      ["export function f(m) { m ||= [, 0b10, 0b11]; return m; }", undefined],
      ["export function f(x) { return [1, , x, , ]; }", 5],
      ["export function f(x) { return [, ...x, , 2]; }", [7, 8]],
    ] as [string, unknown][]) {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = (c: string): unknown => {
        const r = (
          new Function(`${c.replace(/^export /m, "")}; return f;`)() as (x: unknown) => unknown[]
        )(input);
        return [r.length, Object.keys(r), r];
      };
      expect(go(code), code).toEqual(go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
      expect(graphIdentity(unpackGraph(packGraph(g)))).toBe(graphIdentity(g));
    }
  });
});

describe("for await (#1330)", () => {
  const ASYNC: [string, string][] = [
    [
      "sums an async generator's values",
      "export async function f() { async function* gen() { yield 1; yield 2; yield 3; } let n = 0; for await (const x of gen()) { n = n + x; } return n; }",
    ],
    [
      "awaits each element of a sync iterable of promises, and returns from inside",
      "export async function f() { const ps = [Promise.resolve(1), Promise.resolve(5), Promise.resolve(9)]; for await (const x of ps) { if (x > 2) return x; } return -1; }",
    ],
    [
      "as Node's streams write it: the first element, or false",
      "export async function f() { async function* gen() { yield 'a'; } for await (const unused of gen()) { return true; } return false; }",
    ],
  ];
  for (const [name, source] of ASYNC) {
    it(name, async () => {
      const g = liftAtom(source);
      expect(opaque(g)).toEqual([]);
      const code = emitTypeScript(g);
      const go = (c: string): Promise<unknown> =>
        (new Function(`${c.replace(/^export /m, "")}; return f;`)() as () => Promise<unknown>)();
      expect(await go(code), code).toEqual(await go(source));
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }
});

describe("an async iteration is stored and read back (#1330)", () => {
  it("packs and unpacks to the same identity, and its line form names it", () => {
    const g = liftAtom(
      "export async function f(it) { let n = 0; for await (const x of it) { n = n + x; } return n; }",
    );
    const packed = packGraph(g);
    expect(graphIdentity(unpackGraph(packed))).toBe(graphIdentity(g));
    expect(g.nodes.find((n) => n.kind === "loop")?.loop?.iterate?.of).toBe("async values");
  });
});
