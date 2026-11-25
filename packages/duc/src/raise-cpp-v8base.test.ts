// SPDX-License-Identifier: Apache-2.0
// The C++ front end on V8's src/base (#1364 acceptance): bits.h/.cc and division-by-constant
// (V8 12.4, vendored): popcounts, leading and trailing zeros, powers of two, rotations, overflow
// helpers with an out parameter, high multiplications, divisions and saturations, and the magic
// numbers for a division by a constant (templates, constexpr, a struct by value). Shaved and
// compiled natively, each entry must give the same 64-bit result on generated inputs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { createCMemory, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const V8 = fileURLToPath(new URL("../vendor/v8/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/v8-base.cpp", import.meta.url));
const ARGS = ["-std=c++20", `-I${V8}`, `-I${V8}include`];
const UNARY = [
  "yk_popcount32",
  "yk_popcount64",
  "yk_popcount8",
  "yk_clz32",
  "yk_clz64",
  "yk_ctz32",
  "yk_ctz64",
  "yk_is_pow2",
  "yk_round_up_pow2_32",
  "yk_round_up_pow2_64",
];
const BINARY = [
  "yk_rotr32",
  "yk_rotr64",
  "yk_add_overflow32",
  "yk_sub_overflow32",
  "yk_mul_overflow32",
  "yk_mul_high32",
  "yk_umul_high32",
  "yk_mul_high64",
  "yk_umul_high64",
  "yk_div32",
  "yk_mod32",
  "yk_div64",
  "yk_mod64",
  "yk_sat_add64",
  "yk_sat_sub64",
];
/** A divisor's magic numbers: for divisors the algorithm takes (not 0, 1 or -1). */
const MAGIC = ["yk_signed_magic32", "yk_unsigned_magic32", "yk_signed_magic64"];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-v8base-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("V8's src/base bits and division by a constant, shaved from C++", () => {
  const unit = shaveCUnit(FIXTURE, [...UNARY, ...BINARY, ...MAGIC], ARGS, "clang++", "v8-base.cpp");

  it("every entry, and every template instance it uses, shaves with no refusal", () => {
    expect([...unit.refused]).toEqual([]);
    for (const n of [...UNARY, ...BINARY, ...MAGIC]) expect(unit.atoms.has(n), n).toBe(true);
  });

  const word = fc.oneof(
    fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
    fc.bigInt({ min: -(2n ** 31n), max: 2n ** 31n - 1n }),
    fc.bigInt({ min: -300n, max: 300n }),
    fc.constantFrom(
      0n,
      1n,
      -1n,
      2n ** 31n - 1n,
      -(2n ** 31n),
      2n ** 63n - 1n,
      -(2n ** 63n),
      1n << 40n,
    ),
  );
  const cases = (seed: number): [string, bigint, bigint][] => [
    ...[...UNARY, ...BINARY].flatMap((f, i) =>
      fc
        .sample(fc.tuple(word, word), { numRuns: 60, seed: seed + i })
        .map(([a, b]): [string, bigint, bigint] => [f, a, b]),
    ),
    ...MAGIC.flatMap((f, i) =>
      fc
        .sample(
          fc.oneof(
            fc.bigInt({ min: 2n, max: 100000n }),
            fc.bigInt({ min: 2n, max: 2n ** 31n - 1n }),
          ),
          { numRuns: 60, seed: seed + 100 + i },
        )
        .map((d): [string, bigint, bigint] => [f, d, 0n]),
    ),
  ];

  let exe = "";
  const native = (all: readonly [string, bigint, bigint][]): string[] => {
    if (exe === "") {
      const driver = join(work, "driver.c");
      const names = [...UNARY, ...BINARY, ...MAGIC];
      writeFileSync(
        driver,
        `#include <stdio.h>
#include <string.h>
#include <stdint.h>
${names.map((n) => `int64_t ${n}(${UNARY.includes(n) || MAGIC.includes(n) ? "int64_t" : "int64_t, int64_t"});`).join("\n")}
int main(void) {
  char f[64]; long long a, b;
  while (scanf("%63s %lld %lld", f, &a, &b) == 3) {
${names.map((n) => `    if (!strcmp(f, "${n}")) printf("%lld\\n", (long long)${n}(${UNARY.includes(n) || MAGIC.includes(n) ? "a" : "a, b"}));`).join("\n")}
  }
  return 0;
}
`,
      );
      const obj = join(work, "v8-base.o");
      execFileSync("clang++", [...ARGS, "-O0", "-c", FIXTURE, "-o", obj]);
      exe = join(work, "v8-base");
      execFileSync("clang++", ["-O0", "-x", "c", driver, "-x", "none", obj, "-o", exe]);
    }
    return execFileSync(exe, {
      input: `${all.map((c) => c.join(" ")).join("\n")}\n`,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
  };

  for (const lowered of [false, true]) {
    it(`each entry equals the C++ compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const all = cases(lowered ? 1364 : 13640);
      const want = native(all);
      const env = link(unit.atoms, lowered, createCMemory(), [unit]);
      const got = all.map(([n, a, b]) =>
        String(BigInt.asIntN(64, (env[n] as Fn)(...(BINARY.includes(n) ? [a, b] : [a])) as bigint)),
      );
      const bad = got.flatMap((g, i) =>
        g === want[i] ? [] : [`${all[i]?.join(" ")}: shaved ${g}, C++ ${want[i]}`],
      );
      expect(bad.slice(0, 8)).toEqual([]);
    }, 900_000);
  }
});
