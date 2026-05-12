// SPDX-License-Identifier: MIT

/**
 * Recursively sum the decimal digits of a non-negative integer until a single
 * digit remains (digital root). For example, sumDigitsRecursive(493) = 7
 * because 4+9+3=16, then 1+6=7. Returns 0 for input 0.
 *
 * @param n - A non-negative safe integer whose digits will be summed.
 * @returns The digital root of n (a value in [0, 9]).
 * @throws {RangeError} if n is not a non-negative safe integer.
 */
export function sumDigitsRecursive(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError("sumDigitsRecursive: argument must be a non-negative safe integer");
  }
  if (n < 10) return n;
  let sum = 0;
  let remaining = n;
  while (remaining > 0) {
    sum += remaining % 10;
    remaining = Math.floor(remaining / 10);
  }
  return sumDigitsRecursive(sum);
}
