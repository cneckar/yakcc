# Plan — WI-DEC-B4V3-001 — annotate `DEC-BENCH-B4-V3-001` verdict in MASTER_PLAN.md

> Workflow id: `dec-b4v3-001-kill`
> Goal id: `g-dec-b4v3-001`
> Work item id: `wi-dec-b4v3-001`
> Authority: planner (governance writes only — no source / no bench / no docs touched)
> Worktree: `/Users/cris/src/yakcc/.worktrees/feature-dec-b4v3-001-kill` @ `origin/main` (5663395)
> Predecessor: PR landing dossier at `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` (commit `c2cddbf`); #653 already CLOSED.

---

## 1. Problem statement (restated)

The B4-v3 hypothesis matrix executed on 2026-05-17 and the resulting dossier
(`bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`, committed `c2cddbf`,
closing #653) is the empirical record-of-execution. The Decision Log in
`MASTER_PLAN.md` does **not** yet carry the corresponding `DEC-BENCH-B4-V3-001`
row, and the v0.5 Slice 2.6 block (lines 1972-2011) still narrates the slice as
"in progress / pending Phase 1 + Phase 2 runs — operator-initiated", which is
factually stale: both phases completed.

The MASTER_PLAN is the canonical governance surface for cross-stage decisions;
without a Decision Log row, Future Implementers reading the plan top-to-bottom
cannot see the verdict, cannot find the dossier from the plan, and cannot tell
that the Slice 2.6 cycle closed (only what was planned, not what happened).

This WI is a **governance-only annotation** of facts already established in
the dossier. No source, no bench, no docs, no scripts, no examples are
touched. Scope is restricted to two files by the workflow contract:

- `MASTER_PLAN.md`
- `plans/wi-dec-b4v3-001.md` (this file)

## 2. Verdict to record (sourced from the dossier, not the dispatch prompt)

The orchestrator dispatch prompt described the verdict as a flat "KILL" with a
cell table whose numbers diverge from the committed dossier. The canonical
authority is the **dossier**:

- `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` § 4 — verdict prose:
  > **The hypothesis is not supported at this corpus shape.**
- Headline finding: hooking added cost on every cell measured cleanly, never
  reduced output tokens, degraded quality on the only task large enough to
  stress max_tokens (`json5-parser`: Opus-hooked and Sonnet-hooked truncated
  at max_tokens=4096, 0/3 pass vs unhooked 3/3).
- One faint signal toward rescue: `json5-parser × F` (haiku-hooked) — 1/3 vs
  E unhooked 0/3. N=3 is too thin to call confirmed; 4/5 tasks could not
  exercise the rescue scenario because haiku solved them solo.
- Total spend: **$7.08 / $75 cap** (`DEC-V0-B4-SLICE2-COST-CEILING-004`).
  Phase 1 ran twice; the first phase 1 (license-refused, $1.70) is the
  apparatus tax for discovering the SPDX gate. Phase 2 cost $5.33.

The dossier identifies two **structural apparatus defects** that prevent the
current run from being a clean falsification of the hypothesis at all corpus
shapes:

1. **Registry is shredded; no task-scale atoms to find.** All 194 atoms at
   level L0 (leaf-level fragments); largest impl_source 1,601 chars; average
   88 chars. There is no "json5-parser whole impl" atom for the weak model's
   MCP query to match. The hypothesis assumed registry contained whole-task
   solutions; shave decomposed them to single-statement / single-literal
   fragments.
2. **Task set isn't calibrated to weak-model failure threshold.** Only
   `json5-parser` made haiku fail. The other 4 tasks were within haiku's solo
   capability, so the rescue test couldn't fire.

These two defects mean the right verdict shape is **"not supported at this
corpus shape; apparatus defects identified; B4-v4 redesign required"** rather
than a flat hypothesis KILL. The dispatch prompt's "KILL" framing is too
strong — but the data does decisively reject the hypothesis _as currently
testable_, which is also what the dossier says.

## 3. Why this is two edits, not one

The MASTER_PLAN edit has two structurally distinct touches:

### Edit A — Amend existing `DEC-BENCH-B4-V3-001` row in place (line 2653)

**Discovered during plan execution:** the Decision Log already contains a
`DEC-BENCH-B4-V3-001` row at line 2653 — authored at #644 (the design pass)
with a deliberate `**Verdict slot:** pending first run.` placeholder. The
correct shape is **amend the existing row in place**, not append a duplicate.
Appending a second `DEC-BENCH-B4-V3-001` row would violate Sacred Practice
#12 (no parallel mechanisms / single source of truth) — a row ID is a unique
key, and the row was authored to receive its verdict via in-place fill (the
honesty-clause precedent in the same row's Rationale cell says: *"verdict
slot empty until Tester runs, raw oracle counts recorded verbatim"*).

The amendment replaces the single sentence `**Verdict slot:** pending first
run.` with a multi-paragraph verdict block carrying: the verdict prose
(verbatim quote from dossier § 4), Phase 1 + Phase 2 execution actuals,
total spend, headline finding, rescue-signal note, validation-criteria
result, the two structural apparatus defects, the next-iteration redirect,
the "why-not-flat-KILL" framing, and the how-to-apply guard. The
Rationale cell also receives an **Amendment 2026-05-18 (WI-DEC-B4V3-001)**
paragraph appended after the original cornerstones paragraph, recording
that the verdict fill is governance-only and pointing at the dossier as the
underlying evidence record.

This in-place fill is the **single canonical Decision Log authority** for
the B4-v3 verdict. The dossier remains the underlying evidence record; the
row is the plan-level pointer at it. The mechanism precisely matches the
`DEC-BENCH-B4-001` precedent at line 2652, which was likewise authored as a
verdict-bearing row and had its verdict filled in-place after the first
min-tier matrix run completed (`min-2026-05-14-21-20-9d0e8234`).

### Edit B — Active Initiatives Slice 2.6 status update (lines 1972-2011)

The Slice 2.6 block currently says "in progress 2026-05-17" and
"Hypothesis validation criteria ... (pending Phase 1 + Phase 2 runs —
operator-initiated)". Both statements are stale.

Update the status to **"closed 2026-05-18; dossier landed; #653 CLOSED;
hypothesis not supported at this corpus shape per `DEC-BENCH-B4-V3-001`;
B4-v4 redesign queued"**. Update the validation-criteria line to record the
verdict instead of the pending state. Mark the work-item rows as landed
(WI-B4-V3-PHASE1-RUN, WI-B4-V3-PHASE2-RUN, WI-B4-V3-DOSSIER all complete per
commit `c2cddbf`).

Keep Slice 2.6's design narrative intact — it remains accurate as the
description of what was attempted; only the status/outcome lines change.

### Why no separate plans-section or work-item-table touches

The work item shape (WI-B4-V3-DOSSIER → record `DEC-BENCH-B4-V3-001`) is
already in MASTER_PLAN.md at line 2003. The work was done; only the status
and the Decision Log row are missing. Adding a fresh "v0.5-bench-followup"
initiative section would be a parallel mechanism for a slice that already
exists; Sacred Practice #12 forbids it.

## 4. Concrete edits

### Edit A: insert into Decision Log table

Position: at the end of the Decision Log table (after the last row, before
the next section break). Mirrors the precedent of how new DEC rows have been
appended over time (the table grows monotonically; rows are never reordered).

Row text (single line in the pipe-delimited table; long-cell formatting is the
established norm — the row appears on a single logical line in source):

```
| DEC-BENCH-B4-V3-001 | **B4-v3 hypothesis matrix verdict (WI-DEC-B4V3-001, 2026-05-18, closes #653).** ... | ... |
```

Decision cell load:

1. The verdict prose from dossier § 4 (verbatim quote, attributed): *"The
   hypothesis is not supported at this corpus shape."*
2. Two-phase execution summary: Phase 1 corpus-build (`phase1-2026-05-17T23-16-09`,
   335 atoms registered, $1.75 plus $1.70 license-refused apparatus tax);
   Phase 2 matrix (`phase2-2026-05-17T23-23-33`, 90/90 calls, $5.33). **Total
   spend $7.08 / $75 cap.**
3. Headline cell summary: across all cleanly-measurable cells, hooking added
   2-6× cost (input tokens 4-7× from MCP context-stuffing), never reduced
   output tokens, and degraded quality on the one task large enough to stress
   max_tokens (`json5-parser`: Opus-hooked 0/3 + Sonnet-hooked 0/3 due to
   max_tokens=4096 truncation, vs unhooked 3/3).
4. One faint rescue signal: `json5-parser × F` (haiku-hooked) 1/3 vs E
   unhooked 0/3. N=3 is too thin to declare confirmed; 4/5 tasks could not
   exercise the rescue scenario.
5. Two structural apparatus defects identified in operator review (dossier § 5):
   (a) registry is shredded to leaf-level fragments (all 194 atoms at L0;
   largest 1,601 chars; avg 88 chars) — no task-scale atoms exist for the
   weak model to find; (b) task set not calibrated to weak-model failure
   boundary (only json5-parser stressed haiku).
6. Next-iteration redirection (dossier § 6): B4-v4 must (i) persist
   task-scale composite atoms or an intent-index queryable by task intent,
   and (ii) recalibrate tasks to live deliberately at/beyond haiku's failure
   boundary. B4-v4 is a separate WI gated on those structural changes. This
   DEC does **not** ship the redesign; it records the verdict + the redirect.
7. Cross-references: dossier `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`;
   landing commit `c2cddbf`; closes #653; predecessor PR #647 (harness
   landing only); budget DEC `DEC-V0-B4-SLICE2-COST-CEILING-004`; phase-split
   DEC `DEC-BENCH-B4-V3-PHASE1-BUDGET-001`; related apparatus PRs #714 (shave
   license-gate removal) and #682 (issue); cluster context
   `DEC-B4-CONVERGENCE-001` (Path A measurement leg — refutes convergence at
   this corpus shape, leaves the convergence hypothesis itself open pending
   B4-v4 redesign).
