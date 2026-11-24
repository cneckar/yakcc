// SPDX-License-Identifier: Apache-2.0
// SQLite's record helpers, shaved (#1363's acceptance; #1368's C part): the varint codec, a
// record value's decoding into a Mem (sqlite3VdbeSerialGet), and text to number (sqlite3Atoi64,
// sqlite3GetInt32, sqlite3AtoF), from the SQLite yakcc runs on: the amalgamation better-sqlite3
// bundles (3.53.0). The oracle is the same amalgamation compiled natively by clang, with the same
// defines, on generated inputs; compared byte for byte, as raised and as lifted and lowered.
// What SQLite calls from the C library is musl's, shaved too.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, type CMemory as Mem, hex, link } from "./__fixtures__/c-link.js";
import { C_LEAVES_JS, createCMemory, recordLayouts, shaveCUnit } from "./raise-c.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// The SQLite yakcc runs on, pinned by the lockfile through @yakcc/registry's better-sqlite3.
const SQLITE = (() => {
  try {
    const req = createRequire(join(repo, "packages/registry/package.json"));
    return join(dirname(req.resolve("better-sqlite3/package.json")), "deps/sqlite3/sqlite3.c");
  } catch {
    return undefined;
  }
})();
// SQLITE_DISABLE_INTRINSIC: SQLite's own portable C, not compiler intrinsics (__int128,
// __builtin_clzll); the native oracle is built with the same defines, so both run the same C.
const ARGS = [
  "-std=c11",
  "-DSQLITE_THREADSAFE=0",
  "-DSQLITE_OMIT_LOAD_EXTENSION",
  "-DSQLITE_DISABLE_INTRINSIC",
];
// The C library SQLite calls (memcpy, ...): musl's, shaved, as raise-c-memory.test.ts does.
const MUSL = fileURLToPath(new URL("../vendor/musl/", import.meta.url));
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
    return SQLITE !== undefined;
  } catch {
    return false;
  }
})();

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-sqlite-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const utf8 = (s: string): number[] => [...Buffer.from(s, "utf8")];

const ROOTS = [
  "sqlite3PutVarint",
  "sqlite3GetVarint",
  "sqlite3GetVarint32",
  "sqlite3VarintLen",
  "sqlite3VdbeSerialTypeLen",
  "sqlite3VdbeSerialGet",
  "sqlite3Atoi64",
  "sqlite3GetInt32",
  "sqlite3AtoF",
];

