// SPDX-License-Identifier: MIT

/**
 * Remove duplicate elements from an array, preserving the order of first
 * occurrence of each element. Equality is determined by SameValueZero (===
 * for non-NaN values; NaN === NaN). Returns a new array; the input is not
 * mutated.
 *
 * @param arr    - The input array, possibly containing duplicates.
 * @param keyFn  - Optional function to extract a comparison key; defaults to identity.
 * @returns New array with duplicates removed, first-occurrence order preserved.
 */
export function dedupeStableOrder<T>(arr: readonly T[], keyFn?: (item: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const result: T[] = [];
  for (const item of arr) {
    const key = keyFn !== undefined ? keyFn(item) : item;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
