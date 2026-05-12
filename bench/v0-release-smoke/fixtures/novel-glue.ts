// SPDX-License-Identifier: MIT
/**
 * Chunk an array into fixed-size sub-arrays.
 *
 * Splits `items` into consecutive sub-arrays of length `size`.
 * The last chunk may be smaller than `size` if the array length
 * is not evenly divisible.
 *
 * @param items - The source array to split.
 * @param size  - The maximum length of each chunk (must be >= 1).
 * @returns An array of chunks; empty array when `items` is empty.
 * @throws {RangeError} When `size` is less than 1.
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size < 1) {
    throw new RangeError(`chunk size must be >= 1, got ${size}`);
  }
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
