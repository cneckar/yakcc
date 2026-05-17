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
