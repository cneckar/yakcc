# DEC-BENCH-B4-V4-001 — B4-v4 hypothesis matrix execution dossier

> **Status**: accepted
> **Decision**: First B4-v4 matrix run is preserved as the execution of record. The v4 corpus redesign (composite atoms + failure-boundary-calibrated tasks) was successfully built and exercised. The hypothesis (registry-hooked atoms rescue weak models) is **not confirmed at this corpus shape**. Rescue scenario fired on one task (semver-range); N=10 extension yielded a directional signal (F > E) but F=20% is sub-statistical and does not meet the ≥70% confirmation threshold. Verdict: **rescue ambiguous — directional signal at sub-statistical power**.
> **Closes**: #731
> **Run identifiers (canonical)**: `phase1-2026-05-18T17-18-16` + `phase2-2026-05-18T17-55-24`
> **Total spend**: $8.74 USD against $75 cap (`DEC-V0-B4-SLICE2-COST-CEILING-004`)
> **Operator authorization**: `cdn@yakcc.com`, 2026-05-18 ~16:40Z ("we can run some benchmarks that were blocked now")

## 1. Objective

Per #731, execute the B4-v4 two-phase hypothesis matrix end-to-end and produce a DEC-attributed dossier. The hypothesis under test:

> Giving a weaker model (haiku) access to a registry of atoms shaved from a stronger model's (opus) solutions lets the weaker model produce the same correct output with **fewer total tokens** (and ideally higher pass-rate). Without hooks, the weaker model either fails or burns more output. With hooks, it leverages the registry to short-cut to a correct solution.

The B4-v4 apparatus corrects both structural defects identified in `DEC-BENCH-B4-V3-001`:

1. **Registry redesign (DEC-B4-V4-CORPUS-COMPOSITE-001)**: dual-shave persistence — fine pass (`maxControlFlowBoundaries=1`, L0 leaves) AND coarse pass (`maxControlFlowBoundaries=999`, task-scale composite atoms). The v3 registry had 194 atoms all at L0, average 88 chars. The v4 registry has 348 atoms including task-scale composites up to 3,418 chars.
2. **Task-set recalibration (DEC-BENCH-B4-V4-TASKS-001)**: 6 tasks (`crc32c`, `utf8-codec`, `base32-rfc4648`, `lru-ttl-cache`, `semver-range`, `ring-buffer`) deliberately calibrated to Haiku-4.5's failure boundary. Each has documented adversarial traps that make Haiku-4.5 genuinely fail unhooked.

The matrix shape: **3 models × 2 hook configs × 6 tasks × 3 reps = 108 calls** in Phase 2, building on Phase 1's Opus-built corpus.

## 2. Execution mechanics

### Phase 1 (corpus build, Opus unhooked)

Two apparatus-setup runs, then one canonical run:

| Run | Outcome | Cost | Atoms in registry |
|---|---|---|---|
| `phase1-2026-05-18T17-11-11` | `Cannot find package '@anthropic-ai/sdk'` — bench deps not installed | $0 | 0 |
| `phase1-2026-05-18T17-17-20` | `License refused: no recognizable license identifier` — stale shave dist | $0 | 0 |
| **`phase1-2026-05-18T17-18-16`** | **18/18 reps oracle complete, atoms registered** | **$1.92** | **348** |

Two apparatus discoveries:

- **Missing bench deps**: `bench/B4-tokens-v4/` is not in the pnpm workspace. Running `pnpm install` from repo root does not install bench-local deps. Fix: `pnpm install --ignore-workspace` from the bench dir created local `node_modules/@anthropic-ai/sdk`. This also applies in the worktree (separate `pnpm install --ignore-workspace` required in the worktree bench dir).

- **Stale shave dist (DEC-LICENSE-GATE-REMOVE-001)**: `packages/shave/dist` had not been rebuilt after WI-682 removed the ingest-side license gate. The dist still threw `LicenseRefusedError` for LLM-generated code lacking SPDX headers. Fix: `pnpm --filter @yakcc/shave build` rebuilt the dist from src. No bench apparatus modifications were made; this is a pre-run environment setup step.

Phase 1 canonical run `phase1-2026-05-18T17-18-16`: 18/18 reps complete (6 tasks × N=3), all 18 reps have non-empty `atom_merkle_roots_fine` and `atom_merkle_roots_coarse`.

All earlier run artifacts are preserved for historical record.

### Registry verification (Wave 3, $0)

Verified directly via SQLite query against `tmp/B4-tokens-v4/phase1-2026-05-18T17-18-16/registry.sqlite` at `2026-05-18T17:32Z`. Full report: `phase1-2026-05-18T17-18-16-registry-verify.txt`.

