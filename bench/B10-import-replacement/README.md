# B10 — Import-Replacement Benchmark

**Issue:** [#512](https://github.com/cneckar/yakcc/issues/512)
**Workflow:** `WI-512-B10-IMPORT-BENCH`
**Status:** Slice 3 (FINAL) — 15-task corpus, 12/15 PASS-DIRECTIONAL on dry-run

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

## Headline Results (Slice 3, dry-run, 2026-05-17)

12/15 PASS-DIRECTIONAL | 3/15 WARN-DIRECTIONAL

| Task | Library | Arm A fns | Arm B fns | Reduction | Verdict |
|---|---|---:|---:|---:|---|
| validate-rfc5321-email | validator@13.15.35 | 6 | 511 | 98.8% | PASS-DIRECTIONAL |
| verify-jwt-hs256 | jsonwebtoken@9.0.2 | 6 | 278 | 97.8% | PASS-DIRECTIONAL |
| decode-jwt-header-claims | jsonwebtoken@9.0.2 | 5 | 278 | 98.2% | PASS-DIRECTIONAL |
| rate-limit-sliding-window | p-throttle@8.1.0 | 7 | 1 | -600% | WARN-DIRECTIONAL |
| parse-rfc3339-datetime | date-fns@4.1.0 | 5 | 478 | 99.0% | PASS-DIRECTIONAL |
| format-iso-date | date-fns@4.1.0 | 5 | 478 | 99.0% | PASS-DIRECTIONAL |
| add-business-days | date-fns@4.1.0 | 3 | 478 | 99.4% | PASS-DIRECTIONAL |
| cycle-safe-deep-clone | lodash@4.17.21 | 11 | 692 | 98.4% | PASS-DIRECTIONAL |
| semver-range-satisfies | semver@7.8.0 | 9 | 119 | 92.4% | PASS-DIRECTIONAL |
| bcrypt-verify-constant-time | bcryptjs@2.4.3 | 5 | 57 | 91.2% | PASS-DIRECTIONAL [GAP] |
| uuid-v4-generate-validate | uuid@11.1.1 | 5 | 29 | 82.8% | WARN-DIRECTIONAL |
| nanoid-generate | nanoid@3.3.12 | 3 | 1 | -200% | WARN-DIRECTIONAL |
| debounce-with-flush-cancel | lodash@4.17.21 | 10 | 692 | 98.6% | PASS-DIRECTIONAL |
| validate-string-min-max | zod@3.25.76 | 4 | 437 | 99.1% | PASS-DIRECTIONAL [GAP] |
| coerce-semver | semver@7.8.0 | 4 | 119 | 96.6% | PASS-DIRECTIONAL |

**[GAP]**: engine-gap-disclosed — arm-a is hand-authored reference, not real atom composition via production CLI path (see `corpus-spec.json` `engine_gap_disclosure` fields).

**WARN notes:**
- `rate-limit-sliding-window`: p-throttle is pure-ESM single-export module; resolver sees 1 fn. Arm A (7 fns) is therefore larger. Low-fn packages are a known resolver edge-case; this task still proves the zero-npm-import guarantee.
- `nanoid-generate`: nanoid CJS bundle resolves to 1 fn. Same edge-case as p-throttle.
- `uuid-v4-generate-validate`: uuid@11.1.1 is a small package (29 fns); 82.8% reduction is below 90% target.

**Acceptance bar:** ≥10/15 PASS-DIRECTIONAL. Result: **12/15 PASS-DIRECTIONAL. BAR MET.**

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

## CVE Secondary Metric

`fixtures/npm-audit-db/advisories.json` is a **real pinned snapshot** captured
via `npm audit --json` on 2026-05-17 against the 11 covered packages.

**Packages with known advisories (as of 2026-05-17):**

| Package | Advisory | Severity |
|---|---|---|
| lodash@4.17.21 | GHSA-xxjr-mmjv-4gpg | moderate |
| lodash@4.17.21 | GHSA-r5fr-rjxr-66jc | high |
| lodash@4.17.21 | GHSA-f23m-r3pf-42rh | moderate |

**Packages with 0 advisories:**
semver@7.8.0, uuid@11.1.1, nanoid@3.3.12, date-fns@4.1.0, jsonwebtoken@9.0.2,
bcryptjs@2.4.3, zod@3.25.76, p-throttle@8.1.0, ms@2.1.3, validator@13.15.35.

The DB is pinned (not auto-refreshed in CI) for determinism. See
`DEC-BENCH-B10-SLICE3-CVE-METRIC-001` in `harness/measure-transitive-surface.mjs`.

---

## Arms

| Arm | Description |
|---|---|
| **Arm A** | yakcc atom composition emit. S1: B9 reference `.mjs` files (zero npm imports — valid lower bound). S2+: `tasks/<task>/arm-a/{fine,medium,coarse}.mjs` emits hand-translated from WI-510 atom subgraphs (S3 production CLI path not yet wired — see `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001`). |
| **Arm B** | LLM baseline (claude-sonnet-4-6, N=3 reps, temperature=1.0). Dry-run reads `fixtures/<task>/arm-b-response.json`. Live run calls the Anthropic API. |

---

## How to Run

### Dry-run (offline, reads fixtures — CI default, zero API cost)

```
pnpm bench:import-replacement:dry
# or:
node bench/B10-import-replacement/harness/run.mjs --dry-run
```

Writes `bench/B10-import-replacement/test/smoke-fixture-<sha>.json`.
The committed fixture is the S1 smoke result proving U4 mitigation on real B9 inputs.

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
node --test bench/B10-import-replacement/test/*.test.mjs
```

| Test | What it proves |
|---|---|
| T1–T11 | Exact-count assertions on synthetic fixtures: cycle guard, dev-dep cutoff, re-export dedup, type-only exclusion, dynamic imports, builtin/stdlib exclusion, exports-map resolution, unresolvable imports, function-counting unit, npm-audit |
| T-CVE-DB-1 | Real pinned advisories.json (not synthetic placeholder) |
| S1–S10 | Harness smoke: run.mjs exits 0, artifact well-formed, all 6 B9 tasks present, U4 mitigation proven on real inputs |
| T-DETERMINISTIC-DRYRUN-1 | Two consecutive dry-runs produce identical verdict lines |
| T-CLASSIFIER-CVE-1 | summarizeSuite total_cve_matches aggregation |
| T-CLASSIFIER-1a–d | Classifier: PENDING/PASS/WARN/INCONCLUSIVE paths |
| Per-task (14×) | T-CORPUS-1, T-A-1, T-A-2, T-B-1, T-RESOLVER-DELTA-1, T-SMOKE-RUN-1 for each of the 14 S3 tasks |

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
| `DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001` | Demo library: validator@13.15.35 / isEmail | `test/validate-rfc5321-email.test.mjs` |
| `DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001` | 14 S3 tasks across 11 WI-510 libraries | `corpus-spec.json`, all S3 spec.yak files |
| `DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001` | Arm A S3 hand-translation fallback (12 tasks) | all S3 arm-a/*.mjs |
| `DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001` | Arm A S3 engine-gap-disclosed (bcryptjs, zod) | bcrypt/zod arm-a/*.mjs |
| `DEC-BENCH-B10-SLICE3-CVE-METRIC-001` | CVE secondary metric: real pinned advisory DB | `harness/measure-transitive-surface.mjs`, `fixtures/npm-audit-db/advisories.json` |
| `DEC-BENCH-B10-SLICE3-COST-001` | S3 cost cap $25 | `harness/run.mjs` |

Cross-bench references: `DEC-V0-MIN-SURFACE-002` (B9 axis-1, single-file walk —
B10 extends into node_modules); `DEC-V0-MIN-SURFACE-003` (B9/B4 prompt, reused verbatim).

---

## Directory Layout

```
bench/B10-import-replacement/
├── README.md                              # This file
├── package.json                           # Bench-local deps (NOT in pnpm workspace)
├── corpus-spec.json                       # 15 tasks (S1 empty + S2 email + S3 14 tasks)
├── harness/
│   ├── run.mjs                            # Orchestrator
│   ├── measure-transitive-surface.mjs     # BFS import-closure resolver (primary metric)
│   ├── measure-axis1.mjs                  # Single-file structural census
│   ├── arm-a-emit.mjs                     # Arm A emit path resolver
│   ├── llm-baseline.mjs                   # Arm B (Anthropic API / dry-run fixture)
│   └── classify-arm-b.mjs                 # Verdict aggregation across N reps
├── fixtures/
│   ├── npm-audit-db/
│   │   ├── advisories.json                # Real pinned advisory DB (2026-05-17 snapshot)
│   │   └── advisories-meta.json           # Provenance/generation metadata
│   ├── validate-rfc5321-email/arm-b-response.json
│   └── <task-id>/arm-b-response.json      # 14 S3 task fixtures
├── tasks/
│   ├── validate-rfc5321-email/            # S2 task (READ-ONLY)
│   └── <task-id>/                         # 14 S3 tasks, each with:
│       ├── spec.yak                       #   Task spec (sha256-locked in corpus-spec.json)
│       └── arm-a/{fine,medium,coarse}.mjs #   Arm A granularity strategies
│           oracle.test.mjs                #   Oracle unit tests
└── test/
    ├── measure-transitive-surface.test.mjs   # T1–T11 + T-CVE-DB-1
    ├── measure-transitive-surface.fixtures/  # Synthetic node_modules trees
    ├── run.test.mjs                          # S1–S10 + T-DETERMINISTIC-DRYRUN-1
    ├── classify-arm-b.test.mjs               # T-CLASSIFIER-1a–d + T-CLASSIFIER-CVE-1
    ├── validate-rfc5321-email.test.mjs       # S2 task tests
    ├── <task-id>.test.mjs                    # 14 S3 per-task test files
    └── smoke-fixture-<sha>.json              # Committed S1 smoke result
```

## Slice Roadmap

| Slice | Status | Deliverable |
|---|---|---|
| **S1** | landed | Harness + resolver + B9 smoke validation |
| **S2** | landed | First import-heavy task (`validate-rfc5321-email`) + dry-run validation |
| **S3** | landed (#512) | Full 15-task corpus (14 new + S2) + 12/15 PASS-DIRECTIONAL + real CVE DB |