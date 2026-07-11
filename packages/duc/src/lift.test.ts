// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { mayInfluence, usupp } from "./influence.js";
import { DucLiftError, liftAtom } from "./lift.js";
import type { DiamondReason, DucGraph } from "./types.js";
import type { ValueId } from "./types.js";
import { isWellFormed } from "./wellformed.js";

/** Lift and assert the base invariant every lift must satisfy: well-formedness. */
function lift(
  src: string,
  ...args: Parameters<typeof liftAtom> extends [string, ...infer R] ? R : never
): DucGraph {
  const graph = liftAtom(src, ...args);
  const wf = isWellFormed(graph);
  expect(wf.wellFormed, `lift must be well-formed:\n${src}`).toBe(true);
  return graph;
}

const diamondReasons = (g: DucGraph): DiamondReason[] =>
  g.nodes.flatMap((n) => (n.diamond !== undefined ? [n.diamond.reason] : []));
const diamondSymbols = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => (n.diamond !== undefined ? [n.diamond.symbol] : []));
const kinds = (g: DucGraph): string[] => g.nodes.map((n) => n.kind);
const onlyObs = (g: DucGraph): ValueId => {
  expect(g.obs).toHaveLength(1);
  return g.obs[0] as ValueId;
};
const paramValue = (g: DucGraph, index = 0): ValueId => {
  const params = g.nodes.filter((n) => n.kind === "param-source");
  return params[index]?.outputs[0] as ValueId;
};

describe("determinism + base invariant", () => {
  it("lifts the same source to the same graph", () => {
    const src = "export function f(a: number, b: number): number { return a + b; }";
    expect(liftAtom(src)).toEqual(liftAtom(src));
  });

  it("every parameter and both operands influence the observation", () => {
    const g = lift(
      "export function f(a: number, b: number): number { const s = a + b; return s * 2; }",
    );
    const obs = onlyObs(g);
    expect(mayInfluence(g, paramValue(g, 0), obs)).toBe(true);
    expect(mayInfluence(g, paramValue(g, 1), obs)).toBe(true);
  });
});

describe("unresolved references become diamond-sources (W1/W2)", () => {
  it("a free identifier read is a diamond-source and lands in usupp", () => {
    // Paper Example 2.7: an unresolved read.
    const g = lift("export function f(x: number): number { return read(x, FLAGS); }");
    expect(diamondSymbols(g).sort()).toEqual(["FLAGS", "read"]);
    expect(diamondReasons(g).every((r) => r === "free-identifier")).toBe(true);
    const support = usupp(g, onlyObs(g))
      .map((s) => s.label.symbol)
      .sort();
    expect(support).toEqual(["FLAGS", "read"]);
  });

  it("a foreign import is a diamond-source labelled with its module", () => {
    const g = lift(
      'import { readFileSync } from "node:fs";\nexport function f(p: string): string { return readFileSync(p); }',
    );
    const diamond = g.nodes.find((n) => n.diamond?.symbol === "readFileSync")?.diamond;
    expect(diamond?.reason).toBe("foreign-import");
    expect(diamond?.module).toBe("node:fs");
  });

  it("default, namespace, and aliased named imports are all foreign-sources", () => {
    const g = lift(
      'import def, * as ns from "x";\nimport { a as b } from "y";\n' +
        "export function f(): unknown { return def(ns.z, b); }",
    );
    expect(diamondSymbols(g).sort()).toEqual(["b", "def", "ns"]);
    expect(diamondReasons(g).every((r) => r === "foreign-import")).toBe(true);
  });

  it("type-only imports carry no runtime value and are never sources", () => {
    const g = lift(
      'import type { T } from "z";\nimport { type A, c } from "m";\nexport function f(): unknown { return c; }',
    );
    expect(diamondSymbols(g)).toEqual(["c"]);
  });

  it("ambient globals are diamond-sources labelled ambient-read", () => {
    const g = lift("export function f(x: number): number { return Math.max(x, 0); }");
    const math = g.nodes.find((n) => n.diamond?.symbol === "Math")?.diamond;
    expect(math?.reason).toBe("ambient-read");
  });

  it("honors a custom ambient-globals set", () => {
    const g = lift("export function f(): unknown { return CUSTOM; }", {
      ambientGlobals: ["CUSTOM"],
    });
    expect(g.nodes.find((n) => n.diamond?.symbol === "CUSTOM")?.diamond?.reason).toBe(
      "ambient-read",
    );
  });
});

