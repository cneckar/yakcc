// SPDX-License-Identifier: Apache-2.0
/**
 * WasmGC (DEC-DUC-WASM-MEMORY-001, #1300): strings as arrays of UTF-16 units, and the runtime's
 * operations as atoms. Every runtime atom is checked against the builtin it defines, twice: run
 * as JavaScript over the primitives' JavaScript forms, and lowered to WasmGC and run in Node's
 * engine. Then programs over strings and numbers are lowered and compared with the TypeScript
 * reference (`emitTypeScript` of the same graph). Every comparison is exact: `Object.is` for
 * numbers, unit for unit for strings.
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
  same,
} from "./__fixtures__/bytecode-cases.js";
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { emitTypeScript } from "./emit-ts.js";
import { emitWasmGc, instantiateWasmGc } from "./emit-wasm-gc.js";
import { WasmEmitError, emitWasm } from "./emit-wasm.js";
import { liftAtom } from "./lift.js";
import {
  BIGNUM_ATOMS,
  DYNAMIC_ATOMS,
  RUNTIME_ATOMS,
  RUNTIME_PRIMITIVES_JS,
} from "./wasm-runtime-atoms.js";

/** A runtime atom lowered alone: a module whose `f` is the atom. */
async function atomInWasm(key: string): Promise<(...a: unknown[]) => unknown> {
  const a = ALL_ATOMS[key] as { source: string; inputs: readonly string[]; output: string };
  return instantiateWasmGc(emitWasmGc(liftAtom(a.source), { inputs: a.inputs, output: a.output }));
}

describe("runtime atoms define the builtins exactly (#1300)", () => {
  for (const [key, builtin, args] of DEFINES) {
    it(`${key}: as JavaScript and as WasmGC, on 400 inputs`, async () => {
      const js = atomInJs(key);
      const wasm = await atomInWasm(key);
      const inputs = fc.sample(args, { numRuns: 400, seed: 13000 });
      const bad: string[] = [];
      for (const a of inputs) {
        const want = (builtin as (...x: unknown[]) => unknown)(...a);
        for (const [how, got] of [
          ["js", js(...a)],
          ["wasm", wasm(...a)],
        ] as const)
          if (!Object.is(got, want))
            bad.push(
              `${how} ${JSON.stringify(a)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`,
            );
      }
      expect(bad.slice(0, 5)).toEqual([]);
    }, 60_000);
  }
});

