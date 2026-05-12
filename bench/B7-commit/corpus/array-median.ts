// SPDX-License-Identifier: MIT

/**
 * Compute the median of a numeric array using O(n log n) sort.
 * Returns NaN for empty arrays.
 *
 * @param values - The numeric array whose median is to be computed.
 * @returns The median value, or NaN if the array is empty.
 */
export function arrayMedian(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
