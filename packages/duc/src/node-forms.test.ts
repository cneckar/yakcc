// SPDX-License-Identifier: Apache-2.0
/**
 * The last forms of Node's library that lifted to an opaque summary (#1330, #1361 M3). Each now lifts
 * with no opaque summary, its TypeScript lowering computes what the source computes, and the round
 * trip holds:
 * - a closure capturing a name that another function's own binding of the same name reassigns;
 * - a `continue` of a loop, inside a switch in it;
 * - a yielding `try` in a method that reads `this`;
 * - a `for...of` that stops: it leaves before the next element is pulled;
 * - a derived constructor's arrow made before `super(..)` that reads `this` when it runs;
 * - `super(..)` inside a `try`.
 */
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftFidelity } from "./fidelity.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

type Fn = (...a: unknown[]) => unknown;

const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

const source = (code: string): Fn =>
  new Function(
    `${ts
      .transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "")}; return f;`,
  )() as Fn;

const outcome = (fn: Fn, args: unknown[]): string => {
  try {
    return `= ${JSON.stringify(fn(...args)) ?? "undefined"}`;
  } catch (e) {
    return `throws ${(e as Error).constructor.name}`;
  }
};

function agrees(code: string, inputs: unknown[][]): void {
  const g = liftAtom(code);
  expect(opaque(g), code).toEqual([]);
  const lowered = emitTypeScript(g);
  const b = new Function(`${runnable(lowered)}; return f;`)() as Fn;
  const a = source(code);
  for (const args of inputs)
    expect(outcome(b, args), `${code} on ${JSON.stringify(args)}`).toBe(outcome(a, args));
  expect(graphIdentity(liftAtom(lowered)), code).toBe(graphIdentity(g));
}

describe("Node's last opaque forms (#1330)", () => {
  it("a closure captures a name another function's parameter of the same name reassigns", () => {
    agrees(
      `export function f(req: any, err: any) {
  const log: string[] = [];
  function done(req: any, err: any) { if (!err) { err = 'hang up'; } log.push(String(err)); }
  const later = (er: any) => { if (er === 'x') { er = null; } done(req, er || err); };
  later('x'); later('y'); done(req, err);
  return log;
}`,
      [
        [{}, null],
        [{}, "boom"],
      ],
    );
  });

  it("a continue of the loop, inside a switch in it", () => {
    const inputs = [[""], ["a"], ["abc"], ["aab"], ["xyzzy"], ["zzzz"], ["baab"], ["qxz"]];
    agrees(
      "export function f(s: string) { let n = 0; for (let i = 0; i < s.length; i++) { switch (s[i]) { case 'a': n++; break; case 'b': continue; default: continue; } n += 10; } return n; }",
      inputs,
    );
    agrees(
      "export function f(s: string) { let n = 0, i = 0; while (i < s.length) { const c = s[i++]; switch (c) { case 'x': n += 100; case 'y': n += 1; break; case 'z': { if (n > 2) continue; n += 5; break; } default: n -= 1; continue; } n *= 2; } return n; }",
      inputs,
    );
    // A continue in a loop inside a case is that loop's.
    agrees(
      "export function f(s: string) { let n = 0; for (const c of s) { switch (c) { case 'a': for (let j = 0; j < 3; j++) { if (j === 1) continue; n += j; } break; default: n += 7; } } return n; }",
      inputs,
    );
  });

  it("a for...of that stops leaves before the next element is pulled", () => {
    agrees(
      `export function f(items: any[]) {
  let pulled = 0;
  function* gen() { for (const x of items) { pulled++; yield x; } }
  const out: any[] = [];
  for (const x of gen()) { out.push(x); if (x === 'stop') break; }
  return [out, pulled];
}`,
      [[[]], [[1, 2, 3]], [["a", "stop", "b", "c"]]],
    );
  });

  it("a yielding try in a method that reads this", () => {
    agrees(
      `export function f(items: any[]) {
  const log: string[] = [];
  class D {
    #i = 0;
    #items: any[];
    constructor(xs: any[]) { this.#items = xs; }
    #read() { return this.#i < this.#items.length ? this.#items[this.#i++] : null; }
    *entries() {
      try { while (true) { const r = this.#read(); if (r === null) { break; } yield r; } }
      finally { log.push('closed:' + this.#i); }
    }
  }
  const out: any[] = [];
  for (const x of new D(items).entries()) { out.push(x); if (x === 'stop') break; }
  return [out, log];
}`,
      [[[]], [[1, 2, 3]], [["a", "stop", "b"]]],
    );
  });

  it("an arrow made before super(..) reads this when it runs", () => {
    agrees(
      `export function f(n: number) {
  class Base { tag: string; constructor(o: any) { this.tag = o.tag; } }
  class Sock extends Base {
    count = 0;
    close: () => number;
    constructor(k: number) {
      const handle: any = {};
      handle.close = () => this.bump(k);
      super({ tag: 'sock' + k });
      this.close = handle.close;
    }
    bump(k: number) { this.count += k; return this.count; }
  }
  const s = new Sock(n);
  return [s.tag, s.close(), s.close()];
}`,
      [[1], [5]],
    );
  });

  it("super(..) inside a try", () => {
    agrees(
      `export function f(code: string) {
  class Base { code: string; constructor(c: string) { if (c === 'bad') throw new TypeError('bad'); this.code = c; } }
  class Script extends Base {
    constructor(c: string) {
      try { super(c); } catch (e) { throw e; }
      this.code = this.code + '!';
    }
  }
  try { return new Script(code).code; } catch (e) { return 'caught ' + (e as Error).message; }
}`,
      [["ok"], ["bad"]],
    );
  });
});

