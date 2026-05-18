# wi-631-stage-b — Stage B: checked-in seed cache at `bootstrap/as-cache-seed/`

- Workflow ID: `wi-631-stage-b`
- Goal ID:    `g-wi631b`
- Work Item:  `wi-631b-planning` (planner stage) → implementer slice
- Branch:     `feature/wi-631-stage-b`
- Closes:     partial #631 (Stage B; Stage A landed in PR #693 / commit `e50291a`)
- Cross-ref:  #485 (parent — cold-run wall-clock problem),
              DEC-AS-COMPILE-CACHE-001 (content-addressed cache key),
              DEC-AS-COMPILE-CACHE-002 (on-disk shard at `tmp/yakcc-as-cache/`),
              DEC-AS-WASM-CACHE-CI-001 (Stage A CI cache step, PR #693),
              DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001 (the workflow we are amending),
              `plans/wi-631-as-wasm-cache.md` (Stage A planning record)
- Status:     implemented (awaiting reviewer; seed generation in progress 2026-05-18)

---

## Identity

This is the planning record for **Stage B** of #631: committing a static seed
of pre-compiled wasm shards at `bootstrap/as-cache-seed/` so that even a CI
runner with zero actions/cache history still starts the closer-parity-as job
with a populated `tmp/yakcc-as-cache/` directory.

Stage B is the **commit-zero unblock** for #631's chicken-and-egg problem:
Stage A (PR #693) added `actions/cache@v4` for `tmp/yakcc-as-cache/`, but a
fresh repo / fresh runner / first-ever post-merge run on a brand new commit
still has no cache hit. With operator-cancelled main-side runs (observed
2026-05-18 — see #485 thread and run-history captured below), the cache may
**never** populate on its own. Stage B removes that dependency by shipping a
working seed in git.

Stage A is preserved verbatim; this slice is purely additive (new directory +
one new step at the top of the existing CI cache region).

---

## Problem Statement

### Who has this problem

- The `closer-parity-as` workflow on every fresh runner / fresh repo clone.
- Stage A's `actions/cache@v4` cannot produce a hit until at least one full
  cold run has previously succeeded and saved a cache. Operator-cancelled
  runs (see "Operational observation" below) starve that pre-requisite.
- Developers running `closer-parity-as.test.ts` locally with an empty
  `tmp/yakcc-as-cache/` (e.g. fresh `git clone`, fresh laptop, after `rm -rf
  tmp/`). Stage B benefits them too because the same on-disk format is used
  locally and in CI.

### How often

- Every CI runner that misses the actions/cache key (a new key prefix, a
  branch with no cache history, a runner whose cache was evicted by GitHub
  LRU). With ~80 PR/main churns per week and a single fresh-runner condition
  per WORKFLOW_KEY rotation, this is "every cold push" until Stage B lands.
- Every fresh developer clone or `rm -rf tmp/` in a worktree.

### What's the cost

- Without Stage B: the first cold run on any commit must compile all 4119
  atoms sequentially through asc (per-atom child-process fan-out, bounded by
  `computeAscConcurrency()`). Per the test docstring (L364):
  `3_600_000ms` (60-minute) `beforeAll` budget. The 60-min `timeout-minutes`
  at L53 of `closer-parity-as.yml` mirrors that. Operator-cancelled runs
  preempt the run **before** it can write a fresh `actions/cache` save, so
  Stage A's cache stays empty across cancelled runs.
- With Stage B: even a cancelled cold-run path still pays only `compile
  (changed atoms only)` because the seed pre-populates the cache directory
  before asc would be invoked. Per the #631 issue body: "Even on a fresh CI
  runner with no actions/cache hit, the seed reduces cold work by ~80%+ on
  typical commits."

### Operational observation (2026-05-18, current session)

Run history for `closer-parity-as.yml` (`gh run list --workflow=closer-parity-as.yml --limit 10`):

| HEAD SHA  | Title                                                                      | Outcome   |
|-----------|-----------------------------------------------------------------------------|-----------|
| `cd39d22` | fix(shave): #666 …                                                          | pending   |
| `8ce865e` | fix(bench/B10): #691 …                                                      | cancelled |
| `e50291a` | ci(closer-parity-as): WI-631 Stage A — actions/cache for tmp/yakcc-as-cache/ | cancelled |
| `0735838` | docs(ci): #651 Option B …                                                   | cancelled |
| `7752542` | docs: WI-656 Slice 3 …                                                      | cancelled |
| `c5b5dde` | feat(cli): WI-656 Slice 2 …                                                 | (active)  |
| `03c566e` | fix(bench/B10): #679 …                                                      | cancelled |
| `8b4b19e` | fix(bench/B9): #680 …                                                       | cancelled |
| `393d278` | feat(cli): WI-656 Slice 1 …                                                 | cancelled |
| `33f31c1` | data(registry): #624 …                                                      | cancelled |

Even the post-merge run on the commit that **landed Stage A** (`e50291a`) was
cancelled before it could populate the cache. Stage A's `actions/cache@v4`
restore step never produced a saved cache to restore in subsequent runs.
This is precisely the failure mode Stage B exists to eliminate: a seed
committed in git is unconditional — no run needs to succeed for the seed to
be present.

### Goals (measurable)

- **G1** — A new directory `bootstrap/as-cache-seed/` exists in git and
  contains content-addressed wasm shards in the **exact on-disk layout**
  produced by `packages/compile/src/as-compile-cache.ts` (`<key[0..3]>/<key>.wasm`
  per DEC-AS-COMPILE-CACHE-002, line 134). No format invention.
- **G2** — The directory is regenerable: a one-shot generator script
  (`scripts/build-as-cache-seed.mjs`) reads the current corpus via the same
  `regenerateCorpus()` loader used by `closer-parity-as.test.ts` and produces
  the seed bytes by calling the **same** `cachedAsEmit()` API path. The
  generator's only output is the seed directory; it does NOT mutate any
  package source.
- **G3** — `.github/workflows/closer-parity-as.yml` gains exactly **one** new
  step (`Seed AS wasm shard cache from bootstrap/`) placed **before** the
  existing `Restore AS wasm shard cache` step. The step copies
  `bootstrap/as-cache-seed/` into `tmp/yakcc-as-cache/`. Stage A's restore
  step then overlays any actions/cache hit on top, so:
  - cold runs see seed
  - warm runs see seed ⊕ actions/cache (cache wins on key collision because
    `cp -rn` is used — see DEC-AS-WASM-SEED-COPY-MODE-001 below).
- **G4** — Total committed seed size is within an **explicit size budget**
  recorded in the plan and validated by the implementer's first action. If
  the budget is exceeded, the slice degrades to **Option B** (curated subset)
  per the alternatives below — without requiring a re-plan.
- **G5** — Inline `@decision DEC-AS-WASM-SEED-001` annotation in the workflow
  next to the new step, plus matching annotations in the generator script
  header and at the top of any documentation in `bootstrap/as-cache-seed/`.
- **G6** — No source change in `packages/compile/src/as-compile-cache.ts`
  unless the implementer's size-budget probe (Phase 0 below) reveals an
  actual incompatibility. The shard layout already documented at L128-138
  (`<root>/<key[0..3]>/<key>.wasm`) is the contract Stage B writes to.

### Non-goals (explicit)

- **NG1** — Do **not** modify `timeout-minutes: 60` (DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001).
  That is #633.
- **NG2** — Do **not** modify `runs-on: ubuntu-latest`. That is #632.
- **NG3** — Do **not** modify Stage A's `Restore AS wasm shard cache` step
  (lines 113-127 of `closer-parity-as.yml` post-PR-#693). Stage B is additive
  only; the new seed step sits BEFORE it.
- **NG4** — Do **not** edit `MASTER_PLAN.md` ([operator directive][orch]:
  MASTER_PLAN amend is orchestrator scope, not implementer scope).
- **NG5** — Do **not** touch `packages/registry/**`, `packages/shave/**`,
  `packages/contracts/**`, `packages/ir/**`, `packages/seeds/**`, or
  `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts`. The corpus
  source is read-only here; mutating it would invalidate the seed at the
  moment of generation.
- **NG6** — Do **not** add a `pull_request` trigger to `closer-parity-as.yml`.
- **NG7** — Do **not** mock `asc`. Real `node_modules/.pnpm/.../asc` only,
  invoked via the same `assemblyScriptBackend().emit()` path the production
  test uses. Pinned by `pnpm-lock.yaml`.
- **NG8** — Do **not** vendor `assemblyscript` or check in its node_modules.
- **NG9** — Do **not** add Git LFS configuration. The size budget (G4 below)
  is explicitly chosen to fit inside ordinary git without LFS, mirroring the
  existing `bootstrap/expected-roots.json` (2.7 MB) precedent.
- **NG10** — Do **not** remove or alter Stage A's `actions/cache@v4` step.
  Stage B complements it; both ship together.

[orch]: ../.claude/projects/-home-claude-yakcc/memory/master_plan_amend_orchestrator.md

### Unknowns / ambiguities

The **size budget** is the dominant unknown. The implementer's Phase 0
(below) is required to MEASURE before committing the full seed. Three
authority sources informed the budget targets:

- **Reference precedent:** `bootstrap/expected-roots.json` = 2.7 MB on
  disk, already committed. The repo already pays this cost class for the
  bootstrap-data role.
- **Asc output shape:** flags `--optimize --runtime stub --noExportMemory`
  (CANONICAL_ASC_FLAGS at L88 of `as-compile-cache.ts`) deliberately produce
  small wasm — stub runtime, no GC, no exported memory. Single-function
  modules typically land in the 200-500 B range; complex string-touching
  atoms can reach 1-2 KB.
- **Atom count:** corpus is 4119 atoms (per test docstring L364 and
  `bootstrap/CORPUS_STATS.md` showing 1889 current-shave + 3807 monotonic
  superset; the test runs the regenerated current set).

**Phase 0 implementer task:** measure actual per-atom wasm size on a
representative sample and total seed size on the full corpus. Three
outcomes:

- ≤ 5 MB total → ship Option A (full seed).
- 5-20 MB total → ship Option A with a `.gitattributes eol=lf binary` row
  and an explicit comment in `bootstrap/as-cache-seed/README.md` noting
  the size; still no LFS.
- &gt; 20 MB total → degrade to **Option B** (curated stable subset). See
  "Alternatives" below; degradation path is pre-approved by this plan.
- &gt; 50 MB total or any single shard &gt; 1 MB → STOP and emit
  `PLAN_VERDICT: blocked_by_plan` with measurements. Re-plan needed.

### Dominant constraints

- **Content-addressing means stable atoms cost zero git churn.** Per
  DEC-AS-COMPILE-CACHE-001, cache key is sha256(atomHash | ascVersion |
  ascFlagsHash). An atom whose source is unchanged produces a byte-identical
  shard at the same path. So Option A (commit all 4119) is the right
  default: rebuilds add new files for changed atoms; unchanged atoms produce
  zero diff.
- **Format compatibility is contractual.** The shard layout
  `<root>/<key[0..3]>/<key>.wasm` is defined by `shardPaths()` in
  `as-compile-cache.ts` L132-138. Stage B writes to that exact layout;
  `readWasm()` at L176-206 reads it back unmodified. No code change needed
  if the seed conforms.
- **CI step order matters.** The seed copy MUST run before Stage A's
  `Restore AS wasm shard cache` so actions/cache hit overlays the seed
  (newer cached files take precedence). It MUST run after `Checkout` so the
  repo's `bootstrap/as-cache-seed/` directory exists. It MUST share the
  same `if: steps.verified-cache.outputs.cache-hit != 'true'` guard so
  verified-marker hits remain pure skips.
- **Generator hermeticity.** The generator must produce deterministic
  bytes — same corpus + same asc version = same wasm. Per DEC-AS-COMPILE-CACHE-001,
  this is already the case for the cache module; the generator simply
  invokes the same path.
- **No new package, no new test file, no new workflow.** This slice adds
  one directory of data, one script, one workflow step, one plan, and one
  README in the seed directory. Five surface-area items max.

---

## Architecture Design

### State authority map

| Domain                                              | Authority                                                                                              | Touched by this slice?       |
|-----------------------------------------------------|--------------------------------------------------------------------------------------------------------|------------------------------|
| Atom source → wasm bytes (cache module)             | `packages/compile/src/as-compile-cache.ts` (DEC-AS-COMPILE-CACHE-001/-002)                            | NO (consumer only)           |
| On-disk shard layout `<root>/<key[0..3]>/<key>.wasm` | `shardPaths()` in `as-compile-cache.ts` L128-138                                                       | NO (we conform to it)        |
| Cache root path (`<repoRoot>/tmp/yakcc-as-cache/`)  | `defaultCacheDir()` in `as-compile-cache.ts` L117-126                                                  | NO (we seed it; do not move) |
| Corpus regeneration (atom inputs)                   | `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts` → `regenerateCorpus()`                      | NO (read-only consumer)      |
| Asc version / flag pin                              | `pnpm-lock.yaml` (assemblyscript pin) + CANONICAL_ASC_FLAGS at `as-compile-cache.ts` L88              | NO (we read both)            |
| Verified-marker fast-skip cache                     | `tmp/closer-parity-as/.verified-marker` (Stage A workflow)                                             | NO (peer cache, unchanged)   |
| CI-side persistence (`tmp/yakcc-as-cache/` restore) | Stage A: `actions/cache@v4` step (DEC-AS-WASM-CACHE-CI-001, PR #693)                                   | NO (preserved verbatim)      |
| **NEW: checked-in seed at `bootstrap/as-cache-seed/`** | THIS SLICE — generator + directory + workflow seed-copy step (DEC-AS-WASM-SEED-001 + -002 + -003) | **YES**                      |

### Decisions

#### DEC-AS-WASM-SEED-001 — Commit a checked-in wasm seed at `bootstrap/as-cache-seed/`

- **Status:** accepted
- **Rationale:**
  - Stage A (DEC-AS-WASM-CACHE-CI-001) is necessary but insufficient: the
    cache cannot populate if cold runs are cancelled before completion. The
    2026-05-18 run history above (run table) confirms this happens routinely.
  - Content-addressed names mean stable atoms cost zero git churn. A
    full-corpus seed at ≤ a few MB sits in the same cost class as
    `bootstrap/expected-roots.json` (2.7 MB), already an accepted committed
    artifact.
  - The seed directory IS the cache root format. No translation layer; no
    new code in `as-compile-cache.ts`. The shard files are produced by the
    same `cachedAsEmit()` path that production uses, so any future change to
    the cache format invalidates the seed in lockstep with the consumer.
  - Location `bootstrap/` follows existing precedent for "data the project
    needs to verify itself": `expected-roots.json`, `expected-failures.json`,
    `CORPUS_STATS.md` all live there.

#### DEC-AS-WASM-SEED-002 — Generator script at `scripts/build-as-cache-seed.mjs`, invoked manually

- **Status:** accepted
- **Rationale:**
  - The seed is regenerated **out of band**, not on every CI run. A CI step
    that compiles 4119 atoms to refresh the seed defeats the entire point of
    Stage B (we'd be paying the cost we wanted to amortize).
  - Manual operator invocation matches the existing `yakcc bootstrap`
    pattern: data files in `bootstrap/` are produced by `yakcc bootstrap`,
    committed, and re-run when the operator chooses (e.g. after an asc
    version bump in `pnpm-lock.yaml`).
  - The script is a thin orchestrator: imports `regenerateCorpus`,
    `assemblyScriptBackend`, and `cachedAsEmit` directly, sets
    `YAKCC_AS_CACHE_DIR` to a staging directory, walks the corpus, and rsyncs
    the output to `bootstrap/as-cache-seed/`. ≤ 100 lines.
  - Located under `scripts/` (existing project convention) rather than
    `packages/compile/src/` because it's an operator tool, not library code.

#### DEC-AS-WASM-SEED-003 — Workflow seed-copy step BEFORE Stage A's actions/cache restore

- **Status:** accepted
- **Rationale:**
  - Step order: `Checkout` → **NEW: seed copy** → Stage A restore →
    pnpm/build → run test → cache save (auto).
  - On cold cache (Stage A miss): test sees `tmp/yakcc-as-cache/` already
    populated by the seed. ~80%+ of atoms hit; ~20% miss-and-compile;
    `actions/cache@v4` saves the post-test state for next run.
  - On warm cache (Stage A hit): the restore step overwrites seed files
    with cached files when keys collide. Per DEC-AS-WASM-SEED-COPY-MODE-001
    (below) we use `cp -r --no-clobber` so the seed acts as a floor: any
    file already present from the cache is preserved; only missing files are
    populated by the seed. This means Stage A's cache always wins on
    collision (it's at least as fresh as the seed).
  - The same `if: steps.verified-cache.outputs.cache-hit != 'true'` guard
    that Stage A uses applies to the seed step — verified-marker hits skip
    everything in the slow path, including seed copy. This preserves the
    DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001 fast-skip purity.

#### DEC-AS-WASM-SEED-COPY-MODE-001 — Use `cp -rn` (no-clobber) for seed copy

- **Status:** accepted
- **Rationale:**
  - `cp -rn` (or `cp -r --no-clobber`) ensures Stage A's actions/cache hit
    is never overwritten by a stale seed file. The seed only fills holes;
    the cache wins ties.
  - Atomic-rename concerns (DEC-AS-COMPILE-CACHE-006) do not apply because
    the seed copy runs before any concurrent `cachedAsEmit()` invocations.
    The CI job is single-process for this phase; no inflight writes to race
    against.
  - `rsync --ignore-existing` is an acceptable equivalent. Plain `cp -r`
    (overwriting) is rejected because a seed committed N weeks ago may be
    older than what actions/cache last saved; overwriting would regress
    freshness.

### Alternatives considered

- **Option B — Commit only N most-stable atoms (curated subset).**
  Considered. This is the **pre-approved fallback** if Phase 0 measurement
  shows the full-corpus seed exceeds 20 MB. Mechanism: the generator script
  accepts `--max-bytes <N>` and selects atoms in descending order of
  historical stability (last-N-commits with no source-hash change). Plan
  approves degrading to Option B without re-plan as long as: (a) coverage
  ≥ 50% of corpus, and (b) total ≤ 20 MB, and (c) the README under
  `bootstrap/as-cache-seed/` records the selection rationale.

- **Option C — Hash-only seed, lazy-fetch from artifact storage.**
  Rejected. This is essentially "Stage A done better" — it still requires a
  prior successful run to populate the artifact, recreating the
  chicken-and-egg. Defeats the purpose.

- **Implement Stage B inside `as-compile-cache.ts` (new "seed loader" API).**
  Rejected. The shard layout IS the seed format; the on-disk cache module
  already reads `<root>/<key[0..3]>/<key>.wasm` files unconditionally. A
  seed loader would be a parallel mechanism (Sacred Practice #12 violation:
  single source of truth). The right factoring is: the cache module reads
  files from disk; CI provisions the files; whether they came from
  actions/cache or a checked-in seed is invisible to the consumer.

- **Use Git LFS for the seed.** Rejected (NG9). The size budget chosen
  (≤ 20 MB hard cap) fits inside ordinary git. LFS would add operator
  burden (LFS install on every clone, CI runner setup) for no proportional
  benefit. If Phase 0 reveals the seed must exceed 20 MB to be useful,
  we re-plan rather than introduce LFS.

- **Symlink `tmp/yakcc-as-cache/` to `bootstrap/as-cache-seed/`.**
  Rejected. The cache writes new files during a run (the misses); a symlink
  would mutate the committed seed directory. We need a copy semantic so the
  seed stays pristine in git.

- **Hash-key the seed at top-level (`bootstrap/as-cache-seed/<key>.wasm`
  flat, no shards).** Rejected. The cache module's `shardPaths()` reads
  `<root>/<key[0..3]>/<key>.wasm`. A flat seed would force a translation
  step (move/rename on copy), and the cache module's writes would
  immediately diverge layout. Conformance to the existing shard layout is
  required by DEC-AS-COMPILE-CACHE-002.

---

## Wave Decomposition

Single work item with an internal Phase 0 measurement step that gates Phase 1
scope.

### W-WI631-B1 — Generate seed + wire CI seed-copy step

- **Weight:** M
- **Gate:** review (seed contents + workflow yaml are both load-bearing for
  CI cold-run economics and for ongoing repo size growth)
- **Deps:** none (Stage A is already merged in `e50291a`)
- **Integration:**
  - `bootstrap/as-cache-seed/**` (new directory; primary deliverable)
  - `bootstrap/as-cache-seed/README.md` (new; documents the seed)
  - `scripts/build-as-cache-seed.mjs` (new; the generator)
  - `.github/workflows/closer-parity-as.yml` (one new step)
  - `plans/wi-631-stage-b.md` (this file; status update)

#### Phase 0 — Measurement (BLOCKING — must complete first)

The implementer runs the generator end-to-end against the current corpus
**before** committing any wasm to `bootstrap/as-cache-seed/`. Outputs:

1. Per-atom size histogram (min / p50 / p95 / max).
2. Total seed directory size.
3. Total atom count (should be ~4119 ±).
4. Asc version (from `pnpm-lock.yaml` resolved entry, MUST match
   `ASC_VERSION` at L96-101 of `as-compile-cache.ts`).
5. Generator wall-clock time (informational; not a gate).

Decision gate (apply in order):

- Total ≤ 5 MB → ship Option A (full seed). Continue to Phase 1.
- 5 MB &lt; Total ≤ 20 MB → ship Option A; add `.gitattributes` row
  `bootstrap/as-cache-seed/**/*.wasm binary` and a sized-noted comment in
  `bootstrap/as-cache-seed/README.md`. Continue to Phase 1.
- 20 MB &lt; Total ≤ 50 MB → degrade to Option B; generator passes
  `--max-bytes 20971520` (20 MB hard cap), selects atoms by stability rank.
  README records selection rationale + coverage %. Continue to Phase 1.
- Total &gt; 50 MB **or** any single shard &gt; 1 MB → STOP. Emit
  `PLAN_VERDICT: blocked_by_plan` with measurements + a one-paragraph
  recommendation (e.g., "shrink corpus first via #XXX" or "raise budget
  with operator approval").

#### Phase 1 — Generator + seed

1. Create `scripts/build-as-cache-seed.mjs`. Header includes
   `@decision DEC-AS-WASM-SEED-002` annotation.
2. The script:
   - resolves `repoRoot` (process.cwd() + `git rev-parse --show-toplevel`
     fallback)
   - sets `process.env.YAKCC_AS_CACHE_DIR` to a staging path under
     `tmp/wi-631-stage-b/staging-cache/` (NOT inside `bootstrap/`; rsync at
     end)
   - invokes `regenerateCorpus()` from
     `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts` via
     dynamic ESM import (this is the same authority the test uses)
   - constructs an `assemblyScriptBackend()` and walks atoms with
     `cachedAsEmit()` in serial (concurrency is acceptable but serial keeps
     output deterministic for the seed generator role)
   - on completion, `rsync -a --delete <staging> bootstrap/as-cache-seed/`
   - prints the Phase 0 measurement output to stdout (so re-running the
     generator post-merge re-confirms the budget)
3. The script supports `--max-bytes <N>` for Option B degradation.

#### Phase 2 — Seed directory

1. After Phase 0 passes the budget gate, the generator's output IS the
   committed content. Add to git, all the way down.
2. Add `bootstrap/as-cache-seed/README.md`:
   - what this is (links to DEC-AS-WASM-SEED-001)
   - how to regenerate (`pnpm node scripts/build-as-cache-seed.mjs`)
   - when to regenerate (after asc version bumps; after corpus shape
     changes that affect ≥ 10% of atoms; otherwise drift is fine because
     unchanged atoms produce zero diff)
   - Phase 0 measurements at time of commit (total bytes, atom count,
     asc version, p50/p95 size)
3. Add `.gitattributes` entry: `bootstrap/as-cache-seed/**/*.wasm binary`
   so git treats them as binary (no diff noise, no text-mode line-ending
   munging — preempts a class of bug analogous to DEC-BENCH-B8-SHA-001).

#### Phase 3 — Workflow seed-copy step

Insert into `.github/workflows/closer-parity-as.yml`, positioned **after**
`Restore verified-marker cache` (currently L93-100) and **before**
`Restore AS wasm shard cache` (currently L120-127). Exact text:

```yaml
      # -----------------------------------------------------------------------
      # Seed AS wasm shard cache from checked-in bootstrap/ (WI-631 Stage B).
      #
      # This step copies bootstrap/as-cache-seed/* into tmp/yakcc-as-cache/
      # so cold runs (no actions/cache hit) start with a populated cache.
      # The next step (Stage A restore) overlays any actions/cache hit on
      # top; --no-clobber ensures the cache (potentially fresher than the
      # committed seed) wins on collision.
      # @decision DEC-AS-WASM-SEED-001
      # @decision DEC-AS-WASM-SEED-003
      # @decision DEC-AS-WASM-SEED-COPY-MODE-001
      # -----------------------------------------------------------------------
      - name: Seed AS wasm shard cache from bootstrap/
        if: steps.verified-cache.outputs.cache-hit != 'true'
        run: |
          mkdir -p tmp/yakcc-as-cache
          if [ -d bootstrap/as-cache-seed ]; then
            cp -rn bootstrap/as-cache-seed/. tmp/yakcc-as-cache/
            echo "Seeded $(find tmp/yakcc-as-cache -name '*.wasm' | wc -l) wasm shard(s) from bootstrap/as-cache-seed/"
          else
            echo "bootstrap/as-cache-seed/ not present; skipping seed copy"
          fi
```

The `if [ -d ... ]` guard means Stage B is forward-compatible with branches
that have not yet been rebased onto the post-merge main — the step is a
no-op when the seed directory does not exist.

#### Phase 4 — Plan status update + decision-log row

Append to this file (Decision Log section below) any in-flight clarifications
the implementer makes. Set status to `implemented` in the front matter when
the PR opens.

#### What this slice MUST NOT do

- Must NOT modify `as-compile-cache.ts` (NG6 plus DEC-AS-COMPILE-CACHE-002
  conformance: the layout is the contract).
- Must NOT modify any other workflow.
- Must NOT modify `corpus-loader.ts` or any `packages/` source.
- Must NOT add a `pull_request` trigger.
- Must NOT delete or modify Stage A's `Restore AS wasm shard cache` step.
- Must NOT use `cp -r` (overwriting) — see DEC-AS-WASM-SEED-COPY-MODE-001.
- Must NOT use Git LFS (NG9).
- Must NOT add `bootstrap/as-cache-seed/` to `.gitignore`.

---

## Scope Manifest

- **Allowed paths:**
  - `bootstrap/as-cache-seed/**`
  - `bootstrap/as-cache-seed/README.md`
  - `scripts/build-as-cache-seed.mjs`
  - `.github/workflows/closer-parity-as.yml`
  - `.gitattributes` (additive only — one new row for the wasm binary marker)
  - `plans/wi-631-stage-b.md`
- **Required paths (must be modified or created):**
  - `bootstrap/as-cache-seed/` (new directory with ≥ 1 wasm shard, modulo
    Phase 0 budget outcome)
  - `bootstrap/as-cache-seed/README.md` (new file)
  - `scripts/build-as-cache-seed.mjs` (new file)
  - `.github/workflows/closer-parity-as.yml` (one new step inserted at the
    documented location)
  - `.gitattributes` (one new row)
  - `plans/wi-631-stage-b.md` (this file; status update on landing)
- **Forbidden paths (touching these is a scope violation):**
  - `MASTER_PLAN.md` (NG4)
  - `packages/compile/src/as-compile-cache.ts` (NG6 + DEC-AS-COMPILE-CACHE-002
    conformance)
  - `packages/compile/src/as-backend.ts`
  - `packages/compile/src/as-parity-runner.ts`
  - `packages/compile/test/as-backend/closer-parity-as.test.ts`
  - `packages/registry/**`
  - `packages/shave/**`
  - `packages/contracts/**`
  - `packages/ir/**`
  - `packages/seeds/**`
  - `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts`
  - `examples/v1-wave-3-wasm-lower-demo/test/shave-cache.json`
  - `examples/v1-wave-3-wasm-lower-demo/test/pending-atoms-as.json`
  - All other `.github/workflows/*.yml` files (besides `closer-parity-as.yml`)
  - All `docs/**`
  - `plans/wi-631-as-wasm-cache.md` (Stage A plan; preserved verbatim)
- **State authorities touched:**
  - **NEW:** `bootstrap/as-cache-seed/` (checked-in seed for the on-disk
    shard cache). Owner: DEC-AS-WASM-SEED-001. Generator: DEC-AS-WASM-SEED-002.
  - **NEW:** workflow seed-copy step in `closer-parity-as.yml`. Owner:
    DEC-AS-WASM-SEED-003.
  - No SQLite tables touched. No runtime hooks touched. No
    orchestrator/policy surfaces touched.

---

## Evaluation Contract

### Required checks (acceptance evidence)

- **EC-1 — YAML validity.** `.github/workflows/closer-parity-as.yml`
  parses without errors. Verify with
  `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/closer-parity-as.yml`
  or `gh workflow list` after push.
- **EC-2 — Correct insertion point.** The new
  `Seed AS wasm shard cache from bootstrap/` step appears **after**
  `Restore verified-marker cache` and **before**
  `Restore AS wasm shard cache`. Verify with
  `grep -n "Seed AS wasm shard cache from bootstrap\|Restore verified-marker cache\|Restore AS wasm shard cache" .github/workflows/closer-parity-as.yml`
  and check line ordering.
- **EC-3 — Skip-when-verified guard present.** The new step has
  `if: steps.verified-cache.outputs.cache-hit != 'true'`.
  `grep -A 2 "Seed AS wasm shard cache from bootstrap" .github/workflows/closer-parity-as.yml`
  shows the `if:` line.
- **EC-4 — Decision annotations inline.** The block above the new step
  references `DEC-AS-WASM-SEED-001`, `DEC-AS-WASM-SEED-003`, and
  `DEC-AS-WASM-SEED-COPY-MODE-001`.
  `grep -c "DEC-AS-WASM-SEED-" .github/workflows/closer-parity-as.yml` ≥ 3.
- **EC-5 — Copy mode is no-clobber.** The step uses `cp -rn` (or
  `cp -r --no-clobber`), **not** plain `cp -r`. Verify by inspecting the
  step body.
- **EC-6 — Seed directory present and shaped correctly.** `find
  bootstrap/as-cache-seed -mindepth 2 -maxdepth 2 -name "*.wasm" | wc -l` ≥ 1.
  Every wasm file path matches the regex
  `bootstrap/as-cache-seed/[0-9a-f]{3}/[0-9a-f]{64}\.wasm` (mirrors
  `shardPaths()` at `as-compile-cache.ts` L132-138). Verify by
  `find bootstrap/as-cache-seed -name "*.wasm" | grep -vE '^bootstrap/as-cache-seed/[0-9a-f]{3}/[0-9a-f]{64}\.wasm$'`
  returns empty.
- **EC-7 — Every shard is valid WASM.** For every wasm file, the first 4
  bytes are `\0asm` (magic `0x00 0x61 0x73 0x6d`, mirrors the validation in
  `readWasm()` at L200 of `as-compile-cache.ts`). Verify with a one-liner
  shell loop over `find bootstrap/as-cache-seed -name '*.wasm'`.
- **EC-8 — Seed size budget.** `du -sb bootstrap/as-cache-seed | awk
  '{print $1}'` ≤ 20971520 (20 MB) absolute hard cap. Implementer records
  actual measurement in the README. Reviewer verifies on diff.
- **EC-9 — Generator script exists and is invokable.**
  `scripts/build-as-cache-seed.mjs` exists; its header includes
  `@decision DEC-AS-WASM-SEED-002`; `node scripts/build-as-cache-seed.mjs --help`
  exits 0 and prints usage text.
- **EC-10 — README exists with required sections.**
  `bootstrap/as-cache-seed/README.md` exists and contains the substrings
  `DEC-AS-WASM-SEED-001`, `pnpm node scripts/build-as-cache-seed.mjs`,
  `asc version`, and a `Size budget` section with the Phase 0 measurements.
- **EC-11 — `.gitattributes` updated.** Contains a row matching
  `bootstrap/as-cache-seed/.*\.wasm binary`. Verify with
  `grep "bootstrap/as-cache-seed.*binary" .gitattributes`.
- **EC-12 — Scope compliance.** `git diff --name-only origin/main...HEAD`
  contains only paths from the Allowed list above. `git diff --name-only
  origin/main...HEAD -- packages/` is empty. `git diff --name-only
  origin/main...HEAD -- MASTER_PLAN.md` is empty.
- **EC-13 — Stage A preservation.** `git diff origin/main...HEAD --
  .github/workflows/closer-parity-as.yml` shows only **additions** in the
  Stage A region (lines around L113-127 of post-PR-#693 main). The exact
  text of `Restore AS wasm shard cache` (path, key, restore-keys, if guard)
  is byte-identical to `origin/main`.
- **EC-14 — Untouched legacy steps.** The exact text of `Compute source
  hash`, `Restore verified-marker cache`, `Skip — already verified for this
  source state`, `Set up pnpm`, `Set up Node.js`, `Install dependencies`,
  `Build all packages`, `Run closer-parity-as`, and `Write verified-marker`
  is byte-identical to `origin/main`. Verify by running the diff above and
  checking that no lines inside those step bodies appear with `-` or `+`
  markers (outside whitespace).
- **EC-15 — PR-side CI green.** The 5 required pr-ci checks pass:
  `lint`, `typecheck`, `build`, `branch-hygiene`, `B6a air-gap`.
  Pre-existing main-side failures unrelated to workflow yaml are tolerated.

### Required real-path checks

- **RPC-1 — Smoke check seed loading locally.** After the PR is cut, the
  implementer or reviewer runs (in the worktree):

  ```bash
  rm -rf tmp/yakcc-as-cache
  cp -r bootstrap/as-cache-seed tmp/yakcc-as-cache
  pnpm --filter @yakcc/compile test -- test/as-backend/closer-parity-as.test.ts 2>&1 | grep "\[as-cache\]"
  ```

  Expected: `[as-cache] hits=<N> misses=<M> disabled=0` where `N >= 0.5 *
  (N + M)` (seed provides ≥ 50% hit rate on current main; in practice much
  higher because the corpus has not churned between seed generation and
  test run).

  **This is a real-path check, not a CI check.** It runs locally in the
  implementer worktree. If `N == 0` (all misses), the seed is the wrong
  format — block on EC-6/EC-7 and re-investigate.

- **RPC-2 — Post-merge closer-parity-as observation.** The first
  post-merge run of `closer-parity-as.yml` on the merged commit is the
  ultimate evidence. PR landing does NOT gate on it (per Stage A's
  EC-precedent). Observe and record in the PR thread or a follow-up
  comment on #631.

### Required authority invariants

- **DEC-AS-COMPILE-CACHE-001** (content-addressed cache key) — preserved
  (no source change; the seed files are produced via this exact key
  derivation in the generator).
- **DEC-AS-COMPILE-CACHE-002** (on-disk shard layout `<root>/<key[0..3]>/<key>.wasm`)
  — preserved AND **enforced by EC-6**. Any seed file not matching that
  layout is rejected.
- **DEC-AS-COMPILE-CACHE-006** (atomic-write via renameWithRetry) — not
  applicable to the seed; the seed is written once at generation time, never
  touched at runtime.
- **DEC-AS-WASM-CACHE-CI-001** (Stage A) — preserved verbatim. EC-13
  verifies byte-identity.
- **DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001** — preserved structurally; one
  new step added; triggers, runner, timeout, concurrency unchanged.
- **DEC-CI-CLOSER-PARITY-NO-CANCEL-001** — preserved
  (`cancel-in-progress: false` untouched).
- **DEC-CI-MERGE-GATE-ENFORCE-001** — preserved (no `pull_request` trigger
  added).
- **DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001** — N/A; the seed is regenerable,
  not accumulated. The README explicitly notes regeneration is acceptable
  and the seed is allowed to shrink as well as grow.

### Required integration points

- **Stage A's `Restore AS wasm shard cache` step (preserved).** Stage B's
  seed step runs BEFORE Stage A's restore so cache hits overlay the seed.
- **Verified-marker fast-skip cache (preserved).** Stage B's seed step shares
  the `if: steps.verified-cache.outputs.cache-hit != 'true'` guard.
- **`pnpm install --frozen-lockfile` and `pnpm -r build` (preserved order).**
  Both still come AFTER the seed copy + Stage A restore.
- **`packages/compile/src/as-compile-cache.ts` (no edit).** The seed
  conforms to its on-disk read format (`readWasm()` at L176-206); no API
  change needed.
- **`examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts` (read-only
  consumer in the generator).** The generator imports `regenerateCorpus()`
  and uses it as the corpus authority — same as the test. No edit.

### Forbidden shortcuts

- Do NOT generate the seed inside CI on every run (NG defeats the
  amortization story; DEC-AS-WASM-SEED-002).
- Do NOT mock `asc` (NG7). Real binary only.
- Do NOT vendor `assemblyscript` (NG8).
- Do NOT use Git LFS (NG9).
- Do NOT modify `as-compile-cache.ts` to "improve" seed loading
  (Sacred Practice #12: single authority; the shard layout is the contract).
- Do NOT touch `timeout-minutes` (NG1) or `runs-on` (NG2).
- Do NOT use `cp -r` (overwriting) — see DEC-AS-WASM-SEED-COPY-MODE-001.
- Do NOT add seed regeneration to a CI cron / workflow_dispatch (that's a
  separate slice if ever needed).
- Do NOT edit `MASTER_PLAN.md` (NG4).
- Do NOT add a `pull_request` trigger to the workflow.

### Ready-for-guardian definition

Reviewer may declare `READY_FOR_GUARDIAN` iff **ALL** of the following hold:

1. EC-1 through EC-14 all pass on the implementer's worktree head.
2. EC-15 (PR-side CI green) is observed on the open PR.
3. RPC-1 (local smoke check) has been run by the implementer or reviewer
   and the captured `[as-cache] hits=N misses=M` line is recorded in the PR
   description, with `N >= 0.5 * (N + M)`.
4. `git diff --name-only origin/main...HEAD` matches the Scope Manifest
   exactly — no Forbidden paths present.
5. Phase 0 measurements are recorded in
   `bootstrap/as-cache-seed/README.md` AND the PR description.

If Phase 0 hits the &gt;50 MB / &gt;1 MB-per-shard ceiling, the implementer
emits `PLAN_VERDICT: blocked_by_plan` and stops; reviewer does NOT attempt to
salvage by reducing scope without a re-plan.

---

## Decision Log (new entries from this slice)

| DEC-ID                              | Title                                                                                                  | Status   | Rationale (one-line)                                                                                                                                                |
|-------------------------------------|--------------------------------------------------------------------------------------------------------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| DEC-AS-WASM-SEED-001                | Commit checked-in wasm seed at `bootstrap/as-cache-seed/` in the cache module's shard layout            | accepted | Eliminates the chicken-and-egg surviving Stage A: cancelled cold runs can no longer starve the cache. Sized to fit alongside `expected-roots.json` (2.7 MB precedent). |
| DEC-AS-WASM-SEED-002                | Seed generator lives at `scripts/build-as-cache-seed.mjs`; invoked manually, not in CI                  | accepted | Avoids paying full-corpus compile cost on every CI run (which would defeat the amortization). Matches the `yakcc bootstrap` pattern for `bootstrap/` artifacts.       |
| DEC-AS-WASM-SEED-003                | Workflow seed-copy step inserted BEFORE Stage A restore; shares `if: verified-cache.cache-hit != 'true'` guard | accepted | Cache hit overlays seed; both gated on verified-marker miss to preserve fast-skip purity (DEC-CI-CLOSER-PARITY-AS-WORKFLOW-001).                              |
| DEC-AS-WASM-SEED-COPY-MODE-001      | Seed copy uses `cp -rn` (no-clobber) so actions/cache always wins on collision                          | accepted | Seed is a floor (fills holes); cache is at-least-as-fresh and must win when both have a given key. Plain `cp -r` would regress freshness.                           |

(MASTER_PLAN.md Decision Log row insertion is orchestrator scope; not part
of this slice per NG4.)

---

## Continuation

After this slice merges:

- The next post-merge `closer-parity-as.yml` run on a non-verified-marker
  hash is observational evidence. Even if cancelled mid-flight, no harm:
  the seed is present from commit zero.
- **Seed refresh cadence:** the seed becomes stale gradually as the corpus
  evolves. Refresh is operator-triggered, not scheduled. Recommended
  triggers:
  - asc version bump in `pnpm-lock.yaml` (CANONICAL_ASC_FLAGS invariants
    apply; any change to the flags themselves also forces a refresh).
  - Observed seed hit-rate &lt; 50% in CI logs (the `[as-cache] hits=N
    misses=M` line in `Run closer-parity-as` step output).
  - Quarterly hygiene refresh during a low-activity window.
- #633 (timeout-minutes review) and #632 (larger runner) remain independent
  follow-ups, gated on evidence from this slice + Stage A combined.
- A future slice could add a CI step that warns when seed hit-rate drops
  below a threshold (informational only; no gate). Tracked separately if
  desired.

---

## Implementer onboarding notes

Read these before starting Phase 0:

1. `packages/compile/src/as-compile-cache.ts` lines 21-138 (DEC-AS-COMPILE-CACHE-001/002,
   `defaultCacheDir()`, `shardPaths()`).
2. `.github/workflows/closer-parity-as.yml` lines 91-127 (existing Stage A
   region).
3. `examples/v1-wave-3-wasm-lower-demo/test/corpus-loader.ts` lines 96-200
   (`regenerateCorpus()` API surface).
4. `plans/wi-631-as-wasm-cache.md` (Stage A plan; the structure here mirrors
   it intentionally).
5. `bootstrap/CORPUS_STATS.md` (existing committed-data precedent in
   `bootstrap/`).

Phase 0 measurement is the **first** observable action. Do NOT commit any
wasm shard to `bootstrap/as-cache-seed/` until Phase 0 numbers are recorded
in the PR and pass the size-budget gate. If you cannot pass the gate, emit
`PLAN_VERDICT: blocked_by_plan` and stop.