Key findings:
- `total_atoms = 348`
- `size_p100 = 3418`, `size_p50 = 52`, `size_p10 = 19`
- `over_1500_chars = 10` (gate ≥6: **PASS**)
- Per-task top-1 query scores via `findCandidatesByQuery({ behavior: <intent> }, { limit: 5 })`: all 6 tasks ≥ 0.70 (**PASS**)

Note: the plan's verification script used `reg.findCandidatesByQuery(string, ...)` which returns no results. The correct API takes `QueryIntentCard { behavior: string }`. The verified scores above used the correct object form.

### Phase 2 (matrix exploit, 6 cells × 6 tasks × 3 reps)

Two abandoned runs, then one canonical run:

| Run | Outcome | Notes |
|---|---|---|
| `phase2-2026-05-18T17-40-43` (smoke) | smoke PASS | MCP spawn + oracle pipeline confirmed |
| `phase2-2026-05-18T17-41-10` | MCP errors in hooked cells (B, D, F) — worktree path issue | Aborted. Historical record preserved. |
| `phase2-2026-05-18T17-54-47` (smoke) | smoke PASS after worktree fix | Confirmed fix |
| **`phase2-2026-05-18T17-55-24`** | **108/108 calls complete** | **$6.64** |

**Worktree path discovery**: `mcp-server.mjs`'s `findRepoRootSync()` looks for `.git` as a **directory**, but in git worktrees `.git` is a **file**. The fallback resolved to the worktree root, which lacks `packages/registry/dist/`. Fix: set `YAKCC_REPO_ROOT=C:/src/yakcc` env var (the comment in `mcp-server.mjs` documents this exact scenario). No apparatus modifications.

Cells:

| Cell | Model | Hook config |
|---|---|---|
| A | opus-4-7 | unhooked (quality baseline) |
| B | opus-4-7 | hooked (registry via MCP) |
| C | sonnet-4-6 | unhooked |
| D | sonnet-4-6 | hooked |
| E | haiku-4-5 | unhooked (killer baseline) |
| F | haiku-4-5 | hooked (killer cell) |

### Wave 6: rescue N=10 (semver-range only)

Rescue eligibility criterion: E=0/3 AND F≥1/3 at N=3 baseline. Only `semver-range` qualified (E=0/3, F=1/3).

| Run | Cell | Task | N | Pass | Cost |
|---|---|---|---|---|---|
| `phase2-2026-05-18T18-29-00` | E haiku·unhooked | semver-range | 10 | 1/10 (10%) | $0.07 |
| `phase2-2026-05-18T18-31-00` | F haiku·hooked | semver-range | 10 | 2/10 (20%) | $0.11 |

## 3. Headline empirical findings

### Oracle pass-rate (X/3 reps) — canonical run `phase2-2026-05-18T17-55-24`

| Task | A opus·unhooked | B opus·hooked | C sonnet·unhooked | D sonnet·hooked | E haiku·unhooked | F haiku·hooked |
|---|---|---|---|---|---|---|
| crc32c | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| utf8-codec | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 |
| base32-rfc4648 | 2/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 |
| lru-ttl-cache | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 2/3 |
| **semver-range** | 3/3 | 3/3 | 3/3 | 2/3 | **0/3** | **1/3** |
| ring-buffer | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

Rescue-eligible tasks at N=3: **semver-range only** (E=0/3, F=1/3).

### semver-range N=10 extension

| Cell | N=3 | N=10 | Direction |
|---|---|---|---|
| E haiku·unhooked | 0/3 (0%) | 1/10 (10%) | — |
| F haiku·hooked | 1/3 (33%) | 2/10 (20%) | F > E ✓ |

F > E directionally. F=20% does not meet the ≥70% confirmation threshold (`DEC-B4-V4-REPS-001`).

### Per-cell token / cost averages (crc32c — all-pass baseline)

crc32c is the cleanest apples-to-apples comparison (all 6 cells 3/3):

| Cell | in tokens | out tokens | $/call |
|---|---|---|---|
| A opus·unhooked | 642 | 484 | $0.0459 |
| **B opus·hooked** | **3,218** | **532** | **$0.0882** |
| C sonnet·unhooked | 469 | 430 | $0.0079 |
| **D sonnet·hooked** | **2,648** | **1,081** | **$0.0242** |
| E haiku·unhooked | 468 | 459 | $0.0022 |
| **F haiku·hooked** | **1,877** | **522** | **$0.0036** |

