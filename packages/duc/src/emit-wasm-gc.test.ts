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
import { EMIT_CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { emitTypeScript } from "./emit-ts.js";
import { emitWasmGc, instantiateWasmGc } from "./emit-wasm-gc.js";
import { WasmEmitError, emitWasm } from "./emit-wasm.js";
import { liftAtom } from "./lift.js";
import { BIGNUM_ATOMS, RUNTIME_ATOMS, RUNTIME_PRIMITIVES_JS } from "./wasm-runtime-atoms.js";

/** Strings with every kind of unit: ASCII, whitespace of every class, lone and paired surrogates. */
const unit = fc.oneof(
  fc.constantFrom(..."abcAB a"),
  fc.constantFrom(
    9,
    10,
    11,
    12,
    13,
    32,
    160,
    5760,
    8192,
    8202,
    8232,
    8233,
    8239,
    8287,
    12288,
    65279,
    0x85,
    0x200b,
  ),
  fc.integer({ min: 0xd800, max: 0xdfff }),
  fc.integer({ min: 0, max: 0xffff }),
);
const text = fc
  .array(unit, { maxLength: 8 })
  .map((us) => us.map((u) => (typeof u === "number" ? String.fromCharCode(u) : u)).join(""));
const position = fc.oneof(
  fc.integer({ min: -10, max: 12 }),
  fc.constantFrom(
    Number.NaN,
    0,
    -0,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    -1.5,
    2 ** 40,
  ),
  fc.double(),
);

const ALL_ATOMS = { ...RUNTIME_ATOMS, ...BIGNUM_ATOMS } as Record<
  string,
  { source: string; inputs: readonly string[]; output: string }
>;

/**
 * The runtime atoms as JavaScript: each lifted and written back by `emitTypeScript`, run with the
 * primitives as the engine has them and with the other atoms it calls.
 */
const JS_ATOMS: Record<string, (...a: unknown[]) => unknown> = (() => {
  const env: Record<string, (...a: unknown[]) => unknown> = {
    ...(RUNTIME_PRIMITIVES_JS as unknown as Record<string, (...a: unknown[]) => unknown>),
  };
  const names = [...Object.keys(ALL_ATOMS), ...Object.keys(RUNTIME_PRIMITIVES_JS)];
  for (const [k, a] of Object.entries(ALL_ATOMS)) {
    const src = runnable(emitTypeScript(liftAtom(a.source)));
    env[k] = new Function(...names, `${src}; return f;`)(
      ...names.map(
        (n) =>
          (...x: unknown[]) =>
            env[n]?.(...x),
      ),
    ) as (...a: unknown[]) => unknown;
  }
  return env;
})();
const atomInJs = (key: string): ((...a: unknown[]) => unknown) =>
  JS_ATOMS[key] as (...a: unknown[]) => unknown;

/** A runtime atom lowered alone: a module whose `f` is the atom. */
async function atomInWasm(key: string): Promise<(...a: unknown[]) => unknown> {
  const a = ALL_ATOMS[key] as { source: string; inputs: readonly string[]; output: string };
  return instantiateWasmGc(emitWasmGc(liftAtom(a.source), { inputs: a.inputs, output: a.output }));
}

/** Each atom, with the builtin it defines and the arbitrary of its arguments. */
const DEFINES: [string, (...a: never[]) => unknown, fc.Arbitrary<unknown[]>][] = [
  ["__ykCharCodeAt", (s: string, p: number) => s.charCodeAt(p), fc.tuple(text, position)],
  ["__ykCharAt", (s: string, p: number) => s.charAt(p), fc.tuple(text, position)],
  [
    "__ykSlice",
    (s: string, a: number, b: number) => s.slice(a, b),
    fc.tuple(text, position, position),
  ],
  [
    "__ykSubstring",
    (s: string, a: number, b: number) => s.substring(a, b),
    fc.tuple(text, position, position),
  ],
  [
    "__ykIndexOf",
    (s: string, t: string, p: number) => s.indexOf(t, p),
    fc.tuple(text, fc.oneof(text, fc.constantFrom("", "a", "ab")), position),
  ],
  [
    "__ykStartsWith",
    (s: string, t: string, p: number) => s.startsWith(t, p),
    fc.tuple(text, fc.oneof(text, fc.constantFrom("", "a")), position),
  ],
  [
    "__ykEndsWith",
    (s: string, t: string, p: number) => s.endsWith(t, p),
    fc.tuple(text, fc.oneof(text, fc.constantFrom("", "a")), position),
  ],
  ["__ykTrim", (s: string) => s.trim(), fc.tuple(text)],
  [
    "__ykStrEquals",
    (a: string, b: string) => a === b,
    fc.oneof(
      fc.tuple(text, text),
      text.map((s) => [s, s]),
    ),
  ],
  [
    "__ykStrLess",
    (a: string, b: string) => a < b,
    fc.oneof(
      fc.tuple(text, text),
      text.map((s) => [s, `${s}a`]),
    ),
  ],
];

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

/** Doubles of every kind: specials, boundaries of the layout, subnormals, and random bit patterns. */
const DOUBLES: number[] = (() => {
  const xs = [
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1,
    -1,
    0.1,
    0.2,
    0.30000000000000004,
    1 / 3,
    123.456,
    1e21,
    1e-7,
    1e-6,
    1.5e-7,
    123e-20,
    1e20,
    9.999999999999999e20,
    2 ** 53,
    2 ** 53 + 2,
    2 ** 63,
    5e-324,
    2.2250738585072014e-308,
    2.225073858507201e-308,
    Number.MAX_VALUE,
    4.35,
    9007199254740994,
    123456789012345680000,
    -2.5e-7,
    1e-323,
  ];
  for (let i = -1080; i <= 1030; i += 7) xs.push(2 ** i);
  for (let i = -330; i <= 310; i += 3) xs.push(10 ** i, 3 * 10 ** i);
  const dv = new DataView(new ArrayBuffer(8));
  let seed = 1300;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let i = 0; i < 1500; i++) {
    dv.setUint32(0, next() * 2 + (next() % 2));
    dv.setUint32(4, next() * 2 + (next() % 2));
    xs.push(dv.getFloat64(0));
  }
  return xs;
})();

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

