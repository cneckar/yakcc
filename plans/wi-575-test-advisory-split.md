# WI-575: Split test-advisory into own workflow

## Problem

`pr-ci.yml` uses `cancel-in-progress: true` scoped to `github.ref`. This is
the right behavior for the fast-check jobs (lint, typecheck, build, airgap) —
we only care about the latest commit, so cancelling stale runs saves minutes
and credits.

However the `test-advisory` job takes up to 20 minutes. Every new commit push
to the PR branch cancels the running job before it can complete. PRs #562,
#566, #570, and #571 all hit this: the advisory test was killed mid-run,
surface no result, and in the case of PR #570 merged with incorrect assertions
because vitest never reached the assertion phase.

## Fix: Path (c) — Separate workflow file

Move `test-advisory` into `.github/workflows/pr-ci-test-advisory.yml` with:
- Same `pull_request: branches: [main]` trigger (fires on every PR commit)
- **No `concurrency` block** — GitHub queues runs naturally; the latest run
  wins, but earlier ones are NOT cancelled. The 20-min job completes.
- `continue-on-error: true` preserved at the job level (remains advisory,
  per DEC-CI-MERGE-GATE-ENFORCE-001)
- All steps byte-for-byte identical to the original pr-ci.yml job
- `fetch-depth: 0` preserved so `scripts/affected-packages.sh` can resolve
  the PR base ref

The original `test-advisory` job stanza in `pr-ci.yml` is replaced with a
stub comment pointing to the new file.

Decision: `DEC-CI-TEST-ADVISORY-SEPARATE-WORKFLOW-001` (recorded in the new
workflow file header).

## Why not path (a) — make test required

Making the test job a branch-protection required check would force the full
20-minute run before merge. This is out of scope for this work item: it
requires admin branch-protection changes (out-of-session), changes the
operator-mandated non-gating policy (DEC-CI-MERGE-GATE-ENFORCE-001), and
defeats the "fast PR gate" architecture goal (DEC-CI-FAST-PATH-PHASE-1-001).

## Why not path (b) — reorder jobs

The jobs in pr-ci.yml run in parallel — there is no serial dependency that
would let "reordering" help. `cancel-in-progress: true` on the same `group`
kills all in-progress runs of the workflow, regardless of job order. Reordering
cannot escape cancel-in-progress semantics.

## Acceptance criteria

1. `.github/workflows/pr-ci-test-advisory.yml` is present and parses as valid
   YAML.
2. New workflow uses `pull_request` trigger matching pr-ci.yml but has NO
   `cancel-in-progress` (and no `concurrency` block at all).
3. `test-advisory` job is removed from `pr-ci.yml`; stub comment remains.
4. New workflow retains `continue-on-error: true` (advisory, non-gating).
5. `scripts/affected-packages.sh` is used identically in the new workflow.
6. `fetch-depth: 0` preserved in checkout step.

Post-merge verification: on the next PR push, the new `pr-ci-test-advisory`
workflow should appear in the GitHub Actions tab and run to completion even if
`pr-ci` is cancelled by a subsequent push.

## Out of scope

- Branch protection changes (requires admin session)
- Removing `continue-on-error` or making test gating
- Test runtime optimization
- Changes to any other workflow file
