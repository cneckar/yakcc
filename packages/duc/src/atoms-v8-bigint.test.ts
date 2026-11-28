// SPDX-License-Identifier: Apache-2.0
/**
 * V8's BigInt library as the runtime links it (#1516): `atoms/v8-bigint.ts` is what shaving V8's
 * src/bigint and musl's memcpy, memset, memmove and abort gives now. Needs clang.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shaveV8BigIntLibrary } from "./__fixtures__/v8-bigint-library.js";
import { V8_BIGINT_ATOM_SOURCES, V8_BIGINT_STATICS } from "./atoms/v8-bigint.js";

const hasClang = (() => {
  try {
    execFileSync("clang++", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasClang)("V8's BigInt library, shaved (#1516)", () => {
  it("atoms/v8-bigint.ts equals shaving V8's src/bigint and musl's C library calls now", () => {
    const lib = shaveV8BigIntLibrary();
    expect(lib.refused).toEqual([]);
    expect(Object.fromEntries(lib.atoms)).toEqual(V8_BIGINT_ATOM_SOURCES);
    expect(Object.fromEntries(lib.statics)).toEqual(V8_BIGINT_STATICS);
  }, 900_000);
});
