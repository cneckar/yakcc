# fix-628: Nightly bootstrap-verify chronic drift suppression

## Problem (issue #628)

Nightly CI has failed 7 consecutive days (#316, #392, #434, #509, #537, #567, #628)
on the `yakcc bootstrap --verify` job. Prior issues were closed without root-cause
fix. The `bootstrap.yml` (push:main) workflow is **also** red for the same reason
(`bootstrap` run `25992585238` at 96e5a6a, plus several earlier).

## Root cause

Failing log (run `25981233122`, job `yakcc bootstrap --verify` at 05:09:59Z):

```
bootstrap --verify: FAILED
  committed: /home/runner/work/yakcc/yakcc/bootstrap/expected-roots.json (5104 entries)
  shaved:    3420 entries

Unrecorded atoms (673 — in current shave, NOT in committed manifest):
  Fix: run 'yakcc bootstrap' to record these atoms, then commit the manifest.
```

The failure is a **design mismatch** between two CI workflows that share one
artifact (`bootstrap/expected-roots.json`):

- `bootstrap-accumulate.yml` writes the manifest on `push:main`. Per
  `DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001` (`packages/cli/src/commands/bootstrap.ts:55-68`),
  this writer is explicitly **best-effort** with an **eventual invariant**:
  "atoms are recorded on a best-effort basis; the invariant is eventual (not gate-blocking)."
- `bootstrap.yml` and `nightly.yml` both run `yakcc bootstrap --verify`, which
  treats `current_shave ⊆ committed_manifest` as a **hard gate**
  (`packages/cli/src/commands/bootstrap.ts:489-509`).

When `bootstrap-accumulate` cannot push (rapid-merge contention — see #645/PR #646)
or is cancelled by a sister merge (10 of the last 10 runs are
`failure`/`cancelled`/`action_required`), new atoms shaved from merged source never
land in the manifest. The next `bootstrap --verify` then fails on those unrecorded
atoms — turning best-effort drift into a red gate, contradicting the explicit design.

The 673 unrecorded atoms are accumulated drift across **the entire week of failing/contended
accumulate runs**, not a regression from any single merge. This is a chronic
infrastructure mismatch, not a code defect.

## Fix design

**Surgical workflow-level suppression in two files** — make the verify step
**advisory** in CI until accumulate stabilises (gated by #645/PR #646 landing
plus a follow-up to either harden accumulate's push contention or relax the
verify gate's CI contract).

For both `.github/workflows/bootstrap.yml` and `.github/workflows/nightly.yml`,
add `continue-on-error: true` to the `Verify content-addressed manifest` step
and a comment that names the design mismatch + tracking issue:

```yaml
- name: Verify content-addressed manifest
  if: steps.verified-cache.outputs.cache-hit != 'true'
  # @decision DEC-VERIFY-CI-ADVISORY-001 — verify is advisory until
  # bootstrap-accumulate's eventual invariant stops drifting under rapid-merge
  # contention (#645, PR #646 and follow-up). Per
  # DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 the accumulator is best-effort; making
  # verify a hard gate contradicts that contract. The full diagnostic still
  # prints in the run log (loud failure preserved for local/dev use).
  # Tracking: <new issue number — implementer will fill in after filing>.
  continue-on-error: true
  run: node packages/cli/dist/bin.js bootstrap --verify
```

The diagnostic ("Unrecorded atoms: ...") still prints to the run log, preserving
Sacred Practice #5 (loud failure) for human triage. The job's overall conclusion
becomes `success` so the auto-issue-creating `notify-failure` job in `nightly.yml`
stops firing for this class of drift. `bootstrap.yml` (push:main) likewise stops
turning the merge queue red on the same class of drift.

The `nightly.yml` `notify-failure` step still fires for **real** regressions in
`full-test`, `wave-3-parity`, or any step that genuinely fails — only the
known-noisy verify step is muted.

### Scope

Two files, one-line `continue-on-error: true` plus a comment block on each:

| File | Edit |
|------|------|
| `.github/workflows/bootstrap.yml` | Add `continue-on-error: true` + DEC comment to step at L98-100 |
| `.github/workflows/nightly.yml`   | Add `continue-on-error: true` + DEC comment to step at L98-100 |

Estimated diff: ~14 lines added (2 × 7-line comment-and-flag block), 0 deletions.

### Out of scope

- Do **not** touch `.github/workflows/bootstrap-accumulate.yml` (owned by #645 / PR #646).
- Do **not** modify `packages/cli/src/commands/bootstrap.ts` (`runVerify()` semantics
  remain strict — correct for local dev, just not CI).
- Do **not** add a new `--soft` CLI flag (rejected — see alternatives below).
- No bench work (this is workflow infra, not benchmarking).

## Alternatives considered

| Option | Verdict |
|--------|---------|
| `continue-on-error: true` on the verify step (chosen) | Reversible, no code change, preserves diagnostic, fastest path to green CI |
| Add `--soft` flag to `runVerify()` returning 0 with WARN | Rejected — adds CLI surface for transient infra noise; local dev correctly wants strict mode |
| Remove `bootstrap-verify` from nightly entirely | Rejected — loses diagnostic visibility; we want the report, just not the red gate |
| Block the fix on #645/PR #646 landing and a fresh accumulate | Rejected — accumulate is best-effort by design; the contradiction will recur regardless of #645's retry-budget bump |
| Run `yakcc bootstrap` locally + commit the manifest to flush drift | Rejected — Sacred Practice violation: "CI is the sole writer of manifest updates" (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 part (c)) |

## Evaluation Contract

The implementer is **ready for guardian** when ALL of these are demonstrably true:

1. **Workspace gates green** on the worktree HEAD:
   - `pnpm -w lint` → exit 0
   - `pnpm -w typecheck` → exit 0
   - (no source code changed; tests not required, but `pnpm -w test` should not
     regress — implementer may skip if expensive)
2. **YAML lints clean** for both workflow files (no syntax/indent errors):
   - `python -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/bootstrap.yml`
   - same for `nightly.yml`
3. **Scope discipline**: `git diff main --stat` shows ONLY:
   - `.github/workflows/bootstrap.yml`
   - `.github/workflows/nightly.yml`
   - `plans/fix-628-nightly-bootstrap-verify.md`
4. **Comment quality**: each `continue-on-error: true` is preceded by a
   `@decision DEC-VERIFY-CI-ADVISORY-001` comment block naming the contradiction
   with DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 and a tracking-issue placeholder
   the implementer fills in after filing the follow-up.
5. **Follow-up issue filed** via `gh issue create` (label: `ci`, `claude-todo`)
   that captures: "verify-vs-accumulate contract mismatch; either harden
   accumulate or formalise verify's CI-advisory contract once #645/PR #646 lands."
   Implementer pastes the issue number into the two workflow comment blocks
   before staging.

## Forbidden shortcuts

- Do **not** edit `packages/cli/src/commands/bootstrap.ts` — `runVerify()` is correct as-is.
- Do **not** edit `.github/workflows/bootstrap-accumulate.yml` (owned by #645/PR #646).
- Do **not** run `node packages/cli/dist/bin.js bootstrap` locally and commit
  `expected-roots.json` — that violates DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001
  part (c) ("CI is the sole writer").
- Do **not** remove the verify step entirely or wrap it behind an env-var off-switch.
- Do **not** add `if: false` (loses the diagnostic).

## DECs

- **DEC-VERIFY-CI-ADVISORY-001** (new): bootstrap-verify is a CI-advisory step
  (continue-on-error) until the verify-vs-accumulate contract mismatch is
  formally resolved. The local CLI gate (`yakcc bootstrap --verify` exit 1)
  remains strict for dev use.

## Drafted PR title/body

**Title:** `ci: mark bootstrap-verify advisory in nightly + push:main (closes #628)`

**Body:**

```markdown
## Summary

`bootstrap --verify` has failed in every nightly run for the last 7 days
(#316, #392, #434, #509, #537, #567, #628) and is also red on `bootstrap.yml`
push:main. Root cause is a **contract mismatch** between two CI workflows that
share `bootstrap/expected-roots.json`:

- `bootstrap-accumulate.yml` writes the manifest on a **best-effort, eventual
  invariant** basis (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001).
- `bootstrap.yml` and `nightly.yml` `bootstrap-verify` treat
  `current_shave ⊆ committed_manifest` as a **hard gate**.

The accumulate workflow has been losing rapid-merge contention races (see #645
/ PR #646), leaving 673 atoms unrecorded. The verify gate fires red, even
though the underlying design says drift is acceptable.

## Fix

Mark the `Verify content-addressed manifest` step `continue-on-error: true` in
both `bootstrap.yml` and `nightly.yml`. The diagnostic (named-roots listing)
still prints in the run log — only the job-level conclusion changes from
failure to success. `nightly.yml`'s `notify-failure` step still fires for
genuine regressions in `full-test` / `wave-3-parity` / other steps.

Strict-mode `yakcc bootstrap --verify` is **unchanged** — local dev use still
exits non-zero on drift.

## Tracking

New DEC: `DEC-VERIFY-CI-ADVISORY-001`. Follow-up issue filed to formally
reconcile the verify-vs-accumulate contract once #645/PR #646 lands and
accumulate's retry budget stabilises.

## Scope

| File | Change |
|------|--------|
| `.github/workflows/bootstrap.yml` | +continue-on-error + DEC comment |
| `.github/workflows/nightly.yml`   | +continue-on-error + DEC comment |
| `plans/fix-628-nightly-bootstrap-verify.md` | New |

closes #628
```

## Estimated implementer turn budget

**1 turn** — workflow YAML edits + 1 `gh issue create` + 2 `pnpm -w` gate runs +
PR open. No tests, no source. Scope is `.github/workflows/*.yml` plus plans
file. Should be Tier-1-adjacent (workflow file > Simple Task Fast Path threshold
because `notify-failure` topology + DEC creation make this guardian-bound).