### Hooked-vs-unhooked deltas

- **Input tokens (hooked)**: 4–5× the unhooked baseline (MCP context-stuffing).
- **Output tokens (hooked)**: equal (opus B≈A) to 2.4× larger (sonnet D vs C) than unhooked.
- **Cost per call (hooked)**: 1.6–3× the unhooked baseline.
- **Quality (hooked)**: mixed. Opus+hooked improved base32-rfc4648 (3/3 vs A=2/3). Sonnet+hooked degraded on base32-rfc4648 (1/3 vs C=3/3) and lru-ttl-cache (1/3 vs C=3/3). Haiku+hooked was better-or-equal on all tasks except lru-ttl-cache (2/3 vs E=3/3) and provided the only rescue signal on semver-range.

## 4. Verdict on the hypothesis

**Rescue ambiguous: directional signal at sub-statistical power.**

The v4 corpus redesign successfully produced task-scale composite atoms (348 atoms, 10 atoms >1,500 chars, top-1 scores ≥0.70 for all 6 tasks). The registry is no longer the "strawman" of v3 (194 leaf atoms, average 88 chars). The task-set recalibration produced exactly one rescue-eligible task (`semver-range`), which is the correct experimental condition for testing the rescue hypothesis.

On the rescue-eligible task:
- N=3 baseline: F=1/3 vs E=0/3 — directional signal, too thin to conclude.
- N=10 extension: F=2/10 (20%) vs E=1/10 (10%) — directional (F > E) but F far below the ≥70% confirmation threshold.

The failure mode for semver-range haiku·unhooked is highly specific: the tilde-range `~1` should accept `1.9.9` (8/10 reps fail on this one test case), plus edge cases around `satisfies()` throwing `TypeError` for partial versions. The hooked cell's marginal improvement (1 additional pass in 10 tries) suggests the composite atoms were found but did not provide a decisive advantage on these edge-case semantics.

**The hypothesis is not confirmed at this corpus shape.** A flat "not supported" verdict (as in v3) is not warranted here: the apparatus improvements worked, the rescue scenario fired, and a directional signal exists. But the signal is too weak and too narrow (1 task, N=10, F=20%) to declare the hypothesis confirmed. The honest characterisation is "directional signal at sub-statistical power."

**Important distinction from v3:** In v3, the negative result was partly an apparatus artifact (no task-scale atoms, wrong task set). In v4, the apparatus is repaired — the result reflects the genuine weakness of the rescue effect on this specific task set and corpus shape.

## 5. Design observations

### 5.1 Rescue calibration: one task at the failure boundary is too narrow a base

Only `semver-range` produced E=0/3. The other 5 tasks were within haiku's solo capability. "6 tasks calibrated to the failure boundary" turns out to mean "5 tasks haiku handles, 1 task haiku struggles with." For the rescue test to be statistically meaningful, ≥3 rescue-eligible tasks at N=3 are needed.

### 5.2 semver-range failure mode is resistant to atom substitution

The specific failure on `semver-range` is a narrow edge case: `~1 should accept 1.9.9` (the major-only tilde-range expand rule). Haiku generates a semantically-plausible but subtly wrong rule for this case. The composite atoms from Opus solutions contain the correct rule (since Opus passed 3/3), but the atom lookup + substitution mechanism did not reliably guide haiku to the right answer. This is the deepest diagnostic: the registry has the right information, but the substitution path is not reliably leveraging it for fine-grained semantic edge cases.

### 5.3 Sonnet degradation in D cells

sonnet·hooked degraded on `base32-rfc4648` (1/3 vs C=3/3) and `lru-ttl-cache` (1/3 vs C=3/3). Sonnet-unhooked passes 3/3 on both. The MCP context injection is disrupting sonnet's generation on tasks it would otherwise solve cleanly. This is a regressor — hooking a model that doesn't need rescue makes it worse.

### 5.4 Opus+hooked quality improvement on base32-rfc4648

Surprisingly, opus·hooked improved over opus·unhooked on `base32-rfc4648` (B=3/3 vs A=2/3). Opus-unhooked fails 1/3 on this task; the registry atom lookup seems to have provided a useful hint. This is the only cell where hooking improved quality vs the unhooked baseline, and only on the strongest model.

## 6. Next iteration: if B4-v5 is warranted

Based on this run's diagnostic findings, a B4-v5 apparatus would need:

