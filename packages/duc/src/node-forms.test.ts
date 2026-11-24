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
