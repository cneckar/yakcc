# Plan: WI-193 Slice 1 — B8-CURVE Sampler Harness (zero cost)

**Workflow:** `wi-193-s1-b8-curve`
**Goal:** `g-193-s1`
**Work item:** `wi-193-s1`
**Branch:** `feature/193-s1-b8-curve-sampler`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-193-s1-b8-curve-sampler`
**Parent suite:** #167 (WI-BENCHMARK-SUITE) — characterisation framing
**Parent decision:** DEC-BENCH-SUITE-CHARACTERISATION-001 (KILL bars are directional targets only)
**This slice decision (to be annotated in source):** `DEC-BENCH-B8-CURVE-SLICE1-001`

---

## 1. Problem statement

B8-SYNTHETIC produced a single `f=1.0` ceiling point on N=10 tasks. We need a **scaling curve** across `f ∈ {0.0, 0.1, …, 1.0}` to decide whether the existing 10-task corpus has enough resolution to characterise the asymptote and curve shape, or whether **Slice 2 corpus expansion** is warranted.

The operator (#193 confirm 2026-05-18 15:16Z) decided:

- **Method A** (subset-fraction sampling) is the primary scaling axis.
- **Comparators:** (a) naive baseline + (c) hooked (with `findCandidatesByQuery` semantics). **Skip** (b) aware-prompt.
- **Two curves per run:** `all_tasks` and `tasks_with_coverage` (per #167 DQ-9).
- **Five KILL criteria** from `bench/B8-synthetic/RUBRIC.md` are **directional targets**, not hard pass/fail (per DEC-BENCH-SUITE-CHARACTERISATION-001).
- **Zero LLM cost** — deterministic simulation only.

S1 produces the harness + first-pass data. S2 (deferred) is corpus expansion *if* the S1 curve shape warrants it.

---

## 2. Goals and non-goals

### Goals
- Deterministic, seeded subset-fraction sampler over the committed N=10 corpus.
- Per-f loop over `{0.0, 0.1, …, 1.0}` producing per-fraction hit-rate and mean-savings rows for **both** comparators (naive, hooked).
- Two curves emitted per run: `all_tasks` and `tasks_with_coverage`.
- Curve data JSON artifact + ASCII text-mode plot in stdout.
- Decision-point note in dossier: "is N=10 enough or do we need S2?"

### Non-goals (S1)
- Aware-prompt comparator (b)
- LLM API calls (zero cost is hard constraint)
- Corpus expansion (that is S2's scope, decided after this slice's data)
- `MASTER_PLAN.md` edit (follow-up after data observed; forbidden in this slice's scope)
- `bench/B8-synthetic/` modifications (forbidden in scope; read-only consumption only)
- Production plotting (matplotlib/etc.); ASCII plot is acceptable per characterisation framing

---

## 3. Constraints reconciliation (critical)

The operator decision says "per-f loop over EXISTING 10-task corpus" with "zero cost — deterministic simulation only". The existing B8-synthetic simulator (`hit-rate-simulator.mjs`) computes per-block `hit` by calling `registry.findCandidatesByQuery()` against `bootstrap/yakcc.registry.sqlite` — which requires the **built** `packages/registry/dist/` and the registry SQLite file.

**Status check in this worktree:**
- `bootstrap/yakcc.registry.sqlite` — **MISSING**
- `packages/registry/dist/index.js` — **MISSING**
- `bench/B8-synthetic/results-darwin-2026-05-14-slice1.json` — **PRESENT** (committed; contains per-task per-block `hit` truth table from a prior real run)
- `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json` — **PRESENT**

**Resolution:** S1 uses a **cached truth-table** strategy. The sampler reads a committed B8-synthetic results artifact as the per-block hit truth table, then samples subsets and aggregates. This is:

1. **Zero cost** — no LLM calls, no registry lookups, no embeddings.
2. **Deterministic** — same seed + same source artifact = same curve.
3. **Reproducible across machines** — does not require local registry build.
4. **Scope-clean** — does not write `bench/B8-synthetic/`; only reads its committed artifact.
5. **Honest about its semantics** — explicitly documented in README as "subset-of-prior-truth-table sampling" not "live re-simulation".

A `--live` flag is **out of scope for S1** but reserved as a future Slice 1.5 path for environments where the registry is built (it would re-run the simulator per sampled subset). S1's acceptance is the curve shape, not absolute number provenance.

---

## 4. File-by-file plan

All paths relative to the worktree root. All files are net-new (directory does not exist yet).

### 4.1 `bench/B8-curve/sampler.mjs`

Pure ES module. Exports:

```js
// Deterministic seeded sampler. Returns the subset (preserves task order for stability).
//   tasks: array (e.g. perTask rows from the source truth-table artifact)
//   fraction: number in [0, 1]
//   seed: integer
// Algorithm:
//   - If fraction == 0 → return []
//   - If fraction == 1 → return tasks.slice() (no sampling)
//   - Otherwise: mulberry32(seed) PRNG, shuffle indices, take ceil(fraction * N), sort indices ascending, project tasks
//   - ceil semantics chosen so that f=0.1 of N=10 ⇒ k=1 task (not 0); documented in README
export function sampleSubset(tasks, fraction, seed) { ... }

