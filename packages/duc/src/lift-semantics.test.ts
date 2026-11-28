// SPDX-License-Identifier: Apache-2.0
/**
 * The lift findings of #1370, fixed together. Each case runs as written (TypeScript's transpile) and
 * as its lifted graph lowered back to TypeScript, on the same inputs, and must agree; its graph has
 * no opaque node, and the round trip gives the same identity.
 *
 * 1. `in` and `instanceof` under a short-circuit or a ternary run only on the paths that reach them.
 * 2. A TypeScript `this:` parameter is no argument.
 * 3. A function declaration or expression is a function (it has a `prototype`, `new` constructs with
 *    it) whether or not it reads `this`.
 * 4. An operator that converts an operand that may be an object (`valueOf`, `toString`) is ordered
 *    with the reads and writes around it, and runs only on its own paths.
 * 5. A function's `length` is its parameters before the first with a default or a rest one, kept
 *    through the round trip.
 * 6. Array destructuring is the iterator protocol, closed when not exhausted.
 * 7. `super` in an object literal's method is the literal's prototype.
 */
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { LlvmEmitError, emitLlvmBoxed } from "./emit-llvm-boxed.js";
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

const asWritten = (code: string): Fn =>
  new Function(
    `${ts
      .transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "")}; return f;`,
  )() as Fn;

const lowered = (code: string): Fn =>
  new Function(
    `${ts
      .transpileModule(runnable(code), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "")}; return f;`,
  )() as Fn;

/** A result as text that keeps undefined, NaN, -0, BigInts, Symbols and functions apart. */
const show = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x === undefined
      ? "<undefined>"
      : typeof x === "bigint"
        ? `<${x}n>`
        : typeof x === "symbol"
          ? `<${String(x)}>`
          : typeof x === "function"
            ? `<fn ${x.name}>`
            : typeof x === "number" && (Number.isNaN(x) || Object.is(x, -0))
              ? `<${Object.is(x, -0) ? "-0" : "NaN"}>`
              : x,
  ) ?? "<undefined>";

const outcome = (run: () => unknown): string => {
  try {
    return `= ${show(run())}`;
  } catch (e) {
    return `throws ${(e as Error)?.constructor?.name ?? String(e)}`;
  }
};

/** The lifted graph agrees with the source on every input, has no opaque node, and round-trips. */
function agrees(code: string, inputs: unknown[][], call?: (f: Fn) => unknown): void {
  const g = liftAtom(code);
  expect(opaque(g), code).toEqual([]);
  const text = emitTypeScript(g);
  const a = asWritten(code);
  const b = lowered(text);
  const cases = call !== undefined ? [[]] : inputs;
  for (const args of cases) {
    const want = outcome(() => (call !== undefined ? call(a) : a(...args)));
    const got = outcome(() => (call !== undefined ? call(b) : b(...args)));
    expect(got, `${code} on ${show(args)}`).toBe(want);
  }
  expect(graphIdentity(liftAtom(text)), code).toBe(graphIdentity(g));
}

describe("1. in and instanceof run only where they are reached", () => {
  it.each([
    ["typeof a === 'object' && 'k' in a", [[5], [{ k: 1 }], [null]]],
    ["a === 1 || 'k' in a", [[1], [{}], [{ k: 0 }]]],
    ["a ?? ('k' in a)", [[1], [null]]],
    ["a ? 'k' in a : 0", [[0], [{ k: 1 }]]],
    ["typeof a === 'function' && 0 instanceof a", [[1], [Array]]],
    ["!!a && !!a.b && 'c' in a.b", [[0], [{ b: 1 }], [{ b: { c: 1 } }]]],
  ] as const)("%s", (expr, inputs) => {
    agrees(`export function f(a) { return ${expr}; }`, inputs as unknown as unknown[][]);
  });

  it("a guard chain over a symbol key", () => {
    agrees(
      "export function f(x) { const sym = Symbol('c'); return x !== null && (typeof x === 'object' || typeof x === 'function') && sym in x; }",
      [[5], [{}], [null], [() => 1]],
    );
  });
});

