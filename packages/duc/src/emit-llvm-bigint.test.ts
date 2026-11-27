// SPDX-License-Identifier: Apache-2.0
/**
 * BigInt and the fixed-width and float64-bits leaves in the native lowering (#1361 P0, #1369,
 * DEC-DUC-OPERATIONS-AS-ATOMS-001): what raised C's 64-bit integers and a double's bits lower to.
 * Each program is lowered with NaN-boxed values, linked with the runtime, and run on generated
 * inputs; its results must be Node's exactly (a BigInt by value, a number by Object.is), the
 * TypeError and RangeError a BigInt operation throws included.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-bigint-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The leaves as their JavaScript definitions (raise-c's C_LEAVES_JS, and the float64 words). */
const LEAVES_JS = `
const __ykI32Mul = (a, b) => Math.imul(a, b);
const __ykU64 = (x) => BigInt.asUintN(64, x);
const __ykI64 = (x) => BigInt.asIntN(64, x);
const __ykNumToBig = (x) => BigInt(x);
const __ykBigToI32 = (x) => Number(BigInt.asIntN(32, x));
const __ykBigToU32 = (x) => Number(BigInt.asUintN(32, x));
const __ykBigToF64 = (x) => Number(x);
const __ykF64ToI64 = (x) => BigInt.asIntN(64, BigInt(Math.trunc(x)));
const __ykF64Bits = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getBigUint64(0); };
const __ykF64FromBits = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setBigUint64(0, BigInt.asUintN(64, x)); return v.getFloat64(0); };
const __ykF64Hi = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getUint32(0); };
const __ykF64Lo = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getUint32(4); };
const __ykF64Make = (hi, lo) => { const v = new DataView(new ArrayBuffer(8)); v.setUint32(0, hi >>> 0); v.setUint32(4, lo >>> 0); return v.getFloat64(0); };
`;