// PRNG (mulberry32) — small, deterministic, well-understood. Embedded inline (no deps).
function mulberry32(a) { ... }
```

Guarantees:
- Same `(tasks, fraction, seed)` → identical output across machines/runs.
- For a fixed `seed`, raising `fraction` is a **superset relation** on the sampled indices (monotone-stable sampling). This avoids spurious curve non-monotonicity from sampling churn. Achieved by: shuffle once per seed, then for each f take the first `ceil(f*N)` indices of the shuffled order.

### 4.2 `bench/B8-curve/per-f-loop.mjs`

Pure ES module. Exports:

```js
// Two comparators applied to each sampled block:
//   - naive:  treats every block as a "miss" (raw_tokens passthrough). No savings ever.
//   - hooked: uses the block's recorded `hit` from the source truth table.
//             If hit → hook_tokens = HOOK_TOKENS_PER_HIT (45). Else → raw_tokens.
// Naive is the floor (0% savings); hooked is the realised behaviour for that subset.
export const COMPARATORS = { naive, hooked };

// Run all fractions × comparators. Returns CurveData.
// fractions default: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
// curves: ['all_tasks', 'tasks_with_coverage']
export function runPerFLoop({ tasks, fractions, seed, comparators }) { ... }
```

Output shape (per row):
```
{
  f, comparator, curve,
  n_tasks_sampled,
  mean_hit_rate, mean_savings_pct, total_savings_pct,
  total_raw_tokens, total_hook_tokens,
}
```

For `tasks_with_coverage` curve at `f` where the sampled subset contains **zero** covered tasks, emit a row with `n_tasks_sampled = 0` and null aggregates (not zero) so downstream consumers can distinguish "empty sample" from "0% savings".

### 4.3 `bench/B8-curve/run-curve.mjs`

CLI entry (executable, `#!/usr/bin/env node`). Invocation:

```
node bench/B8-curve/run-curve.mjs \
  [--seed 42] \
  [--source bench/B8-synthetic/results-darwin-2026-05-14-slice1.json] \
  [--fractions 0,0.1,0.2,...,1.0] \
  [--out bench/B8-curve/results/curve-N10-<date>.json]
```

Defaults:
- `--seed 42`
- `--source` → pick the most recent `bench/B8-synthetic/results-*.json` deterministically (sort filenames lex; if both `darwin` and `linux` exist, document the precedence: prefer `linux` revalidation when both date-equal — but for S1 we just take lex-max which is `results-linux-2026-05-17-revalidation-slice1.json`).
- `--fractions` → `0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0`
- `--out` → `bench/B8-curve/results/curve-N10-YYYY-MM-DD.json` (UTC date in filename)

