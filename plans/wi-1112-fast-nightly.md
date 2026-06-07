# WI-1112 — Fast nightly: stop @yakcc/cli tests timing out on default mirror

**Workflow:** `wi-1112-fast-nightly`
**Issue:** #1112 — "Nightly full-test suite is slow/cancels — ~50 60s-timeout tests in cli uninstall + hooks-lifecycle"
**Status:** planner output (no source written)
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-1112-fast-nightly/`

---

## 1. Problem statement

`.github/workflows/nightly.yml:37` runs the "full test suite (pnpm -r build + test)" job with `timeout-minutes: 60`. Observed behavior: the job has been **cancelled** (e.g. run 27071808030) while `bootstrap --verify` is still in-flight, because `full-test` is overshooting the 60-minute job timeout.

Issue #1112 attributed this to ~51 tests in the `@yakcc/cli` suite hitting their `testTimeout: 60_000` (`packages/cli/vitest.config.ts:40`), dominating wall-clock. 51 × 60 s = 51 min in the worst case (serial), which alone overruns the job timeout window.

## 2. Root cause (single, mechanical, confirmed)

**Every `init()` call in `hooks-lifecycle.test.ts` and most `init()` calls in `uninstall.test.ts` trigger a real network mirror against `https://registry.yakcc.com` that bounds out at 60 seconds in CI.**

Evidence chain:

1. **Default-peer mirror landed Oct/Nov 2025** — `758fe00 feat(cli): WI-WPE-C #771 — registry.yakcc.com default mirror-on-init (#773)`.
   - `packages/cli/src/commands/init.ts:150` — `const DEFAULT_REGISTRY_PEER_URL = "https://registry.yakcc.com";`
   - `packages/cli/src/commands/init.ts:684-689` — `effectivePeerUrl` resolves to `DEFAULT_REGISTRY_PEER_URL` whenever `--peer`, `--local`, and `--airgapped` are all absent.
   - `packages/cli/src/commands/init.ts:691-715` — when `effectivePeerUrl` is set, init runs `federation mirror --remote <peer>` inside a `Promise.race` against `setTimeout(..., MIRROR_TIMEOUT_MS)`.

