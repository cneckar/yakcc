// SPDX-License-Identifier: MIT

/**
 * Count the number of set bits (1-bits) in a 32-bit unsigned integer using
 * the parallel bit-counting (population count) algorithm. The input is treated
 * as an unsigned 32-bit integer via >>> 0 coercion before counting.
 *
 * @param n - The value whose set bits are counted; coerced to Uint32 before use.
 * @returns The number of 1-bits in the 32-bit representation of n (0–32).
 */
export function popcount(n: number): number {
  let x = n >>> 0; // coerce to unsigned 32-bit integer
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  x = (x * 0x01010101) >>> 24;
  return x;
}
