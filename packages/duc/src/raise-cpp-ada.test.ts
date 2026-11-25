// SPDX-License-Identifier: Apache-2.0
// The C++ front end on ada (#1367: Node's WHATWG URL parser, vendor/ada), shaved whole through
// libstdc++'s std::string, std::optional and tl::expected, its IDNA and Unicode tables and its SSE2
// paths, over musl shaved to the leaves. Each URL, parsed against a base or not, gives the same
// components (or the same failure) as the same sources compiled natively.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
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

const ADA = fileURLToPath(new URL("../vendor/ada/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/ada-run.cpp", import.meta.url));
const ARGS = ["-std=c++17", "-DNDEBUG", "-D_GLIBCXX_ASSERTIONS", `-I${ADA}`];

/** Each case: a URL, and the base it is parsed against (none: undefined). */
const CASES: readonly [string, string?][] = [
  ["https://example.com"],
  ["https://user:pass@sub.example.com:8080/p/a/t/h?query=string#hash"],
  ["HTTP://EXAMPLE.COM/A/../B/./C"],
  ["http://example.com:80/"],
  ["https://example.com:443/x"],
  ["ftp://ftp.example.org:21/file.txt"],
  ["ws://localhost:3000/socket"],
  ["file:///C:/Windows/System32"],
  ["file://server/share/file"],
  ["mailto:someone@example.com"],
  ["javascript:alert(1)"],
  ["data:text/plain;base64,SGVsbG8="],
  ["http://[::1]:8080/"],
  ["http://[2001:db8::ff00:42:8329]/"],
  ["http://[::ffff:192.0.2.128]/"],
  ["http://192.168.0.1/"],
  ["http://0x7f.1/"],
  ["http://127.0.0.1.:80/"],
  ["http://4294967295/"],
  ["http://4294967296/"],
  ["http://example.com/%7Efoo/%7ebar"],
  ["http://example.com/a b?c d#e f"],
  ["http://example.com/\u00e9t\u00e9?\u00e7a=\u00e0#\u00fc"],
  ["https://m\u00fcnchen.de/"],
  ["https://\u0444\u0443\u043d\u043a\u0446\u0438\u044f.\u0440\u0444/"],
  ["https://xn--mnchen-3ya.de/"],
  ["https://EXAMPLE.\u3002com/"],
  ["https://faß.de/"],
  ["http://a.b.c.d.e/"],
  ["http://ex ample.com/"],
  ["http://exa%mple.com/"],
  ["http://[::1/"],
  ["http://:80/"],
  ["https://"],
  ["not a url"],
  [""],
  ["  https://trimmed.example.com/  "],
  ["https://example.com/\t\nwith/tabs"],
  ["https://example.com?a=1&b=2&a=3"],
  ["https://example.com/#"],
  ["https://example.com/?"],
  ["blob:https://example.com/uuid"],
  ["../up/one", "https://example.com/a/b/c"],
  ["./same", "https://example.com/a/b/c"],
  ["/absolute/path", "https://example.com/a/b/c"],
  ["?only=query", "https://example.com/a/b?old=1#h"],
  ["#only-hash", "https://example.com/a/b?q"],
  ["//other.host/x", "https://example.com/a"],
  ["https://full.example/", "https://example.com/a"],
  ["", "https://example.com/a?b#c"],
  ["..", "file:///a/b/c"],
  ["x", "mailto:a@b"],
  ["x", "not a base"],
  ["http:relative", "http://example.com/dir/"],
  ["\\\\backslash\\path", "http://example.com/"],
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-ada-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("ada, Node's URL parser, shaved from C++", () => {
  const unit = shaveCUnit(FIXTURE, ["yk_url"], ARGS, "clang++", "ada-run.cpp");
  const externals = [...new Set([...unit.atoms.values()].flatMap((a) => a.externals))].filter(
    (x) => !unit.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(externals));

  it("the parser shaves with no refusal, its C library down to the leaves", () => {
    expect([...unit.refused]).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
    expect(unit.atoms.size).toBeGreaterThan(700);
  });

  const hexOf = (s: string): string => Buffer.from(s, "utf8").toString("hex");

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
#include <string.h>
int yk_url(const char *in, int n, const char *base, int bn, char *out, int cap);
static int unhex(const char *h, char *out) {
  int n = 0; unsigned v;
  for (; h[0] && h[0] != ' ' && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); out[n++] = (char)v; }
  return n;
}
int main(void) {
  static char line[1 << 16], in[1 << 14], base[1 << 14], out[1 << 16];
  while (fgets(line, sizeof line, stdin)) {
    char *sp = strchr(line, ' ');
    int n = unhex(line + 1, in);
    int bn = line[0] == 'b' ? unhex(sp + 1, base) : -1;
    int r = yk_url(in, n, base, bn, out, sizeof out);
    printf("%d:", r);
    for (int i = 0; i < r; i++) putchar(out[i] == '\\n' ? '~' : out[i]);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const obj = join(work, "ada-run.o");
    execFileSync("clang++", [...ARGS, "-O0", "-c", FIXTURE, "-o", obj], { maxBuffer: 1 << 26 });
    const exe = join(work, "ada");
    execFileSync("clang++", ["-x", "c", driver, "-x", "none", obj, "-o", exe]);
    const input = CASES.map(([u, b]) =>
      b === undefined ? `u${hexOf(u)} -` : `b${hexOf(u)} ${hexOf(b)}`,
    );
    return execFileSync(exe, { input: `${input.join("\n")}\n`, encoding: "utf8" })
      .split("\n")
      .slice(0, CASES.length);
  };

  it("each URL's components equal the native parser's (as raised)", () => {
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
    const cap = 1 << 16;
    const out = L.__ykAlloc(cap, 16);
    const got = CASES.map(([u, b]) => {
      const ub = [...Buffer.from(u, "utf8")];
      const bb = b === undefined ? [] : [...Buffer.from(b, "utf8")];
      const pu = memory.put([...ub, 0]);
      const pb = memory.put([...bb, 0]);
      let r: unknown;
      try {
        r = (env.yk_url as Fn)(pu, ub.length, pb, b === undefined ? -1 : bb.length, out, cap);
      } catch (e) {
        return `trap: ${(e as Error).message}`;
      }
      const n = Number(r);
      const text = n > 0 ? Buffer.from(memory.get(out, n)).toString("latin1") : "";
      return `${n}:${text.replaceAll("\n", "~")}`;
    });
    const nativeLatin1 = want.map((w) => Buffer.from(w, "utf8").toString("latin1"));
    const bad = got.flatMap((g, i) =>
      g === nativeLatin1[i]
        ? []
        : [`${JSON.stringify(CASES[i])}\n  shaved ${g}\n  C++    ${nativeLatin1[i]}`],
    );
    expect(bad).toEqual([]);
  }, 900_000);
});
