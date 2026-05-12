// SPDX-License-Identifier: MIT

/**
 * Zip two arrays together into pairs, extending the shorter array with a fill
 * value so the result has length max(a.length, b.length). Unlike zip-shortest,
 * no elements from either array are discarded.
 *
 * @param a        - First array.
 * @param b        - Second array.
 * @param fillA    - Value used when `a` is exhausted before `b`. Default: undefined.
 * @param fillB    - Value used when `b` is exhausted before `a`. Default: undefined.
 * @returns Array of [aVal, bVal] tuples, length = max(a.length, b.length).
 */
export function zipLongest<A, B>(
  a: readonly A[],
  b: readonly B[],
  fillA?: A,
  fillB?: B,
): [A | undefined, B | undefined][] {
  const len = Math.max(a.length, b.length);
  const result: [A | undefined, B | undefined][] = [];
  for (let i = 0; i < len; i++) {
    const aVal: A | undefined = i < a.length ? a[i] : fillA;
    const bVal: B | undefined = i < b.length ? b[i] : fillB;
    result.push([aVal, bVal]);
  }
  return result;
}