Steps:
1. Parse args; load the source artifact JSON; validate `_meta.benchmark === 'B8-SYNTHETIC'` and `_meta.corpus_n === 10` (fail loud if not — Sacred Practice #5).
2. Extract `per_task` rows. Each row already has `blocks[]` with `hit` and `raw_tokens`. This is the truth table.
3. Call `runPerFLoop({ tasks: per_task, fractions, seed, comparators: COMPARATORS })`.
4. Build the artifact:
   ```
   {
     _meta: {
       benchmark: 'B8-CURVE',
       slice: 1,
       decision: 'DEC-BENCH-B8-CURVE-SLICE1-001',
       generated_at: ISO,
       seed,
       fractions,
       source_artifact: { path, sha256, corpus_n, corpus_sha256 },
       comparators: ['naive', 'hooked'],
       curves: ['all_tasks', 'tasks_with_coverage'],
       note: 'S1 cached-truth-table sampling. See README for semantics.',
     },
     rows: [...],                  // flat list of {f, comparator, curve, ...}
     ascii_plot: '<multiline str>', // also printed to stdout
   }
   ```
5. `mkdirSync(outDir, {recursive:true})`, write `JSON.stringify(artifact, null, 2)`.
6. Print:
   - Source artifact path + corpus SHA-256
   - Curve table (markdown) for hooked × all_tasks and hooked × tasks_with_coverage
   - ASCII plot: x-axis f (0.0..1.0), y-axis mean_savings_pct, two series (hooked all, hooked covered)
   - "Decision point" footer block: explicit prompt for whether S2 corpus expansion is warranted, with three observable conditions:
     - Curve asymptotes cleanly by f=0.6 → N=10 is sufficient resolution; S2 likely not needed.
     - Curve still climbing steeply at f=1.0 → N=10 is too small; S2 expansion warranted.
     - High variance run-to-run at fixed f (verify by re-running with different seeds) → N=10 is too small.

Performance budget: <30s wall on a fresh clone. (Pure JS, no I/O beyond two file reads and one file write; trivial.)

### 4.4 `bench/B8-curve/README.md`

Sections:
- **What This Is** — B8-CURVE S1 produces the f-sweep curve B8-SYNTHETIC deferred (per its 3-slice plan, Slice 2). Implemented here under a new bench dir to keep scope clean.
- **Methodology** — Cached truth-table sampling. Explicit: `hit` comes from a frozen prior B8-synthetic run; this slice does not re-simulate live. Naming the source artifact and its `corpus_sha256` in the output artifact preserves provenance.
- **Sampler semantics** — Monotone-stable seeded sampling: for a fixed seed, subsets at lower f are subsets of subsets at higher f. Rationale: avoids sampling-churn-induced curve non-monotonicity, which would otherwise obscure the underlying signal.
- **Comparators** — naive (floor; raw passthrough) vs hooked (uses recorded hit). Aware-prompt deferred.
- **Pass/KILL bars** — quote DEC-BENCH-SUITE-CHARACTERISATION-001 verbatim: directional targets only; no project-level KILL triggered pre-data.
- **Acceptance bar (S1)** — produces a coherent curve shape (monotone-non-decreasing in hooked × all_tasks; `naive × all_tasks` is 0% everywhere; `tasks_with_coverage` is ≥ `all_tasks`). Absolute numbers do not matter for S1 acceptance.
- **Running** — `node bench/B8-curve/run-curve.mjs` (no pnpm script in S1; can be added in follow-up if useful).
- **Decision point** — when to run S2 corpus expansion (the three observable conditions above).
- **Cross-reference** — #193, #167, #192, DEC-BENCH-SUITE-CHARACTERISATION-001, DEC-BENCH-B8-SYNTHETIC-SLICE1-001.

### 4.5 `bench/B8-curve/package.json`

Bench-local manifest. Zero dependencies. Just for `type: "module"` declaration and identification.

```json
{
  "name": "@yakcc/bench-b8-curve",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "B8-CURVE — subset-fraction sampler + per-f loop over the B8-SYNTHETIC corpus.",
  "scripts": {
    "run": "node ./run-curve.mjs"
  }
}
```

No `dependencies` block (pure Node stdlib).

### 4.6 `plans/wi-193-s1-b8-curve.md`

This file. Lives in `plans/` per scope manifest.

---

## 5. Authority and integration map

**State authority touched:** `b8-curve-sampler` (per workflow authority domains). New; this slice creates it. No conflict with `b8-synthetic-sampler` or any registry/embedder authority.

**Read-only inputs:**
- `bench/B8-synthetic/results-*.json` — committed prior simulator output. Treated as immutable provenance source.

**No writes** to `bench/B8-synthetic/`, `packages/`, `MASTER_PLAN.md`, hooks, docs, scripts. All scope-forbidden per workflow contract.

**Outputs:**
- `bench/B8-curve/results/curve-N10-<date>.json` (under allowed prefix `bench/B8-curve/**`)
- stdout (markdown table + ASCII plot)

**Decision annotation:** `DEC-BENCH-B8-CURVE-SLICE1-001` lives as a JSDoc `@decision` block in `bench/B8-curve/run-curve.mjs` (the orchestrator), mirroring how `DEC-BENCH-B8-SYNTHETIC-SLICE1-001` lives in `bench/B8-synthetic/hit-rate-simulator.mjs`. **No `MASTER_PLAN.md` edit** in this slice; that is a documented follow-up after data is observed.

---

## 6. Risk register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Curve looks fake because hits come from a frozen artifact | Medium | Medium | README is loud about cached-truth-table semantics; output artifact `_meta.source_artifact` records path + sha256; future Slice 1.5 `--live` mode reserved |
| Sampler non-monotone churn obscures signal | Medium | High | Monotone-stable sampling (shuffle once per seed; take prefix). Documented + asserted in unit-style runtime check in run-curve.mjs (`hooked × all_tasks` mean_hit_rate must be non-decreasing in f for fixed seed) |
| Source artifact missing or schema-drifted | Low | High | Validate `_meta.benchmark === 'B8-SYNTHETIC'`, `corpus_n === 10`, per_task[].blocks[].hit existence; fail loud with explicit path + expected shape |
| Two committed result artifacts (darwin + linux) confuse provenance | Low | Low | Default to lex-max filename; document precedence; allow `--source` override |
| At low f, `tasks_with_coverage` curve is empty (n=0) | High | Low | Explicitly emit `n_tasks_sampled=0` + null aggregates rather than crash or emit `0.0` |
| Operator interprets "real curve data" as live re-simulation | Medium | Medium | README front-matter explicitly contrasts S1 (cached-truth-table) vs hypothetical S1.5 (live re-simulation) vs S2 (corpus expansion). Decision-point block in stdout calls this out. |

---

## 7. Evaluation Contract (verbatim from dispatch)

1. `bench/B8-curve/sampler.mjs` exports `sampleSubset(registry, fraction, seed) → SampledRegistry` (deterministic given seed)
   - **Implementer note:** the dispatch spec uses "registry" loosely; concretely the input is the array of per-task truth-table rows. Function signature: `sampleSubset(tasks, fraction, seed) → tasks[]`. Keep the export name `sampleSubset`.
2. `bench/B8-curve/per-f-loop.mjs` exports `runPerFLoop(registry, fractions, seed, comparators) → CurveData`
   - **Implementer note:** options-bag form `runPerFLoop({ tasks, fractions, seed, comparators })` is acceptable (preferred for clarity); keep the export name `runPerFLoop`.
3. `bench/B8-curve/run-curve.mjs` is the CLI entry. Invocation: `node bench/B8-curve/run-curve.mjs [--seed N] [--out path]`
4. Default invocation produces `bench/B8-curve/results/curve-N10-<date>.json` with per-fraction rows for both comparators (naive + hooked)
5. Output JSON includes both curves (all_tasks, tasks_with_coverage)
6. README documents scope, methodology, S1 acceptance bar
7. `package.json` is bench-local (no deps for S1 — pure Node), `type: module`
8. `node bench/B8-curve/run-curve.mjs` on a fresh worktree clone produces results in <30s
9. Output curve data is deterministic given fixed seed
10. `plans/wi-193-s1-b8-curve.md` documents the plan (this file)

---

## 8. Scope Manifest (verbatim from workflow contract)

**Allowed:**
- `bench/B8-curve/*`
- `bench/B8-curve/**/*`
- `plans/wi-193-s1-b8-curve.md`
- `tmp/wi-193-s1-*` (and recursive)

**Required:**
- `bench/B8-curve/sampler.mjs`
- `bench/B8-curve/per-f-loop.mjs`
- `bench/B8-curve/run-curve.mjs`
- `bench/B8-curve/README.md`
- `bench/B8-curve/package.json`
- `plans/wi-193-s1-b8-curve.md`

**Forbidden** (selected highlights):
- `packages/**`, `bench/B8-synthetic/**`, all other `bench/B*/**`, `MASTER_PLAN.md`, `docs/**`, `.github/**`, `.claude/**`, `scripts/**`, `examples/**`, `bootstrap/**`

---

## 9. Out of scope (explicit, S1)

- Aware-prompt comparator (b) — Slice 1.5 or later
- LLM API calls (zero cost is hard constraint)
- Live registry re-simulation per sampled subset (Slice 1.5 path reserved)
- Corpus expansion (Slice 2; decision deferred to post-S1 observation)
- `MASTER_PLAN.md` edit (follow-up after data observed)
- `bench/B8-synthetic/` modifications (scope-forbidden; read-only consumption only)
- Production-grade plotting (matplotlib/etc.) — ASCII plot suffices
- `pnpm bench:*` script wiring at repo root (not in scope; bench-local `npm run` is enough)
- New decisions in `MASTER_PLAN.md` decision log (DEC entry is JSDoc-annotated in source only for S1)

---

## 10. Decision Log (this slice)

- **DEC-BENCH-B8-CURVE-SLICE1-001** (proposed; annotated in `run-curve.mjs`):
  - **Title:** B8-CURVE S1 uses cached-truth-table sampling over a committed B8-SYNTHETIC artifact, not live registry re-simulation.
  - **Rationale:** Zero LLM cost is a hard constraint; this worktree does not have a built `packages/registry/dist/` or `bootstrap/yakcc.registry.sqlite`. The B8-SYNTHETIC committed results carry per-block `hit` truth from a prior real run with documented `corpus_sha256` and `registry_path`. Sampling that truth table at fraction f is mathematically equivalent to re-running the simulator on a deterministic subset of the corpus (because the simulator is deterministic given fixed registry state). Provenance is preserved in the output `_meta.source_artifact` block.
  - **Status:** Proposed in S1; promoted to MASTER_PLAN in the follow-up slice that observes the data.

- **DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001** (proposed; annotated in `sampler.mjs`):
  - **Title:** Monotone-stable seeded sampling (shuffle once per seed; take prefix per f).
  - **Rationale:** Independent sampling at each f would introduce churn that obscures the underlying signal in any single-seed run. Monotone-stable sampling guarantees that the f-sweep curve is non-decreasing in sampled set membership, isolating the corpus-shape effect from sampling noise.

---

## 11. Next steps after this slice

1. Run `node bench/B8-curve/run-curve.mjs` on this branch; capture the curve artifact + stdout.
2. **Observe the data** (operator/planner decision boundary):
   - Curve asymptotes cleanly by f≈0.6 → close #193, defer S2 indefinitely with documented rationale.
   - Curve still climbing at f=1.0 → file S2 corpus-expansion work item with target N (e.g. 30 or 100).
   - High variance across seeds → file S2 corpus-expansion work item with seed-variance evidence.
3. Promote `DEC-BENCH-B8-CURVE-SLICE1-001` (and `-MONOTONE-SAMPLING-001`) into `MASTER_PLAN.md` decision log in the follow-up slice (out of scope here).
4. Optional Slice 1.5: add `--live` flag to `run-curve.mjs` that re-invokes `hit-rate-simulator.mjs` per sampled subset, for environments with a built registry. Out of scope here.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: B8-CURVE S1 plan written; implementer dispatch ready for sampler+per-f loop+CLI+README+package.json over committed B8-synthetic truth-table artifact (zero cost, deterministic, scope-clean).