1. **Broader rescue coverage**: select tasks with a higher Haiku-4.5 failure rate, or use a weaker model baseline. A task suite where ≥3 of 6 tasks produce E=0/3 at N=3 gives enough statistical power for rescue confirmation.
2. **Atom substitution quality**: investigate why the semver-range composite atoms did not close the edge-case gap. The substitution path may be providing the full impl but not the critical tilde-range rule specifically. A finer-grained "intent slice" atom focused on tilde-range semantics might outperform the full composite.
3. **Disable-hooked-on-capable-model**: the Sonnet D-cell degradation is a product signal — hooking a model that doesn't need rescue is a net negative. A capability-aware hook (enable only when model confidence falls below a threshold) is the design response.
4. **(Optional) Haiku-3.0 cells**: as proposed in v3 dossier §6, adding `claude-3-haiku-20240307` (the original Haiku 3.0) as a weaker baseline may produce more rescue-eligible tasks at N=3 without changing the task suite.

These belong in a separate WI (B4-v5 or similar). #731 is closed by this dossier.

## 7. Apparatus / process notes

- **Cost discipline held**: $8.74 actual / $75 cap (11.7% of budget). Breakdown: Phase 1 $1.92 (includes two $0 apparatus-setup aborts — no API cost for those), Phase 2 baseline $6.64, rescue N=10 $0.18.
- **Honesty clause held**: the test conditions produced a weak rescue signal, not confirmation. The dossier records this honestly.
- **Apparatus changes required (pre-run environment setup, not bench modifications)**:
  - `pnpm install --ignore-workspace` in `bench/B4-tokens-v4/` (and in the worktree bench dir) to install `@anthropic-ai/sdk` locally.
  - `pnpm --filter @yakcc/shave build` to rebuild shave dist after WI-682's license-gate removal (DEC-LICENSE-GATE-REMOVE-001).
  - `YAKCC_REPO_ROOT=C:/src/yakcc` env var when running from a git worktree (documented in `mcp-server.mjs`'s `findRepoRootSync` comment).
  - Registry API: `findCandidatesByQuery({ behavior: string }, opts)` — takes `QueryIntentCard`, not a plain string. All three findings documented in `phase1-2026-05-18T17-18-16-registry-verify.txt` notes section.
- **Validity of canonical runs**: phase1 and phase2 canonical runs are genuine LLM emissions through the real shave pipeline with no hand-crafted atoms. The never-synthetic invariant (`DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001`) holds.
- **Broken MCP run artifact**: `phase2-2026-05-18T17-41-10.json` is a partial run with hooked cells returning MCP errors. It is retained for historical record but is **not the measurement run**. The canonical Phase 2 run is `phase2-2026-05-18T17-55-24`.
- **Raw artifacts** (committed alongside this dossier):
  - `phase1-2026-05-18T17-11-11.json` + `.jsonl` — deps-missing abort
  - `phase1-2026-05-18T17-17-20.json` + `.jsonl` — stale-dist abort
  - `phase1-2026-05-18T17-18-16.json` + `.jsonl` — canonical corpus-build run
  - `phase1-2026-05-18T17-18-16-registry-verify.txt` — registry verification report
  - `phase2-2026-05-18T17-40-43.json` + billing — Phase 2 smoke PASS
  - `phase2-2026-05-18T17-41-10.json` + billing — broken MCP run (historical)
  - `phase2-2026-05-18T17-54-47.json` + billing — Phase 2 smoke PASS (after worktree fix)
  - `phase2-2026-05-18T17-55-24.json` + billing — canonical Phase 2 run
  - `phase2-2026-05-18T18-29-00.json` + billing — rescue E N=10
  - `phase2-2026-05-18T18-31-00.json` + billing — rescue F N=10

## 8. Cross-references

- WI: #731 (`[FuckGoblin] wi-731-b4-v4-execute`)
- Predecessor design: PR #728 (corpus-redesign apparatus, WI-722)
- v3 dossier: `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`
- Budget DEC: `DEC-V0-B4-SLICE2-COST-CEILING-004`
- Corpus redesign DEC: `DEC-B4-V4-CORPUS-COMPOSITE-001`
- Task-set DEC: `DEC-BENCH-B4-V4-TASKS-001`
- Reps DEC: `DEC-B4-V4-REPS-001` (N=3 baseline; ≥70% F required for rescue confirmation)
- Matrix DEC: `DEC-BENCH-B4-V4-MATRIX-001`
- License-gate removal: `DEC-LICENSE-GATE-REMOVE-001` (WI-682 / PR #714)
- Convergence context: `DEC-B4-CONVERGENCE-001` (Path A measurement leg — v4 dossier is the first measurement with the repaired apparatus; hypothesis remains open at sub-statistical power)
