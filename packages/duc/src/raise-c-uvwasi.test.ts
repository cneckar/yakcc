// SPDX-License-Identifier: Apache-2.0
// uvwasi (#1367: Node's WASI implementation, vendor/node/deps/uvwasi, 0.0.23), its computing
// parts shaved from its C sources (and libuv's they call) over musl shaved to the leaves: path
// normalization (how a guest's path is sandboxed), every WASI error's name, libuv's errors as
// WASI's, and WASI's structures as a guest reads them, equal the same sources compiled natively.
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

const WASI = fileURLToPath(new URL("../vendor/node/deps/uvwasi/", import.meta.url));
const UV = fileURLToPath(new URL("../vendor/node/deps/uv/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-uvwasi.c", import.meta.url));
const ARGS = [
  "-std=gnu11",
  "-D_GNU_SOURCE",
  "-D_LARGEFILE_SOURCE",
  "-D_FILE_OFFSET_BITS=64",
  `-I${WASI}include`,
  `-I${WASI}src`,
  `-I${UV}include`,
  `-I${UV}src`,
];
const FILES = [
  ...readdirSync(join(WASI, "src"))
    .filter((f) => f.endsWith(".c"))
    .map((f) => join(WASI, "src", f)),
  ...readdirSync(join(UV, "src"))
    .filter((f) => f.endsWith(".c"))
    .map((f) => join(UV, "src", f)),
];
/** The native oracle: uvwasi, and libuv as uv.gyp builds it for Linux. */
const NATIVE = [
  ...FILES,
  ...[
    "async",
    "core",
    "dl",
    "fs",
    "getaddrinfo",
    "getnameinfo",
    "loop",
    "loop-watcher",
    "pipe",
    "poll",
    "process",
    "random-devurandom",
    "signal",
    "stream",
    "tcp",
    "thread",
    "tty",
    "udp",
    "proctitle",
    "linux",
    "procfs-exepath",
    "random-getrandom",
    "random-sysctl-linux",
  ].map((f) => join(UV, "src/unix", `${f}.c`)),
];

const PATHS = [
  "/",
  ".",
  "..",
  "a/b/c",
  "a/./b/../c",
  "/a/b/../../..",
  "../../etc/passwd",
  "a//b///c/",
  "./a/",
  "a/b/..",
  "/../a",
  "a/../../b",
  "",
  "....//..",
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-uvwasi-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("uvwasi's computing parts, shaved from C", () => {
  const fixture = shaveCUnit(
    FIXTURE,
    ["yk_wasi_normalize", "yk_wasi_errors", "yk_wasi_serdes"],
    ARGS,
    "clang",
    "node-uvwasi.c",
  );
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const wasi = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...wasi.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !wasi.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("uvwasi's parts shave with no refusal, their C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(wasi.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const paths = [
    ...PATHS,
    ...fc.sample(
      fc
        .array(fc.constantFrom("a", "bb", ".", "..", "", "x.y"), { maxLength: 8 })
        .chain((parts) => fc.boolean().map((abs) => `${abs ? "/" : ""}${parts.join("/")}`)),
      { numRuns: 60, seed: 1367 },
    ),
  ];
  const values = fc.sample(
    fc.array(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), { minLength: 17, maxLength: 17 }),
    {
      numRuns: 20,
      seed: 1368,
    },
  );

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
long yk_wasi_normalize(const char *, long, char *, long);
long yk_wasi_errors(char *, long);
long yk_wasi_serdes(const unsigned long long *, unsigned char *);
int main(void) {
  static char line[1 << 14], in[1 << 12], out[1 << 16];
  long r = yk_wasi_errors(out, sizeof out);
  for (long i = 0; i < r; i++) putchar(out[i] == '\\n' ? '~' : out[i]);
  putchar('\\n');
  while (fgets(line, sizeof line, stdin)) {
    if (line[0] == 'p') {
      long n = 0; unsigned v;
      for (char *h = line + 2; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (char)v; }
      in[n] = 0;
      r = yk_wasi_normalize(in, n, out, sizeof out);
      fwrite(out, 1, r, stdout);
    } else {
      unsigned long long v[17]; char *p = line + 2;
      for (int i = 0; i < 17; i++) v[i] = strtoull(p, &p, 10);
      unsigned char b[256];
      r = yk_wasi_serdes(v, b);
      for (long i = 0; i < r; i++) printf("%02x", b[i]);
    }
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "uvwasi");
    execFileSync("clang", [
      ...ARGS,
      "-O1",
      "-ffunction-sections",
      "-Wl,--gc-sections",
      driver,
      FIXTURE,
      ...NATIVE,
      "-lpthread",
      "-ldl",
      "-lrt",
      "-o",
      exe,
    ]);
    const lines = [
      ...paths.map((p) => `p ${hex(Buffer.from(p, "latin1"))}`),
      ...values.map((v) => `s ${v.join(" ")}`),
    ];
    return execFileSync(exe, {
      input: `${lines.join("\n")}\n`,
      encoding: "latin1",
      maxBuffer: 1 << 26,
    })
      .split("\n")
      .slice(0, lines.length + 1);
  };

  for (const lowered of [false, true])
    it(`paths, errors and serialized structures equal native (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const want = native();
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        new Map([...musl.atoms, ...wasi.atoms, ...fixture.atoms]),
        lowered,
        memory,
        [...musl.units, ...wasi.units, fixture],
        system.leaves as unknown as Record<string, Fn>,
      );
      env.yk_musl_init?.();
      const cap = 1 << 16;
      const out = memory.leaves.__ykAlloc(cap, 16);
      const text = (n: number): string =>
        Buffer.from(memory.get(out, Math.max(0, n))).toString("latin1");
      const run = (f: () => string): string => {
        try {
          return f();
        } catch (e) {
          return `trap: ${(e as Error).message}`;
        }
      };
      const got = [
        run(() => text(Number((env.yk_wasi_errors as Fn)(out, BigInt(cap)))).replaceAll("\n", "~")),
        ...paths.map((p) =>
          run(() => {
            const b = [...Buffer.from(p, "latin1"), 0];
            return text(
              Number(
                (env.yk_wasi_normalize as Fn)(
                  memory.put(b),
                  BigInt(b.length - 1),
                  out,
                  BigInt(cap),
                ),
              ),
            );
          }),
        ),
        ...values.map((v) =>
          run(() => {
            const vs = memory.leaves.__ykAlloc(8 * 17, 8);
            v.forEach((x, i) => memory.leaves.__ykStore64(vs + 8 * i, x));
            const n = Number((env.yk_wasi_serdes as Fn)(vs, out));
            return hex(memory.get(out, n));
          }),
        ),
      ];
      const bad = got.flatMap((g, i) =>
        g === want[i]
          ? []
          : [`${i}\n  shaved ${g.slice(0, 300)}\n  C      ${want[i]?.slice(0, 300)}`],
      );
      expect(bad.slice(0, 5)).toEqual([]);
    }, 900_000);
});
