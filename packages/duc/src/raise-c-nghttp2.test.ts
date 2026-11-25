// SPDX-License-Identifier: Apache-2.0
// nghttp2 (#1367: Node's HTTP/2 library, vendor/node/deps/nghttp2, 1.69.0), shaved from its C
// sources (each file a unit) over musl shaved to the leaves, as Node builds it (nghttp2.gyp). HPACK:
// header lists through one deflater and inflater (the dynamic table carried from list to list),
// and the inflater on corrupted blocks. A whole exchange: a client and a server session in memory,
// requests with bodies, read in chunks, at several flow-control windows. Every byte each side sends
// and every callback equal the same sources compiled natively.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const NGHTTP2 = fileURLToPath(new URL("../vendor/node/deps/nghttp2/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-nghttp2.c", import.meta.url));
/** nghttp2.gyp's defines. */
const ARGS = [
  "-std=gnu11",
  "-D_U_=",
  "-DBUILDING_NGHTTP2",
  "-DNGHTTP2_STATICLIB",
  "-DHAVE_CONFIG_H",
  `-I${NGHTTP2}lib/includes`,
  `-I${NGHTTP2}lib`,
];
const FILES = readdirSync(join(NGHTTP2, "lib"))
  .filter((f) => f.endsWith(".c"))
  .map((f) => join(NGHTTP2, "lib", f));

/** A header list: names and values (a value starting `!`: never indexed). */
type Headers = [string, string][];
type HpackCase = { lists: Headers[]; table: number; flip: number };
type H2Case = {
  requests: Headers[];
  body: number[];
  reply: number[];
  window: number;
  chunk: number;
};

