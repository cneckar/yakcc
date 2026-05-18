# WI-651: Formalize verify as permanently advisory (#651 Option B)

## Identity
- Workflow: `fix-651-verify-advisory-permanent`
- Goal: `g-651-verify-b`
- Work item: `wi-651-verify-b`
- Branch / worktree: `feature/651-verify-advisory-permanent` @ `/Users/cris/src/yakcc/.worktrees/feature-651-verify-advisory-permanent`
- Closes: #651 (cancel root cause tracked separately in #686)

## Operator decision (2026-05-17)
Option B: formalize verify as **permanently** advisory. The framing "interim
until bootstrap-accumulate stabilizes" was empirically false — the 80%
cancellation rate on `bootstrap-accumulate` (#686) means there is no realistic
near-term world where verify becomes a hard CI gate. The
DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 contract is explicitly eventual /
best-effort; making verify a hard gate has always contradicted that. We are
aligning the documentation with that runtime reality, not changing behavior.
`continue-on-error: true` stays. Local pre-commit / pre-push hooks remain the
strict-invariant authority where authors can resolve drift inline.

## Scope (matches workflow Scope Manifest)
Allowed:
- `.github/workflows/nightly.yml`
- `.github/workflows/bootstrap.yml`
- `.github/workflows/bootstrap-accumulate.yml`
- `plans/wi-651-verify-advisory-permanent.md`
- `tmp/wi-651-*`

Required:
- `plans/wi-651-verify-advisory-permanent.md`

Forbidden (sample — full list in workflow manifest):
- `packages/**`
- All other `.github/workflows/*.yml` (pr-ci, closer-parity-as, wave-3-parity, bench-b*, …)
- `.github/actions/**`, `.claude/**`, `MASTER_PLAN.md`, `bench/**`, `docs/**`, `scripts/**`

## Diff sketch

### `.github/workflows/nightly.yml` (lines 100–107)
Replace the existing DEC-VERIFY-CI-ADVISORY-001 comment block with the
permanent-advisory framing. `continue-on-error: true` and the `run:` line on
108 are **unchanged**.

From:
```yaml
        # @decision DEC-VERIFY-CI-ADVISORY-001 — verify is advisory until
        # bootstrap-accumulate's eventual invariant stops drifting under
        # rapid-merge contention (#645, PR #646 and follow-up #651). Per
        # DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 the accumulator is best-effort;
        # making verify a hard gate contradicts that contract. The full
        # diagnostic still prints in the run log (loud failure preserved for
        # local/dev use). Tracking: #651 (reconciliation).
        continue-on-error: true
```
To:
```yaml
        # @decision DEC-VERIFY-CI-ADVISORY-001 — verify is PERMANENTLY advisory
        # per #651 Option B (operator decision 2026-05-17). This aligns with
        # DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001's eventual-invariant /
        # best-effort contract: making verify a hard CI gate would contradict
        # that contract. CI verify failures print the full diagnostic (loud
        # failure preserved in the run log) but do NOT block merges. The
        # strict invariant is enforced by local pre-commit / pre-push hooks
        # where authors can resolve drift inline. Empirical basis: ~80% of
        # bootstrap-accumulate runs are cancelled by sister activity, so no
        # retry-budget tuning alone can close the gap (cancellation root cause
        # tracked in #686). This is not interim — do not flip continue-on-error
        # to false without superseding this DEC.
        continue-on-error: true
```

### `.github/workflows/bootstrap.yml` (lines 100–107)
Identical block, identical replacement. Same `continue-on-error: true`
unchanged. Same one-paragraph rewrite — keep the two files byte-identical in
this block so future audits remain trivial.

### `.github/workflows/bootstrap-accumulate.yml` (header comment, lines 1–19)
Append a one-line cross-reference to the existing header block so the
eventual-invariant contract is explicitly named as canonical (not transitional)
and is paired with the new permanent-advisory framing on the verify side.
Insert after line 19 (before the blank line and `name:` on line 21):
```yaml
# Cross-reference: per #651 Option B (operator decision 2026-05-17) the
# verify step in nightly.yml and bootstrap.yml is PERMANENTLY advisory
# (DEC-VERIFY-CI-ADVISORY-001). The accumulator's eventual-invariant /
# best-effort contract above is the canonical contract, not an interim
# state awaiting promotion to a hard gate.
```
Nothing else in this file changes. `concurrency:` block, `timeout-minutes`,
`cancel-in-progress: false`, all step-level `continue-on-error` values, and
all push-gate logic are **unchanged**.

## Behavior contract
Pure documentation alignment. Zero CI behavior change. Verifiable by:
- Diff scoped to the 4 allowed paths only.
- `grep -n 'continue-on-error' .github/workflows/nightly.yml bootstrap.yml bootstrap-accumulate.yml` returns identical values pre/post.
- `grep -n 'cancel-in-progress\|timeout-minutes\|concurrency:' .github/workflows/bootstrap-accumulate.yml` identical pre/post.

## Evaluation Contract
- **required_tests:** none. Doc-only YAML comment update. Smoke: workflow YAML parses (CI workflow lint catches any syntax breakage automatically).
- **required_evidence:**
  - Diff restricted to the 4 allowed paths.
  - DEC text removes the words "interim", "until", "reconciliation" from the verify block.
  - `continue-on-error: true` value preserved verbatim in both nightly.yml and bootstrap.yml.
  - bootstrap-accumulate.yml gains a header cross-reference; all operational fields unchanged.
- **required_real_path_checks:** all three target workflow files exist at the listed paths.
- **required_authority_invariants:**
  - `continue-on-error` value unchanged in all three files.
  - `concurrency:` block unchanged in bootstrap-accumulate.yml.
  - All `timeout-minutes` values unchanged.
  - No other workflow files touched.
  - No source packages touched.
- **required_integration_points:** CI behavior unchanged — documentation only aligns with the operator decision.
- **forbidden_shortcuts:**
  - Flipping `continue-on-error` to `false` (contradicts Option B).
  - Removing the loud-failure diagnostic / `run:` invocation.
  - Modifying any other workflow file (`pr-ci.yml`, `closer-parity-as.yml`, `wave-3-parity.yml`, `bench-b*.yml`, etc.).
  - Editing `.github/actions/**`, `.claude/**`, `MASTER_PLAN.md`, `bench/**`, `docs/**`, `scripts/**`.
- **rollback_boundary:** single git revert of the WI commit restores the prior DEC framing. No data migration, no state cleanup.
- **acceptance_notes:** Operator-decision-only WI. References #686 for cancellation root-cause investigation, which is intentionally **out of scope** here.
- **ready_for_guardian_definition:**
  - The 4 allowed files updated as specified, no other paths touched.
  - YAML still parses (validated by GitHub workflow lint in CI).
  - PR opened with `Closes #651`.
  - Reviewer confirms the authority invariants and forbidden-shortcuts list above.

## Waves
Single wave, single work item (`wi-651-verify-b`). No dependencies. Weight S.

## Decision Log (delta)
- **DEC-VERIFY-CI-ADVISORY-001** reframed from "interim until bootstrap-accumulate stabilizes" → "permanent per #651 Option B operator decision 2026-05-17". No supersession ID needed — same DEC, updated rationale text reflecting operator decision.
- **DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001** annotated as canonical (not interim) via header cross-reference. No rationale change.
