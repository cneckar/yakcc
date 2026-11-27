// SPDX-License-Identifier: Apache-2.0
/**
 * Shave `Math`'s atoms (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1359, #1362): V8 12.4's `ieee754.cc`
 * (the V8 in Node v22) and musl's `scalbn.c`, through the C front end. `scripts/shave-math.ts` runs
 * this and writes `math.ts`; a test checks `math.ts` is what this gives. Needs clang.
 */
import { fileURLToPath } from "node:url";
import { shaveCUnit } from "../raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** musl's functions whose C meaning on doubles is `Math`'s: Math.floor, ceil, trunc, abs. */
export const MUSL_MATH = ["floor", "ceil", "trunc", "fabs"] as const;
/** musl's own include order (its internal headers: libm.h's FORCE_EVAL, sqrt's table). */
const MUSL_MATH_ARGS = (musl: string): string[] => [
  "-std=c11",
  "-nostdinc",
  "-ffreestanding",
  "-D_XOPEN_SOURCE=700",
  "-mlong-double-64",
  `-I${musl}yakcc`,
  `-I${musl}arch/x86_64`,
  `-I${musl}arch/generic`,
  `-I${musl}src/include`,
  `-I${musl}src/internal`,
  `-I${musl}obj/include`,
  `-I${musl}include`,
];

/** A shaved atom: the TypeScript the lifter reads, and the externals it references. */
export interface ShavedAtomSource {
  readonly source: string;
  readonly externals: readonly string[];
}

/** Every atom of `Math`, by name, and the refusals (none expected). */
export function shaveMathAtoms(): {
  readonly atoms: ReadonlyMap<string, ShavedAtomSource>;
  readonly refused: ReadonlyMap<string, string>;
} {
  const v8 = here("../../vendor/v8/");
  const musl = here("../../vendor/musl/");
  const ieee754 = shaveCUnit(
    `${v8}src/base/ieee754.cc`,
    ["ieee754::", "__kernel", "__ieee754"],
    ["-std=c++20", `-I${v8}`, `-I${v8}include`],
  );
  // musl's: scalbn (ieee754's callee), and the functions whose C meaning on doubles is Math's
  // (floor, ceil, trunc; fabs is Math.abs).
  const musls = ["scalbn", ...MUSL_MATH].map((f) =>
    shaveCUnit(`${musl}src/math/${f}.c`, [f], MUSL_MATH_ARGS(musl), "clang"),
  );
  const atoms = new Map([...ieee754.atoms, ...musls.flatMap((u) => [...u.atoms])]);
  return {
    atoms: new Map([...atoms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    refused: new Map([...ieee754.refused, ...musls.flatMap((u) => [...u.refused])]),
  };
}
