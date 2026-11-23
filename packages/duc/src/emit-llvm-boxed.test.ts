// SPDX-License-Identifier: Apache-2.0
// The native lowering beyond the typed subset (#1292, DEC-DUC-NATIVE-RUNTIME-001): NaN-boxed values
// and the runtime. Each program is lifted, lowered to LLVM IR, compiled by llc, linked with the
// runtime (compiled by clang) into a C harness, and run on generated inputs of every value kind
// the slice covers; its results must be the source's, as Node computes them, exactly. One program
// also runs on AArch64, ARMv7 and RISC-V under QEMU.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { LlvmEmitError } from "./emit-llvm.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-boxed-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Every value kind the slice covers, with the awkward ones each coercion has. */
const scalar = fc.oneof(
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1e21,
    1e21,
    0.1,
    1e-7,
    123e-20,
    2 ** 53,
  ),
  fc.string({ maxLength: 6 }),
  fc.string({ unit: "binary", maxLength: 4 }),
  fc.constantFrom(
    "",
    " ",
    " 12 ",
    "0x1F",
    "0b101",
    "0o17",
    "1e3",
    "-0",
    "Infinity",
    "-Infinity",
    "12px",
    ".5",
    "5.",
    "+.5e-3",
    " 12 ",
    "a",
    "abc",
    "ab,c",
  ),
  fc.boolean(),
  fc.constantFrom(null, undefined),
);
const value = fc.oneof(
  { weight: 4, arbitrary: scalar },
  { weight: 1, arbitrary: fc.array(scalar, { maxLength: 4 }) },
);

/** The source as Node runs it. */
function reference(source: string): (...a: unknown[]) => unknown {
  return new Function(`${source.replace(/^export /, "")}; return f;`)() as (
    ...a: unknown[]
  ) => unknown;
}

/** Runs the program natively and in Node on the same inputs; returns the disagreements. */
function disagreements(
  source: string,
  inputs: readonly unknown[][],
  target = "x86_64-linux",
): string[] {
  const run = harness(emitLlvmBoxed(liftAtom(source)), work, target);
  // The reference may throw (a method on a value without it): those inputs are not compared here.
  const ref = reference(source);
  const kept: { args: unknown[]; want: unknown }[] = [];
  for (const args of inputs) {
    try {
      kept.push({ args: structuredClone(args), want: ref(...structuredClone(args)) });
    } catch {}
  }
  const { results, stderr } = run(kept.map((k) => k.args));
  if (results.length !== kept.length) return [`ran ${results.length} of ${kept.length}: ${stderr}`];
  return kept.flatMap((k, i) =>
    same(results[i], k.want)
      ? []
      : [
          `${JSON.stringify(k.args)} → native ${JSON.stringify(results[i])}, node ${JSON.stringify(k.want)}`,
        ],
  );
}

const PROGRAMS: [string, string, number][] = [
  // + with ToPrimitive, string concatenation and Number::toString's shortest digits.
  ["+ on every pair of kinds", "export function f(a, b) { return a + b; }", 2],
  [
    "the other operators and their coercions",
    "export function f(a, b) { return [a == b, a === b, a != b, a < b, a >= b, a > b, a <= b, typeof a, !a, a - b, a * b, a / b, a % b, -a, +b, a && b, a || b]; }",
    2,
  ],
  [
    "template literals and number formatting",
    "export function f(a, b) { return `${a}|${b}|${a / 3}|${b * 1e21}|${a * 1e-7}`; }",
    2,
  ],
  [
    "strings: length, index, charCodeAt, slice, indexOf",
    "export function f(s, i) { if (typeof s !== 'string') return null; return [s.length, s[i], s.charCodeAt(i), s.slice(i), s.slice(-2, i), s.indexOf('a', i), s.indexOf(s.slice(1))]; }",
    2,
  ],
  [
    "arrays: a loop, push, index, join, indexOf, slice",
    "export function f(xs, v) { if (typeof xs !== 'object' || xs === null) return xs; const out = []; let i = 0; while (i < xs.length) { out.push(xs[i] + v); i = i + 1; } out.push(xs.length); return [out.join('|'), out.indexOf(v), out.slice(-2), out[0], out[99], xs.join()]; }",
    2,
  ],
  [
    "the exact Math on any value",
    "export function f(a, b) { return [Math.floor(a), Math.round(a), Math.sign(b), Math.min(a, b), Math.max(a, b, -0), Math.abs(a), Math.trunc(b), Math.sqrt(a)]; }",
    2,
  ],
];

describe.skipIf(!canRun("x86_64-linux"))("boxed values, natively on this host (#1292)", () => {
  for (const [name, source, arity] of PROGRAMS) {
    it(`computes what Node computes: ${name}`, () => {
      const inputs = fc.sample(fc.array(value, { minLength: arity, maxLength: arity }), {
        numRuns: 500,
        seed: 1292,
      });
      expect(disagreements(source, inputs)).toEqual([]);
    }, 180_000);
  }
});

describe("boxed values on other architectures, under QEMU (#1292)", () => {
  const source = PROGRAMS[4]?.[1] as string;
  for (const target of ["aarch64-linux", "arm-linux", "riscv64-linux"])
    it.skipIf(!canRun(target))(
      `${target}: the array program computes what Node computes`,
      () => {
        const inputs = fc.sample(fc.array(value, { minLength: 2, maxLength: 2 }), {
          numRuns: 150,
          seed: 7,
        });
        expect(disagreements(source, inputs, target)).toEqual([]);
      },
      180_000,
    );
});

describe("what the boxed lowering refuses, for now (#1292)", () => {
  const refusal = (source: string): string => {
    try {
      emitLlvmBoxed(liftAtom(source));
    } catch (e) {
      if (e instanceof LlvmEmitError) return e.message;
      throw e;
    }
    return "lowered";
  };
  it("free names, closures, objects written, approximated Math", () => {
    expect(refusal("export function f(x) { return helper(x); }")).toMatch(
      /"helper" is not in the native base set/,
    );
    expect(refusal("export function f(xs) { return xs.map((x) => x + 1); }")).toMatch(/closure/);
    expect(refusal("export function f(o) { o.k = 1; return o; }")).toMatch(/not in the subset yet/);
    expect(refusal("export function f(x) { return Math.sin(x); }")).toMatch(
      /implementation-approximated/,
    );
  });
});
