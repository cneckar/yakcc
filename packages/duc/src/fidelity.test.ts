// SPDX-License-Identifier: Apache-2.0
// Lift fidelity (#1173, DUC Norm 3, DEC-DUC-LIFT-FIDELITY-001): the graph references exactly the
// names its source reads without declaring, as TypeScript's binder finds them.
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
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
