# WI-612 — Drop `cancel-in-progress` on `closer-parity-as.yml`

Closes: #612
Workflow ID: `fix-612-cancel-in-progress-drop`
Decision: `DEC-CI-CLOSER-PARITY-AS-NO-CANCEL-001`

## Problem

`.github/workflows/closer-parity-as.yml` declares:

```yaml
concurrency:
  group: closer-parity-as-${{ github.ref }}
  cancel-in-progress: true
```

After WI-485 / WI-575 split closer-parity-as to `push:main + workflow_dispatch`
(removing `pull_request`), the workflow's only natural trigger on a busy
`main` branch is rapid-fire merge commits. Each new merge cancels any
in-flight run before it can complete. Observed 2026-05-16: 5 consecutive
cancellations during a heavy merge session; one run was killed at the 42-min
mark — past the expensive `pnpm -r build` + asc compile stages but before the
verified-marker cache write that would let subsequent runs short-circuit via
the input-hash cache.

The cancel behavior was inherited from PR-style workflows (where canceling
superseded commits is correct: a newer push to the same PR makes the older
SHA obsolete). On `push:main` the older SHA is *not* obsolete — every commit
on main is a permanent record state, and the verified-marker cache is keyed
on the input hash of source files, so a completed run on commit N is still
useful even if commit N+1 has already landed.

## Fix

Change line 29 of `.github/workflows/closer-parity-as.yml`:

```diff
 concurrency:
   group: closer-parity-as-${{ github.ref }}
-  cancel-in-progress: true
+  cancel-in-progress: false
```

Keep the concurrency group declaration intact — it's still useful for UI
grouping and prevents misinterpretation as "no concurrency policy". The
explicit `false` documents the intent (DEC-CI-CLOSER-PARITY-AS-NO-CANCEL-001)
better than removing the key entirely.

Add a one-line `@decision` annotation referencing
`DEC-CI-CLOSER-PARITY-AS-NO-CANCEL-001` and #612 immediately above or
adjacent to the concurrency block so future implementers see the rationale
in-place.

## Rationale (DEC-CI-CLOSER-PARITY-AS-NO-CANCEL-001)

- `push:main` trigger means every commit is a permanent state worth verifying;
  newer commits do not invalidate older ones the way new PR pushes do.
- The verified-marker cache (DEC-AS-COMPILE-CACHE-001 / #531) is keyed by
  source-file input hash — a completed run on any commit N populates the cache
  for any later commit N+k that has the same input hash, making completion
  more valuable than the speed of newer-commit feedback.
- Sibling reference: `.github/workflows/pr-ci-test-advisory.yml`
  (DEC-CI-TEST-ADVISORY-SEPARATE-WORKFLOW-001) — long-running advisory
  workflow with no top-level concurrency cancel; same intent class.
- `wave-3-parity.yml` retains `cancel-in-progress: true` for now; that's a
  separate workflow with different perf characteristics and is explicitly out
  of scope for #612 (and explicitly forbidden by the workflow scope manifest).

## Non-goals

- Not touching `wave-3-parity.yml` (out of scope; separate evaluation needed).
- Not touching `pr-ci.yml` (PR-time cancel is correct).
- Not changing the concurrency group key.
- Not changing the 60-min `timeout-minutes` (DEC-AS-CLOSER-PARITY-CONCURRENCY-001).
- Not changing trigger surface (`push:main` + `workflow_dispatch` per
  DEC-CI-MERGE-GATE-ENFORCE-001).

## Acceptance

- Diff is scoped to `.github/workflows/closer-parity-as.yml` (one-line value
  change + one-line `@decision` annotation) plus this plan file.
- `cancel-in-progress: false` (or key removed) in the diff.
- Concurrency `group:` key unchanged: `closer-parity-as-${{ github.ref }}`.
- `timeout-minutes: 60` preserved.
- No other workflow files touched.
- No source code, bench, docs, scripts touched.
- Reviewer verdict `ready_for_guardian`.
- PR opened with `Closes #612`.

## Post-land verification (observational, not pre-merge testable)

After landing, the next `push:main` event triggering closer-parity-as should
complete uninterrupted even if subsequent merges land during its 40+min run.
The verified-marker cache will then populate, making the *following* run
short-circuit via cache-hit. This cannot be asserted pre-merge — it's a
behavioral observation against the live `main` branch.

## Rollback boundary

Single-commit `git revert` restores `cancel-in-progress: true` (the current
observed-broken state). Trivial and safe.

## References

- #612 — issue body specifies the exact fix
- #531 — verified-marker cache (DEC-AS-COMPILE-CACHE-001)
- #485 — closer-parity-as lane established
- #575 — test-advisory split (mirror of long-running advisory pattern)
- DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001 — existing workflow rationale
- DEC-CI-TEST-ADVISORY-SEPARATE-WORKFLOW-001 — sibling no-cancel pattern