const NAMES = [
  ":method",
  ":path",
  ":authority",
  ":scheme",
  "accept",
  "user-agent",
  "cookie",
  "content-type",
  "x-custom",
  "cache-control",
];
const arbValue = fc.oneof(
  fc.constantFrom(
    "GET",
    "/",
    "/index.html",
    "example.com",
    "https",
    "text/html",
    "no-cache",
    "!secret",
  ),
  fc.string({ unit: fc.constantFrom(..."abcxyz019 -/=.!"), maxLength: 40 }),
);
const arbHeaders = fc.array(fc.tuple(fc.constantFrom(...NAMES), arbValue), { maxLength: 10 });
const listsText = (lists: Headers[]): string =>
  lists.map((l) => l.map(([n, v]) => `${n}\t${v}\n`).join("")).join("\n");

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-nghttp2-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("nghttp2, Node's HTTP/2 library, shaved from C", () => {
  const fixture = shaveCUnit(FIXTURE, ["yk_hpack", "yk_h2"], ARGS, "clang", "node-nghttp2.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const ng = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...ng.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !ng.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("nghttp2 shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(ng.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const hpack: HpackCase[] = fc.sample(
    fc.record({
      lists: fc.array(arbHeaders, { minLength: 1, maxLength: 6 }),
      table: fc.constantFrom(0, 64, 256, 4096),
      flip: fc.nat(500),
    }),
    { numRuns: 60, seed: 1367 },
  );
  const request = (method: string, path: string, extra: Headers): Headers => [
    [":method", method],
    [":path", path],
    [":scheme", "https"],
    [":authority", "example.com"],
    ...extra,
  ];
  const h2: H2Case[] = fc.sample(
    fc.record({
      requests: fc.array(
        fc
          .tuple(
            fc.constantFrom("GET", "POST", "PUT"),
            fc.constantFrom("/", "/a/b", "/upload?x=1"),
            arbHeaders,
          )
          .map(([m, p, h]) =>
            request(
              m,
              p,
              h.filter(([n]) => !n.startsWith(":")),
            ),
          ),
        { minLength: 1, maxLength: 4 },
      ),
      body: fc.uint8Array({ maxLength: 3000 }).map((b) => [...b]),
      reply: fc.uint8Array({ maxLength: 3000 }).map((b) => [...b]),
      window: fc.constantFrom(65535, 1000, 100),
      chunk: fc.constantFrom(1, 9, 100, 1 << 16),
    }),
    { numRuns: 30, seed: 1368 },
  );

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
long yk_hpack(const char *, long, long, long, char *, long);
long yk_h2(const char *, long, const unsigned char *, long, const unsigned char *, long, long, long, char *, long);
static unsigned char in[1 << 18], b1[1 << 16], b2[1 << 16];
static char out[1 << 22];
static long unhex(const char *h, unsigned char *o) {
  long n = 0; unsigned v;
  for (; h[0] && h[0] != ' ' && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); o[n++] = (unsigned char)v; }
  return n;
}
int main(void) {
  static char line[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    long a, b, r;
    char kind = line[0], *p = line + 2;
    a = strtol(p, &p, 10); b = strtol(p, &p, 10);
    if (kind == 'h') {
      long n = unhex(p + 2, in);
      r = yk_hpack((char *)in, n, a, b, out, sizeof out);
    } else {
      char *q = p + 2;
      long n = unhex(q, in); q = strchr(q, ' ') + 2;
      long bn = unhex(q, b1); q = strchr(q, ' ') + 2;
      long rn = unhex(q, b2);
      r = yk_h2((char *)in, n, b1, bn, b2, rn, a, b, out, sizeof out);
    }
    printf("%ld:", r);
    for (long i = 0; i < r; i++) printf("%02x", (unsigned char)out[i]);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "nghttp2");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-o", exe]);
    const lines = [
      ...hpack.map((c) => `h ${c.table} ${c.flip} x${hex(Buffer.from(listsText(c.lists)))}`),
      ...h2.map(
        (c) =>
          `s ${c.window} ${c.chunk} x${hex(Buffer.from(listsText(c.requests)))} x${hex(c.body)} x${hex(c.reply)}`,
      ),
    ];
    return execFileSync(exe, {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .slice(0, lines.length);
  };

  it("every frame sent, every callback, every HPACK block and inflation equal native (as raised)", () => {
    const want = native();
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...ng.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...ng.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const cap = 1 << 22;
    const out = memory.leaves.__ykAlloc(cap, 16);
    const W = (n: number): bigint => BigInt(n);
    const put = (b: number[]): number => memory.put(b.length > 0 ? b : [0]);
    const run = (f: () => unknown): string => {
      try {
        const r = Number(f());
        return `${r}:${r > 0 ? hex(memory.get(out, r)) : ""}`;
      } catch (e) {
        return `trap: ${(e as Error).message}`;
      }
    };
    const got = [
      ...hpack.map((c) => {
        const t = [...Buffer.from(listsText(c.lists))];
        return run(() =>
          (env.yk_hpack as Fn)(put(t), W(t.length), W(c.table), W(c.flip), out, W(cap)),
        );
      }),
      ...h2.map((c) => {
        const t = [...Buffer.from(listsText(c.requests))];
        return run(() =>
          (env.yk_h2 as Fn)(
            put(t),
            W(t.length),
            put(c.body),
            W(c.body.length),
            put(c.reply),
            W(c.reply.length),
            W(c.window),
            W(c.chunk),
            out,
            W(cap),
          ),
        );
      }),
    ];
    const text = (h: string | undefined): string =>
      h === undefined || h.startsWith("trap")
        ? String(h)
        : Buffer.from(h.slice(h.indexOf(":") + 1), "hex").toString("latin1");
    const bad = got.flatMap((g, i) => {
      if (g === want[i]) return [];
      const a = text(g).split("\n");
      const b = text(want[i]).split("\n");
      const k = a.findIndex((x, j) => x !== b[j]);
      return [
        `case ${i}, line ${k}\n  shaved ${a[k]?.slice(0, 300)}\n  C      ${b[k]?.slice(0, 300)}`,
      ];
    });
    expect(bad.slice(0, 5)).toEqual([]);
  }, 1_800_000);
});
