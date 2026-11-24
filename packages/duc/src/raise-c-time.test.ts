// SPDX-License-Identifier: Apache-2.0
// musl's time, environment and small stdlib functions, shaved down to the leaves (#1365): gmtime_r,
// timegm, strftime, getenv, srand/rand and bsearch. The shaved closure runs over the memory leaves;
// the oracle is the same musl sources compiled natively. Both sides get the same environment
// (TZ=UTC), set in musl's __environ. Each case's printed result must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { buildMuslNative, shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-time-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ROOTS = ["gmtime_r", "timegm", "strftime", "getenv", "srand", "rand", "bsearch"];
const ENV = ["TZ=UTC", "HOME=/home/yakcc", "LANG=C", "EMPTY="];
const FORMATS = [
  "%Y-%m-%d %H:%M:%S",
  "%a %b %e %j %U %W %u %w",
  "%y %C %G %g %V %I %p %M",
  "%c|%x|%X|%D|%F|%T|%R|%r",
  "%s %% %h %A %B",
];
const NAMES = ["TZ", "HOME", "LANG", "EMPTY", "NOPE", "HOM"];
// A sorted table for bsearch, and keys present and absent.
const TABLE = [-90, -7, 0, 3, 4, 17, 99, 1000, 4096, 70000];

