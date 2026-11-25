// SPDX-License-Identifier: Apache-2.0
// llhttp (#1367: Node's HTTP parser, vendor/node/deps/llhttp), shaved from its C sources (each
// file a unit) over musl shaved to the leaves. Requests and responses, valid and broken, fed in
// chunks of every size, with each lenient flag: every callback (through C function pointers),
// its data, and the parse's outcome are the same as the same sources compiled natively.
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

const LLHTTP = fileURLToPath(new URL("../vendor/node/deps/llhttp/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-llhttp.c", import.meta.url));
const ARGS = ["-std=c11", `-I${LLHTTP}include`];
const FILES = ["llhttp.c", "api.c", "http.c"].map((f) => join(LLHTTP, "src", f));

/** One parse: the stream, its type (0 either, 1 request, 2 response), chunk size, lenient bits. */
type Case = { bytes: number[]; type: number; step: number; lenient: number };

const CORPUS = [
  "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
  "GET /a/b?c=d#e HTTP/1.0\r\nConnection: keep-alive\r\n\r\n",
  "POST /submit HTTP/1.1\r\nContent-Length: 11\r\nContent-Type: text/plain\r\n\r\nhello world",
  "POST /chunked HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: x\r\n\r\n",
  "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nmissing",
  "HTTP/1.0 301 Moved\r\nLocation: /x\r\n\r\n",
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n\x81\x05hello",
  "GET /chat HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n\r\n",
  "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\ntunnel",
  "OPTIONS * HTTP/1.1\r\n\r\n",
  "GET / HTTP/1.1\r\nA: 1\r\n\r\nGET /two HTTP/1.1\r\nB: 2\r\n\r\n",
  "GET / HTTP/1.1\nHost: lf-only\n\n",
  "GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
  "GET / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
  "GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n0\r\n\r\n",
  "GET / HTTP/9.9\r\n\r\n",
  "BREW /pot HTTP/1.1\r\n\r\n",
  "GET / HTTP/1.1\r\nBad Header\r\n\r\n",
  "GET / HTTP/1.1\r\nX:  folded\r\n  continued\r\n\r\n",
  "HTTP/1.1 200\r\nTransfer-Encoding: chunked\r\n\r\nA \r\n0123456789\r\n0\r\n\r\n",
  "HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n",
  "HTTP/1.1 200 OK\r\n\r\nbody until close",
  "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
  "GET /\x7f HTTP/1.1\r\n\r\n",
  "GET / HTTP/1.1\r\nHost: \xe9\xe8\r\n\r\n",
  "\r\nGET / HTTP/1.1\r\n\r\n",
  "",
  "G",
];

const arbMessage: fc.Arbitrary<string> = fc
  .record({
    request: fc.boolean(),
    method: fc.constantFrom("GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "M-SEARCH", "SOURCE"),
    path: fc.constantFrom("/", "/x?y=z", "*", "http://h/p", "/%20sp"),
    version: fc.constantFrom("1.1", "1.0", "0.9", "2.0"),
    status: fc.integer({ min: 100, max: 599 }),
    eol: fc.constantFrom("\r\n", "\r\n", "\n"),
    headers: fc.array(
      fc.tuple(
        fc.constantFrom("Host", "X-A", "Connection", "Upgrade", "Accept", "content-length"),
        fc.constantFrom("a", "keep-alive", "close", "", " spaced ", "upgrade", "3"),
      ),
      { maxLength: 5 },
    ),
    body: fc.oneof(
      fc.constant({ kind: "none", text: "" }),
      fc.string({ maxLength: 40 }).map((t) => ({ kind: "length", text: t })),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 4 }).map((cs) => ({
        kind: "chunked",
        text: cs.map((c) => `${Buffer.byteLength(c).toString(16)}\r\n${c}\r\n`).join(""),
      })),
    ),
    tail: fc.string({ maxLength: 6 }),
  })
  .map((m) => {
    const start = m.request
      ? `${m.method} ${m.path} HTTP/${m.version}`
      : `HTTP/${m.version} ${m.status} Reason`;
    const hs = m.headers.map(([k, v]) => `${k}: ${v}`);
    if (m.body.kind === "length") hs.push(`Content-Length: ${Buffer.byteLength(m.body.text)}`);
    if (m.body.kind === "chunked") hs.push("Transfer-Encoding: chunked");
    const body = m.body.kind === "chunked" ? `${m.body.text}0\r\n\r\n` : m.body.text;
    return `${[start, ...hs].join(m.eol)}${m.eol}${m.eol}${body}${m.tail}`;
  });

