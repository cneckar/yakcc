// SPDX-License-Identifier: Apache-2.0
// Shaving C (#1329, DEC-DUC-OPERATIONS-AS-ATOMS-001): C and C++ raised to atoms from clang's typed
// AST. Two oracles: the same C compiled natively by clang, and, for V8's ieee754.cc, Node's Math.
// Each raised function is run as raised and as lifted to a graph and lowered back to TypeScript.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { ts } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { C_LEAVES_JS, createCMemory, shaveCUnit } from "./raise-c.js";
import type { DucGraph } from "./types.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const V8 = here("../vendor/v8/");
const MUSL = here("../vendor/musl/");
const FIXTURE = here("./__fixtures__/c/semantics.c");

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

type Fn = (...a: unknown[]) => unknown;

/** The atoms as functions that call one another by name: as raised, or lifted and lowered. */
function link(
  atoms: ReadonlyMap<string, { source: string }>,
  lowered: boolean,
  memory: ReturnType<typeof createCMemory> = createCMemory(),
): Record<string, Fn> {
  const leaves = {
    ...(C_LEAVES_JS as unknown as Record<string, Fn>),
    ...(memory.leaves as unknown as Record<string, Fn>),
  };
  const env: Record<string, Fn> = { ...leaves };
  const names = [...Object.keys(leaves), ...atoms.keys()];
  for (const [key, atom] of atoms) {
    let source = atom.source;
    if (lowered) {
      const g = liftAtom(source);
      expect(opaque(g), key).toEqual([]);
      source = emitTypeScript(g);
    }
    const js = ts
      .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText.replace(/^export /m, "");
    env[key] = new Function(...names, `${js}; return f;`)(
      ...names.map(
        (n) =>
          (...x: unknown[]) =>
            env[n]?.(...x),
      ),
    ) as Fn;
  }
  return env;
}

const bitsOf = (x: number): bigint => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0);
};
const doubleOf = (b: bigint): number => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt.asUintN(64, b));
  return v.getFloat64(0);
};

/** Doubles of every kind: the edges, then generated ones over several ranges. */
const doubles = (n: number, seed: number): number[] => [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.MAX_VALUE,
  2 ** -1022,
  1e-300,
  1e300,
  Math.PI,
  Math.PI / 2,
  Math.PI / 4,
  709.78,
  709.79,
  -745.13,
  1e10,
  1e22,
  2 ** 52,
  3 * 2 ** 1020,
  ...fc.sample(
    fc.oneof(
      fc.double(),
      fc.double({ min: -10, max: 10 }),
      fc.double({ min: -1e6, max: 1e6 }),
      fc.tuple(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n })).map(([b]) => doubleOf(b)),
    ),
    { numRuns: n, seed },
  ),
];

