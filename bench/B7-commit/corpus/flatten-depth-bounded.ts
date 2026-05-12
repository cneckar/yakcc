// SPDX-License-Identifier: MIT

/**
 * Recursively flatten a nested array up to a specified depth. At depth 0,
 * returns a shallow copy of the input. At depth 1, flattens one level (same
 * as Array.prototype.flat). Elements that are not arrays are included as-is
 * at any depth.
 *
 * @param arr   - The (possibly nested) array to flatten.
 * @param depth - Maximum recursion depth; must be a non-negative integer.
 * @returns A new flat array with nesting removed up to `depth` levels.
 * @throws {RangeError} if depth is not a non-negative integer.
 */
export function flattenDepthBounded(arr: readonly unknown[], depth: number): unknown[] {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new RangeError("flattenDepthBounded: depth must be a non-negative integer");
  }
  const result: unknown[] = [];
  for (const item of arr) {
    if (Array.isArray(item) && depth > 0) {
      const nested = flattenDepthBounded(item as unknown[], depth - 1);
      for (const n of nested) result.push(n);
    } else {
      result.push(item);
    }
  }
  return result;
}
