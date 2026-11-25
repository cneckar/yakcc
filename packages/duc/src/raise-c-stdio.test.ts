// SPDX-License-Identifier: Apache-2.0
// musl's formatted output and number parsing, shaved down to the leaves (#1365): snprintf (musl's
// vfprintf: integers, strings, characters, and fmt_fp's exact decimal and hexadecimal doubles),
// strtol, strtoul, strtoll, strtod and atoi. The shaved closure runs over the memory leaves; the
// oracle is the same musl sources compiled natively. Each case's result (snprintf's count and
// bytes; a parse's value and where it stopped) must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
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

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-stdio-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ROOTS = ["snprintf", "strtol", "strtoul", "strtoll", "strtod", "atoi"];

/** One snprintf: a format and its one argument (none for a format with no conversion). */
type Arg = { i: number } | { l: bigint } | { d: number } | { s: string } | null;
type Print = [string, Arg];
/** One parse: the function, the text, the base (strtod and atoi: none). */
type Parse = ["strtol" | "strtoul" | "strtoll" | "strtod" | "atoi", string, number];

const INT_FORMATS = [
  "%d",
  "%5d",
  "%-5d|",
  "%05d",
  "%+d",
  "% d",
  "%x",
  "%#x",
  "%X",
  "%o",
  "%#o",
  "%u",
  "%c",
  "%.3d",
  "%hhd",
  "%hd",
  "%.0d",
];
const LONG_FORMATS = ["%ld", "%lld", "%lx", "%#lo", "%lu", "%20ld", "%-20lx|", "%jd", "%zd"];
const DOUBLE_FORMATS = [
  "%f",
  "%.0f",
  "%.10f",
  "%e",
  "%.3e",
  "%E",
  "%g",
  "%.17g",
  "%G",
  "%a",
  "%.3a",
  "%A",
  "%12.4f",
  "%-+14.6e|",
  "%#.0f",
  "%#g",
  "%010.2f",
];
const STRING_FORMATS = ["%s", "%.3s", "%10s|", "%-10s|", "%.0s"];

const FIXED: Print[] = [
  ["hello, world", null],
  ["100%%", null],
  ...INT_FORMATS.map((f): Print => [f, { i: 0 }]),
  ...INT_FORMATS.map((f): Print => [f, { i: -2147483648 }]),
  ...INT_FORMATS.map((f): Print => [f, { i: 2147483647 }]),
  ...INT_FORMATS.map((f): Print => [f, { i: 65 }]),
  ...LONG_FORMATS.map((f): Print => [f, { l: -9223372036854775808n }]),
  ...LONG_FORMATS.map((f): Print => [f, { l: 9223372036854775807n }]),
  ...DOUBLE_FORMATS.flatMap((f): Print[] =>
    [
      0,
      -0,
      1,
      -1.5,
      0.1,
      1e300,
      5e-324,
      2.2250738585072014e-308,
      1.7976931348623157e308,
      123456.789,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ].map((d): Print => [f, { d }]),
  ),
  ...STRING_FORMATS.map((f): Print => [f, { s: "yakcc" }]),
  ...STRING_FORMATS.map((f): Print => [f, { s: "" }]),
];

const PARSES: Parse[] = [
  ...[
    "0",
    "42",
    "-42",
    "  +17xyz",
    "0x1F",
    "0X",
    "077",
    "9223372036854775807",
    "9223372036854775808",
    "-9223372036854775809",
    "z",
    "",
    "   ",
    "-0",
  ].flatMap((t): Parse[] => [
    ["strtol", t, 10],
    ["strtol", t, 0],
    ["strtol", t, 16],
    ["strtoul", t, 0],
    ["strtoll", t, 36],
    ["atoi", t, 0],
  ]),
  ...[
    "0",
    "1",
    "-2.5",
    "0.1",
    "1e308",
    "1e309",
    "-1e-400",
    "2.2250738585072011e-308",
    "4.9e-324",
    "0x1.8p3",
    "0x.1p-1070",
    "inf",
    "-Infinity",
    "nan",
    "1.7976931348623157e308",
    "123456789012345678901234567890",
    ".5e",
    "  3.14159265358979323846rest",
    "0.000000000000000000000000000001",
    "1_000",
  ].map((t): Parse => ["strtod", t, 0]),
];

/** A C string literal for ASCII text. */
const lit = (t: string): string => JSON.stringify(t);
const bits = (d: number): bigint => new BigUint64Array(new Float64Array([d]).buffer)[0] as bigint;