describe("control-as-data: sel joins (Example 2.6)", () => {
  it("an if that reassigns produces a sel gate with the condition as input", () => {
    const g = lift(
      "export function f(x: number): number { let y = 0; if (x > 0) { y = x; } return y; }",
    );
    expect(kinds(g)).toContain("sel");
    // the secret x reaches y only through the branch — an implicit flow
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });

  it("an if/else that reassigns both branches joins with a sel", () => {
    const g = lift(
      "export function f(x: number): number { let y = x; if (x > 0) { y = x; } else { y = 0; } return y; }",
    );
    expect(kinds(g)).toContain("sel");
  });

  it("a ternary is a sel", () => {
    const g = lift("export const g = (c: boolean, a: number, b: number): number => (c ? a : b);");
    expect(kinds(g)).toContain("sel");
    expect(mayInfluence(g, paramValue(g, 0), onlyObs(g))).toBe(true);
  });

  it("a return-less early return is ignored; reads still resolve", () => {
    const g = lift("export function f(x: number): void { if (x > 0) { return; } doThing(x); }");
    expect(diamondSymbols(g)).toContain("doThing");
  });
});

describe("loops summarize to one opaque node (DEC-DUC-SCOPE-001)", () => {
  it("for-of with a compound-assign accumulator", () => {
    const g = lift(
      "export function f(xs: number[]): number { let s = 0; for (const x of xs) { s = s + x; } return s; }",
    );
    expect(kinds(g)).toContain("loop");
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });

  it("while, do-while, for(;;) and for-in all summarize to a loop node", () => {
    for (const src of [
      "export function f(n: number): number { let i = 0; while (i < n) { i += 1; } return i; }",
      "export function f(n: number): number { let i = 0; do { i += 1; } while (i < n); return i; }",
      "export function f(n: number): number { let s = 0; for (let j = 0; j < n; j++) { s += j; } return s; }",
      "export function f(o: object): number { let c = 0; for (const k in o) { c += 1; } return c; }",
    ]) {
      expect(kinds(lift(src))).toContain("loop");
    }
  });

  it("does not mint spurious diamond-sources for loop-local or closure-local names", () => {
    // `x` is the for-of loop variable and `acc` is body-local; neither is an
    // external unknown, so neither should appear as a diamond-source.
    const loop = lift(
      "export function f(xs: number[]): number { let s = 0; for (const x of xs) { const acc = x + 1; s = s + acc; } return s; }",
    );
    expect(diamondSymbols(loop)).not.toContain("x");
    expect(diamondSymbols(loop)).not.toContain("acc");

    // a nested closure's own parameter `y` is local, not a free unknown.
    const closure = lift(
      "export function f(x: number): (y: number) => number { return (y) => x + y; }",
    );
    expect(diamondSymbols(closure)).not.toContain("y");
  });

  it("a loop that increments an outer variable rebinds it through the loop node", () => {
    const g = lift(
      "export function f(x: number): number { for (let i = 0; i < 3; i++) { x++; } return x; }",
    );
    expect(kinds(g)).toContain("loop");
    // x is observed after being updated inside the loop, so the loop node
    // redefines it and the (updated) value is what flows to the observation.
    expect(isWellFormed(g).wellFormed).toBe(true);
  });
});

describe("expression forms", () => {
  it("property and element access", () => {
    const g = lift("export function f(o: { a: number[] }, k: number): number { return o.a[k]; }");
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true); // k -> o.a[k]
  });

  it("array and object literals, templates", () => {
    expect(
      isWellFormed(lift("export function f(x: number): number[] { return [x, x + 1]; }"))
        .wellFormed,
    ).toBe(true);
    expect(
      isWellFormed(lift("export function f(x: number): object { return { v: x }; }")).wellFormed,
    ).toBe(true);
    expect(
      isWellFormed(lift("export function f(x: number): string { return `n=${x}`; }")).wellFormed,
    ).toBe(true);
  });

  it("call and new", () => {
    expect(kinds(lift("export function f(x: number): Date { return new Date(x); }"))).toContain(
      "op",
    );
  });

  it("await and yield", () => {
    lift("export async function f(p: Promise<number>): Promise<number> { return (await p) + 1; }");
    lift("export function* f(x: number): Generator<number> { yield x; }");
  });

  it("a closure captures the free variables it reads", () => {
    const g = lift("export function f(x: number): () => number { return () => x + 1; }");
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });

  it("prefix/postfix unary and compound assignment reassign the binding", () => {
    const inc = lift("export function f(x: number): number { let y = x; y++; return y; }");
    expect(mayInfluence(inc, paramValue(inc), onlyObs(inc))).toBe(true);
    const pre = lift("export function f(x: number): number { let y = x; --y; return y; }");
    expect(mayInfluence(pre, paramValue(pre), onlyObs(pre))).toBe(true);
    const plus = lift("export function f(x: number): number { let y = 0; y += x; return y; }");
    expect(mayInfluence(plus, paramValue(plus), onlyObs(plus))).toBe(true);
  });

  it("type-carrying wrappers pass through (as / satisfies / non-null / paren / negation)", () => {
    lift("export function f(x: unknown): number { return (x as number) + 1; }");
    lift("export function f(x: number | null): number { return x! + 1; }");
    lift("export function f(x: number): number { return (-x) + 1; }");
    lift("export function f(x: number): boolean { return !(x > 0); }");
  });

  it("an unmodelled expression form reaches the sound opaque fallback", () => {
    // `typeof`/`void`/`delete` are their own expression kinds — the lifter has no
    // special case, so they fall through to the fallback opaque node over reads.
    const g = lift("export function f(x: unknown): string { return typeof x; }");
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });
});

