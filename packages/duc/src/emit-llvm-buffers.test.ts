// SPDX-License-Identifier: Apache-2.0
/**
 * ArrayBuffer, the typed arrays, DataView, TextEncoder and the builtins @noble/hashes and
 * @yakcc/contracts use, in the native runtime (#1333): each program lowered with boxed values,
 * linked with the runtime, and run on generated inputs; its results must be Node's exactly, the
 * RangeError and TypeError they throw included.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-buffers-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function disagreements(source: string, inputs: readonly unknown[][]): string[] {
  const run = harness(emitLlvmBoxed(liftAtom(source)), work);
  const ref = new Function(`${source.replace(/^export /, "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
  const want = inputs.map((args) => {
    try {
      return ref(...args);
    } catch (e) {
      return `threw ${(e as Error).name}`;
    }
  });
  const { results, stderr } = run(inputs);
  if (results.length !== inputs.length)
    return [`ran ${results.length} of ${inputs.length}: ${stderr}`];
  const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
  return inputs.flatMap((args, i) =>
    same(results[i], want[i])
      ? []
      : [`${show(args)} → native ${show(results[i])}, node ${show(want[i])}`],
  );
}

/** Each expression in a try, so that one throwing does not hide the others. */
const each = (exprs: string[]): string =>
  `[${exprs.map((e) => `(() => { try { return ${e}; } catch (e) { return 'threw ' + e.name; } })()`).join(", ")}]`;

const num = fc.oneof(
  fc.integer({ min: -300, max: 300 }),
  fc.double(),
  fc.constantFrom(
    0,
    -0,
    0.5,
    1.5,
    2.5,
    255.5,
    -1,
    256,
    2 ** 32 + 5,
    -(2 ** 31) - 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e300,
  ),
);
const text = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.string({ unit: "binary", maxLength: 5 }),
  fc.constantFrom("", "é", "\ud800", "\udc00x", "😀", "a\u0000b"),
);

const PROGRAMS: [string, string, fc.Arbitrary<unknown[]>][] = [
  [
    "element conversions of every typed array (ToInt8 … ToUint8Clamp, Float32 rounding), and out-of-range indices",
    `export function f(x, i) { const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]; return kinds.map((K) => { const a = new K(3); a[1] = x; a[i] = x; return [Array.from(a), a[i], a[-1], a['1'], a.length, a.byteLength, K.BYTES_PER_ELEMENT]; }); }`,
    fc.tuple(num, fc.oneof(fc.integer({ min: -2, max: 4 }), fc.constantFrom(1.5, "2", "x"))),
  ],
  [
    "views of one buffer see each other's writes; subarray shares, slice copies; set and fill",
    `export function f(x, k) { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = i * 17 + x; const w = new Uint32Array(b.buffer, 4, 2); w[0] = x * 1000003; const s = b.subarray(2, 10); s[0] = 99; const c = b.slice(k); c[0] = 7; const d = new Uint16Array(4); ${"d.set([x, k, 3], 1)"}; const e = new Int32Array(5).fill(x, 1, k); return ${each(["Array.from(b)", "Array.from(w)", "Array.from(s)", "Array.from(c)", "Array.from(d)", "Array.from(e)", "s.byteOffset", "w.byteOffset", "s.buffer === b.buffer", "c.buffer === b.buffer", "new Uint32Array(b.buffer, 3, 1)", "new Uint32Array(b.buffer, 4, 9)", "d.set([1, 2, 3, 4], 2)", "Array.from(new Uint8Array([300, -1, 2.7]))", "Array.from(Uint8Array.from([1, 2, 3], (v) => v * x))", "Array.from(Uint32Array.of(x, k))"])}; }`,
    fc.tuple(fc.integer({ min: -5, max: 300 }), fc.integer({ min: -3, max: 6 })),
  ],
  [
    "DataView reads and writes in both byte orders, BigInt64 included, with its RangeError",
    `export function f(x, at) { const v = new DataView(new ArrayBuffer(16), 2); return ${each(["(v.setUint32(at, x), [v.getUint32(at), v.getUint32(at, true), v.getInt16(at), v.getUint8(at + 1)])", "(v.setFloat64(0, x, true), [v.getFloat64(0, true), v.getFloat64(0), v.getUint32(4, true)])", "(v.setFloat32(at, x), v.getFloat32(at))", "(v.setBigUint64(0, BigInt(at) * 1234567891011n, true), [v.getBigUint64(0, true), v.getBigInt64(0)])", "v.getUint32(13)", "v.byteLength", "v.byteOffset"])}; }`,
    fc.tuple(num, fc.integer({ min: -1, max: 14 })),
  ],
  [
    "TextEncoder: UTF-8 with lone surrogates as U+FFFD",
    "export function f(s) { const e = new TextEncoder(); return [Array.from(e.encode(s)), e.encoding, e.encode().length]; }",
    fc.tuple(text),
  ],
  [
    "BigInt(x), BigInt.asUintN and asIntN, Number's statics, Object.is",
    `export function f(x, n) { return ${each(["BigInt(x)", "BigInt.asUintN(n, BigInt(Math.trunc(x) || 0) * 3n)", "BigInt.asIntN(n, -(BigInt(Math.trunc(x) || 0)) * 5n)", "Number.isFinite(x)", "Number.isInteger(x)", "Number.isSafeInteger(x)", "Number.isNaN(x)", "Number.MAX_SAFE_INTEGER", "Number.EPSILON", "Object.is(x, -0)", "Object.is(x, x)", "BigInt('0x1f')", "BigInt(' 12 ')", "BigInt('1.5')"])}; }`,
    fc.tuple(num, fc.integer({ min: 0, max: 80 })),
  ],
  [
    "Number::toString(radix) as V8 writes it, string padding, repeat, lastIndexOf, trimStart/End, concat",
    `export function f(x, r, s) { return ${each(["x.toString(r)", "x.toString(2)", "x.toString(16)", "x.toString(36)", "s.padStart(r, 'ab')", "s.padEnd(6)", "s.repeat(r % 4)", "s.lastIndexOf('a', r)", "s.trimStart() + '|' + s.trimEnd()", "s.concat(x, r)"])}; }`,
    fc.tuple(
      fc.oneof(num, fc.double({ min: -1000, max: 1000 })),
      fc.oneof(fc.integer({ min: 2, max: 36 }), fc.constantFrom(1, 37, 10)),
      text,
    ),
  ],
  [
    "instanceof, ArrayBuffer.isView, iteration and join of typed arrays",
    "export function f(x) { const a = new Uint8Array([x, 2, 3]); const out = []; for (const v of a) out.push(v); return [a instanceof Uint8Array, a instanceof Uint32Array, ArrayBuffer.isView(a), ArrayBuffer.isView([1]), out, [...a], a.join('-'), String(a), a.indexOf(2), a.includes(x), a.at(-1), Array.from(a.map((v) => v * 2)), a.reduce((s, v) => s + v, 0)]; }",
    fc.tuple(fc.integer({ min: -10, max: 300 })),
  ],
];

describe.skipIf(!canRun("x86_64-linux"))(
  "buffers, views and their builtins, natively (#1333)",
  () => {
    for (const [name, source, args] of PROGRAMS)
      it(name, () => {
        const inputs = fc.sample(args, { numRuns: 200, seed: 1333 }) as unknown[][];
        expect(disagreements(source, inputs).slice(0, 5)).toEqual([]);
      }, 300_000);
  },
);
