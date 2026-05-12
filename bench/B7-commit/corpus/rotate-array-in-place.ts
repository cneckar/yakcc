// SPDX-License-Identifier: MIT

/**
 * Rotate an array in-place to the right by `k` positions. Elements that fall
 * off the right end wrap around to the left. A negative `k` rotates left.
 * Uses the three-reversal algorithm: O(n) time, O(1) extra space.
 * No-ops on arrays of length 0 or 1.
 *
 * @param arr - The array to rotate in-place.
 * @param k   - Number of positions to rotate right (may be negative or > arr.length).
 */
export function rotateArrayInPlace<T>(arr: T[], k: number): void {
  const n = arr.length;
  if (n <= 1 || k === 0) return;
  const steps = ((k % n) + n) % n; // normalize to [0, n)
  if (steps === 0) return;

  function reverse(lo: number, hi: number): void {
    while (lo < hi) {
      const tmp = arr[lo]!;
      arr[lo] = arr[hi]!;
      arr[hi] = tmp;
      lo++;
      hi--;
    }
  }

  reverse(0, n - 1);
  reverse(0, steps - 1);
  reverse(steps, n - 1);
}
