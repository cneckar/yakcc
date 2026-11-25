// SPDX-License-Identifier: Apache-2.0
// libuv (#1367: Node's event loop library, vendor/node/deps/uv, 1.51.0), its computing parts
// shaved from its C sources (each file a unit) over musl shaved to the leaves, as Node builds it
// for Linux (uv.gyp). Every error's name and message equal Node's own (util.getSystemErrorMap);
// IDNA to ASCII (host names as uv_getaddrinfo sends them) and IPv4/IPv6 text to bytes and back
// equal the same sources compiled natively.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as util from "node:util";
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

const UV = fileURLToPath(new URL("../vendor/node/deps/uv/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-uv.c", import.meta.url));
/** uv.gyp's for Linux. */
const ARGS = [
  "-std=gnu11",
  "-D_GNU_SOURCE",
  "-D_LARGEFILE_SOURCE",
  "-D_FILE_OFFSET_BITS=64",
  "-D_POSIX_C_SOURCE=200112",
  `-I${UV}include`,
  `-I${UV}src`,
  `-I${UV}src/unix`,
];
/** The whole library as uv.gyp builds it for Linux (common, posix and linux sources): the oracle. */
const NATIVE = [
  ...[
    "fs-poll",
    "idna",
    "inet",
    "random",
    "strscpy",
    "strtok",
    "thread-common",
    "threadpool",
    "timer",
    "uv-data-getter-setters",
    "uv-common",
    "version",
  ].map((f) => `src/${f}.c`),
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
  ].map((f) => `src/unix/${f}.c`),
].map((f) => join(UV, f));
/** Its platform-independent sources, from which the computing parts are shaved. */
const FILES = readdirSync(join(UV, "src"))
  .filter((f) => f.endsWith(".c"))
  .map((f) => join(UV, "src", f));

