# @yakcc/variance

Variance scoring and star-topology contract design rules for Yakcc specs.

## What this package provides

- **`varianceScore`** — compute a weighted composite similarity score (in [0, 1])
  between two `SpecYak` specs across five dimensions. Used by the registry's
  selection logic to rank candidate implementations.
- **`compareDimensions`** — compute the per-dimension breakdown without the
  weighted sum. Useful for introspection and debugging.
- **`applyContractDesignRules`** — merge N specs using star-topology rules
  (intersection / majority-vote / union per `DEC-VAR-002`).
- **`mapCweFamily`** — map a `SpecYak` against the CWE-474 family, returning
  which CWEs are present and which are clear.
- **`CWE_474_FAMILY`** — the canonical CWE pattern table used in security scoring.
  Updates require governance review (`DEC-VAR-003`).
- **`DIMENSION_WEIGHTS`** — the default weight vector for `varianceScore`.
  Weights sum exactly to 1.0 (asserted at module load).

This package is a pure-function leaf: no I/O, no LLM calls, no imports from
`@yakcc/shave` or `@yakcc/registry` (`DEC-VAR-004`). Callers own the
`IntentCard` → `SpecYak` translation step.

## Five scoring dimensions

`varianceScore` decomposes alignment into five weighted dimensions
(`DEC-VAR-001`):

| Dimension | Weight | Scoring method |
|-----------|--------|----------------|
| `security` | 0.35 | Agreement on CWE-474 family presence/clear status |
| `behavioral` | 0.25 | Jaccard similarity over normalized postconditions |
| `error_handling` | 0.20 | Jaccard over error descriptions (0.7) + error types (0.3) |
| `performance` | 0.10 | Structural match of time/space non-functional claims |
| `interface` | 0.10 | Jaccard over input + output parameter identity keys |

All dimension scores are in [0, 1] where 1.0 = perfect alignment.

Behavior prose (`SpecYak.behavior`) is excluded from the behavioral score
(`DEC-VAR-005`): prose comparison requires semantic embedding, which is
forbidden in this leaf package.

## Star-topology merge rules (DEC-VAR-002)

`applyContractDesignRules(specs)` merges N `SpecYak` specs:

- `safety.preconditions` = **intersection** — every contributor must agree; no
  precondition is dropped
- `safety.invariants` = **intersection** — same
- `safety.cweClear` = **intersection** of per-spec CWE-clear sets — a CWE is
  clear only if all contributors clear it
- `behavioral.postconditions` = **majority vote** (≥ ⌈N/2⌉ contributors) —
  dominant correct postconditions survive without requiring unanimity
- `behavioral.behavior` = first lexicographic non-empty prose value (tie-break
  logged in `MergedContract.source.tieBreaks`)
- `capability.effects` = **union** — no declared effect is silently elided

Throws `RangeError` on empty input (zero-contributor merge is undefined under
star-topology rules).

## Public API

```ts
import {
  varianceScore,
  compareDimensions,
  applyContractDesignRules,
  mapCweFamily,
  CWE_474_FAMILY,
  DIMENSION_WEIGHTS,
} from "@yakcc/variance";
import type {
  VarianceDimension,
  DimensionScores,
  VarianceOptions,
  VarianceResult,
  CweId,
  CwePattern,
  CweMapping,
  MergedContract,
  TieBreakRecord,
} from "@yakcc/variance";
```

### `varianceScore(canonical, candidate, options?)`

```ts
const result = varianceScore(canonicalSpec, candidateSpec);
// result.score        — weighted composite in [0, 1]
// result.dimensions   — per-dimension breakdown
// result.weights      — weights used (default or caller-supplied)
```

Caller-supplied weights must include all five dimension keys and sum to 1.0
(±1e-9); throws `RangeError` otherwise.

### `applyContractDesignRules(specs)`

```ts
const merged = applyContractDesignRules([specA, specB, specC]);
// merged.safety.preconditions     — intersection of all three
// merged.behavioral.postconditions — majority-vote survivors
// merged.capability.effects        — union of all declared effects
// merged.source.tieBreaks          — logged resolution events
```

## Cross-references

- `@yakcc/contracts` — `SpecYak` type consumed by all variance functions
- `DEC-VAR-001` — dimension framing (5 canonical dimensions)
- `DEC-VAR-002` — star-topology merge rules
- `DEC-VAR-003` — CWE-474 family governance
- `DEC-VAR-004` — leaf-package invariant (no circular deps)
- `DEC-VAR-005` — behavior prose excluded at v0.7

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
