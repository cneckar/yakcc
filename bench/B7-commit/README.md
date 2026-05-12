# B7 — Time-to-Commit: Novel-Glue Flywheel Latency

**Issue:** [#381](https://github.com/cneckar/yakcc/issues/381) — WI-B7-SLICE-1: Harness MVP + initial measurement  
**Parent:** [#191](https://github.com/cneckar/yakcc/issues/191) — WI-BENCHMARK-B7: Time-to-commit for novel glue  
**Track:** WI-BENCHMARK-SUITE Slice 1/3

## What it measures

For each of 5 hand-authored utility functions, the harness measures the wall-clock duration of the novel-glue flywheel round-trip:

```
t0_emit → atomizeEmission → t2_atomized → findCandidatesByIntent → t3_query_hit
```

Two cache states are measured: **cold** (fresh SQLite registry per rep) and **warm** (same registry reused across all 5 reps for a given utility).

Per the KILL gate from #191:

| Median warm wall-clock | Slice 1 verdict |
|------------------------|-----------------|
| ≤3 s                   | PASS-aspirational |
| 3–10 s                 | PASS-hard-cap |
| 10–15 s                | WARN |
| >15 s                  | **KILL** — `WI-FAST-PATH-VERIFIER` filed immediately |

## Small-N caveat

**N=5 reps per (utility × cache state). Total: 50 measurements per run.**

This is an intentionally small sample for a first-pass KILL-gate check. Results should be interpreted as:
- A KILL verdict (>15 s warm median) is reliable: if we can't clear 15 s on 5 reps, the path is not viable.
- A PASS-provisional verdict is a lower bound — the true median may be higher on a cold machine or under CI load.
- Slice 2 expands N, adds more utilities, and produces a statistically meaningful estimate.

## Corpus

5 hand-authored utility functions in `bench/B7-commit/corpus/`:

| File | Function | Description |
|------|----------|-------------|
| `iso-duration-to-seconds.ts` | `isoDurationToSeconds` | Parse ISO 8601 duration → total seconds |
| `is-valid-ipv4.ts` | `isValidIPv4` | Validate dotted-decimal IPv4 address |
| `hamming-distance.ts` | `hammingDistance` | Hamming distance between equal-length strings |
| `camel-to-snake-preserving-acronyms.ts` | `camelToSnakePreservingAcronyms` | camelCase/PascalCase → snake_case with acronym collapsing |
| `array-median.ts` | `arrayMedian` | Compute median of a numeric array |

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

## Output

After a run, results are written to `tmp/B7-commit/slice1-<timestamp>.json`. The file contains:

- `environment`: platform, Node.js version, run timestamp
- `measurements[]`: per-rep timing records with `cacheState`, `utilityName`, `t0_emit`, `t2_atomized`, `t3_query_hit`, `wallMs`, `atomized`, `bmrInTopK`, `combinedScore`
- `aggregate`: median + p95 per cache state
- `verdict.slice_1_call_to_action`: KILL / WARN / PASS-hard-cap / PASS-aspirational / PASS-provisional

## Architecture

The harness calls real `atomizeEmission` from `@yakcc/hooks-base` and real `registry.findCandidatesByIntent` from `@yakcc/registry`. No stubs.

Warm-cache definition: the same SQLite registry instance is reused across all N=5 reps for a given utility. This means the first rep is effectively cold (no prior atoms for that utility) and subsequent reps query a registry that already contains the just-stored atom. This is the cheapest valid definition of "warm" and produces the most optimistic latency estimate.

See `@decision DEC-BENCH-B7-HARNESS-001` in `harness/run.mjs` for full methodology documentation.

## Cross-reference

- `bench/v0-release-smoke/smoke.mjs` — Steps 8b + 9 proved the flywheel round-trip works. Slice 1 times it.
- `bench/B6-airgap/` — B6 shape mirrored here (corpus-spec.json + SHA-256 verification).
- `bench/B1-latency/` — B1 shape mirrored for artifact JSON + verdict gate.
