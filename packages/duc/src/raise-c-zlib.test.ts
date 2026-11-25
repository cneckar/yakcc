// SPDX-License-Identifier: Apache-2.0
// zlib (#1367: Node's zlib binding is zlib's deflate and inflate), shaved from its C sources
// (vendor/zlib, each file a unit) over musl shaved to the leaves. Deflate at every level and
// strategy, in zlib, raw and gzip framing, gives the same bytes as the same sources compiled
// natively; inflate of each gives the input back, and of corrupt streams the same error; the
// checksums are the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { shaveCFiles } from "./__fixtures__/c-files.js";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ZLIB = fileURLToPath(new URL("../vendor/zlib/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/zlib-run.c", import.meta.url));
const ARGS = ["-std=c11", `-I${ZLIB}`];
const FILES = [
  "adler32.c",
  "compress.c",
  "crc32.c",
  "deflate.c",
  "inffast.c",
  "inflate.c",
  "inftrees.c",
  "trees.c",
  "uncompr.c",
  "zutil.c",
].map((f) => join(ZLIB, f));
const ROOTS = ["yk_deflate", "yk_inflate", "yk_adler32", "yk_crc32"];

/** One case: input bytes, a level (-1 default, 0..9), a strategy (0..4), window bits. */
type Case = { bytes: number[]; level: number; strategy: number; bits: number };

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-zlib-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("zlib's deflate and inflate, shaved from C", () => {
  const fixture = shaveCUnit(FIXTURE, ROOTS, ARGS, "clang", "zlib-run.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const zlib = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...zlib.externals])].filter((x) => !fixture.atoms.has(x));
  const musl = withMuslInit(shaveMusl(libc));

  it("zlib shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(zlib.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const cases = (seed: number): Case[] =>
    fc.sample(
      fc.record({
        bytes: fc.oneof(
          fc.uint8Array({ maxLength: 600 }).map((b) => [...b]),
          // Compressible: repeated words, runs.
          fc
            .array(fc.constantFrom("the ", "quick ", "brown ", "fox ", "aaaaaaaa", "\n", "zlib "), {
              maxLength: 300,
            })
            .map((w) => [...Buffer.from(w.join(""), "utf8")]),
          fc
            .tuple(fc.integer({ min: 0, max: 255 }), fc.nat(3000))
            .map(([v, n]) => Array(n).fill(v)),
        ),
        level: fc.integer({ min: -1, max: 9 }),
        strategy: fc.integer({ min: 0, max: 4 }),
        bits: fc.constantFrom(15, -15, 31, 9, -9),
      }),
      { numRuns: 60, seed },
    );

  const native = (all: readonly Case[]): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <string.h>
int yk_deflate(const unsigned char *, int, unsigned char *, int, int, int, int);
int yk_inflate(const unsigned char *, int, unsigned char *, int, int);
unsigned long yk_adler32(const unsigned char *, int);
unsigned long yk_crc32(const unsigned char *, int);
static unsigned char in[1 << 16], z[1 << 17], back[1 << 17];
static char line[1 << 18];
int main(void) {
  int level, strategy, bits;
  while (fgets(line, sizeof line, stdin)) {
    char *h = line; int n = 0; unsigned v;
    sscanf(h, "%d %d %d", &level, &strategy, &bits);
    h = strrchr(line, ' ') + 2; /* past the space and the x */
    for (; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (unsigned char)v; }
    int zn = yk_deflate(in, n, z, sizeof z, level, strategy, bits);
    printf("%d:", zn);
    for (int i = 0; i < zn; i++) printf("%02x", z[i]);
    int bn = zn > 0 ? yk_inflate(z, zn, back, sizeof back, bits) : 0;
    printf(" %d %d", bn, bn == n && memcmp(back, in, n) == 0);
    if (zn > 4) { z[zn / 2] ^= 0x5a; printf(" %d", yk_inflate(z, zn, back, sizeof back, bits)); }
    printf(" %lu %lu\\n", yk_adler32(in, n), yk_crc32(in, n));
  }
  return 0;
}
`,
    );
    const exe = join(work, "zlib");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-o", exe]);
    const input = all.map((c) => `${c.level} ${c.strategy} ${c.bits} x${hex(c.bytes)}`).join("\n");
    return execFileSync(exe, { input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  it("each case's stream, round trip, corrupt-stream error and checksums equal native (as raised)", () => {
    const all = cases(1367);
    const want = native(all);
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...zlib.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...zlib.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const z = L.__ykAlloc(1 << 17, 16);
    const back = L.__ykAlloc(1 << 17, 16);
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    const got = all.map((c) => {
      try {
        return one(c);
      } catch (e) {
        return `trap: ${(e as Error).message} ${
          (e as { nearest?: string }).nearest
            ?.split("\n")
            .filter((l) => / as |nearest/.test(l))
            .slice(0, 6)
            .join(" ; ") ?? ""
        }`;
      }
    });
    function one(c: Case): string {
      const p = memory.put(c.bytes.length > 0 ? c.bytes : [0]);
      const n = c.bytes.length;
      const zn = call("yk_deflate", p, n, z, 1 << 17, c.level, c.strategy, c.bits);
      const zbytes = zn > 0 ? memory.get(z, zn) : [];
      let out = `${zn}:${hex(zbytes)}`;
      const bn = zn > 0 ? call("yk_inflate", z, zn, back, 1 << 17, c.bits) : 0;
      const same = bn === n && hex(memory.get(back, Math.max(0, bn))) === hex(c.bytes) ? 1 : 0;
      out += ` ${bn} ${same}`;
      if (zn > 4) {
        const k = Math.floor(zn / 2);
        L.__ykStore8(z + k, (L.__ykLoad8(z + k) ^ 0x5a) & 255);
        out += ` ${call("yk_inflate", z, zn, back, 1 << 17, c.bits)}`;
      }
      const ad = BigInt.asUintN(64, BigInt((env.yk_adler32 as Fn)(p, n) as bigint));
      const cr = BigInt.asUintN(64, BigInt((env.yk_crc32 as Fn)(p, n) as bigint));
      return `${out} ${ad} ${cr}`;
    }
    const bad = got.flatMap((g, i) =>
      g === want[i]
        ? []
        : [
            `${JSON.stringify({ ...all[i], bytes: `${all[i]?.bytes.length} ${hex(all[i]?.bytes.slice(0, 12) ?? [])}` })}\n  shaved ${g.slice(0, 200)}\n  C      ${want[i]?.slice(0, 200)}`,
          ],
    );
    expect(bad.slice(0, 5)).toEqual([]);
  }, 900_000);
});
