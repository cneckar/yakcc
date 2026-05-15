# WI-542: Fix DEC ID drift in plans/wi-508-import-intercept-hook.md

Closes #542.

## Problem

`plans/wi-508-import-intercept-hook.md:284` references the decision id
`DEC-WI508-SHARED-IMPORT-CLASSIFIER-001`, but source (`packages/hooks-base/src/import-classifier.ts:2`,
`packages/hooks-base/src/import-intercept.ts:100`, `packages/compile/src/import-gate.ts:67`,
`packages/compile/src/import-gate.test.ts:108`, `packages/compile/vitest.config.ts:5`)
uses `DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001`. Per Code is Truth, source
wins. Plan must be updated.

## Scope

- One file: `plans/wi-508-import-intercept-hook.md`
- One string replacement: `DEC-WI508-SHARED-IMPORT-CLASSIFIER-001` →
  `DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001`
- Verified single occurrence at line 284 (the Decision Log row).
- No source files touched.

## Evaluation Contract

- Required tests: none beyond the post-edit grep.
- Required evidence:
  - `git grep -n "DEC-WI508-SHARED-IMPORT-CLASSIFIER-001" plans/wi-508-import-intercept-hook.md`
    returns empty (no stale id remains).
  - `git grep -n "DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001" plans/wi-508-import-intercept-hook.md`
    returns at least one hit (replacement landed in the Decision Log row).
  - `git diff` shows only `plans/wi-508-import-intercept-hook.md` and this plan
    file changed; no other paths.
- Forbidden shortcuts: editing source DEC ids to match the plan; touching any
  path in `packages/**`, `src/**`, or `.claude/**`.
- Ready-for-guardian definition: stale DEC id removed; target DEC id present;
  no other lines changed; reviewer verdict `ready_for_guardian` on current HEAD;
  PR opened with `Closes #542`.

## Scope Manifest

- Allowed: `plans/wi-508-import-intercept-hook.md`, `plans/wi-542-dec-id-drift.md`
- Required: `plans/wi-508-import-intercept-hook.md`
- Forbidden: `packages/**`, `src/**`, `.claude/**`
- Authority domains touched: none.
