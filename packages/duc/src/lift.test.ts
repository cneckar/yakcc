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
    expect(diamond?.reason).toBe("unlinked-reference");
    expect(diamond?.module).toBe("node:fs");
  });

  it("default, namespace, and aliased named imports are all foreign-sources", () => {
    const g = lift(
      'import def, * as ns from "x";\nimport { a as b } from "y";\n' +
        "export function f(): unknown { return def(ns.z, b); }",
    );
    expect(diamondSymbols(g).sort()).toEqual(["b", "def", "ns"]);
    expect(diamondReasons(g).every((r) => r === "unlinked-reference")).toBe(true);
  });

  it("type-only imports carry no runtime value and are never sources", () => {
    const g = lift(
      'import type { T } from "z";\nimport { type A, c } from "m";\nexport function f(): unknown { return c; }',
    );
    expect(diamondSymbols(g)).toEqual(["c"]);
  });

  it("ambient globals are diamond-sources labelled platform-primitive", () => {
    const g = lift("export function f(x: number): number { return Math.max(x, 0); }");
    const math = g.nodes.find((n) => n.diamond?.symbol === "Math")?.diamond;
    expect(math?.reason).toBe("platform-primitive");
  });

  it("honors a custom ambient-globals set", () => {
    const g = lift("export function f(): unknown { return CUSTOM; }", {
      ambientGlobals: ["CUSTOM"],
    });
    expect(g.nodes.find((n) => n.diamond?.symbol === "CUSTOM")?.diamond?.reason).toBe(
      "platform-primitive",
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

describe("a lone bare (non-exported) function is the primary atom (WI-EXPLAIN-01)", () => {
  // Shave persists an atom as its raw factored fragment — a bare `function f(…)`
  // with no `export`. Its parameters are the atom boundary and its returns are the
  // observations, exactly as for an exported function. Without primary-recognition
  // the declaration is summarized as one opaque region and its returns are re-lifted
  // in the empty outer scope, so params and `var` locals surface as spurious
  // free-identifier diamonds and observations disconnect from the body.

  it("binds a bare function's parameters (they are param-sources, not free-ids)", () => {
    const g = lift("function f(a, b) { return a + b; }");
    expect(g.nodes.filter((n) => n.kind === "param-source")).toHaveLength(2);
    expect(diamondSymbols(g)).not.toContain("a");
    expect(diamondSymbols(g)).not.toContain("b");
    expect(mayInfluence(g, paramValue(g, 0), onlyObs(g))).toBe(true);
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true);
  });

  it("does not mint free-id diamonds for a bare function's own var locals", () => {
    // `validLen`/`placeHoldersLen` are `var` locals; only the genuine capture is unknown.
    const g = lift(
      "function getLens(b64) { var validLen = b64.indexOf('='); var placeHoldersLen = validLen; return cap(validLen, placeHoldersLen); }",
    );
    expect(diamondSymbols(g)).not.toContain("validLen");
    expect(diamondSymbols(g)).not.toContain("placeHoldersLen");
    expect(diamondSymbols(g)).not.toContain("b64");
    expect(diamondSymbols(g)).toContain("cap"); // genuine free reference survives
  });

  it("a reassigned parameter stays bound, not a free-identifier", () => {
    // `pointer = pointer.split('/')` reassigns the param; the read must still resolve.
    const g = lift(
      "function compilePointer(pointer) { if (typeof pointer === 'string') { pointer = pointer.split('/'); } return pointer; }",
    );
    expect(diamondSymbols(g)).not.toContain("pointer");
    expect(usupp(g, onlyObs(g))).toHaveLength(0);
  });

  it("surfaces only the genuine sibling reference, with params bound", () => {
    // `byteLength(b64)` calls sibling `getLens`; b64 and the locals are bound.
    const g = lift(
      "function byteLength(b64) { var lens = getLens(b64); var v = lens[0]; return v * 3; }",
    );
    expect(diamondSymbols(g)).toEqual(["getLens"]);
  });

  it("an exported entry point still wins over bare helpers", () => {
    // With exactly one exported function-like among bare helpers, the export is primary.
    const g = lift("function helper(z) { return z; }\nexport function main(x) { return use(x); }");
    // `main`'s param x is bound; the export's boundary — not helper's — is the atom.
    expect(diamondSymbols(g)).toContain("use");
    expect(diamondSymbols(g)).not.toContain("x");
  });

  it("two bare functions remain ambiguous → top-level fallback (unchanged)", () => {
    const g = lift("function a() { return one(); }\nfunction b() { return two(); }");
    expect(isWellFormed(g).wellFormed).toBe(true);
    expect(diamondSymbols(g)).toContain("one");
    expect(diamondSymbols(g)).toContain("two");
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

describe("non-statement fragments lift through analysis forms (WI-EXPLAIN-04, #1173)", () => {
  it("an anonymous function expression lifts with its parameters bound and influencing the result", () => {
    const g = lift("function (a, b) { return a + b; }");
    expect(g.nodes.filter((n) => n.kind === "param-source")).toHaveLength(2);
    expect(mayInfluence(g, paramValue(g, 0), onlyObs(g))).toBe(true);
    expect(mayInfluence(g, paramValue(g, 1), onlyObs(g))).toBe(true);
  });

  it("an async anonymous function expression lifts too", () => {
    const g = lift("async function (a) { return await a; }");
    expect(mayInfluence(g, paramValue(g), onlyObs(g))).toBe(true);
  });

  it("a bare function body lifts: its returns are observations and its free reads are unknowns", () => {
    const g = lift("{ var x = read(y); return x; }");
    expect(diamondSymbols(g).sort()).toEqual(["read", "y"]);
    expect(g.obs.length).toBeGreaterThan(0);
  });

  it("a bare expression statement lifts (it records no observation, by design)", () => {
    expect(() => liftAtom("[1, 2]")).not.toThrow();
  });

  it("a fragment that parses in no analysis form still throws DucLiftError", () => {
    expect(() => liftAtom("export function f( {")).toThrow(DucLiftError);
    expect(() => liftAtom("}}} {{{")).toThrow(DucLiftError);
  });

  it("a fragment that parses as written is not reshaped", () => {
    // The as-written form wins: a named function's parameters are not renamed.
    const g = lift("function named(a) { return a; }");
    // The observation is the parameter itself (identity return). mayInfluence is
    // irreflexive by definition, so we assert identity, not influence.
    expect(onlyObs(g)).toBe(paramValue(g));
  });
});

describe("the implicit arguments binding is an explained ambient read (WI-EXPLAIN, #1173)", () => {
  it("arguments is an platform-primitive diamond that still feeds the result", () => {
    const g = lift("function f() { return arguments[0]; }");
    const d = g.nodes.find((n) => n.diamond?.symbol === "arguments")?.diamond;
    expect(d?.reason).toBe("platform-primitive");
    expect(usupp(g, onlyObs(g)).map((s) => s.label.symbol)).toContain("arguments");
  });
});

describe("host globals: pure host data is explained, authority-bearing names are not (DEC-DUC-HOST-GLOBALS-001)", () => {
  it("Buffer and TextEncoder are ambient reads", () => {
    const g = lift(
      "export function f(s: string) { return new TextEncoder().encode(Buffer.from(s)); }",
    );
    expect(diamondReasons(g)).toEqual(expect.arrayContaining(["platform-primitive"]));
    expect(diamondSymbols(g)).toEqual(expect.arrayContaining(["Buffer", "TextEncoder"]));
  });
  it("process and the timers are platform primitives; require is not (D5, #1282)", () => {
    // Authority is a label in the target's base set (base-set.ts), not an unexplained name.
    const g = lift("export function f() { return process.env.X; }");
    expect(g.nodes.find((n) => n.diamond?.symbol === "process")?.diamond?.reason).toBe(
      "platform-primitive",
    );
    const t = lift("export function f(cb: () => void) { setTimeout(cb, 0); }");
    expect(t.nodes.find((n) => n.diamond?.symbol === "setTimeout")?.diamond?.reason).toBe(
      "platform-primitive",
    );
    const r = lift("export function f() { return require('m'); }");
    expect(r.nodes.find((n) => n.diamond?.symbol === "require")?.diamond?.reason).toBe("free-identifier");
  });
});

describe("region-scoped returns: a return belongs to its own scope (class methods and loop variables)", () => {
  it("a class method's return of its own parameter is not a free identifier", () => {
    const g = lift("class A { m (y) { return y } }");
    expect(diamondSymbols(g)).not.toContain("y");
  });
  it("a constructor that reassigns and returns its parameter does not report it free", () => {
    const g = lift("class A { constructor (x) { x = x + 1; return x } }");
    expect(diamondSymbols(g)).not.toContain("x");
  });
  it("a return of a loop variable inside the loop is not a free identifier", () => {
    const g = lift("function f (xs) { for (const v of xs) { return v } }");
    expect(diamondSymbols(g)).not.toContain("v");
  });
  it("a genuine free read inside a method is still reported", () => {
    const g = lift("class A { m () { return g } }");
    expect(g.nodes.find((n) => n.diamond?.symbol === "g")?.diamond?.reason).toBe("free-identifier");
  });
  it("a return inside a nested method is not an observation of the enclosing atom", () => {
    const g = lift("class A { m (y) { return y } }");
    expect(g.obs).toHaveLength(0);
  });
});

describe("nested function declarations and JSDoc (residue defects found in bcryptjs)", () => {
  it("a call to a nested function declaration resolves to it, not a free identifier", () => {
    const g = lift("function outer (len) { function random (n) { return n } return random(len) }");
    expect(diamondSymbols(g)).not.toContain("random");
  });
  it("a call that precedes a nested function declaration (hoisting) resolves to it", () => {
    const g = lift("function outer (len) { return random(len); function random (n) { return n } }");
    expect(diamondSymbols(g)).not.toContain("random");
  });
  it("a recursive nested function does not report its own name as free", () => {
    const g = lift(
      "function outer (n) { function fact (k) { return k <= 1 ? 1 : k * fact(k - 1) } return fact(n) }",
    );
    expect(diamondSymbols(g)).not.toContain("fact");
  });
  it("a nested function reading an outer parameter binds it, not a free identifier", () => {
    const g = lift("function outer (p) { function f () { return p } return f() }");
    expect(diamondSymbols(g)).not.toContain("p");
  });
  it("a genuine free read inside a nested function is still reported", () => {
    const g = lift("function outer (len) { function f (n) { return n + g } return f(len) }");
    expect(diamondSymbols(g)).toContain("g");
  });
  it("JSDoc tag names on a nested function are not free identifiers", () => {
    const g = lift(
      "function outer (len) {\n/**\n * Generates bytes.\n * @param {number} len Bytes length\n * @returns {number} Random bytes\n */\nfunction random (n) { return n }\nreturn random(len) }",
    );
    expect(diamondSymbols(g)).not.toContain("param");
    expect(diamondSymbols(g)).not.toContain("returns");
    expect(diamondSymbols(g)).not.toContain("random");
  });
  it("a nested function reading a later-declared local is reported (sound, conservative)", () => {
    // The function is bound at its own position because it reads a name declared later
    // in the same body. That name is an unknown here, never a missing edge.
    const g = lift("function outer () { function f () { return K } const K = 1; return f() }");
    expect(diamondSymbols(g)).toContain("K");
  });
});

describe("labels, class self-reference, and pure legacy globals (residue defects)", () => {
  it("a statement label and its break target are not free identifiers", () => {
    const g = lift("function f (xs) { loop1: for (const x of xs) { if (x) break loop1; } return xs }");
    expect(diamondSymbols(g)).not.toContain("loop1");
  });
  it("a continue to a label is not a free identifier", () => {
    const g = lift("function f (xs) { outer: for (const x of xs) { for (const y of x) { continue outer; } } return xs }");
    expect(diamondSymbols(g)).not.toContain("outer");
  });
  it("a class's own name inside its method is a self-reference, not a free identifier", () => {
    const g = lift("class C { m (range, options) { return new C(range, options) } }");
    expect(diamondSymbols(g)).not.toContain("C");
  });
  it("the pure legacy codecs escape and unescape are explained", () => {
    const g = lift("function f (x) { return unescape(escape(x)) }");
    const reasonOf = (sym: string) => g.nodes.find((n) => n.diamond?.symbol === sym)?.diamond?.reason;
    expect(reasonOf("unescape")).toBe("platform-primitive");
    expect(reasonOf("escape")).toBe("platform-primitive");
  });
  it("WeakRef stays unexplained: its deref is not a pure function of its argument", () => {
    const g = lift("function f (x) { return new WeakRef(x) }");
    expect(diamondSymbols(g)).toContain("WeakRef");
  });
});
