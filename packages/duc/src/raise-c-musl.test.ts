// SPDX-License-Identifier: Apache-2.0
// musl's string and memory functions, shaved (#1365): each function, and everything it calls
// (another musl function is found as musl's own src/*/<name>.c and shaved too), raised through the
// memory leaves; the oracle is musl compiled natively by clang from the same sources, called on
// generated inputs (every alignment, overlapping memmove, a small alphabet so searches hit, high
// bytes and both cases), compared byte for byte, as raised and as lifted and lowered.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, type CMemory as Mem, hex, link } from "./__fixtures__/c-link.js";
import { C_LEAVES_JS, createCMemory, shaveCUnit } from "./raise-c.js";

const MUSL = fileURLToPath(new URL("../vendor/musl/", import.meta.url));
const MUSL_ARGS = [
  "-std=c99",
  "-nostdinc",
  "-ffreestanding",
  "-D_XOPEN_SOURCE=700",
  "-D_GNU_SOURCE",
  `-I${MUSL}yakcc`,
  `-I${MUSL}arch/x86_64`,
  `-I${MUSL}arch/generic`,
  `-I${MUSL}src/include`,
  `-I${MUSL}src/internal`,
  `-I${MUSL}obj/include`,
  `-I${MUSL}include`,
];

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-musl-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A musl function's source file: `src/<dir>/<name>.c`. */
function sourceOf(name: string): string | undefined {
  for (const dir of readdirSync(`${MUSL}src`)) {
    const f = `${MUSL}src/${dir}/${name}.c`;
    if (existsSync(f)) return f;
  }
  return undefined;
}

/**
 * The functions under test, by the shape of their call. A shape's driver line and its run on the
 * atoms print the same text: the result (a pointer as an offset from its first argument, or -1)
 * and the bytes of any buffer written.
 */
const SHAPES: Record<string, readonly string[]> = {
  copy: ["strcpy", "stpcpy", "strcat"], // (dst, src) -> ptr
  copyN: ["strncpy", "stpncpy", "strncat"], // (dst, src, n) -> ptr
  sizeN: ["strlcpy", "strlcat"], // (dst, src, n) -> size_t
  cmp: ["strcasecmp", "strspn", "strcspn", "strverscmp"], // (a, b) -> int/size_t
  cmpN: ["strncmp", "strncasecmp", "memcmp", "bcmp"], // (a, b, n) -> int
  chr: ["strchr", "strrchr", "strchrnul"], // (s, c) -> ptr
  chrN: ["memchr", "memrchr"], // (s, c, n) -> ptr
  find: ["strstr", "strpbrk", "strcasestr"], // (h, n) -> ptr
  len: ["strnlen"], // (s, n) -> size_t
  move: ["memmove", "memccpy"], // within one buffer / (dst, src, c, n)
  mem: ["memmem"], // (h, hl, n, nl) -> ptr
};
const FUNCTIONS = Object.values(SHAPES).flat();

