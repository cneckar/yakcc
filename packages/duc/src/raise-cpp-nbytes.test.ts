// SPDX-License-Identifier: Apache-2.0
// The C++ front end on Node's nbytes (#1367: vendor/node/deps/nbytes, the byte logic of the buffer
// and string_decoder bindings), over musl shaved to the leaves. Base64 and hex decoding, hex
// encoding, byte swaps, ForceAscii and the Boyer-Moore(-Horspool) string search give the same
// bytes as the same sources compiled natively, and the same as Node's own Buffer where it calls
// them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const NBYTES = fileURLToPath(new URL("../vendor/node/deps/nbytes/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-nbytes.cpp", import.meta.url));
const ARGS = ["-std=c++17", "-DNDEBUG", `-I${NBYTES}include`, `-I${NBYTES}src`];
const ROOTS = [
  "yk_base64_decode",
  "yk_base64_decoded_size",
  "yk_hex_decode",
  "yk_hex_encode",
  "yk_swap",
  "yk_force_ascii",
  "yk_search",
];

/** One operation: its kind, two numbers, and one or two byte strings. */
type Case = { op: string; a: number; b: number; x: number[]; y: number[] };

const bytesOf = (s: string): number[] => [...Buffer.from(s, "latin1")];

const arbCase: fc.Arbitrary<Case> = fc.oneof(
  // base64 (and base64url), valid or with noise, padded or not
  fc
    .tuple(fc.uint8Array({ maxLength: 200 }), fc.boolean(), fc.string({ maxLength: 4 }), fc.nat(3))
    .map(([b, url, noise, cut]) => {
      let s = Buffer.from(b).toString(url ? "base64url" : "base64");
      if (cut > 0) s = s.slice(0, Math.max(0, s.length - cut));
      return { op: "b64", a: 0, b: 0, x: bytesOf(s + noise), y: [] };
    }),
  fc
    .string({ unit: fc.constantFrom(..."AZaz09+/-_= \n\t*".split("")), maxLength: 80 })
    .map((s) => ({ op: "b64", a: 0, b: 0, x: bytesOf(s), y: [] })),
  // hex: valid, odd, with junk
  fc
    .tuple(fc.uint8Array({ maxLength: 200 }), fc.string({ maxLength: 3 }), fc.boolean())
    .map(([b, junk, upper]) => {
      const h = Buffer.from(b).toString("hex");
      return { op: "hexd", a: 0, b: 0, x: bytesOf((upper ? h.toUpperCase() : h) + junk), y: [] };
    }),
  fc.uint8Array({ maxLength: 300 }).map((b) => ({ op: "hexe", a: 0, b: 0, x: [...b], y: [] })),
  fc
    .tuple(fc.constantFrom(16, 32, 64), fc.uint8Array({ maxLength: 260 }))
    .map(([w, b]) => ({ op: "swap", a: w, b: 0, x: [...b], y: [] })),
  fc.uint8Array({ maxLength: 300 }).map((b) => ({ op: "ascii", a: 0, b: 0, x: [...b], y: [] })),
  // search: a haystack of few letters (so needles occur), a needle cut from it or not
  fc
    .tuple(
      fc.array(fc.constantFrom(97, 98, 99, 0xe9), { maxLength: 400 }),
      fc.nat(400),
      fc.integer({ min: 1, max: 40 }),
      fc.nat(420),
      fc.boolean(),
      fc.boolean(),
      fc.array(fc.constantFrom(97, 98, 99, 100), { minLength: 1, maxLength: 12 }),
    )
    .map(([hay, at, len, start, forward, cut, other]) => {
      const needle =
        cut && hay.length > 0 ? hay.slice(at % hay.length, (at % hay.length) + len) : other;
      return {
        op: "search",
        a: Math.min(start, hay.length),
        b: forward ? 1 : 0,
        x: hay,
        y: needle,
      };
    }),
);

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-nbytes-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("Node's nbytes, shaved from C++", () => {
  const unit = shaveCUnit(FIXTURE, ROOTS, ARGS, "clang++", "node-nbytes.cpp");
  const externals = [...new Set([...unit.atoms.values()].flatMap((a) => a.externals))].filter(
    (x) => !unit.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(externals));

  it("nbytes shaves with no refusal, its C library down to the leaves", () => {
    expect([...unit.refused]).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all = [
    ...fc.sample(arbCase, { numRuns: 400, seed: 1367 }),
    // wide (UTF-16) search: the same haystacks as code units
    ...fc
      .sample(
        fc.tuple(
          fc.array(fc.constantFrom(0x61, 0x62, 0x3b1, 0xd83d), { maxLength: 200 }),
          fc.array(fc.constantFrom(0x61, 0x62, 0x3b1), { minLength: 1, maxLength: 8 }),
          fc.nat(200),
          fc.boolean(),
          fc.boolean(),
        ),
        { numRuns: 80, seed: 1368 },
      )
      .map(([h, other, s, f, cut]) => {
        // (A needle cut from the haystack, or not.)
        const at = h.length > 0 ? s % h.length : 0;
        const n = cut && h.length > 0 ? h.slice(at, at + 1 + (s % 6)) : other;
        return [h, n, s % (h.length + 1), f] as const;
      })
      .map(([h, n, s, f]) => ({
        op: "wsearch",
        a: s,
        b: f ? 1 : 0,
        x: [...Buffer.from(Uint16Array.from(h).buffer)],
        y: [...Buffer.from(Uint16Array.from(n).buffer)],
      })),
  ];

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <string.h>
long yk_base64_decode(const char *, long, char *, long);
long yk_base64_decoded_size(const char *, long);
long yk_hex_decode(const char *, long, char *, long);
long yk_hex_encode(const char *, long, char *, long);
long yk_swap(char *, long, int);
void yk_force_ascii(const char *, char *, long);
long yk_search(const void *, long, const void *, long, long, int, int);
static char line[1 << 16], x[1 << 14], y[1 << 14], out[1 << 15];
static int unhex(const char *h, char *o) {
  int n = 0; unsigned v;
  for (h++; h[0] && h[0] != ' ' && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); o[n++] = (char)v; }
  return n;
}
static void put(const char *p, long n) { for (long i = 0; i < n; i++) printf("%02x", (unsigned char)p[i]); }
int main(void) {
  char op[16]; long a, b; char *s;
  while (fgets(line, sizeof line, stdin)) {
    sscanf(line, "%15s %ld %ld", op, &a, &b);
    s = strchr(strchr(strchr(line, ' ') + 1, ' ') + 1, ' ') + 1;
    int xn = unhex(s, x);
    int yn = unhex(strchr(s, ' ') + 1, y);
    if (!strcmp(op, "b64")) {
      long r = yk_base64_decode(x, xn, out, sizeof out);
      printf("%ld %ld:", yk_base64_decoded_size(x, xn), r); put(out, r);
    } else if (!strcmp(op, "hexd")) {
      long r = yk_hex_decode(x, xn, out, sizeof out); printf("%ld:", r); put(out, r);
    } else if (!strcmp(op, "hexe")) {
      long r = yk_hex_encode(x, xn, out, sizeof out); printf("%ld:", r); put(out, r);
    } else if (!strcmp(op, "swap")) {
      long r = yk_swap(x, xn, (int)a); printf("%ld:", r); put(x, xn);
    } else if (!strcmp(op, "ascii")) {
      yk_force_ascii(x, out, xn); put(out, xn);
    } else {
      int w = op[0] == 'w';
      printf("%ld", yk_search(x, w ? xn / 2 : xn, y, w ? yn / 2 : yn, a, (int)b, w));
    }
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const obj = join(work, "nbytes.o");
    execFileSync("clang++", [...ARGS, "-O1", "-c", FIXTURE, "-o", obj]);
    const exe = join(work, "nbytes");
    execFileSync("clang++", ["-x", "c", driver, "-x", "none", obj, "-o", exe]);
    const input = all.map((c) => `${c.op} ${c.a} ${c.b} x${hex(c.x)} x${hex(c.y)}`).join("\n");
    return execFileSync(exe, { input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  /** What Node's Buffer gives, where it calls nbytes directly (else undefined). */
  const node = (c: Case): string | undefined => {
    const x = Buffer.from(c.x);
    switch (c.op) {
      case "hexd": {
        const d = Buffer.from(x.toString("latin1"), "hex");
        return `${d.length}:${d.toString("hex")}`;
      }
      case "hexe":
        return `${x.length * 2}:${Buffer.from(x.toString("hex"), "latin1").toString("hex")}`;
      case "swap": {
        if (x.length % (c.a / 8) !== 0) return `0:${x.toString("hex")}`;
        const s = Buffer.from(x);
        c.a === 16 ? s.swap16() : c.a === 32 ? s.swap32() : s.swap64();
        return `1:${s.toString("hex")}`;
      }
      case "search":
        // Buffer#indexOf searches forward from the offset (lastIndexOf's offset differs).
        return c.b === 1 && c.y.length <= c.x.length - c.a
          ? `${x.indexOf(Buffer.from(c.y), c.a)}`
          : undefined;
      default:
        return undefined;
    }
  };

  it("each operation gives the native bytes, and Node's Buffer's (as raised)", () => {
    const want = native();
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...unit.atoms]),
      false,
      memory,
      [...musl.units, unit],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const out = L.__ykAlloc(1 << 15, 16);
    /** A C long (i64). */
    const W = (n: number): bigint => BigInt(n);
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    const one = (c: Case): string => {
      const px = memory.put([...c.x, 0]);
      const py = memory.put([...c.y, 0]);
      const xn = c.x.length;
      const get = (p: number, n: number): string => (n > 0 ? hex(memory.get(p, n)) : "");
      switch (c.op) {
        case "b64": {
          const size = call("yk_base64_decoded_size", px, W(xn));
          const r = call("yk_base64_decode", px, W(xn), out, W(1 << 15));
          return `${size} ${r}:${get(out, r)}`;
        }
        case "hexd": {
          const r = call("yk_hex_decode", px, W(xn), out, W(1 << 15));
          return `${r}:${get(out, r)}`;
        }
        case "hexe": {
          const r = call("yk_hex_encode", px, W(xn), out, W(1 << 15));
          return `${r}:${get(out, r)}`;
        }
        case "swap":
          return `${call("yk_swap", px, W(xn), c.a)}:${get(px, xn)}`;
        case "ascii":
          call("yk_force_ascii", px, out, W(xn));
          return get(out, xn);
        default: {
          const w = c.op === "wsearch";
          const yn = c.y.length;
          return `${call("yk_search", px, W(w ? xn / 2 : xn), py, W(w ? yn / 2 : yn), W(c.a), c.b, w ? 1 : 0)}`;
        }
      }
    };
    const got = all.map((c) => {
      try {
        return one(c);
      } catch (e) {
        return `trap: ${(e as Error).message}`;
      }
    });
    const bad = got.flatMap((g, i) => {
      const c = all[i] as Case;
      const n = node(c);
      return g === want[i] && (n === undefined || n === g)
        ? []
        : [
            `${c.op} ${c.a} ${c.b} ${hex(c.x).slice(0, 60)} ${hex(c.y)}\n  shaved ${g.slice(0, 160)}\n  C++    ${want[i]?.slice(0, 160)}\n  Node   ${n?.slice(0, 160)}`,
          ];
    });
    expect(bad.slice(0, 5)).toEqual([]);
    expect(new Set(all.map((c) => c.op)).size).toBe(7);
    // (The searches find their needles, forward and back, narrow and wide.)
    for (const op of ["search", "wsearch"])
      for (const b of [0, 1])
        expect(got.some((g, i) => all[i]?.op === op && all[i]?.b === b && g !== "-1")).toBe(true);
  }, 900_000);
});
