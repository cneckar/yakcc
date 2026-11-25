// SPDX-License-Identifier: Apache-2.0
// c-ares (#1367: Node's DNS library, vendor/node/deps/cares, 1.34.9), shaved from its C sources
// (each file a unit) over musl shaved to the leaves, as Node builds it for Linux (cares.gyp). DNS
// responses, well formed (every record type Node's dns.resolve* reads, names compressed or not),
// corrupted and truncated, through each reply parser Node uses and through the record layer
// (parsed, written back, parsed again): every result equals the same sources compiled natively.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const CARES = fileURLToPath(new URL("../vendor/node/deps/cares/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-cares.c", import.meta.url));
/** cares.gyp's for Linux. */
const ARGS = [
  "-std=gnu11",
  "-DCARES_STATICLIB",
  "-DHAVE_CONFIG_H",
  "-D_LARGEFILE_SOURCE",
  "-D_FILE_OFFSET_BITS=64",
  "-D_GNU_SOURCE",
  // (Node's own code calls the reply parsers c-ares marks deprecated; cares.gyp lets it.)
  "-Wno-deprecated-declarations",
  `-I${CARES}include`,
  `-I${CARES}src/lib`,
  `-I${CARES}src/lib/include`,
  `-I${CARES}config/linux`,
];
const FILES = ((dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".c")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
})(join(CARES, "src/lib"));

// --- DNS messages (RFC 1035): names as labels or a pointer to the question's (offset 12).
const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
const u32 = (v: number): number[] => [...u16(v >>> 16), ...u16(v & 0xffff)];
const label = (s: string): number[] => [s.length, ...Buffer.from(s, "latin1")];
const name = (n: string): number[] =>
  n === "@" ? [0xc0, 12] : [...n.split(".").filter(Boolean).flatMap(label), 0];
const charString = (s: string): number[] => label(s.slice(0, 255));

type Rec = { type: number; name: string; ttl: number; rdata: number[] };
const arbName = fc.oneof(
  fc.constant("@"),
  fc
    .array(
      fc.constantFrom("example", "com", "www", "mail", "a", "b-c", "_sip", "_tcp", "xn--bcher-kva"),
      {
        minLength: 1,
        maxLength: 4,
      },
    )
    .map((ls) => ls.join(".")),
);
const arbRec: fc.Arbitrary<Rec> = fc
  .tuple(
    fc.constantFrom(1, 28, 15, 2, 16, 33, 12, 35, 6, 257, 5),
    arbName,
    fc.nat(0x7fffffff),
    fc.uint8Array({ minLength: 16, maxLength: 16 }),
    arbName,
    fc.array(fc.string({ maxLength: 20 }), { minLength: 1, maxLength: 3 }),
    fc.nat(65535),
  )
  .map(([type, n, ttl, bytes, target, texts, num]) => {
    const b = [...bytes];
    const rdata =
      type === 1
        ? b.slice(0, 4)
        : type === 28
          ? b
          : type === 15
            ? [...u16(num), ...name(target)]
            : type === 2 || type === 12 || type === 5
              ? name(target)
              : type === 16
                ? texts.flatMap(charString)
                : type === 33
                  ? [...u16(num), ...u16(num ^ 7), ...u16(num & 0x3fff), ...name(target)]
                  : type === 35
                    ? [
                        ...u16(num),
                        ...u16(num >> 3),
                        ...charString("S"),
                        ...charString("SIP+D2U"),
                        ...charString(texts[0] ?? ""),
                        ...name(target),
                      ]
                    : type === 6
                      ? [
                          ...name(target),
                          ...name("host.master"),
                          ...u32(num * 7),
                          ...u32(3600),
                          ...u32(600),
                          ...u32(86400),
                          ...u32(ttl & 0xffff),
                        ]
                      : [
                          num & 128,
                          ...charString("issue"),
                          ...Buffer.from(texts[0] ?? "", "latin1"),
                        ];
    return { type, name: n, ttl, rdata };
  });