describe.skipIf(!hasClang)("shaving V8's Math (ieee754.cc) and musl's scalbn", () => {
  const v8 = shaveCUnit(
    `${V8}src/base/ieee754.cc`,
    ["ieee754::", "__kernel", "__ieee754"],
    ["-std=c++20", `-I${V8}`, `-I${V8}include`],
  );
  const musl = shaveCUnit(`${MUSL}src/math/scalbn.c`, ["scalbn"], ["-std=c11"], "clang");
  const atoms = new Map([...v8.atoms, ...musl.atoms]);

  it("every function, and every header function and constant it uses, is raised", () => {
    expect([...v8.refused, ...musl.refused]).toEqual([]);
    expect([...v8.atoms.keys()]).toEqual(
      expect.arrayContaining(["sin", "cos", "pow", "__kernel_rem_pio2", "Divide", "infinity"]),
    );
    // scalbn is libc's: an external reference, linked to the atom shaved from musl.
    expect(v8.atoms.get("__kernel_rem_pio2")?.externals).toEqual(["scalbn"]);
  });

  const ONE = [
    "acos",
    "acosh",
    "asin",
    "asinh",
    "atan",
    "atanh",
    "cos",
    "exp",
    "log",
    "log1p",
    "log2",
    "log10",
    "expm1",
    "cbrt",
    "sin",
    "tan",
    "cosh",
    "sinh",
    "tanh",
  ];
  const TWO = ["atan2", "pow"];

  // The native oracle: ieee754.cc compiled by clang, called by name on bit patterns.
  const oracle = join(work, "ieee754");
  const driver = join(work, "driver.cc");
  writeFileSync(
    driver,
    `#include <cstdio>
#include <cstring>
#include <cstdint>
#include "src/base/ieee754.h"
namespace m = v8::base::ieee754;
static double d(unsigned long long b) { double x; memcpy(&x, &b, 8); return x; }
int main() {
  char name[32]; unsigned long long a, b;
  while (scanf("%31s %llx %llx", name, &a, &b) == 3) {
    double x = d(a), y = d(b), r = 0;
    ${ONE.map((n) => `if (!strcmp(name, "${n}")) r = m::${n}(x);`).join("\n    ")}
    if (!strcmp(name, "atan2")) r = m::atan2(x, y);
    if (!strcmp(name, "pow")) r = m::pow(x, y);
    unsigned long long o; memcpy(&o, &r, 8); printf("%016llx\\n", o);
  }
}
`,
  );

  for (const lowered of [false, true]) {
    it(`each function equals the native C and Node's Math, bit for bit (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      execFileSync("clang++", [
        "-std=c++20",
        "-O0",
        "-ffp-contract=off",
        `-I${V8}`,
        `-I${V8}include`,
        `${V8}src/base/ieee754.cc`,
        driver,
        "-o",
        oracle,
      ]);
      const env = link(atoms, lowered);
      const xs = doubles(lowered ? 400 : 2000, 1329);
      const cases: [string, number, number][] = [];
      for (const n of [...ONE, ...TWO])
        xs.forEach((x, i) => cases.push([n, x, xs[(i * 7 + 3) % xs.length] as number]));
      const native = execFileSync(oracle, {
        input: `${cases.map(([n, x, y]) => `${n} ${bitsOf(x).toString(16)} ${bitsOf(y).toString(16)}`).join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
        .trim()
        .split("\n")
        .map((h) => doubleOf(BigInt(`0x${h}`)));
      const bad: string[] = [];
      cases.forEach(([n, x, y], i) => {
        const raised = (env[n] as (a: number, b: number) => number)(x, y);
        const node =
          n === "atan2"
            ? Math.atan2(x, y)
            : n === "pow"
              ? x ** y
              : (Math as unknown as Record<string, (a: number) => number>)[n]?.(x);
        if (!Object.is(raised, native[i]))
          bad.push(`${n}(${x}, ${y}): raised ${raised}, C ${native[i]}`);
        if (!Object.is(native[i], node)) bad.push(`${n}(${x}, ${y}): C ${native[i]}, Node ${node}`);
      });
      expect(bad.slice(0, 10)).toEqual([]);
    }, 600_000);
  }
});