const HOSTS = [
  "example.com",
  "münchen.de",
  "bücher.example",
  "faß.de",
  "παράδειγμα.δοκιμή",
  "例え.テスト",
  "xn--mnchen-3ya.de",
  "EXAMPLE.COM",
  "a.b.c",
  "",
  ".",
  "a..b",
  "ab\u0000cd",
  "😀.example",
  "­.example",
];
const ADDRS: [number, string][] = [
  [4, "127.0.0.1"],
  [4, "255.255.255.255"],
  [4, "0.0.0.0"],
  [4, "1.2.3"],
  [4, "01.2.3.4"],
  [4, "256.1.1.1"],
  [4, " 1.2.3.4"],
  [6, "::"],
  [6, "::1"],
  [6, "2001:db8::ff00:42:8329"],
  [6, "2001:0db8:0000:0000:0000:ff00:0042:8329"],
  [6, "::ffff:192.0.2.128"],
  [6, "fe80::1%eth0"],
  [6, "1:2:3:4:5:6:7:8"],
  [6, "1:2:3:4:5:6:7:8:9"],
  [6, "1::2::3"],
  [6, "::1.2.3.4"],
  [6, "g::1"],
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-uv-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("libuv's computing parts, shaved from C", () => {
  const fixture = shaveCUnit(
    FIXTURE,
    ["yk_uv_errors", "yk_uv_idna", "yk_uv_inet"],
    ARGS,
    "clang",
    "node-uv.c",
  );
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const uv = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...uv.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !uv.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("libuv's parts shave with no refusal, their C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(uv.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const hosts = [
    ...HOSTS,
    ...fc.sample(fc.string({ unit: "binary", maxLength: 30 }), { numRuns: 60, seed: 1367 }),
  ];
  const addrs: [number, string][] = [
    ...ADDRS,
    ...fc.sample(
      fc.oneof(
        fc.ipV4().map((a) => [4, a] as [number, string]),
        fc.ipV6().map((a) => [6, a] as [number, string]),
        fc.ipV4Extended().map((a) => [4, a] as [number, string]),
      ),
      { numRuns: 60, seed: 1368 },
    ),
  ];

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
long yk_uv_errors(char *, long);
long yk_uv_idna(const char *, long, char *, long);
long yk_uv_inet(int, const char *, char *, long);
int main(void) {
  static char line[1 << 14], in[1 << 13], out[1 << 16];
  long r = yk_uv_errors(out, sizeof out);
  for (long i = 0; i < r; i++) putchar(out[i] == '\\n' ? '~' : out[i]);
  putchar('\\n');
  while (fgets(line, sizeof line, stdin)) {
    long n = 0; unsigned v;
    for (char *h = line + 2; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (char)v; }
    in[n] = 0;
    if (line[0] == 'h') {
      r = yk_uv_idna(in, n, out, 256);
      printf("%ld:", r);
      for (long i = 0; i < r; i++) printf("%02x", (unsigned char)out[i]);
    } else {
      r = yk_uv_inet(line[0] - '0', in, out, 256);
      fwrite(out, 1, r, stdout);
    }
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "uv");
    // (Only what the fixture reaches is linked: the event loop the common file names is not built.)
    execFileSync("clang", [
      ...ARGS,
      "-O1",
      "-ffunction-sections",
      "-fdata-sections",
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
      ...hosts.map((h) => `h ${hex(Buffer.from(h, "utf8"))}`),
      ...addrs.map(([f, a]) => `${f} ${hex(Buffer.from(a, "latin1"))}`),
    ];
    return execFileSync(exe, {
      input: `${lines.join("\n")}\n`,
      encoding: "latin1",
      maxBuffer: 1 << 26,
    })
      .split("\n")
      .slice(0, lines.length + 1);
  };

  it("errors equal Node's; IDNA and addresses equal native (as raised)", () => {
    const want = native();
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...uv.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...uv.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const cap = 1 << 16;
    const out = memory.leaves.__ykAlloc(cap, 16);
    const text = (n: number): string =>
      Buffer.from(memory.get(out, Math.max(0, n))).toString("latin1");
    const bad: string[] = [];
    // The errors: as native, and (each code's name and message) as Node's.
    const errs = text(Number((env.yk_uv_errors as Fn)(out, BigInt(cap)))).replaceAll("\n", "~");
    if (errs !== want[0])
      bad.push(`errors\n  shaved ${errs.slice(0, 300)}\n  C      ${want[0]?.slice(0, 300)}`);
    const map = util.getSystemErrorMap();
    for (const line of errs.split("~").filter(Boolean)) {
      const [code, name, ...msg] = line.split(" ");
      const n = map.get(Number(code));
      if (n === undefined) {
        if (code !== "-9999") bad.push(`error ${code} ${name}: not in Node's map`);
        continue;
      }
      if (n[0] !== name || n[1] !== msg.join(" ") || util.getSystemErrorName(Number(code)) !== name)
        bad.push(`error ${code}: shaved ${name} "${msg.join(" ")}", Node ${n[0]} "${n[1]}"`);
    }
    hosts.forEach((h, i) => {
      const b = [...Buffer.from(h, "utf8"), 0];
      let got: string;
      try {
        const r = Number((env.yk_uv_idna as Fn)(memory.put(b), BigInt(b.length - 1), out, 256n));
        got = `${r}:${r > 0 ? hex(memory.get(out, r)) : ""}`;
      } catch (e) {
        got = `trap: ${(e as Error).message}`;
      }
      if (got !== want[1 + i])
        bad.push(`idna ${JSON.stringify(h)}\n  shaved ${got}\n  C      ${want[1 + i]}`);
    });
    addrs.forEach(([f, a], i) => {
      const b = [...Buffer.from(a, "latin1"), 0];
      let got: string;
      try {
        got = text(Number((env.yk_uv_inet as Fn)(f, memory.put(b), out, 256n)));
      } catch (e) {
        got = `trap: ${(e as Error).message}`;
      }
      const w = want[1 + hosts.length + i];
      if (got !== w) bad.push(`inet ${f} ${a}\n  shaved ${got}\n  C      ${w}`);
    });
    expect(bad.slice(0, 8)).toEqual([]);
    expect(errs.split("~").length).toBeGreaterThan(70);
  }, 900_000);
});
