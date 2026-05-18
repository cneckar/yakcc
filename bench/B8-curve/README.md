# B8-CURVE — Subset-Fraction Sampler + Per-f Loop

## What This Is

B8-CURVE S1 produces the f-sweep curve that B8-SYNTHETIC deferred to its
planned Slice 2. Rather than expanding the B8-SYNTHETIC harness (which
requires a live registry build), this bench dir implements the curve under a
clean scope: a deterministic subset-fraction sampler over the committed
B8-SYNTHETIC truth-table artifact, with zero LLM cost.

The goal is to determine whether the existing N=10 corpus has enough
resolution to characterise the coherence asymptote and curve shape, or
whether a Slice 2 corpus expansion is warranted.

Parent issues: #193 (this slice), #192 (B8-SYNTHETIC parent), #167
(benchmark suite characterisation framing, DEC-BENCH-SUITE-CHARACTERISATION-001).

## Methodology

**Cached truth-table sampling.** The `hit` field for each block comes from a
frozen prior B8-SYNTHETIC run (committed at
`bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json` by
default). S1 does *not* re-simulate live against the registry. This is
explicitly documented in the output artifact `_meta.source_artifact` block,
which records the source file path, its SHA-256, `corpus_n`, and
`corpus_sha256`.

A future `--live` flag (Slice 1.5) is reserved for environments with a built
`packages/registry/dist/` and `bootstrap/yakcc.registry.sqlite`. S1 does not
implement it.

## Sampler Semantics

**Monotone-stable seeded sampling** — for a fixed seed, subsets at lower f
are always subsets of subsets at higher f.

Algorithm: mulberry32 PRNG seeded by the integer `--seed` produces a full
Fisher-Yates shuffle of [0..N-1]. For fraction f we take the first
`ceil(f * N)` indices of that shuffled order, then return them sorted in
ascending original-index order (preserving task ordering in output).

Rationale (`DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001`): independent sampling
at each f would introduce churn that obscures the underlying signal in any
single-seed run. Monotone-stable sampling isolates the corpus-shape effect
from sampling noise, guaranteeing the f-sweep curve is non-decreasing in
sampled set membership for a fixed seed.

`ceil` semantics: `f=0.1` of `N=10` → `k=1` task (not 0). Avoids degenerate
empty subsets at low fractions for small corpora.

## Comparators

Two comparators are applied to each sampled block:

| Comparator | Semantics |
|------------|-----------|
| `naive`    | Every block is treated as a miss. `hook_tokens = raw_tokens` always. This is the 0%-savings floor. |
| `hooked`   | Uses the recorded `hit` from the truth table. If `hit=true`, `hook_tokens = 45` (HOOK_TOKENS_PER_HIT). Else `raw_tokens`. |

The `hooked` comparator reflects realised production behaviour as recorded in
the source artifact. `naive` serves as an unambiguous floor.

Aware-prompt comparator (b) is deferred to Slice 1.5 or later.

## Two Curves

Each run emits two curves:

| Curve | Tasks included |
|-------|---------------|
| `all_tasks` | All sampled tasks regardless of coverage. |
| `tasks_with_coverage` | Sampled tasks filtered to `task_has_coverage === true`. |

When the `tasks_with_coverage` subset is empty (possible at very low f with
N=10), that row emits `n_tasks_sampled=0` and `null` aggregates to distinguish
"empty sample" from "0% savings".

## Pass / KILL Bars

Per `DEC-BENCH-SUITE-CHARACTERISATION-001` (see #167), the five KILL criteria
in `bench/B8-synthetic/RUBRIC.md` are **directional targets only** for S1.
No project-level KILL is triggered pre-data.

**S1 acceptance bar:**
- Produces a coherent curve shape:
  - `naive × all_tasks` mean_savings_pct is 0% everywhere (exact).
  - `hooked × all_tasks` mean_hit_rate is non-decreasing in f (monotone assertion enforced at runtime).
  - `tasks_with_coverage` mean_savings_pct is ≥ `all_tasks` at each f where both are non-null.
- Absolute numbers do not determine S1 acceptance; the curve *shape* does.

## How to Run

```bash
# Default: seed=42, lex-max source artifact, fractions 0..1 in steps of 0.1
node bench/B8-curve/run-curve.mjs

# Custom seed (run multiple to assess variance)
node bench/B8-curve/run-curve.mjs --seed 123
node bench/B8-curve/run-curve.mjs --seed 999

# Custom output path
node bench/B8-curve/run-curve.mjs --seed 42 --out /tmp/check-curve.json

# Explicit source artifact (override lex-max default)
node bench/B8-curve/run-curve.mjs --source bench/B8-synthetic/results-darwin-2026-05-14-slice1.json

# Subset of fractions (e.g. just the endpoints)
node bench/B8-curve/run-curve.mjs --fractions 0,0.5,1.0
```

No `pnpm` script is wired at the repo root for S1 (out of scope). The
bench-local `npm run run` alias works if you `cd bench/B8-curve` first.

Output is written to `bench/B8-curve/results/curve-N<n>-YYYY-MM-DD.json`
by default.

## Decision Point — When to Run S2 Corpus Expansion

After running S1, inspect the printed curve shape and decision-point footer:

1. **Curve asymptotes cleanly by f≈0.6** — N=10 is sufficient resolution.
   Close #193 and defer S2 indefinitely with documented rationale.

2. **Curve still climbing steeply at f=1.0** — N=10 is too small. File a S2
   corpus-expansion work item with target N (e.g. 30 or 100).

3. **High variance across seeds at fixed f** — N=10 is too small. File a S2
   work item with seed-variance evidence.

## Cross-Reference

- `#193` — this work item
- `#192` — B8-SYNTHETIC parent issue
- `#167` — benchmark suite characterisation framing
- `DEC-BENCH-SUITE-CHARACTERISATION-001` — KILL bars are directional targets
- `DEC-BENCH-B8-SYNTHETIC-SLICE1-001` — synthetic harness ceiling semantics
- `DEC-BENCH-B8-CURVE-SLICE1-001` — cached-truth-table sampling rationale
- `DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001` — monotone-stable sampling rationale
- `bench/B8-synthetic/RUBRIC.md` — five KILL criteria (verbatim)
- `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json` — default source artifact