describe.skipIf(!hasClang)("C's meaning, kept (a fixture compiled natively and shaved)", () => {
  // name, parameter kinds (i: int, u: unsigned, d: double, U: uint64_t, I: int64_t), result kind.
  const SIGS: [string, string, string][] = [
    ["wrap_add", "ii", "i"],
    ["wrap_mul", "ii", "i"],
    ["u_sub_shift", "uu", "u"],
    ["s_shift", "ii", "i"],
    ["trunc_div", "ii", "i"],
    ["trunc_rem", "ii", "i"],
    ["truth", "ii", "i"],
    ["mixed", "iu", "i"],
    ["to_double", "iu", "d"],
    ["from_double", "d", "i"],
    ["wide", "Ui", "U"],
    ["wide_signed", "II", "I"],
    ["words", "d", "u"],
    ["from_words", "uu", "d"],
    ["compound", "ii", "i"],
    ["incdec", "i", "i"],
    ["fallthrough", "i", "i"],
    ["collatz", "i", "i"],
    ["table", "id", "d"],
    ["loops", "i", "i"],
  ];
  const C_TYPE: Record<string, string> = {
    i: "int",
    u: "unsigned",
    d: "double",
    U: "uint64_t",
    I: "int64_t",
  };

  it("every function is raised, and computes what the native C computes", () => {
    const unit = shaveCUnit(
      FIXTURE,
      SIGS.map(([n]) => n),
      ["-std=c11"],
      "clang",
    );
    expect([...unit.refused]).toEqual([]);
    const driver = join(work, "semantics-driver.c");
    // Each argument and result crosses as the 64 bits of its value.
    const arg = (k: string, j: number): string =>
      k === "d" ? `d(v[${j}])` : `(${C_TYPE[k]})v[${j}]`;
    const ret = (k: string): string =>
      k === "d"
        ? "bits(r)"
        : k === "i" || k === "I"
          ? "(unsigned long long)(long long)r"
          : "(unsigned long long)r";
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <string.h>
#include <stdint.h>
${SIGS.map(([n, ps, r]) => `${C_TYPE[r]} ${n}(${[...ps].map((p) => C_TYPE[p]).join(", ")});`).join("\n")}
static double d(unsigned long long b) { double x; memcpy(&x, &b, 8); return x; }
static unsigned long long bits(double x) { unsigned long long b; memcpy(&b, &x, 8); return b; }
int main(void) {
  char name[32]; unsigned long long v[2];
  while (scanf("%31s %llx %llx", name, &v[0], &v[1]) == 3) {
${SIGS.map(([n, ps, r]) => `    if (!strcmp(name, "${n}")) { ${C_TYPE[r]} r = ${n}(${[...ps].map(arg).join(", ")}); printf("%016llx\\n", ${ret(r)}); }`).join("\n")}
  }
  return 0;
}
`,
    );
    const exe = join(work, "semantics");
    execFileSync("clang", [
      "-std=c11",
      "-O0",
      "-fwrapv",
      "-ffp-contract=off",
      FIXTURE,
      driver,
      "-o",
      exe,
    ]);
    const ints = fc.oneof(
      fc.integer({ min: -2147483648, max: 2147483647 }),
      fc.integer({ min: -50, max: 50 }),
      fc.constantFrom(0, 1, -1, 2147483647, -2147483648),
    );
    const value = (k: string, seed: number): bigint[] =>
      k === "d"
        ? doubles(300, seed).map(bitsOf)
        : k === "U" || k === "I"
          ? fc.sample(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { numRuns: 300, seed })
          : fc.sample(ints, { numRuns: 300, seed }).map((x) => BigInt.asUintN(64, BigInt(x)));
    for (const lowered of [false, true]) {
      const env = link(unit.atoms, lowered);
      const cases: [string, string, string, bigint, bigint][] = [];
      SIGS.forEach(([n, ps, r], s) => {
        const a = value(ps[0] as string, s);
        const b = value(ps[1] ?? "i", s + 100);
        a.forEach((x, i) => cases.push([n, ps, r, x, b[i % b.length] as bigint]));
      });
      const native = execFileSync(exe, {
        input: `${cases.map(([n, , , x, y]) => `${n} ${x.toString(16)} ${y.toString(16)}`).join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
        .trim()
        .split("\n");
      const toJs = (k: string, b: bigint): unknown =>
        k === "d"
          ? doubleOf(b)
          : k === "U"
            ? b
            : k === "I"
              ? BigInt.asIntN(64, b)
              : k === "u"
                ? Number(BigInt.asUintN(32, b))
                : Number(BigInt.asIntN(32, b));
      const fromJs = (k: string, v: unknown): bigint =>
        k === "d"
          ? bitsOf(v as number)
          : BigInt.asUintN(64, typeof v === "bigint" ? v : BigInt(v as number));
      const bad: string[] = [];
      cases.forEach(([n, ps, r, x, y], i) => {
        const args = [...ps].map((k, j) => toJs(k, j === 0 ? x : y));
        const got = fromJs(r, (env[n] as Fn)(...args));
        const want = BigInt(`0x${native[i]}`);
        if (got !== want)
          bad.push(`${n}(${args.join(", ")}): raised ${got.toString(16)}, C ${want.toString(16)}`);
      });
      expect(bad.slice(0, 10), lowered ? "lifted and lowered" : "as raised").toEqual([]);
    }
  }, 600_000);
});
