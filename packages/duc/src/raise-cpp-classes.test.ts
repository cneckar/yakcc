// SPDX-License-Identifier: Apache-2.0
// The C++ front end on classes (#1364): methods with `this`, constructors with member and base
// initializers, destructors run when a block is left (in reverse, on every way out), references,
// operators, virtual calls through vtables (a second base's too), new/delete, and a lambda. The fixture's entry points
// run shaved over the memory leaves and compiled natively; each result must be the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link } from "./__fixtures__/c-link.js";
import { createCMemory, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/classes.cpp", import.meta.url));
/** Each entry point and its arity. */
const ENTRIES: readonly [string, number][] = [
  ["yk_point", 2],
  ["yk_guards", 1],
  ["yk_shapes", 2],
  ["yk_refs", 2],
  ["yk_box", 2],
  ["yk_modern", 2],
  ["yk_multi", 2],
];

const work = mkdtempSync(join(tmpdir(), "yakcc-raise-cpp-classes-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasClang)("C++ classes, shaved", () => {
  const unit = shaveCUnit(
    FIXTURE,
    ENTRIES.map(([n]) => n),
    ["-std=c++17"],
    "clang++",
    "classes.cpp",
  );

  it("every entry, and every member function and constructor it uses, shaves with no refusal", () => {
    expect([...unit.refused]).toEqual([]);
    for (const [n] of ENTRIES) expect(unit.atoms.has(n), n).toBe(true);
  });

  const cases = (seed: number): [string, number, number][] =>
    ENTRIES.flatMap(([n]) =>
      fc
        .sample(
          fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 })),
          {
            numRuns: 40,
            seed,
          },
        )
        .map(([a, b]): [string, number, number] => [n, a, b]),
    );

  let exe = "";
  const native = (all: readonly [string, number, number][]): string[] => {
    if (exe === "") {
      const driver = join(work, "driver.c");
      writeFileSync(
        driver,
        `#include <stdio.h>
#include <string.h>
${ENTRIES.map(([n, k]) => `int ${n}(${Array.from({ length: k }, () => "int").join(", ")});`).join("\n")}
int main(void) {
  char f[64]; int a, b;
  while (scanf("%63s %d %d", f, &a, &b) == 3) {
${ENTRIES.map(([n, k]) => `    if (!strcmp(f, "${n}")) printf("%d\\n", ${n}(${k === 1 ? "a" : "a, b"}));`).join("\n")}
  }
  return 0;
}
`,
      );
      const obj = join(work, "classes.o");
      execFileSync("clang++", ["-std=c++17", "-O0", "-fwrapv", "-c", FIXTURE, "-o", obj]);
      exe = join(work, "classes");
      execFileSync("clang++", ["-O0", "-x", "c", driver, "-x", "none", obj, "-o", exe]);
    }
    return execFileSync(exe, {
      input: `${all.map((c) => c.join(" ")).join("\n")}\n`,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
  };

  for (const lowered of [false, true]) {
    it(`each entry equals the C++ compiled natively (${lowered ? "lifted to a graph and lowered" : "as raised"})`, () => {
      const all = cases(lowered ? 1364 : 13640);
      const want = native(all);
      const env = link(unit.atoms, lowered, createCMemory(), [unit]);
      const arity = new Map(ENTRIES);
      const got = all.map(([n, a, b]) =>
        String((env[n] as Fn)(...(arity.get(n) === 1 ? [a] : [a, b]))),
      );
      const bad = got.flatMap((g, i) =>
        g === want[i] ? [] : [`${all[i]?.join(" ")}: shaved ${g}, C++ ${want[i]}`],
      );
      expect(bad.slice(0, 8)).toEqual([]);
    }, 900_000);
  }
});
