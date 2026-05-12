// SPDX-License-Identifier: MIT

/**
 * Compute the Hamming distance between two strings of equal length.
 * The Hamming distance is the number of positions at which the corresponding
 * characters differ. Throws a RangeError if the strings have different lengths.
 *
 * @param a - First string.
 * @param b - Second string, must have the same length as `a`.
 * @returns The number of positions where `a` and `b` differ.
 * @throws {RangeError} if `a` and `b` have different lengths.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `hammingDistance: strings must have equal length (got ${a.length} and ${b.length})`,
    );
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}
