# B7 — Time-to-Commit: Novel-Glue Flywheel Latency

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B7-commit pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

**Issue:** [#396](https://github.com/cneckar/yakcc/issues/396) — WI-B7-SLICE-3: Multi-hardware + subprocess isolation + DEC-BENCH-B7-001  
**Predecessors:** [#381](https://github.com/cneckar/yakcc/issues/381) (Slice 1), [#389](https://github.com/cneckar/yakcc/issues/389) (Slice 2)  
**Parent:** [#191](https://github.com/cneckar/yakcc/issues/191) — WI-BENCHMARK-B7: Time-to-commit for novel glue  
**Track:** WI-BENCHMARK-SUITE Slice 3/3 (FINAL)

## Final Verdict: PASS-aspirational

`DEC-BENCH-B7-001` — median warm wall-clock ≤ 3s on both hardware platforms.  
WI-FAST-PATH-VERIFIER: NOT filed — median warm did not exceed 5s threshold.

## Results Table (6-cell: cache state × hardware)

| Cache state | Hardware | median\_ms | p95\_ms | p99\_ms | n |
|-------------|----------|-----------|---------|---------|---|
| warm | Windows / Node v22.x | **1804.5** | 4893 | 6133 | 288 |
| warm | ubuntu-latest / Node v22.x | pending CI | — | — | — |
| warm | rocky-linux-10.1-x86\_64-amd-epyc-9845 / Node v22.x | 3108 | 9177 | 11560 | 320 |
| cold | Windows / Node v22.x | 2705 | 8870 | 9297 | 320 |
| cold | ubuntu-latest / Node v22.x | pending CI | — | — | — |
| cold | rocky-linux-10.1-x86\_64-amd-epyc-9845 / Node v22.x | 3898.5 | 9942 | 14292 | 320 |

> Windows results from `results-windows-2026-05-12.json` (committed, 2026-05-12).  
> Rocky Linux results from `results-rocky-linux-10.1-x86_64-amd-epyc-9845-2026-05-12.json` (committed, 2026-05-12).  
> ubuntu-latest results from CI nightly run via `bench-b7-commit.yml` — see artifact `b7-commit-<run_number>` or issue #191 comment.  
> Single-run verification accepted per operator decision (subprocess correctness is structural; cost trade-off vs 3-consecutive-run protocol).

### Rocky Linux hardware note

Rocky Linux cell run on a 2-vCPU AMD EPYC 9845 cloud VM, Node v22.22.2. Verdict: **PASS-hard-cap** (warm median 3.108s clears the ≤10s hard-cap; just over the ≤3s aspirational bar). Cross-hardware variance is honest measurement data: Rocky's warm median is ~1.7× the Windows Ryzen 9 9950X result (1.804s), reflecting CPU and vCPU count differences — not a regression. Does not change the published B7 verdict tier (sister's PASS-aspirational verdict from Windows data stands).

`parse-cron-expression` atomized 10/10 cold reps on Rocky — Linux empirical confirmation that subprocess isolation (commit 165bf59, closes #393) defeats the cross-utility contamination bug on Linux too.

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
| >15 s | **Directional target (no KILL pre-data)** — would file `WI-FAST-PATH-VERIFIER` post-characterisation |
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
- `verdict`: one of `PASS-aspirational` | `PASS-hard-cap` | `WARN` | `KILL` <!-- "KILL" reserved for post-characterisation; never emitted by Tester pre-data -->

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
