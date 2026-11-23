// SPDX-License-Identifier: Apache-2.0
// Closures as graphs of their own (#1275): lambda lifting. A closure's captures are its first
// parameters; the closure node takes their values. Closures it cannot express stay opaque.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { decodeGraph, encodeGraph } from "./compact.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { parseLineForm, printLineForm } from "./line-form.js";

const SOURCES = [
  "export function f(x: number): number { const g = (y: number) => y + x; return g(2) + g(3); }",
  "export function f(a: number, b: number): number { function sq(n: number): number { return n * n; } return sq(a) + sq(b); }",
  "export function f(xs: number[], k: number): number { let s = 0; for (const x of xs) { const g = (v: number) => v * k; s = s + g(x); } return s; }",
  "export function f(x: number): number { const g = (y: number) => { const h = (z: number) => z + y + x; return h(1); }; return g(2); }",
];

const closureNode = (src: string) => liftAtom(src).nodes.find((n) => n.closure !== undefined);

describe("closures as graphs (#1275)", () => {
  it("a closure is a node with its own graph, whose first params are its captures", () => {
    const node = closureNode(SOURCES[0] as string);
    expect(node?.label).toBe("closure");
    expect(node?.inputs.length).toBe(1);
    expect(node?.closure?.nodes.filter((n) => n.kind === "param-source").length).toBe(2);
  });

  it("two closures with different bodies are different structures", () => {
    const a = "export function f(x: number): number { const g = () => x + 1; return g(); }";
    const b = "export function f(x: number): number { const g = () => x + 2; return g(); }";
    expect(graphIdentity(liftAtom(a))).not.toBe(graphIdentity(liftAtom(b)));
  });

  it("captures read in either order are the same structure", () => {
    const a =
      "export function f(p: number, q: number): number { const g = () => p - q; return g(); }";
    const b =
      "export function f(p: number, q: number): number { const g = () => { const t = q; return p - t; }; return g(); }";
    expect(graphIdentity(liftAtom(b))).toBe(graphIdentity(liftAtom(a)));
  });

  for (const src of SOURCES) {
    it(`round-trips through the line form, the compact form and TypeScript: ${src.slice(40, 110)}`, () => {
      const g = liftAtom(src);
      expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
      expect(graphIdentity(decodeGraph(encodeGraph(g)))).toBe(graphIdentity(g));
      expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
    });
  }

  it("a closure that reads a variable assigned after it is made sees it through a cell (#1276)", () => {
    const src =
      "export function f(x: number): number { let k = 1; const g = () => k; k = x; return g(); }";
    const g = liftAtom(src);
    expect(closureNode(src)).toBeDefined();
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      x: number,
    ) => number;
    expect(run(7)).toBe(7);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a recursive function reads itself as function-self, and computes the same (#1276)", () => {
    const src =
      "export function f(n: number): number { function fact(m: number): number { return m < 2 ? 1 : m * fact(m - 1); } return fact(n); }";
    expect(closureNode(src)).toBeDefined();
    const g = liftAtom(src);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      n: number,
    ) => number;
    expect(run(5)).toBe(120);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a function that uses this has its own receiver; an arrow captures the enclosing one", () => {
    const fn = closureNode(
      "export function f(x: number): unknown { return function () { return this; }; }",
    );
    expect(fn?.label).toBe("function");
    expect(fn?.closure?.nodes.some((n) => n.label === "this")).toBe(true);
    const arrow = closureNode("export function f(x: number): unknown { return () => this; }");
    expect(arrow?.label).toBe("closure");
    expect(arrow?.inputs).toHaveLength(1);
    expect(arrow?.closure?.nodes.some((n) => n.label === "this")).toBe(false);
  });

  it("a function's receiver survives emission", () => {
    const src =
      "export function f(k: number): unknown { const o = { k, get: function () { return this.k * 2; } }; return o.get(); }";
    const code = emitTypeScript(liftAtom(src));
    expect(code).toContain("function (");
    expect(new Function(`${code.replace("export ", "")}; return f(21);`)()).toBe(42);
  });

  it("a hand-written closure parses to the lifted one", () => {
    const text = [
      "param x",
      "function g with x",
      "  param cx",
      "  param y",
      "  op + y cx -> r",
      "  out r",
      "end",
      'lit "2" -> two',
      "op CallExpression g two -> a",
      'lit "3" -> three',
      // The second call comes after the first: its last operand, ^a, is the heap token (#1285).
      "op CallExpression g three ^a -> b",
      "op + a b -> s",
      "out s",
    ].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(liftAtom(SOURCES[0] as string)));
  });
});

describe("captures the outer graph cannot tell apart", () => {
  it("are ordered by how the closure uses them, so declaring them in another order is the same graph", () => {
    const a =
      "export function f(x: number) { let p; let q; const g = () => { p = x; q = x + 1; return [p, q]; }; return g(); }";
    const b =
      "export function f(x: number) { let q; let p; const g = () => { p = x; q = x + 1; return [p, q]; }; return g(); }";
    expect(graphIdentity(liftAtom(a))).toBe(graphIdentity(liftAtom(b)));
  });
});

