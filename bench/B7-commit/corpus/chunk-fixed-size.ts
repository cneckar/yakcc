// SPDX-License-Identifier: MIT

/**
 * Split an array into consecutive chunks of exactly `size` elements. The final
 * chunk may contain fewer than `size` elements if the array length is not evenly
 * divisible. Returns an empty array for an empty input.
 *
 * @param arr  - The array to chunk.
 * @param size - Chunk size; must be a positive integer.
 * @returns Array of chunks, each a sub-array of `arr`.
 * @throws {RangeError} if size is not a positive integer.
 */
export function chunkFixedSize<T>(arr: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("chunkFixedSize: size must be a positive integer");
  }
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size) as T[]);
  }
  return result;
}
