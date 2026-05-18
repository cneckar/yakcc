# WI-637: csv-row-narrow arm-a tab handling bug

**Issue:** #637
**Workflow:** `fix-637-csv-tab-bug`
**Branch:** `feature/637-csv-tab-bug`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-637-csv-tab-bug`
**Tier:** 1 (Brief) — 3 files, 1 line each, root cause already verified pre-plan

## Problem

B9 csv-row-narrow axis3 (semantic equivalence) returns `equivalence_rate = 88%` instead of 100%. Arm-a granularity variants accept tab characters where spec.yak and arm-b reject them.

## Root Cause (verified)

Three arm-a files contain a tab-exception carve-out that violates the spec:

| File | Line | Bad code |
|---|---|---|
| `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/fine.mjs` | 14 | `if (code < 32 && code !== 9) throw new SyntaxError(...)` |
| `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/medium.mjs` | 8 | `if (code < 32 && code !== 9) throw new SyntaxError(...)` |
| `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/coarse.mjs` | 8 | `if (code < 32 && code !== 9) throw new SyntaxError(...)` |

**Spec (`spec.yak` line 39-41):**
> "Input contains control characters (code < 32)." → `SyntaxError`

No tab exception. The spec is unambiguous: every character with `code < 32` (including tab/0x09) must throw `SyntaxError`.

**Arm-B reference (`fixtures/csv-row-narrow/arm-b-response.json`):** uses `if (code < 32)` with no exception — matches spec exactly.

When fast-check (axis3) generates a string containing `\t`, arm-a's `controlCharRejector` skips it and returns trimmed fields; arm-b correctly throws `SyntaxError`. Outputs diverge → `equivalence_rate` drops to 88%.

## Authority Map

- **Spec authority:** `bench/B9-min-surface/tasks/csv-row-narrow/spec.yak` (read-only this slice — forbidden by scope)
- **Reference impl:** `bench/B9-min-surface/fixtures/csv-row-narrow/arm-b-response.json` (read-only — forbidden by scope)
- **Subject (this slice):** `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/{fine,medium,coarse}.mjs`
- **Measurement:** `bench/B9-min-surface/harness/measure-axis3.mjs` (read-only — forbidden by scope)

The arm-a files must conform to spec.yak + arm-b. They are the wrong side of the divergence. The bug is in arm-a, not in the spec or the harness.

## Fix

Three identical one-line edits — remove the `&& code !== 9` carve-out:

```diff
- if (code < 32 && code !== 9) throw new SyntaxError(...)
+ if (code < 32) throw new SyntaxError(...)
```

Apply to:
1. `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/fine.mjs` line 14 (inside `controlCharRejector`)
2. `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/medium.mjs` line 8 (inside `validateInputCharacters`)
3. `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/coarse.mjs` line 8 (inline in `parseCsvRowNarrow`)

## Decision Log

**DEC-WI-637-001 — Reject tab in arm-a control-character check.**
Rationale: spec.yak says "code < 32 → SyntaxError" with no exception. Arm-b reference rejects all `code < 32`. The `&& code !== 9` exception in arm-a was incorrect (likely a copy-paste of a generic "whitespace-allowing" pattern from another task). The spec authority and arm-b implementation authority both say "no exception," so arm-a aligns with them. Alternative (changing spec or arm-b to allow tab) was rejected because it would be modifying the authority to fit the bug, not fixing the bug.

Suggested `@decision` annotation in each arm-a file:
```
// @decision DEC-WI-637-001: Reject all control chars (code < 32) including tab,
// per spec.yak ("Input contains control characters (code < 32)") and arm-b reference.
```

## Evaluation Contract

**Required tests:**
- All 3 arm-a files contain `if (code < 32)` with NO `&& code !== 9` clause
- axis3 measure on csv-row-narrow returns `equivalence_rate = 1.0` (100%) post-fix
- No other B9 task regresses

**Required evidence:**
- Diff scoped to exactly these 4 files (3 arm-a .mjs + this plan)
- Spec quote preserved in plan (`code < 32 → SyntaxError`)
- This plan committed alongside the fix

**Required real-path checks:**
- All 3 arm-a files exist and are syntactically valid JS
- `bench/B9-min-surface/tasks/csv-row-narrow/spec.yak` exists and is unmodified
- `bench/B9-min-surface/fixtures/csv-row-narrow/arm-b-response.json` exists and is unmodified

**Required authority invariants:**
- `spec.yak` NOT modified (forbidden by scope)
- `arm-b-response.json` NOT modified (forbidden by scope)
- No other B9 task touched
- No source under `packages/**` touched
- No harness, fixture, or attack-class file touched

**Required integration points:**
- axis3 `equivalence_rate` jumps from 0.88 to 1.00 — the bug's measurable signature
  - Verification path: `node bench/B9-min-surface/harness/measure-axis3.mjs` (or whichever invocation the harness supports for a single task)
  - If harness JSON-loading is broken on this environment, file a follow-up issue for the harness rather than skipping verification silently

**Forbidden shortcuts:**
- Do NOT modify `spec.yak` to allow tab (would be modifying spec to fit bug — wrong direction)
- Do NOT modify `arm-b-response.json` (read-only reference, forbidden by scope)
- Do NOT add a "tab is whitespace" carve-out anywhere else in the codebase
- Do NOT touch harness/fixtures/attack-classes (forbidden by scope)

**Rollback boundary:** Single commit; `git revert <sha>` restores the pre-fix state cleanly.

**Ready for guardian when:**
- 3-line fix applied across the 3 arm-a files
- `plans/wi-637-csv-tab-bug.md` committed
- Reviewer verdict `READY_FOR_GUARDIAN`
- PR opened with `Closes #637`

## Scope Manifest

**Allowed paths:**
- `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/fine.mjs`
- `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/medium.mjs`
- `bench/B9-min-surface/tasks/csv-row-narrow/arm-a/coarse.mjs`
- `plans/wi-637-csv-tab-bug.md`
- `tmp/wi-637-*` (any temp workspace)

**Required paths:**
- `plans/wi-637-csv-tab-bug.md`
- All 3 arm-a files above

**Forbidden paths:**
- `packages/**`
- All other `bench/*` axes (B1, B4, B5, B6, B7, B8, B10, v0-release-smoke)
- `bench/B9-min-surface/tasks/csv-row-narrow/spec.yak`
- `bench/B9-min-surface/fixtures/**`
- `bench/B9-min-surface/harness/**`
- `bench/B9-min-surface/test/**`
- `bench/B9-min-surface/attack-classes/**`
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `docs/**`, `scripts/**`

**Authority domains touched:**
- `csv-row-narrow-controlchar-rejector` (the arm-a control-character validation behavior)

## Wave / Work Items

Single work item (`wi-637-csv-tab`) — no decomposition needed. Tier 1.

## Continuation

After landing: close #637. No follow-up planned unless axis3 reveals additional divergences in other csv-row-narrow input classes.