const bytesOf = (s: string): number[] => [...Buffer.from(s, "latin1")];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-c-llhttp-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("llhttp, Node's HTTP parser, shaved from C", () => {
  const fixture = shaveCUnit(FIXTURE, ["yk_http"], ARGS, "clang", "node-llhttp.c");
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const llhttp = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...llhttp.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !llhttp.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("llhttp shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(llhttp.refused).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const all: Case[] = [
    ...CORPUS.flatMap((s) =>
      [0, 1, 3, 7].map((step) => ({ bytes: bytesOf(s), type: 0, step, lenient: 0 })),
    ),
    ...fc.sample(
      fc.record({
        bytes: fc.oneof(
          arbMessage.map(bytesOf),
          // A message with a byte changed.
          fc
            .tuple(arbMessage, fc.nat(200), fc.integer({ min: 0, max: 255 }))
            .map(([m, at, v]) => {
              const b = bytesOf(m);
              if (b.length > 0) b[at % b.length] = v;
              return b;
            }),
          fc
            .tuple(fc.constantFrom(...CORPUS), fc.nat(80))
            .map(([s, cut]) => bytesOf(s).slice(0, cut)),
        ),
        type: fc.constantFrom(0, 1, 2),
        step: fc.constantFrom(0, 1, 2, 5, 16),
        lenient: fc.oneof(fc.constant(0), fc.nat(2047)),
      }),
      { numRuns: 300, seed: 1367 },
    ),
  ];

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
long yk_http(const char *, long, int, int, int, char *, long);
static char line[1 << 16], in[1 << 14], out[1 << 16];
int main(void) {
  int type, step, lenient;
  while (fgets(line, sizeof line, stdin)) {
    char *h = line; int n = 0, used = 0; unsigned v;
    sscanf(h, "%d %d %d x%n", &type, &step, &lenient, &used);
    for (h += used; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (char)v; }
    long r = yk_http(in, n, type, step, lenient, out, sizeof out);
    for (long i = 0; i < r; i++) printf("%02x", (unsigned char)out[i]);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const exe = join(work, "llhttp");
    execFileSync("clang", [...ARGS, "-O1", driver, FIXTURE, ...FILES, "-o", exe]);
    const input = all.map((c) => `${c.type} ${c.step} ${c.lenient} x${hex(c.bytes)}`).join("\n");
    return execFileSync(exe, { input: `${input}\n`, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n")
      .slice(0, all.length);
  };

  for (const lowered of [false, true])
    it(`each parse's callbacks, data and outcome equal native (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const want = native();
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        new Map([...musl.atoms, ...llhttp.atoms, ...fixture.atoms]),
        lowered,
        memory,
        [...musl.units, ...llhttp.units, fixture],
        system.leaves as unknown as Record<string, Fn>,
      );
      env.yk_musl_init?.();
      const cap = 1 << 16;
      const out = memory.leaves.__ykAlloc(cap, 16);
      const got = all.map((c) => {
        const p = memory.put(c.bytes.length > 0 ? c.bytes : [0]);
        try {
          const n = Number(
            (env.yk_http as Fn)(
              p,
              BigInt(c.bytes.length),
              c.type,
              c.step,
              c.lenient,
              out,
              BigInt(cap),
            ),
          );
          return hex(memory.get(out, n));
        } catch (e) {
          return `trap: ${(e as Error).message}`;
        }
      });
      const text = (h: string | undefined): string =>
        h?.startsWith("trap") ? h : Buffer.from(h ?? "", "hex").toString("latin1");
      const bad = got.flatMap((g, i) =>
        g === want[i]
          ? []
          : [
              `${JSON.stringify({ ...all[i], bytes: Buffer.from(all[i]?.bytes ?? []).toString("latin1") })}\n  shaved ${text(g).slice(0, 300)}\n  C      ${text(want[i]).slice(0, 300)}`,
            ],
      );
      expect(bad.slice(0, 5)).toEqual([]);
      // (The parses reach every outcome: complete messages, and errors.)
      const ends = new Set(want.map((w) => /end (\w+)/.exec(text(w))?.[1]));
      expect(ends.has("HPE_OK")).toBe(true);
      expect(ends.size).toBeGreaterThan(5);
    }, 900_000);
});
