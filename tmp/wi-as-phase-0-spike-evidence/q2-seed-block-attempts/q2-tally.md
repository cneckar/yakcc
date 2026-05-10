# Q2 Seed-Block Compile Tally

Atoms attempted: 5 (digit, non-ascii-rejector, integer, comma-separated-integers, ascii-digit-set, optional-whitespace = 6 total)

| atom | result | error classification |
|------|--------|---------------------|
| digit | REJECTED | `JSON.stringify` not in AS stdlib — bounded dialect constraint |
| non-ascii-rejector | COMPILED | clean — pure string/charCode logic, no TS-specific features |
| integer | REJECTED | `readonly [number, number]` tuple type — bounded dialect constraint (readonly tuples unsupported) |
| comma-separated-integers | REJECTED | `import type`, `typeof`, `readonly`, `ReadonlyArray` — 4 bounded dialect constraints |
| ascii-digit-set | COMPILED | clean — simple boolean predicate over string chars |
| optional-whitespace | REJECTED | `input[pos]` string indexing yields i32 in AS (not string), needs explicit cast — bounded dialect constraint |

Compiled cleanly: 2 / 6  (33%)
Rejected: 4 / 6  (67%)

## Rejection Analysis

ALL 4 rejections map to well-known AS dialect boundaries:

1. `JSON` global missing — AS has no built-in JSON; must use assemblyscript-json package or remove
2. `readonly [T, T]` tuple type — AS does not support TS `readonly` modifier on tuple types
3. `import type` / `typeof` — AS does not support type-only imports or `typeof` in type position
4. `string[i]` indexing returns `i32` in AS (char code), not `string` — requires `String.fromCharCode(input.charCodeAt(i))` pattern

None of these are unbounded (random asc internals). All are predictable from the AS type system documentation.
Hard fail condition (>50% unbounded errors): NOT triggered — all rejections are bounded.