8. **How to apply:** any future PR or DEC that revives the B4-v3 hypothesis
   without the two structural apparatus changes (task-scale atom persistence
   + failure-boundary-calibrated task set) must be rejected at reviewer; the
   only legitimate way to revisit is via a new B4-v4 DEC that explicitly
   names which apparatus defect it fixes.

Rationale cell load:

1. The Slice 2.6 design produced the falsifying data the hypothesis was
   shaped to produce: a clean failure on the cleanest task (`pkce-code-verifier`,
   every cell passing → apples-to-apples cost comparison) shows that hooking
   adds cost without quality return at this corpus shape. The data is honest:
   the test conditions clearly favored the null hypothesis on 4/5 tasks (no
   rescue scenario fires when the weak model solves solo), and the dossier
   records that clearly rather than reframing the data.
2. The "not supported at this corpus shape" framing — rather than a flat
   hypothesis KILL — is the load-bearing distinction. The hypothesis assumes
   the registry contains task-scale solutions; the registry contains leaf
   atoms. The hypothesis was tested against a strawman corpus shape; the
   negative result is robust at the strawman shape but does not rule out the
   hypothesis at a corpus shape that includes task-scale atoms.
3. Cost discipline held ($7.08 of $75 cap; 9.4% utilization). The verdict
   is well-evidenced at a low fraction of budget.
