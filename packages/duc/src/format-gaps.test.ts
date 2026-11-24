// SPDX-License-Identifier: Apache-2.0
/**
 * Two (c) gaps for the format lock (#1292, #1361 M1): what the graph did not record, so no lowering
 * could recover it.
 * - #1360: an optional chain short-circuits as a whole (`a?.b.c` is undefined when a is nullish);
 *   the graph now states it as a branch on the chain's base.
 * - #1349: function declarations that call one another are bound through cells, so a forward
 *   reference is structure, not a free name.
 * Each case runs as the source and as the graph lowered to TypeScript, and the round trip holds.
 */
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

type Fn = (...a: unknown[]) => unknown;

const compile = (code: string): Fn => new Function(`${runnable(code)}; return f;`)() as Fn;
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

const freeNames = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(n.diamond?.reason === "free-identifier" ? [n.diamond.symbol] : []),
    ...(n.closure !== undefined ? freeNames(n.closure) : []),
  ]);

const labels = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(n.label !== undefined ? [n.label] : []),
    ...(n.closure !== undefined ? labels(n.closure) : []),
  ]);

function agrees(code: string, inputs: unknown[][]): void {
  const g = liftAtom(code);
  const lowered = emitTypeScript(g);
  const a = source(code);
  const b = compile(lowered);
  for (const args of inputs)
    expect(outcome(b, args), `${code} on ${JSON.stringify(args)}`).toBe(outcome(a, args));
  expect(graphIdentity(liftAtom(lowered)), code).toBe(graphIdentity(g));
}

describe("an optional chain short-circuits as a whole (#1360)", () => {
  const obj = { b: { c: 5, d: { e: 7 } }, m: (x: number) => x + 1, k: { x: (y: number) => y * 2 } };
  const inputs = [[null], [undefined], [obj], [{ b: null }], [{}]];

  it("a?.b.c: undefined when a is nullish, and .c is never read", () => {
    agrees("export function f(a: any) { return a?.b.c; }", inputs);
    // The base is tested once; nothing after it is read on that side.
    const g = liftAtom("export function f(a: any) { return a?.b.c; }");
    expect(labels(g)).toContain("js.loose_eq");
    expect(labels(g)).not.toContain("?.b");
  });

  it("a?.m(1): the call short-circuits too, with its receiver", () => {
    agrees("export function f(a: any) { return a?.m(1); }", inputs);
  });

  it("nested chains, keyed reads and calls on the rest", () => {
    agrees("export function f(a: any) { return a?.b?.d.e; }", inputs);
    agrees("export function f(a: any) { return a?.['k'].x(2); }", inputs);
    agrees("export function f(a: any) { return a?.b!.c; }", inputs);
  });

  it("the base is evaluated once, side effects included", () => {
    agrees(
      "export function f(a: any) { let n = 0; const g = () => { n++; return a; }; const r = g()?.b.c; return [r, n]; }",
      inputs,
    );
  });

  it("a chain of one optional link stays one operation, and parentheses end a chain", () => {
    expect(labels(liftAtom("export function f(a: any) { return a?.b; }"))).toContain("?.b");
    expect(labels(liftAtom("export function f(a: any, k: string) { return a?.[k]; }"))).toContain(
      "ElementAccess?.",
    );
    expect(labels(liftAtom("export function f(g: any) { return g?.(); }"))).toContain(
      "CallExpression?.",
    );
    // (a?.b).c reads .c of undefined: a TypeError, as written.
    agrees("export function f(a: any) { return (a?.b).c; }", [[null], [obj]]);
  });
});

describe("function declarations that call one another (#1349)", () => {
  const EVEN_ODD = `export function f(n: number): boolean {
  function ev(k: number): boolean { return k === 0 ? true : od(k - 1); }
  function od(k: number): boolean { return k === 0 ? false : ev(k - 1); }
  return ev(n);
}`;

  it("the forward reference is a cell, not a free name, and the lowering runs", () => {
    expect(freeNames(liftAtom(EVEN_ODD))).toEqual([]);
    agrees(EVEN_ODD, [[0], [1], [2], [7], [10]]);
  });

  it("called before the declarations, as hoisting allows", () => {
    agrees(
      `export function f(n: number): number {
  const r = a(n);
  function a(k: number): number { return k <= 0 ? 0 : 1 + b(k - 1); }
  function b(k: number): number { return k <= 0 ? 0 : 2 + a(k - 1); }
  return r;
}`,
      [[0], [1], [5]],
    );
  });

  it("three in a cycle, and one reading a var", () => {
    agrees(
      `export function f(n: number): number {
  function x(k: number): number { return k <= 0 ? base : y(k - 1) + 1; }
  function y(k: number): number { return z(k) * 2; }
  function z(k: number): number { return x(k); }
  var base = 3;
  return x(n);
}`,
      [[0], [1], [3]],
    );
  });
});