describe("assignments to members and destructuring lvalues", () => {
  it("a property assignment flows the rhs into the mutated object", () => {
    const g = lift(
      "export function f(o: { v: number }, n: number): { v: number } { o.v = n; return o; }",
    );
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true); // n -> o
  });

  it("an element assignment flows both the rhs AND the index into the mutated array", () => {
    const g = lift(
      "export function f(arr: number[], i: number, v: number): number[] { arr[i] = v; return arr; }",
    );
    expect(mayInfluence(g, paramValue(g, 2), onlyObs(g))).toBe(true); // v -> arr
    // the index chooses which slot is written, so it influences the object too
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true); // i -> arr
  });

  it("a member write inside a loop re-defines the mutated object (influence not lost)", () => {
    const g = lift(
      "export function f(o: { v: number }, secret: number): { v: number } { for (let i = 0; i < 3; i++) { o.v = secret; } return o; }",
    );
    expect(kinds(g)).toContain("loop");
    // secret is written into o inside the loop; the loop node must re-define o
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true); // secret -> o
  });

  it("a destructuring-assignment lvalue does not crash the lifter", () => {
    lift(
      "export function f(arr: number[]): number { let a = 0, b = 0; [a, b] = arr; return a + b; }",
    );
  });
});

describe("destructuring bindings", () => {
  it("object-pattern and array-pattern parameters bind every name", () => {
    const obj = lift(
      "export function f({ a, b }: { a: number; b: number }): number { return a + b; }",
    );
    expect(mayInfluence(obj, paramValue(obj), onlyObs(obj))).toBe(true);
    const arr = lift("export function f([p, q]: number[]): number { return p + q; }");
    expect(mayInfluence(arr, paramValue(arr), onlyObs(arr))).toBe(true);
  });

  it("a destructuring const binding aliases the initializer value", () => {
    const g = lift(
      "export function f(pair: [number, number]): number { const [x, y] = pair; return x + y; }",
    );
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });

  it("an uninitialized let becomes a literal-source until assigned", () => {
    const g = lift("export function f(): number { let z; z = 5; return z; }");
    expect(kinds(g)).toContain("literal-source");
    expect(isWellFormed(g).wellFormed).toBe(true);
  });
});

describe("switch and try summarize opaquely, surfacing returns as observations", () => {
  it("a switch with returns", () => {
    const g = lift(
      "export function f(x: number): number { switch (x) { case 1: return 10; default: return 0; } }",
    );
    expect(g.obs.length).toBeGreaterThanOrEqual(1);
    expect(isWellFormed(g).wellFormed).toBe(true);
  });

  it("a try/catch with a foreign call", () => {
    const g = lift(
      "export function f(x: number): number { try { return risky(x); } catch { return 0; } }",
    );
    expect(diamondSymbols(g)).toContain("risky");
  });
});

describe("no single exported function: top-level fallback", () => {
  it("an exported constant expression is observed", () => {
    const g = lift("export const K = 1 + 2;");
    expect(onlyObs(g)).toBeDefined();
    expect(isWellFormed(g).wellFormed).toBe(true);
  });

  it("multiple exported bindings are each observed", () => {
    const g = lift("export const A = 1;\nexport const B = A + 1;");
    expect(g.obs.length).toBe(2);
  });

  it("multiple exported functions fall back and still resolve their reads", () => {
    const g = lift(
      "export function a(): number { return one(); }\nexport function b(): number { return two(); }",
    );
    expect(diamondSymbols(g).sort()).toEqual(["one", "two"]);
  });
});

describe("errors", () => {
  it("throws DucLiftError on a syntax error", () => {
    expect(() => liftAtom("export function f( {")).toThrow(DucLiftError);
  });

  it("does NOT throw on a semantic error — an unresolved name is a diamond-source", () => {
    expect(() => liftAtom("export function f(): number { return undeclaredName; }")).not.toThrow();
  });
});