describe.skipIf(!hasClang)("musl's snprintf and strto*, shaved down to the leaves", () => {
  const closure = shaveMusl(ROOTS);

  it("the closure shaves with no refusal, and stops only at the leaves", () => {
    expect(closure.refused).toEqual([]);
    expect(closure.missing).toEqual([]);
    for (const r of ROOTS) expect(closure.atoms.has(r), r).toBe(true);
  });

  const randomPrints = (seed: number): Print[] =>
    fc.sample(
      fc.oneof(
        fc.tuple(
          fc.constantFrom(...INT_FORMATS),
          fc.integer().map((i) => ({ i })),
        ),
        fc.tuple(
          fc.constantFrom(...LONG_FORMATS),
          fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((l) => ({ l })),
        ),
        fc.tuple(
          fc.constantFrom(...DOUBLE_FORMATS),
          fc.double({ noNaN: true }).map((d) => ({ d })),
        ),
      ),
      { numRuns: 300, seed },
    ) as Print[];

  /** The native side: each case as C, its result a line written with write(2). */
  const native = (prints: readonly Print[], parses: readonly Parse[]): string[] => {
    const call = ([f, a]: Print): string => {
      const arg =
        a === null
          ? ""
          : "i" in a
            ? `, (int)${a.i}`
            : "l" in a
              ? `, (long)${a.l === -(2n ** 63n) ? "(-9223372036854775807L - 1)" : `${a.l}L`}`
              : "d" in a
                ? `, dbl(0x${bits(a.d).toString(16)}ULL)`
                : `, ${lit(a.s)}`;
      return `  n = snprintf(buf, sizeof buf, ${lit(f)}${arg}); line(n, buf, n < 0 ? 0 : n < (int)sizeof buf ? n : (int)sizeof buf - 1);`;
    };
    const parse = ([fn, t, base]: Parse): string =>
      fn === "strtod"
        ? `  { const char *s = ${lit(t)}; char *e; double d = strtod(s, &e); unsigned long long b; memcpy(&b, &d, 8); num(b, e - s); }`
        : fn === "atoi"
          ? `  num((unsigned long long)(long long)atoi(${lit(t)}), 0);`
          : `  { const char *s = ${lit(t)}; char *e; unsigned long long v = (unsigned long long)${fn}(s, &e, ${base}); num(v, e - s); }`;
    const exe = buildMuslNative(
      closure.units,
      work,
      `stdio${prints.length}`,
      `#include <stddef.h>
#include <string.h>
#include <unistd.h>
int snprintf(char *, size_t, const char *, ...);
long strtol(const char *, char **, int);
unsigned long strtoul(const char *, char **, int);
long long strtoll(const char *, char **, int);
double strtod(const char *, char **);
int atoi(const char *);
static double dbl(unsigned long long b) { double d; memcpy(&d, &b, 8); return d; }
static void put(const char *s, size_t n) { write(1, s, n); }
static void hexs(const unsigned char *p, int n) {
  static const char h[] = "0123456789abcdef";
  for (int i = 0; i < n; i++) { char c[2] = { h[p[i] >> 4], h[p[i] & 15] }; put(c, 2); }
}
static void dec(long long v) { char b[24]; int i = 24; unsigned long long u = v < 0 ? -(unsigned long long)v : (unsigned long long)v; do b[--i] = '0' + u % 10; while (u /= 10); if (v < 0) b[--i] = '-'; put(b + i, 24 - i); }
static void line(int n, const char *buf, int len) { dec(n); put(" ", 1); hexs((const unsigned char *)buf, len); put("\\n", 1); }
static void num(unsigned long long v, long long end) { unsigned char b[8]; for (int i = 0; i < 8; i++) b[i] = v >> (56 - 8 * i); hexs(b, 8); put(" ", 1); dec(end); put("\\n", 1); }
int main(void) {
  char buf[512]; int n;
${prints.map(call).join("\n")}
${parses.map(parse).join("\n")}
  return 0;
}
`,
    );
    return execFileSync(exe, { encoding: "utf8", maxBuffer: 1 << 26 })
      .trim()
      .split("\n");
  };

  /** The same cases on the shaved atoms. */
  const shaved = (
    lowered: boolean,
    prints: readonly Print[],
    parses: readonly Parse[],
  ): string[] => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      closure.atoms,
      lowered,
      memory,
      closure.units,
      system.leaves as unknown as Record<string, Fn>,
    );
    const L = memory.leaves;
    const cstr = (t: string): number => memory.put([...Buffer.from(t, "latin1"), 0]);
    const buf = L.__ykAlloc(512, 16);
    const out: string[] = [];
    for (const [f, a] of prints) {
      const va = L.__ykAlloc(8, 8);
      if (a !== null) {
        if ("i" in a) L.__ykStore64(va, BigInt(a.i));
        else if ("l" in a) L.__ykStore64(va, a.l);
        else if ("d" in a) L.__ykStoreF64(va, a.d);
        else L.__ykStore64(va, BigInt(cstr(a.s)));
      }
      const n = env.snprintf?.(buf, 512n, cstr(f), va) as number;
      const len = n < 0 ? 0 : Math.min(n, 511);
      out.push(`${n} ${hex(memory.get(buf, len))}`);
    }
    const end = L.__ykAlloc(8, 8);
    const word = (v: bigint): string => BigInt.asUintN(64, v).toString(16).padStart(16, "0");
    for (const [fn, t, base] of parses) {
      const s = cstr(t);
      if (fn === "atoi") {
        out.push(`${word(BigInt(env.atoi?.(s) as number))} 0`);
        continue;
      }
      const v =
        fn === "strtod"
          ? bits(env.strtod?.(s, end) as number)
          : (env[fn]?.(s, end, base) as bigint);
      out.push(`${word(v)} ${Number(L.__ykLoad64(end)) - s}`);
    }
    return out;
  };

  for (const lowered of [false, true]) {
    it(`each case equals musl compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const prints = [...FIXED, ...randomPrints(lowered ? 1365 : 13650)];
      const want = native(prints, PARSES);
      const got = shaved(lowered, prints, PARSES);
      const cases = [
        ...prints.map((p) => JSON.stringify(p, (_, v) => (typeof v === "bigint" ? `${v}n` : v))),
        ...PARSES.map((p) => JSON.stringify(p)),
      ];
      const bad = got.flatMap((x, i) =>
        x === want[i] ? [] : [`${cases[i]}: shaved ${x}, C ${want[i]}`],
      );
      expect(bad.slice(0, 8)).toEqual([]);
      expect(got.length).toBe(want.length);
    }, 900_000);
  }
});