4. Sacred Practice #5 (loud failure / preserve coverage): preserving the
   apparatus-tax run (the license-refused phase 1) and recording it as part of
   the cost ledger is the honest accounting; the alternative — silently
   dropping the failed run from the dossier — would have hidden a real
   apparatus-discovery cost.
5. Sacred Practice #12 (no parallel mechanisms): this DEC supersedes nothing;
   it is the first verdict slot for B4-v3. B4-v4 (if it ships) will create a
   sibling DEC, not amend this one in-place.

### Edit B: amend Slice 2.6 status lines (lines 1972, 2005, 2009)

Three precise textual updates:

**Line 1974 (current):**
> Status: **in progress 2026-05-17.** Opened by operator framing in issue [#644]...

**Replacement:**
> Status: **closed 2026-05-18.** Dossier landed at
> `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` (commit `c2cddbf`);
> #653 CLOSED; verdict recorded in `DEC-BENCH-B4-V3-001` (Decision Log).
> Hypothesis **not supported at this corpus shape**; two structural apparatus
> defects identified for B4-v4 redesign (task-scale atom persistence +
> failure-boundary-calibrated task set). Opened by operator framing in issue
> [#644](https://github.com/cneckar/yakcc/issues/644) (WI-B4-V3-HYPOTHESIS-MATRIX).

**Line 2005 (current):**
> WI-B4-V3-TASKS-001 and WI-B4-V3-HARNESS-001 are **landed** (issue #644). WI-B4-V3-HARNESS-COMPLETE is **landed** (issue #662, PR wiring oracle-runner + MCP server + classify + billing/budget/verify).

**Replacement:**
> All six WI rows are **landed** as of 2026-05-18: WI-B4-V3-TASKS-001 and
> WI-B4-V3-HARNESS-001 via issue #644; WI-B4-V3-HARNESS-COMPLETE via issue
> #662 (PR wiring oracle-runner + MCP server + classify + billing/budget/verify);
> WI-B4-V3-PHASE1-RUN, WI-B4-V3-PHASE2-RUN, and WI-B4-V3-DOSSIER via commit
> `c2cddbf` (which produced the dossier at
> `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` and closed #653).

**Line 2009 (current):**
> **Hypothesis validation criteria** (per issue #644): across ≥50% of tasks, all four must hold: E fails oracle OR takes ≥5× A's turns; F passes oracle; C_F/C_A ≤ 0.2; Q_F == Q_A. Verdict in `DEC-BENCH-B4-V3-001` (pending Phase 1 + Phase 2 runs — operator-initiated).

**Replacement:**
> **Hypothesis validation criteria** (per issue #644): across ≥50% of tasks,
> all four must hold: E fails oracle OR takes ≥5× A's turns; F passes oracle;
> C_F/C_A ≤ 0.2; Q_F == Q_A. **Verdict: not supported at this corpus shape
> (`DEC-BENCH-B4-V3-001`).** The criteria were not met on the executed
> matrix: rescue scenario only exercised on `json5-parser` (1/5 tasks; 4/5
> tasks were within haiku-unhooked capability, so E vs F comparison was
> degenerate). On `json5-parser × F` haiku-hooked passed 1/3 vs E unhooked
> 0/3 — directionally consistent with the hypothesis but N=3 too thin to
> declare confirmed. Two structural apparatus defects (registry shredded to
> leaf atoms; task set not calibrated to weak-model failure boundary)
> prevent the current run from being a corpus-shape-independent
> falsification; B4-v4 redesign is queued.

## 5. Evaluation Contract

The Guardian reviewer for this slice may declare ready when ALL of the
following are true. Each criterion is mechanically checkable.

### Required artifacts present

- [ ] `plans/wi-dec-b4v3-001.md` exists, is committed, and matches the scope
      manifest (no edits outside the two allowed files).
- [ ] `MASTER_PLAN.md` is modified.

### Decision Log row content

- [ ] The Decision Log table contains **exactly one** row with
      `DEC-BENCH-B4-V3-001` as the ID cell (the pre-existing row from #644,
      amended in place — no duplicate row appended).
- [ ] The row's Decision cell no longer contains the literal phrase `Verdict
      slot:** pending first run.` (placeholder filled).
- [ ] The Decision cell now contains the literal phrase `Verdict slot
      (filled 2026-05-18 per WI-DEC-B4V3-001, closes #653): NOT SUPPORTED AT
      THIS CORPUS SHAPE`.
- [ ] The Decision cell contains the verbatim quote *"The hypothesis is not
      supported at this corpus shape."*
- [ ] The Decision cell includes the total-spend figure **$7.08** and the
      cost-cap reference **`DEC-V0-B4-SLICE2-COST-CEILING-004`**.
- [ ] The Decision cell includes both apparatus-defect names: the "registry
      shredded to leaf atoms" finding (with the 194 atoms / L0 /
      88-char-avg facts) and the "task set not calibrated to weak-model
      failure boundary" finding.
- [ ] The Decision cell names the landing commit `c2cddbf` and the dossier
      path `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`.
- [ ] The Decision cell records that #653 is closed by this verdict.
- [ ] The Rationale cell carries an `**Amendment 2026-05-18
      (WI-DEC-B4V3-001):**` paragraph appended after the original
      cornerstones paragraph, explaining the in-place fill rationale
      (single-source-of-truth; the row was authored with the verdict-slot
      placeholder specifically so the verdict would land here) and the
      "not supported at this corpus shape" framing (deliberately weaker
      than a flat KILL — explained inline).
- [ ] The pre-existing Decision and Rationale text from #644 (the design
      pass) is preserved unchanged outside the two amendment sites — the
      surrounding text (matrix shape, task list, cell definitions, budget,
      criteria) is **not** rewritten.

### Slice 2.6 status freshness

- [ ] Line 1974 Status reads "closed 2026-05-18" (not "in progress").
- [ ] Line 2005 names all six WI rows as landed (with their landing commit /
      issue references).
- [ ] Line 2009 records the verdict ("not supported at this corpus shape")
      instead of "pending Phase 1 + Phase 2 runs".

### Scope manifest invariants

- [ ] No file under `packages/**`, `bench/**`, `docs/**`, `.github/**`,
      `.claude/**`, `scripts/**`, `examples/**`, `bootstrap/**` is modified.
- [ ] `git status` shows only `MASTER_PLAN.md` modified and
      `plans/wi-dec-b4v3-001.md` added (no other touches).
- [ ] No content from `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md` is
      copy-pasted verbatim into MASTER_PLAN.md — the Decision Log row
      summarizes the dossier and points at it; it does not duplicate the
      dossier's full content (Sacred Practice #12, single source of truth —
      the dossier remains the evidence record; the DEC row is the plan-level
      pointer).

### Authority invariants

- [ ] No Cornerstone (lines 115-148), Identity (lines 94-112), Architecture
      (lines 174-206), or pre-existing Decision Log row is modified. The
      Decision Log is append-only by convention; the new row is appended at
      the end of the table, before the next section break.
- [ ] No `@decision DEC-BENCH-B4-V3-001` annotation is added to any source
      file (the dossier carries the annotation in its dossier markdown; the
      plan carries the pointer in the Decision Log; source files are not
      touched).

### Tests / build

- [ ] No tests are required (governance edit only). Reviewer / Guardian
      should not block on test runs.
- [ ] No build is required (no source / TS / config change).

### Forbidden shortcuts

- [ ] No `git push --force`, no history rewrite, no parallel "v0.5-bench-followup"
      initiative section, no Cornerstone / Identity / Architecture edits, no
      destructive cleanup of the existing Slice 2.6 narrative (only the three
      named status lines change; the design narrative stays intact).

### Ready-for-guardian

The reviewer may declare ready-for-guardian when:

1. All Required Artifacts checks pass.
2. All Decision Log Row Content checks pass (each verifiable via grep).
3. All Slice 2.6 Status Freshness checks pass.
4. All Scope Manifest Invariants pass (`git status` and `git diff --stat`
   confirm).
5. All Authority Invariants pass (the diff for `MASTER_PLAN.md` shows
   exactly: one row added to the Decision Log table, three text replacements
   in lines 1974 / 2005 / 2009, no other hunks).

## 6. Scope Manifest

### Allowed files / directories

- `MASTER_PLAN.md` (Decision Log row append + three status-line updates in
  the Slice 2.6 block)
- `plans/wi-dec-b4v3-001.md` (this plan file — new)
- `tmp/wi-dec-b4v3-001-*` and `tmp/wi-dec-b4v3-001-*/**` (planner / reviewer
  scratch space)

### Required files / directories

- `MASTER_PLAN.md` (the Decision Log row + status lines are the entire
  deliverable; no MASTER_PLAN edit = no governance authority captured)
- `plans/wi-dec-b4v3-001.md` (this file — without it, the planning record
  for the verdict is missing)

### Forbidden touch points

- `packages/**` (no source — this is a governance annotation, not a code
  change; the workflow contract forbids it)
- `bench/**` (the dossier already landed in `c2cddbf`; do not amend it from
  this slice — single-source-of-truth requires the dossier and the plan to
  point at each other, not duplicate)
- `docs/**`, `.github/**`, `.claude/**`, `scripts/**`, `examples/**`,
  `bootstrap/**` (workflow contract forbids — out of scope)
- Any line under MASTER_PLAN.md ## Identity (94-112), ## Cornerstone
  (115-148), ## Architecture (174-206), or any pre-existing Decision Log
  row. The Decision Log is append-only by convention.
- Any line of MASTER_PLAN.md outside the Slice 2.6 block (1972-2011) and
  the Decision Log table — the Decision Log row is appended at the end of
  the table; the Slice 2.6 block has three precise replacements; nothing
  else in the plan moves.

### State authorities touched

- **Decision Log authority** (MASTER_PLAN.md `## Decision Log` table) —
  append one row for `DEC-BENCH-B4-V3-001`. Single source of truth for
  cross-stage decisions; this row is the canonical plan-level pointer at the
  dossier.
- **Active Initiatives status authority** (MASTER_PLAN.md `## Active
  Initiatives` v0.5 Slice 2.6 block) — update three status lines to record
  closure. Sacred Practice #5: stale status is a future-implementer trap.

## 7. Hard constraints (recorded for the implementer / reviewer pass)

- The orchestrator dispatch prompt's "KILL" framing and its cell table are
  **not** to be propagated verbatim into MASTER_PLAN.md. The dossier is the
  authority; numbers and verdict prose must source from
  `bench/B4-tokens-v3/results/DEC-BENCH-B4-V3-001.md`. The Decision Log row
  uses the dossier's "not supported at this corpus shape" framing, not a
  flat KILL — this is the load-bearing distinction (KILL would prematurely
  rule out the hypothesis at corpus shapes that include task-scale atoms;
  the dossier explicitly leaves that door open via B4-v4).
- Planner authority is governance-only. No source. No test files. No
  bench files. No docs. The implementer for this WI is also planner-authored
  per cc-policy authority model — there is no source-implementer hand-off
  (the MASTER_PLAN edit IS the entire deliverable; the planner's
  `can_write_governance` capability covers it).
- Tests are not required (governance edit only). The Guardian preflight
  should treat test-state as not-applicable for this WI — there is no source
  surface for tests to run against.

## 8. Continuation

After this WI lands:

- `DEC-BENCH-B4-V3-001` is closed in the Decision Log; #653 is already
  closed; the dossier is preserved on main.
- B4-v4 (the redesigned-corpus matrix) is **not** automatically scheduled —
  it requires a separate planning pass to author the structural-apparatus
  changes (task-scale atom persistence; failure-boundary-calibrated task
  set). Tracked as a planning candidate to surface in the next
  benchmark-suite planner dispatch.
- The Slice 2.6 closure does not affect any other v0.5 slice or any
  benchmark slice (B1/B2/B5/B6/B7/B8/B9/B10) — those slices have their
  own DEC rows and statuses.

## 9. Decision summary (planner trailer prelude)

**Verdict on the planning question:** the deliverable is fully described by
the two MASTER_PLAN edits and this plan file. No alternatives gate fires
(there is exactly one right shape: a Decision Log row + a status
refresh; alternatives — "amend the dossier", "create a new initiative
section" — are forbidden by Sacred Practice #12). No research gate fires
(the dossier is the authority and is locally readable; nothing about the
B4-v3 verdict needs external research beyond the committed artifact).

The MASTER_PLAN edit is itself the implementer-stage work for this WI.
Planner authority covers it; no source-implementer hand-off is needed.
After planner writes the edits, the workflow moves directly to reviewer
(REVIEW_VERDICT against the Evaluation Contract in § 5) and then to
guardian:land (commit `MASTER_PLAN.md` + `plans/wi-dec-b4v3-001.md` on
`feature/dec-b4v3-001-kill`; PR or direct merge per established workflow
contract; close any tracking issue if one is referenced).
