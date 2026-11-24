// SPDX-License-Identifier: Apache-2.0
// C's memory (#1363, DEC-DUC-OPERATIONS-AS-ATOMS-001): pointers, &, *, [], ->, structs, arrays and
// unions by clang's layout, string literals, and function pointers, raised through the memory
// leaves. The oracle is the same C compiled natively by clang: musl 1.2.5's memcpy, memset,
// strlen, strcmp and qsort, and a fixture of the rest, on generated inputs, compared byte for
// byte (whole buffers and return values), as raised and as lifted to a graph and lowered back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, type CMemory as Mem, hex, link } from "./__fixtures__/c-link.js";
import { CMemoryTrap, C_LEAVES_JS, createCMemory, recordLayouts, shaveCUnit } from "./raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const MUSL = here("../vendor/musl/");
const FIXTURE = here("./__fixtures__/c/memory.c");
// musl's own include order, as its Makefile (and an empty atomic_arch.h: its portable C).
const MUSL_ARGS = [
  "-std=c99",
  "-nostdinc",
  "-ffreestanding",
  "-D_XOPEN_SOURCE=700",
  `-I${MUSL}yakcc`,
  `-I${MUSL}arch/x86_64`,
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

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-memory-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const unhex = (s: string): number[] => (s.match(/../g) ?? []).map((x) => Number.parseInt(x, 16));

const FIXTURE_FNS = [
  "yk_struct_walk",
  "yk_local_struct",
  "yk_string_sum",
  "yk_local_array",
  "yk_ptr_diff",
  "yk_swap",
  "yk_char_array",
  "yk_goto",
  "yk_state",
  "yk_varargs",
  "yk_bits",
  "yk_cmp_int",
  "yk_cmp_bytes",
];

describe.skipIf(!hasClang)("C's memory: musl's string functions and qsort, and a fixture", () => {
  const units = [
    shaveCUnit(`${MUSL}src/string/memcpy.c`, ["memcpy"], MUSL_ARGS, "clang"),
    shaveCUnit(`${MUSL}src/string/memset.c`, ["memset"], MUSL_ARGS, "clang"),
    shaveCUnit(`${MUSL}src/string/strlen.c`, ["strlen"], MUSL_ARGS, "clang"),
    shaveCUnit(`${MUSL}src/string/strcmp.c`, ["strcmp"], MUSL_ARGS, "clang"),
    shaveCUnit(`${MUSL}src/stdlib/qsort.c`, ["__qsort_r"], MUSL_ARGS, "clang"),
    shaveCUnit(`${MUSL}src/stdlib/qsort_nr.c`, ["qsort"], MUSL_ARGS, "clang"),
    shaveCUnit(FIXTURE, FIXTURE_FNS, ["-std=c11"], "clang"),
  ];
  const atoms = new Map(units.flatMap((u) => [...u.atoms]));

  it("every function, and every function it calls, shaves with no refusal", () => {
    expect(units.flatMap((u) => [...u.refused])).toEqual([]);
    expect([...atoms.keys()]).toEqual(
      expect.arrayContaining([
        "memcpy",
        "memset",
        "strlen",
        "strcmp",
        "__qsort_r",
        "qsort",
        "sift",
        "trinkle",
        "cycle",
        "pntz",
        "a_ctz_64",
        "wrapper_cmp",
        ...FIXTURE_FNS,
      ]),
    );
    // qsort's cycle calls memcpy: an external reference, linked to memcpy's atom.
    expect(atoms.get("cycle") && units[4]?.atoms.get("cycle")?.externals).toEqual(["memcpy"]);
    expect(units[5]?.atoms.get("qsort")?.externals).toEqual(["__qsort_r"]);
  });

  it("clang's record layouts are read: sizes, alignments and field offsets", () => {
    const l = recordLayouts(
      execFileSync(
        "clang",
        ["-std=c11", "-fsyntax-only", "-Xclang", "-fdump-record-layouts-complete", FIXTURE],
        {
          encoding: "utf8",
        },
      ),
    ).get("struct pt");
    expect(l?.size).toBe(48);
    expect(l?.align).toBe(8);
    expect(Object.fromEntries([...(l?.fields ?? [])].map(([k, f]) => [k, f.offset]))).toEqual({
      tag: 0,
      x: 8,
      v: 16,
      u: 28,
      next: 32,
      s: 40,
    });
  });

  it("the memory leaves trap outside a live region and on a write to constant data", () => {
    const m = createCMemory();
    const a = m.leaves.__ykAlloc(10, 8);
    expect(m.leaves.__ykStore32(a + 12, 7)).toBe(7); // inside the 16-byte rounding
    expect(() => m.leaves.__ykLoad8(a + 16)).toThrow(CMemoryTrap);
    expect(() => m.leaves.__ykLoad8(0)).toThrow(CMemoryTrap);
    m.leaves.__ykFree(a);
    expect(() => m.leaves.__ykLoad8(a)).toThrow(CMemoryTrap);
    const d = m.leaves.__ykData("u8", [104, 105, 0]);
    expect(m.leaves.__ykData("u8", [104, 105, 0])).toBe(d);
    expect(m.leaves.__ykLoad16(d)).toBe(0x6968);
    expect(() => m.leaves.__ykStore8(d, 1)).toThrow(CMemoryTrap);
  });

  // The native oracle: musl's sources with musl's headers, renamed so as not to meet glibc's, the
  // fixture, and a driver that runs each case on fresh 16-aligned buffers.
  const SZ = 320;
  const exe = join(work, "memory");
  const build = (): void => {
    const rename = [
      "-Dmemcpy=musl_memcpy",
      "-Dmemset=musl_memset",
      "-Dstrlen=musl_strlen",
      "-Dstrcmp=musl_strcmp",
      "-Dqsort=musl_qsort",
    ];
    const objs: string[] = [];
    for (const f of [
      "string/memcpy",
      "string/memset",
      "string/strlen",
      "string/strcmp",
      "stdlib/qsort",
      "stdlib/qsort_nr",
    ]) {
      const o = join(work, `${f.replace("/", "_")}.o`);
      execFileSync("clang", [
        ...MUSL_ARGS,
        ...rename,
        "-O0",
        "-fno-builtin",
        "-fwrapv",
        "-c",
        `${MUSL}src/${f}.c`,
        "-o",
        o,
      ]);
      objs.push(o);
    }
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
void *musl_memcpy(void *, const void *, size_t);
void *musl_memset(void *, int, size_t);
size_t musl_strlen(const char *);
int musl_strcmp(const char *, const char *);
void __qsort_r(void *, size_t, size_t, int (*)(const void *, const void *, void *), void *);
void musl_qsort(void *, size_t, size_t, int (*)(const void *, const void *));
struct pt;
int yk_cmp_int(const void *, const void *);
int yk_cmp_bytes(const void *, const void *, void *);
double yk_struct_walk(struct pt *, int);
${["yk_local_struct", "yk_string_sum", "yk_local_array", "yk_swap", "yk_char_array"].map((n) => `int ${n}(int${n === "yk_swap" ? ", int" : ""});`).join("\n")}
long yk_ptr_diff(int);
int yk_goto(int, int);
int yk_state(int);
int yk_varargs(int, int);
int yk_bits(int, int);
static char h[1 << 16];
static unsigned char *buf(size_t n) { unsigned char *p = aligned_alloc(16, (n + 31) / 16 * 16); memset(p, 0, (n + 31) / 16 * 16); return p; }
static void fill(unsigned char *p) { for (size_t i = 0; h[2 * i]; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); p[i] = (unsigned char)v; } }
static void show(const unsigned char *p, size_t n) { for (size_t i = 0; i < n; i++) printf("%02x", p[i]); }
int main(void) {
  char op[32];
  while (scanf("%31s", op) == 1) {
    if (!strcmp(op, "memcpy")) {
      int d, s, n; unsigned char *dst = buf(${SZ}), *src = buf(${SZ});
      scanf("%d %d %d %s", &d, &s, &n, h); fill(src); scanf("%s", h); fill(dst);
      unsigned char *r = musl_memcpy(dst + d, src + s, n); show(dst, ${SZ}); printf(" %ld\\n", (long)(r - dst));
    } else if (!strcmp(op, "memset")) {
      int d, c, n; unsigned char *dst = buf(${SZ});
      scanf("%d %d %d %s", &d, &c, &n, h); fill(dst);
      unsigned char *r = musl_memset(dst + d, c, n); show(dst, ${SZ}); printf(" %ld\\n", (long)(r - dst));
    } else if (!strcmp(op, "strlen")) {
      int o; unsigned char *p = buf(${SZ}); scanf("%d %s", &o, h); fill(p);
      printf("%lu\\n", (unsigned long)musl_strlen((char *)p + o));
    } else if (!strcmp(op, "strcmp")) {
      int a, b; unsigned char *p = buf(${SZ}), *q = buf(${SZ}); scanf("%d %d %s", &a, &b, h); fill(p); scanf("%s", h); fill(q);
      printf("%d\\n", musl_strcmp((char *)p + a, (char *)q + b));
    } else if (!strcmp(op, "qsort")) {
      size_t w, n; int mode; scanf("%zu %zu %d %s", &w, &n, &mode, h); unsigned char *p = buf(w * n + 1); fill(p);
      if (mode == 0) musl_qsort(p, n, w, yk_cmp_int); else __qsort_r(p, n, w, yk_cmp_bytes, &w);
      show(p, w * n); printf("\\n");
    } else if (!strcmp(op, "walk")) {
      int n; scanf("%d", &n); unsigned char *p = buf(48 * (size_t)n + 1);
      double r = yk_struct_walk((struct pt *)p, n); unsigned long long b; memcpy(&b, &r, 8); printf("%016llx ", b);
      /* next pointers as offsets from the array, so both memories print the same bytes */
      for (int i = 0; i < n; i++) { uint64_t v; memcpy(&v, p + 48 * i + 32, 8); if (v) v -= (uint64_t)(uintptr_t)p; memcpy(p + 48 * i + 32, &v, 8); }
      show(p, 48 * (size_t)n); printf("\\n");
    } else {
      int a, b; scanf("%d %d", &a, &b); long r = 0;
      if (!strcmp(op, "yk_local_struct")) r = yk_local_struct(a);
      if (!strcmp(op, "yk_string_sum")) r = yk_string_sum(a);
      if (!strcmp(op, "yk_local_array")) r = yk_local_array(a);
      if (!strcmp(op, "yk_ptr_diff")) r = yk_ptr_diff(a);
      if (!strcmp(op, "yk_swap")) r = yk_swap(a, b);
      if (!strcmp(op, "yk_char_array")) r = yk_char_array(a);
      if (!strcmp(op, "yk_goto")) r = yk_goto(a, b);
      if (!strcmp(op, "yk_state")) r = yk_state(a);
      if (!strcmp(op, "yk_varargs")) r = yk_varargs(a, b);
      if (!strcmp(op, "yk_bits")) r = yk_bits(a, b);
      printf("%ld\\n", r);
    }
  }
  return 0;
}
`,
    );
    execFileSync("clang", ["-std=c11", "-O0", "-fwrapv", FIXTURE, driver, ...objs, "-o", exe]);
  };

  /** The cases: [the driver's line, a function that runs it on the atoms and prints the same]. */
  const cases = (seed: number): [string, (env: Record<string, Fn>, m: Mem) => string][] => {
    const out: [string, (env: Record<string, Fn>, m: Mem) => string][] = [];
    const bytes = (n: number, s: number, nonzero = false): number[] =>
      fc.sample(fc.integer({ min: nonzero ? 1 : 0, max: 255 }), { numRuns: n, seed: s });
    const ints = (n: number, s: number, min: number, max: number): number[] =>
      fc.sample(fc.integer({ min, max }), { numRuns: n, seed: s });
    // memcpy and memset: every alignment of each end, lengths across the word loops' edges.
    const offs = ints(400, seed, 0, 15);
    const lens = ints(400, seed + 1, 0, 260);
    for (let i = 0; i < 200; i++) {
      const d = offs[i] as number;
      const s = offs[i + 200] as number;
      const n = Math.min(lens[i] as number, SZ - 16);
      const src = bytes(SZ, seed + 10 + i);
      const dst = bytes(SZ, seed + 1000 + i);
      out.push([
        `memcpy ${d} ${s} ${n} ${hex(src)} ${hex(dst)}`,
        (env, m) => {
          const ps = m.put(src);
          const pd = m.put(dst);
          const r = env.memcpy?.(pd + d, ps + s, BigInt(n)) as number;
          return `${hex(m.get(pd, SZ))} ${r - pd}`;
        },
      ]);
      const c = (ints(1, seed + 2000 + i, -1000, 1000)[0] as number) * 7;
      out.push([
        `memset ${d} ${c} ${n} ${hex(dst)}`,
        (env, m) => {
          const pd = m.put(dst);
          const r = env.memset?.(pd + d, c, BigInt(n)) as number;
          return `${hex(m.get(pd, SZ))} ${r - pd}`;
        },
      ]);
    }
    // strlen and strcmp: strings at every alignment, with high bytes; strcmp's pairs share a prefix.
    for (let i = 0; i < 200; i++) {
      const o = offs[i] as number;
      const len = (lens[i] as number) % 200;
      const str = [...bytes(len, seed + 3000 + i, true), 0];
      const buf = [...Array(o).fill(7), ...str];
      out.push([`strlen ${o} ${hex(buf)}`, (env, m) => String(env.strlen?.(m.put(buf) + o))]);
      const cut = ints(1, seed + 4000 + i, 0, len)[0] as number;
      const other = [...str.slice(0, cut), ...bytes(len - cut, seed + 5000 + i, true), 0];
      if (i % 5 === 0) other.splice(0, other.length, ...str); // equal strings
      const o2 = offs[i + 200] as number;
      const a = [...Array(o).fill(9), ...str];
      const b = [...Array(o2).fill(9), ...other];
      out.push([
        `strcmp ${o} ${o2} ${hex(a)} ${hex(b)}`,
        (env, m) => String(env.strcmp?.(m.put(a) + o, m.put(b) + o2)),
      ]);
    }
    // qsort: ints through the comparator; widths of every size through qsort_r's argument.
    for (let i = 0; i < 80; i++) {
      const mode = i % 2;
      const w = mode === 0 ? 4 : ([1, 3, 8, 12, 17, 33][i % 6] as number);
      const n = ints(1, seed + 6000 + i, 0, 70)[0] as number;
      const data =
        mode === 0 || i % 3
          ? bytes(w * n, seed + 7000 + i)
          : bytes(w * n, seed + 7000 + i).map((x) => x & 3);
      out.push([
        `qsort ${w} ${n} ${mode} ${hex(data.length ? data : [0])}`,
        (env, m) => {
          const p = m.put(data.length ? data : [0]);
          if (mode === 0) env.qsort?.(p, BigInt(n), BigInt(w), m.leaves.__ykFnAddr(env.yk_cmp_int));
          else {
            const pw = m.put(
              Array.from({ length: 8 }, (_, k) => Number((BigInt(w) >> BigInt(8 * k)) & 255n)),
            );
            env.__qsort_r?.(p, BigInt(n), BigInt(w), m.leaves.__ykFnAddr(env.yk_cmp_bytes), pw);
          }
          return hex(m.get(p, w * n));
        },
      ]);
    }
    // The fixture.
    for (let i = 1; i < 13; i++)
      out.push([
        `walk ${i}`,
        (env, m) => {
          const p = m.put(Array(48 * i + 1).fill(0));
          const r = env.yk_struct_walk?.(p, i) as number;
          const v = new DataView(new ArrayBuffer(8));
          v.setFloat64(0, r);
          const after = m.get(p, 48 * i);
          const view = new DataView(after.buffer);
          for (let k = 0; k < i; k++) {
            const next = view.getBigUint64(48 * k + 32, true);
            if (next !== 0n) view.setBigUint64(48 * k + 32, next - BigInt(p), true);
          }
          return `${v.getBigUint64(0).toString(16).padStart(16, "0")} ${hex(after)}`;
        },
      ]);
    const xs = [
      0,
      1,
      -1,
      2,
      3,
      255,
      256,
      1000,
      -1000,
      2147483647,
      -2147483648,
      ...ints(40, seed + 8000, -100000, 100000),
    ];
    for (const n of [
      "yk_local_struct",
      "yk_string_sum",
      "yk_local_array",
      "yk_ptr_diff",
      "yk_swap",
      "yk_char_array",
      "yk_goto",
      "yk_state",
      "yk_varargs",
      "yk_bits",
    ])
      xs.forEach((x, k) => {
        const y = xs[(k * 7 + 3) % xs.length] as number;
        out.push([`${n} ${x} ${y}`, (env) => String(env[n]?.(x, y))]);
      });
    return out;
  };

  for (const lowered of [false, true]) {
    it(`each function equals the native C, byte for byte (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      if (!lowered) build();
      const cs = cases(lowered ? 1363 : 13630);
      const native = execFileSync(exe, {
        input: `${cs.map(([line]) => line).join("\n")}\n`,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
        .trim()
        .split("\n");
      const memory = createCMemory();
      const env = link(atoms, lowered, memory, units);
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
            `${line.slice(0, 60)}: shaved ${got.slice(0, 80)}, C ${native[i]?.slice(0, 80)}`,
          );
      });
      expect(bad.slice(0, 8)).toEqual([]);
    }, 600_000);
  }
});
