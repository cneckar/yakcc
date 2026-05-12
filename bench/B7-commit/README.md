# B7 — Time-to-Commit: Novel-Glue Flywheel Latency

**Issue:** [#389](https://github.com/cneckar/yakcc/issues/389) — WI-B7-SLICE-2: Corpus scale-up to ≥30 + cache-state split  
**Predecessor:** [#381](https://github.com/cneckar/yakcc/issues/381) — WI-B7-SLICE-1 (PASS-aspirational verdict, median warm 1.5–1.9 s on N=5)  
**Parent:** [#191](https://github.com/cneckar/yakcc/issues/191) — WI-BENCHMARK-B7: Time-to-commit for novel glue  
**Track:** WI-BENCHMARK-SUITE Slice 2/3

## What it measures

For each of 32 hand-authored utility functions, the harness measures the wall-clock duration of the novel-glue flywheel round-trip:

```
t0_emit → atomizeEmission → t2_atomized → findCandidatesByIntent → t3_query_hit
```

Two cache states are measured per utility:
- **cold** — fresh SQLite registry per rep (zero prior atoms)
- **warm** — registry pre-seeded with one atomize call before the rep loop (atom already present for all N reps)

The Slice 2 warm definition is tighter than Slice 1: all 10 reps operate on a warm registry (no bimodal first-rep effect). See `DEC-BENCH-B7-HARNESS-001` in `harness/run.mjs`.

## Verdict gate (from #191)

| Median warm wall-clock | Verdict |
|------------------------|---------|
| ≤3 s | PASS-aspirational |
| 3–10 s | PASS-hard-cap |
| 10–15 s | WARN |
| >15 s | **KILL** — file `WI-FAST-PATH-VERIFIER` immediately |

## Slice 2 methodology

- **N=10 reps** per (utility × cache state): 32 × 2 × 10 = **640 measurements** per run
- **Metrics per cell**: `median_ms`, `p95_ms`, `p99_ms`
- **Novelty validation phase**: before measurement, each utility's intent is queried against the bootstrap registry. Any pre-atomize top-1 score ≥ 0.70 aborts the run — utilities colliding with the bootstrap corpus violate the novel-glue framing.
- **Corpus rationale**: see `CORPUS_RATIONALE.md` for per-utility selection rationale and adversarial framing documentation.

## Corpus (32 utilities)

| Category | Utilities |
|----------|-----------|
| Slice 1 baseline | `array-median`, `camel-to-snake-preserving-acronyms`, `hamming-distance`, `is-valid-ipv4`, `iso-duration-to-seconds` |
| String parsing / predicates | `parse-semver`, `valid-uuid-v4-detector`, `parse-cron-expression`, `valid-email-rfc5322`, `parse-rgb-hex`, `valid-jwt-shape`, `parse-query-string`, `slugify-ascii` |
| Numeric / math | `gcd-euclidean`, `prime-sieve-eratosthenes`, `lerp-clamped`, `fast-pow-mod`, `sum-digits-recursive`, `kahan-sum` |
| Array / collection | `chunk-fixed-size`, `group-by-key`, `dedupe-stable-order`, `zip-longest`, `flatten-depth-bounded`, `rotate-array-in-place` |
| Date / time | `is-leap-year-gregorian`, `days-between-dates`, `parse-rfc3339-utc` |
| Bitwise / encoding | `popcount`, `base64-url-encode`, `hex-encode-lowercase`, `varint-encode` |

SHA-256 content addresses are committed in `corpus-spec.json` and verified on startup. The harness aborts on drift.

## How to run

### Prerequisites

```bash
pnpm install
pnpm build
```

### Run the benchmark

```bash
pnpm bench:commit
```

Or directly:

```bash
node bench/B7-commit/harness/run.mjs
```

No Anthropic API key required. The harness uses `intentStrategy: "static"` and `offline: true` — pure AST analysis, zero outbound network calls (B6 preserved).

The novelty validation phase requires `bootstrap/yakcc.registry.sqlite` to be present (produced by `pnpm run bootstrap` or `yakcc seed --yakcc`). If the bootstrap sqlite is not found, novelty validation is skipped with a warning.

## Output

After a run, results are written to `tmp/B7-commit/slice2-<timestamp>.json`. The artifact contains:

- `environment`: platform, Node.js version, run timestamp
- `noveltyValidation`: `{ checked, collisions }` — 0 collisions required
- `measurements[]`: per-rep records with `cacheState`, `utilityName`, rep timing fields, `atomized`, `bmrInTopK`, `combinedScore`
- `aggregate`: `{ warm, cold, qualifyingWarm }` each with `median_ms`, `p95_ms`, `p99_ms`, `n`
- `verdict`: one of `PASS-aspirational` | `PASS-hard-cap` | `WARN` | `KILL`

## Architecture

The harness calls real `atomizeEmission` from `@yakcc/hooks-base` and real `registry.findCandidatesByIntent` from `@yakcc/registry`. No stubs. No mocked verification path.

See `@decision DEC-BENCH-B7-HARNESS-001` in `harness/run.mjs` for full methodology documentation (timing capture points, registry isolation, warm-cache evolution from Slice 1 to Slice 2).

See `@decision DEC-BENCH-B7-CORPUS-001` in `CORPUS_RATIONALE.md` for corpus selection rationale and adversarial framing.

## Cross-reference

- `CORPUS_RATIONALE.md` — per-utility adversarial selection rationale
- `bench/v0-release-smoke/smoke.mjs` — Steps 8b + 9 proved the flywheel round-trip works. B7 times it.
- `bench/B6-airgap/` — B6 shape mirrored here (corpus-spec.json + SHA-256 verification).
- `bench/B1-latency/` — B1 shape mirrored for artifact JSON + verdict gate.
