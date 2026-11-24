// SPDX-License-Identifier: Apache-2.0
/**
 * The cases every bytecode lowering is checked on (#1300 WasmGC, #1311 JVM): the inputs that
 * exercise the runtime atoms, the builtins they define, and programs with their argument
 * generators. Each lowering runs them against the TypeScript reference, exactly.
 */
import fc from "fast-check";
import { emitTypeScript } from "../emit-ts.js";
import { liftAtom } from "../lift.js";
import { Thrown } from "../lower-stack.js";
import {
  BIGNUM_ATOMS,
  COLLECTION_ATOMS,
  DYNAMIC_ATOMS,
  METHOD_ATOMS,
  RUNTIME_ATOMS,
  RUNTIME_PRIMITIVES_JS,
} from "../wasm-runtime-atoms.js";
import { runnable } from "./runnable.js";

/** Strings with every kind of unit: ASCII, whitespace of every class, lone and paired surrogates. */
export const unit = fc.oneof(
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
export const text = fc
  .array(unit, { maxLength: 8 })
  .map((us) => us.map((u) => (typeof u === "number" ? String.fromCharCode(u) : u)).join(""));
export const position = fc.oneof(
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

export const ALL_ATOMS = {
  ...RUNTIME_ATOMS,
  ...BIGNUM_ATOMS,
  ...DYNAMIC_ATOMS,
  ...COLLECTION_ATOMS,
  ...METHOD_ATOMS,
} as Record<string, { source: string; inputs: readonly string[]; output: string }>;

/**
 * The runtime atoms as JavaScript: each lifted and written back by `emitTypeScript`, run with the
 * primitives as the engine has them and with the other atoms it calls.
 */
export const JS_ATOMS: Record<string, (...a: unknown[]) => unknown> = (() => {
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
export const atomInJs = (key: string): ((...a: unknown[]) => unknown) =>
  JS_ATOMS[key] as (...a: unknown[]) => unknown;

/** Each atom, with the builtin it defines and the arbitrary of its arguments. */
export const DEFINES: [string, (...a: never[]) => unknown, fc.Arbitrary<unknown[]>][] = [
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

/** Doubles of every kind: specials, boundaries of the layout, subnormals, and random bit patterns. */
export const DOUBLES: number[] = (() => {
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

/**
 * Strings as ECMAScript's StringToNumber reads them: edge cases of the grammar, every double
 * written three ways, and decimal digit strings with exponents across the whole range (subnormals,
 * overflow, halfway cases).
 */
export const NUMERIC_STRINGS: string[] = (() => {
  const out = [
    ...["", " ", "  12  ", " 12\n", "\u00a0 7 \ufeff", "0x1F", "0X1f", "0o17", "0b101", "0b2"],
    ...["-0x1", "0x", "0x1fffffffffffff1", "1e3", "-0", "-.0", "Infinity", "-Infinity"],
    ...["+Infinity", "infinity", "12px", ".5", "5.", "+.5e-3", ".", "e5", "1e", "1e+", "1_000"],
    ...["2.4703282292062327e-324", "2.4703282292062328e-324", "4.9406564584124654e-324"],
    ...["1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308"],
    ...["9007199254740993", "9007199254740995", "123456789012345678901234567890", "0.1"],
    ...["1e-400", "1e400", "00012", "1.0000000000000002", "2.2250738585072011e-308"],
    ...["2.2250738585072012e-308", "0.000000000000000000000000000001e30", "1e99999999999"],
  ];
  const dv = new DataView(new ArrayBuffer(8));
  for (const [hi, lo] of fc.sample(fc.tuple(fc.nat(0xffffffff), fc.nat(0xffffffff)), {
    numRuns: 700,
    seed: 1300,
  })) {
    dv.setUint32(0, hi);
    dv.setUint32(4, lo);
    const x = dv.getFloat64(0);
    out.push(String(x), x.toExponential(20), x.toPrecision(19));
  }
  for (const [d, e] of fc.sample(
    fc.tuple(fc.stringMatching(/^[0-9]{1,30}$/), fc.integer({ min: -350, max: 320 })),
    { numRuns: 500, seed: 1301 },
  ))
    out.push(`${d}e${e}`, `0.${d}e${e}`);
  return out;
})();

/** Numbers for the bitwise operators: ToInt32's edges, fractions, and every range. */
export const bitArg = fc.oneof(
  fc.integer(),
  fc.integer({ min: -40, max: 40 }),
  fc.double(),
  fc.constantFrom(2 ** 31, -(2 ** 31), 2 ** 31 - 1, 2 ** 32, 2 ** 32 + 5, -(2 ** 32) - 3, 2 ** 53),
  fc.constantFrom(1e20, -1e20, -1.5, 4294967295.7, -0, Number.NaN, Number.POSITIVE_INFINITY, 0.5),
);

/** Every kind of value the WasmGC lowering represents. */
export const anyValue = fc.oneof(
  fc.double(),
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, 1e21),
  fc.string({ maxLength: 4 }),
  fc.constantFrom("", " 1 ", "0x10", "1e3", "abc", "-0", "Infinity", "1,2", "number"),
  fc.boolean(),
  fc.constantFrom(null, undefined),
  fc.array(fc.oneof(fc.integer({ min: -5, max: 5 }), fc.double()), { maxLength: 3 }),
  // Arrays of any values: mixed, nested, holding undefined and null (which join as empty).
  fc.array(
    fc.oneof(
      fc.integer({ min: -3, max: 3 }),
      fc.constantFrom("", "a", "1", null, undefined, true),
      fc.array(fc.constantFrom(1, "b", null), { maxLength: 2 }),
    ),
    { minLength: 1, maxLength: 3 },
  ),
  // Plain objects (an object's primitive is "[object Object]"); fc.dictionary's have no prototype.
  fc
    .dictionary(
      fc.constantFrom("a", "b", "x"),
      fc.oneof(fc.integer(), fc.string({ maxLength: 2 })),
      {
        maxKeys: 2,
      },
    )
    .map((d) => ({ ...d })),
);

// biome-ignore lint/suspicious/noExplicitAny: the operators are ECMAScript's, over any values.
export type Op = (a: any, b: any) => unknown;
// Each operator: the atom, what its result means, and the engine's operator.
export const DYNAMIC_OPS: [string, string, (r: unknown) => unknown, Op][] = [
  ["+", "__ykAdd", (r) => r, (a, b) => a + b],
  // biome-ignore lint/suspicious/noDoubleEquals: IsLooselyEqual is what is defined.
  ["==", "__ykLooseEquals", (r) => r, (a, b) => a == b],
  ["===", "__ykStrictEquals", (r) => r, (a, b) => a === b],
  ["<", "__ykCompare", (r) => r === 0, (a, b) => a < b],
  [">=", "__ykCompare", (r) => r === 1, (a, b) => a >= b],
  ["typeof", "__ykTypeOf", (r) => r, (a) => typeof a],
  ["truthiness", "__ykTruthy", (r) => r, (a) => !!a],
  ["String", "__ykToString", (r) => r, (a) => String(a)],
  ["Number", "__ykToNumber", (r) => r, (a) => Number(a)],
];
/** A call's outcome: its value, or a Thrown of what it threw. */
export function outcome(f: (...a: unknown[]) => unknown, args: readonly unknown[]): unknown {
  try {
    return f(...args);
  } catch (e) {
    return e instanceof Thrown ? e : new Thrown(e);
  }
}

/**
 * The same value: by Object.is; an array element by element; a plain object key by key, in order
 * (nested ones too).
 */
export const same = (a: unknown, b: unknown): boolean => {
  // What was thrown, uncaught: the same value; two errors: the same class and toString.
  if (a instanceof Thrown || b instanceof Thrown)
    return a instanceof Thrown && b instanceof Thrown && same(a.value, b.value);
  if (a instanceof Error || b instanceof Error)
    return (
      a instanceof Error &&
      b instanceof Error &&
      Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
      String(a) === String(b)
    );
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      !Array.isArray(a) &&
      !Array.isArray(b) &&
      ka.length === kb.length &&
      ka.every(
        (k, i) =>
          k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return Object.is(a, b);
};

export const numericText = fc.oneof(
  text,
  fc.double().map(String),
  fc.integer().map(String),
  fc.constantFrom("", " 1 ", "0x1f", "1e3", "true", "1,2.5", "2.5", "-0", "Infinity"),
);

export const PROGRAMS: [string, string, string[], string, fc.Arbitrary<unknown[]>][] = [
  [
    "sort (by default, as strings, and with a comparator), spread in array literals, calls and object literals, Array.from, Math.max/min of a spread",
    "export function f(xs: number[], ys: unknown[], s: string, o: any): unknown { const a = [...xs.filter((x: number) => x === x)]; a.sort((p: number, q: number) => p - q); const b: any = [...ys, 1, ...s]; b.sort(); const g = (...r: unknown[]) => r.length; const c: any = ys; const cs = c.slice(); cs.sort((p: any, q: any) => (String(p) < String(q) ? 1 : String(p) > String(q) ? -1 : 0)); return [a, b, cs, Math.max(...xs), Math.min(...xs, 3), Array.from(s), Array.from(ys), Array.from(new Set(xs)), { ...o, z: 1 }, { y: 2, ...o }, [...new Map([[1, s]])], c.concat(...[[1], 2])]; }",
    ["number[]", "unknown[]", "string", "unknown"],
    "unknown",
    fc.tuple(
      fc.array(
        fc.oneof(fc.integer({ min: -20, max: 20 }), fc.constantFrom(-0, Number.NaN, 1e21, 0.5)),
        { maxLength: 6 },
      ),
      fc.array(
        fc.oneof(fc.integer({ min: -2, max: 12 }), fc.constantFrom("a", "", "10", null, undefined)),
        { maxLength: 5 },
      ),
      text,
      fc.oneof(
        fc.constantFrom(null, undefined, 3, "ab"),
        fc.dictionary(fc.constantFrom("y", "z", "w"), fc.integer()).map((d) => ({ ...d })),
      ),
    ),
  ],
  [
    "string methods (split, repeat, padStart/End, lastIndexOf, trimStart/End, at, replace/replaceAll with $-patterns and a callback) and array methods (slice, at, lastIndexOf, concat, reverse)",
    "export function f(s: string, t: string, n: number, xs: unknown[]): unknown { let rep = ''; try { rep = s.repeat(n); } catch (e) { rep = (e as Error).name; } const a: any = xs; const r = [1, 2, 3]; r.reverse(); return [s.split(t), s.split(''), s.split(t, 2), s.split(), rep, s.padStart(n, t), s.padEnd(6, t), s.padStart(5), s.lastIndexOf(t), s.lastIndexOf(t, n), s.trimStart(), s.trimEnd(), s.at(n), s.at(-1), s.replace(t, '[$&]'), s.replaceAll(t, '<$$>'), s.replace(t, (m: string, p: number) => m.length + ':' + p), s.replaceAll('', '-'), a.slice(1), a.slice(-2, n), a.at(-1), a.lastIndexOf(t), a.concat([1, 2], s), r]; }",
    ["string", "string", "number", "unknown[]"],
    "unknown",
    fc.tuple(
      text,
      fc.oneof(text, fc.constantFrom("", "a", " ")),
      fc.oneof(fc.integer({ min: -2, max: 6 }), fc.constantFrom(Number.NaN, 1.5)),
      fc.array(fc.oneof(fc.integer({ min: -2, max: 2 }), fc.constantFrom("a", "", null)), {
        maxLength: 4,
      }),
    ),
  ],
  [
    "Map and Set (SameValueZero keys, -0, NaN, iteration, forEach, delete, size), and methods of receivers of any kind (arrays, strings)",
    "export function f(xs: unknown[], k: unknown, s: string): unknown { const m = new Map(); m.set('a', 1); m.set(k, s); m.set(NaN, 'nan'); m.set(-0, 'zero'); const st = new Set([1, 2, 2, s, NaN, NaN]); const out: unknown[] = []; m.forEach((v: unknown, key: unknown) => out.push([key, v])); const entries: unknown[] = []; for (const e of m) entries.push(e); const vals: unknown[] = []; for (const v of st) vals.push(v); const ks: unknown[] = []; for (const q of m.keys()) ks.push(q); const anyArr: any = xs; anyArr.push(s); const popped = anyArr.pop(); const sAny: any = s; return [m.get('a'), m.get(k), m.get(NaN), m.get(0), m.has(k), m.size, m.delete('a'), m.delete('zz'), m.size, st.size, st.has(NaN), st.has('x'), out, entries, vals, ks, String(m), JSON.stringify(m), Object.keys(st), m instanceof Map, st instanceof Set, m instanceof Error, popped, anyArr.length, anyArr.indexOf(s), anyArr.includes(NaN), anyArr.join('-'), anyArr.map((x: unknown) => typeof x), sAny.slice(1), sAny.indexOf('a'), sAny.trim(), sAny.charCodeAt(0)]; }",
    ["unknown[]", "unknown", "string"],
    "unknown",
    fc.tuple(
      fc.array(
        fc.oneof(fc.integer({ min: -2, max: 2 }), fc.constantFrom("a", "", null, Number.NaN)),
        { maxLength: 4 },
      ),
      anyValue,
      text,
    ),
  ],
  [
    "bitwise operators: &, |, ^, <<, >>, >>>, ~ on every kind of number (ToInt32's modulo, a shift's count mod 32)",
    "export function f(a: number, b: number): unknown { return [a & b, a | b, a ^ b, a << b, a >> b, a >>> b, ~a, ~~a, a | 0, a >>> 0, -1 >>> 0, 1 << 31, (a & 0xff) << 8, b >>> 32, a << -1]; }",
    ["number", "number"],
    "unknown",
    fc.tuple(bitArg, bitArg),
  ],
  [
    "builtins as functions: filter(Boolean), map(String), map(Number), Math's one-argument functions, stored and called",
    "export function f(xs: unknown[], n: number): unknown { const nums = [n, -n, 2.5, -0.5]; const fs: unknown[] = [String, Math.abs]; return [xs.filter(Boolean), xs.map(String), xs.map(Number), nums.map(Math.abs), nums.map(Math.floor), nums.map(Math.sqrt), nums.map(Math.round), Boolean(n), Boolean(), (fs[0] as any)(n), (fs[1] as any)(-3), typeof fs[0]]; }",
    ["unknown[]", "number"],
    "unknown",
    fc.tuple(
      fc.array(
        fc.oneof(
          fc.integer({ min: -2, max: 2 }),
          fc.constantFrom("", "a", "1", null, undefined, true, false),
        ),
        {
          maxLength: 5,
        },
      ),
      fc.oneof(fc.integer({ min: -5, max: 5 }), fc.double()),
    ),
  ],
  [
    "instanceof Error and its subclasses, Array, Object and Function; Array.isArray; in a catch",
    "export function f(x: unknown, n: number): unknown { const errs: unknown[] = [new Error('a'), new TypeError('b'), new RangeError('c'), x]; const out: unknown[] = []; for (const e of errs) out.push([e instanceof Error, e instanceof TypeError, e instanceof RangeError, e instanceof Object, e instanceof Array, Array.isArray(e)]); const g = (k: number) => k; let caught = ''; try { if (n > 0) (x as any).boom(); else throw new RangeError('r'); } catch (e) { caught = e instanceof TypeError ? 'type' : e instanceof RangeError ? 'range' : 'other'; } return [out, g instanceof Function, g instanceof Object, [1] instanceof Array, x instanceof Function, Array.isArray(x), caught]; }",
    ["unknown", "number"],
    "unknown",
    fc.tuple(anyValue, fc.integer({ min: -1, max: 1 })),
  ],
  [
    "closures that call each other: const arrows through a cell, read with the comma operator",
    "export function f(n: number): unknown { const isEven = (k: number): boolean => (k === 0 ? true : isOdd(k - 1)); const isOdd = (k: number): boolean => (k === 0 ? false : isEven(k - 1)); const ping = (k: number, acc: string): string => (k <= 0 ? acc : pong(k - 1, acc + 'i')); const pong = (k: number, acc: string): string => (k <= 0 ? acc : ping(k - 1, acc + 'o')); return [isEven(n), isOdd(n), ping(n, '')]; }",
    ["number"],
    "unknown",
    fc.tuple(fc.integer({ min: 0, max: 15 })),
  ],
  [
    "JSON: stringify (key order, undefined and functions, errors, NaN, space, toJSON, a cycle's TypeError), parse (duplicates, escapes, a SyntaxError), and their round trip",
    "export function f(x: unknown, s: string, n: number): unknown { const o: any = { a: [1, 'two', null, undefined, true], b: { c: x, 2: 'i', 1: s }, d: undefined, f: () => 1, e: new Error('m'), n: n }; const cyc: any = { z: 1 }; cyc.self = cyc; let circ = ''; try { JSON.stringify(cyc); } catch (e) { circ = (e as Error).name; } let parsed: unknown = 'none'; try { parsed = JSON.parse(s); } catch (e) { parsed = (e as Error).name; } const withTo = { v: 1, toJSON: () => 'custom' }; return [JSON.stringify(o), JSON.stringify(o, null, 2), JSON.stringify(x), JSON.stringify([x, s]), JSON.stringify(s), JSON.stringify(withTo), JSON.stringify({ k: withTo }), circ, parsed, JSON.parse(JSON.stringify(o)), JSON.parse('[1,\"a\\\\u0041\",{\"x\":-1.5e3,\"x\":2},true,null]'), JSON.stringify(o, undefined, '--')]; }",
    ["unknown", "string", "number"],
    "unknown",
    fc.tuple(
      anyValue,
      fc.oneof(
        text,
        numericText,
        fc.constantFrom('{"a":1}', "[1, 2]", '"x"', "nul", "{", "[1,]", "01", "-0", "1.", " true "),
      ),
      fc.oneof(fc.double(), fc.integer()),
    ),
  ],
  [
    "iteration: for-in keys in ECMAScript's order, for-of over arrays (one growing), strings by code point, mixed arrays, with break; Object.keys, values, entries",
    "export function f(o: any, xs: number[], s: string): unknown { const keys: unknown[] = []; for (const k in o) keys.push(k); let sum = 0; for (const x of xs) sum = sum + x; const cps: unknown[] = []; for (const c of s) cps.push(c); const grow = [1, 2]; let seen = 0; for (const g of grow) { if (grow.length < 5) grow.push(g * 10); seen = seen + 1; } let found = -1; for (const x of xs) { if (x > 2) { found = x; break; } } const mixed: unknown[] = [s, 1, true]; const kinds: unknown[] = []; for (const m of mixed) kinds.push(typeof m); const ordered = { b: 1, 2: 'two', a: 3, 1: 'one' }; return [keys, sum, cps, seen, grow, found, kinds, Object.keys(ordered), Object.values(ordered), Object.keys(xs), Object.keys(s), Object.entries(o)]; }",
    ["unknown", "number[]", "string"],
    "unknown",
    fc.tuple(
      fc.oneof(
        fc
          .dictionary(
            fc.constantFrom("a", "b", "1", "10", "02", "x"),
            fc.integer({ min: 0, max: 9 }),
            {
              maxKeys: 4,
            },
          )
          .map((d) => ({ ...d })),
        fc.constantFrom(null, undefined),
      ),
      fc.array(fc.integer({ min: -3, max: 5 }), { maxLength: 5 }),
      text,
    ),
  ],
  [
    "recursive closures: a const arrow, a function declaration, recursion over an array and with an accumulator, aliased and passed to map",
    "export function f(n: number, xs: number[]): unknown { const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1)); function fib(k: number): number { return k < 2 ? k : fib(k - 1) + fib(k - 2); } const sum = (a: number[], i: number): number => (i >= a.length ? 0 : a[i] + sum(a, i + 1)); const countdown = (k: number, acc: string): string => (k <= 0 ? acc : countdown(k - 1, acc + k)); const powk = (e: number): number => (e <= 0 ? 1 : n * powk(e - 1)); const self = fact; return [powk(3), powk(n), fact(n), fib(n), sum(xs, 0), countdown(n, ''), self(3), [1, 2, 3].map(fact)]; }",
    ["number", "number[]"],
    "unknown",
    fc.tuple(
      fc.integer({ min: -1, max: 12 }),
      fc.array(fc.integer({ min: -9, max: 9 }), { maxLength: 6 }),
    ),
  ],
  [
    "function values: closures stored in an array and an object, chosen, returned, composed, called; typeof and ===; calling a non-function",
    "export function f(k: number, s: string): unknown { const fs: unknown[] = []; fs.push((x: number) => x + k); fs.push((x: number) => s + x); const o: any = { inc: (x: number) => x + 1, name: s }; const pick = (b: boolean) => (b ? (x: number) => x * 2 : (x: number) => x - k); const compose = (f: any, g: any) => (x: unknown) => f(g(x)); const h = compose(o.inc, pick(k > 0)); const out = fs.map((g: any) => g(3)); let thrown = ''; try { (o.name as any)(1); } catch (e) { thrown = (e as Error).name; } return [out, o.inc(k), pick(true)(k), pick(false)(k), h(5), typeof fs[0], fs[0] === fs[0], fs[0] === fs[1], thrown]; }",
    ["number", "string"],
    "unknown",
    fc.tuple(fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), text),
  ],
  [
    "functions passed as they are: map, filter, forEach, reduce, some, every, find, findIndex, and a closure argument",
    "export function f(xs: number[], k: number, s: string): unknown { const out: unknown[] = []; const twice = (x: number) => x * 2; const apply = (g: (n: number) => number, v: number) => g(g(v)); const ys = xs.map((x) => x * k).filter((y) => y > 1); xs.forEach((x, i) => out.push(s + i + ':' + x)); const mixed: unknown[] = [s, k, xs.length > 2]; return [ys, ys.reduce((a, b) => a + b, 0), xs.reduce((a, b) => a * 10 + b), xs.some((x) => x > k), xs.every((x) => x >= 0), xs.find((x) => x > k), xs.findIndex((x) => x === k), mixed.map((m) => typeof m), mixed.filter((m) => m), apply(twice, k), apply((n) => n + k, 1), out]; }",
    ["number[]", "number", "string"],
    "unknown",
    fc.tuple(
      fc.array(fc.integer({ min: -2, max: 5 }), { maxLength: 5 }),
      fc.integer({ min: -2, max: 4 }),
      text,
    ),
  ],
  [
    "exceptions: throw and catch, a TypeError from undefined, a thrown number, finally and rethrow, return through finally, uncaught",
    "export function f(n: number, s: string, x: unknown): unknown { const out: unknown[] = []; let a = 0; try { a = n * 2; if (n > 1) throw new Error(s); out.push('no'); } catch (e) { out.push('caught ' + (e as Error).message); a = -1; } try { out.push((x as any).length); } catch (e) { out.push((e as Error).name); } let t = ''; try { try { if (n < 0) throw n; t = t + 'b'; } finally { t = t + 'f'; } } catch (e) { t = t + 'c' + e; } const g = (): number => { try { return n + 1; } finally { out.push('g'); } }; out.push(g()); if (s === 'boom') throw new RangeError('boom!'); return [a, t, out]; }",
    ["number", "string", "unknown"],
    "unknown",
    fc.tuple(
      fc.oneof(fc.integer({ min: -2, max: 3 }), fc.double()),
      fc.oneof(text, fc.constant("boom")),
      fc.oneof(anyValue, fc.constantFrom(null, undefined)),
    ),
  ],
  [
    "objects: literals, property reads and writes, computed keys, missing properties, toString, +, ==, typeof",
    "export function f(a: number, s: string, x: unknown): unknown { const o: any = { n: a, s: s, x: x }; o.n = o.n + 1; o.extra = s; const k = s.length > 1 ? 'n' : 's'; const p: any = { n: 1, n2: 2 }; p[k] = x; return [o.n, o.s, o.missing, o[k], o.x, String(o), o + '!', o == '[object Object]', typeof o, o === o, o === p, p, { a: o.x, b: [a], c: { d: s } }]; }",
    ["number", "string", "unknown"],
    "unknown",
    fc.tuple(fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), text, anyValue),
  ],
  [
    "errors: new Error and its message, name and toString; a subclass; Error called without new",
    "export function f(m: string, b: boolean): unknown { const e = b ? new Error(m) : new TypeError(); const g = Error(m + '!'); return [e.message, e.name, String(e), g.message, e + '', typeof e, (e as any).missing, String(new RangeError(m))]; }",
    ["string", "boolean"],
    "unknown",
    fc.tuple(text, fc.boolean()),
  ],
  [
    "arrays of any values: mixed literals, push and pop, reads in and out of range, join, ==, +, typeof",
    "export function f(x: unknown, n: number, s: string): unknown { const a = [x, n, s]; const b = []; b.push(s); b.push(n); b.push(x); const p = b.pop(); const e = []; return [a.length, a[1], a[5], a[-0], a[1.5], b.length, p, e.pop(), String(a), a + '|' + b, a == s, a[0] === x, typeof a, b, [a, [n]], e]; }",
    ["unknown", "number", "string"],
    "unknown",
    fc.tuple(anyValue, fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), text),
  ],
  [
    "a completion record, as a try lifts to: a choice of two arrays, read by element",
    "export function f(n: number, s: string): unknown { const r = n > 0 ? [1, s] : [0, n]; return r[0] === 1 ? r[1] : r; }",
    ["number", "string"],
    "unknown",
    fc.tuple(fc.oneof(fc.integer({ min: -2, max: 2 }), fc.double()), text),
  ],
  [
    "a string's units by index, in and out of range",
    "export function f(s: string, i: number): unknown { return [s[i], s[0], s[s.length], s[i + 0.5]]; }",
    ["string", "number"],
    "unknown",
    fc.tuple(text, fc.oneof(fc.integer({ min: -2, max: 9 }), fc.constantFrom(Number.NaN, -0))),
  ],
  [
    "closures called where they are made: captures, one closure at several argument types, a missing argument",
    "export function f(k: number, s: string, b: boolean): string { const add = (v: number) => v + k; const tag = (x: unknown) => s + ':' + x; let acc = 0; let i = 0; while (i < 3) { acc = add(acc) * 2; i = i + 1; } return tag(acc) + tag(add(0.5)) + tag(undefined) + tag(b) + tag(s) + tag(); }",
    ["number", "string", "boolean"],
    "string",
    fc.tuple(fc.oneof(fc.integer({ min: -5, max: 5 }), fc.double()), text, fc.boolean()),
  ],
  [
    "a closure with a loop that returns early, and its result used",
    "export function f(xs: number[], t: number): number { const find = (ys: number[], u: number) => { let i = 0; while (i < ys.length) { if (ys[i] === u) return i; i = i + 1; } return -1; }; return find(xs, t) * 10 + find(xs, t + 1); }",
    ["number[]", "number"],
    "number",
    fc.tuple(
      fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 6 }),
      fc.integer({ min: 0, max: 4 }),
    ),
  ],
  [
    "values of any kind: +, ==, ===, relational, typeof, truthiness, arithmetic, templates, ??, ||, &&",
    "export function f(a: any, b: any): string { return String(a + b) + '|' + (a == b) + (a === b) + (a < b) + (a >= b) + (a > b) + (a <= b) + (a != b) + (a !== b) + typeof a + typeof b + (!a) + (a ? 1 : 2) + (a - b) + a * 2 + -b + `<${a}>` + (a ?? 'n') + (a || b) + (b && a) + (a == null) + (b === undefined); }",
    ["unknown", "unknown"],
    "string",
    fc.tuple(anyValue, anyValue),
  ],
  [
    "undefined and null as values: an optional result, element reads in and out of range, ??",
    "export function f(xs: number[], i: number, k: boolean): number | null | undefined { let r; if (k) r = xs[i]; const y = xs[i + 1] ?? -1; if (r === undefined) return y > 0 ? undefined : y < -1 ? null : y; return r * 2 + y; }",
    ["number[]", "number", "boolean"],
    "number | null | undefined",
    fc.tuple(
      fc.array(fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), { maxLength: 4 }),
      fc.oneof(fc.integer({ min: -1, max: 5 }), fc.constantFrom(0.5, -0, Number.NaN)),
      fc.boolean(),
    ),
  ],
  [
    "a loop whose carried value changes kind, and a result of any kind",
    "export function f(n: number, s: string, x: unknown): unknown { let v: any = n; let i = 0; while (i < 4) { v = i % 2 === 0 ? v + s : v * 1; if (v === x) return i; i = i + 1; } return v; }",
    ["number", "string", "unknown"],
    "unknown",
    fc.tuple(fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), numericText, anyValue),
  ],
  [
    "arrays across the boundary, as values of any kind",
    "export function f(a: number[], x: unknown): unknown { if (x === null) return a; if (typeof x === 'object') return x; return a[0] === x ? a : x; }",
    ["number[]", "unknown"],
    "unknown",
    fc.tuple(fc.array(fc.integer({ min: -2, max: 2 }), { maxLength: 3 }), anyValue),
  ],
  [
    "values made numbers and compared across types: Number, unary +, ==, <, + of an array",
    'export function f(s: string, n: number, b: boolean): string { const a = [n, 2.5]; const t = Number(s) + +s * 2 - Number(b); return t + "|" + (s == n) + (s != b) + (s < n) + (n >= s) + (a == s) + (a < s) + (a + s) + Number(a) + Number([n]) + (b == n) + (a == a) + (s + a > s) + `${a}` + String([n]) + ([n] == n) + Number(); }',
    ["string", "number", "boolean"],
    "string",
    fc.tuple(
      numericText,
      fc.oneof(fc.double(), fc.integer(), fc.constantFrom(0, 1, 2.5)),
      fc.boolean(),
    ),
  ],
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
