// SPDX-License-Identifier: Apache-2.0
// brotli (#1367: Node's zlib.brotliCompress and brotliDecompress, vendor/node/deps/brotli),
// shaved from its C sources (each file a unit) over musl shaved to the leaves. Compression at
// every quality, window and mode gives the same bytes as the same sources compiled natively, and
// Node's own decompressor gives the input back; streaming decompression, in chunks, of each and of
// corrupt streams gives the same bytes or the same error.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
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

const BROTLI = fileURLToPath(new URL("../vendor/node/deps/brotli/c/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-brotli.c", import.meta.url));
const ARGS = ["-std=c11", `-I${BROTLI}include`];
const FILES = ["common", "dec", "enc"].flatMap((d) =>
  readdirSync(join(BROTLI, d))
    .filter((f) => f.endsWith(".c"))
    .map((f) => join(BROTLI, d, f)),
);
const ROOTS = ["yk_brotli_compress", "yk_brotli_decompress"];

/** One case: input bytes, quality (0..11), window bits (10..24), mode, the decoder's chunk size. */
type Case = { bytes: number[]; quality: number; lgwin: number; mode: number; step: number };

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-brotli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("brotli, shaved from C", () => {
  const fixture = shaveCUnit(FIXTURE, ROOTS, ARGS, "clang", "node-brotli.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const brotli = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...brotli.externals])].filter((x) => !fixture.atoms.has(x));
  const musl = withMuslInit(shaveMusl(libc));

  it("brotli shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(brotli.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all: Case[] = fc.sample(
    fc.record({
      bytes: fc.oneof(
        fc.uint8Array({ maxLength: 400 }).map((b) => [...b]),
        fc
          .array(fc.constantFrom("the ", "quick ", "brown ", "fox ", "<div>", "\n", "brotli "), {
            maxLength: 200,
          })
          .map((w) => [...Buffer.from(w.join(""), "utf8")]),
        fc.tuple(fc.integer({ min: 0, max: 255 }), fc.nat(2000)).map(([v, n]) => Array(n).fill(v)),
      ),
      quality: fc.integer({ min: 0, max: 11 }),
      lgwin: fc.constantFrom(10, 16, 22, 24),
      mode: fc.integer({ min: 0, max: 2 }),
      step: fc.constantFrom(0, 1, 7, 64),
    }),
    { numRuns: 48, seed: 1367 },
  );

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <string.h>
long yk_brotli_compress(const unsigned char *, long, unsigned char *, long, int, int, int);
long yk_brotli_decompress(const unsigned char *, long, unsigned char *, long, int);
static unsigned char in[1 << 16], z[1 << 17], back[1 << 17];
static char line[1 << 18];
int main(void) {
  int quality, lgwin, mode, step, used = 0;
  while (fgets(line, sizeof line, stdin)) {
    char *h = line; int n = 0; unsigned v;
    sscanf(h, "%d %d %d %d x%n", &quality, &lgwin, &mode, &step, &used);
    for (h += used; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (unsigned char)v; }
    long zn = yk_brotli_compress(in, n, z, sizeof z, quality, lgwin, mode);
    printf("%ld:", zn);
    for (long i = 0; i < zn; i++) printf("%02x", z[i]);
    long bn = zn > 0 ? yk_brotli_decompress(z, zn, back, sizeof back, step) : 0;
    printf(" %ld %d", bn, bn == n && memcmp(back, in, n) == 0);
    if (zn > 4) { z[zn / 2] ^= 0x5a; printf(" %ld", yk_brotli_decompress(z, zn, back, sizeof back, step)); }
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "brotli");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-lm", "-o", exe]);
    const input = all
      .map((c) => `${c.quality} ${c.lgwin} ${c.mode} ${c.step} x${hex(c.bytes)}`)
      .join("\n");
    return execFileSync(exe, { input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  it("each case's stream, round trip and corrupt-stream outcome equal native (as raised)", () => {
    const want = native();
    // (Node's own decompressor reads each native stream back to its input.)
    want.forEach((w, i) => {
      const [zn, z] = (w.split(" ")[0] as string).split(":") as [string, string];
      if (Number(zn) > 0)
        expect(hex(brotliDecompressSync(Buffer.from(z, "hex")))).toBe(hex(all[i]?.bytes ?? []));
    });
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...brotli.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...brotli.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const z = L.__ykAlloc(1 << 17, 16);
    const back = L.__ykAlloc(1 << 17, 16);
    const W = (n: number): bigint => BigInt(n);
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    const one = (c: Case): string => {
      const p = memory.put(c.bytes.length > 0 ? c.bytes : [0]);
      const n = c.bytes.length;
      const zn = call("yk_brotli_compress", p, W(n), z, W(1 << 17), c.quality, c.lgwin, c.mode);
      let out = `${zn}:${zn > 0 ? hex(memory.get(z, zn)) : ""}`;
      const bn = zn > 0 ? call("yk_brotli_decompress", z, W(zn), back, W(1 << 17), c.step) : 0;
      const same = bn === n && (n === 0 || hex(memory.get(back, n)) === hex(c.bytes)) ? 1 : 0;
      out += ` ${bn} ${same}`;
      if (zn > 4) {
        const k = Math.floor(zn / 2);
        L.__ykStore8(z + k, (L.__ykLoad8(z + k) ^ 0x5a) & 255);
        out += ` ${call("yk_brotli_decompress", z, W(zn), back, W(1 << 17), c.step)}`;
      }
      return out;
    };
    const got = all.map((c) => {
      try {
        return one(c);
      } catch (e) {
        return `trap: ${(e as Error).message}`;
      }
    });
    const bad = got.flatMap((g, i) =>
      g === want[i]
        ? []
        : [
            `${JSON.stringify({ ...all[i], bytes: `${all[i]?.bytes.length} ${hex(all[i]?.bytes.slice(0, 12) ?? [])}` })}\n  shaved ${g.slice(0, 200)}\n  C      ${want[i]?.slice(0, 200)}`,
          ],
    );
    expect(bad.slice(0, 5)).toEqual([]);
  }, 1_800_000);
});