2. **Mirror timeout is 60 s** — `packages/cli/src/commands/init.ts:174` — `const MIRROR_TIMEOUT_MS = 60_000;`
   (Bumped from 10 s to 60 s in PR #816 / closes #790.)

3. **vitest test timeout is also 60 s** — `packages/cli/vitest.config.ts:40` — `testTimeout: 60_000`.
   Net effect: an `init()` call that loses the mirror race **races against the vitest timeout itself**. In CI, where the network race always loses (no public `registry.yakcc.com` instance reachable from GitHub Actions runners), each affected test pegs at ~60 s and frequently trips vitest's timeout.

4. **The two slow files lack any mirror seam** — `git grep` shows neither uses `--local`, `--airgapped`, nor injects `runFederation` / `opts.runFederation` to stub the mirror:

   - `packages/cli/test/integration/hooks-lifecycle.test.ts:461-479,497-534,540-599,605-645` — every `init([..., "--no-seed"], logger, { overrideHome })` call relies on the default peer. The file is a 6-adapter `for` loop × 6 `it` blocks = **36 init-driven test cases**, each calling `init()` 1-2 times.
     - No `--local` in the file. `grep -n "local|airgapped|runFederation|MIRROR|--peer|YAKCC_AIRGAP"` returns zero hits.
   - `packages/cli/src/commands/uninstall.test.ts:212,232,246,265,297,378,402,416,437,464,536,549,576,619` — 14 `init(...)` call-sites; only one (`uninstall.test.ts:145`) passes `--local`. The other 13 default-mirror.
     - `grep -n "local|airgapped|runFederation|MIRROR|--peer|YAKCC_AIRGAP"` returns 5 hits, all in the one `--local` test.

5. **Contrast: `init.test.ts` is fast precisely because it uses the seams.**
   - `packages/cli/src/commands/init.test.ts:31` — DEC-WPE-DEFAULT-PEER-001 seam documented at the top.
   - `packages/cli/src/commands/init.test.ts:91` — `const noOpMirror = async (...) => 0;` and `captureMirror()` at line 97.
   - `packages/cli/src/commands/init.test.ts:116-238` — every `init()` either passes `--local` or `runFederation: noOpMirror`.
   - PR #1108 (closes #1098) was the **same class of fix** for `init.test.ts`. The remaining slow files were not yet hermetic; that is what #1112 is asking us to finish.

6. **Issue framing vs reality.**
   The issue body speculates these tests "spawn real subprocesses (CLI lifecycle / hook install / uninstall) that hang waiting on something absent in CI." That speculation is wrong. The tests are **in-process** — they `await init(...)` and `await uninstall(...)` directly (see `hooks-lifecycle.test.ts:43-50` imports of `init` and `uninstall` from `../../src`; `uninstall.test.ts:30-31` likewise). The 60 s wait is **inside** `init()`, on `registry.yakcc.com`. There is no spawn to mock and no fake clock needed; the existing `runFederation` seam already exists and is the canonical fix.

## 3. Secondary issues (smaller wall-clock impact)

### 3a. `seed-yakcc.test.ts` corpus/null-zero provider mismatch
- `packages/cli/src/commands/seed-yakcc.test.ts:40` — already uses `createOfflineEmbeddingProvider()` and threads `offlineEmbeddings` through every `openRegistry`/`seedYakccCorpus` call.
- `packages/cli/src/commands/seed-yakcc.test.ts:73, 121, 272` — `describe.skipIf(BOOTSTRAP_CORPUS_PATH === null)` gates execution on whether `bootstrap/yakcc.registry.sqlite` exists on the runner.
- The "6 skipped + suite-level error" pattern in #1112 happens when the bootstrap sqlite **does** exist on the runner but the registry inside it was embedded with a different provider than the offline one (vector dimension mismatch). Today's `bootstrap/expected-roots.json` change and PR #1113 (#1031 Slice A) realigned the bootstrap embed-provider, so the suite-level error should be gone on current main. Need to **verify locally** by running this test against the worktree's bootstrap sqlite; if green, no source change is needed and we only audit/annotate.

### 3b. `emit-atom.test.ts` — one test times out in full run, passes in isolation
- `packages/cli/src/commands/emit-atom.test.ts` does NOT call `init()` and does NOT touch the federation mirror. `grep` for `init(|spawn|setTimeout|federation|mirror|peer|--local` returns zero hits.
- Likely cause: with `pool: "forks"` (`vitest.config.ts:39`) and many concurrent forks, this test is contending for shared resource (bootstrap sqlite open, registry write) or for compile-time cache. It is **secondary**: it accounts for ~1 timeout × 60 s = 1 min, not the bulk.
- Treatment: investigate once mirror tests are fast; do not bundle the fix into the same slice unless it's a one-line vitest config tweak.

### 3c. Nightly job timeout window
- `nightly.yml:37` `timeout-minutes: 60` for `full-test`. Acceptable. After mirror tests collapse from ~60 s each to <1 s each, the full suite should fit comfortably; no schedule-window change needed.

## 4. Approach evaluation (issue body's four options)

| Option | Verdict | Reason |
|---|---|---|
| (a) Mock spawn / fake clock for subprocess tests | **Wrong target.** The tests are in-process; there is no subprocess to mock. The "hang" is `setTimeout(60_000)` inside `init()` racing against a real HTTPS GET. |
| (b) Env-flag gate real variants (mirror `YAKCC_RUST_E2E`) | **Not needed.** A canonical in-process seam already exists (`InitOptions.runFederation` + `--local`). The `YAKCC_RUST_E2E` pattern in `shave-rust.test.ts:5` is for tests that genuinely need a real cargo subprocess; nothing in hooks-lifecycle or uninstall needs the real network. Use the seam, not an env gate. |
| (c) `pool: 'forks'` / sharding | **Already enabled** (`vitest.config.ts:39`). Sharding cannot help when each affected test wall-clocks at 60 s; you'd still hit job timeout, just in parallel. Not a fix. |
| (d) Make seed-yakcc hermetic | **Largely done** (PR #1113 / WI-1031 Slice A). Verify post-land; only intervene if local run still surfaces the suite-level error. |

**Recommended approach:** apply the existing `--local` / `runFederation: noOpMirror` seams to the slow tests, mirroring exactly what `init.test.ts` does. No new mechanism, no new env flag, no new mock; this is the canonical pattern already documented in `DEC-WPE-DEFAULT-PEER-001`.

## 5. Slice decomposition

Three slices. **A and B are independent** and can run in parallel; C is verification + a small follow-up only if A/B leave residual slow paths.

---

### Slice A — `hooks-lifecycle.test.ts` hermetic (biggest impact)

**Files to change (allowed):**
- `packages/cli/test/integration/hooks-lifecycle.test.ts`

**Files allowed to read but not modify:**
- `packages/cli/src/commands/init.ts` (reference for seam shape)
- `packages/cli/src/commands/init.test.ts` (reference for `noOpMirror` pattern)

**Forbidden:**
- Any change to `packages/cli/src/commands/init.ts` or `uninstall.ts` (production code)
- Any change to `packages/cli/vitest.config.ts`
- Any new env-flag mechanism

**Approach:**
Add `--local` to the `init([...])` argv in every test that doesn't care about the federation/mirror surface (all 6 × 6 = 36 cases). The lifecycle suite tests hook artefact installation/uninstall round-trips — none of it depends on default-peer or mirror behavior. `--local` skips the mirror entirely (`init.ts:684-689` — when `parsed.values.local === true`, `effectivePeerUrl` is `undefined`).

This is a one-token edit per call site (insert `"--local",` into the argv arrays at lines `462-465`, `483-485`, `498-503`, `511-516`, `548-551`, `584-587`, `607-611`, `624-629` — 8 call sites total).

**Expected savings:** Each test currently waits up to 60 s on the mirror race. Six adapters × six tests × ~50-60 s = **~30-36 minutes** of wall-clock removed from the full run.

**Evaluation Contract:**
- **Required tests:** `pnpm --filter @yakcc/cli test test/integration/hooks-lifecycle.test.ts` completes in **< 30 s** wall-clock total (was: minutes-to-tens-of-minutes). All 36 tests must pass.
- **Required real-path checks:**
  - Confirm the suite still exercises the install + uninstall + re-init round-trip per adapter (the existing assertions on `isYakccMarkerPresent`, byte-identity snapshots, and sibling preservation must still run and still pass).
  - Confirm `homeDirSnapshots` `afterAll` HOME-sentinel check still fires and passes (real HOME not touched).
- **Required authority invariants:**
  - No change to `init.ts` / `uninstall.ts` production code.
  - No change to `vitest.config.ts`.
  - No new env flag introduced.
- **Required integration points:** None (test-file-local change).
- **Forbidden shortcuts:**
  - Do **not** add `runFederation: noOpMirror` if `--local` works (prefer the most restrictive, simplest seam — `--local` also short-circuits other default-peer logic, which is desirable for this suite).
  - Do **not** add `it.skipIf(process.env.CI)` or any other env gate. The fix must apply to local and CI uniformly.
  - Do **not** bump `testTimeout` or `MIRROR_TIMEOUT_MS` to mask the issue.
- **Ready-for-guardian when:**
  - All 36 hooks-lifecycle tests pass locally in <30 s aggregate wall-clock.
  - `git diff` is confined to `packages/cli/test/integration/hooks-lifecycle.test.ts`.
  - `pnpm --filter @yakcc/cli typecheck` and `pnpm --filter @yakcc/cli build` both succeed.

**Scope Manifest:**
- **allowed_paths:**
  - `packages/cli/test/integration/hooks-lifecycle.test.ts`
  - `plans/wi-1112-fast-nightly.md` (planner notes)
- **required_paths:**
  - `packages/cli/test/integration/hooks-lifecycle.test.ts`
- **forbidden_paths:**
  - `packages/cli/src/**/*.ts` (production code)
  - `packages/cli/vitest.config.ts`
  - `packages/cli/package.json`
  - any file outside `packages/cli/test/integration/` and `plans/`
- **state_authorities_touched:** none (test-only).

---

### Slice B — `uninstall.test.ts` hermetic

**Files to change (allowed):**
- `packages/cli/src/commands/uninstall.test.ts`

**Forbidden:**
- `packages/cli/src/commands/uninstall.ts` (production code)
- `packages/cli/src/commands/init.ts` (production code)
- `packages/cli/vitest.config.ts`

**Approach:**
Same surgical edit as Slice A, applied to the 13 `init(...)` call-sites in `uninstall.test.ts` that do **not** already pass `--local`:

- `uninstall.test.ts:212` (line numbers approximate to current HEAD; implementer should re-locate)
- `uninstall.test.ts:232`
- `uninstall.test.ts:246`
- `uninstall.test.ts:265` (inside `initBothClaudeAndCursor`; helper may need adjustment)
- `uninstall.test.ts:297`
- `uninstall.test.ts:378`
- `uninstall.test.ts:402`
- `uninstall.test.ts:416`
- `uninstall.test.ts:437`
- `uninstall.test.ts:464`
- `uninstall.test.ts:536`
- `uninstall.test.ts:549`
- `uninstall.test.ts:576`
- `uninstall.test.ts:619`

The single existing `--local` call at line 145 is the model. Insert `"--local",` into each affected argv array (and into the helper `initBothClaudeAndCursor` if it's the single shared path for two of these). Re-run after editing to confirm.

If a test specifically asserts default-peer behavior (none of the 13 do, but verify), keep `runFederation: noOpMirror` injection instead of `--local` so the default-peer codepath is still exercised without network I/O.

**Expected savings:** 13 init-driven tests × ~50-60 s = **~11-13 minutes** of wall-clock removed.

**Evaluation Contract:**
- **Required tests:** `pnpm --filter @yakcc/cli test src/commands/uninstall.test.ts` completes in **< 20 s** total. All 27 tests pass.
- **Required real-path checks:**
  - Uninstall + re-init scenarios still exercise the install→remove→re-install round-trip (assertions on `installedHooks`, hook artefact presence/absence, sibling preservation must all still pass).
  - Tests that exercise `runCli(...)` (e.g. `uninstall.test.ts:454`) still validate the CLI dispatch surface.
- **Required authority invariants:**
  - No change to production code.
  - No change to `vitest.config.ts`.
- **Required integration points:** none.
- **Forbidden shortcuts:**
  - No env gate.
  - No timeout bumps.
- **Ready-for-guardian when:**
  - All `uninstall.test.ts` tests pass in <20 s aggregate.
  - `git diff` is confined to `packages/cli/src/commands/uninstall.test.ts`.
  - `pnpm --filter @yakcc/cli typecheck` + `build` succeed.

**Scope Manifest:**
- **allowed_paths:**
  - `packages/cli/src/commands/uninstall.test.ts`
  - `plans/wi-1112-fast-nightly.md`
- **required_paths:**
  - `packages/cli/src/commands/uninstall.test.ts`
- **forbidden_paths:**
  - `packages/cli/src/commands/init.ts`
  - `packages/cli/src/commands/uninstall.ts`
  - `packages/cli/vitest.config.ts`
  - any file outside `packages/cli/src/commands/uninstall.test.ts` and `plans/`
- **state_authorities_touched:** none.

---

### Slice C — Verify seed-yakcc + investigate emit-atom (conditional)

**Trigger:** Only run this slice if, **after Slices A and B land**, the full `pnpm --filter @yakcc/cli test` run shows:
- (i) the `seed-yakcc.test.ts` suite-level provider-mismatch error reappears, OR
- (ii) `emit-atom.test.ts` still has a test that times out only in the full run.

**Files possibly to touch (allowed):**
- `packages/cli/src/commands/seed-yakcc.test.ts` (only if the offline-provider seam needs a tweak — unlikely)
- `packages/cli/src/commands/emit-atom.test.ts` (only if ordering/shared-state pollution is the cause)
- `packages/cli/vitest.config.ts` (last resort, only to set `fileParallelism: false` or add per-file timeout overrides if no test-level fix is possible)

**Forbidden:**
- Any production code change.
- Any change to `bootstrap/expected-roots.json` or the bootstrap sqlite.

**Approach:**
1. **seed-yakcc:** Run `pnpm --filter @yakcc/cli test src/commands/seed-yakcc.test.ts` in this worktree (which has `bootstrap/expected-roots.json` modified). If the suite errors on provider mismatch:
   - Confirm `bootstrap/yakcc.registry.sqlite` on the runner was built against the post-#1031 offline provider.
   - If not, the fix may belong upstream (bootstrap regeneration), not in this slice; escalate to user.
   - If yes, the offline-provider seam in the test needs to be tightened — investigate the embedding-dimension propagation.
   - If the suite is now green (most likely outcome given PR #1113 landed), close this branch with "verified hermetic, no change needed" annotation.
2. **emit-atom:** Identify the timing-out test in a full run, then in isolation. If shared bootstrap-sqlite contention is the cause, consider:
   - Per-test isolated registry path (already standard — verify the failing test isn't reading the shared `bootstrap/`).
   - As a last resort, `vitest.config.ts` could set `fileParallelism: false` for just this file — but the cost is a serialization budget, so prefer the test-level fix.

**Expected savings:** small — 0-2 minutes total. This slice is hygiene + verification, not the headline fix.

**Evaluation Contract:**
- **Required tests:** Full `pnpm --filter @yakcc/cli test` completes in **< 5 minutes** wall-clock (vs current ~50+ min). All tests pass; zero suite-level errors.
- **Required real-path checks:** None beyond test pass.
- **Required authority invariants:** No production-code touch.
- **Forbidden shortcuts:** No `vitest.config.ts` blanket timeout increases; no `it.skip` to hide failing tests.
- **Ready-for-guardian when:** Full @yakcc/cli suite is green and fast; documented decision (annotation or @decision) explains any test-config tweak.

**Scope Manifest:**
- **allowed_paths:**
  - `packages/cli/src/commands/seed-yakcc.test.ts`
  - `packages/cli/src/commands/emit-atom.test.ts`
  - `packages/cli/vitest.config.ts` (last-resort only)
  - `plans/wi-1112-fast-nightly.md`
- **forbidden_paths:**
  - `packages/cli/src/commands/*.ts` (production code)
  - `bootstrap/**`
- **state_authorities_touched:** none in source; possibly the offline embedding contract (read-only).

---

## 6. Dependencies and wave plan

```
Slice A (hooks-lifecycle)  ─┐
                            ├──>  Slice C (verify residuals)
Slice B (uninstall)         ─┘
```

A and B are independent; both touch only their own test file. They can be implemented in parallel or sequentially in either order. C is conditional and runs only after both land.

**Recommended first slice: A** — biggest single-file wall-clock impact (~30-36 min), highest signal-to-noise win, and the cleanest demonstration that the seam works. If Slice A reduces the full run to ~15-20 min (still over budget but no longer cancelling), Slice B finishes the job.

## 7. Expected wall-clock outcome

| Surface | Current worst case | After A | After A+B | After A+B+C |
|---|---|---|---|---|
| `hooks-lifecycle.test.ts` | ~36 min | ~30 s | ~30 s | ~30 s |
| `uninstall.test.ts` | ~13 min | ~13 min | ~20 s | ~20 s |
| `seed-yakcc.test.ts` | suite error or skip | unchanged | unchanged | green |
| `emit-atom.test.ts` | 1 × 60 s in full run | ~50 s | ~50 s | ~10 s |
| **Full @yakcc/cli suite** | **~50+ min (cancels)** | **~15-20 min** | **~3-5 min** | **~2-3 min** |
| **Nightly full-test job** | **cancels at 60 min** | **completes ~45 min** | **completes ~15 min** | **completes ~10 min** |

(Numbers assume `pool: "forks"` parallelism is already absorbing ~half of the serial work; pure-serial worst cases would be roughly double.)

## 8. Decision log

- **DEC-1112-FIX-SURFACE-001** — The fix lives in test files, not production. The default-peer + 60 s mirror timeout is a deliberate UX choice (DEC-WPE-DEFAULT-PEER-001 + #790 → 10 s→60 s bump in #816). Tests that don't care about the federation surface must opt out via the existing `--local` flag or `runFederation: noOpMirror` seam; bending the production behavior for test convenience is rejected.
- **DEC-1112-PREFER-LOCAL-FLAG-001** — `--local` is preferred over `runFederation: noOpMirror` in hooks-lifecycle and uninstall tests because (a) it short-circuits the entire default-peer codepath, not just the mirror; (b) it matches the `mode: "local"` semantics those tests already implicitly assume; (c) it's one positional token vs an options-object insertion. `noOpMirror` is reserved for tests that specifically assert default-peer args (currently only `init.test.ts`).
- **DEC-1112-NO-ENV-GATE-001** — Rejected: gating tests on `YAKCC_RUST_E2E`-style env flags. Reason: the slow tests do not need the network at all (no spawn, no real registry); skipping them by default would leave a hermetic test gap. The seam removes the slowness without removing coverage.

## 9. Open questions / things implementer should sanity-check

1. Does the `seedDetectProbe()` setup in `hooks-lifecycle.test.ts:181-202` interact with `--local` in any unexpected way? (Should not — detection probes are HOME-dir layout, mirror is federation. Verify by running the test.)
2. Does `initBothClaudeAndCursor` helper in `uninstall.test.ts` (referenced at line 115, 265) make both `init()` calls; if so, both need `--local`.
3. After Slices A+B land, re-run `pnpm --filter @yakcc/cli test` and capture the full wall-clock. If still over ~5 min, dispatch Slice C.

---

PLAN_VERDICT: ready_for_implementer
RECOMMENDED_FIRST_SLICE: A
EXPECTED_WALL_CLOCK_SAVINGS: 30-36 minutes (Slice A alone); 45-50 minutes total after A+B
