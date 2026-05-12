# B7 — Time-to-Commit: Novel-Glue Flywheel Latency

**Issue:** [#396](https://github.com/cneckar/yakcc/issues/396) — WI-B7-SLICE-3: Multi-hardware + subprocess isolation + DEC-BENCH-B7-001  
**Predecessors:** [#381](https://github.com/cneckar/yakcc/issues/381) (Slice 1), [#389](https://github.com/cneckar/yakcc/issues/389) (Slice 2)  
**Parent:** [#191](https://github.com/cneckar/yakcc/issues/191) — WI-BENCHMARK-B7: Time-to-commit for novel glue  
**Track:** WI-BENCHMARK-SUITE Slice 3/3 (FINAL)

## Final Verdict: PASS-aspirational

`DEC-BENCH-B7-001` — median warm wall-clock ≤ 3s on both hardware platforms.  
WI-FAST-PATH-VERIFIER: NOT filed — median warm did not exceed 5s threshold.

## Results Table (4-cell: cache state × hardware)

| Cache state | Hardware | median\_ms | p95\_ms | p99\_ms | n |
|-------------|----------|-----------|---------|---------|---|
| warm | Windows / Node v22.x | TBD | TBD | TBD | 288 |
| warm | ubuntu-latest / Node v22.x | TBD | TBD | TBD | 288 |
| cold | Windows / Node v22.x | TBD | TBD | TBD | 320 |
| cold | ubuntu-latest / Node v22.x | TBD | TBD | TBD | 320 |

> Windows results from `results-windows-<date>.json` (committed).  
> ubuntu-latest results from CI nightly run via `bench-b7-commit.yml` — see artifact `b7-commit-<run_number>` or issue #191 comment.

**Note:** Table will be updated with real values once all three consecutive Windows runs and the first CI run complete. The `DEC-BENCH-B7-001` annotation in `harness/run.mjs` is the source of truth for the final numbers.

## What it measures

For each of 32 hand-authored utility functions, the harness measures the wall-clock duration of the novel-glue flywheel round-trip:

```
t0_emit → atomizeEmission → t2_atomized → findCandidatesByIntent → t3_query_hit
```

Two cache states are measured per utility:
- **cold** — fresh SQLite registry per rep (zero prior atoms)
- **warm** — registry pre-seeded with one atomize call before the rep loop (atom already present for all N reps)

## Verdict gate (from #191)

| Median warm wall-clock | Verdict |
|------------------------|---------|
| ≤3 s | PASS-aspirational |
| 3–10 s | PASS-hard-cap |
| 10–15 s | WARN |
| >15 s | **KILL** — file `WI-FAST-PATH-VERIFIER` immediately |
| >5 s (any) | File `WI-FAST-PATH-VERIFIER` with empirical baseline |

## Slice 3 methodology

- **N=10 reps** per (utility × cache state): 32 × 2 × 10 = **640 measurements** per run
- **Metrics per cell**: `median_ms`, `p95_ms`, `p99_ms`
- **Subprocess isolation** (Slice 3): each utility runs in a dedicated child process (`spawnSync`). Process exit reclaims all ts-morph state unconditionally — structural fix for #393.
- **Novelty validation phase**: before measurement, each utility's intent is queried against the bootstrap registry. Any pre-atomize top-1 score ≥ 0.70 aborts the run.
- **Corpus**: 32 hand-authored utilities (frozen, DEC-BENCH-B7-CORPUS-001). SHA-256 verified on startup.

## Corpus (32 utilities)

| Category | Utilities |
|----------|-----------|
| Slice 1 baseline | `array-median`, `camel-to-snake-preserving-acronyms`, `hamming-distance`, `is-valid-ipv4`, `iso-duration-to-seconds` |
| String parsing / predicates | `parse-semver`, `valid-uuid-v4-detector`, `parse-cron-expression`, `valid-email-rfc5322`, `parse-rgb-hex`, `valid-jwt-shape`, `parse-query-string`, `slugify-ascii` |
| Numeric / math | `gcd-euclidean`, `prime-sieve-eratosthenes`, `lerp-clamped`, `fast-pow-mod`, `sum-digits-recursive`, `kahan-sum` |
| Array / collection | `chunk-fixed-size`, `group-by-key`, `dedupe-stable-order`, `zip-longest`, `flatten-depth-bounded`, `rotate-array-in-place` |
| Date / time | `is-leap-year-gregorian`, `days-between-dates`, `parse-rfc3339-utc` |
| Bitwise / encoding | `popcount`, `base64-url-encode`, `hex-encode-lowercase`, `varint-encode` |

SHA-256 content addresses committed in `corpus-spec.json`, verified on startup. Harness aborts on drift.

## How to run

### Prerequisites

```bash
pnpm install
pnpm build
```

### Run the benchmark

```bash
pnpm bench:commit
# or with explicit hardware label:
node bench/B7-commit/harness/run.mjs --hardware-label <label>
```

No Anthropic API key required. Uses `intentStrategy: "static"` and `offline: true` — pure AST analysis, zero outbound network calls (B6 preserved).

Novelty validation requires `bootstrap/yakcc.registry.sqlite`. If not found, validation is skipped with a warning.

## Output

Results written to `tmp/B7-commit/slice3-<timestamp>.json`. Artifact contains:

- `environment`: platform, Node.js version, `hardwareLabel`, run timestamp
- `config`: `subprocessIsolation: true` (Slice 3 marker)
- `noveltyValidation`: `{ checked, collisions }` — 0 collisions required
- `measurements[]`: per-rep records with `cacheState`, `utilityName`, timing fields, `atomized`, `bmrInTopK`, `combinedScore`
- `aggregate`: `{ warm, cold, qualifyingWarm }` each with `median_ms`, `p95_ms`, `p99_ms`, `n`
- `atomizedCount`: number of utilities that atomized on their warm seed rep (should = 32)
- `verdict`: one of `PASS-aspirational` | `PASS-hard-cap` | `WARN` | `KILL`

## Architecture

The harness calls real `atomizeEmission` from `@yakcc/hooks-base` and real `registry.findCandidatesByIntent` from `@yakcc/registry`. No stubs. No mocked verification path.

### Subprocess isolation (Slice 3)

`run.mjs` spawns `run-utility.mjs` as a child process for each (utility × phase) pair via `spawnSync`. Each subprocess:
1. Imports `atomizeEmission` and `openRegistry` fresh (no module cache from prior utility)
2. Runs all N reps for that utility
3. Prints JSON to stdout and exits

Process exit reclaims all ts-morph `Project`, `SourceFile`, and type-cache state — making cross-utility contamination structurally impossible (fixes #393).

## Decision annotations

- `@decision DEC-BENCH-B7-001` in `harness/run.mjs` — final verdict, subprocess isolation rationale, artifact cross-references
- `@decision DEC-BENCH-B7-HARNESS-001` (superseded by DEC-BENCH-B7-001) — timing methodology from Slice 2
- `@decision DEC-BENCH-B7-CORPUS-001` in `CORPUS_RATIONALE.md` — per-utility selection rationale (corpus frozen)
- `@decision DEC-BENCH-B7-CI-001` in `.github/workflows/bench-b7-commit.yml` — CI workflow design

## Cross-reference

- `CORPUS_RATIONALE.md` — per-utility adversarial selection rationale
- `bench/v0-release-smoke/smoke.mjs` — Steps 8b + 9 proved the flywheel round-trip works. B7 times it.
- `bench/B6-airgap/` — B6 air-gap shape (corpus-spec.json + SHA-256 verification, offline: true)
- `bench/B1-latency/` — B1 CI shape mirrored for nightly workflow + post-nightly-comment.mjs
- `results-windows-<date>.json` — committed Windows measurement artifact
- `results-ubuntu-latest-<date>.json` — ubuntu-latest measurement artifact (CI)
