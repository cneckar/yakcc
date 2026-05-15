# wi-485-closer-parity-as-ci — Add `closer-parity-as.yml` CI workflow + close #485 with cold-run evidence

- Workflow ID: `wi-485-closer-parity-as-ci`
- Goal ID:    `g-485-closer-parity-as-ci`
- Work Item:  `wi-485-closer-parity-as-ci`
- Branch:     `feature/485-closer-parity-as-ci`
- Closes:     #485 (after first post-merge cold run completes with evidence)
- Status:     planned (planner stage), awaiting `guardian:provision`

---

## Identity

This is the planning record for adding a dedicated long-lived CI lane that
runs `packages/compile/test/as-backend/closer-parity-as.test.ts` against the
full 4119-atom regenerated corpus on `push:main` and on operator-initiated
`workflow_dispatch`.

#531 (now closed via PR #559) landed the structural fix that makes the test
fit inside a 60-min budget:
- content-addressed asc compile cache (`as-compile-cache.ts`)
- bounded-parallel runner (`as-parity-runner.ts`)
- cheap end-to-end smoke (2-atom real-asc test inside `as-compile-cache.test.ts`)

But the **full 4119-atom validation that #485 asks for has no CI lane today**:
- `wave-3-parity.yml` runs the v1 (TS-backend) test, NOT the AS-backend test.
- `pr-ci.yml`'s affected-package test step has a 20-min `timeout-minutes` —
  insufficient for the AS test's 60-min `beforeAll` budget.
- `nightly.yml` does not currently invoke this specific test.

User directive (2026-05-15): **smoke locally, validate in non-critical
long-lived CI.** The 2-atom real-asc check inside `as-compile-cache.test.ts`
is the local gate (cheap + decisive). This WI builds the long-lived CI lane
that exercises the full corpus and produces the wall-clock evidence required
to close #485.

---

## Problem Statement

### Who has this problem
- Maintainers landing AS-backend changes who need post-merge confirmation
  the 4119-atom invariant suite still holds.
- Anyone investigating the Phase 2 80% gate-flip (#143) — the `it.fails`
  line at L470 of `closer-parity-as.test.ts` is only observable in CI when
  a full cold run completes.
- Issue #485 itself, which cannot close without recorded cold-run evidence.

### How often
- Every merge to `main` that touches AS-backend code paths.
- Ad-hoc operator-initiated runs from the GitHub UI.

### What's the cost
- Without the lane: #485 stays open indefinitely; AS-backend regressions
  land silently on `main`; the 80% gate stays unobservable.
- With the wrong shape (e.g. gating on PR): merge throughput dies because the
  test legitimately takes 10–30 min cold and 60 min worst-case.

### Goals (measurable)
- **G1** — New workflow file exists at `.github/workflows/closer-parity-as.yml`.
- **G2** — Workflow triggers on `push: branches: [main]` and on
  `workflow_dispatch:` (parameterless).
- **G3** — `timeout-minutes: 60` matches the test's `beforeAll` hookTimeout
  (`3_600_000` ms at L364 of the test file). NOT lower; NOT higher.
- **G4** — Workflow is **advisory**, NOT gating — it must NOT be added to
  `pr-ci.yml`, must NOT be referenced as a required check in branch
  protection, and must live as its own file under `.github/workflows/`.
- **G5** — Fast-skip cache invalidates when any of the canonical source-of-
  truth files for the test changes (see §Fast-skip cache below).
- **G6** — After the workflow lands and the first post-merge cold run
  completes, paste run URL + wall-clock into the #485 closing comment.

### Non-goals
- Closing #485 in the same PR that introduces the workflow — closure must
  follow the first successful post-merge cold run.
- Modifying `pr-ci.yml` (removing or adding closer-parity-as references) —
  scope-forbidden in this WI.
- Adding closer-parity-as to `nightly.yml` — separate decision; possibly a
  follow-up WI if the lane proves valuable for warm-cache regression sweep.
- Workflow_dispatch input parameters (force-rerun, override concurrency,
  override timeout) — keep v1 parameterless; iterate only if needed.
- Tightening the 60-min budget — separate "WI-CLOSER-PARITY-AS-BUDGET-
  TIGHTEN" follow-up after enough wall-clock data accumulates.

### Dominant constraints
- DEC-CI-MERGE-GATE-ENFORCE-001 — long tests must NOT gate PR merges.
- DEC-CI-FAST-PATH-PHASE-1-005 — no `pull_request:` trigger for long suites.
- DEC-CI-FAST-PATH-PHASE-3-001 family — fast-skip cache pattern from
  `wave-3-parity.yml` is the canonical shape; mirror it.
- Test's own `3_600_000` ms hookTimeout (cannot be raised per
  DEC-AS-CLOSER-PARITY-CONCURRENCY-001 / DEC-AS-COMPILE-CACHE-001).

