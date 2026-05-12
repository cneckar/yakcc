// SPDX-License-Identifier: MIT

/**
 * Compute the sum of a numeric array using the Kahan compensated summation
 * algorithm, which reduces floating-point rounding error compared to naive
 * sequential addition. Returns 0 for an empty array.
 *
 * @param values - The array of finite numbers to sum.
 * @returns The Kahan-compensated sum of all values.
 * @example kahanSum([0.1, 0.2, 0.3]) // ≈ 0.6 (not 0.6000000000000001)
 */
export function kahanSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const v of values) {
    const y = v - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    sum = t;
  }
  return sum;
}
