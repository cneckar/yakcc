# Plan: WI-731 — Execute B4-v4 matrix + publish DEC-BENCH-B4-V4-001

**Workflow:** `wi-731-b4-v4-execute`
**Goal:** `g-wi-731-b4-v4-execute`
**Work item:** `wi-731-b4-v4-execute-planner`
**Branch:** `feature/wi-731-b4-v4-execute`
**Worktree:** `C:/src/yakcc/.worktrees/feature-wi-731-b4-v4-execute`
**Ticket:** [#731](https://github.com/cneckar/yakcc/issues/731) (`fuckgoblin`, `benchmarks`, `ready`, `load-bearing`)
**Predecessor (apparatus):** PR [#728](https://github.com/cneckar/yakcc/pull/728) (WI-722 B4-v4 corpus redesign, merged 2026-05-18 16:26Z, commit `8e6ed5a`)
**Predecessor (dossier model):** `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` (issue #653)
**Operator authorization:** `cdn@yakcc.com`, 2026-05-18 ~16:40Z ("we can run some benchmarks that were blocked now")
**Budget cap:** $75 total (DEC-V0-B4-SLICE2-COST-CEILING-004), Phase 1 sub-cap $25.

---

## 0. Tier and dispatch summary

- **Complexity tier:** Tier 2 (Standard). Single implementer slice, multi-phase apparatus execution + dossier authoring, well-bounded scope. No architecture decisions required (all corpus / task-set / rep / driver / budget DECs are pre-locked by PR #728's design phase).
- **Implementer dispatch:** one implementer slice runs Phase 1 → registry verification → Phase 2 → (conditional) N=10 rescue re-runs → dossier author. No additional planner re-engagement required unless a phase emits an `ERROR` or a budget overrun.
- **Reviewer:** read-only outer-loop check of dossier honesty + cost discipline + Evaluation Contract gates.
- **Land:** PR (NEVER Guardian-merge — per memory `feedback_pr_not_guardian_merge.md`).

---

## 1. Problem statement and scope

`#728` landed the B4-v4 apparatus (dual-shave persistence, 6-task harder suite, 6-cell matrix). The apparatus has never been exercised against the Anthropic API. This work item runs the apparatus end-to-end and publishes the dossier — characterisation-pass framing per `DEC-BENCH-SUITE-CHARACTERISATION-001`: the verdict can be "rescue confirmed", "rescue refuted", or "rescue ambiguous". All three are valid landings; the honesty clause is what gets tested, not the empirical outcome.

### Goals

1. Execute Phase 1 (Opus × 6 tasks × N=3 reps with dual-shave persistence) under the $25 sub-cap.
2. Verify the registry produced by Phase 1 contains task-scale composite atoms (DEC-B4-V4-CORPUS-COMPOSITE-001 §1 — this is the apparatus correctness check that distinguishes v4 from v3).
3. Execute Phase 2 (6 cells A–F × 6 tasks × N=3 reps = 108 calls) under the $50 sub-cap.
4. Identify rescue-eligible tasks (where E unhooked fails AND F hooked passes ≥1 rep at N=3) and re-run those specific tasks at N=10 for statistical power per DEC-B4-V4-REPS-001.
5. Author `DEC-BENCH-B4-V4-001.md` dossier following the v3 dossier template (`bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`), recording observed values verbatim — including null / negative findings.
6. Land via PR with `closes #731`.

### Non-goals

- **No apparatus modifications.** Phases 1 + 2 scripts, tasks, oracles, MCP server, decomposer, and shave pipeline are all read-only inputs. If the apparatus surfaces a defect that blocks execution, halt, file a follow-up ticket, and re-plan — do not patch the apparatus inside this WI's scope.
- **No D4 follow-up (Haiku 3.0 cells G/H).** Operator DEC D4 on #722 explicitly defers Haiku-3.0 cells until after the first B4-v4 verdict is in. Out of scope here.
- **No source changes** in `packages/shave/`, `packages/registry/`, `packages/contracts/`, or `packages/hooks-base/`. The apparatus consumes these read-only; mutations here would compromise the never-synthetic invariant.
- **No B4-v3 apparatus changes.** v3 is closed; do not edit its results or harness.

### Dominant constraints

1. **Cost ceiling.** $75 total cap (DEC-V0-B4-SLICE2-COST-CEILING-004). Phase 1 sub-cap $25 (DEC-BENCH-B4-V4-PHASE1-001). Any spend > $25 in Phase 2 toward N=10 rescue re-runs is permitted only if Phase 1 + Phase 2 baseline stayed under $50 combined; otherwise stop and report.
2. **Never-synthetic invariant.** Registry must be built solely from real Opus emissions through the real shave pipeline. The dual-shave in `atom-sync-v4.mjs` is the canonical pathway; do not hand-craft or LLM-fabricate any atom content.
3. **Honesty clause.** If results don't show rescue, the dossier records that verbatim — same shape as `DEC-BENCH-B4-V3-001.md` §4 "Verdict on the hypothesis: not supported at this corpus shape." A null verdict at v4 is a legitimate landing.
4. **Run isolation.** Each Phase 1 run creates a fresh per-run SQLite registry under `tmp/B4-tokens-v4/<run-id>/registry.sqlite`. Phase 2 consumes it via `YAKCC_REGISTRY_PATH`. Do not point Phase 2 at any other registry path (especially not the workspace `.yakcc/registry.sqlite`).
5. **Env wiring.** All Anthropic API calls must use `node --env-file=.env bench/B4-tokens-v4/harness/<script>` invoked from repo root, per memory `project_b4_v3_harness_env_wiring.md`. `.env` is at `C:/src/yakcc/.env` (gitignored). Verified present at planner time.

---

## 2. Apparatus audit (verified at planner time, 2026-05-18)

Inspected the just-landed `bench/B4-tokens-v4/` tree at worktree HEAD (`9735b7b`).

### 2.1 Phase scripts present

- `bench/B4-tokens-v4/harness/phase1-v4.mjs` ✓ — Opus unhooked, calls `syncAtoms` (fine, maxCF=1) AND `syncWholeImpl` (coarse, maxCF=999) per rep. Writes `phase1-<iso>.json` (summary) + `phase1-<iso>.jsonl` (per-rep billing). Hard budget guard at $25 with early-exit + writeResults().
- `bench/B4-tokens-v4/harness/phase2-v4.mjs` ✓ — 6-cell matrix loop with MCP-spawn for hooked arms; per-rep oracle pass-rate; BudgetTracker pre-call check at $50. Demands `YAKCC_REGISTRY_PATH` env var (fails fast if absent or file missing). Writes `phase2-<iso>.json` + `billing-phase2-<iso>.jsonl`.
- `bench/B4-tokens-v4/harness/atom-sync-v4.mjs` ✓ — dual-shave wrapper around `@yakcc/shave`. `syncAtoms` = default fine; `syncWholeImpl` overrides `recursionOptions.maxControlFlowBoundaries=999`. Header carries DEC-B4-V4-CORPUS-COMPOSITE-001 rationale verbatim.
- `bench/B4-tokens-v4/harness/matrix-v4.mjs` ✓ — defines `PHASE2_CELLS` (A=opus·unhooked, B=opus·hooked, C=sonnet·unhooked, D=sonnet·hooked, E=haiku·unhooked, F=haiku·hooked) with model_ids locked.
- `bench/B4-tokens-v4/harness/verify-v4.mjs` ✓ — verifies all 6 task prompt SHA-256 hashes against `tasks.json` at suite-load time; aborts on drift.
- `bench/B4-tokens-v4/harness/oracle-runner.mjs` ✓ — extracts ```typescript fenced code, writes to scratch, runs the task's vitest oracle, returns `{ oracle_passed, oracle_pass_count, oracle_total, oracle_failures }`.
- `bench/B4-tokens-v4/harness/mcp-server.mjs` ✓ — path-agnostic atom-lookup MCP server (verbatim of B4-v3, locked by DEC-V0-B4-V3-MCP-NAMING-001).
- `bench/B4-tokens-v4/harness/billing.mjs` + `budget.mjs` ✓ — reused from B4-v3 verbatim; pricing table includes `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`.

### 2.2 Six tasks present

| ID | prompt.md | oracle.test.ts | reference-impl.ts | sha256 (per tasks.json) |
|---|---|---|---|---|
| `crc32c` | ✓ | ✓ | ✓ | `2bde57dc9517f23b...` |
| `utf8-codec` | ✓ | ✓ | ✓ | `527fcc77ee84db61...` |
| `base32-rfc4648` | ✓ | ✓ | ✓ | `64fc0edd5efb9039...` |
| `lru-ttl-cache` | ✓ | ✓ | ✓ | `944263147ec864a9...` |
| `semver-range` | ✓ | ✓ | ✓ | `b650cfe9d31cf01a...` |
| `ring-buffer` | ✓ | ✓ | ✓ | `25a2cf1d7fcbe99f...` |

DEC-BENCH-B4-V4-TASKS-001 documents the per-task Haiku trap. Each task is a single named-export class, matching the composite-atom design (one class = one whole-impl atom).

### 2.3 Apparatus exit criteria for execution

Before launching real Phase 1, the implementer must:
1. Run `node bench/B4-tokens-v4/harness/phase1-v4.mjs --dry-run` from repo root. Expect: zero API calls, prints task count + dual-shave note, exits 0.
2. Run `node --env-file=.env bench/B4-tokens-v4/harness/phase1-v4.mjs --task=crc32c --n-reps=1` (smoke real-API). Expect: 1 Opus call (~$0.05), 1 fine + 1 coarse shave pass, summary JSON + JSONL written, registry file emitted, prints `export YAKCC_REGISTRY_PATH=...` next-step.
3. Stop. Verify the smoke registry has both fine and coarse atoms (see §4.2 — query commands). If verified, proceed to the full Phase 1 run.

If any step fails or the smoke registry is missing coarse atoms, **halt and re-plan**. Do not patch the apparatus in this WI.

---

## 3. Execution plan (exact invocations)

All commands run from repo root (`C:/src/yakcc/`), not from the worktree subdirectory — `.env` lives at repo root.

### 3.1 Wave 1 — Phase 1 smoke (cost ≤ $0.10)

```bash
# From C:/src/yakcc/
node bench/B4-tokens-v4/harness/phase1-v4.mjs --dry-run
node --env-file=.env bench/B4-tokens-v4/harness/phase1-v4.mjs --task=crc32c --n-reps=1
```

**Acceptance:** dry-run exits 0; smoke run writes `bench/B4-tokens-v4/results/phase1-<iso>.json` with `atoms_fine >= 1` AND `atoms_coarse >= 1` for the crc32c rep. If `atoms_coarse == 0`, halt — that signals the dual-shave wiring is broken at runtime.

### 3.2 Wave 2 — Phase 1 full (cost ≤ $25)

```bash
node --env-file=.env bench/B4-tokens-v4/harness/phase1-v4.mjs
```

Runs 6 tasks × N=3 reps = 18 Opus calls. Expected spend ~$1–3 based on v3 Phase 1 ($1.75 for 5 tasks × 3 reps). The $25 cap is generous headroom for any prompt-size differences. The script writes:

- `bench/B4-tokens-v4/results/phase1-<iso>.json` (summary with per-task per-rep merkle roots)
- `bench/B4-tokens-v4/results/phase1-<iso>.jsonl` (per-rep billing rows)
- `tmp/B4-tokens-v4/phase1-<iso>/registry.sqlite` (per-run SQLite, NOT committed)
- `tmp/B4-tokens-v4/phase1-<iso>/impl-scratch/` (scratch impls, deleted per-rep)

**Acceptance gates:**
- Total cost printed at end ≤ $25.
- Summary JSON exists, has `n_tasks=6`, `n_reps=3`, all 18 reps have `atom_merkle_roots_fine` AND `atom_merkle_roots_coarse` populated.
- Per-task per-rep: `atom_merkle_roots_coarse.length >= 1` (composite atom persisted from this rep).
- Registry sqlite file exists at the printed path.

Capture the `YAKCC_REGISTRY_PATH` export line from stdout — Wave 3 needs it.

### 3.3 Wave 3 — Registry verification (zero cost)

DEC-B4-V4-CORPUS-COMPOSITE-001 §1 requires a post-Phase-1 check that the registry actually contains task-scale composite atoms (this is what was missing in v3). Two complementary queries:

```bash
# From C:/src/yakcc/, with YAKCC_REGISTRY_PATH set from Wave 2 output
export YAKCC_REGISTRY_PATH=tmp/B4-tokens-v4/phase1-<iso>/registry.sqlite

# 3.3.a — coarse-atom count + size distribution. Composite atoms should be hundreds
# to thousands of chars (whole-impl-shaped), not single statements (88-char v3 leaves).
node --eval '
  const { openRegistry } = await import("./packages/registry/dist/index.js");
  const { createLocalEmbeddingProvider } = await import("./packages/contracts/dist/index.js");
  const reg = await openRegistry(process.env.YAKCC_REGISTRY_PATH, { embeddings: createLocalEmbeddingProvider() });
  const all = await reg.listBlocks();
  const sizes = all.map(b => (b.impl_source ?? "").length).sort((a,b) => b-a);
  console.log("total_atoms", all.length);
  console.log("size_p100", sizes[0] ?? 0);
  console.log("size_p50",  sizes[Math.floor(sizes.length/2)] ?? 0);
  console.log("size_p10",  sizes[Math.floor(sizes.length*0.9)] ?? 0);
  console.log("over_300_chars", sizes.filter(s => s >= 300).length);
  console.log("over_1500_chars", sizes.filter(s => s >= 1500).length);
  await reg.close();
' --input-type=module
```

**Acceptance:** `over_1500_chars >= 6` (at least one composite atom per task; in practice expect 6–18+ from N=3 reps).

```bash
# 3.3.b — MCP atom-lookup query simulation per task intent.
# For each of the 6 tasks, run a task-intent query through the same selector the hook
# uses. Expect at least one composite-atom candidate at combinedScore >= 0.70 per task.
node --eval '
  const tasks = [
    { id: "crc32c", intent: "CRC-32C Castagnoli checksum class with update digest reset clone methods" },
    { id: "utf8-codec", intent: "UTF-8 encoder and decoder without TextEncoder TextDecoder handling 1-4 byte sequences and surrogate pairs" },
    { id: "base32-rfc4648", intent: "RFC 4648 Base32 encode and decode with A-Z2-7 alphabet, padding, case-insensitive decode" },
    { id: "lru-ttl-cache", intent: "LRU cache with per-entry TTL, lazy expiry on get, capacity counts only live entries" },
    { id: "semver-range", intent: "SemVer range satisfaction with caret tilde comparators handling ^0.x.y semantics" },
    { id: "ring-buffer", intent: "fixed-capacity ring buffer with push shift peek get iterator size capacity clear" },
  ];
  const { openRegistry } = await import("./packages/registry/dist/index.js");
  const { createLocalEmbeddingProvider } = await import("./packages/contracts/dist/index.js");
  const reg = await openRegistry(process.env.YAKCC_REGISTRY_PATH, { embeddings: createLocalEmbeddingProvider() });
  for (const t of tasks) {
    const candidates = await reg.findCandidatesByQuery(t.intent, { limit: 5 });
    const top = candidates[0];
    console.log(t.id, "top1_score=" + (top?.combinedScore?.toFixed(3) ?? "none"), "top1_size=" + (top?.block?.impl_source?.length ?? 0));
  }
  await reg.close();
' --input-type=module
```

**Acceptance (informational, not blocking):** record per-task top-1 combinedScore + size in dossier. A score < 0.70 or a size < 300 chars on any task is a signal worth noting in the dossier §5 (apparatus observations) but does NOT block proceeding to Phase 2 — Phase 2 measures the empirical rescue regardless.

Record the verification output verbatim into `bench/B4-tokens-v4/results/phase1-<iso>-registry-verify.txt` (committed alongside the results JSON). This is the v4-distinguishing artifact: it documents that the corpus shape actually changed.

### 3.4 Wave 4 — Phase 2 smoke (cost ≤ $0.01)

```bash
node bench/B4-tokens-v4/harness/phase2-v4.mjs --dry-run
node --env-file=.env bench/B4-tokens-v4/harness/phase2-v4.mjs --smoke
```

`--smoke` runs cell E × crc32c × N=1 (haiku unhooked, expected to fail). Verifies MCP server can spawn / classify code / run oracle / write billing without budget complaints.

**Acceptance:** smoke completes; one oracle result printed; `bench/B4-tokens-v4/results/phase2-smoke-<iso>.json` written.

### 3.5 Wave 5 — Phase 2 full baseline (cost ≤ $50)

```bash
node --env-file=.env bench/B4-tokens-v4/harness/phase2-v4.mjs
```

Runs 6 cells × 6 tasks × N=3 reps = 108 calls. Expected spend ~$8–15 based on v3 ($5.33 for 90 calls with similar mix; v4 adds 18 calls + slightly larger prompts on the harder tasks but maintains same MCP overhead pattern).

**Acceptance gates:**
- BudgetTracker did not throw `BudgetExceededError` mid-run.
- Final summary JSON written: `bench/B4-tokens-v4/results/phase2-<iso>.json`.
- Per-rep billing JSONL written: `bench/B4-tokens-v4/results/billing-phase2-<iso>.jsonl`.
- 108 rows in the JSONL (no missing reps).
- Phase 2 cumulative spend printed at end.

### 3.6 Wave 6 — Rescue-eligible re-runs at N=10 (conditional, cost ≤ $5 typical)

DEC-B4-V4-REPS-001: N=3 baseline; bump to N=10 only on rescue-eligible tasks at execution. A task is **rescue-eligible** if and only if BOTH:
- Cell E (haiku·unhooked) `oracle_pass_count == 0` on all 3 reps for that task.
- Cell F (haiku·hooked) `oracle_pass_count >= 1` on at least 1 rep for that task.

For each rescue-eligible task, re-run cells E and F at N=10:

```bash
# For each rescue-eligible <TASK_ID>:
node --env-file=.env bench/B4-tokens-v4/harness/phase2-v4.mjs --task=<TASK_ID> --cell=E --n-reps=10
node --env-file=.env bench/B4-tokens-v4/harness/phase2-v4.mjs --task=<TASK_ID> --cell=F --n-reps=10
```

These re-runs append to the same `bench/B4-tokens-v4/results/` directory with distinct `phase2-<iso>` run ids; the dossier presents the N=3 baseline matrix AND the N=10 rescue cohort separately.

**Cost guard:** total Phase 1 + Phase 2 (baseline + rescue) must not exceed $50. The implementer logs cumulative spend before each rescue re-run and stops if a re-run would push past $50. Crossing $50 without explicit operator OK is a `BLOCKED` condition — report and stop, do not re-run more.

**Acceptance:** for every rescue-eligible task, both E×N=10 and F×N=10 result files exist; dossier records both pass-rate columns.

**No rescue-eligible tasks?** That itself is a v4 finding (the v3 null finding repeats at v4) — document verbatim in dossier §4 and skip Wave 6 entirely. This is the honesty clause in action.

### 3.7 Wave 7 — Dossier authorship + landing

Author `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md` following the v3 dossier shape (`bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`). Mandatory sections:

1. **Header** — DEC id, status, decision summary, closes #731, canonical run identifiers, total spend vs cap, operator auth quote.
2. **§1 Objective** — quote DEC-BENCH-B4-V4-TASKS-001 and DEC-B4-V4-CORPUS-COMPOSITE-001 rationale verbatim; restate the v4-vs-v3 hypothesis fix.
3. **§2 Execution mechanics** — phase 1 + phase 2 + (conditional) rescue cohort tables, per-run cost.
4. **§3 Headline empirical findings** —
   - Oracle pass-rate matrix: 6 tasks × 6 cells × N (X/N format).
   - Per-cell token + cost averages on a fully-passing comparison task (cleanest apples-to-apples).
   - Hooked-vs-unhooked deltas summary.
   - Rescue cohort table (if Wave 6 fired): E×N=10 vs F×N=10 per rescue-eligible task.
5. **§4 Verdict on the hypothesis** — verbatim record of the empirical result. One of:
   - "Rescue confirmed at composite-atom corpus shape" (criteria: ≥1 task with E×N=10 pass-rate ≤10% AND F×N=10 pass-rate ≥70%, with cost ratio F/A ≤ 0.2).
   - "Rescue not supported at this corpus shape" (mirror v3 §4 framing — explain which tasks tested the rescue scenario and which didn't).
   - "Rescue ambiguous: directional signal at sub-statistical power" (E and F differ but N too thin to call).
6. **§5 Apparatus observations** — registry-verify output verbatim from Wave 3, composite-atom size distribution, any per-task top-1 score notes.
7. **§6 Cross-references** — #731, predecessor #722 / PR #728, v3 dossier `DEC-BENCH-B4-V3-001`, DEC-V0-B4-SLICE2-COST-CEILING-004, DEC-B4-V4-CORPUS-COMPOSITE-001, DEC-BENCH-B4-V4-TASKS-001, DEC-B4-V4-REPS-001.

After dossier author:
- Annotate `MASTER_PLAN.md` with `DEC-BENCH-B4-V4-001` row in Decision Log (verdict text mirrors §4 exactly).
- Mark `wi-731-b4-v4-execute` row in Active Initiatives as closed with dossier link.
- Run full-workspace gates: `pnpm -w lint` then `pnpm -w typecheck` (NEVER `--filter` — per memory `feedback_eval_contract_match_ci_checks.md`).
- Commit, push branch, open PR with `closes #731`. PR body links the dossier, summarises spend vs cap, names the verdict.
- After PR opens, the orchestrator's standing loop handles CI / merge / cleanup per memory `feedback_pr_not_guardian_merge.md` and `workflow_fuckgoblin_orchestrator_loop.md`.

---

## 4. Files produced (commit ledger)

All committed under the worktree branch `feature/wi-731-b4-v4-execute`:

| Path | Source | Notes |
|---|---|---|
| `bench/B4-tokens-v4/results/phase1-<iso>.json` | Wave 2 stdout-driven | Summary; per-rep merkle roots fine+coarse |
| `bench/B4-tokens-v4/results/phase1-<iso>.jsonl` | Wave 2 | Per-rep billing rows |
| `bench/B4-tokens-v4/results/phase1-<iso>-registry-verify.txt` | Wave 3 | Composite-atom verification artifact |
| `bench/B4-tokens-v4/results/phase2-<iso>.json` | Wave 5 | 6×6×N=3 baseline summary |
| `bench/B4-tokens-v4/results/billing-phase2-<iso>.jsonl` | Wave 5 | 108 baseline billing rows |
| `bench/B4-tokens-v4/results/phase2-<iso>.json` (×R) | Wave 6 (per rescue-eligible task, conditional) | N=10 rescue cohort summaries |
| `bench/B4-tokens-v4/results/billing-phase2-<iso>.jsonl` (×R) | Wave 6 (conditional) | N=10 rescue cohort billing |
| `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md` | Wave 7 | The dossier |
| `MASTER_PLAN.md` | Wave 7 | Append `DEC-BENCH-B4-V4-001` to Decision Log + close initiative row |
| `plans/wi-731-b4-v4-execute.md` | this plan | Planner artifact (one commit, with scope JSON) |
| `tmp/scope-wi-731-b4-v4-execute.json` | planner | Scope authority (committed for audit) |

NOT committed (gitignored by `tmp/`):
- `tmp/B4-tokens-v4/phase1-<iso>/registry.sqlite` — per-run SQLite (large, regenerable).
- `tmp/B4-tokens-v4/phase1-<iso>/impl-scratch/*` — scratch impls (already auto-cleaned per rep).

---

## 5. Integration surface

- **State domains touched:**
  - `bench-b4-v4-execute-results` — new artifacts in `bench/B4-tokens-v4/results/`. Sole authority for v4 empirical record.
  - `registry-composite-atoms-corpus` — written transiently during Phase 1 to per-run SQLite at `tmp/B4-tokens-v4/<run-id>/registry.sqlite`. NOT touched in the workspace `.yakcc/registry.sqlite`. Disposable.
  - `MASTER_PLAN.md decision-log` — append `DEC-BENCH-B4-V4-001` row.
- **Adjacent components (read-only):**
  - `packages/shave/` (dual-shave pipeline via `atom-sync-v4.mjs`).
  - `packages/registry/` (per-run SQLite storage + findCandidatesByQuery).
  - `packages/contracts/` (embedding providers).
  - `packages/hooks-base/` (not directly invoked; the MCP server consumes the registry directly).
- **Canonical authorities (do not duplicate):**
  - Shave decomposition: `@yakcc/shave` `shave()` (called via `atom-sync-v4.mjs`). NEVER hand-craft atom content.
  - Embedding provider: `createLocalEmbeddingProvider()` from `@yakcc/contracts`. Same model as production.
  - Cost pricing: `bench/B4-tokens-v4/harness/billing.mjs` PRICING table. Single source.
  - Budget cap: `DEC-V0-B4-SLICE2-COST-CEILING-004` ($75 total).
- **Removal targets:** none. v4 is additive; v3 dossier and apparatus remain untouched.

---

## 6. Evaluation Contract (gates Guardian readiness)

This contract is the single source of truth for reviewer + Guardian admission. Every gate must be observably green before reviewer issues `ready_for_guardian`.

### 6.1 Required artifacts present

1. `bench/B4-tokens-v4/results/phase1-<iso>.json` exists; has `n_tasks=6`, `n_reps=3`, `total_cost_usd <= 25`, `cap_usd=25`, `registry_path` populated, 18 rep entries all with non-empty `atom_merkle_roots_fine` AND `atom_merkle_roots_coarse` arrays.
2. `bench/B4-tokens-v4/results/phase1-<iso>.jsonl` exists; line count == 18; every line parses; cumulative `cumulative_cost_usd` monotonically increases and final ≤ 25.
3. `bench/B4-tokens-v4/results/phase1-<iso>-registry-verify.txt` exists; contains `total_atoms`, `size_p100`, `over_1500_chars` keys; `over_1500_chars` value >= 6; contains per-task top-1 line for all 6 task ids.
4. `bench/B4-tokens-v4/results/phase2-<iso>.json` (baseline) exists; per-task per-cell rep count == 3; all 108 (or 36 per task × 6 tasks = 216 rep entries — actually 6 tasks × 6 cells × 3 reps = 108) reps either oracle-passed or oracle-failed (no `error` field on >0 reps without an explanation).
5. `bench/B4-tokens-v4/results/billing-phase2-<iso>.jsonl` (baseline) exists; line count == 108; cumulative cost ≤ $50 at end-of-baseline.
6. For each rescue-eligible task identified, both `cell=E` and `cell=F` N=10 result files exist OR the dossier explicitly documents why Wave 6 was skipped (no rescue-eligible tasks; or operator-OK cost ceiling override; or apparatus failure).
7. `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md` exists with all 6 mandatory sections (§§1–6) populated.
8. `MASTER_PLAN.md` Decision Log contains a `DEC-BENCH-B4-V4-001` row whose verdict text matches dossier §4 verbatim.
9. `MASTER_PLAN.md` Active Initiatives shows `wi-731-b4-v4-execute` as closed with dossier link.

### 6.2 Required real-path checks

1. `node bench/B4-tokens-v4/harness/phase1-v4.mjs --dry-run` exits 0 from repo root.
2. `node bench/B4-tokens-v4/harness/phase2-v4.mjs --dry-run` exits 0 from repo root.
3. Total spend (Phase 1 + Phase 2 baseline + rescue cohort) ≤ $50 OR dossier records an operator-approved overage justification with timestamp.

### 6.3 Required authority invariants

1. **NO writes** to `packages/shave/`, `packages/registry/`, `packages/contracts/`, `packages/hooks-base/`, `packages/hooks-bridge/`, `packages/cli/`, `packages/compile/`, `packages/ir/`, `packages/seeds/`, `packages/federation/`. The apparatus is correct; this WI is execution-only.
2. **NO writes** to `bench/B4-tokens-v4/harness/`, `bench/B4-tokens-v4/tasks/`, `bench/B4-tokens-v4/tasks.json`, `bench/B4-tokens-v4/vitest.config.mjs`, `bench/B4-tokens-v4/package.json`. Apparatus is locked.
3. **NO writes** to `bench/B4-tokens-v3/`, `bench/B4-tokens/`, any other `bench/B*/` directory. v4 is additive.
4. **NO writes** to `.yakcc/registry.sqlite` or any workspace-default registry. All Phase 1 registry writes go to `tmp/B4-tokens-v4/<run-id>/registry.sqlite`.
5. Never-synthetic invariant honored: all registry contents derive from real Opus API emissions through the real shave pipeline. No hand-crafted or LLM-fabricated atom content.

### 6.4 Required CI gates

Per memory `feedback_eval_contract_match_ci_checks.md`:
1. `pnpm -w lint` green (full workspace; NEVER `--filter`).
2. `pnpm -w typecheck` green (full workspace; NEVER `--filter`).

### 6.5 Required integration points

1. Dossier cross-references all binding DECs verbatim (DEC-V0-B4-SLICE2-COST-CEILING-004, DEC-B4-V4-CORPUS-COMPOSITE-001, DEC-BENCH-B4-V4-TASKS-001, DEC-B4-V4-REPS-001, DEC-BENCH-B4-V4-MATRIX-001).
2. PR description includes `closes #731`.
3. PR landed by orchestrator's standing PR-loop pattern (NOT Guardian-merge into main; per memory `feedback_pr_not_guardian_merge.md`).

### 6.6 Forbidden shortcuts

1. Do NOT modify any apparatus file to "make tests pass" — if oracle tests fail because Opus emitted bad code, that IS the data.
2. Do NOT skip Wave 3 (registry verification). It is the v4-distinguishing apparatus check.
3. Do NOT skip Wave 6 except when there are zero rescue-eligible tasks. If skipped, document why verbatim in dossier §3.
4. Do NOT pre-allocate N=10 across all tasks; N=3 default, N=10 only on rescue-eligible per DEC-B4-V4-REPS-001.
5. Do NOT use anything other than `node --env-file=.env` invocation for cost-bearing calls.
6. Do NOT call any model not in `matrix-v4.mjs DRIVERS` (D4 defers Haiku-3.0 explicitly).
7. Do NOT write to the workspace `.yakcc/registry.sqlite`.
8. Do NOT exceed $50 total Phase 1 + Phase 2 spend without explicit operator OK in chat at execution time; document the OK timestamp + quote in dossier §7 if applicable.
9. Do NOT reframe a null finding as a positive result. The honesty clause is binding — v3's `DEC-BENCH-B4-V3-001` is the precedent.

### 6.7 Ready-for-guardian definition

Reviewer may issue `REVIEW_VERDICT: ready_for_guardian` when AND ONLY WHEN:
- All §6.1 artifacts present and parse-clean.
- All §6.2 real-path checks pass.
- All §6.3 authority invariants verified by `git diff main...HEAD` showing zero touches to forbidden paths.
- All §6.4 CI gates green (paste output).
- All §6.5 integration points present.
- Zero §6.6 shortcuts taken (or each taken-shortcut documented as a deviation with operator-OK quote).
- Dossier §4 verdict is internally consistent with the data tables in §3.

---

## 7. Scope Manifest

Authoritative scope; `tmp/scope-wi-731-b4-v4-execute.json` is the runtime-readable canonical form (5-key schema).

### Allowed paths

- `bench/B4-tokens-v4/results/**` (all new artifacts)
- `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md` (dossier)
- `MASTER_PLAN.md` (Decision Log + initiative status row)
- `plans/wi-731-b4-v4-execute.md` (this plan)
- `tmp/scope-wi-731-b4-v4-execute.json` (this scope JSON)
- `tmp/B4-tokens-v4/**` (gitignored runtime artifacts — registry sqlite, impl scratch)

### Required paths (must be created)

- `bench/B4-tokens-v4/results/phase1-<iso>.json`
- `bench/B4-tokens-v4/results/phase1-<iso>.jsonl`
- `bench/B4-tokens-v4/results/phase1-<iso>-registry-verify.txt`
- `bench/B4-tokens-v4/results/phase2-<iso>.json`
- `bench/B4-tokens-v4/results/billing-phase2-<iso>.jsonl`
- `bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md`

### Forbidden paths

- `bench/B4-tokens-v4/harness/**` (apparatus locked)
- `bench/B4-tokens-v4/tasks/**` (corpus + oracles locked)
- `bench/B4-tokens-v4/tasks.json` (locked)
- `bench/B4-tokens-v4/vitest.config.mjs` (locked)
- `bench/B4-tokens-v4/package.json` (locked)
- `bench/B4-tokens-v3/**` (v3 closed)
- `bench/B4-tokens/**` (v2 closed)
- All other `bench/B*/` directories.
- `packages/**` (apparatus consumer, must not change)
- `.yakcc/**` (workspace registry untouched)
- `.env` (secret, never persisted to repo)

### State domains touched

- `bench-b4-v4-execute-results` (sole authority for v4 results)
- `bench-b4-v4-dossier` (sole authority for v4 verdict)
- `MASTER_PLAN.md decision-log` (append-only)

### Authority domains

- `bench-b4-v4-execute` (this WI is the sole authority)
- `dossier-b4-v4` (this WI is the sole authority)

---

## 8. Decision log entry (drafted; finalized in dossier authoring)

```
DEC-BENCH-B4-V4-001 | accepted | <date> | First B4-v4 matrix run is preserved as
the execution of record for the corpus-redesign hypothesis (composite-atom
persistence per DEC-B4-V4-CORPUS-COMPOSITE-001 + 6-task harder suite per
DEC-BENCH-B4-V4-TASKS-001). Verdict: <one of: rescue confirmed | rescue not
supported at this corpus shape | rescue ambiguous at N=3, follow-up at N=10
documented>. Closes #731. Dossier:
bench/B4-tokens-v4/results/DEC-BENCH-B4-V4-001.md.
```

The verdict line is filled in at dossier-author time (Wave 7) from the actual data, not pre-committed.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Apparatus has a runtime bug not caught by `--dry-run` | M | Smoke run at Wave 1 ($0.10 max) catches it before full Phase 1 commits |
| Coarse shave produces zero atoms despite maxCF=999 | L | Wave 3 verification halts before Phase 2 if `over_1500_chars < 6` |
| Phase 2 spend overruns $50 due to MCP context stuffing on 6 harder tasks | M | BudgetTracker pre-call guard throws BudgetExceededError; partial-run results are still saved by `phase2-v4.mjs` write path |
| No rescue-eligible tasks (v3 null repeats at v4) | M | Honesty clause: document verbatim, skip Wave 6, land null verdict |
| `.env` missing or `ANTHROPIC_API_KEY` invalid | L | Phase scripts exit fast with clear error; smoke run surfaces it before commit |
| Cross-platform vitest binary not found by oracle-runner | L | `oracle-runner.mjs` already has multi-location search fallback; if it still fails, run `pnpm -w install` once at the start |
| LLM emits non-fenced code that oracle-runner can't extract | L | `extractCode` has TS-fenced → plain-fenced → raw-text fallback chain; record any extraction-failed reps in dossier §5 |
| Worktree drift from main mid-run (someone lands changes to packages/) | L | Implementer pins to current HEAD at run start; if `git fetch` shows new commits after Phase 1, halt and re-plan |
| Concurrent run by another session against same `.yakcc/registry.sqlite` | L | This WI never writes the workspace registry — runs are perfectly isolated under per-run `tmp/B4-tokens-v4/<id>/` |

---

## 10. Reviewer checklist (for the read-only outer-loop reviewer)

1. **Scope compliance:** `git diff main...HEAD --stat` shows zero touches to forbidden paths in §7.
2. **Apparatus untouched:** `git diff main...HEAD bench/B4-tokens-v4/harness/ bench/B4-tokens-v4/tasks/ bench/B4-tokens-v4/tasks.json` is empty.
3. **Artifacts present:** all §6.1 paths exist and parse cleanly.
4. **Cost discipline:** sum of all billing JSONL `cost_usd` ≤ $50 (or operator-OK overage in dossier).
5. **Composite atoms verified:** `phase1-<iso>-registry-verify.txt` shows `over_1500_chars >= 6`.
6. **Honesty clause:** dossier §4 verdict matches data tables in §3. No reframing of null findings.
7. **CI green:** paste of `pnpm -w lint` + `pnpm -w typecheck` output in PR or reviewer artifact.
8. **PR not Guardian-merge:** confirm PR opened via `gh pr create --base main`, NOT direct merge.

---

## 11. Memory / standing-rules cross-references

- `workflow_fetch_before_planning.md` — orchestrator confirmed fetch at dispatch time.
- `project_b4_v3_harness_env_wiring.md` — `node --env-file=.env` invocation from repo root.
- `feedback_pr_not_guardian_merge.md` — land via PR, NEVER Guardian-merge.
- `feedback_fetch_before_pr.md` — `git fetch origin && git pull --ff-only origin main` immediately before `gh pr create`.
- `feedback_eval_contract_match_ci_checks.md` — `pnpm -w lint` + `pnpm -w typecheck`, NEVER `--filter`.
- `feedback_planner_writes_to_wrong_cwd.md` — plan + scope written INSIDE worktree (verified).
- `feedback_no_continue_prompts.md` — after PR lands, orchestrator picks up next fuckgoblin issue without permission-seeking.
- `feedback_act_on_unblocks.md` — operator's "we can run some benchmarks that were blocked now" is the unblock; execute.
- `workflow_fuckgoblin_orchestrator_loop.md` — this WI is a fuckgoblin queue item; orchestrator's standing loop handles PR + cleanup post-merge.
- `feedback_worktree_naming_convention.md` — worktree at `.worktrees/feature-wi-731-b4-v4-execute` (cc-policy retire compatible).

---

## 12. Next work item

Upon PR merge:
- If verdict is "rescue confirmed" → next WI is D4 follow-up (Haiku 3.0 cells G/H per #722 D4 deferral); orchestrator files the ticket.
- If verdict is "rescue not supported at this corpus shape" → record as the second null finding in the B4 sequence; operator decides whether to invest in B4-v5 corpus design or pivot the cluster (`DEC-B4-CONVERGENCE-001` re-evaluation). Filed as `needs_user_decision`.
- If verdict is "rescue ambiguous, follow-up at N=10 documented" → already executed via Wave 6; no follow-up needed beyond the dossier.

Planner's emitted next work item: `wi-731-b4-v4-execute` (the implementation/execution slice; this planner pass produces only the plan + scope, not the execution).
