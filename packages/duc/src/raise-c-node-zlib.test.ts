// SPDX-License-Identifier: Apache-2.0
// Node's zlib (#1367: vendor/node/deps/zlib, Chromium's zlib as Node vendors it, in its portable
// configuration, CPU_NO_SIMD), shaved from its C sources (each file a unit) over musl shaved to the
// leaves, and run as Node's zlib binding runs it. Against Node itself: deflateSync,
// deflateRawSync and gzipSync at every level, window, memory level and strategy give the same
// bytes; inflating Node's streams, whole or corrupted, gives the same data or the same failure;
// crc32 equals zlib.crc32.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
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

const ZLIB = fileURLToPath(new URL("../vendor/node/deps/zlib/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-zlib.c", import.meta.url));
const ARGS = ["-std=c11", "-DHAVE_HIDDEN", "-DCPU_NO_SIMD", `-I${ZLIB}`];
const FILES = [
  "adler32.c",
  "compress.c",
  "cpu_features.c",
  "crc32.c",
  "deflate.c",
  "inffast.c",
  "inflate.c",
  "inftrees.c",
  "trees.c",
  "uncompr.c",
  "zutil.c",
].map((f) => join(ZLIB, f));
const ROOTS = ["yk_node_deflate", "yk_node_inflate", "yk_node_crc32"];
/** Node's default chunk size (zlib.constants.Z_DEFAULT_CHUNK). */
const CHUNK = 16 * 1024;

/** One case: input, framing, level, window bits, memory level, strategy. */
type Case = {
  bytes: number[];
  framing: "deflate" | "raw" | "gzip";
  level: number;
  windowBits: number;
  memLevel: number;
  strategy: number;
};

describe.skipIf(!hasClang)("Node's zlib, shaved from C, against Node", () => {
  const fixture = shaveCUnit(FIXTURE, ROOTS, ARGS, "clang", "node-zlib.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const z = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...z.externals])].filter((x) => !fixture.atoms.has(x));
  const musl = withMuslInit(shaveMusl(libc));

  it("Node's zlib shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(z.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all: Case[] = fc.sample(
    fc.record({
      bytes: fc.oneof(
        fc.uint8Array({ maxLength: 600 }).map((b) => [...b]),
        fc
          .array(fc.constantFrom("the ", "quick ", "brown ", "fox ", "aaaaaaaa", "\n", "node "), {
            maxLength: 400,
          })
          .map((w) => [...Buffer.from(w.join(""), "utf8")]),
        // Longer than a chunk, so the output takes several.
        fc
          .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 40_000 }))
          .map(([v, n]) => Array(n).fill(v)),
      ),
      framing: fc.constantFrom("deflate", "raw", "gzip"),
      level: fc.integer({ min: -1, max: 9 }),
      windowBits: fc.integer({ min: 9, max: 15 }),
      memLevel: fc.integer({ min: 1, max: 9 }),
      strategy: fc.integer({ min: 0, max: 4 }),
    }),
    { numRuns: 150, seed: 1367 },
  );

  const nodeDeflate = (c: Case): Buffer => {
    const opts = {
      level: c.level,
      windowBits: c.windowBits,
      memLevel: c.memLevel,
      strategy: c.strategy,
    };
    const b = Buffer.from(c.bytes);
    return c.framing === "raw"
      ? zlib.deflateRawSync(b, opts)
      : c.framing === "gzip"
        ? zlib.gzipSync(b, opts)
        : zlib.deflateSync(b, opts);
  };
  const nodeInflate = (c: Case, stream: Buffer): string => {
    try {
      const opts = { windowBits: c.windowBits };
      const out =
        c.framing === "raw"
          ? zlib.inflateRawSync(stream, opts)
          : c.framing === "gzip"
            ? zlib.gunzipSync(stream)
            : zlib.inflateSync(stream, opts);
      return hex(out);
    } catch {
      return "failed";
    }
  };
  const wbits = (c: Case): number =>
    c.framing === "raw" ? -c.windowBits : c.framing === "gzip" ? c.windowBits + 16 : c.windowBits;

  it("each stream equals Node's; inflating Node's streams, whole or corrupted, gives Node's data or failure; crc32 is zlib.crc32's (as raised)", () => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...z.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...z.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const cap = 1 << 18;
    const out = L.__ykAlloc(cap, 16);
    const W = (n: number): bigint => BigInt(n);
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    const bad: string[] = [];
    all.forEach((c, i) => {
      const label = `${i} ${JSON.stringify({ ...c, bytes: `${c.bytes.length} ${hex(c.bytes.slice(0, 8))}` })}`;
      try {
        const p = memory.put(c.bytes.length > 0 ? c.bytes : [0]);
        const want = nodeDeflate(c);
        const n = call(
          "yk_node_deflate",
          p,
          W(c.bytes.length),
          out,
          W(cap),
          c.level,
          wbits(c),
          c.memLevel,
          c.strategy,
          CHUNK,
        );
        const got = n > 0 ? Buffer.from(memory.get(out, n)) : Buffer.alloc(0);
        if (!got.equals(want))
          bad.push(
            `${label}\n  deflate: shaved ${n} ${hex(got.subarray(0, 24))}, Node ${want.length} ${hex(want.subarray(0, 24))}`,
          );
        // Node's stream inflated, and corrupted.
        const streams = [want];
        if (want.length > 4) {
          const broken = Buffer.from(want);
          broken[broken.length >> 1] ^= 0x5a;
          streams.push(broken);
        }
        for (const s of streams) {
          const ps = memory.put([...s]);
          const m = call("yk_node_inflate", ps, W(s.length), out, W(cap), wbits(c), CHUNK);
          const shaved = m >= 0 ? hex(memory.get(out, Math.max(0, m))) : "failed";
          const node = nodeInflate(c, s);
          if (shaved !== node)
            bad.push(
              `${label}\n  inflate${s === want ? "" : " (corrupt)"}: shaved ${m} ${shaved.slice(0, 40)}, Node ${node.slice(0, 40)}`,
            );
        }
        const crc = BigInt.asUintN(
          64,
          BigInt((env.yk_node_crc32 as Fn)(p, W(c.bytes.length), 0n) as bigint),
        );
        if (Number(crc) !== zlib.crc32(Buffer.from(c.bytes)))
          bad.push(`${label}\n  crc32: shaved ${crc}, Node ${zlib.crc32(Buffer.from(c.bytes))}`);
      } catch (e) {
        bad.push(`${label}\n  trap: ${(e as Error).message}`);
      }
    });
    expect(bad.slice(0, 5)).toEqual([]);
  }, 1_800_000);
});
