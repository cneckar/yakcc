// SPDX-License-Identifier: MIT

/**
 * Return all prime numbers up to and including `limit` using the Sieve of
 * Eratosthenes. Returns an empty array for limit < 2.
 *
 * @param limit - Upper bound (inclusive). Must be a non-negative finite integer.
 * @returns Sorted array of all primes in [2, limit].
 * @throws {RangeError} if limit is not a non-negative finite integer.
 */
export function primeSieveEratosthenes(limit: number): number[] {
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
    throw new RangeError("primeSieveEratosthenes: limit must be a non-negative integer");
  }
  if (limit < 2) return [];
  const composite = new Uint8Array(limit + 1); // 0 = prime candidate, 1 = composite
  for (let i = 2; i * i <= limit; i++) {
    if (composite[i] === 0) {
      for (let j = i * i; j <= limit; j += i) {
        composite[j] = 1;
      }
    }
  }
  const primes: number[] = [];
  for (let i = 2; i <= limit; i++) {
    if (composite[i] === 0) primes.push(i);
  }
  return primes;
}