describe("captures that change (#1276)", () => {
  it("a name reassigned before the closure is made is captured with that value", () => {
    const src =
      "export function f(o: any, cb: any) { o = o || {}; cb = cb || (() => 0); const g = () => cb(o); return g; }";
    expect(closureNode(src)).toBeDefined();
  });

  it("a name reassigned after the closure is made is a cell the closure reads when called", () => {
    const src = "export function f(x: number) { const g = () => x; x = x + 1; return g(); }";
    const g = liftAtom(src);
    expect(g.nodes.some((n) => n.label?.startsWith("Closure#"))).toBe(false);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      x: number,
    ) => number;
    expect(run(2)).toBe(3);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a name another closure rebinds is a cell both closures share", () => {
    const src =
      "export function f(x: number) { const set = (v: number) => { x = v; }; const get = () => x; set(x + 1); return get() * 10 + x; }";
    const g = liftAtom(src);
    expect(g.nodes.some((n) => n.label?.startsWith("Closure#"))).toBe(false);
    expect(g.nodes.some((n) => n.label === 'object:["value"]')).toBe(true);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      x: number,
    ) => number;
    expect(run(2)).toBe(33);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a counter a closure steps is shared with its scope", () => {
    const src =
      "export function f(n: number) { let count = 0; const tick = () => { count++; return count; }; for (let i = 0; i < n; i++) tick(); return count; }";
    const g = liftAtom(src);
    const code = emitTypeScript(g);
    const run = new Function(`${code.replace("export ", "")}; return f;`)() as (
      n: number,
    ) => number;
    expect([run(0), run(4)]).toEqual([0, 4]);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a member write to a captured object keeps the same object", () => {
    const src =
      "export function f() { const api = {}; api.a = 1; const get = () => api.a; api.b = 2; return get; }";
    const code = emitTypeScript(liftAtom(src));
    expect(closureNode(src)).toBeDefined();
    expect(new Function(`${code.replace("export ", "")}; return f()();`)()).toBe(1);
  });

  it("a name a nested function declares does not hide the outer one a closure reads", () => {
    const g = liftAtom(
      "export function f(s: number) { const a = () => { const b = (s: number) => s; return s + b(1); }; return a; }",
    );
    const walk = (x: typeof g): boolean =>
      x.nodes.some(
        (n) => n.diamond?.symbol === "s" || (n.closure !== undefined && walk(n.closure)),
      );
    expect(walk(g)).toBe(false);
  });

  it("a captured constant is part of the closure's own graph", () => {
    const id = (src: string): string => graphIdentity(liftAtom(src));
    expect(
      id("export function f(c: any) { let r = 0; if (c) r = 10; else throw 1; return () => r; }"),
    ).toBe(id("export function f(c: any) { if (c) {} else throw 1; return () => 10; }"));
  });

  it("two ifs on the same condition are numbered by what they hold, not by source order", () => {
    const src =
      "export function f(r: any, cb: any) { if (cb) r = 10; else if (r) throw 1; function g(c: any) { return r; } if (cb) { return g; } else return 1; }";
    const g = liftAtom(src);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
  });

  it("a capture the closure never reads is no capture", () => {
    const id = (src: string): string => graphIdentity(liftAtom(src));
    expect(id("export function f(p: any) { const g = () => { if (p) { } }; return g; }")).toBe(
      id("export function f(p: any) { const g = () => {}; return g; }"),
    );
  });

  it("a loop over a cell carries the heap token, and its condition after a break is not run", () => {
    for (const src of [
      "export function f(r: number) { var i = 0; function next() { for (; i < r;) { i = i + 1; if (i > 5) break; } } next(); return i; }",
      "export function f(r: number) { var i = 0; function next() { if (i < r) { for (; i < r;) { i = i + 1; } } } next(); return i; }",
      "export function f(r: any, c: any, p: any) { if (c) { } else throw 1; var i = 0; k(); function next() { p(i); } return next; }",
    ]) {
      const g = liftAtom(src);
      expect(graphIdentity(liftAtom(emitTypeScript(g))), src).toBe(graphIdentity(g));
    }
  });

  it("a method looked up by a key is ordered just before its call, as a lowering writes it", () => {
    const src =
      "export function f(len: number) { (self['crypto'] || self['msCrypto'])['getRandomValues'](a = new Uint32Array(len)); }";
    const g = liftAtom(src);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
  });
});

describe("a capture rebound by destructuring (#1173)", () => {
  const opaque = (src: string): boolean => /\S+#[0-9a-f]{16}/.test(printLineForm(liftAtom(src)));
  it("before the closure is made: the closure is a graph", () => {
    expect(opaque("export function f(c) { ({c} = c); const g = () => c; return g; }")).toBe(false);
    expect(
      opaque(
        "export function f(c) { let r = false; ({c, r = false} = c); const g = () => r; return g(); }",
      ),
    ).toBe(false);
  });
  it("after it: the name is shared, and the closure sees the write", () => {
    const src = "export function f(c) { const g = () => c; ({c} = {c: 2}); return g(); }";
    expect(opaque(src)).toBe(false);
    const code = emitTypeScript(liftAtom(src));
    const f = new Function(`${code.replace(/^export /m, "")}; return f;`)() as (
      c: number,
    ) => number;
    expect(f(5)).toBe(2);
  });
});