---

## Architecture & State Authority

### State authorities touched
- **`ci-workflow-closer-parity-as`** — the new workflow file is the sole
  authority for its name, triggers, timeout, cache key, and invocation.
  No sibling workflow nor `pr-ci.yml` may make claims about closer-parity-as.

### Mirror source (read-only reference, NOT modified)
- `.github/workflows/wave-3-parity.yml` — structural template:
  - `on:` shape (`push: branches: [main]` only, NO `pull_request:`)
  - `concurrency:` group keyed on `${{ github.ref }}`
  - single `parity:` job on `ubuntu-latest`
  - source-hash computation (`find … -name '*.ts' … | sort -z | xargs sha256sum`)
  - `actions/cache@v4` keyed on the hash
  - cache-hit fast-skip path
  - cache-miss slow path: pnpm setup → install → build → test → write marker
- The new workflow's key structural difference from `wave-3-parity.yml`:
  - `timeout-minutes: 60` (vs. wave-3's 30)
  - `workflow_dispatch:` ALSO enabled (wave-3 has push:main only)
  - source-hash scope is narrower (see below)
  - vitest invocation targets a single test file (see below)
  - cache marker path is `tmp/closer-parity-as/.verified-marker`

### Decision: workflow design
**`@decision DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001`**

Add `.github/workflows/closer-parity-as.yml` as an advisory, content-keyed,
push:main + workflow_dispatch-triggered lane with a 60-minute job timeout
that runs `packages/compile/test/as-backend/closer-parity-as.test.ts`. The
workflow mirrors `wave-3-parity.yml`'s fast-skip-cache shape so no-op pushes
are cheap.

Rationale:
- The test legitimately takes 10–30 min cold (4119 atoms ÷ concurrency 4 ≈
  10–15 min asc work + per-atom overhead + ubuntu-latest variance).
  Anything <60-min budget risks false failures.
- Gating PR merges on this would destroy throughput and is explicitly
  forbidden by DEC-CI-MERGE-GATE-ENFORCE-001.
- `workflow_dispatch:` matters because operators may want to re-run after
  asc version bumps, threshold tweaks, or to refresh evidence on demand.
- Fast-skip cache is essential: docs-only or unrelated-source pushes to
  `main` should not pay the 10–30 min cost on every push. The marker pattern
  from `wave-3-parity.yml` invalidates exactly when the input source changes.

### Fast-skip cache — source hash file list (locked)
The cache key must invalidate iff any of the following changes:
1. `packages/compile/test/as-backend/closer-parity-as.test.ts` — the test
   itself (corpus loader, parity body, invariants).
2. `packages/compile/src/as-compile-cache.ts` — the asc compile cache module
   (#531 landed it; behavior change here invalidates cached results).
3. `packages/compile/src/as-parity-runner.ts` — bounded-parallel runner
   (#531 landed it; concurrency/scheduling change must invalidate).
4. `packages/compile/src/as-backend.ts` — asc backend (asc invocation,
   flags, tmpdir handling).
5. `packages/compile/src/as-backend.props.ts` — sibling properties file in
   the same change-scope as `as-backend.ts`.
6. `pnpm-lock.yaml` — asc version pin (transitive deps).

Implementation: a single `find … -name '*.ts' … | sort -z | xargs sha256sum`
over those four `.ts` files plus a separate `sha256sum pnpm-lock.yaml`,
piped to a final `sha256sum`. Match the literal style of `wave-3-parity.yml`
lines 38–49 for consistency.

### Cache marker path
`tmp/closer-parity-as/.verified-marker` (parallels wave-3's
`tmp/wave-3-parity/.verified-marker`).

### Vitest invocation
`pnpm --filter @yakcc/compile test -- test/as-backend/closer-parity-as.test.ts`

Rationale:
- `packages/compile/package.json` scripts: `"test": "vitest run"`. Passing
  a path glob after `--` filters to the single test file.
- `--filter @yakcc/compile` keeps the workspace boundary tight.
- No need to set `YAKCC_AS_PARITY_CONCURRENCY` — the test's
  `computeAscConcurrency()` (DEC-AS-CLOSER-PARITY-CONCURRENCY-001) auto-
  picks `min(os.cpus().length, CI ? 4 : 6)` and detects CI from env.
- `pnpm -r build` is still required because `@yakcc/compile` consumes built
  artifacts of sibling workspace packages.

### Why NOT `continue-on-error: true` at job level
`wave-3-parity.yml` does NOT set it, and we mirror that. The workflow is
already advisory by virtue of NOT being a required check; setting
`continue-on-error` would suppress red-X status on the workflow run itself,
which is the only signal an operator gets that the AS test broke. Leave it
unset so a real failure is visible.

---

## Scope Manifest

### Allowed paths
- `.github/workflows/closer-parity-as.yml` (NEW)
- `plans/wi-485-closer-parity-as-ci.md` (this file)

### Required paths
- `.github/workflows/closer-parity-as.yml`

### Forbidden touch points
- `packages/**` — no source/test edits in this WI.
- `.github/workflows/wave-3-parity.yml` — read-only reference.
- `.github/workflows/pr-ci.yml` — must NOT add closer-parity-as as a gating
  check.
- `.github/workflows/nightly.yml` — separate decision, separate WI.
- `.claude/**` — out of scope.
- `MASTER_PLAN.md` — not edited in this WI.

### Expected state authorities touched
- `ci-workflow-closer-parity-as` (new authority, owned solely by the new
  workflow file).

---

## Evaluation Contract

### Required tests
- **YAML structural lint** — `actionlint` or `yamllint` locally passes on
  the new file. (CI itself will run this on push.)
- **Structural mirror check** — the new workflow file contains:
  - `name: closer-parity-as`
  - `on:` with `push: branches: [main]` AND `workflow_dispatch:`
  - `concurrency:` group `closer-parity-as-${{ github.ref }}` with
    `cancel-in-progress: true`
  - `jobs.parity:` on `runs-on: ubuntu-latest` with `timeout-minutes: 60`
  - source-hash step covering the four `.ts` files + `pnpm-lock.yaml`
  - `actions/cache@v4` keyed on the source hash, path
    `tmp/closer-parity-as/.verified-marker`
  - cache-hit skip step that prints the marker
  - cache-miss path: pnpm setup → setup-node@22 → install --frozen-lockfile
    → `pnpm -r build` → vitest invocation → write marker
- **First post-merge cold run** — triggered automatically when the workflow
  lands on `main`; must complete inside 60 min with green status.

### Required evidence
- New file at `.github/workflows/closer-parity-as.yml`.
- This plan file at `plans/wi-485-closer-parity-as-ci.md`.
- First run URL from `gh run list --workflow=closer-parity-as.yml` after the
  workflow lands.
- Cold-run wall-clock from that first run (target <60 min; expected
  10–30 min on ubuntu-latest with concurrency=4).
- Verification that the fast-skip cache key truly invalidates when any of
  the four source files changes (inspectable from the workflow log's
  "Computed input hash" output).

### Required real-path checks
- `.github/workflows/wave-3-parity.yml` exists (mirror source).
- `.github/workflows/closer-parity-as.yml` does NOT exist pre-implementation.
- `packages/compile/test/as-backend/closer-parity-as.test.ts` exists.
- `packages/compile/src/as-compile-cache.ts` exists.
- `packages/compile/src/as-parity-runner.ts` exists.
- `packages/compile/src/as-backend.ts` exists.

### Required authority invariants
- **Advisory only** — DEC-CI-MERGE-GATE-ENFORCE-001 forbids adding this to
  `pr-ci.yml` as a gating check. Reviewer must verify no edit to
  `pr-ci.yml` exists in the diff.
- **Fast-skip cache key correctness** — the source-hash step must include
  all five files listed above (4 `.ts` + `pnpm-lock.yaml`). Missing one
  means the workflow caches incorrectly and could pass on stale evidence
  after a source change.
- **60-min timeout** — must match the test's `beforeAll(fn, 3_600_000)`
  budget. Setting it lower causes false timeouts; setting it higher masks
  real perf regressions.

### Required integration points
- `workflow_dispatch:` trigger allows operator-initiated runs from the
  GitHub UI for ad-hoc validation (e.g. after asc upgrade, threshold
  experiment).
- `push: branches: [main]` ensures every merge that touches AS-backend code
  paths gets post-merge correctness verification.
- Fast-skip cache pattern mirrors `wave-3-parity.yml` so the workflow is
  cheap on no-op or unrelated commits.

### Forbidden shortcuts
- Adding the workflow to `pr-ci.yml` as a gating check.
- Setting `timeout-minutes` below 60.
- Running the full 4119-atom corpus locally as "validation" before pushing.
  The 2-atom real-asc test inside `as-compile-cache.test.ts` is the local
  gate — cheap, decisive, already integrated. Running the full corpus
  locally defeats the smart-local + long-CI split the user explicitly asked
  for and burns hours per iteration.
- Skipping the fast-skip cache and re-running the corpus on every push.
- Adding `continue-on-error: true` to suppress red-X status on real failures.

### Ready for guardian when
- `.github/workflows/closer-parity-as.yml` is present and structurally
  mirrors the spec in §Implementation below.
- `plans/wi-485-closer-parity-as-ci.md` (this file) is present.
- Local YAML lint passes (`actionlint` or `yamllint`).
- Local typecheck + lint hygiene per pre-push memory (see §Validation).
- Reviewer verdict is `ready_for_guardian`.
- PR is opened referencing #485 ("relates to" — closure deferred until
  cold-run evidence is in hand).

**Note on closing #485** — leave the issue OPEN at PR-merge time. Only
after the first post-merge cold run completes successfully and we have run
URL + wall-clock, post the closing comment + close. If the first cold run
fails or hits 60-min ceiling, leave #485 OPEN with the run URL pinned as
"pending — investigating".

---

## Implementation Spec — the exact YAML

The implementer should produce this file at
`.github/workflows/closer-parity-as.yml`. Comments are part of the file
(institutional memory for the next implementer).

```yaml
# @decision DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001
# Title: closer-parity-as long-lived CI lane (advisory, push:main + workflow_dispatch)
# Status: accepted
# Rationale: closer-parity-as.test.ts runs the full 4119-atom AS-backend
# corpus with a 60-min hookTimeout budget (DEC-AS-COMPILE-CACHE-001 +
# DEC-AS-CLOSER-PARITY-CONCURRENCY-001 made this feasible). It is too long
# to gate PRs (DEC-CI-MERGE-GATE-ENFORCE-001) but post-merge correctness
# matters. This workflow runs it on push:main and on operator-initiated
# workflow_dispatch with a content-keyed fast-skip cache so no-op commits
# are cheap. Mirror of wave-3-parity.yml's shape.

name: closer-parity-as

on:
  push:
    branches: [main]
  # workflow_dispatch enables operator-initiated runs from the GitHub UI —
  # useful after asc version bumps, threshold experiments, or to refresh
  # cold-run wall-clock evidence on demand.
  workflow_dispatch:
  # pull_request trigger intentionally omitted per DEC-CI-FAST-PATH-PHASE-1-005
  # and DEC-CI-MERGE-GATE-ENFORCE-001. PR-time coverage of the AS-backend is
  # provided by the cheap 2-atom real-asc test inside
  # packages/compile/src/as-compile-cache.test.ts via pr-ci.yml's
  # affected-package test step.

concurrency:
  group: closer-parity-as-${{ github.ref }}
  cancel-in-progress: true

jobs:
  parity:
    name: closer-parity-as (full 4119-atom corpus)
    runs-on: ubuntu-latest
    # 60-min timeout matches the test's beforeAll(fn, 3_600_000) hookTimeout
    # at packages/compile/test/as-backend/closer-parity-as.test.ts L364.
    # Do NOT lower this; do NOT raise it (raising masks perf regressions,
    # lowering produces false timeouts).
    timeout-minutes: 60

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # -----------------------------------------------------------------------
      # Fast-skip cache.
      #
      # The closer-parity-as result is a deterministic function of:
      #   - closer-parity-as.test.ts (the test body + corpus loader)
      #   - as-compile-cache.ts      (cache module landed in #531)
      #   - as-parity-runner.ts      (bounded-parallel runner landed in #531)
      #   - as-backend.ts            (asc invocation)
      #   - as-backend.props.ts      (sibling props file in same change-scope)
      #   - pnpm-lock.yaml           (asc version pin + transitive deps)
      #
      # Cache a marker file keyed on the input hash; skip on cache hit.
      # Cache miss = first time we've seen this source state OR a prior run
      # failed (markers are only written after a successful test pass).
      # -----------------------------------------------------------------------
      - name: Compute source hash
        id: source-hash
        run: |
          HASH=$(
            {
              sha256sum \
                packages/compile/test/as-backend/closer-parity-as.test.ts \
                packages/compile/src/as-compile-cache.ts \
                packages/compile/src/as-parity-runner.ts \
                packages/compile/src/as-backend.ts \
                packages/compile/src/as-backend.props.ts
              sha256sum pnpm-lock.yaml
            } | sha256sum | awk '{print $1}'
          )
          echo "hash=$HASH" >> "$GITHUB_OUTPUT"
          echo "Computed input hash: $HASH"

      - name: Restore verified-marker cache
        id: verified-cache
        uses: actions/cache@v4
        with:
          path: tmp/closer-parity-as/.verified-marker
          key: closer-parity-as-verified-${{ steps.source-hash.outputs.hash }}

      - name: Skip — already verified for this source state
        if: steps.verified-cache.outputs.cache-hit == 'true'
        run: |
          echo "Cache hit — closer-parity-as was previously verified for this exact source state."
          echo
          cat tmp/closer-parity-as/.verified-marker

      # -----------------------------------------------------------------------
      # Slow path — runs only on cache miss.
      # -----------------------------------------------------------------------
      - name: Set up pnpm
        if: steps.verified-cache.outputs.cache-hit != 'true'
        uses: pnpm/action-setup@v4

      - name: Set up Node.js
        if: steps.verified-cache.outputs.cache-hit != 'true'
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        if: steps.verified-cache.outputs.cache-hit != 'true'
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        if: steps.verified-cache.outputs.cache-hit != 'true'
        run: pnpm -r build

      - name: Run closer-parity-as (full 4119-atom corpus)
        if: steps.verified-cache.outputs.cache-hit != 'true'
        run: pnpm --filter @yakcc/compile test -- test/as-backend/closer-parity-as.test.ts

      - name: Write verified-marker
        if: steps.verified-cache.outputs.cache-hit != 'true'
        run: |
          mkdir -p tmp/closer-parity-as
          {
            echo "input-hash: ${{ steps.source-hash.outputs.hash }}"
            echo "verified-at: $(date -u +%FT%TZ)"
            echo "commit: ${{ github.sha }}"
            echo "ref: ${{ github.ref }}"
          } > tmp/closer-parity-as/.verified-marker
          cat tmp/closer-parity-as/.verified-marker
```

### Notes for the implementer
- Use the exact YAML above as the starting point. Do NOT reformat block
  indentation; GitHub Actions is strict.
- The `pnpm/action-setup@v4` call has no `with: version:` — honors the
  single `packageManager` authority in `package.json` per DEC-CI-OFFLINE-004.
- `actions/setup-node@v4` with `cache: pnpm` is the canonical pnpm cache
  hook on Node 22, identical to `wave-3-parity.yml`.
- The marker text format is identical to `wave-3-parity.yml` line 92–101.
  Keep it identical so cross-workflow tooling that reads markers Just Works.

---

## Validation Strategy (pre-push hygiene + post-push evidence)

### Pre-push (local, implementer responsibility)
Per the pre-push hygiene memory, the implementer in the worktree must:

1. **Lint the YAML.**
   - `actionlint .github/workflows/closer-parity-as.yml`
     (install via `brew install actionlint` if missing), OR
   - `yamllint .github/workflows/closer-parity-as.yml` as a fallback.
2. **Rebase on origin/main** before push:
   - `git -C <worktree> fetch origin main`
   - `git -C <worktree> rebase origin/main`
   - `git -C <worktree> diff --stat origin/main..HEAD` — confirm only the
     two scoped files appear.
3. **Workspace lint + typecheck** (cheap, catches accidental scope leaks):
   - `pnpm lint`
   - `pnpm typecheck`
   - Both should be no-ops since only `.github/` and `plans/` are touched.
4. **Do NOT run the full 4119-atom corpus locally.** The 2-atom real-asc
   smoke inside `packages/compile/src/as-compile-cache.test.ts` is the
   local gate; running the full corpus defeats the smart-local + long-CI
   split.
5. **PR body** must reference #485 with "relates to" (NOT "closes") since
   closure is deferred to post-merge cold-run evidence.

### Post-push (orchestrator + operator, after Guardian lands)
1. After Guardian merges the PR to `main`, the new workflow auto-triggers.
2. Grab the run URL: `gh run list --workflow=closer-parity-as.yml --limit 1 --json url,status,conclusion,createdAt,updatedAt`.
3. Watch the run: `gh run watch <run-id>` (or check periodically).
4. On success:
   - Compute wall-clock from `createdAt` → `updatedAt`.
   - Post closing comment on #485 with:
     - Run URL
     - Wall-clock (e.g. "Cold run completed in 14m23s on ubuntu-latest")
     - Commit SHA
     - Note: workflow is advisory + content-keyed; subsequent unrelated
       pushes will fast-skip.
   - Close #485.
5. On failure or 60-min ceiling:
   - Do NOT close #485.
   - Pin the run URL in a comment as "pending — investigating".
   - Escalate to planner for next-steps (likely a follow-up WI to either
     investigate the perf regression or revisit budget bounds).

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ubuntu-latest perf variance pushes cold run >60 min | Medium | High | The 60-min budget already includes headroom over the projected 10–30 min wall-clock. If hit, investigate before closing #485 — likely an asc regression or runner perf shift, not a workflow bug. |
| asc version drift from `pnpm-lock.yaml` invalidates the cache unexpectedly | Low | Low | This is by design — `pnpm-lock.yaml` IS part of the source hash. Cache miss on lock-bump is correct behavior. |
| pnpm cache miss in `actions/setup-node@v4` | Low | Medium | Same setup as `wave-3-parity.yml`, which has been stable. If it fails, falls back to fresh `pnpm install --frozen-lockfile`. |
| Workflow added to `pr-ci.yml` by accident (scope leak) | Low | Critical | Reviewer must verify diff shows ONLY the two scoped files. Forbidden-paths in Scope Manifest backstop this. |
| `timeout-minutes: 60` set too low/high | Low | High | Spec mandates exactly 60 — matches test's `3_600_000` ms hookTimeout. Reviewer verifies the literal value. |
| First post-merge cold run reveals new perf regression | Medium | Medium | That's the workflow's job — surface it. Leave #485 open with run URL, dispatch follow-up planner. |
| `pnpm --filter @yakcc/compile test -- test/as-backend/closer-parity-as.test.ts` runs other compile tests too | Low | Medium | The positional arg after `--` becomes a vitest path filter; vitest only runs matching files. If validation shows otherwise, escalate to planner for a `--testNamePattern` or scripts-level invocation. |

---

## Out of scope (explicit)

- **Closing #485 in the same PR.** Closure requires post-merge cold-run
  evidence, which doesn't exist until after the workflow is on `main` AND
  has run once.
- **Modifying `pr-ci.yml`.** The PR-time advisory affected-package test
  remains useful as a "did the test break in obvious ways" gate. Removing
  or augmenting it is a separate decision (potential follow-up:
  WI-CLOSER-PARITY-AS-PRCI-CLEANUP).
- **Adding closer-parity-as to `nightly.yml`.** Possible follow-up: a warm-
  cache nightly sweep that proves the cache stays effective overnight.
- **`workflow_dispatch` inputs** (force-rerun, override concurrency, force
  cache bust). Keep v1 parameterless; add inputs only after observed need.
- **Tightening the 60-min budget.** Track as
  WI-CLOSER-PARITY-AS-BUDGET-TIGHTEN once enough wall-clock data
  accumulates (≥10 cold runs on `main`).
- **Branch protection / required-checks configuration.** This workflow MUST
  NOT be required. No GitHub UI changes needed (default = not required).

---

## Wave decomposition

Single wave. One file added, one plan doc. Trivial graph.

- **W1** (S, Gate: none → review → approve)
  - `.github/workflows/closer-parity-as.yml` (NEW)
  - `plans/wi-485-closer-parity-as-ci.md` (this file)
  - Deps: none
  - Integration: none (file is self-contained; no sibling workflow touched)

Critical path: W1 only. Max width: 1.

---

## Decision Log

| DEC-ID | Rationale |
|--------|-----------|
| `DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001` | Add advisory, content-keyed fast-skip, push:main + workflow_dispatch-triggered lane with 60-min timeout running `closer-parity-as.test.ts`. Mirror `wave-3-parity.yml` structurally; differ only in: file scope (single-test vitest invocation), timeout (60 vs 30 min), triggers (adds workflow_dispatch), cache-marker path, and narrower source-hash file list. Honors DEC-CI-MERGE-GATE-ENFORCE-001 (not gating), DEC-CI-FAST-PATH-PHASE-1-005 (no `pull_request:`), and the test's own 3,600,000 ms hookTimeout. |

References (do NOT amend; cited for context):
- `DEC-CI-MERGE-GATE-ENFORCE-001` — long tests must not gate PR merges.
- `DEC-CI-FAST-PATH-PHASE-1-005` — no `pull_request:` trigger for long suites.
- `DEC-CI-FAST-PATH-PHASE-3-001` — fast-skip cache pattern.
- `DEC-CI-OFFLINE-004` — pnpm `packageManager` authority (no `with: version:`).
- `DEC-AS-CLOSER-PARITY-CONCURRENCY-001` — `computeAscConcurrency()` and CI=4 default.
- `DEC-AS-COMPILE-CACHE-001` — `cachedAsEmit()` content-addressed cache.

---

## Rollback boundary

`git revert` the single landing commit. The new workflow file is removed.
No source/test changes were touched, so the rollback is mechanical with
zero blast radius. The fast-skip cache entries created in GitHub Actions
cache storage will age out via standard 7-day eviction; no manual cleanup
needed.