function reference(source: string): (...a: unknown[]) => unknown {
  return new Function(`${LEAVES_JS}${source.replace(/^export /, "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
}

/** The program natively and in Node; the inputs they disagree on. */
function disagreements(source: string, inputs: readonly unknown[][]): string[] {
  const run = harness(emitLlvmBoxed(liftAtom(source)), work);
  const ref = reference(source);
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

/** BigInts of every size: small, near the 32- and 64-bit edges, and wide. */
const big = fc.oneof(
  fc.bigInt({ min: -1000n, max: 1000n }),
  fc.constantFrom(
    0n,
    1n,
    -1n,
    2n ** 31n,
    -(2n ** 31n),
    2n ** 32n - 1n,
    2n ** 63n,
    -(2n ** 63n),
    2n ** 64n - 1n,
    2n ** 64n,
    2n ** 70n + 2n ** 17n + 1n,
    -(2n ** 70n + 2n ** 17n + 1n),
    2n ** 70n + 2n ** 17n,
    2n ** 1100n,
  ),
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }),
  fc.bigInt({ min: -(2n ** 200n), max: 2n ** 200n }),
);
const double = fc.oneof(
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(
    0,
    -0,
    0.5,
    -1.5,
    2 ** 53,
    2 ** 63,
    -(2 ** 63),
    2 ** 64,
    1e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MIN_VALUE,
  ),
);

/** Each operation in a try, so that one throwing does not hide the others. */
const each = (exprs: string[]): string =>
  `[${exprs.map((e) => `(() => { try { return ${e}; } catch (e) { return 'threw ' + e.name; } })()`).join(", ")}]`;

const PROGRAMS: [string, string, fc.Arbitrary<unknown[]>][] = [
  [
    "BigInt arithmetic, bitwise operators and shifts, exactly, with division's RangeError",
    `export function f(a, b) { const k = b % 80n; return ${each(["a + b", "a - b", "a * b", "a / b", "a % b", "-a", "a & b", "a | b", "a ^ b", "~a", "a << k", "a >> k", "a << -k", "a * a * b"])}; }`,
    fc.tuple(big, big),
  ],
  [
    "BigInt comparisons and equality, with numbers and strings too; typeof, truthiness, String and Number",
    `export function f(a, b, x, s) { return ${each(["a === b", "a !== b", "a == b", "a < b", "a <= b", "a > b", "a == x", "a < x", "x < a", "a >= x", "a == s", "a < s", "s < a", "typeof a", "a ? 1 : 0", "!a", "String(a)", "`<${a}>`", "a + s", "Number(a)", "[a, b].includes(a)"])}; }`,
    fc.tuple(
      big,
      big,
      double,
      fc.oneof(
        fc.constantFrom("", " 12 ", "0x1f", "-5", "1e3", "abc", "18446744073709551616"),
        fc.bigInt().map(String),
      ),
    ),
  ],
  [
    "mixing a BigInt with a number is a TypeError; unary plus and >>> too",
    `export function f(a, x) { return ${each(["a + x", "x * a", "a - x", "a | x", "+a", "a >>> 1n", "Math.floor(a)", "a ** 2n"].filter((e) => !e.includes("**")))}; }`,
    fc.tuple(big, double),
  ],
  [
    "the fixed-width leaves: 64-bit wraps, conversions between widths, a 32-bit multiply",
    `export function f(a, b, x, y) { return ${each(["__ykU64(a * b)", "__ykI64(a * b)", "__ykU64(a << 3n)", "__ykI64(-a)", "__ykBigToI32(a)", "__ykBigToU32(a)", "__ykBigToF64(a)", "__ykBigToF64(a * a * a)", "__ykNumToBig(x)", "__ykF64ToI64(x)", "__ykI32Mul(x, y)", "__ykI32Mul(x | 0, 2654435761)"])}; }`,
    fc.tuple(big, big, double, double),
  ],
  [
    "the float64-bits leaves: a double's 64 bits and its two words, and back",
    `export function f(x, a, h, l) { return ${each(["__ykF64Bits(x)", "__ykF64FromBits(a)", "__ykF64FromBits(__ykF64Bits(x))", "__ykF64Hi(x)", "__ykF64Lo(x)", "__ykF64Make(h, l)", "__ykF64Make(__ykF64Hi(x), __ykF64Lo(x))", "__ykBigToU32(__ykF64Bits(x) >> 32n)"])}; }`,
    fc.tuple(
      double,
      big,
      fc.oneof(fc.integer({ min: 0, max: 2 ** 32 - 1 }), double),
      fc.oneof(fc.integer({ min: 0, max: 2 ** 32 - 1 }), double),
    ),
  ],
  [
    "BigInt literals in every radix, ++ and -- on a BigInt",
    "export function f(a) { let c = a; c++; let d = a; d--; return [0x1fn, 0o17n, 0b101n, 1_000_000n, 18446744073709551615n, c, d, ++c, a + 0xffffffffffffffffn]; }",
    fc.tuple(big),
  ],
  [
    "typed BigInts (#1369): proved narrower than 128 bits, computed as i128, exactly as the BigInt",
    `export function f(x, y, i, j) { const b = __ykF64Bits(x); const c = __ykF64Bits(y); const k = __ykNumToBig(i | 0); const u = __ykNumToBig(j >>> 0); return [${[
      "__ykBigToU32(b >> 32n)",
      "__ykBigToI32(b & 0xffffffffn)",
      "__ykBigToU32((b >> 52n) & 0x7ffn)",
      "__ykU64(b * c)",
      "__ykI64(b + c)",
      "__ykU64(b - c)",
      "__ykI64(-b)",
      "__ykU64(~b)",
      "b << 40n",
      "b >> 200n",
      "-(b >> 200n)",
      "__ykF64FromBits(b | 1n)",
      "__ykF64FromBits((b & 0xfffffffffffffn) | (c & 0xfff0000000000000n))",
      "b === c",
      "b < c",
      "b >= c",
      "k * u",
      "__ykBigToF64(k * u * 3n)",
      "__ykBigToF64(b * c)",
      "(k ^ u) | (k & 5n)",
      "k < u",
      "__ykU64(k)",
      "__ykI64(u << 33n)",
      "String(b ^ c)",
      "b ? 1 : 0",
      "__ykBigToU32(b >> __ykNumToBig(32))",
      "__ykU64(b << __ykNumToBig(3))",
      "b >> __ykNumToBig(300)",
    ].join(", ")}]; }`,
    fc.tuple(double, double, fc.oneof(fc.integer(), double), fc.oneof(fc.integer(), double)),
  ],
  [
    // A function of BigInt parameters (raised C's 64-bit integers): its clone taking them as i128s
    // when each is below 2^64 in magnitude, else its general lowering. A carry that reads itself
    // (`c = (c >> 1n) ^ …`) through a select and an early return, % and / (by zero, the RangeError).
    "BigInt parameters, carries that read themselves, selects, % and /, as a clone and not",
    "export function f(x, k) { function step(c, n, d) { c = __ykU64(~c) & 0xffffffffn; let i = 0; let q = 0n; while (n !== 0n) { n = __ykU64(n - 1n); c = (c >> 1n) ^ ((c & 1n) !== 0n ? 0xedb88320n : 0n); if (c === 0x12345n) return -1n; q = __ykU64(q + c % 7n + c / d); i = (i + 1) | 0; } return [c ^ 0xffffffffn, q, i, c % d]; } try { return step(x, typeof k === 'bigint' ? k & 63n : 5n, typeof k === 'bigint' ? k % 5n : 3n); } catch (e) { return `threw ${e.name}`; } }",
    fc.tuple(big, big),
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("BigInt and the leaves, natively (#1361)", () => {
  for (const [name, source, args] of PROGRAMS)
    it(name, () => {
      const inputs = fc.sample(args, { numRuns: 300, seed: 1361 }) as unknown[][];
      expect(disagreements(source, inputs).slice(0, 5)).toEqual([]);
    }, 300_000);
});
