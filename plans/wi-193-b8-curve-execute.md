# Plan: WI-193 — Execute B8-CURVE S1 + decide on S2 expansion

**Workflow:** `wi-193-b8-curve-execute`
**Goal:** `g-wi-193-b8-curve-execute`
**Work item:** `wi-193-b8-curve-execute-planner`
**Branch:** `feature/wi-193-b8-curve-execute`
**Worktree:** `C:/src/yakcc/.worktrees/feature-wi-193-b8-curve-execute`
**Parent suite:** #167 (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS), DEC-BENCH-SUITE-CHARACTERISATION-001 (KILL bars are directional targets only)
**Apparatus shipped:** PR #730 (commit `9735b7b`), merged 2026-05-18 — `bench/B8-curve/{sampler,per-f-loop,run-curve}.mjs`, README, package.json
**This slice decision (proposed, annotate in MASTER_PLAN.md):** `DEC-BENCH-B8-CURVE-EXECUTE-001`
**Tier:** Standard (Tier 2)

---

## 1. Problem statement

PR #730 shipped the B8-CURVE S1 **apparatus** (deterministic subset-fraction sampler, per-f loop, CLI) but did NOT execute it. `bench/B8-curve/results/` is empty. The operator's design rule (issue #193 comment 2026-05-18T15:16Z) is:

> *"Don't pre-commit to S2/S3 until S1 surfaces signal. Reasons: S1 is zero-cost — fire-and-observe before spending budget. S1's low-N curve tells us whether the methodology produces a coherent shape; if it doesn't, S2 corpus expansion is wasted work."*

This WI executes S1 (zero cost), characterises the curve, and produces an explicit, evidence-backed decision: pursue S2 corpus expansion OR descope S2/S3 and close #193 with documented rationale.

**Who has this problem:** anyone evaluating whether yakcc's hook layer produces meaningful token savings at production hit rates. The B8 family of benchmarks is load-bearing for the project's value claim ("at X% intent hit rate, savings are Y%").

**Cost of not solving:** #193 sits open with apparatus-but-no-data; the operator cannot decide whether to spend the $20–30 S2 budget on corpus expansion; the benchmark suite is incomplete.

## 2. Pre-planning evidence (planner audit)

The planner inspected the worktree and ran one read-only query against the source artifact. Findings:

**Apparatus present (all under `bench/B8-curve/`):**
- `README.md` (140 lines) — methodology, semantics, decision rubric
- `sampler.mjs` (124 lines) — `sampleSubset(tasks, fraction, seed)` exports
- `per-f-loop.mjs` (249 lines) — `runPerFLoop({tasks, fractions, seed, comparators})` + `COMPARATORS = {naive, hooked}`
- `run-curve.mjs` (471 lines) — CLI entry with `--seed`, `--source`, `--fractions`, `--out`
- `package.json` — bench-local manifest, zero deps
- `results/` — empty directory

