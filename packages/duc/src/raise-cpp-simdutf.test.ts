// SPDX-License-Identifier: Apache-2.0
// The C++ front end on simdutf's scalar UTF-8/UTF-16 paths (#1364 acceptance): validation, code
// point counts, lengths and conversions (both byte orders), from the vendored amalgamation through
// template instances (each `convert<endianness>` its own atom), C++ character types, enum classes
// and anonymous namespaces. The shaved atoms run over the memory leaves; the oracle is the same
// C++ compiled natively. On random valid and invalid UTF-8 and UTF-16, each result and each output
// buffer must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
import { shaveMusl } from "./__fixtures__/c-musl.js";
import { createCMemory, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SIMDUTF = fileURLToPath(new URL("../vendor/simdutf/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/simdutf-scalar.cpp", import.meta.url));
const ARGS = [
  "-std=c++17",
  "-DSIMDUTF_IMPLEMENTATION_HASWELL=0",
  "-DSIMDUTF_IMPLEMENTATION_ICELAKE=0",
  "-DSIMDUTF_IMPLEMENTATION_WESTMERE=0",
  "-DSIMDUTF_IMPLEMENTATION_FALLBACK=1",
  `-I${SIMDUTF}`,
];
const UTF8 = ["yk_utf8_validate", "yk_utf8_count", "yk_utf16_length_from_utf8"];
const UTF8_TO = ["yk_utf8_to_utf16le", "yk_utf8_to_utf16be"];
const UTF16 = ["yk_utf16le_validate", "yk_utf16le_count", "yk_utf8_length_from_utf16le"];
const UTF16_TO = ["yk_utf16le_to_utf8", "yk_utf16be_to_utf8"];
const ROOTS = [...UTF8, ...UTF8_TO, ...UTF16, ...UTF16_TO];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-simdutf-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** One input: UTF-8 bytes, or UTF-16 code units (little-endian in memory). */
type Input = { k: 8; bytes: number[] } | { k: 16; units: number[] };

describe.skipIf(!hasClang)("simdutf's scalar UTF-8/UTF-16, shaved from C++", () => {
  const unit = shaveCUnit(FIXTURE, ROOTS, ARGS, "clang++", "simdutf-scalar.cpp");

  it("every root, and every function it calls, shaves with no refusal", () => {
    expect([...unit.refused]).toEqual([]);
    for (const r of ROOTS) expect(unit.atoms.has(r), r).toBe(true);
    // Each byte order is its own instance of each converter template.
    const converters = [...unit.atoms.keys()].filter((k) => /^convert(_\d+)?$/.test(k));
    expect(converters.length).toBe(4);
    expect([...new Set([...unit.atoms.values()].flatMap((a) => a.externals))]).toEqual(["memcpy"]);
  });

  const inputs = (seed: number): Input[] =>
    fc.sample(
      fc.oneof(
        // Valid UTF-8 (any code points), with and without long ASCII runs.
        fc
          .string({ unit: "binary", maxLength: 60 })
          .map((s): Input => ({ k: 8, bytes: [...Buffer.from(s, "utf8")] })),
        fc
          .string({ unit: "binary-ascii", minLength: 16, maxLength: 70 })
          .map((s): Input => ({ k: 8, bytes: [...Buffer.from(s, "utf8")] })),
        // Arbitrary bytes, mostly invalid; and valid text with one byte changed.
        fc
          .uint8Array({ maxLength: 40 })
          .map((b): Input => ({ k: 8, bytes: [...b] })),
        fc
          .tuple(
            fc.string({ unit: "binary", minLength: 1, maxLength: 30 }),
            fc.nat(),
            fc.integer({ min: 0, max: 255 }),
          )
          .map(([s, i, v]): Input => {
            const bytes = [...Buffer.from(s, "utf8")];
            bytes[i % bytes.length] = v;
            return { k: 8, bytes };
          }),
        // UTF-16: valid strings, and arbitrary units (lone surrogates).
        fc
          .string({ unit: "binary", maxLength: 40 })
          .map(
            (s): Input => ({
              k: 16,
              units: [...s].flatMap((c) =>
                [...Buffer.from(c, "utf16le")].reduce<number[]>(
                  (a, b, j, all) => (j % 2 === 0 ? [...a, b | ((all[j + 1] as number) << 8)] : a),
                  [],
                ),
              ),
            }),
          ),
        fc
          .array(
            fc.oneof(fc.integer({ min: 0, max: 0xffff }), fc.integer({ min: 0xd800, max: 0xdfff })),
            { maxLength: 30 },
          )
          .map((units): Input => ({ k: 16, units })),
      ),
      { numRuns: 400, seed },
    );

  /** The native side: the fixture compiled as C++, a driver reading each input as hex. */
  let exe = "";
  const native = (all: readonly Input[]): string[] => {
    if (exe === "") {
      const driver = join(work, "driver.c");
      writeFileSync(
        driver,
        `#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <uchar.h>
${UTF8.map((f) => `size_t ${f}(const char *, size_t);`).join("\n")}
${UTF8_TO.map((f) => `size_t ${f}(const char *, size_t, char16_t *);`).join("\n")}
${UTF16.map((f) => `size_t ${f}(const char16_t *, size_t);`).join("\n")}
${UTF16_TO.map((f) => `size_t ${f}(const char16_t *, size_t, char *);`).join("\n")}
static void hexs(const unsigned char *p, size_t n) { for (size_t i = 0; i < n; i++) printf("%02x", p[i]); }
int main(void) {
  static char line[1 << 16]; static unsigned char in[1 << 15]; static unsigned char out[1 << 17];
  while (fgets(line, sizeof line, stdin)) {
    int k; size_t n = 0; char *h = strchr(line, ' ') + 1; sscanf(line, "%d", &k);
    for (; h[0] && h[0] != '\\n'; h += 2) { unsigned v; sscanf(h, "%2x", &v); in[n++] = (unsigned char)v; }
    if (k == 8) {
${UTF8.map((f) => `      printf("%zu ", ${f}((const char *)in, n) & ${f.endsWith("validate") ? "0xff" : "(size_t)-1"});`).join("\n")}
${UTF8_TO.map((f) => `      { memset(out, 0xee, 4 * n + 16); size_t r = ${f}((const char *)in, n, (char16_t *)out); printf("%zu:", r); hexs(out, 2 * r); printf(" "); }`).join("\n")}
    } else {
      n /= 2;
${UTF16.map((f) => `      printf("%zu ", ${f}((const char16_t *)in, n) & ${f.endsWith("validate") ? "0xff" : "(size_t)-1"});`).join("\n")}
${UTF16_TO.map((f) => `      { memset(out, 0xee, 4 * n + 16); size_t r = ${f}((const char16_t *)in, n, (char *)out); printf("%zu:", r); hexs(out, r); printf(" "); }`).join("\n")}
    }
    printf("\\n");
  }
  return 0;
}
`,
      );
      const obj = join(work, "simdutf-scalar.o");
      execFileSync("clang++", [...ARGS, "-O0", "-c", FIXTURE, "-o", obj]);
      exe = join(work, "simdutf");
      execFileSync("clang", ["-O0", driver, obj, "-lstdc++", "-o", exe]);
    }
    const stdin = all
      .map((x) =>
        x.k === 8 ? `8 ${hex(x.bytes)}` : `16 ${hex(x.units.flatMap((u) => [u & 255, u >> 8]))}`,
      )
      .join("\n");
    return execFileSync(exe, { input: `${stdin}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  const shaved = (lowered: boolean, all: readonly Input[]): string[] => {
    const memory = createCMemory();
    const musl = shaveMusl(["memcpy"]);
    const env = link(new Map([...musl.atoms, ...unit.atoms]), lowered, memory, [
      unit,
      ...musl.units,
    ]);
    const L = memory.leaves;
    return all.map((x) => {
      const bytes = x.k === 8 ? x.bytes : x.units.flatMap((u) => [u & 255, u >> 8]);
      const n = x.k === 8 ? bytes.length : x.units.length;
      const p = memory.put(bytes.length > 0 ? bytes : [0]);
      const parts: string[] = [];
      const call = (f: string, ...a: unknown[]): bigint => {
        const r = (env[f] as Fn)(...a);
        return typeof r === "bigint" ? r : BigInt(r as number);
      };
      for (const f of x.k === 8 ? UTF8 : UTF16) {
        const r = call(f, p, BigInt(n));
        parts.push(`${f.endsWith("validate") ? r & 0xffn : BigInt.asUintN(64, r)} `);
      }
      for (const f of x.k === 8 ? UTF8_TO : UTF16_TO) {
        const out = L.__ykAlloc(4 * n + 16, 16);
        for (let i = 0; i < 4 * n + 16; i++) L.__ykStore8(out + i, 0xee);
        const r = Number(call(f, p, BigInt(n), out));
        parts.push(`${r}:${hex(memory.get(out, x.k === 8 ? 2 * r : r))} `);
      }
      return parts.join("");
    });
  };

  for (const lowered of [false, true]) {
    it(`each result equals the C++ compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const all = inputs(lowered ? 1364 : 13640);
      const want = native(all);
      const got = shaved(lowered, all);
      const bad = got.flatMap((g, i) =>
        g === want[i] ? [] : [`${JSON.stringify(all[i])}: shaved ${g} / C++ ${want[i]}`],
      );
      expect(bad.slice(0, 6)).toEqual([]);
    }, 900_000);
  }
});
