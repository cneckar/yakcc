// SPDX-License-Identifier: MIT

/**
 * Group an array of objects by the value of a specified key, returning a Map
 * whose keys are the distinct values of that property and whose values are
 * arrays of the items that produced that key value. Insertion order is preserved
 * within each group and across groups (first-seen key ordering).
 *
 * @param items    - The array of items to group.
 * @param keyFn    - Function that extracts the grouping key from each item.
 * @returns Map from key to array of items with that key, in first-seen order.
 */
export function groupByKey<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = result.get(key);
    if (group !== undefined) {
      group.push(item);
    } else {
      result.set(key, [item]);
    }
  }
  return result;
}
