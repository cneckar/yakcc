# B2-bloat: Transitive Dependency Weight Benchmark

**Parent issue:** [#186](https://github.com/cneckar/yakcc/issues/186) — WI-BENCHMARK-B2: Bloat reduction reality check  
**Current slice:** Slice 1 — coarse granularity, cold-corpus baseline  
**Sweep dimension:** emit-strategy granularity (coarse / medium / fine — same axis as B9)

The B2 benchmark measures whether assembling a JSON Schema 2020-12 validator via Yakcc yields
meaningful transitive dependency weight reduction vs. the equivalent NPM bundle (ajv@8.x).

---

## Quick Start

### Dry-run (no install required)

```bash
pnpm bench:bloat:dry
```

Loads fixture test cases (156 cases across 45 groups) and confirms the harness runs.
Does not measure bundle sizes or execute the validator.

### Live run with test suite (no esbuild required)

```bash
pnpm bench:bloat
```

Builds the Yakcc validator (via `tsc`) and runs the 156-case fixture test suite.
Reports semantic correctness (pass rate). Requires `pnpm install` at root.

### Full measurement (requires bench deps)

```bash
pnpm --dir bench/B2-bloat install
pnpm bench:bloat
```

Full run: builds the validator, bundles with esbuild, measures gzipped sizes,
runs the test suite, and compares against ajv.

---

## Comparators

| Arm | Description |
|-----|-------------|
| **A — Yakcc (coarse)** | Single-atom validator: `examples/json-schema-validator/src/validator.ts` compiled with `tsc` then bundled with esbuild (minified, ESM). One distinct unit. |
| **B — ajv@8.x** | ajv@8.x + transitive closure bundled with esbuild (minified, ESM). ~12 distinct packages in transitive closure. |

Same semantics: both validators must pass an identical JSON Schema 2020-12 test suite.

---

## Metrics

| Metric | Target (directional) | KILL |
|--------|---------------------|------|
| Raw bundle size reduction (A vs B) | ≥90% | <60% |
| Gzip bundle size reduction | ≥90% | <60% |
| Distinct-unit count reduction | ≥80% | <50% |
| Semantic equivalence pass rate | ≥95% | <90% |
| Cold-start time (first validate call) | ≤ ajv cold-start | >2× ajv |

Per [#186 reframe (2026-05-13)](https://github.com/cneckar/yakcc/issues/186#issuecomment-4442627848),
all bars are **directional targets only** — no hard kill pre-data. Pass/fail is recorded
in `@decision DEC-BENCH-B2-001` after live run.

---

## Sweep Dimensions

This benchmark sweeps **emit-strategy granularity** (same axis as B9):

| Strategy | Description | Slice |
|----------|-------------|-------|
| **Coarse** | Single atom for the full validator | Slice 1 (this) |
| **Medium** | One atom per keyword category (type/numeric/string/array/object/logic/ref) | Slice 2 (planned) |
| **Fine** | One atom per keyword | Slice 3 (planned) |

Each granularity produces a measurement point. The headline output is the
**Pareto frontier of (bloat reduction × atomization cost)** along the granularity axis.

---

## Cold-Corpus Caveat

This Slice 1 run is a **cold-corpus baseline**: the application-layer corpus does not yet
contain JSON Schema validation primitives, so all 1 atom is new code (zero reuse from registry).

The ≥90% reduction target requires corpus atoms that can be REFERENCED rather than included.
As the registry fills with application-layer atoms (WI-510 and successors), future slice runs
will show the reduction curve climbing toward the directional target.

`@decision DEC-BENCH-B2-001` is annotated in the harness with the tester-fill fields.

---

## What the Slice 1 result measures (audit, 2026-11-28)

Slice 1's numbers stand (90.3% raw and 90.2% gzipped, 156/156 cases, the same on Linux; the
"N/A" pass rate in `results-2026-05-18.json` was the Windows import bug the harness notes). But
arm A is one hand-written 910-line validator, not atoms from the registry. So the 90% is a
minimal hand-written validator against Ajv, which generates code at run time. It says nothing
about yakcc yet. Two questions decide whether atoms themselves cut bloat.

**1. Do packages share code that content addressing would store once?** Measured, and no.
`harness/cross-package-dedup.ts` lifts the 19 real corpus packages from their entry points.
It uses yakcc's own program record: every module reached, each top-level statement a graph.
It then counts each graph's identity across packages:

| Graphs | Shared by 2+ packages | Graph bytes | Saved by storing each once |
|---|---|---|---|
| 2,027 | 4 | 19.8 MB | 4.5 KB (0.02%) |

Results are in `results-cross-package-dedup-2026-11-28.txt`. The identity is exact, so two
helpers that differ only in a name are counted apart. Even if renaming merged many more, sharing
between real packages is too small to matter. Content addressing does not cut bloat by
deduplication across packages.

**2. Does atom-level dead-code removal beat a bundler's?** No more than statement-level
tree-shaking does. A program record's atom is a top-level statement, the unit ESM tree-shaking
removes, so atoms can match that shaking but never remove more. On CommonJS, where bundlers keep
whole modules, the gap is real. Only uuid ships both builds in the corpus; esbuild (minified)
bundling one function from each:

| Function | CommonJS (browser) | ESM (browser) | ESM ÷ CommonJS |
|---|---|---|---|
| `md5` | 3,387 | 3,228 | 0.95 |
| `sha1` | 1,387 | 1,228 | 0.89 |
| `v3` | 6,086 | 4,892 | 0.80 |
| `v5` | 4,082 | 2,892 | 0.71 |
| `parse` | 984 | 625 | 0.64 |
| `v1ToV6` | 2,002 | 1,259 | 0.63 |
| `v4` | 2,095 | 1,050 | 0.50 |

That gap is what any CommonJS-aware tree-shaker closes, and so the most atoms could claim on
size. So a win there is not evidence for atoms. The gap can be large inside one module: semver's
`coerce` reaches all 60 statements of `internal/re.js` for the few regular expressions it uses.

---

## Test Suite

The fixture test suite (`fixtures/test-cases.json`) covers:
- Boolean schemas (true/false)
- `type` (all 7 JSON types + union type arrays)
- `const`, `enum`
- Numeric: `multipleOf`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- String: `minLength`, `maxLength`, `pattern`
- Array: `minItems`, `maxItems`, `uniqueItems`, `prefixItems`, `items`, `contains`, `minContains`, `maxContains`
- Object: `required`, `minProperties`, `maxProperties`, `properties`, `additionalProperties`, `patternProperties`, `propertyNames`, `dependentRequired`, `dependentSchemas`
- Logic: `allOf`, `anyOf`, `oneOf`, `not`
- Conditional: `if`/`then`/`else`
- References: `$ref`, `$defs`, `$anchor`
- Annotations: `unevaluatedProperties`, `unevaluatedItems`
- Recursive schemas

**156 test cases, 45 groups.**

For the full JSON Schema Test Suite: https://github.com/json-schema-org/JSON-Schema-Test-Suite

---

## File Layout

```
bench/B2-bloat/
  package.json            bench-local deps (esbuild, ajv)
  README.md               this file
  harness/
    run.mjs               main benchmark entry point (pnpm bench:bloat)
  fixtures/
    test-cases.json       curated 156-case test suite (no install required)

examples/json-schema-validator/
  spec.yak                Yakcc atom spec (behavior, guarantees, property tests)
  src/validator.ts        JSON Schema 2020-12 implementation (strict-subset compliant)
  package.json
  tsconfig.json
```