describe("Number::toString as a runtime atom (#1300)", () => {
  it(`the shortest round-trip digits and ECMAScript's layout, as V8 writes them, on ${DOUBLES.length} doubles: as JavaScript and as WasmGC`, async () => {
    const js = atomInJs("__ykNumberToString");
    const wasm = await atomInWasm("__ykNumberToString");
    const bad: string[] = [];
    for (const x of DOUBLES) {
      const want = String(x);
      for (const [how, got] of [
        ["js", js(x)],
        ["wasm", wasm(x)],
      ] as const)
        if (got !== want) bad.push(`${how} ${want}: ${String(got)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);

  it("the big-integer atoms agree with BigInt", async () => {
    const limbs = (b: bigint): number[] => {
      const out: number[] = [];
      for (let v = b; v > 0n; v >>= 24n) out.push(Number(v & 0xffffffn));
      return out;
    };
    const value = (xs: readonly number[]): bigint =>
      xs.reduceRight((acc, l) => (acc << 24n) + BigInt(l), 0n);
    const big = fc.bigInt({ min: 0n, max: 2n ** 200n });
    const add = atomInJs("__ykBigAdd");
    const sub = atomInJs("__ykBigSub");
    const cmp = atomInJs("__ykBigCmp");
    const mul = atomInJs("__ykBigMulSmall");
    const from = atomInJs("__ykBigFromInt");
    for (const [a, b] of fc.sample(fc.tuple(big, big), { numRuns: 300, seed: 1300 })) {
      expect(value(add(limbs(a), limbs(b)) as number[])).toBe(a + b);
      expect(cmp(limbs(a), limbs(b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      const [hi, lo] = a >= b ? [a, b] : [b, a];
      const d = sub(limbs(hi), limbs(lo)) as number[];
      expect(value(d)).toBe(hi - lo);
      expect(d.length === 0 || d[d.length - 1] !== 0).toBe(true);
      expect(value(mul(limbs(a), 10) as number[])).toBe(a * 10n);
    }
    for (const n of [0, 1, 2 ** 24 - 1, 2 ** 24, 2 ** 53 - 1])
      expect(value(from(n) as number[])).toBe(BigInt(n));
  }, 120_000);
});

describe("StringToNumber as a runtime atom (#1300)", () => {
  it(`reads ${NUMERIC_STRINGS.length} strings as Number does, correctly rounded: as JavaScript and as WasmGC`, async () => {
    const js = atomInJs("__ykStringToNumber");
    const wasm = await atomInWasm("__ykStringToNumber");
    const bad: string[] = [];
    for (const s of NUMERIC_STRINGS) {
      const want = Number(s);
      for (const [how, got] of [
        ["js", js(s)],
        ["wasm", wasm(s)],
      ] as const)
        if (!Object.is(got, want)) bad.push(`${how} ${JSON.stringify(s)}: ${String(got)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);
});

describe("the dynamic-value atoms define ECMAScript's operators (#1300)", () => {
  for (const [name, key, meaning, engine] of DYNAMIC_OPS)
    it(`${name} agrees with the engine on every kind of value: as JavaScript and as WasmGC`, async () => {
      const arity = (ALL_ATOMS[key] as { inputs: readonly string[] }).inputs.length;
      const js = atomInJs(key);
      const wasm = await atomInWasm(key);
      const bad: string[] = [];
      for (const [a, b] of fc.sample(fc.tuple(anyValue, anyValue), { numRuns: 1000, seed: 1302 })) {
        const args = arity === 1 ? [a] : [a, b];
        const want = engine(a, b);
        for (const [how, got] of [
          ["js", meaning(js(...args))],
          ["wasm", meaning(wasm(...args))],
        ] as const)
          if (!Object.is(got, want))
            bad.push(`${how} ${JSON.stringify(args)}: ${String(got)} vs ${String(want)}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
    }, 120_000);
});

describe("programs over strings, lowered to WasmGC (#1300)", () => {
  for (const [name, source, inputs, output, args] of PROGRAMS) {
    it(`computes what the TypeScript reference computes: ${name}`, async () => {
      const g = liftAtom(source);
      const ref = new Function(`${runnable(emitTypeScript(g))}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const wasm = await instantiateWasmGc(emitWasmGc(g, { inputs, output }));
      const bad: string[] = [];
      for (const a of fc.sample(args, { numRuns: 400, seed: 13001 })) {
        const want = ref(...a);
        const got = wasm(...a);
        if (!same(got, want))
          bad.push(`${JSON.stringify(a)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
      }
      expect(bad.slice(0, 5)).toEqual([]);
    }, 60_000);
  }

  it("the module holds only the runtime atoms it reaches", () => {
    const m = emitWasmGc(
      liftAtom("export function f(s: string): number { return s.trim().length; }"),
      {
        inputs: ["string"],
        output: "number",
      },
    );
    expect(m.atoms).toEqual(["__ykTrim"]);
  });
});

describe("the WasmGC lowering subsumes the typed one (#1289)", () => {
  it("every emit case the typed lowering takes, it takes, and computes the same", async () => {
    let compared = 0;
    for (const tc of EMIT_CASES) {
      const g = liftAtom(tc.source);
      const inputs = tc.args[0]?.map((a) => (typeof a === "boolean" ? "boolean" : "number")) ?? [];
      let typed: ReturnType<typeof emitWasm>;
      try {
        typed = emitWasm(g, { inputs });
      } catch (e) {
        if (e instanceof WasmEmitError) continue;
        throw e;
      }
      const output = typed.booleanResult ? "boolean" : "number";
      const wasm = await instantiateWasmGc(emitWasmGc(g, { inputs, output }));
      const ref = new Function(`${runnable(emitTypeScript(g))}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      for (const args of tc.args)
        expect(Object.is(wasm(...args), ref(...args)), `${tc.name} ${JSON.stringify(args)}`).toBe(
          true,
        );
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(3);
  });
});

describe("what the WasmGC lowering refuses, with the reason (#1300)", () => {
  const refusal = (source: string, inputs: string[], output: string): string => {
    try {
      emitWasmGc(liftAtom(source), { inputs, output });
    } catch (e) {
      if (e instanceof WasmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("a method not yet an atom, a member of a value of any kind, an element write in a program", () => {
    expect(
      refusal(
        "export function f(s: string): string { return s.toUpperCase(); }",
        ["string"],
        "string",
      ),
    ).toMatch(/toUpperCase is not in the subset yet/);
    expect(
      refusal(
        "export function f(x: unknown): unknown { return x.length; }",
        ["unknown"],
        "unknown",
      ),
    ).toMatch(/member length of a value of any kind/);
    expect(
      refusal(
        "export function f(a: number[]): number[] { a[5] = 1; return a; }",
        ["number[]"],
        "number[]",
      ),
    ).toMatch(/element write is not in the subset of a program yet/);
  });

  it("what was refused before values of any kind is lowered: ==, undefined, null, element reads", () => {
    for (const [source, inputs, output] of [
      [
        "export function f(s: string, n: number): boolean { return s == n; }",
        ["string", "number"],
        "boolean",
      ],
      [
        "export function f(s: string): string | undefined { return s; }",
        ["string"],
        "string | undefined",
      ],
      ["export function f(s: string): string { let t; return t + s; }", ["string"], "string"],
      ["export function f(s: string): boolean { return s === null; }", ["string"], "boolean"],
      ["export function f(a: number[]): number { return a[0]; }", ["number[]"], "number"],
    ] as const)
      expect(refusal(source, [...inputs], output)).toBe("lowered");
  });
});
