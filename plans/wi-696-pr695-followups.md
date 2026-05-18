# WI-696 — PR #695 reviewer follow-ups (4 findings)

- **Workflow ID:** `696-pr695-followups`
- **Goal ID:** `g-696-pr695-followups`
- **Implementer work item:** `696-pr695-followups-impl`
- **Branch:** `feature/696-pr695-followups`
- **Worktree:** `c:/src/yakcc/.worktrees/feature-696-pr695-followups`
- **Ticket:** [#696](https://github.com/cneckar/yakcc/issues/696)
- **PR closed by predecessor:** [#695](https://github.com/cneckar/yakcc/pull/695) (closed #666)
- **Predecessor plan:** [`plans/wi-fix-666-private-class-fields.md`](./wi-fix-666-private-class-fields.md)
- **Initiative:** shave-engine-cleanup
- **Complexity tier:** Tier 2 (Standard) — small scope (~2 files), but touches governance surfaces (DEC consequences, MASTER_PLAN.md) and is guardian-bound.

## 1. Problem statement

PR #695 fixed the shave engine's `decompose()` so it no longer stubs on
ArrowFunction expression bodies (lru-cache-11.3.6/dist/esm/index.js now
decomposes cleanly: moduleCount=3, stubCount=0, leafCount=433). The reviewer
surfaced 4 non-blocking findings that the implementer agreed to track but
didn't file. Issue #696 captures them. Without this WI:

- **F1** leaves §F's quality gate underspecified — when the local embedding
  provider eventually runs in CI, the asserted bar (`plans.length > 0`) is
  weaker than the documented gate (`combinedScore >= 0.70`), so a regression
  in atom-quality could land silently.
- **F2** leaves DEC-FLIP-001's consequences field empty, so future
  archaeology against the DEC can't see what Slice 10 graduated from / into.
- **F3** leaves §F's describe/it comment block claiming "engine-gap stub
  state" that no longer exists; that misleads future implementers reading
  the test.
- **F4** leaves MASTER_PLAN.md without a record that the v0.7 closure ran
  into a private-class-field engine-gap (#666), how it was discovered
  (lru-cache-11.3.6 stubbing), and how it was closed (#695 +
  DEC-SHAVE-PRIVATE-CLASS-FIELD-001). The plan §4 template assigned the row
  to planner; this WI fulfils that obligation.

These are all "the work was done, the documentation/record wasn't tightened
to match." None of them ship runtime risk *today* — F1 is gated by
`DISCOVERY_EVAL_PROVIDER=local` which CI does not set; F2/F3 are textual;
F4 is the project-history record. All four become real cost the next time
someone tries to audit, extend, or regress-test this surface.

## 2. Architecture / state-authority map

No new authorities. This WI touches only:

- **Test file authority:** `packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` — already owns the §A-§F + Compound Slice 10 assertions; F1/F2/F3 tighten its existing contents.
- **Plan history authority:** `MASTER_PLAN.md` "v0.7 closure note" block (lines ~1176-1188 in current worktree HEAD) — F4 adds a single row describing the engine-gap WI that wasn't enumerated when v0.7 closed.

**No engine change.** `recursion.ts` and the rest of the decomposer surface
are out of scope (already shipped under #695). Modifying them here would
extend the WI past its boundary and would re-open #666's review.

**No DEC creation.** F2 *amends* DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001
(adds a missing field) but does not change its semantics. The amendment
restores the field that the original plan §3.3 template (lines 158-160 of
`plans/wi-fix-666-private-class-fields.md`) already prescribed verbatim, so
no new design decision is being made.

**No new MASTER_PLAN.md initiative or DEC.** F4 is a single ledger row
appended under the existing v0.7 closure note. It does not amend permanent
sections (Identity / Architecture / Principles / Decision Log).

## 3. Wave decomposition

One work item, one implementer dispatch, sequenced commits or single commit
at the implementer's discretion.

| WI | Title | Weight | Gate | Deps | Integration | Landing policy |
|---|---|---|---|---|---|---|
| 696-pr695-followups-impl | Address 4 reviewer follow-ups (F1-F4) from PR #695 | S | review | — | `lru-cache-headline-bindings.test.ts` + `MASTER_PLAN.md` v0.7 closure note | PR-based landing per memory `feedback_pr_not_guardian_merge.md`; no Guardian merge to main; auto-land permitted once reviewer issues `ready_for_guardian` |

**Critical path:** linear, single slice. No parallelism.

## 4. Evaluation Contract (implementer + reviewer share)

### required_tests
- §F under `DISCOVERY_EVAL_PROVIDER=local` asserts `forest.combinedScore >= 0.70` (the canonical gate from DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001). The implementer must call `forest.combinedScore` (or whichever field the local-provider path produces — verify against the existing §F local-eval branch) rather than the current weaker `plans.length > 0`. The existing `it.skipIf(!USE_LOCAL_PROVIDER)` envelope MUST be preserved — CI continues to skip §F because CI does not set the env var.
- `pnpm -F @yakcc/shave vitest run src/universalize/lru-cache-headline-bindings.test.ts` — Sections A-E and Compound continue to PASS post-fix (decomposed state); §F continues to skipIf-skip in CI (acceptable per plan §7 of the predecessor plan).
- The grep test `rg "DEFERRED due to engine-gap" packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` returns 0 hits.
- The grep test `rg "consequences:" packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` returns at least 1 hit inside the DEC-FLIP-001 block (line ~162).

### required_evidence
- Reviewer attaches the §F local-provider assertion diff (before/after) showing the `combinedScore >= 0.70` line.
- Reviewer attaches the DEC-FLIP-001 block diff showing the `consequences:` field with both bullets present per plan §3.3 template lines 158-160.
- Reviewer attaches the §F comment block diff showing "DEFERRED due to engine-gap stub state" framing replaced with post-fix framing.
- Reviewer attaches the MASTER_PLAN.md diff showing the new engine-gap WI row under the v0.7 closure note.

### required_real_path_checks
- `pnpm -w lint` — green across full workspace (NEVER `--filter <pkg>` per memory `feedback_eval_contract_match_ci_checks.md`).
- `pnpm -w typecheck` — green across full workspace.
- `pnpm -w build` — green across full workspace.
- `pnpm -F @yakcc/shave vitest run src/universalize/lru-cache-headline-bindings.test.ts` — green (the directly-touched test file).
- `pnpm -F @yakcc/shave test` — core shave engine suite green (regression net; should be 163/163 per #695's test plan).

### required_authority_invariants
- `recursion.ts` and the decomposer surface are NOT modified. The engine fix from #695 (DEC-SHAVE-PRIVATE-CLASS-FIELD-001) is the only authority over private-class-field/arrow-body descent; nothing in this WI shifts that.
- DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001 remains the canonical authority for the `>= 0.70` quality gate. F1's assertion change is *aligning to* that DEC, not redefining it.
- DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001 remains the canonical authority for the Slice 10 "flip from engine-gap-honest to post-#666 decomposed" framing. F2's `consequences:` addition is a missing-field restoration per the predecessor plan §3.3 template, not a semantic change.
- DEC headers in the file (`DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001`, `DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002`) MUST be preserved as historical record per the predecessor plan §3.3 closing note.

### required_integration_points
- No callers consume this test file outside the `@yakcc/shave` package vitest run.
- MASTER_PLAN.md's "Active Initiatives → v0.7 sub-function decomposition" section reads the v0.7 closure note; the new row is appended to that note's existing ledger format.

### forbidden_shortcuts
- Do NOT modify `packages/shave/src/universalize/recursion.ts` or any other engine surface. The fix is shipped under #695.
- Do NOT swap §F to `it.skip` or `it.skipIf(true)` to dodge the local-provider branch — the `it.skipIf(!USE_LOCAL_PROVIDER)` envelope is the canonical CI-skip path and stays.
- Do NOT remove or relabel any existing `@decision` DEC header in the file. Add the `consequences:` field to DEC-FLIP-001 in place; preserve everything else.
- Do NOT widen the WI scope to other Slice 10 test files (e.g. `private-class-field-walk.test.ts`) — those are out of scope and already covered by #695's regression net.
- Do NOT skip the full-workspace gates by running `--filter <pkg>` for lint/typecheck (memory `feedback_eval_contract_match_ci_checks.md`).
- Do NOT request Guardian merge to main. Land via PR with `closes #696` (memory `feedback_pr_not_guardian_merge.md`).
- Do NOT open the PR without first running `git fetch origin && git pull --ff-only origin main` inside the worktree (memory `feedback_fetch_before_pr.md`).

### rollback_boundary
- Per-file revert is clean: `lru-cache-headline-bindings.test.ts` and `MASTER_PLAN.md` are independently revertable. F1 alone, F2 alone, F3 alone, F4 alone — each is a localized text edit. No schema or runtime state to migrate; no dependency on this WI from any other in-flight WI.

### acceptance_notes
- The four findings have prescribed mechanical fixes; no design choices remain. F2's `consequences:` bullets are dictated verbatim by predecessor plan §3.3 template lines 158-160:
  - `- Slice 10 acceptance graduates from engine-reality-honest (PR #663) to fully-decomposed`
  - `- Combined-score fixed floor 0.70 (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001) now binding`
- F4 row format mirrors existing rows in the v0.7 closure note (a single bullet citing the WI number, PR, and DEC).

### ready_for_guardian_definition
- All 4 findings addressed per their evaluation criteria above.
- All 5 `required_real_path_checks` green at HEAD.
- Reviewer issues `REVIEW_VERDICT: ready_for_guardian` against the implementer's pushed head SHA.
- PR exists with `closes #696` in the body and links to this plan; no dispatch of Guardian to merge into main.

## 5. Scope Manifest (mirror in `tmp/scope-696-pr695-followups.json`)

### allowed_paths
- `packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` — F1, F2, F3.
- `MASTER_PLAN.md` — F4 only (v0.7 closure note row append).
- `plans/wi-696-pr695-followups.md` — this plan, owned by planner.

### required_paths
- `packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` — required for F1+F2+F3.
- `MASTER_PLAN.md` — required for F4.

### forbidden_paths
- All other `packages/**` — engine, contracts, registry, compile, seeds, IR, hooks, CLI, variance, federation: all out of scope.
- `bench/**` — not within this WI.
- `examples/**`, `scripts/**`, `tools/**`, `bootstrap/**`, `docs/**`, `patches/**`, `.github/**`, `.claude/**` — not within this WI.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `turbo.json`, `biome.json` — root configs untouched.
- All other `plans/**` files — predecessor plan `wi-fix-666-private-class-fields.md` is sealed.

### state_domains
- `shave_decomposer_ast` (read-only — this WI does NOT modify engine behavior; F1's assertion reads the post-fix decomposed-state output that #695 produced).
- `master_plan_ledger` (append-only — F4 appends one row to v0.7 closure note).
- `slice10_dec_ledger` (in-place text amendment — F2 fills a missing field in an accepted DEC; DEC semantics unchanged).

### authority_domains
*(none — this WI does not create or shift any control-plane authority)*

## 6. Decision Log

No new design decisions. The only DEC-shaped change is F2 (adding the
`consequences:` field that was specified in the predecessor plan §3.3
template but omitted from the landed DEC). This is a field-completeness
restoration, not a new decision.

| DEC-ID | Where | Rationale |
|---|---|---|
| *(none for this WI)* | | F1/F3 are assertion/comment tightening to match the engine-fix state; F2 restores a field the original plan already prescribed; F4 is a record-keeping append. |

## 7. Standing rules referenced

- `memory/feedback_eval_contract_match_ci_checks.md` — full-workspace lint/typecheck only.
- `memory/feedback_pr_not_guardian_merge.md` — land via PR, not Guardian-merge.
- `memory/feedback_fetch_before_pr.md` — `git fetch origin && git pull --ff-only origin main` before `gh pr create`.
- `memory/feedback_no_cross_package_imports.md` — N/A (no new imports added).
- Sacred Practice #2 — no source edits on main; all work in the worktree.

## 8. Quality Gate (planner self-check)

- All four findings have prescribed acceptance criteria with greppable / runnable verification.
- Scope Manifest names every touched file and explicitly forbids the engine surface.
- Evaluation Contract names full-workspace gates, not package-scoped shortcuts.
- DEC-FLIP-001 `consequences:` content is fully specified in `acceptance_notes` so the implementer has no design freedom on the textual content.
- No new authorities, no new DECs, no design choices remain.

## 9. Next action

PLAN_VERDICT: next_work_item — Guardian provision for `696-pr695-followups-impl`.