describe.skipIf(!hasClang)("SQLite's record helpers, shaved from the amalgamation", () => {
  const file = SQLITE as string;
  const unit = shaveCUnit(file, ROOTS, ARGS, "clang");
  const libc = ["memcpy", "memset", "strlen", "strcmp"].map((f) =>
    shaveCUnit(`${MUSL}src/string/${f}.c`, [f], MUSL_ARGS, "clang"),
  );
  const atoms = new Map([...unit.atoms, ...libc.flatMap((u) => [...u.atoms])]);

  it("every root, and every function it calls, shaves with no refusal", () => {
    expect([...unit.refused, ...libc.flatMap((u) => [...u.refused])]).toEqual([]);
    expect([...unit.atoms.keys()]).toEqual(
      expect.arrayContaining([...ROOTS, "putVarint64", "serialGet"]),
    );
    // What SQLite calls and does not define is the C library's: linked to musl's atoms.
    const externals = new Set([...unit.atoms.values()].flatMap((a) => a.externals));
    for (const x of externals) expect(atoms.has(x), x).toBe(true);
  });

  // Mem's layout, as clang lays it out for this build.
  const mem = recordLayouts(
    execFileSync("clang", [...ARGS, "-fsyntax-only", "-Xclang", "-fdump-record-layouts", file], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
    }),
  ).get("struct sqlite3_value");

  const exe = join(work, "sqlite-helpers");
  const build = (): void => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include "${file}"
#include <stdio.h>
static char h[1 << 14];
static unsigned char b[1 << 13];
static int fill(void) { int n = 0; for (; h[2 * n]; n++) { unsigned v; sscanf(h + 2 * n, "%2x", &v); b[n] = (unsigned char)v; } b[n] = 0; return n; }
int main(void) {
  char op[32];
  while (scanf("%31s", op) == 1) {
    if (!strcmp(op, "put")) { unsigned long long v; scanf("%llx", &v); unsigned char o[16] = {0}; int n = sqlite3PutVarint(o, v); printf("%d ", n); for (int i = 0; i < 16; i++) printf("%02x", o[i]); printf("\\n"); }
    else if (!strcmp(op, "get")) { scanf("%s", h); fill(); u64 v = 0; int n = sqlite3GetVarint(b, &v); printf("%d %llx\\n", n, (unsigned long long)v); }
    else if (!strcmp(op, "get32")) { scanf("%s", h); fill(); u32 v = 0; int n = sqlite3GetVarint32(b, &v); printf("%d %x\\n", n, v); }
    else if (!strcmp(op, "len")) { unsigned long long v; scanf("%llx", &v); printf("%d\\n", sqlite3VarintLen(v)); }
    else if (!strcmp(op, "tlen")) { unsigned t; scanf("%u", &t); printf("%u\\n", sqlite3VdbeSerialTypeLen(t)); }
    else if (!strcmp(op, "serial")) { unsigned t; scanf("%u %s", &t, h); fill(); Mem m; memset(&m, 0, sizeof m);
      sqlite3VdbeSerialGet(b, t, &m); unsigned long long u; memcpy(&u, &m.u, 8);
      printf("%x %d %llx %ld\\n", m.flags, m.n, u, m.z ? (long)((unsigned char *)m.z - b) : -1L); }
    else if (!strcmp(op, "atoi")) { int len; scanf("%d %s", &len, h); fill(); i64 v = 0; int rc = sqlite3Atoi64((char *)b, &v, len, SQLITE_UTF8); printf("%d %llx\\n", rc, (unsigned long long)v); }
    else if (!strcmp(op, "int32")) { scanf("%s", h); fill(); int v = 0; int rc = sqlite3GetInt32((char *)b, &v); printf("%d %d\\n", rc, v); }
    else if (!strcmp(op, "atof")) { scanf("%s", h); fill(); double v = 0; int rc = sqlite3AtoF((char *)b, &v); unsigned long long u; memcpy(&u, &v, 8); printf("%d %llx\\n", rc, u); }
  }
  return 0;
}
`,
    );
    execFileSync(
      "clang",
      [...ARGS, "-O0", "-fwrapv", "-ffp-contract=off", driver, "-o", exe, "-lm"],
      {
        stdio: "ignore",
      },
    );
  };

  type Case = [string, (env: Record<string, Fn>, m: Mem) => string];
  const cases = (seed: number): Case[] => {
    const out: Case[] = [];
    const u64s = [
      0n,
      1n,
      127n,
      128n,
      240n,
      2287n,
      2288n,
      67823n,
      67824n,
      (1n << 24n) - 1n,
      1n << 24n,
      (1n << 56n) - 1n,
      1n << 56n,
      2n ** 64n - 1n,
      ...fc.sample(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { numRuns: 120, seed }),
      ...fc.sample(fc.bigInt({ min: 0n, max: 2n ** 21n }), { numRuns: 60, seed: seed + 1 }),
    ];
    for (const v of u64s) {
      out.push([
        `put ${v.toString(16)}`,
        (env, m) => {
          const p = m.put(Array(16).fill(0));
          const n = env.sqlite3PutVarint?.(p, v) as number;
          return `${n} ${hex(m.get(p, 16))}`;
        },
      ]);
      out.push([`len ${v.toString(16)}`, (env) => String(env.sqlite3VarintLen?.(v))]);
    }
    // Varints to decode: encodings of the values above, and arbitrary bytes.
    const blobs = [
      ...fc.sample(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 9, maxLength: 12 }), {
        numRuns: 150,
        seed: seed + 2,
      }),
      ...fc.sample(fc.array(fc.integer({ min: 128, max: 255 }), { minLength: 9, maxLength: 12 }), {
        numRuns: 40,
        seed: seed + 3,
      }),
    ];
    for (const bytes of blobs) {
      out.push([
        `get ${hex(bytes)}`,
        (env, m) => {
          const p = m.put(bytes);
          const pv = m.put(Array(8).fill(0));
          const n = env.sqlite3GetVarint?.(p, pv) as number;
          return `${n} ${(m.leaves.__ykLoad64(pv) as bigint).toString(16)}`;
        },
      ]);
      out.push([
        `get32 ${hex(bytes)}`,
        (env, m) => {
          const p = m.put(bytes);
          const pv = m.put(Array(8).fill(0));
          const n = env.sqlite3GetVarint32?.(p, pv) as number;
          return `${n} ${m.leaves.__ykLoad32(pv).toString(16)}`;
        },
      ]);
    }
    // Record values: every serial type of a number, and blobs and texts.
    const types = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ...Array.from({ length: 30 }, (_, i) => 12 + i)];
    for (const t of types) {
      out.push([`tlen ${t}`, (env) => String(env.sqlite3VdbeSerialTypeLen?.(t))]);
      for (const bytes of fc.sample(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 16, maxLength: 16 }),
        { numRuns: 6, seed: seed + 100 + t },
      )) {
        out.push([
          `serial ${t} ${hex(bytes)}`,
          (env, m) => {
            const p = m.put(bytes);
            const l = mem as NonNullable<typeof mem>;
            const pm = m.put(Array(l.size).fill(0));
            env.sqlite3VdbeSerialGet?.(p, t, pm);
            const f = (name: string) => (l.fields.get(name) as { offset: number }).offset;
            const flags = m.leaves.__ykLoad16(pm + f("flags"));
            const n = m.leaves.__ykLoad32(pm + f("n")) | 0;
            const u = m.leaves.__ykLoad64(pm + f("u")) as bigint;
            const z = Number(m.leaves.__ykLoad64(pm + f("z")) as bigint);
            return `${flags.toString(16)} ${n} ${u.toString(16)} ${z === 0 ? -1 : z - p}`;
          },
        ]);
      }
    }
    // Text to numbers.
    const texts = [
      "",
      "0",
      "-0",
      "+5",
      "  12",
      "12  ",
      "12abc",
      "9223372036854775807",
      "9223372036854775808",
      "-9223372036854775808",
      "-9223372036854775809",
      "18446744073709551616",
      "00000000000000000000001",
      "2147483647",
      "2147483648",
      "-2147483648",
      "-2147483649",
      "0x1A",
      "1e10",
      "1.5e-300",
      "1e-400",
      "1e999",
      ".5",
      "5.",
      "-.5e+3",
      "3.14159265358979323846",
      "123456789012345678901234567890",
      "0.1",
      "1e308",
      "2.2250738585072014e-308",
      "4.9e-324",
      "  -1.25E2  ",
      "nan",
      "inf",
      "1e",
      "1e+",
      ...fc.sample(fc.integer({ min: -2147483648, max: 2147483647 }).map(String), {
        numRuns: 40,
        seed: seed + 4,
      }),
      ...fc.sample(fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }).map(String), {
        numRuns: 40,
        seed: seed + 5,
      }),
      ...fc.sample(
        fc.double({ noNaN: true }).map((x) => String(x)),
        { numRuns: 80, seed: seed + 6 },
      ),
      ...fc.sample(
        fc
          .tuple(
            fc.integer({ min: 0, max: 99999 }),
            fc.integer({ min: 0, max: 9999 }),
            fc.integer({ min: -320, max: 320 }),
          )
          .map(([a, b, e]) => `${a}.${b}e${e}`),
        { numRuns: 60, seed: seed + 7 },
      ),
    ];
    for (const text of texts) {
      const bytes = utf8(text);
      out.push([
        `atoi ${bytes.length} ${hex(bytes)}`,
        (env, m) => {
          const p = m.put([...bytes, 0]);
          const pv = m.put(Array(8).fill(0));
          const rc = env.sqlite3Atoi64?.(p, pv, bytes.length, 1) as number;
          return `${rc} ${(m.leaves.__ykLoad64(pv) as bigint).toString(16)}`;
        },
      ]);
      out.push([
        `int32 ${hex(bytes)}`,
        (env, m) => {
          const p = m.put([...bytes, 0]);
          const pv = m.put(Array(8).fill(0));
          const rc = env.sqlite3GetInt32?.(p, pv) as number;
          return `${rc} ${m.leaves.__ykLoad32(pv) | 0}`;
        },
      ]);
      out.push([
        `atof ${hex(bytes)}`,
        (env, m) => {
          const p = m.put([...bytes, 0]);
          const pv = m.put(Array(8).fill(0));
          const rc = env.sqlite3AtoF?.(p, pv) as number;
          return `${rc} ${(m.leaves.__ykLoad64(pv) as bigint).toString(16)}`;
        },
      ]);
    }
    // An empty hex field would end the driver's scanf: give empty texts a NUL byte to read.
    return out.map(([line, run]) => [line.replace(/ $/, " 00"), run]);
  };

  for (const lowered of [false, true]) {
    it(`each helper equals the native C, byte for byte (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      if (!lowered) build();
      const cs = cases(lowered ? 1368 : 13680);
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
            `${line.slice(0, 60)}: shaved ${got.slice(0, 60)}, C ${native[i]?.slice(0, 60)}`,
          );
      });
      expect(bad.slice(0, 8)).toEqual([]);
    }, 900_000);
  }
});
