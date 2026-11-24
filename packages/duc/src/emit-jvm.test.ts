// SPDX-License-Identifier: Apache-2.0
/**
 * The JVM lowering (#1311, DEC-DUC-BYTECODE-TARGETS-001): the same stack IR as the WasmGC lowering,
 * written as class files and run on a JVM, which verifies them as it loads them. It is checked on
 * the cases the WasmGC lowering is (`__fixtures__/bytecode-cases.ts`): every runtime atom against
 * the builtin it defines, and every program against the TypeScript reference. Every comparison is
 * exact: `Object.is` for numbers, unit for unit for strings, element by element for arrays.
 *
 * Needs a JDK (java and javac); without one the suite is skipped, as the native suites are.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALL_ATOMS,
  DEFINES,
  DOUBLES,
  DYNAMIC_OPS,
  NUMERIC_STRINGS,
  PROGRAMS,
  anyValue,
  atomInJs,
  outcome,
  same,
} from "./__fixtures__/bytecode-cases.js";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { JvmEmitError, emitJvm, jdkAvailable, runJvm } from "./emit-jvm.js";
import { emitTypeScript } from "./emit-ts.js";
import { WasmEmitError, emitWasm } from "./emit-wasm.js";
import { liftAtom } from "./lift.js";

const jdk = jdkAvailable();

/** A runtime atom lowered alone, run on a JVM over every argument list. */
function atomOnJvm(key: string, calls: readonly (readonly unknown[])[]): unknown[] {
  const a = ALL_ATOMS[key] as { source: string; inputs: readonly string[]; output: string };
  return runJvm(emitJvm(liftAtom(a.source), { inputs: a.inputs, output: a.output }), calls);
}

/** The differences between what was got and what was wanted, the first five. */
function differences(
  calls: readonly (readonly unknown[])[],
  got: readonly unknown[],
  want: (args: readonly unknown[]) => unknown,
): string[] {
  const bad: string[] = [];
  calls.forEach((args, i) => {
    const w = want(args);
    if (!same(got[i], w) && bad.length < 5)
      bad.push(`${JSON.stringify(args)}: ${String(got[i])} vs ${String(w)}`);
  });
  return bad;
}

describe.skipIf(!jdk)("runtime atoms on a JVM define the builtins exactly (#1311)", () => {
  for (const [key, builtin, args] of DEFINES)
    it(`${key}, on 400 inputs`, () => {
      const calls = fc.sample(args, { numRuns: 400, seed: 13000 });
      expect(
        differences(calls, atomOnJvm(key, calls), (a) =>
          (builtin as (...x: unknown[]) => unknown)(...a),
        ),
      ).toEqual([]);
    }, 120_000);

  it(`Number::toString on ${DOUBLES.length} doubles, as V8 writes them`, () => {
    const calls = DOUBLES.map((x) => [x]);
    expect(differences(calls, atomOnJvm("__ykNumberToString", calls), ([x]) => String(x))).toEqual(
      [],
    );
  }, 300_000);

  it(`StringToNumber on ${NUMERIC_STRINGS.length} strings, as Number reads them`, () => {
    const calls = NUMERIC_STRINGS.map((s) => [s]);
    expect(differences(calls, atomOnJvm("__ykStringToNumber", calls), ([s]) => Number(s))).toEqual(
      [],
    );
  }, 300_000);

  it("the big-integer atoms agree with their JavaScript form", () => {
    const limbs = fc.array(fc.integer({ min: 0, max: 2 ** 24 - 1 }), { maxLength: 8 });
    const pairs = fc
      .sample(fc.tuple(limbs, limbs), { numRuns: 300, seed: 1311 })
      .map(([a, b]) => [trim(a), trim(b)]);
    for (const key of ["__ykBigAdd", "__ykBigCmp"])
      expect(
        differences(pairs, atomOnJvm(key, pairs), (a) => atomInJs(key)(...a)),
        key,
      ).toEqual([]);
  }, 120_000);

  for (const [name, key, meaning, engine] of DYNAMIC_OPS)
    it(`${name} agrees with the engine on every kind of value`, () => {
      const arity = (ALL_ATOMS[key] as { inputs: readonly string[] }).inputs.length;
      const calls = fc
        .sample(fc.tuple(anyValue, anyValue), { numRuns: 1000, seed: 1302 })
        .map(([a, b]) => (arity === 1 ? [a] : [a, b]));
      const got = atomOnJvm(key, calls).map(meaning);
      expect(differences(calls, got, (a) => engine(a[0], a[1]))).toEqual([]);
    }, 120_000);
});

/** Big-integer limbs with no high zero limb, the atoms' normal form. */
function trim(xs: number[]): number[] {
  const out = [...xs];
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}