**Source artifact present:** `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json`
- `_meta.benchmark = "B8-SYNTHETIC"` (validates apparatus's loud check)
- `_meta.corpus_n = 10` (validates apparatus's loud check)
- `_meta.corpus_sha256 = 40788cc0…4477a3`
- `_meta.note` records WI-611 Slice 1 revalidation, registry from `.yakcc/registry.sqlite` mtime 2026-05-17, **registry predates all WI-510 slices**

**Critical empirical finding — the truth table:**

```
totalBlocks=38, totalHits=0, corpus_hit_rate=0.000
all 10 tasks: task_has_coverage=false, task_hit_rate=0.000
```

The 2026-05-17 source artifact records **zero hits across all 38 blocks on all 10 tasks**. This is consistent with the artifact's own `_meta.registry_state_summary.known_missing_initiatives` block, which lists 15 WI-510/WI-579 slices landed AFTER registry birth (2026-05-12) but NOT reflected in the registry mtime-2026-05-17 state. The cached truth table is honest about being cached, and what it caches is "zero coverage at the time the registry was last reseeded."

**Consequence for S1 curve:** Every comparator × curve combination will emit identical, flat aggregates:
- `naive × all_tasks`: 0% savings everywhere (by comparator definition — naive treats every block as miss).
- `hooked × all_tasks`: 0% hit rate, 0% savings everywhere (because every block has `hit=false` in the truth table; hooked falls through to raw passthrough).
- `naive × tasks_with_coverage`: `n_tasks_sampled=0` and null aggregates at every f (no tasks have `task_has_coverage=true`).
- `hooked × tasks_with_coverage`: same — `n_tasks_sampled=0`, null aggregates at every f.

The monotonicity assertion in `run-curve.mjs` (`hooked × all_tasks` mean_hit_rate non-decreasing in f) holds **vacuously** at flat zero.

This is itself the signal. It is not a methodology failure — it is the methodology working correctly to surface an upstream truth: the cached source artifact is corpus-misaligned (registry state predates the hook-discoverable bindings that landed in WI-510 Slices 1–8 and WI-579 Slices 1–6). The decision-branch in §6 absorbs this as a first-class outcome.

## 3. Goals and non-goals

### Goals
- Run `node bench/B8-curve/run-curve.mjs` at least once at seed=42 with default lex-max source artifact; capture `_meta.source_artifact` provenance block in committed JSON.
- Run two additional seeds (`--seed 123`, `--seed 999`) for variance assessment (zero cost; deterministic).
- Produce an explicit characterisation analysis: curve shape, slope f=0.6→1.0, variance across seeds, coverage subset population.
- Produce an explicit decision artifact:
  1. **S2 warranted** → file follow-up WI with target N and rationale; OR
  2. **S2 descoped (apparatus-OK, source-stale)** → re-source artifact (run a fresh B8-SYNTHETIC against current registry) is the actual unblock, not corpus expansion; document and close; OR
  3. **S2 descoped (methodology-limit)** → document the limit, defer S2 indefinitely, close #193.
- Append `DEC-BENCH-B8-CURVE-EXECUTE-001` to `MASTER_PLAN.md` Decision Log with the chosen branch + rationale.
- Update the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative section in `MASTER_PLAN.md` to reflect WI-193 terminal state.

### Non-goals
- **No source modifications to `bench/B8-curve/*.mjs`** — apparatus is correct as shipped in PR #730; this WI only consumes it.
- **No regeneration of `bench/B8-synthetic/results-*.json`** — that is a different WI (cost profile differs; live registry/embedder required; would touch B8-SYNTHETIC scope).
- **No live `--live` mode** — Slice 1.5 reserved in README.
- **No corpus expansion in this WI** — corpus expansion is S2 (only filed/dispatched IF the analysis warrants it).
- **No aware-prompt comparator (b)** — deferred per Slice 1 scope.
- **No `pnpm bench:b8-curve` script** — bench-local invocation is sufficient; root wiring is a separate follow-up if needed.
- **No `.github/workflows/` edit** — manual invocation only; not a CI gate.

## 4. Architecture / state-authority map

No new state authorities. This WI consumes one and writes one.

| Domain | Authority (this WI) | Action |
|---|---|---|
| `b8-synthetic-truth-table` | `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json` (read-only consumer) | READ — validated by `run-curve.mjs` loud checks |
| `b8-curve-apparatus` | `bench/B8-curve/{sampler,per-f-loop,run-curve}.mjs` (read-only consumer of execution) | EXECUTE only |
| `b8-curve-results` | `bench/B8-curve/results/curve-N10-<date>.json` | WRITE — new authority; this WI creates first instance |
| `bench-b8-curve-decision` | `MASTER_PLAN.md` Decision Log + `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative row + #193 comment | WRITE — terminal verdict |

**No parallel mechanisms.** This WI does not introduce a new sampler, new comparator, new CLI, or new bench dir. Every produced artifact path is under the apparatus's expected output prefix.

**Integration with #167.** Per `DEC-BENCH-SUITE-CHARACTERISATION-001` (Principle 1, "No KILL pre-data") and `DEC-BENCH-B8-SYNTHETIC-SLICE1-001`, the five RUBRIC.md KILL bars are directional targets only. The curve being flat at 0% does NOT trigger a project-level KILL — it triggers an honesty-clause observation: "B8-CURVE S1 at the 2026-05-17 source-artifact snapshot produced a flat 0% curve; the registry state captured by that snapshot predates 15 named WI-510/WI-579 slices."

## 5. Execution plan (work item slice)

Single guardian-bound implementer work item: **WI-193-EXEC-1**.

### 5.1 Suggested commit boundaries (informational, implementer judgment)

- **C1 (planner-owned, already complete on planner commit):** this plan file + scope JSON + MASTER_PLAN row reservation.
- **C2 (implementer):** execute apparatus at three seeds; commit three curve JSONs to `bench/B8-curve/results/`.
- **C3 (implementer):** append analysis section + decision to `MASTER_PLAN.md` (per chosen Phase B/C branch below); post #193 comment as a checklist of what changed; final commit.

The implementer MAY consolidate C2+C3 into a single commit if the analysis is short and the diff stays scoped.

### 5.2 Exact invocations

The implementer MUST run these from the worktree root, `C:/src/yakcc/.worktrees/feature-wi-193-b8-curve-execute`.

```powershell
# Seed 42 — primary curve
node bench/B8-curve/run-curve.mjs --seed 42 --out bench/B8-curve/results/curve-N10-2026-05-18-seed42.json

# Seed 123 — variance check
node bench/B8-curve/run-curve.mjs --seed 123 --out bench/B8-curve/results/curve-N10-2026-05-18-seed123.json

# Seed 999 — second variance check
node bench/B8-curve/run-curve.mjs --seed 999 --out bench/B8-curve/results/curve-N10-2026-05-18-seed999.json
```

Each invocation will:
1. Locate source artifact via lex-max in `bench/B8-synthetic/results-*.json` → resolves to `results-linux-2026-05-17-revalidation-slice1.json` (planner verified).
2. Validate `_meta.benchmark === "B8-SYNTHETIC"` and `_meta.corpus_n === 10` (passes — planner verified).
3. Compute the per-f loop over `f ∈ {0.0, 0.1, …, 1.0}` × `{naive, hooked}` × `{all_tasks, tasks_with_coverage}` = 44 rows per run.
4. Assert monotonicity on `hooked × all_tasks` mean_hit_rate (passes vacuously at flat 0%).
5. Write artifact JSON; print markdown tables + ASCII plot + decision footer to stdout.

Performance budget: <5 seconds wall per invocation (pure-JS arithmetic over 38 blocks × 11 fractions).

**Note on output filename:** The README's default output uses `curve-N10-YYYY-MM-DD.json` with no seed suffix; for variance studies the implementer must pass `--out` explicitly to avoid filename collision between seeds. The required file `bench/B8-curve/results/curve-N10-2026-05-18.json` in the Evaluation Contract is satisfied by **any one** of the three seed runs being renamed/copied to that canonical filename, OR by passing `--out bench/B8-curve/results/curve-N10-2026-05-18.json` on the seed=42 run. Implementer chooses; pick the form that keeps history clean.

### 5.3 Capture stdout to a dossier

Implementer SHOULD capture each run's stdout to `bench/B8-curve/results/stdout-seed<N>-2026-05-18.txt` (or equivalent). This is informational, not required-for-Guardian — the JSON artifact is the source of truth — but it preserves the human-readable markdown tables + ASCII plot + decision footer alongside the data. If stdout-capture would create scope confusion, prefer pasting the tables into the analysis section in the next step (§6) instead.

## 6. Analysis criteria and decision branch

After the three seed runs, the implementer inspects the artifacts and chooses ONE branch.

### 6.1 Definitions

- **Coherent signal**: `hooked × all_tasks mean_hit_rate` is monotone-non-decreasing in f (apparatus enforces this at runtime), AND values strictly increase from f=0 to f=1, AND f=0.6→1.0 slope < 0.5pp (curve has asymptoted) per the apparatus's decision footer.
- **Climbing-at-f=1.0**: slope f=0.6→1.0 > 0.5pp; curve has not asymptoted; suggests N=10 is too small.
- **High seed variance**: at any fixed f, the spread of `hooked × all_tasks mean_savings_pct` across seeds {42, 123, 999} exceeds 10pp. Suggests N=10 is too small.
- **Flat-at-zero (degenerate signal — observed in planner audit)**: `hooked × all_tasks mean_hit_rate` is exactly 0.0 at every f. This is what the planner expects given the 2026-05-17 source artifact's 0-hit truth table.

### 6.2 Decision branches (mutually exclusive — pick one)

**Branch A — Coherent signal, asymptote visible:**
- Conclusion: N=10 has sufficient resolution.
- Action: file no S2 expansion WI. Document the asymptote estimate + confidence intervals in MASTER_PLAN. Close #193 with link to the curve artifact. Defer S2 indefinitely with rationale.

**Branch B — Climbing at f=1.0 and/or high seed variance:**
- Conclusion: N=10 is undersized; S2 corpus expansion is warranted.
- Action: file `WI-193-S2-CORPUS-EXPANSION` planner-followup with target N (recommend N=30 first; N=100 if budget allows) and the seed-variance evidence as justification. Update `MASTER_PLAN.md` initiative row to show S2 active. Do NOT close #193 yet.

**Branch C — Flat-at-zero (degenerate signal):**
- Conclusion: the cached source artifact's truth table is corpus-misaligned (registry pre-dates the hook-discoverable bindings that landed in WI-510/WI-579 between 2026-05-12 and 2026-05-17). S1's apparatus is correct; the curve is flat because the upstream cache is flat. **S2 corpus expansion would not fix this** — expanding from N=10 to N=30 against a registry that has 0% hit rate just produces a larger 0% sample. The actual unblock is **re-sourcing the B8-SYNTHETIC artifact against the current registry** (a separate, larger-scoped WI; out of scope here).
- Action: file no S2 expansion WI. Annotate `MASTER_PLAN.md` decision log: `DEC-BENCH-B8-CURVE-EXECUTE-001` records the flat-zero observation + the upstream root cause (cached truth table corpus-misalignment) + the actual unblock path (re-source B8-SYNTHETIC). Update the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative row to show WI-193 terminal-deferred. Recommend (in the MASTER_PLAN annotation) that a future B8-SYNTHETIC re-run WI re-validates the truth table; once that lands, this WI can be re-opened to re-run the curve against fresh data. Close #193 with the analysis link.

**Branch D — Other (unexpected shape, e.g. non-monotone violation, or asymptote at very high savings but artifact still warrants follow-up):**
- The implementer SHOULD pause and surface the unexpected shape to the orchestrator/operator before committing a decision. This is a real user-decision boundary if the data invalidates either the apparatus correctness OR the WI-193 framing.

### 6.3 Planner expectation (not a constraint on implementer)

Given the planner-verified source artifact state, **Branch C is the planner's expected outcome**. The implementer is NOT bound by this expectation — if the actual data warrants Branch A or B, that is the correct call. Honesty-clause is universal (#167 Principle 4).

## 7. Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Apparatus throws on invocation (path resolution, fs error) | Low | Medium | Apparatus is the same code that passed PR #730 review; planner verified files present and source artifact valid. If failure, implementer re-reads `run-curve.mjs` and `bench/B8-curve/README.md` to debug before considering apparatus modification (which is scope-forbidden — would require re-planning). |
| Lex-max source resolution picks an unexpected file | Low | Low | Planner verified only two `results-*.json` exist in `bench/B8-synthetic/`; lex-max is `results-linux-2026-05-17-revalidation-slice1.json`. If `bench/B8-synthetic/` contents change between planner and implementer, implementer pins `--source` explicitly. |
| Three seeds happen to agree at flat 0%; operator reads as "apparatus is broken" | Medium (almost certain given source state) | Medium | Branch C analysis is explicit: the apparatus is correct, the upstream source is stale. The README's `_meta.source_artifact` block makes provenance auditable. The MASTER_PLAN decision annotation must explicitly state this in plain language to avoid future-implementer confusion. |
| `MASTER_PLAN.md` edit conflicts with another concurrent planner | Low | Low | Worktree is feature-WI-193-b8-curve-execute; checkout off main `aa1a48e`. Implementer runs `git fetch origin && git pull --ff-only origin main` immediately before opening the PR (per memory `feedback_fetch_before_pr.md`). If conflict on MASTER_PLAN.md, implementer rebases and re-runs the analysis section append. |
| Workspace lint/typecheck regression unrelated to this WI | Low | Low | Run full-workspace `pnpm -w lint` and `pnpm -w typecheck` (per memory `feedback_eval_contract_match_ci_checks.md`); if a pre-existing failure surfaces, escalate to operator as a finding, do NOT mask it. |
| Implementer modifies apparatus to "make the curve interesting" | Low | High | Scope manifest explicitly forbids `bench/B8-curve/*.mjs` and `bench/B8-curve/README.md` + `package.json`. Hooks enforce. Forbidden-shortcuts list in §10 is explicit. |

## 8. Evaluation Contract (verbatim — gates Guardian readiness)

The reviewer MUST verify all 10 items before issuing `REVIEW_VERDICT=ready_for_guardian`.

1. **Curve artifact committed.** `bench/B8-curve/results/curve-N10-2026-05-18.json` exists, is valid JSON, parses with `_meta.benchmark === "B8-CURVE"`, `_meta.slice === 1`, and contains `_meta.source_artifact.{path, sha256, corpus_n, corpus_sha256}` block.
2. **Multi-seed variance run.** At least two additional seed artifacts exist under `bench/B8-curve/results/` (suggested: `curve-N10-2026-05-18-seed123.json` and `curve-N10-2026-05-18-seed999.json`). Each parses with the same schema as item 1.
3. **All seed artifacts agree on schema and source provenance.** Each artifact's `_meta.source_artifact.sha256` matches across all three (same source file). Each `_meta.fractions` array is identical.
4. **Apparatus unchanged.** `git diff --stat HEAD~..HEAD -- bench/B8-curve/` shows NO modifications to `sampler.mjs`, `per-f-loop.mjs`, `run-curve.mjs`, `README.md`, or `package.json` between the planner-base commit and the final implementer head. Only files under `bench/B8-curve/results/` are added.
5. **Analysis section appended to MASTER_PLAN.md.** The `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative section contains a new sub-section or row referencing WI-193 terminal state + linked to the curve artifact + linked to the decision branch (A/B/C/D) chosen.
6. **Decision Log entry appended.** `MASTER_PLAN.md` Decision Log table contains a new row for `DEC-BENCH-B8-CURVE-EXECUTE-001` with verbatim rationale matching the chosen branch from §6.2. The row cites the curve artifact path(s), the source artifact SHA-256, and the registry-state context.
7. **Decision branch is explicit and evidence-backed.** The analysis text states which branch (A/B/C/D) was chosen and quotes ≥1 specific numeric value from the curve artifact(s) (e.g. f=1.0 mean_hit_rate, f=0.6→1.0 slope, cross-seed spread). No vague language like "looks good" or "seems sufficient" — every claim is backed by a number from the JSON.
8. **Honesty clause respected.** If the curve is flat at 0% (Branch C), the analysis says so verbatim and does NOT manufacture interpretation. The apparatus-OK / source-stale framing must appear if Branch C is chosen.
9. **Full-workspace lint and typecheck green.** `pnpm -w lint` exits 0. `pnpm -w typecheck` exits 0. Implementer pastes the relevant tail of each command's output into the PR body. (No `--filter` scoping — per memory `feedback_eval_contract_match_ci_checks.md`.)
10. **No source code touched.** `git diff --stat HEAD~..HEAD` shows changes ONLY under `bench/B8-curve/results/`, `plans/wi-193-b8-curve-execute.md`, `tmp/scope-wi-193-b8-curve-execute.json`, and `MASTER_PLAN.md`. No `packages/`, no `examples/`, no `scripts/`, no `.github/`, no `bench/B8-synthetic/` modifications, no `bench/B8-curve/*.mjs` modifications.

### 8.1 Ready-for-guardian definition

Reviewer declares `REVIEW_VERDICT=ready_for_guardian` when AND ONLY when:
- All 10 Evaluation Contract items are verified true on the current HEAD.
- The decision branch chosen in items 5–8 is internally consistent (e.g. Branch B implies a follow-up WI being filed; Branch C implies a source-re-validation recommendation).
- No silent apparatus modifications appear in the diff.

### 8.2 Forbidden shortcuts

- Do NOT modify `bench/B8-curve/sampler.mjs`, `per-f-loop.mjs`, `run-curve.mjs`, `README.md`, or `package.json` for any reason. If you believe the apparatus has a bug, STOP and escalate to the orchestrator — that is a different WI.
- Do NOT modify `bench/B8-synthetic/results-linux-2026-05-17-revalidation-slice1.json` or any other file under `bench/B8-synthetic/`. The source artifact is immutable provenance.
- Do NOT skip the variance runs (seeds 123, 999). They are zero-cost and are the evidence base for the "high seed variance" branch evaluation.
- Do NOT pre-commit to filing an S2 WI as a token gesture if Branch C is chosen. Branch C is "S2 expansion would not fix this; re-source upstream first." Branch C must NOT be silently translated into Branch B.
- Do NOT skip the full-workspace `lint`/`typecheck`. Package-scoped (`--filter`) passing is necessary but not sufficient per project memory.
- Do NOT mask a pre-existing lint/typecheck failure by claiming it is "out of scope." Surface it explicitly in the PR body as a finding for operator triage.

## 9. Scope Manifest (verbatim — matches `tmp/scope-wi-193-b8-curve-execute.json`)

**Allowed paths:**
- `plans/wi-193-b8-curve-execute.md`
- `tmp/scope-wi-193-b8-curve-execute.json`
- `MASTER_PLAN.md`
- `bench/B8-curve/results/**`

**Required paths (must be created/modified):**
- `plans/wi-193-b8-curve-execute.md` (this file — planner-written)
- `tmp/scope-wi-193-b8-curve-execute.json` (planner-written)
- `MASTER_PLAN.md` (planner appends initiative row reservation; implementer appends Decision Log entry + analysis sub-section)
- `bench/B8-curve/results/curve-N10-2026-05-18.json` (implementer; primary seed=42 artifact)

**Forbidden paths (must NOT be modified):**
- `bench/B8-curve/sampler.mjs`, `per-f-loop.mjs`, `run-curve.mjs`, `README.md`, `package.json` (apparatus — immutable in this WI)
- `bench/B8-synthetic/**` (read-only source-of-truth)
- All other bench dirs: `bench/B1-latency/**`, `bench/B2-bloat/**`, `bench/B4-tokens/**`, `bench/B4-tokens-v3/**`, `bench/B4-tokens-v4/**`, `bench/B5-coherence/**`, `bench/B6-airgap/**`, `bench/B7-commit/**`, `bench/B9-min-surface/**`, `bench/B10-import-replacement/**`, `bench/v0-release-smoke/**`
- `packages/**`, `examples/**`, `docs/**`, `.github/**`, `.claude/**`, `scripts/**`, `bootstrap/**`

**State authorities touched:**
- `b8-curve-results` (write — new authority instance)
- `bench-b8-curve-decision` (write — terminal verdict via MASTER_PLAN.md)

(JSON keys for runtime scope-sync: `allowed_paths`, `required_paths`, `forbidden_paths`, `state_domains`, `authority_domains` — five canonical keys, verified.)

## 10. Decision Log entry (proposed; implementer commits during analysis pass)

```
DEC-BENCH-B8-CURVE-EXECUTE-001 — WI-193 B8-CURVE S1 first-data run

Title: B8-CURVE Slice 1 executed against the lex-max committed source artifact
       (results-linux-2026-05-17-revalidation-slice1.json), seeds {42, 123, 999};
       chose Branch {A|B|C|D} per the apparatus's decision-rubric and the
       observed curve shape.

Status: accepted (S1 execution complete; S2 disposition recorded per branch).

Rationale:
  [Implementer fills with: curve shape summary (1-2 sentences citing numeric
   values from the artifact), branch choice, and either (a) reason no S2 is
   warranted, (b) the S2 follow-up WI filed (with link), or (c) the upstream
   root-cause and the recommended re-source path.]

Cross-reference: #193, #167, #192, DEC-BENCH-SUITE-CHARACTERISATION-001,
  DEC-BENCH-B8-CURVE-SLICE1-001, DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001,
  PR #730 (apparatus), bench/B8-curve/results/curve-N10-2026-05-18*.json.
```

## 11. Hand-off and merge plan

Per project memory:
- Land via PR (not Guardian-merge). After implementer + reviewer cycle green, push branch and `gh pr create` against main.
- Run `git fetch origin && git pull --ff-only origin main` immediately before opening the PR.
- PR title: `feat(bench/B8-curve): WI-193 — execute S1 + record S2 disposition (refs #193)`
- PR body must include:
  - Brief summary of branch chosen + decision evidence (paste 5-10 lines from MASTER_PLAN analysis section).
  - Output of `pnpm -w lint` (tail).
  - Output of `pnpm -w typecheck` (tail).
  - Link to all committed curve artifacts.
- Post a verbatim copy of the analysis section as a comment on issue #193 (per project rule: questions/decisions on issues, not in chat).
- If Branch B was chosen, the implementer SHOULD file the S2 follow-up issue in the same PR session (`gh issue create ... --title "WI-193 S2 — Corpus expansion to N=…"`) and link both directions.

## 12. Next planner work-item after this PR lands

If Branch B (S2 corpus expansion warranted): next planner dispatch is `wi-193-s2-corpus-expansion`.

If Branch A or C (no S2): #193 closes; next planner dispatch returns to the FuckGoblin queue (any of the other open `fuckgoblin`-labeled issues).

If Branch D (unexpected): planner re-dispatch required; operator-decision boundary may activate.

---

## 13. Quality Gate (planner self-audit before emitting trailer)

- [x] All dependencies and states mapped (§4)
- [x] Evaluation Contract has 10 executable acceptance criteria + ready-for-guardian definition (§8)
- [x] Scope Manifest has 5 canonical JSON keys + matches `tmp/scope-wi-193-b8-curve-execute.json` (§9)
- [x] Forbidden-shortcuts list is explicit (§8.2)
- [x] Decision branches enumerated with measurable triggers and concrete actions (§6.2)
- [x] No vague completion language; every gate references a numeric or grep-able fact
- [x] Honesty clause for the planner-expected Branch-C outcome is explicit (§6.3)
- [x] Apparatus immutability appears in BOTH Evaluation Contract (item 4, 10) AND Scope Manifest (forbidden_paths) AND forbidden-shortcuts (§8.2) — three independent guards

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-193 B8-CURVE execute plan written; next work item is wi-193-b8-curve-execute-impl-1 (single-slice: 3 seed runs + analysis + decision branch + MASTER_PLAN annotation; planner-expected Branch C — flat-zero from corpus-misaligned cached truth table).
