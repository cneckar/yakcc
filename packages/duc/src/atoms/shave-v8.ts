// SPDX-License-Identifier: Apache-2.0
/**
 * Shave V8's C++ that touches no V8 object (#1516): `src/bigint` (BigInt's digit arithmetic), as one
 * unit (`v8/bigint.cc`, its files as V8 builds them), with the C++ front end. Needs clang.
 */
import { fileURLToPath } from "node:url";
import { type ShavedUnit, shaveCUnit } from "../raise-c.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** The processor's methods the callers use, by symbol (a method is a root by its mangled name). */
export const V8_BIGINT_METHODS = {
  multiply: "_ZN2v86bigint9Processor8MultiplyENS0_8RWDigitsENS0_6DigitsES3_",
  divide: "_ZN2v86bigint9Processor6DivideENS0_8RWDigitsENS0_6DigitsES3_",
  modulo: "_ZN2v86bigint9Processor6ModuloENS0_8RWDigitsENS0_6DigitsES3_",
  toString: "_ZN2v86bigint9Processor8ToStringEPcPiNS0_6DigitsEib",
} as const;

/** V8 12.4's `src/bigint`, shaved: its functions, the processor's methods, and V8's processor. */
export function shaveV8BigInt(): ShavedUnit {
  const v8 = here("../../vendor/v8/");
  return shaveCUnit(
    here("./v8/bigint.cc"),
    ["v8::bigint::", "yk_v8_bigint_processor", ...Object.values(V8_BIGINT_METHODS)],
    ["-std=c++20", "-DV8_ADVANCED_BIGINT_ALGORITHMS", `-I${v8}`, `-I${v8}include`],
  );
}