describe.skipIf(!jdk)(
  "programs on a JVM compute what the TypeScript reference does (#1311)",
  () => {
    for (const [name, source, inputs, output, args] of PROGRAMS)
      it(name, () => {
        const g = liftAtom(source);
        const ref = new Function(`${runnable(emitTypeScript(g))}; return f;`)() as (
          ...a: unknown[]
        ) => unknown;
        const calls = fc.sample(args, { numRuns: 400, seed: 13001 });
        const got = runJvm(emitJvm(g, { inputs, output }), calls);
        expect(differences(calls, got, (a) => outcome(ref, a))).toEqual([]);
      }, 120_000);

    it("every emit case the typed wasm lowering takes, the JVM lowering takes, and computes the same", () => {
      let compared = 0;
      const refused: string[] = [];
      for (const tc of EMIT_CASES) {
        const g = liftAtom(tc.source);
        const inputs =
          tc.args[0]?.map((a) => (typeof a === "boolean" ? "boolean" : "number")) ?? [];
        let typed: ReturnType<typeof emitWasm>;
        try {
          typed = emitWasm(g, { inputs });
        } catch (e) {
          if (e instanceof WasmEmitError) continue;
          throw e;
        }
        const output = typed.booleanResult ? "boolean" : "number";
        let m: ReturnType<typeof emitJvm>;
        try {
          m = emitJvm(g, { inputs, output });
        } catch (e) {
          // Only the host functions with no exact JVM counterpart (classified (b)) may be refused.
          if (e instanceof JvmEmitError && /no exact counterpart/.test(e.message)) {
            refused.push(`${tc.name}: ${e.message}`);
            continue;
          }
          throw e;
        }
        const ref = new Function(`${runnable(emitTypeScript(g))}; return f;`)() as (
          ...a: unknown[]
        ) => unknown;
        expect(
          differences(tc.args, runJvm(m, tc.args), (a) => outcome(ref, a)),
          tc.name,
        ).toEqual([]);
        compared++;
      }
      expect(compared).toBeGreaterThanOrEqual(3);
      expect(refused.length).toBeLessThanOrEqual(compared);
    }, 300_000);
  },
);

/** Doubles for the host functions: specials, small integers and halves, and every range. */
const hostArg = fc.oneof(
  fc.constantFrom(
    0,
    -0,
    0.5,
    -0.5,
    1,
    -1,
    1.5,
    -1.5,
    2.5,
    -2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ),
  fc.constantFrom(
    Number.NEGATIVE_INFINITY,
    2 ** 52 + 1,
    -(2 ** 52) - 1,
    4503599627370495.5,
    0.49999999999999994,
  ),
  fc.double({ min: -10, max: 10 }),
  fc.double(),
);

describe.skipIf(!jdk)("ECMAScript's host functions on a JVM agree with V8 (#1311)", () => {
  const HOST: [string, number][] = [
    ["%", 2],
    ["**", 2],
    ...[
      "round",
      "sign",
      "fround",
      "expm1",
      "log",
      "log1p",
      "log10",
      "sin",
      "cos",
      "tan",
      "asin",
      "acos",
      "atan",
      "sinh",
      "tanh",
    ].map((m): [string, number] => [`Math.${m}`, 1]),
    ...["pow"].map((m): [string, number] => [`Math.${m}`, 2]),
  ];
  for (const [fn, arity] of HOST)
    it(`${fn}, on 1000 arguments`, () => {
      const params = arity === 1 ? "x: number" : "x: number, y: number";
      const call = fn.startsWith("Math.") ? `${fn}(${arity === 1 ? "x" : "x, y"})` : `x ${fn} y`;
      const g = liftAtom(`export function f(${params}): number { return ${call}; }`);
      const ref = new Function(`${runnable(emitTypeScript(g))}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const calls = fc
        .sample(fc.tuple(hostArg, hostArg), { numRuns: 1000, seed: 1311 })
        .map(([x, y]) => (arity === 1 ? [x] : [x, y]));
      const inputs = arity === 1 ? ["number"] : ["number", "number"];
      const got = runJvm(emitJvm(g, { inputs, output: "number" }), calls);
      expect(differences(calls, got, (a) => outcome(ref, a))).toEqual([]);
    }, 120_000);
});

describe("what the JVM lowering refuses, with the reason (#1311)", () => {
  const refusal = (source: string, inputs: string[], output: string): string => {
    try {
      emitJvm(liftAtom(source), { inputs, output });
    } catch (e) {
      if (e instanceof JvmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("a host function with no exact JVM counterpart, and what the shared lowering refuses", () => {
    expect(
      refusal(
        "export function f(x: number): number { return Math.asinh(x); }",
        ["number"],
        "number",
      ),
    ).toMatch(/Math.asinh has no exact counterpart on the JVM yet/);
    // V8's exp differs from StrictMath's in the last place: refused, not approximated.
    expect(
      refusal("export function f(x: number): number { return Math.exp(x); }", ["number"], "number"),
    ).toMatch(/Math.exp has no exact counterpart on the JVM yet/);
    expect(
      refusal(
        "export function f(s: string): string { return s.toUpperCase(); }",
        ["string"],
        "string",
      ),
    ).toMatch(/toUpperCase is not in the subset yet/);
  });
});
