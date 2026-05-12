// SPDX-License-Identifier: MIT

/**
 * Compute the greatest common divisor of two non-negative integers using the
 * iterative Euclidean algorithm. gcd(0, n) = gcd(n, 0) = n for all n ≥ 0.
 * Both inputs are truncated to integers before computation.
 *
 * @param a - First non-negative integer.
 * @param b - Second non-negative integer.
 * @returns The GCD of |a| and |b|.
 * @throws {RangeError} if either argument is not a finite number.
 */
export function gcdEuclidean(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError("gcdEuclidean: both arguments must be finite numbers");
  }
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}