const message = (
  id: number,
  flags: number,
  q: string,
  qtype: number,
  sections: [Rec[], Rec[], Rec[]],
): number[] => [
  ...u16(id),
  ...u16(flags),
  ...u16(1),
  ...u16(sections[0].length),
  ...u16(sections[1].length),
  ...u16(sections[2].length),
  ...name(q === "@" ? "example.com" : q),
  ...u16(qtype),
  ...u16(1),
  ...sections
    .flat()
    .flatMap((r) => [
      ...name(r.name),
      ...u16(r.type),
      ...u16(1),
      ...u32(r.ttl),
      ...u16(r.rdata.length),
      ...r.rdata,
    ]),
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-cares-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("c-ares, Node's DNS library, shaved from C", () => {
  const fixture = shaveCUnit(FIXTURE, ["yk_dns"], ARGS, "clang", "node-cares.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const cares = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...cares.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !cares.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("c-ares shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(cares.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all: number[][] = fc.sample(
    fc
      .tuple(
        fc.nat(65535),
        fc.constantFrom(0x8180, 0x8580, 0x8183, 0x8182, 0x0100, 0x8380),
        arbName,
        fc.constantFrom(1, 28, 15, 2, 16, 33, 12, 35, 6, 257),
        fc.tuple(
          fc.array(arbRec, { maxLength: 4 }),
          fc.array(arbRec, { maxLength: 2 }),
          fc.array(arbRec, { maxLength: 2 }),
        ),
        fc.oneof(fc.constant("whole"), fc.constant("flip"), fc.constant("cut")),
        fc.nat(1000),
      )
      .map(([id, flags, q, qtype, s, how, at]) => {
        const m = message(id, flags, q, qtype, s as [Rec[], Rec[], Rec[]]);
        if (how === "flip" && m.length > 0) m[at % m.length] = (m[at % m.length] as number) ^ 0x5a;
        return how === "cut" ? m.slice(0, at % (m.length + 1)) : m;
      }),
    { numRuns: 200, seed: 1367 },
  );

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
long yk_dns(const unsigned char *, long, char *, long);
int main(void) {
  static char line[1 << 16], out[1 << 18];
  static unsigned char m[1 << 15];
  while (fgets(line, sizeof line, stdin)) {
    long n = 0; unsigned v;
    for (char *h = line + 1; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); m[n++] = (unsigned char)v; }
    long r = yk_dns(m, n, out, sizeof out);
    for (long i = 0; i < r; i++) putchar(out[i] == '\\n' ? '~' : out[i]);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "cares");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-o", exe]);
    return execFileSync(exe, {
      input: `${all.map((m) => `x${hex(m)}`).join("\n")}\n`,
      encoding: "latin1",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .slice(0, all.length);
  };

  it("every reply parser's result and the record layer's equal native (as raised)", () => {
    const want = native();
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...cares.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...cares.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const cap = 1 << 18;
    const out = memory.leaves.__ykAlloc(cap, 16);
    const got = all.map((m) => {
      try {
        const p = memory.put(m.length > 0 ? m : [0]);
        const n = Number((env.yk_dns as Fn)(p, BigInt(m.length), out, BigInt(cap)));
        return Buffer.from(memory.get(out, n)).toString("latin1").replaceAll("\n", "~");
      } catch (e) {
        return `trap: ${(e as Error).message}`;
      }
    });
    const bad = got.flatMap((g, i) =>
      g === want[i]
        ? []
        : [
            `${hex(all[i] ?? []).slice(0, 120)}\n  shaved ${g.slice(0, 400)}\n  C      ${want[i]?.slice(0, 400)}`,
          ],
    );
    expect(bad.slice(0, 5)).toEqual([]);
    // (The parsers succeed on the well-formed answers of their type, and fail on the others.)
    expect(want.some((w) => / A 0 name=/.test(` ${w}`))).toBe(true);
    expect(want.some((w) => /MX 0 \d/.test(w))).toBe(true);
    expect(want.some((w) => /RECORD 0 .* write 0 .* again 0/.test(w))).toBe(true);
  }, 1_800_000);
});
