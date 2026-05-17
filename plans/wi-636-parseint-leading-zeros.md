# WI-636 — parse-int-list arm-a leading-zeros fix

## Root cause

All three arm-a granularities (fine / medium / coarse) consumed digit sequences
with `[0-9]+` and passed the result directly to `parseInt(..., 10)`.
`parseInt` silently accepts leading zeros (`"007"` → `7`), so the input
`[007]` passed the parser without error — a shape_escape under the
`integer-overflow / leading-zeros` attack class.

## Fix

After digit consumption, a single guard rejects any multi-digit sequence whose
first character is `"0"`:

```js
if (end - pos > 1 && input[pos] === "0") {
  throw new SyntaxError(`Leading zeros not allowed at position ${pos}`);
}
```

This preserves the valid single-zero `[0]` (length 1 → guard skips) and
rejects `[007]`, `[01]`, `[00]`, etc.

### Files changed

| File | Site(s) patched |
|------|----------------|
| `bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs` | `parseDigits` (1 site) |
| `bench/B9-min-surface/tasks/parse-int-list/arm-a/medium.mjs` | `parseIntegerList` first-element + remaining-elements loops (2 sites) |
| `bench/B9-min-surface/tasks/parse-int-list/arm-a/coarse.mjs` | digit loop inside `listOfInts` (1 site) |

## Decision

**DEC-WI-636-001** — annotated inline in `fine.mjs::parseDigits`.

Rationale: the guard is the minimal structural fix. It adds O(1) work per
integer (one comparison after the existing digit loop) and introduces no new
state. Alternatives such as post-parse string re-inspection or regex
pre-validation were rejected as heavier and redundant.

## axis2 evidence (post-fix)

```
fine   → shape_escapes: 0
medium → shape_escapes: 0
coarse → shape_escapes: 0
```