describe("hoisting over a let or const (#1330)", () => {
  it("a function declaration reads a const declared above it, which its own initializer passes", () => {
    agrees(
      `export function f(n: number) {
  const calls: number[] = [];
  const emit = make(n, deprecated);
  function deprecated(k: number) { emit(k); return k * 2; }
  function make(m: number, fn: (k: number) => number) { return (k: number) => calls.push(m + k + fn.length); }
  return [deprecated(3), deprecated(4), calls];
}`,
      [[1], [10]],
    );
  });

  it("a closure in a const's own initializer reads the const when it runs", () => {
    agrees(
      `export function f(flag: boolean) {
  const log: string[] = [];
  function eos(cb: () => void) { return () => { log.push('cleaned'); cb(); }; }
  const cleanup: () => void = eos(() => { if (flag && log.length < 3) { cleanup(); } });
  const run = () => cleanup();
  run();
  return log;
}`,
      [[true], [false]],
    );
  });
});

describe("a write to an outer name that a function expression of the same name shadows (#1330)", () => {
  it("`transcode = function transcode(..) {..}` keeps the write", () => {
    for (const source of [
      "transcode = function transcode(x) { return x; };",
      "if (c) { transcode = function transcode(x) { return transcode; }; }",
    ]) {
      const g = liftAtom(source);
      expect(liftFidelity(source, g), source).toEqual({ holds: true, missing: [], extra: [] });
      const code = emitTypeScript(g);
      expect(code, source).toMatch(/\btranscode = /);
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    }
  });
});

describe("a switch that yields, in a generator's loop (#1330)", () => {
  it("each case's yield is the generator's", () => {
    agrees(
      `export function f(items: string[]) {
  function* report(xs: string[]) {
    yield 'start';
    for (const x of xs) {
      switch (x) {
        case 'a': { yield 'A'; yield 'a2'; break; }
        case 'skip': continue;
        default: yield x.toUpperCase();
      }
      yield '-';
    }
  }
  return [...report(items)];
}`,
      [[[]], [["a", "b"]], [["skip", "a", "c"]]],
    );
  });
});

describe("a function declared in a block after a statement that may throw (#1330)", () => {
  it("is bound on the side the rest is lifted on", () => {
    agrees(
      `export function f(i: boolean, t: boolean) {
  const out: number[] = [];
  if (i) { if (!t) { throw new RangeError('no'); } }
  if (t) { out.push(1); } else { function g() { return 7; } out.push(g()); }
  return out;
}`,
      [
        [false, false],
        [false, true],
        [true, true],
        [true, false],
      ],
    );
  });
});

describe("a function declaration reading a class declared in its scope (#1330)", () => {
  it("reads the class, whichever is written first", () => {
    agrees(
      `export function f(n: number) {
  class P { static make(k: number) { return new P(k); } v: number; constructor(k: number) { this.v = k * 2; } }
  function init(k: number) { return () => P.make(k).v; }
  function later(k: number) { return Q.twice(k); }
  class Q { static twice(k: number) { return k * 2; } }
  return [init(n)(), later(n)];
}`,
      [[1], [5]],
    );
  });
});

describe("an object rest (#1330)", () => {
  it("lowers to the runtime's call and lifts back to the same operation", () => {
    agrees(
      `export function f(o: any) {
  const { prototype, a, ...rest } = o;
  return [Object.keys(rest), rest.b, prototype === undefined, a];
}`,
      [[{ prototype: 1, a: 2, b: 3, c: 4 }], [{ b: 9 }], [null]],
    );
  });
});

describe("a join of two equal arms, one on a side of a branch (#1330)", () => {
  it("emits, runs and round-trips", () => {
    agrees(
      `export function f(p: any, a: number) {
  if (p) { if (!(p.s > 0)) { throw new RangeError('s'); } }
  if (p) { return [a, p.s]; }
  return [a];
}`,
      [
        [null, 1],
        [{ s: 2 }, 3],
        [{ s: -1 }, 4],
      ],
    );
  });
});