describe("2. a TypeScript this parameter is erased", () => {
  it("does not shift the arguments", () => {
    agrees(
      "export function f(this: { k: number }, a: number): number { return this.k + a; }",
      [],
      (f) => f.call({ k: 2 }, 1),
    );
  });

  it("does not count in the length, with a default after it", () => {
    agrees(
      "export function f(this: { k: number }, a: number, b = 2): number { return this.k + a + b; }",
      [],
      (f) => [f.call({ k: 1 }, 1), f.length],
    );
  });
});

describe("3. a function is a function whether or not it reads this", () => {
  it.each([
    ["declaration with a prototype method", "function F() {} F.prototype.m = a; return new F().m;"],
    [
      "expression with a prototype",
      "const F = function () { return; }; F.prototype.k = a; return [typeof F.prototype, new F().k];",
    ],
    ["new.target", "function F() { return new.target === F; } return [F(), new F() instanceof F];"],
    [
      "a constructor returning an object",
      "function F() { return new Map(); } F.prototype.k = 1; return [F.prototype.k, new F() instanceof Map];",
    ],
    ["an arrow has none", "const g = () => 1; return [g.prototype, typeof g];"],
    [
      "a method is no constructor",
      "const o = { m() { return 1; } }; try { new o.m(); return 'made'; } catch (e) { return [e.name, o.m.prototype]; }",
    ],
    ["an async function has no prototype", "async function A() {} return [A.prototype, typeof A];"],
    ["a generator has one", "function* G() { yield 1; } return [typeof G.prototype, [...G()]];"],
    ["arguments", "function g() { return arguments.length; } return g(1, 2, a);"],
  ])("%s", (_name, body) => {
    agrees(`export function f(a) { ${body} }`, [[3]]);
  });
});

describe("4. an operand's conversion is ordered, and lazy", () => {
  it.each([
    ["+", "let x = 0; const o = { valueOf() { x++; return 5; } }; return [o + 1, x];"],
    ["<", "let x = 0; const o = { valueOf() { x += 2; return a; } }; return [o < 3, x];"],
    [
      "a template",
      "let x = 'a'; const o = { toString() { x = 'b'; return 'o'; } }; return [`${o}`, x];",
    ],
    ["==", "let x = 0; const o = { valueOf() { x = 7; return a; } }; return [o == 1, x];"],
    [
      "a read before it",
      "let x = 0; const o = { valueOf() { x++; return 5; } }; const before = x; const s = o * 2; return [before, s, x];",
    ],
    [
      "in a for loop",
      "let x = 0; const o = { valueOf() { x++; return 1; } }; let s = 0; for (let i = 0; i < 3; i++) s = s + o; return [s, x];",
    ],
    [
      "read after a while loop",
      "let x = 0; const o = { valueOf() { x += 10; return 1; } }; let i = 0; while (i < 2) { i = i + o; } return [i, x];",
    ],
    [
      "under &&",
      "let n = 0; const v = { valueOf() { n++; return 2; } }; const r = a && v * 3; return [r, n];",
    ],
  ])("%s", (_name, body) => {
    agrees(`export function f(a) { ${body} }`, [[0], [1], [9]]);
  });

  it("a BigInt arm and a Number arm run only when chosen", () => {
    agrees("export function f(x) { return typeof x === 'bigint' ? x + 1n : x + 1; }", [
      [1],
      [BigInt(2)],
    ]);
  });

  it("a Symbol is not converted on the path that tests for it", () => {
    agrees("export function f(s) { return typeof s === 'symbol' ? 'sym' : s + '!'; }", [
      ["a"],
      [Symbol("q")],
    ]);
  });

  it("?? stays a value, null and undefined converting nothing", () => {
    agrees("export function f(a, b) { return a ?? b; }", [
      [null, 2],
      [0, 2],
    ]);
  });
});

