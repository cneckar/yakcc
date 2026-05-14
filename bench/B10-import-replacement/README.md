# B10 — Import-Replacement Benchmark

**Issue:** [#512](https://github.com/cneckar/yakcc/issues/512)
**Workflow:** `WI-512-B10-IMPORT-BENCH`
**Status:** Slice 1 — harness only, empty corpus (Slice 2+ adds import-heavy tasks)

---

## Purpose

B10 measures the **transitive reachable surface** of npm package imports versus
yakcc atom composition. The central claim it is designed to test:

> "yakcc's atom composition ships ≥90% fewer reachable functions than a natural
> LLM solution that imports a real npm package."

B9 (`bench/B9-min-surface/`) established that yakcc atoms are structurally
minimal *within a single file*. B10 extends the measurement into `node_modules`,
following every `import` statement transitively, so that the full installed
surface of an npm dependency becomes visible.

---

## Metric Methodology

**Primary axis: `reachable_functions` (transitive import closure)**

The resolver performs a BFS walk from the emit file, following every static
`import` and `export … from` declaration into `node_modules`. At each file it
counts body-bearing function nodes (`FunctionDeclaration`, `FunctionExpression`,
`ArrowFunction`, `MethodDeclaration`, `Constructor`, `GetAccessor`,
`SetAccessor`). The total across all traversed files is `reachable_functions`.

This count represents "the code that ships when you `npm install` this package
and import it" — the un-tree-shaken installed surface.

**`@decision DEC-IRT-B10-METRIC-001`** — full methodology, exclusion lists,
conservative-bias direction, and dynamic-import handling are documented in the
`@decision` block at the top of
`bench/B10-import-replacement/harness/measure-transitive-surface.mjs`.

**Secondary axes (also in every measurement result):**

| Field | Meaning |
|---|---|
| `reachable_bytes` | sum of on-disk byte sizes of all traversed files |
| `reachable_files` | unique source files traversed |
| `unique_non_builtin_imports` | count of distinct non-builtin import specifiers |
| `builtin_imports` | `node:*` / Node builtin import count (excluded from traversal) |
| `call_graph_from_entry` | B9-comparable call-graph BFS from a named entry (if `--entry` given) |
| `npm_audit.cve_pattern_matches` | advisory DB matches over traversed packages |

**Exclusion lists (never traversed, never counted):**

- TypeScript stdlib: `lib.*.d.ts` files and `typescript/lib/` paths — prevents
  `JSON.parse` from resolving into `lib.es5.d.ts` and inflating the count
  (U4 mitigation)
- Node.js builtins: `node:*` specifiers and the standard builtin module list
- `@types/*` packages: pure type packages

**Conservative bias direction:** unresolvable imports → counted as 0 (under-counts
Arm B). Non-literal dynamic imports → not traversed (under-counts Arm B). This
makes the "≥90% reduction" claim hard to game.

---

## Arms

| Arm | Description |
|---|---|
| **Arm A** | yakcc atom composition emit. Slice 1: B9 reference `.mjs` files (zero npm imports — valid lower bound). Slice 2+: `tasks/<task>/arm-a/{fine,medium,coarse}.mjs` emits produced by `yakcc compile` via the #508 import-intercept hook + #510 atoms. |
| **Arm B** | LLM baseline (claude-sonnet-4-6, N=3 reps, temperature=1.0). Dry-run reads B9 fixture responses. Live run calls the Anthropic API. |

---

## How to Run

### Dry-run (offline, reads B9 fixtures — CI default, zero API cost)

```
pnpm bench:import-replacement:dry
# or:
node bench/B10-import-replacement/harness/run.mjs --dry-run
```

Writes `bench/B10-import-replacement/test/smoke-fixture-<sha>.json`.
The committed fixture is the Slice 1 smoke result proving U4 mitigation on real
B9 inputs.

### No-network (skips Arm B entirely)

```
pnpm bench:import-replacement:no-network
# or:
node bench/B10-import-replacement/harness/run.mjs --no-network
```

### Live run (requires `ANTHROPIC_API_KEY`)

```
pnpm bench:import-replacement
# or:
node bench/B10-import-replacement/harness/run.mjs
```

Results written to `tmp/B10-import-replacement/results-<platform>-<date>.json`.

### Measure a single emit file

```
node bench/B10-import-replacement/harness/measure-transitive-surface.mjs \
  --emit path/to/emit.mjs \
  [--entry myFunction] \
  [--audit] \
  [--json]
```

---

## Air-Gap Note

Dry-run and no-network modes are fully offline (zero external calls). Live Arm B
mode calls the Anthropic Messages API — this **exits the B6 air-gap by design**,
identical to B9's documented behavior (`bench/B9-min-surface/README.md`).
Do not run live mode inside an air-gapped CI environment without an explicit
`ANTHROPIC_API_KEY` override.

---

## Test Suite

```
node --test bench/B10-import-replacement/test/measure-transitive-surface.test.mjs \
             bench/B10-import-replacement/test/run.test.mjs
```

| Test | What it proves |
|---|---|
| T1–T11 | Exact-count assertions on synthetic fixtures: cycle guard, dev-dep cutoff, re-export dedup, type-only exclusion, dynamic imports, builtin/stdlib exclusion, exports-map resolution, unresolvable imports, function-counting unit, npm-audit |
| S1–S10 | Harness smoke: run.mjs exits 0, artifact well-formed, all 6 B9 tasks present, U4 mitigation proven on real inputs |

---

## Decision Log

| DEC ID | Title | File |
|---|---|---|
| `DEC-IRT-B10-METRIC-001` | Transitive-reachable-surface methodology | `harness/measure-transitive-surface.mjs` |
| `DEC-B10-S1-LAYOUT-001` | Mirror B9 layout; no shared harness code | `harness/run.mjs` |
| `DEC-BENCH-B10-SLICE1-COST-001` | Slice 1 cost cap $25 | `harness/run.mjs` |
| `DEC-B10-ARM-A-S1-001` | Arm A emit resolver — B9 reference fallback | `harness/arm-a-emit.mjs` |
| `DEC-B10-LLM-BASELINE-001` | Arm B prompt — same vanilla prompt as B9/B4 | `harness/llm-baseline.mjs` |
| `DEC-B10-CLASSIFY-ARM-B-001` | Arm B classifier — aggregate across N reps | `harness/classify-arm-b.mjs` |
| `DEC-B10-AXIS1-STRUCT-001` | B10 single-file structural metric | `harness/measure-axis1.mjs` |
| `DEC-B10-RUN-SMOKE-001` | run.mjs smoke test | `test/run.test.mjs` |

Cross-bench references: `DEC-V0-MIN-SURFACE-002` (B9 axis-1, single-file walk —
B10 extends into node_modules); `DEC-V0-MIN-SURFACE-003` (B9/B4 prompt, reused verbatim).

---

## Directory Layout

```
bench/B10-import-replacement/
├── README.md                              # This file
├── package.json                           # Bench-local deps (NOT in pnpm workspace)
├── corpus-spec.json                       # Slice 1: { "tasks": [] }
├── harness/
│   ├── run.mjs                            # Orchestrator
│   ├── measure-transitive-surface.mjs     # BFS import-closure resolver (primary metric)
│   ├── measure-axis1.mjs                  # Single-file structural census
│   ├── arm-a-emit.mjs                     # Arm A emit path resolver
│   ├── llm-baseline.mjs                   # Arm B (Anthropic API / dry-run fixture)
│   └── classify-arm-b.mjs                 # Verdict aggregation across N reps
├── fixtures/
│   └── npm-audit-db/advisories.json       # Offline advisory DB (for T11 and audit flag)
└── test/
    ├── measure-transitive-surface.test.mjs   # T1–T11 exact-count unit tests
    ├── measure-transitive-surface.fixtures/  # Synthetic node_modules trees
    ├── run.test.mjs                          # S1–S10 harness smoke tests
    └── smoke-fixture-<sha>.json              # Committed smoke result (Slice 1)
```

## Slice Roadmap

| Slice | Status | Deliverable |
|---|---|---|
| **S1** | ✓ landed | Harness + resolver + B9 smoke validation |
| **S2** | blocked on #510 | First import-heavy task (`validate-rfc5321-email`) + real results |
| **S3** | blocked on #510/#508 | Full 12–20 task corpus + headline ≥90% reading |
