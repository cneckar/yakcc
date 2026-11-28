// SPDX-License-Identifier: Apache-2.0
// C++ statics and offsetof as V8's heap setup has them, shaved: equal to the same code compiled
// natively (DEC-DUC-V8-OBJECT-MODEL-001).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Fn, link, runInitializers } from "./__fixtures__/c-link.js";
import { shaveMusl } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const FIXTURE = here("./__fixtures__/cxx/v8-statics.cc");
const work = mkdtempSync(join(tmpdir(), "yakcc-cxx-statics-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("C++ statics and offsetof, as V8's heap setup has them", () => {
  it("a constexpr std::initializer_list read by a range-for, offsetof by function, and a static member read through an object (V8's read-only flags), and V8's `rep stosq` MemsetPointer, equal native", () => {
    writeFileSync(
      join(work, "main.cc"),
      `#include "${FIXTURE}"\n#include <cstdio>\nint main() { printf("%d %d %d %d %ld %ld\\n", table_sum(), offsets(5), offsets(-9), flags_read(2), memset_words(5), memset_words(0)); }\n`,
    );
    execFileSync("clang++", ["-std=c++20", "main.cc", "-o", "main"], { cwd: work });
    const want = execFileSync(join(work, "main"), { encoding: "utf8" }).trim();
    const unit = shaveCUnit(
      FIXTURE,
      ["_Z9table_sumv", "_Z7offsetsi", "_Z10flags_readi", "_Z12memset_wordsi"],
      ["-std=c++20"],
      "clang++",
      "v8-statics.cc",
      [],
      true,
    );
    expect([...unit.refused]).toEqual([]);
    const musl = shaveMusl(["strlen"]);
    for (const lowered of [false, true]) {
      const memory = createCMemory();
      const system = createCSystem(memory);
      const env = link(
        new Map([...musl.atoms, ...unit.atoms]),
        lowered,
        memory,
        [...musl.units, unit],
        system.leaves as unknown as Record<string, Fn>,
      );
      // (Its globals constructed, as a program's startup does: the flags.)
      runInitializers(env as Record<string, Fn>, [unit]);
      const got = [
        (env._Z9table_sumv as Fn)(),
        (env._Z7offsetsi as Fn)(5),
        (env._Z7offsetsi as Fn)(-9),
        (env._Z10flags_readi as Fn)(2),
        (env._Z12memset_wordsi as Fn)(5),
        (env._Z12memset_wordsi as Fn)(0),
      ].join(" ");
      expect(got).toBe(want);
    }
  }, 600_000);
});