describe("5. a function's length", () => {
  it.each([
    [
      "a declaration with a default and a rest",
      "function g(a, b = 1, c) {} function h(a, ...r) {} return [g.length, h.length];",
    ],
    ["a plain declaration", "function g(a, b) {} return g.length;"],
    [
      "an expression and an arrow",
      "const g = function (a, b = 1, ...c) {}; const h = (a, b) => {}; return [g.length, h.length];",
    ],
    ["a default of undefined", "function g(a, b = undefined) {} return g.length;"],
  ])("%s", (_name, body) => {
    agrees(`export function f() { ${body} }`, [[]]);
  });
});

describe("6. array destructuring is the iterator protocol", () => {
  it.each([
    ["a Set", "const [p, q] = new Set([a, 2]); return [p, q];"],
    ["a Map's entries", "const m = new Map([[a, 'x']]); const [[k, v]] = m; return [k, v];"],
    [
      "a generator",
      "function* g() { yield a; yield a + 1; } const [x, y, z] = g(); return [x, y, z];",
    ],
    ["a rest", "const [h, ...t] = new Set([a, 2, 3]); return [h, t];"],
    ["an array with a hole and a default", "const [x, , y = 9] = [a, 2]; return [x, y];"],
    ["a string by code points", "const [c, d] = String(a) + '😀x'; return [c, d];"],
    ["an assignment", "let x, y; [x, y] = new Set([a, a * 2]); return [x, y];"],
    ["a parameter", "const g = ([u, v]) => u + v; return g(new Set([a, 10]));"],
    [
      "a for-of head",
      "let s = 0; for (const [k, v] of new Map([[a, 2], [3, 4]])) s += k * v; return s;",
    ],
    ["a default reading an earlier element", "const [x, y = x * 2] = new Set([a]); return [x, y];"],
    ["the swap", "let b = a + 1; let c = a; [b, c] = [c, b]; return [b, c];"],
    [
      "nested with an object pattern",
      "const [{ k }, [p]] = [{ k: a }, new Set([a + 1])]; return [k, p];",
    ],
  ])("%s", (_name, body) => {
    agrees(`export function f(a) { ${body} }`, [[1], [5]]);
  });

  const iterable = (done: string): string =>
    `let closed = 0; const it = { [Symbol.iterator]() { let i = 0; return { next: () => ({ value: i++, done: ${done} }), return() { closed++; return {}; } }; } };`;

  it.each([
    ["closed when not exhausted", `${iterable("false")} const [x] = it; return [x, closed];`],
    ["closed after a hole", `${iterable("i > 5")} const [, b] = it; return [b, closed];`],
    [
      "not closed when exhausted",
      `${iterable("i > 1")} const [a, b, c] = it; return [a, b, c, closed];`,
    ],
    [
      "a result that is no object",
      "const it = { [Symbol.iterator]() { return { next: () => 5 }; } }; try { const [a] = it; return a; } catch (e) { return e.name; }",
    ],
  ])("%s", (_name, body) => {
    agrees(`export function f() { ${body} }`, [[]]);
  });

  it("a value that is not iterable", () => {
    agrees(
      "export function f(a) { try { const [x] = a; return x; } catch (e) { return e.name; } }",
      [[5], [{}], [[7]]],
    );
  });
});

describe("7. super in an object literal's method", () => {
  it("calls the literal's prototype's method", () => {
    agrees(
      "export function f(a) { const proto = { hi() { return 'p' + a; } }; const o = { __proto__: proto, hi() { return super.hi() + '!'; } }; return o.hi(); }",
      [[1]],
    );
  });

  it("reads the prototype's property in a getter", () => {
    agrees(
      "export function f(a) { const proto = { k: a }; const o = { __proto__: proto, get k2() { return super.k * 2; } }; return o.k2; }",
      [[4]],
    );
  });
});

describe("7. natively, until the runtime knows a literal's home object", () => {
  it("super in an object literal's method is refused, not read as undefined", () => {
    const g = liftAtom(
      "export function f(a) { const proto = { hi() { return 'p' + a; } }; const o = { __proto__: proto, hi() { return super.hi() + '!'; } }; return o.hi(); }",
    );
    expect(() => emitLlvmBoxed(g)).toThrow(LlvmEmitError);
    expect(() => emitLlvmBoxed(g)).toThrow(/super in an object literal/);
  });
});

