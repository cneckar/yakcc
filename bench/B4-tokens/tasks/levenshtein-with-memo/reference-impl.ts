// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/levenshtein-with-memo/reference-impl.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 task corpus: levenshtein-with-memo reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves the oracle tests correctly
//   distinguish correct memoized-recursive from broken implementations. Hand-written;
//   not LLM-generated (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   Adversarial trap: memo declared OUTSIDE the inner recursive fn, closed over it.
//   Models often declare memo INSIDE (resets on every levenshtein call) or use
//   string slicing as cache keys (defeating memoization overhead savings).

/**
 * Compute the Levenshtein edit distance between strings a and b.
 *
 * Uses top-down dynamic programming with a Map-based memo cache.
 * The cache is keyed by (i, j) index pairs encoded as a single integer
 * to avoid string allocation overhead.
 *
 * @param a - Source string
 * @param b - Target string
 * @returns Minimum edit distance (non-negative integer)
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Memo cache: key = i * (n+1) + j, value = edit distance at (i, j)
  // Declared outside the inner function so it persists across recursive calls.
  const memo = new Map<number, number>();

  function dp(i: number, j: number): number {
    // Base cases
    if (i === 0) return j; // insert all of b[0..j)
    if (j === 0) return i; // delete all of a[0..i)

    const key = i * (n + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: number;
    if (a[i - 1] === b[j - 1]) {
      // Characters match — no edit needed at this position
      result = dp(i - 1, j - 1);
    } else {
      // Min of: substitute (i-1, j-1), delete from a (i-1, j), insert into a (i, j-1)
      result = 1 + Math.min(dp(i - 1, j - 1), dp(i - 1, j), dp(i, j - 1));
    }

    memo.set(key, result);
    return result;
  }

  return dp(m, n);
}
