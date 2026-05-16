# wi-nightly-timeouts-v2: Nightly test timeout stopgap

## Problem

5 nightly test failures (all timeout-class) observed in CI run:
https://github.com/cneckar/yakcc/actions/runs/25952447737

Affected tests:

| File | Test | Old timeout | New timeout |
|------|------|-------------|-------------|
| `module-graph.test.ts` | two passes over ms produce byte-identical forest structure | 30 000 ms | 90 000 ms |
| `validator-headline-bindings.test.ts` | section A -- moduleCount in [7,12] for isEmail subgraph | 120 000 ms | 300 000 ms |
| `validator-headline-bindings.test.ts` | section D -- two-pass byte-identical determinism for isEmail subgraph | 120 000 ms | 300 000 ms |
| `validator-headline-bindings.test.ts` | section D -- two-pass byte-identical determinism for isURL subgraph | 120 000 ms | 300 000 ms |
| `validator-headline-bindings.test.ts` | all four per-entry shaves are independent, complete, and produce non-empty forests | 120 000 ms | 300 000 ms |

Note: The compound interaction test (5th row) was already bumped to 300 000 ms in commit `5d8bde1`
(WI-510 Slice 4) before this work item landed; only 4 edits were applied here.

## Fix

Per-test `{ timeout: N }` overrides in the two affected test files. No global
config change — see "Why not vitest.config.ts" below.

## Why NOT vitest.config.ts

Issue #541 tracks the anti-pattern of using `hookTimeout` / global timeout
config in `vitest.config.ts` as a blunt instrument. Global bumps hide slow
tests indiscriminately and mask real regressions. Per-test overrides are
surgical: they document exactly which tests are slow and why, and leave the
global timeout as a canary for newly-introduced slowness.

`vitest.config.ts` is explicitly **forbidden** in the scope of this work item.

## Why v2

v1 (`wi-nightly-test-timeouts`) hit a policy catch-22:
- Guardian landing was denied because `evaluation_state` was pinned to an old
  SHA after the implementer amended rather than created a fresh commit.
- The implementer lease blocked `can_land_git` by design.

v2 starts fresh from `origin/main` HEAD (`5d8bde1`) on a clean branch
`feature/nightly-timeouts-v2`, avoiding the merge-chain dead end.

## Structural fix tracker

Issue #541 tracks the proper long-term fix: reducing the shave engine's
per-call latency so these tests no longer need generous timeouts to pass
reliably on cold CI runners.

## Acceptance criteria

- All 5 affected tests pass under their new budgets (4 edits applied; 1 was
  pre-existing in current HEAD)
- `vitest.config.ts` is NOT modified
- No assertions weakened; no `it.skip` / `it.todo` introduced
- Nightly CI clears the 5 timeout failures from run #25952447737
- `git diff --stat origin/main..HEAD` shows exactly 3 files: the 2 test files
  plus this plan doc

## Rollback

```
git revert <landing-commit>
```