describe("the round trip and the fidelity of these fixes", () => {
  const roundTrips = (src: string): void => {
    const g = liftAtom(src);
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
  };
  it("a literal read in a loop is a primitive, as it is once lowered", () => {
    roundTrips(
      "export function f(p, i) { const m = 3; for (let k = 0; k < 2; k++) { const r = p[k] - i; if (r < m) continue; } return 2; }",
    );
  });
  it("a closure's capture of a literal is a primitive, as it is once lowered", () => {
    roundTrips(
      "const tMin = 1, tMax = 26, base = 36;\nconst f = function (k, bias, w) { for (;;) { for (let j = 0; ; j++) { const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias; if (w < t) break; w = base - t; } return w; } };\nexport { f };",
    );
  });
  it("destructuring reads Symbol, and only that, beyond the source's names", () => {
    for (const src of [
      "export function f(a) { const [x, y] = a; return x + y; }",
      "export function f(a) { let x, y; [x, y] = a; return x; }",
      "export function f(m) { let s = 0; for (const [k, v] of m) s += k * v; return s; }",
    ])
      expect(liftFidelity(src, liftAtom(src))).toEqual({ holds: true, missing: [], extra: [] });
  });
  it("is refused under a Symbol of the program's own, not read through it", () => {
    expect(() =>
      liftAtom("export function f(a) { const Symbol = 1; const [x] = a; return x + Symbol; }"),
    ).toThrow(/Symbol is a binding of the program's own/);
  });
});

describe("8. test262: a read of a name outside the atom where it is written, and the empty pattern", () => {
  it("a bare read of an unresolvable name throws where it stands, in a try", () => {
    agrees(
      "export function f(a) { try { if (a) zzzUnresolvedA; return 'read'; } catch (e) { return e.constructor.name; } }",
      [[0], [1]],
    );
  });

  it("in a closure, when the closure runs", () => {
    agrees(
      "export function f(a) { const g = () => { zzzUnresolvedB; }; if (a) { try { g(); } catch (e) { return e.constructor.name; } } return 'made'; }",
      [[0], [1]],
    );
  });

  it("in order after the calls before it", () => {
    agrees(
      "export function f(a) { const log = [a]; try { log.push(1); zzzUnresolvedC; } catch (e) { log.push(2); } return log; }",
      [[0]],
    );
  });

  it("typeof of a name the atom writes but nothing declares is the reference's", () => {
    agrees(
      "export function f(a) { const g = () => { zzzWrittenD = a; }; return [typeof zzzWrittenD, typeof g]; }",
      [[1]],
    );
  });

  it("an empty object pattern refuses null and undefined", () => {
    agrees(
      "export function f(a) { try { const {} = a; return 'ok'; } catch (e) { return e.constructor.name; } }",
      [[null], [undefined], [{}], [1], ["s"]],
    );
    agrees(
      "export function f(a) { const g = ({}) => 1; try { return g(a); } catch (e) { return e.constructor.name; } }",
      [[null], [{}]],
    );
  });
});

describe("9. a return from a try inside a branch is the function's", () => {
  it.each([
    ["in the try, in an if", "if (a) { try { return 'try'; } catch (e) {} } return 'after';"],
    [
      "in the catch, in an if",
      "if (a) { try { throw 1; } catch (e) { return 'caught'; } } return 'after';",
    ],
    [
      "in the catch, in an else",
      "if (!a) {} else { try { throw 1; } catch (e) { return 'caught'; } } return 'after';",
    ],
    [
      "nested twice",
      "if (a) { if (a > 1) { try { throw a; } catch (e) { return e; } } } return 'after';",
    ],
  ] as const)("%s", (_what, body) => {
    agrees(`export function f(a) { ${body} }`, [[0], [1], [2]]);
  });
});