describe.skipIf(!hasClang)(
  "musl's time, getenv, rand and bsearch, shaved down to the leaves",
  () => {
    // With the startup the library expects (the thread's locale).
    const closure = withMuslInit(shaveMusl(ROOTS));

    it("the closure shaves with no refusal, and stops only at the leaves", () => {
      expect(closure.refused).toEqual([]);
      expect(closure.missing).toEqual([]);
      for (const r of ROOTS) expect(closure.atoms.has(r), r).toBe(true);
    });

    const times = (seed: number): bigint[] => [
      0n,
      -1n,
      951782400n, // 2000-02-29
      2147483647n,
      -2147483648n,
      253402300799n, // 9999-12-31 23:59:59
      ...fc.sample(fc.bigInt({ min: -(2n ** 40n), max: 2n ** 40n }), { numRuns: 40, seed }),
    ];

    const native = (
      ts: readonly bigint[],
      seeds: readonly number[],
      keys: readonly number[],
    ): string[] => {
      const exe = buildMuslNative(
        closure.units,
        work,
        `time${ts.length}`,
        `#include <stddef.h>
#include <string.h>
#include <unistd.h>
struct tm { int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst; long tm_gmtoff; const char *tm_zone; };
struct tm *gmtime_r(const long *, struct tm *);
long timegm(struct tm *);
size_t strftime(char *, size_t, const char *, const struct tm *);
char *getenv(const char *);
void srand(unsigned);
int rand(void);
void *bsearch(const void *, const void *, size_t, size_t, int (*)(const void *, const void *));
extern char **__environ;
void yk_musl_init(void);
static void put(const char *s) { write(1, s, strlen(s)); }
static void dec(long long v) { char b[24]; int i = 24; unsigned long long u = v < 0 ? -(unsigned long long)v : (unsigned long long)v; do b[--i] = '0' + u % 10; while (u /= 10); if (v < 0) b[--i] = '-'; write(1, b + i, 24 - i); }
static int cmp(const void *a, const void *b) { int x = *(const int *)a, y = *(const int *)b; return (x > y) - (x < y); }
static char *env[] = { ${ENV.map((e) => JSON.stringify(e)).join(", ")}, 0 };
static const int table[] = { ${TABLE.join(", ")} };
int main(void) {
  yk_musl_init();
  __environ = env;
  struct tm tm; char buf[256]; long t;
${ts
  .map(
    (
      t,
    ) => `  t = ${t === -(2n ** 63n) ? "0" : `${t}L`}; if (gmtime_r(&t, &tm)) { dec(tm.tm_year); put(" "); dec(tm.tm_mon); put(" "); dec(tm.tm_mday); put(" "); dec(tm.tm_hour); put(" "); dec(tm.tm_min); put(" "); dec(tm.tm_sec); put(" "); dec(tm.tm_wday); put(" "); dec(tm.tm_yday); put(" "); dec(timegm(&tm));
${FORMATS.map((f) => `    put(" |"); strftime(buf, sizeof buf, ${JSON.stringify(f)}, &tm); put(buf);`).join("\n")}
  } else put("null"); put("\\n");`,
  )
  .join("\n")}
${NAMES.map((n) => `  { char *v = getenv(${JSON.stringify(n)}); put(v ? v : "(null)"); put("\\n"); }`).join("\n")}
${seeds.map((s) => `  srand(${s}u); for (int i = 0; i < 4; i++) { dec(rand()); put(" "); } put("\\n");`).join("\n")}
${keys.map((k) => `  { int key = ${k}; const int *p = bsearch(&key, table, ${TABLE.length}, sizeof *table, cmp); dec(p ? p - table : -1); put("\\n"); }`).join("\n")}
  return 0;
}
`,
      );
      return execFileSync(exe, { encoding: "utf8", maxBuffer: 1 << 26 })
        .trim()
        .split("\n");
    };

    const shaved = (
      lowered: boolean,
      ts: readonly bigint[],
      seeds: readonly number[],
      keys: readonly number[],
    ): string[] => {
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(closure.atoms, lowered, memory, closure.units, {
        ...(system.leaves as unknown as Record<string, Fn>),
        // The comparison bsearch calls through its pointer, as the native driver's.
        yk_cmp: (a: unknown, b: unknown): number => {
          const x = memory.leaves.__ykLoad32(a as number) | 0;
          const y = memory.leaves.__ykLoad32(b as number) | 0;
          return (x > y ? 1 : 0) - (x < y ? 1 : 0);
        },
      });
      const L = memory.leaves;
      env.yk_musl_init?.();
      const cstr = (t: string): number => memory.put([...Buffer.from(t, "latin1"), 0]);
      const str = (a: number): string => {
        let s = "";
        for (let i = a; L.__ykLoad8(i) !== 0; i++) s += String.fromCharCode(L.__ykLoad8(i));
        return s;
      };
      // __environ: an array of the strings' addresses, ended by 0.
      const envp = L.__ykAlloc(8 * (ENV.length + 1), 8);
      ENV.forEach((e, i) => L.__ykStore64(envp + 8 * i, BigInt(cstr(e))));
      L.__ykStore64(L.__ykStatic("__environ"), BigInt(envp));
      const out: string[] = [];
      const tm = L.__ykAlloc(56, 8);
      const tp = L.__ykAlloc(8, 8);
      const buf = L.__ykAlloc(256, 16);
      const fmts = FORMATS.map(cstr);
      for (const t of ts) {
        L.__ykStore64(tp, t);
        if ((env.gmtime_r?.(tp, tm) as number) === 0) {
          out.push("null");
          continue;
        }
        const f = (i: number): number => L.__ykLoad32(tm + 4 * i) | 0;
        const fields = [f(5), f(4), f(3), f(2), f(1), f(0), f(6), f(7)];
        const back = env.timegm?.(tm) as bigint;
        const formatted = fmts.map((fa) => {
          const n = Number(env.strftime?.(buf, 256n, fa, tm) as bigint);
          return ` |${str(buf).slice(0, n)}`;
        });
        out.push(`${fields.join(" ")} ${back}${formatted.join("")}`);
      }
      for (const n of NAMES) {
        const v = env.getenv?.(cstr(n)) as number;
        out.push(v === 0 ? "(null)" : str(v));
      }
      for (const s of seeds) {
        env.srand?.(s >>> 0);
        out.push(`${[0, 1, 2, 3].map(() => env.rand?.() as number).join(" ")} `);
      }
      const table = L.__ykAlloc(4 * TABLE.length, 16);
      TABLE.forEach((v, i) => L.__ykStore32(table + 4 * i, v));
      const cmp = L.__ykFnAddr(env.yk_cmp);
      for (const k of keys) {
        const key = L.__ykAlloc(4, 4);
        L.__ykStore32(key, k);
        const p = env.bsearch?.(key, table, BigInt(TABLE.length), 4n, cmp) as number;
        out.push(String(p === 0 ? -1 : (p - table) / 4));
      }
      return out;
    };

    for (const lowered of [false, true]) {
      it(`each case equals musl compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
        const seed = lowered ? 1365 : 13650;
        const ts = times(seed);
        const seeds = [0, 1, 42, 4294967295];
        const keys = [
          ...TABLE,
          -91,
          5,
          100000,
          ...fc.sample(fc.integer({ min: -100, max: 5000 }), { numRuns: 10, seed }),
        ];
        const want = native(ts, seeds, keys);
        const got = shaved(lowered, ts, seeds, keys);
        const bad = got.flatMap((g, i) =>
          g === want[i] ? [] : [`line ${i}: shaved ${g} / C ${want[i]}`],
        );
        expect(bad.slice(0, 8)).toEqual([]);
        expect(got.length).toBe(want.length);
      }, 900_000);
    }
  },
);
