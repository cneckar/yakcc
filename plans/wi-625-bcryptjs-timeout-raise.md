# WI-625 — Raise bcryptjs test timeouts; unskip §A-§E + compound

**Workflow**: `fix-625-bcryptjs-timeout-raise`
**Issue**: #625 (follow-up to #585 / PR #627)
**Branch**: `feature/625-bcryptjs-timeout-raise`
**Worktree**: `/Users/cris/src/yakcc/.worktrees/feature-625-bcryptjs-timeout-raise`
**Author**: planner (Serenity)
**Date**: 2026-05-16

## Tightened scope (operator-authorized)

Only the timeout/unskip surface from #625 lands here. The remaining items in the
issue body (result caching, corpus row population, §F re-enable) are explicitly
**deferred** — each becomes a separate WI if needed. See "Out of scope" below.

## Problem statement

WI-585 (PR #627) shipped the UMD-IIFE engine fix in `recursion.ts`
(`ParenthesizedExpression` unwrap inside `decomposableChildrenOf`). The fix
correctly decomposes `bcryptjs@2.4.3/dist/bcrypt.js`
(`moduleCount=1, stubCount=0, externalSpecifiers=['crypto']`), but each section
of `bcryptjs-headline-bindings.test.ts` now performs a full 1379-line UMD-IIFE
decompose, exceeding the original 120s / 300s per-test ceilings. To unblock
landing #585, sections §A-§E + the compound section were temporarily marked
`.skip` with a tracking pointer to #625.

The engine-side correctness work is done. What remains is operational:
**raise per-test timeouts to a realistic budget and remove the `.skip` markers**
so the post-fix assertions actually run in CI.

## Goals

1. Unskip §A, §B, §C, §D, §E, and the compound interaction test in
   `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts`.
2. Raise each affected per-test timeout to a realistic budget that absorbs the
   live cost of a full bcryptjs UMD-IIFE decompose (§D does two passes).
3. Verify with a single end-to-end test run that the unskipped sections all
   pass within the new budget on the engine-fix HEAD.

## Non-goals (deferred to separate WIs)

- **Result caching** between sections (e.g., a module-level `await
  shavePackage()` memo). Issue #625's blocker comment defers this; raising
  timeouts is sufficient to unblock CI signal.
- **§F combinedScore quality gate re-enable.** That is #624's scope and
  requires `DISCOVERY_EVAL_PROVIDER=local`; §F stays `.skipIf(!USE_LOCAL_PROVIDER)`.
- **Corpus row population** for `cat1-bcryptjs-hash-001` /
  `cat1-bcryptjs-verify-001`. Deferred to a separate registry-corpus WI.
- **Splitting bcryptjs into a separate test file** with relaxed policy.
  Not needed once per-test timeouts are realistic.
- **Any engine change.** `recursion.ts` and adjacent universalize sources
  are forbidden in this WI.

## Current state of affected tests

`packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts`:

| Section | Lines | Current timeout | Current state | Notes |
|--------|------|----------------|---------------|-------|
| §A — UMD IIFE decompose shape | 160-197 | 120_000 ms | `it.skip` | single decompose |
| §B — first-node kind=module | 202-217 | 120_000 ms | `it.skip` | single decompose |
| §C — externalSpecifiers/stubs | 222-245 | 120_000 ms | `it.skip` | single decompose |
| §D — two-pass determinism | 250-294 | 300_000 ms | `it.skip` | **two full decompose passes** |
| §E — slice plans + persist | 299-333 | 120_000 ms | `it.skip` | decompose + slicing + persist |
| §F (hash) — combinedScore | 349-396 | 120_000 ms | `.skipIf(!USE_LOCAL_PROVIDER)` | **leave as-is — #624 territory** |
| §F (verify) — combinedScore | 400-448 | 120_000 ms | `.skipIf(!USE_LOCAL_PROVIDER)` | **leave as-is — #624 territory** |
| Compound — real production seq | 464-518 | 300_000 ms | `it.skip` | decompose + plans + persist |

Empirical baseline from #585 PR #627: total test runtime ~25 min, ~300s+ per
section, with §D and the compound section dominating because they perform
multiple expensive operations against the 1379-line UMD IIFE.

## Decision: per-section timeout budgets

Two-tier raise based on operation count per test:

- **Tier 1 — single decompose (§A, §B, §C, §E):** `120_000` → `900_000` ms
  (15 minutes). 3× headroom over the observed ~300s ceiling. Matches the
  operator-stated `900_000` target.

- **Tier 2 — two-pass / compound (§D, compound):** `300_000` →
  `1_500_000` ms (25 minutes). §D performs two independent
  `shavePackage()` passes; the compound section performs decompose + slice
  plan collection + atom persistence. A flat `900_000` leaves §D effectively
  at 1.5× margin (live cost ~600s) which is too tight for CI variance.
  `1_500_000` ms gives ~2.5× margin on the 2× baseline. The compound section
  gets the same budget for symmetry and because it does extra slice+persist
  work on top of decompose.

| Section | New timeout |
|---------|-------------|
| §A | 900_000 ms |
| §B | 900_000 ms |
| §C | 900_000 ms |
| §D | 1_500_000 ms |
| §E | 900_000 ms |
| Compound | 1_500_000 ms |

Vitest test-level timeout option (the second `{ timeout }` argument to
`it(...)`) overrides the vitest config default per test, so no config change
is required. Hook timeouts and global default remain untouched.

## Assertions (no changes — already post-WI-585)

The skipped tests already encode the post-fix assertions; this WI only
changes timeouts + removes `.skip`. Confirming the assertions match the
operator contract:

- `forest.moduleCount >= 1` — §A line 188, §C implied, §D pass-equality, compound line 478
- `forest.stubCount === 0` — §A line 192, §C line 235, §D lines 291-292, compound line 479
- `externalSpecifiers` includes `'crypto'` — §C line 243, compound line 482
- `persistedCount > 0` — §E line 328, compound line 505

No assertion edits are needed. If the live engine behavior diverges from any
of these, that is a separate engine-side investigation — this WI surfaces the
signal rather than masking it.

## Diff sketch

For each of §A, §B, §C, §E:

```diff
-  // SKIPPED — WI-585 engine fix lands moduleCount=1 (correct) but bcrypt library
-  // decompose is now slow (300s+ per section). Test assertion updates + per-test
-  // timeout tuning tracked in follow-up issue #625.
-  it.skip(
+  // WI-625: unskipped post-WI-585; per-test timeout raised to absorb full
+  // bcryptjs UMD IIFE decompose cost (~300s per section observed).
+  it(
     "section X -- ...",
-    { timeout: 120_000 },
+    { timeout: 900_000 },
     async () => { ... }
   );
```

For §D and the compound section, the same shape but with `{ timeout: 1_500_000 }`
and a comment noting the two-pass / compound rationale.

§F (`.skipIf(!USE_LOCAL_PROVIDER)`) blocks are **not touched**.

## Files

- **Modified (required):**
  - `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts`
  - `plans/wi-625-bcryptjs-timeout-raise.md` (this file)
- **Untouched (forbidden by scope manifest):**
  - `packages/shave/src/universalize/recursion.ts` — WI-585 engine fix preserved
  - all other universalize sources and sibling headline-bindings tests
  - all other packages (compile, contracts, registry, cli, federation, ir,
    seeds, variance), all hooks packages, `.github/`, `.claude/`, `bench/`,
    `docs/`, `scripts/`, `MASTER_PLAN.md`
- **tmp/ workspace allowed:** `tmp/wi-625-*` for intermediate logs.

## Verification approach

Single test-file run on the worktree:

```bash
cd /Users/cris/src/yakcc/.worktrees/feature-625-bcryptjs-timeout-raise
pnpm --filter @yakcc/shave test bcryptjs-headline-bindings 2>&1 \
  | tee tmp/wi-625-verify/full-run.log
```

Expected: all §A-§E + compound `it()` blocks **pass** within their budgets.
Both §F blocks remain skipped (no `DISCOVERY_EVAL_PROVIDER=local` set).
Wall-clock budget for the run: ~25-35 min.

If §D or compound times out at `1_500_000` ms, the engine has regressed or
something is genuinely pathological — escalate to planner rather than raising
the budget further. Do **not** re-`.skip` to make the test cheaper.

## Risks and mitigations

- **Risk:** §D or compound still times out under CI jitter.
  **Mitigation:** budget is 2.5× the live single-pass cost. If insufficient,
  the deferred result-caching WI is the right answer; do not silently raise.
- **Risk:** assertions diverge from live engine output.
  **Mitigation:** the assertions are already what WI-585 landed; any divergence
  is signal, not noise. Report rather than weaken.
- **Risk:** vitest hook/setup timeout (`testTimeout` in config) shadows the
  per-test option.
  **Mitigation:** verified — vitest per-test `{ timeout }` overrides the
  config default. No config change needed.

## Out of scope (explicitly for #624 / future WIs)

- §F combinedScore (#624)
- Result caching for §A-§D shared decompose
- Corpus row `expectedAtomName` population
- Splitting bcryptjs into its own test file
- Any engine change (forbidden)

## Evaluation contract (mirrored from dispatch)

- **required_tests:** all §A-§E + compound `it()` unskipped; timeouts
  ≥ 900_000 ms (§D / compound ≥ 1_500_000 ms); assertions match post-WI-585
  reality (`moduleCount >= 1`, `stubCount === 0`,
  `externalSpecifiers.includes('crypto')`, `persistedCount > 0`); single
  end-to-end run of `bcryptjs-headline-bindings.test.ts` passes.
- **required_evidence:** diff scoped to allowed_paths only; this plan file
  committed; test-run output showing all unskipped sections pass within budget.
- **required_real_path_checks:**
  `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` present.
- **required_authority_invariants:** `recursion.ts` untouched (engine fix
  preserved); §F `combinedScore` blocks stay `.skipIf(!USE_LOCAL_PROVIDER)`
  (#624 territory); no other test files modified; no source packages touched.
- **required_integration_points:** WI-585 engine fix
  (`ParenthesizedExpression` unwrap in `recursion.ts`) drives the new
  assertions.
- **forbidden_shortcuts:** re-applying `.skip` to make tests cheaper; adding
  result caching (deferred); lowering assertions below live reality.
- **rollback_boundary:** single commit; `git revert` returns tests to `.skip`.
- **ready_for_guardian_definition:** all unskipped tests pass; reviewer
  verdict `ready_for_guardian`; PR body opens with `Closes #625`.

## Scope manifest (mirrored from workflow contract)

- **allowed_paths:**
  - `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts`
  - `plans/wi-625-bcryptjs-timeout-raise.md`
  - `tmp/wi-625-*`
- **required_paths:** `plans/wi-625-bcryptjs-timeout-raise.md`
- **forbidden_paths:** all other source packages; sibling universalize tests
  (`recursion.ts`, `module-graph.ts`, `slicer.ts`, `zod-`, `validator-`,
  `lodash-`, `iife-walk.test.ts`); fixtures; all `hooks-*`; `.github/`,
  `.claude/`, `MASTER_PLAN.md`, `bench/`, `docs/`, `scripts/`.
- **authority_domains:** `bcryptjs-test-timeout` — this WI owns the per-test
  timeout values for the bcryptjs headline bindings test, and only those.