const PROGRAMS: [string, string, string[], string, fc.Arbitrary<unknown[]>][] = [
  [
    "numbers and booleans made strings: +, String, toString, templates",
    'export function f(n: number, m: number, b: boolean): string { const s = "n=" + n; return s + "|" + String(m / 3) + "|" + (n * m).toString() + `<${n - m}:${b}>` + b + String(b) + (1 + n) + ""; }',
    ["number", "number", "boolean"],
    "string",
    fc.tuple(
      fc.oneof(fc.double(), fc.integer()),
      fc.oneof(fc.double(), fc.constantFrom(0, -0, 1e21, 1e-7, 3)),
      fc.boolean(),
    ),
  ],
  [
    "concatenation, length, literals, equality",
    'export function f(a: string, b: string): number { const c = a + "|" + b; return c === b + a ? -1 : c.length * 10 + (a < b ? 1 : 0) + (a >= b ? 2 : 0); }',
    ["string", "string"],
    "number",
    fc.tuple(text, text),
  ],
  [
    "string methods: slice, indexOf, includes, charCodeAt, trim",
    'export function f(s: string, i: number): string { const t = s.trim(); const k = t.indexOf("a", i); if (k < 0) return t.slice(i) + (t.includes(" ") ? "!" : "?"); return t.slice(0, k) + t.charAt(k + 1) + t.substring(i, k); }',
    ["string", "number"],
    "string",
    fc.tuple(text, position),
  ],
  [
    "a loop that builds a string and returns from inside",
    'export function f(s: string, n: number): string { let out = ""; let i = 0; while (i < s.length) { if (s.charCodeAt(i) > 0xd7ff && n > 2) return out + "#"; out = out + s.charAt(s.length - 1 - i); i = i + 1; } return out; }',
    ["string", "number"],
    "string",
    fc.tuple(text, fc.integer({ min: 0, max: 5 })),
  ],
  [
    "carries that depend on each other: a string and a number built together",
    'export function f(n: number, s: string): string { let a = ""; let b = s; let k = 0; while (k < n) { const c = a + b; a = b; b = c; k = k + 1; } return b + a.slice(0, 3); }',
    ["number", "string"],
    "string",
    fc.tuple(fc.integer({ min: 0, max: 6 }), text),
  ],
  [
    "strings in selections and truthiness",
    'export function f(a: string, b: string, k: boolean): string { const x = k ? a : b; return (x || "empty") + (a && "+") + (!b ? "-" : "") + (x.startsWith(b) ? "s" : "") + (a.endsWith(b, 3) ? "e" : ""); }',
    ["string", "string", "boolean"],
    "string",
    fc.tuple(text, text, fc.boolean()),
  ],
];

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
        if (!Object.is(got, want))
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
  it("== across types, a method not yet an atom, an undefined result, element access in a program", () => {
    expect(
      refusal("export function f(a: number[]): number { return a[0]; }", ["number[]"], "number"),
    ).toMatch(/element read .* not in the subset of a program yet/);
    expect(
      refusal(
        "export function f(s: string, n: number): boolean { return s == n; }",
        ["string", "number"],
        "boolean",
      ),
    ).toMatch(/converts the string/);
    expect(
      refusal(
        "export function f(s: string): string { return s.toUpperCase(); }",
        ["string"],
        "string",
      ),
    ).toMatch(/toUpperCase is not in the subset yet/);
    expect(
      refusal(
        "export function f(s: string): string { return s; }",
        ["string"],
        "string | undefined",
      ),
    ).toMatch(/may be undefined/);
    // undefined may stand for a default only where a value is chosen, never as an operand.
    expect(
      refusal(
        "export function f(s: string): string { let t; return t + s; }",
        ["string"],
        "string",
      ),
    ).toMatch(/undefined is an operand/);
    expect(
      refusal(
        "export function f(s: string): boolean { return s === null; }",
        ["string"],
        "boolean",
      ),
    ).toMatch(/literal null is not in the subset/);
  });
});
