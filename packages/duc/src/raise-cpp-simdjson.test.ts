// SPDX-License-Identifier: Apache-2.0
// The C++ front end on simdjson (#1367: Node's JSON parser for package.json, vendor/node/deps/
// simdjson, 4.5.0, its portable kernel), shaved with its on-demand API's templates over musl shaved
// to the leaves. package.json texts, well formed and broken, read as Node's module loader reads them:
// every field's key, type and value (strings unescaped, objects and arrays raw), or the error, equal
// the same C++ compiled natively.
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

const SIMDJSON = fileURLToPath(new URL("../vendor/node/deps/simdjson/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-simdjson.cpp", import.meta.url));
const ARGS = [
  "-std=c++20",
  "-DNDEBUG",
  "-DSIMDJSON_IMPLEMENTATION_HASWELL=0",
  "-DSIMDJSON_IMPLEMENTATION_ICELAKE=0",
  "-DSIMDJSON_IMPLEMENTATION_WESTMERE=0",
  "-DSIMDJSON_IMPLEMENTATION_FALLBACK=1",
  `-I${SIMDJSON}`,
];

const DOCS = [
  '{"name":"yakcc","version":"1.0.0","main":"index.js","type":"module"}',
  '{"name":"x","exports":{".":{"import":"./a.mjs","require":"./a.cjs"},"./sub":"./sub.js"},"imports":{"#dep":"./dep.js"}}',
  '{ "name" : "spaced\\tname\\u00e9\\ud83d\\ude00", "private" : true, "files" : [ "a", "b" ], "n": -1.5e3 }',
  '{"name":"esc\\"aped\\\\\\/","main":null,"x":0,"y":1e400}',
  '{"exports":"./only.js"}',
  "{}",
  "[]",
  '{"name":',
  '{"name":"x",}',
  '{"a":1 "b":2}',
  "",
  '"just a string"',
  '{"bad":"\\u12"}',
  '{"deep":[[[[[[[[[[1]]]]]]]]]]}',
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-simdjson-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("simdjson, Node's package.json reader, shaved from C++", () => {
  const unit = shaveCUnit(FIXTURE, ["yk_package_json"], ARGS, "clang++", "node-simdjson.cpp");
  const externals = [...new Set([...unit.atoms.values()].flatMap((a) => a.externals))].filter(
    (x) => !unit.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(externals));

  it("simdjson shaves with no refusal, its C library down to the leaves", () => {
    expect([...unit.refused].slice(0, 20)).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  const docs = [
    ...DOCS,
    ...fc.sample(
      fc.json({ maxDepth: 3 }).map((j) => (j.startsWith("{") ? j : `{"v":${j}}`)),
      { numRuns: 60, seed: 1367 },
    ),
    ...fc.sample(
      fc
        .tuple(fc.json({ maxDepth: 2 }), fc.nat(200), fc.constantFrom("}", ",", '"', "\\", "x", ""))
        .map(([j, at, c]) => {
          const s = j.startsWith("{") ? j : `{"v":${j}}`;
          const i = at % (s.length + 1);
          return s.slice(0, i) + c + s.slice(i + 1);
        }),
      { numRuns: 40, seed: 1368 },
    ),
  ];

  const native = (): string[] => {
    const driver = join(work, "driver.c");
    writeFileSync(
      driver,
      `#include <stdio.h>
long yk_package_json(const char *, long, char *, long);
int main(void) {
  static char line[1 << 16], in[1 << 15], out[1 << 16];
  while (fgets(line, sizeof line, stdin)) {
    long n = 0; unsigned v;
    for (char *h = line + 1; h[0] && h[0] != '\\n'; h += 2) { sscanf(h, "%2x", &v); in[n++] = (char)v; }
    long r = yk_package_json(in, n, out, sizeof out);
    for (long i = 0; i < r; i++) printf("%02x", (unsigned char)out[i]);
    putchar('\\n');
  }
  return 0;
}
`,
    );
    const obj = join(work, "simdjson.o");
    execFileSync("clang++", [...ARGS, "-O1", "-c", FIXTURE, "-o", obj], { maxBuffer: 1 << 26 });
    const exe = join(work, "simdjson");
    execFileSync("clang++", ["-x", "c", driver, "-x", "none", obj, "-o", exe]);
    return execFileSync(exe, {
      input: `${docs.map((d) => `x${hex(Buffer.from(d, "utf8"))}`).join("\n")}\n`,
      encoding: "latin1",
      maxBuffer: 1 << 26,
    })
      .split("\n")
      .slice(0, docs.length);
  };

  for (const lowered of [false, true])
    it(`each document's fields (or its error) equal native (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const want = native();
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        new Map([...musl.atoms, ...unit.atoms]),
        lowered,
        memory,
        [...musl.units, unit],
        system.leaves as unknown as Record<string, Fn>,
      );
      env.yk_musl_init?.();
      const cap = 1 << 16;
      const out = memory.leaves.__ykAlloc(cap, 16);
      const bad: string[] = [];
      docs.forEach((d, i) => {
        const b = [...Buffer.from(d, "utf8")];
        let got: string;
        try {
          const n = Number(
            (env.yk_package_json as Fn)(
              memory.put(b.length > 0 ? b : [0]),
              BigInt(b.length),
              out,
              BigInt(cap),
            ),
          );
          got = n > 0 ? hex(memory.get(out, n)) : "";
        } catch (e) {
          got = `trap: ${(e as Error).message}`;
        }
        const text = (h: string | undefined): string =>
          h?.startsWith("trap") ? h : Buffer.from(h ?? "", "hex").toString("utf8");
        if (got !== want[i])
          bad.push(
            `${d.slice(0, 80)}\n  shaved ${text(got).slice(0, 200)}\n  C++    ${text(want[i]).slice(0, 200)}`,
          );
      });
      expect(bad.slice(0, 5)).toEqual([]);
    }, 1_800_000);
});
