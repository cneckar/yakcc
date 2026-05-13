// SPDX-License-Identifier: MIT
//
// @decision DEC-V0-B4-SEED-memoize-001
// @title memoize: generic Map-backed memoization wrapper
// @status accepted
// @rationale
//   The levenshtein-with-memo B4 task requires a memoization primitive.
//   Levenshtein DP has overlapping subproblems: edit(i, j) is recomputed
//   O(m*n) times in a naive recursion without caching. A memoize wrapper
//   reduces this to O(m*n) distinct calls with O(1) lookups on repeats.
//
//   Design decisions:
//   (A) CALLER-SUPPLIED KEY FUNCTION: Rather than JSON.stringify(args) by
//       default, the caller supplies keyFn. This is intentional -- it lets
//       the caller control key space (e.g., `${i},${j}` for two integers
//       is cheaper and collision-free compared to JSON.stringify([i, j])).
//       It also keeps the atom free of assumptions about argument types.
//
//   (B) MAP OVER OBJECT: Map is used instead of a plain object cache because
//       Map does not inherit prototype keys and has better performance for
//       high-cardinality key sets (V8 optimises Map internally).
//
//   (C) EXCEPTION NOT CACHED: If fn throws, the error is re-thrown and no
//       entry is written to the cache. The next call will re-invoke fn. This
//       is the standard memoize contract; caching exceptions would hide bugs.
//
//   (D) UNKNOWN TYPES: Inputs and outputs are typed as unknown[] / unknown to
//       keep the atom within the strict-subset validator's validated surface.
//       Callers cast to concrete types at the usage site.
//
//   Reference: Memoization pattern attributed to Donald Michie (1968);
//   application to Levenshtein distance in Wagner & Fischer (1974).

/**
 * Wrap a pure function with a Map-backed cache keyed by keyFn(...args).
 *
 * fn is called at most once per unique key. Exceptions from fn propagate
 * to the caller and are NOT cached -- subsequent calls with the same key
 * will re-invoke fn.
 *
 * @param fn    - Pure function to memoize.
 * @param keyFn - Serialises args to a string cache key.
 * @returns A memoized wrapper sharing a single internal cache.
 */
export function memoize(
  fn: (...args: unknown[]) => unknown,
  keyFn: (...args: unknown[]) => string,
): (...args: unknown[]) => unknown {
  const cache: Map<string, unknown> = new Map();

  return function memoized(...args: unknown[]): unknown {
    const key = keyFn(...args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}