describe.skipIf(!hasClang)("musl's string and memory functions, shaved", () => {
  // Each function's unit, then every external it references that musl defines, to a fixpoint.
  const atoms = new Map<string, { source: string; externals: readonly string[] }>();
  const refused: [string, string][] = [];
  const files = new Map<string, string>(); // name -> source file
  const todo = [...FUNCTIONS];
  while (todo.length > 0) {
    const name = todo.pop() as string;
    if (atoms.has(name) || files.has(name)) continue;
    const file = sourceOf(name);
    if (file === undefined) continue;
    files.set(name, file);
    // musl defines some functions under an implementation name and aliases them
    // (`weak_alias(__stpcpy, stpcpy)`): the atom is the implementation's, by both names.
    const alias = new RegExp(`weak_alias\\((\\w+),\\s*${name}\\)`).exec(
      readFileSync(file, "utf8"),
    )?.[1];
    const unit = shaveCUnit(file, [alias ?? name], MUSL_ARGS, "clang");
    refused.push(...unit.refused);
    for (const [k, a] of unit.atoms) {
      atoms.set(k, a);
      for (const x of a.externals) if (!atoms.has(x)) todo.push(x);
    }
    if (alias !== undefined && unit.atoms.has(alias))
      atoms.set(name, unit.atoms.get(alias) as never);
  }

  it("every function, and everything it calls, shaves with no refusal; every external is musl's", () => {
    expect(refused).toEqual([]);
    for (const f of FUNCTIONS) expect(atoms.has(f), f).toBe(true);
    const missing = [...atoms.values()].flatMap((a) => a.externals).filter((x) => !atoms.has(x));
    expect([...new Set(missing)]).toEqual([]);
  });

  const SZ = 160;
  const exe = join(work, "string");
  const build = (): void => {
    // musl's objects under their own names: linked into the executable, they are the definitions
    // the driver calls (glibc's shared library defines them too, and loses; its own internal
    // calls do not go through these names).
    const objs = [...new Set(files.values())].map((f, i) => {
      const o = join(work, `m${i}.o`);
      execFileSync("clang", [...MUSL_ARGS, "-O0", "-fno-builtin", "-fwrapv", "-c", f, "-o", o]);
      return o;
    });
    const call = (shape: string, f: string): string => {
      const m = f;
      switch (shape) {
        case "copy":
          return `r = (unsigned char *)${m}((char *)a + x, (char *)b + y); off(a);`;
        case "copyN":
          return `r = (unsigned char *)${m}((char *)a + x, (char *)b + y, n); off(a);`;
        case "sizeN":
          return `v = (long)${m}((char *)a + x, (char *)b + y, n);`;
        case "cmp":
          return `v = ${f === "strspn" || f === "strcspn" ? "(long)" : "(long)(int)"}${m}((char *)a + x, (char *)b + y);`;
        case "cmpN":
          return `v = ${m}(a + x, b + y, n);`;
        case "chr":
          return `r = (unsigned char *)${m}((char *)a + x, c); off(a);`;
        case "chrN":
          return `r = ${m}(a + x, c, n); off(a);`;
        case "find":
          return `r = (unsigned char *)${m}((char *)a + x, (char *)b + y); off(a);`;
        case "len":
          return `v = (long)${m}((char *)a + x, n);`;
        case "mem":
          return `r = ${m}(a + x, n, b + y, (size_t)c); off(a);`;
        default:
          throw new Error(shape);
      }
    };
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
size_t strlcpy(char *, const char *, size_t);
size_t strlcat(char *, const char *, size_t);
static char h[1 << 12];
static unsigned char *buf(void) { unsigned char *p = aligned_alloc(16, ${SZ}); memset(p, 0, ${SZ}); return p; }
static void fill(unsigned char *p) { for (size_t i = 0; h[2 * i]; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); p[i] = (unsigned char)v; } }
int main(void) {
  char op[32];
  while (scanf("%31s", op) == 1) {
    int x, y, c; size_t n; scanf("%d %d %d %zu", &x, &y, &c, &n);
    unsigned char *a = buf(), *b = buf(); scanf("%s", h); fill(a); scanf("%s", h); fill(b);
    unsigned char *r = 0; long v = 0; long ro = -2;
#define off(base) (ro = r ? (long)(r - (base)) : -1L)
${Object.entries(SHAPES)
  .filter(([s]) => s !== "move")
  .flatMap(([s, fs]) => fs.map((f) => `    if (!strcmp(op, "${f}")) { ${call(s, f)} }`))
  .join("\n")}
    if (!strcmp(op, "memmove")) { r = memmove(a + x, a + y, n); off(a); }
    if (!strcmp(op, "memccpy")) { r = memccpy(a + x, b + y, c, n); off(a); }
    printf("%ld %ld ", ro, v);
    for (int i = 0; i < ${SZ}; i++) printf("%02x", a[i]);
    printf("\\n");
  }
  return 0;
}
`,
    );
    execFileSync("clang", ["-std=c11", "-O0", "-fwrapv", driver, ...objs, "-o", exe]);
  };

  type Case = [string, (env: Record<string, Fn>, m: Mem) => string];
  const cases = (seed: number): Case[] => {
    const out: Case[] = [];
    // A small alphabet (so searches and spans hit), its other case, and high bytes.
    const alphabet = [0x61, 0x62, 0x63, 0x41, 0x42, 0x43, 0x2e, 0x31, 0x32, 0xe9, 0xff];
    const str = (s: number, max: number): number[] =>
      fc.sample(fc.array(fc.constantFrom(...alphabet), { maxLength: max }), {
        numRuns: 1,
        seed: s,
      })[0] as number[];
    let k = 0;
    for (const [shape, fs] of Object.entries(SHAPES))
      for (const f of fs)
        for (let i = 0; i < 40; i++) {
          const s = seed + 1000 * k++ + i;
          const x = i % 16;
          const y = (i * 7) % 16;
          const sa = str(s, shape === "copy" || shape === "copyN" ? 40 : 90);
          // The needle is often a piece of the haystack.
          const sb =
            (shape === "find" || shape === "mem" || shape === "cmp" || shape === "cmpN") &&
            i % 2 === 0
              ? sa.slice(i % 5, (i % 5) + 1 + (i % 7))
              : str(s + 7, 40);
          const a = [...Array(x).fill(0x2d), ...sa, 0];
          const b = [...Array(y).fill(0x2d), ...sb, 0];
          const c =
            shape === "mem"
              ? sb.length
              : (alphabet[i % alphabet.length] as number) + (i % 3 === 0 ? 256 : 0);
          const n = shape === "move" ? (i * 5) % 70 : (i * 3) % 50;
          const line = `${f} ${x} ${y} ${c} ${n} ${hex(a)} ${hex(b)}`;
          out.push([
            line,
            (env, m) => {
              const pa = m.put([...a, ...Array(SZ - a.length).fill(0)]);
              const pb = m.put([...b, ...Array(SZ - b.length).fill(0)]);
              const fn = env[f] as Fn;
              const big = BigInt(n);
              let r: number | undefined;
              let v = 0n;
              switch (shape) {
                case "copy":
                case "chr":
                case "find":
                  r = fn(pa + x, shape === "chr" ? c : pb + y) as number;
                  break;
                case "copyN":
                  r = fn(pa + x, pb + y, big) as number;
                  break;
                case "sizeN":
                case "len":
                  v = BigInt.asIntN(
                    64,
                    (shape === "len" ? fn(pa + x, big) : fn(pa + x, pb + y, big)) as bigint,
                  );
                  break;
                case "cmp": {
                  const res = fn(pa + x, pb + y);
                  v = typeof res === "bigint" ? BigInt.asIntN(64, res) : BigInt(res as number);
                  break;
                }
                case "cmpN":
                  v = BigInt(fn(pa + x, pb + y, big) as number);
                  break;
                case "chrN":
                  r = fn(pa + x, c, big) as number;
                  break;
                case "mem":
                  r = fn(pa + x, big, pb + y, BigInt(c)) as number;
                  break;
                case "move":
                  r = (
                    f === "memmove" ? fn(pa + x, pa + y, big) : fn(pa + x, pb + y, c, big)
                  ) as number;
                  break;
              }
              const ro = r === undefined ? -2 : r === 0 ? -1 : r - pa;
              return `${ro} ${v} ${hex(m.get(pa, SZ))}`;
            },
          ]);
        }
    return out;
  };

  for (const lowered of [false, true]) {
    it(`each function equals musl compiled natively, byte for byte (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      if (!lowered) build();
      const cs = cases(lowered ? 1365 : 13650);
      const native = execFileSync(exe, {
        input: `${cs.map(([line]) => line).join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
        .trim()
        .split("\n");
      const memory = createCMemory();
      const env = link(atoms, lowered, memory);
      const bad: string[] = [];
      cs.forEach(([line, run], i) => {
        let got: string;
        try {
          got = run(env, memory);
        } catch (e) {
          got = `threw ${e instanceof Error ? e.message : String(e)}`;
        }
        if (got !== native[i])
          bad.push(
            `${line.slice(0, 50)}: shaved ${got.slice(0, 50)}, C ${native[i]?.slice(0, 50)}`,
          );
      });
      expect(bad.slice(0, 8)).toEqual([]);
    }, 900_000);
  }
});
