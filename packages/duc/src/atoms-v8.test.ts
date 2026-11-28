// SPDX-License-Identifier: Apache-2.0
/**
 * V8's code as the runtime links it (#1516): `atoms/v8-bigint.ts` and `atoms/v8-numbers.ts` are what
 * shaving V8's src/bigint and its number conversions (with ICU's uchar.cpp and the C library's
 * calls, musl's) gives now. Needs clang.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shaveV8BigIntLibrary } from "./__fixtures__/v8-bigint-library.js";
import { shaveV8NumbersLibrary } from "./__fixtures__/v8-numbers-library.js";
import { V8_BIGINT_ATOM_SOURCES, V8_BIGINT_STATICS } from "./atoms/v8-bigint.js";
import { V8_NUMBERS_ATOM_SOURCES, V8_NUMBERS_STATICS } from "./atoms/v8-numbers.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasClang)("V8's code the runtime links, shaved (#1516)", () => {
  it("atoms/v8-bigint.ts equals shaving V8's src/bigint and musl's C library calls now", () => {
    const lib = shaveV8BigIntLibrary();
    expect(lib.refused).toEqual([]);
    expect(Object.fromEntries(lib.atoms)).toEqual(V8_BIGINT_ATOM_SOURCES);
    expect(Object.fromEntries(lib.statics)).toEqual(V8_BIGINT_STATICS);
  }, 900_000);

  it("atoms/v8-numbers.ts equals shaving V8's number conversions now; only V8's fatal paths left", () => {
    const lib = shaveV8NumbersLibrary();
    expect(lib.refused).toEqual([]);
    expect(lib.externals.every((x) => /Fatal|Platform/.test(x))).toBe(true);
    expect(Object.fromEntries(lib.atoms)).toEqual(V8_NUMBERS_ATOM_SOURCES);
    expect(Object.fromEntries(lib.statics)).toEqual(V8_NUMBERS_STATICS);
  }, 1_800_000);
});
