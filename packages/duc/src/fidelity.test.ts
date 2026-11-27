// SPDX-License-Identifier: Apache-2.0
// Lift fidelity (#1173, DUC Norm 3, DEC-DUC-LIFT-FIDELITY-001): the graph references exactly the
// names its source reads without declaring, as TypeScript's binder finds them.
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { graphFreeNames, liftFidelity, sourceFreeNames, topLevelNames } from "./fidelity.js";
import { liftAtom } from "./lift.js";

const holds = (source: string) => liftFidelity(source, liftAtom(source));

describe("lift fidelity (#1173)", () => {
  it("holds on every emit case", () => {
    for (const tc of EMIT_CASES)
      expect(holds(tc.source), tc.name).toEqual(expect.objectContaining({ holds: true }));
  });

  it("the source's free names come from the binder: not properties, labels, types or its own bindings", () => {
    const names = sourceFreeNames(
      "function f (o: Opts, xs: number[]) { const k = o.size; outer: for (const x of xs) { if (x > LIMIT) break outer; } return { k, total: sum(xs) } }",
    );
    expect([...names].sort()).toEqual(["LIMIT", "sum"]);
  });

  it("a dropped reference shows as missing, an invented one as extra", () => {
    const source = "function f (a) { return helper(a) + K }";
    const other = liftAtom("function f (a) { return helper(a) + J }");
    expect(liftFidelity(source, other)).toEqual({ holds: false, missing: ["K"], extra: ["J"] });
  });

  it("references inside closures count: a closure's graph is part of the atom's", () => {
    const g = liftAtom("function f (xs) { return xs.map((x) => scale(x)) }");
    expect(graphFreeNames(g).has("scale")).toBe(true);
    expect(holds("function f (xs) { return xs.map((x) => scale(x)) }").holds).toBe(true);
  });

  it("an atom's own top-level declarations are module bindings: recursion reads one", () => {
    expect([...topLevelNames("function isIP (s) { return s ? isIP('') : 4 }")]).toEqual(["isIP"]);
    expect(holds("function isIP (s) { return s ? isIP('') : 4 }").holds).toBe(true);
    expect(holds("const t = function () { return t.enabled }").holds).toBe(true);
  });

  it("`new.target` inside a class method is one name: `target` is not captured as a variable", () => {
    const source =
      "class E extends Error { constructor (m) { super(m); const proto = new.target.prototype; this.p = proto } }";
    const g = liftAtom(source);
    expect(graphFreeNames(g).has("target")).toBe(false);
    expect(liftFidelity(source, g).holds).toBe(true);
  });

  it("a `var` initialized with a closure that reads it binds it, through a cell (lodash memoize)", () => {
    const source =
      "function memoize (func) { var memoized = function (k) { var c = memoized.cache; return c.has(k) ? c.get(k) : func(k) }; memoized.cache = new Map(); return memoized }";
    expect(holds(source)).toEqual({ holds: true, missing: [], extra: [] });
  });

  it("a closure made before a later `var` in a function body binds it, through a cell", () => {
    const source =
      "function factory () { var o = {}; o.salt = function (r) { return r || ROUNDS }; var ROUNDS = 10; return o }";
    expect(holds(source)).toEqual({ holds: true, missing: [], extra: [] });
  });

  it("a fragment of a generator's body yields: `yield` is not a name it reads (#1330)", () => {
    // As the shaver slices the runtime's generator primitives: before, `yield* body()` was read
    // as a name `yield` times body(), and the gate refused `yield` as unresolved.
    for (const [fragment, free] of [
      ["return yield* body();", ["body"]],
      ["const done = yield* finalizer();", ["finalizer"]],
      ["return yield* handler(thrown);", ["handler", "thrown"]],
      ["const x = await a(); yield x;", ["a"]],
    ] as [string, string[]][]) {
      const g = liftAtom(fragment);
      expect([...graphFreeNames(g)].sort(), fragment).toEqual(free);
      expect(holds(fragment), fragment).toEqual({ holds: true, missing: [], extra: [] });
    }
  });

  it("`globalThis` declared by the source is its own binding, not the platform's (#1331)", () => {
    const declared = "const { Error, globalThis } = primordials;\nif (m) { globalThis.x = Error; }";
    expect(sourceFreeNames(declared).has("globalThis")).toBe(false);
    expect(holds(declared)).toEqual({ holds: true, missing: [], extra: [] });
    expect(sourceFreeNames("globalThis.x = 1;").has("globalThis")).toBe(true);
  });
});

describe("what never runs is not read (#1292)", () => {
  it("a call after a return is no read of the source's, as it is no node of the graph's", () => {
    // esbuild's helper, written after the function it names, in undici's bundle.
    const source = `function connect(c) {
  const s = open(c);
  return s;
  function write(x) { s.push(x); }
  __name(write, "write");
}`;
    expect(sourceFreeNames(source).has("__name")).toBe(false);
    expect(sourceFreeNames(source).has("open")).toBe(true);
    expect(liftFidelity(source, liftAtom(source)).holds).toBe(true);
  });
});

describe("a short-circuit its left literal decides (#1368)", () => {
  it("never runs its right side: a bundler's list of export names reads none of them", () => {
    // esbuild's annotation at the end of a CommonJS bundle, for a tool to read.
    const source = "0 && (module.exports = { textChanges, codefix });";
    expect([...sourceFreeNames(source)]).toEqual([]);
    expect([...graphFreeNames(liftAtom(source))]).toEqual([]);
    expect(holds(source).holds).toBe(true);
  });

  it("is that literal, before && and || and ??", () => {
    for (const source of [
      "function f(x) { return false && x.y; }",
      "function f(x) { return true || x.y; }",
      "function f(x) { return 0 ?? x.y; }",
    ])
      expect(liftAtom(source).nodes.some((n) => n.label === ".y")).toBe(false);
  });

  it("still runs it when the literal does not decide", () => {
    for (const source of [
      "function f(x) { return 1 && x.y; }",
      "function f(x) { return null ?? x.y; }",
      "function f(x) { return undefined || x.y; }",
    ])
      expect(liftAtom(source).nodes.some((n) => n.label === ".y")).toBe(true);
  });
});

describe("an iterating loop whose leading break reads its own variable (#1368)", () => {
  // TypeScript's lastWhere: the test is of each element, a break like any other, not the
  // condition a lowering writes before the element is pulled.
  const source = `function lastWhere(a, pred) {
  let last2;
  for (const value of a) {
    if (!pred(value)) break;
    last2 = value;
  }
  return last2;
}`;

  it("reads no name the source does not", () => {
    expect(holds(source)).toEqual({ holds: true, missing: [], extra: [] });
  });

  it("round-trips", () => {
    const g = liftAtom(source);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
  });
});

describe("a type's own name is no read (#1292)", () => {
  it("a generic arrow's type parameter, a local type alias and interface", () => {
    for (const source of [
      "export function f() { const memo = <T>(c: Map<string, T>, make: () => T): T => make(); return memo; }",
      "export function f(xs: unknown[]) { type E = { d: string }; return xs.map((e) => (e as E).d); }",
      "export function f(xs: unknown[]) { interface I { d: string } return xs.map((e) => (e as I).d); }",
    ]) {
      expect([...graphFreeNames(liftAtom(source))]).toEqual([]);
      expect(holds(source).holds).toBe(true);
    }
  });
});
