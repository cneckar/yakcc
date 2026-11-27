// SPDX-License-Identifier: Apache-2.0
/**
 * Shave `Math`'s atoms (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1359, #1362): V8 12.4's `ieee754.cc`
 * (the V8 in Node v22) and musl's `scalbn.c`, through the C front end. `scripts/shave-math.ts` runs
 * this and writes `math.ts`; a test checks `math.ts` is what this gives. Needs clang.
 */
import { fileURLToPath } from "node:url";
import { type StaticDef, shaveCUnit } from "../raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** musl's functions whose C meaning on doubles is `Math`'s: Math.floor, ceil, trunc, abs, sqrt. */
export const MUSL_MATH = ["floor", "ceil", "trunc", "fabs", "sqrt"] as const;
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
  const musls = ["scalbn", "__math_invalid", ...MUSL_MATH].map((f) =>
    shaveCUnit(`${musl}src/math/${f}.c`, [f], MUSL_MATH_ARGS(musl), "clang"),
  );
  // sqrt's table, from the file that defines it: constant data, written into the atoms.
  const tables = shaveCUnit(
    `${musl}src/math/sqrt_data.c`,
    [],
    MUSL_MATH_ARGS(musl),
    "clang",
    "sqrt_data",
    ["__rsqrt_tab"],
  );
  const statics = new Map([...musls.flatMap((u) => [...u.statics]), ...tables.statics]);
  const atoms = new Map(
    [...ieee754.atoms, ...musls.flatMap((u) => [...u.atoms])].map(([k, a]) => [
      k,
      { ...a, source: withConstants(a.source, statics) },
    ]),
  );
  return {
    atoms: new Map([...atoms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    refused: new Map([
      ...ieee754.refused,
      ...musls.flatMap((u) => [...u.refused]),
      ...tables.refused,
    ]),
  };
}

/** A static of values alone, as its bytes (little-endian), or undefined. */
function constantBytes(def: StaticDef): number[] | undefined {
  if (def.at !== undefined) return undefined;
  const bytes = new DataView(new ArrayBuffer(Math.max(def.size, 1)));
  const SIZE: Record<string, number> = {
    i8: 1,
    u8: 1,
    i16: 2,
    u16: 2,
    i32: 4,
    u32: 4,
    i64: 8,
    u64: 8,
    f32: 4,
    f64: 8,
  };
  for (const item of def.init) {
    if (!("value" in item)) return undefined;
    const n = SIZE[item.kind];
    if (n === undefined || item.offset + n > def.size) return undefined;
    const v = item.value;
    if (item.kind === "f64") bytes.setFloat64(item.offset, Number(v), true);
    else if (item.kind === "f32") bytes.setFloat32(item.offset, Number(v), true);
    else if (n === 8) bytes.setBigUint64(item.offset, BigInt.asUintN(64, BigInt(v)), true);
    else if (n === 4) bytes.setUint32(item.offset, Number(v) >>> 0, true);
    else if (n === 2) bytes.setUint16(item.offset, Number(v) & 0xffff, true);
    else bytes.setUint8(item.offset, Number(v) & 0xff);
  }
  return [...new Uint8Array(bytes.buffer).slice(0, def.size)];
}

/**
 * An atom's reads of constant statics (a table of values, C's `const` data) as the constants
 * themselves: `__ykStatic("key")` the address of the bytes, `__ykData("u8", [..])`, in the atom.
 */
function withConstants(source: string, statics: ReadonlyMap<string, StaticDef>): string {
  return source.replace(/__ykStatic\("([^"]+)"\)/g, (call, key: string) => {
    const def = statics.get(key);
    const bytes = def === undefined ? undefined : constantBytes(def);
    return bytes === undefined ? call : `__ykData("u8", [${bytes.join(", ")}])`;
  });
}
