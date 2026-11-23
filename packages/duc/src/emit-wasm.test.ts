// SPDX-License-Identifier: Apache-2.0
// Lowering to WebAssembly directly from the graph (#1289): the typed subset (numbers and booleans)
// computes what the source computes, compared with Object.is (NaN and -0 included), on the emit
// cases that fit and on generated inputs; everything else is refused with its reason.
import fc from "fast-check";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { WasmEmitError, type WasmSignature, emitWasm, instantiateWasm } from "./emit-wasm.js";
import { liftAtom } from "./lift.js";

function runSource(source: string, args: readonly unknown[]): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const fn = new Function(`${runnable(js)}; return f;`)() as (...a: unknown[]) => unknown;
  return fn(...args);
}

/** The signature a source declares: its parameters' types and its return type. */
function signatureOf(source: string): WasmSignature {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile("s.ts", source);
  const fn = sf.getFunctions()[0];
  if (fn === undefined) throw new Error("no function");
  const output = fn.getReturnTypeNode()?.getText();
  return {
    inputs: fn.getParameters().map((p) => p.getTypeNode()?.getText() ?? "unknown"),
    ...(output !== undefined ? { output } : {}),
  };
}

async function lowered(source: string): Promise<(...a: unknown[]) => unknown> {
  return instantiateWasm(emitWasm(liftAtom(source), signatureOf(source)));
}

describe("lowering to WebAssembly: the emit cases that fit the subset (#1289)", () => {
  const fits: string[] = [];
  const refused: string[] = [];
  for (const tc of EMIT_CASES) {
    let ok = true;
    try {
      emitWasm(liftAtom(tc.source), signatureOf(tc.source));
    } catch (e) {
      if (!(e instanceof WasmEmitError)) throw e;
      ok = false;
    }
    (ok ? fits : refused).push(tc.name);
    if (!ok) continue;
    it(`computes what the source computes: ${tc.name}`, async () => {
      const f = await lowered(tc.source);
      for (const args of tc.args)
        expect(Object.is(f(...args), runSource(tc.source, args)), JSON.stringify(args)).toBe(true);
    });
  }
  it("the cases outside the subset are refused, not lowered wrong", () => {
    expect(fits.length).toBeGreaterThanOrEqual(3);
    expect(fits.length + refused.length).toBe(EMIT_CASES.length);
  });
});

/** Sources in the subset, with a generator for their inputs. */
const PROGRAMS: [string, string, fc.Arbitrary<unknown[]>][] = [
  [
    "arithmetic, comparison and selection",
    "export function f(a: number, b: number): number { const m = a < b ? a : b; return (m * 3 - b / 2) % 7; }",
    fc.tuple(fc.double(), fc.double()),
  ],
  [
    "a loop with an early exit",
    "export function f(n: number, k: number): number { let i = 0; let s = 0; while (i < n) { if (s > k) break; s = s + i * i; i = i + 1; } return s; }",
    fc.tuple(fc.integer({ min: -5, max: 200 }), fc.integer({ min: -10, max: 100000 })),
  ],
  [
    "a loop inside a branch, nested loops",
    "export function f(n: number): number { let t = 0; if (n > 0) { let i = 0; while (i < n) { let j = 0; while (j < i) { t = t + j; j = j + 1; } i = i + 1; } } else { t = -n; } return t; }",
    fc.tuple(fc.integer({ min: -50, max: 40 })),
  ],
  [
    "booleans and JavaScript's truthiness",
    "export function f(a: number, b: boolean): boolean { return (!a && b) || (a !== a) === b || (a > 0 && !b); }",
    fc.tuple(fc.oneof(fc.double(), fc.constantFrom(0, -0, Number.NaN)), fc.boolean()),
  ],
  [
    "Math, native and imported",
    "export function f(x: number, y: number): number { return Math.floor(x) - Math.ceil(y) + Math.abs(x - y) + Math.min(x, y, 3) + Math.max(-0, x) + Math.round(y) + Math.sqrt(Math.abs(x)) + x ** 2 + Math.PI; }",
    fc.tuple(fc.double(), fc.double()),
  ],
  [
    "early returns",
    "export function f(x: number): number { if (x !== x) return -1; if (x < 0) return x * -2; if (x === 0) return 1 / x; return x - 0.5; }",
    fc.tuple(fc.oneof(fc.double(), fc.constantFrom(0, -0, Number.NaN))),
  ],
];

describe("lowering to WebAssembly: generated inputs (#1289)", () => {
  for (const [name, source, inputs] of PROGRAMS) {
    it(`agrees with the source on every input: ${name}`, async () => {
      const f = await lowered(source);
      fc.assert(
        fc.property(inputs, (args) => Object.is(f(...args), runSource(source, args))),
        { numRuns: 300 },
      );
    });
  }
});

describe("lowering to WebAssembly: what is refused (#1289)", () => {
  const refusal = (source: string): string => {
    try {
      emitWasm(liftAtom(source), signatureOf(source));
    } catch (e) {
      if (e instanceof WasmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("a string parameter, an array, a throw, a free name, a closure", () => {
    expect(refusal("export function f(s: string): number { return s.length; }")).toMatch(
      /not a number or a boolean/,
    );
    expect(refusal("export function f(xs: number[]): number { return xs[0]; }")).toMatch(
      /not a number or a boolean/,
    );
    expect(
      refusal(
        "export function f(x: number): number { if (x < 0) throw new Error('neg'); return x; }",
      ),
    ).toMatch(/not in the wasm base set|not in the subset/);
    expect(refusal("export function f(x: number): number { return helper(x); }")).toMatch(
      /"helper" is not in the wasm base set/,
    );
    expect(
      refusal(
        "export function f(x: number): number { const g = (y: number) => y + x; return g(1); }",
      ),
    ).toMatch(/closure|not in the subset/);
  });
  it("an operation that can give a number or a boolean", () => {
    expect(refusal("export function f(a: number, b: boolean): boolean { return a && b; }")).toMatch(
      /mixes a number and a boolean/,
    );
  });
  it("a result whose type is not the contract's", () => {
    expect(refusal("export function f(a: number, b: number): number { return a < b; }")).toMatch(
      /contract says number/,
    );
  });
});
