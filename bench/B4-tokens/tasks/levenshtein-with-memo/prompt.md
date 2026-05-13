# Task: Levenshtein Distance with Memoization

Implement a TypeScript function `levenshtein` that computes the edit distance between two strings using memoized recursion:

```typescript
function levenshtein(a: string, b: string): number;
```

## Requirements

1. **Correct Levenshtein semantics**: The edit distance is the minimum number of single-character edits (insertions, deletions, substitutions) required to transform string `a` into string `b`.
2. **Memoization required**: The recursive implementation MUST use memoization (top-down DP with a cache). A naive recursive implementation without memoization will time out on strings of length ≥ 20.
3. **Base cases**:
   - `levenshtein("", b)` → `b.length` (all insertions)
   - `levenshtein(a, "")` → `a.length` (all deletions)
4. **Symmetric**: `levenshtein(a, b) === levenshtein(b, a)` must hold for all inputs.
5. **Zero distance**: `levenshtein(a, a) === 0` for any string `a`.
6. **Unicode**: Treat each JavaScript string character (UTF-16 code unit) as a single unit. You do not need to handle surrogate pairs specially.
7. **No mutation of inputs**: The function must not modify the input strings.

## Export

Export the function as a named export:

```typescript
export { levenshtein };
```

## Notes

- Do not use external libraries. Pure TypeScript, no dependencies.
- The implementation must be a single `.ts` file.
- The memoization cache may use a `Map`, object literal, or 2D array — any approach that achieves O(m*n) time and space.
- Do NOT implement the iterative bottom-up DP table as your primary approach — the task specifically requires memoized recursion to test atom composition. An iterative approach will fail the "memoization required" oracle check.
