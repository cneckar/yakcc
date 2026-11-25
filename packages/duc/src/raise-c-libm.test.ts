// SPDX-License-Identifier: Apache-2.0
// musl's libm, shaved down to the leaves (#1365): the double functions of math.h (powers,
// logarithms, trigonometric, hyperbolic, error and gamma functions, rounding, remainders). The
// shaved closure runs over the memory leaves; the oracle is the same musl sources compiled
// natively. Each result must be the same bits, on special values and on random doubles.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { buildMuslNative, shaveMusl } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-libm-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const UNARY = [
  "sqrt",
  "cbrt",
  "exp",
  "exp2",
  "expm1",
  "log",
  "log2",
  "log10",
  "log1p",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "erf",
  "erfc",
  "tgamma",
  "lgamma",
  "floor",
  "ceil",
  "round",
  "rint",
  "trunc",
  "logb",
];
const BINARY = [
  "pow",
  "atan2",
  "fmod",
  "hypot",
  "remainder",
  "fmax",
  "fmin",
  "fdim",
  "copysign",
  "nextafter",
];

const SPECIAL = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  10,
  1e-300,
  -1e-300,
  5e-324,
  2.2250738585072014e-308,
  1e300,
  -1e300,
  1.7976931348623157e308,
  Math.PI,
  -Math.PI,
  Math.PI / 2,
  Math.E,
  0.1,
  100,
  709.78,
  -745.2,
  1e22,
  3.0000000000000004,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
];

const bits = (d: number): bigint => new BigUint64Array(new Float64Array([d]).buffer)[0] as bigint;
const hex = (b: bigint): string => b.toString(16).padStart(16, "0");

describe.skipIf(!hasClang)("musl's libm, shaved down to the leaves", () => {
  const closure = shaveMusl([...UNARY, ...BINARY]);

  it("the closure shaves with no refusal, and stops only at the leaves", () => {
    expect(closure.refused).toEqual([]);
    expect(closure.missing).toEqual([]);
    for (const r of [...UNARY, ...BINARY]) expect(closure.atoms.has(r), r).toBe(true);
  });

  const cases = (seed: number): [string, number, number][] => {
    const random = fc.sample(
      fc.oneof(
        fc.double(),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -800, max: 800, noNaN: true }),
      ),
      { numRuns: 60, seed },
    );
    const xs = [...SPECIAL, ...random];
    return [
      ...UNARY.flatMap((f) => xs.map((x): [string, number, number] => [f, x, 0])),
      ...BINARY.flatMap((f) =>
        xs.map((x, i): [string, number, number] => [f, x, xs[(i * 7 + 3) % xs.length] as number]),
      ),
    ];
  };

  const native = (all: readonly [string, number, number][]): string[] => {
    const exe = buildMuslNative(
      closure.units,
      work,
      `libm${all.length}`,
      `#include <string.h>
#include <unistd.h>
${UNARY.map((f) => `double ${f}(double);`).join("\n")}
${BINARY.map((f) => `double ${f}(double, double);`).join("\n")}
static double dbl(unsigned long long b) { double d; memcpy(&d, &b, 8); return d; }
static void out(double d) {
  static const char h[] = "0123456789abcdef";
  unsigned long long b; memcpy(&b, &d, 8);
  char s[17]; for (int i = 0; i < 16; i++) s[i] = h[(b >> (60 - 4 * i)) & 15]; s[16] = '\\n';
  write(1, s, 17);
}
int main(void) {
${all
  .map(([f, x, y]) =>
    UNARY.includes(f)
      ? `  out(${f}(dbl(0x${hex(bits(x))}ULL)));`
      : `  out(${f}(dbl(0x${hex(bits(x))}ULL), dbl(0x${hex(bits(y))}ULL)));`,
  )
  .join("\n")}
  return 0;
}
`,
    );
    return execFileSync(exe, { encoding: "utf8", maxBuffer: 1 << 26 })
      .trim()
      .split("\n");
  };

  for (const lowered of [false, true]) {
    it(`each result is the bits of musl compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const all = cases(lowered ? 1365 : 13650);
      const want = native(all);
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        closure.atoms,
        lowered,
        memory,
        closure.units,
        system.leaves as unknown as Record<string, Fn>,
      );
      const got = all.map(([f, x, y]) => hex(bits(env[f]?.(x, y) as number)));
      const bad = got.flatMap((g, i) =>
        g === want[i] ? [] : [`${all[i]?.join(" ")}: shaved ${g}, C ${want[i]}`],
      );
      // NaN payloads aside (JavaScript does not keep them), every bit is the same.
      const real = bad.filter((b) => {
        const [, , , , s, , c] = b.split(" ");
        const nan = (h: string | undefined): boolean =>
          /^(7ff|fff)[0-9a-f]{13}$/.test(h ?? "") && !/^(7ff|fff)0{13}$/.test(h ?? "");
        return !(nan(s?.replace(",", "")) && nan(c));
      });
      expect(real.slice(0, 10)).toEqual([]);
    }, 900_000);
  }
});
