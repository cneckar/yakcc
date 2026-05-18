# fix-706 — B2 esbuild cannot resolve `ajv` from `tmp/` scratch dir

**Branch:** `feature/706-b2-nodepaths`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-706-b2-nodepaths`
**Base:** `main @ 8aee0ec`
**Closes:** #706
**Relates:** none (B2 harness is isolated from B1/B3-B10 harnesses)

---

## 1. Problem (verbatim from #706)

`bench/B2-bloat/harness/run.mjs:104-111` calls `esbuild.build()` against an entry
at `tmp/B2-bloat/ajv-entry.mjs`. Esbuild walks `node_modules` UP from the entry's
directory and never reaches `bench/B2-bloat/node_modules` (which contains `ajv`
and `ajv-formats`). The bundle returns `null` and the headline transitive-weight
metric for B2 is unmeasurable.

### 1.1 Empirical confirmation

- `bundleWithEsbuild()` writes its entry to `OUT_DIR = resolve(ROOT_DIR, "tmp/B2-bloat")` (line 56).
- `measureAjv()` synthesizes `tmp/B2-bloat/ajv-entry.mjs` containing
  `import Ajv from "ajv";` (line 194-195), then calls
  `bundleWithEsbuild(ajvEntry, ajvOutFile, "browser")` (line 197).
- esbuild's default Node-style resolution walks up from the entry's directory:
  `tmp/B2-bloat → tmp → <repo-root>`. None of those contains `node_modules/ajv`.
- `ajv` lives only at `bench/B2-bloat/node_modules/ajv` (bench-local install,
  not in the pnpm workspace per `bench/B2-bloat/package.json` notes).
- Result: esbuild throws `Could not resolve "ajv"`; the harness catches nothing
  here, so the run errors before producing `ajv.bundleSizeBytes`.

### 1.2 Why the yakcc arm is not affected

`measureYakccValidator()` bundles a compiled JS file located at
`examples/json-schema-validator/dist/validator.js` (line 159-160). That entry
has its own `node_modules` walk that reaches the workspace `node_modules` for
TypeScript-emitted helpers; the yakcc validator has zero npm runtime deps so
bundling succeeds. Only the ajv arm crosses a `tmp/` boundary that defeats
default `node_modules` resolution.

---

## 2. Investigation findings (planner, 2026-05-17)

### 2a. State of `bench/B2-bloat/node_modules`

- Main repo: `bench/B2-bloat/node_modules/ajv`, `…/ajv-formats`, `…/esbuild`
  present (prior `pnpm --dir bench/B2-bloat install`).
- Fresh worktree `feature-706-b2-nodepaths`: `bench/B2-bloat/node_modules/`
  DOES NOT exist yet. The implementer MUST run
  `pnpm --dir bench/B2-bloat install` once in the worktree to satisfy the
  smoke-run precondition. This is a build-step in the worktree, not a source
  edit — no `package.json`/lockfile changes (lockfile does not exist for B2).

### 2b. The minimal `nodePaths` fix

esbuild's `nodePaths` option (the JS-API form of node's `NODE_PATH` env var)
adds extra directories to the module-resolution search path. Adding
`bench/B2-bloat/node_modules` (resolved from `__dirname = harness/`) lets the
existing entry at `tmp/B2-bloat/ajv-entry.mjs` find `ajv` without moving the
entry or copying `node_modules`.

This is the smallest possible fix and matches the issue's prescribed
remediation verbatim.

### 2c. Why not the alternatives

| Alternative | Why rejected |
|---|---|
| Move `ajv-entry.mjs` into `bench/B2-bloat/` | Pollutes the source tree with build-time artifacts; `tmp/` is the canonical scratch dir per Sacred Practice #3. |
| Symlink `bench/B2-bloat/node_modules` into `tmp/B2-bloat/` | OS-dependent; adds cleanup obligations; not idiomatic esbuild. |
| Use esbuild's `absWorkingDir` to point at `bench/B2-bloat/` | Changes the meaning of relative paths in `entryPoints`/`outfile` (currently absolute); higher blast radius than `nodePaths`. |
| Pre-bundle ajv via a separate step and feed the bundle in | Defeats the metric (we want esbuild to do the transitive walk). |
| `esbuild --resolve-extensions` / custom plugin | Massive overkill for a 1-option fix. |

`nodePaths` wins on minimality, locality, and idiomatic esbuild usage.

### 2d. Backward-compat for the yakcc arm

`bundleWithEsbuild` is called twice: line 160 (yakcc arm, entry inside
`examples/.../dist/`) and line 197 (ajv arm, entry inside `tmp/B2-bloat/`).
Adding `nodePaths: [bench/B2-bloat/node_modules]` to both call sites is safe:
esbuild's resolver tries the local walk first and only falls back to
`nodePaths` if the local walk fails. The yakcc arm's local walk continues to
succeed unchanged.

### 2e. Sister activity

- `git log -1 bench/B2-bloat/harness/run.mjs` → last touched at
  `f53fb8a` (B2 initial slice). No active sister WI on this file in any open
  worktree (verified — only the scope-bound worktree
  `feature-706-b2-nodepaths` touches it).
- No other open issue overlaps `bench/B2-bloat/harness/**`.

Safe to proceed.

---

## 3. Approach

### 3.1 Fix

Add a `nodePaths` option to the single `esbuild.build()` invocation inside
`bundleWithEsbuild()`. Resolve the path once at function entry (cheap; happens
twice per run at most).

```js
async function bundleWithEsbuild(entryPoint, outFile, platform = "node") {
  let esbuild;
  try {
    const _require = createRequire(import.meta.url);
    esbuild = _require("esbuild");
  } catch {
    return null; // esbuild not available
  }

  // @decision DEC-FIX-706-NODEPATHS-001
  // The ajv arm writes its entry to tmp/B2-bloat/ajv-entry.mjs (OUT_DIR), but
  // ajv/ajv-formats are installed at bench/B2-bloat/node_modules/. esbuild's
  // default upward node_modules walk from tmp/B2-bloat never reaches the
  // bench dir. nodePaths adds bench/B2-bloat/node_modules as a fallback
  // resolution root so the ajv entry resolves. Safe for the yakcc arm: local
  // walk takes priority; nodePaths is fallback only.
  const benchNodeModules = resolve(__dirname, "..", "node_modules");

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    platform,
    format: "esm",
    outfile: outFile,
    nodePaths: [benchNodeModules],
  });
  return statSync(outFile).size;
}
```

Single-file change. No new imports needed (`resolve` and `__dirname` are
already in scope at the top of the file).

### 3.2 Smoke verification (implementer)

In the worktree, after the edit:

```bash
# precondition (one-time bench-local install in this worktree)
pnpm --dir bench/B2-bloat install

# live run
node bench/B2-bloat/harness/run.mjs 2>&1 | tee tmp/wi-706-smoke.log
```

Expected log output (or close to):
```
Arm B: ajv@8.x (reference comparator)
  ajv bundle (esbuild, minified): <N>  bytes   # N > 100_000 typical
  ajv bundle (gzip): <M> bytes               # M > 10_000 typical
```

The harness also writes a JSON results file (search for `results.json`/similar
at run end — confirm a `bundleSizeBytes` / `gzipBundleSize` field for the ajv
arm is non-null).

### 3.3 Yakcc-arm regression check

Same `node bench/B2-bloat/harness/run.mjs` invocation logs the yakcc arm
output. Expected (per #706 contract item 3):
- raw bundle bytes within ±10% of ~11_352 B
- gzip bundle bytes within ±10% of ~3_548 B

The implementer captures both armA and armB log lines into
`tmp/wi-706-smoke.log` and quotes the salient lines in the PR body.

### 3.4 Test strategy

`bench/B2-bloat/` has no existing test harness; the smoke run IS the test (the
harness is itself a measurement script, not a unit-tested library). Per the
issue's eval contract item 5 ("If no existing test infra, a smoke run + json
output check is acceptable; reviewer to confirm."), the smoke log + JSON
inspection is the empirical proof.

No new test file is added. The smoke log committed as part of the PR body
(NOT as a tracked file — `tmp/wi-706-*` is in `forbidden_paths` for commit per
Sacred Practice #3) is the evaluation evidence.

---

## 4. State authority map

| Domain | Authority |
|---|---|
| B2 bloat harness measurement | `bench/B2-bloat/harness/run.mjs` (sole authority for the harness; no parallel measurement script) |
| esbuild module resolution policy (B2) | `bundleWithEsbuild()` in the same file — adding `nodePaths` is a strictly-additive policy extension within the same authority |
| B2 dependency manifest | `bench/B2-bloat/package.json` (frozen here — forbidden_paths) |
| B2 transitive install state | `bench/B2-bloat/node_modules/` (build artifact, not source; out of scope for diff) |
| OUT_DIR (entry scratch location) | `tmp/B2-bloat/` (canonical scratchlane; unchanged) |

**No new authority introduced.** The fix extends the existing esbuild call
shape with one additional documented option.

---

## 5. Wave decomposition

| W-ID | Title | Weight | Gate | Deps | Files |
|---|---|---|---|---|---|
| W1 | Edit `bundleWithEsbuild()` to pass `nodePaths: [bench/B2-bloat/node_modules]` with `@decision DEC-FIX-706-NODEPATHS-001` annotation | S | none | — | `bench/B2-bloat/harness/run.mjs` |
| W2 | One-time bench-local install: `pnpm --dir bench/B2-bloat install` (build step, not source edit) | S | none | — | (no diff; produces `bench/B2-bloat/node_modules/` which is gitignored) |
| W3 | Smoke run: `node bench/B2-bloat/harness/run.mjs` → capture `tmp/wi-706-smoke.log`; confirm ajv arm produces non-null bundle/gzip sizes; confirm yakcc arm within ±10% of baseline | S | review | W1, W2 | (no diff) |
| W4 | Commit plan + run.mjs change; reviewer verifies smoke log + diff scope; guardian lands | S | guardian | W3 | `plans/wi-706-b2-nodepaths.md`, `bench/B2-bloat/harness/run.mjs` |

**Critical path:** W1 → W2 → W3 → W4. W1 and W2 are independent but trivial
enough to do sequentially. W3 is load-bearing — without the smoke evidence
the change is unverified.

---

## 6. Evaluation contract

### Required tests / live checks

1. `bench/B2-bloat/harness/run.mjs` exposes `bundleWithEsbuild` and that
   function passes a non-empty `nodePaths` array to `esbuild.build()` that
   resolves to `bench/B2-bloat/node_modules` (verifiable by reading the diff).
2. **Live invocation** `node bench/B2-bloat/harness/run.mjs` (in the worktree,
   after `pnpm --dir bench/B2-bloat install`) produces:
   - ajv arm: non-null bundle bytes AND non-null gzip bytes
     (`ajv.bundleSize` and `ajv.gzipBundleSize`, or equivalent results-JSON
     fields, must be numbers, not `null`).
   - yakcc arm: bundle bytes within ±10% of the pre-fix baseline
     (~11_352 B raw, ~3_548 B gzip — exact numbers depend on the validator's
     current source at HEAD; reviewer checks the relative stability, not the
     absolute number).
3. Existing yakcc-arm behavior must not regress: the change must not cause the
   yakcc arm to fail to bundle or to produce materially different sizes.
4. **No** edits to `bench/B2-bloat/package.json`,
   `bench/B2-bloat/package-lock.json` (does not exist; must remain so), or
   any pnpm-workspace file.
5. **No** edits to any other bench directory (`bench/B1-*`, `bench/B3-*`, …,
   `bench/B10-*`, `bench/v0-release-smoke/*`, `bench/B2-bloat/fixtures/*`,
   `bench/B2-bloat/README.md`).
6. The plan file `plans/wi-706-b2-nodepaths.md` is committed in the same PR.

### Required evidence (in PR body or commit message)

- Diff scoped strictly to `allowed_paths` (see Scope Manifest §7).
- Smoke-run output quoted verbatim, specifically:
  - the ajv-arm log lines showing non-null bundle/gzip bytes, AND
  - the yakcc-arm log lines showing the bundle/gzip bytes within ±10% of
    baseline.
- `git fetch origin && git diff --stat origin/main..HEAD` showing only the
  two intended files (`bench/B2-bloat/harness/run.mjs` and
  `plans/wi-706-b2-nodepaths.md`).
- Pre-push hygiene per durable memory `feedback_pre_push_hygiene.md`:
  - `git fetch origin && git rebase origin/main` (no-op if already current,
    proves the branch tracks origin/main; per memory
    `feedback_branch_must_track_origin_main.md`)
  - `pnpm -w lint` clean (full-workspace, not package-scoped)
  - `pnpm -w typecheck` clean (full-workspace)
  - `pnpm -w format` applied (biome) to the modified `.mjs` file
    (run.mjs is `.mjs` — biome handles it; if biome skips `.mjs` extensions
    per repo config, document that the file was checked manually).

### Required real-path checks

- `bench/B2-bloat/harness/run.mjs` has `nodePaths: [...]` set inside
  `esbuild.build()`, with the path resolving to
  `bench/B2-bloat/node_modules`.
- `bench/B2-bloat/package.json` byte-identical to its state at `origin/main`
  (`git diff origin/main..HEAD -- bench/B2-bloat/package.json` returns empty).
- `bench/B2-bloat/README.md` untouched.
- `bench/B2-bloat/fixtures/**` untouched.
- No new file under `bench/B2-bloat/`.
- The smoke log under `tmp/wi-706-smoke.log` is NOT committed (tmp/ is
  scratchlane).

### Required authority invariants

- `bench/B2-bloat/harness/run.mjs` remains the sole B2 measurement authority.
  No new harness file added.
- `bundleWithEsbuild()` signature preserved (still
  `(entryPoint, outFile, platform = "node") => Promise<number | null>`).
- The function's try/catch for missing `esbuild` is preserved.
- No new top-level import added (the file already has `resolve` from
  `node:path` and `__dirname` from `fileURLToPath(import.meta.url)`).
- No change to the `__dirname` / `BENCH_DIR` / `ROOT_DIR` / `OUT_DIR`
  constants at the top of the file.

### Required integration points

- The fix is localized inside `bundleWithEsbuild`; both call sites
  (line 160 yakcc, line 197 ajv) consume the same function unchanged.
- The `@decision DEC-FIX-706-NODEPATHS-001` annotation is added at the point
  of the new option per "Code is Truth" practice.

### Forbidden shortcuts

- **No** moving the ajv entry file out of `tmp/B2-bloat/` into
  `bench/B2-bloat/` (violates Sacred Practice #3).
- **No** symlinking `bench/B2-bloat/node_modules` into `tmp/`.
- **No** edits to `bench/B2-bloat/package.json` or any lockfile.
- **No** install of `ajv`/`ajv-formats`/`esbuild` into the root
  `package.json` or any workspace `package.json`.
- **No** edits to other bench dirs.
- **No** new harness file or wrapper.
- **No** custom esbuild plugin (massive overkill).
- **No** silent try/catch around the `esbuild.build()` call to mask a
  remaining resolution failure. If `nodePaths` does not fix the ajv arm,
  **stop and ask**.
- **No** `git push --force`.
- **No** landing without reviewer `REVIEW_VERDICT: ready_for_guardian`.
- **No** skipping `pnpm -w lint && pnpm -w typecheck` before push (sacred
  practice + durable memory).

### Rollback boundary

`git revert <single-commit-sha>` returns `bundleWithEsbuild` to its pre-fix
state; the ajv arm reverts to producing null bundle sizes. Single commit,
single revert, zero collateral.

### Acceptance notes

- Single PR, single squash-merge.
- Issue label `serenity` MUST be applied to #706 immediately on implementer
  pickup (per MEMORY feedback `feedback_serenity_claim_label.md`).
- PR title: `fix(bench-b2): #706 — nodePaths for esbuild ajv resolution (closes #706)`
- PR body: `closes #706` (lower-case "closes", per durable PR convention).

### Ready for guardian when

- `bench/B2-bloat/harness/run.mjs` diff = single addition of `nodePaths`
  option + the resolved-path local variable + the `@decision`
  DEC-FIX-706-NODEPATHS-001 annotation block. No other change.
- `plans/wi-706-b2-nodepaths.md` exists and is committed.
- Smoke-run evidence quoted in PR body:
  - ajv arm: `bundleSize > 0` AND `gzipBundleSize > 0`.
  - yakcc arm: `bundleSize` within ±10% of ~11_352 B (or whatever the
    current main-baseline produces — reviewer's call).
- `git diff --stat origin/main..HEAD` shows exactly two files changed.
- `pnpm -w lint && pnpm -w typecheck` clean.
- Reviewer issues `REVIEW_VERDICT: ready_for_guardian` with current head SHA.
- PR opened against `main` with body `closes #706` and `serenity` label
  applied.

---

## 7. Scope manifest

(Mirrors `tmp/wi-706-scope.json`; the orchestrator already wrote the
authoritative scope row via `scope-sync`. This section restates it for
reviewer eye-checking.)

### Allowed paths

- `bench/B2-bloat/harness/run.mjs` (the sole source edit)
- `plans/wi-706-b2-nodepaths.md` (this file)
- `tmp/wi-706-*`, `tmp/wi-706-*/*`, `tmp/wi-706-*/**/*` (scratchlane for
  smoke logs and any local capture; NOT committed)

### Required paths

- `plans/wi-706-b2-nodepaths.md` (this file — MUST be in commit)

### Forbidden paths (verbatim from scope.json)

- `packages/*`, `packages/**/*`
- `bench/B1-latency/*`, `bench/B1-latency/**/*`
- `bench/B4-tokens/*`, `bench/B4-tokens/**/*`
- `bench/B5-coherence/*`, `bench/B5-coherence/**/*`
- `bench/B6-airgap/*`, `bench/B6-airgap/**/*`
- `bench/B7-commit/*`, `bench/B7-commit/**/*`
- `bench/B8-synthetic/*`, `bench/B8-synthetic/**/*`
- `bench/B9-min-surface/*`, `bench/B9-min-surface/**/*`
- `bench/B10-import-replacement/*`, `bench/B10-import-replacement/**/*`
- `bench/B3-cache-hit/*`, `bench/B3-cache-hit/**/*`
- `bench/v0-release-smoke/*`, `bench/v0-release-smoke/**/*`
- `bench/B2-bloat/fixtures/*`, `bench/B2-bloat/fixtures/**/*`
- `bench/B2-bloat/README.md`
- `bench/B2-bloat/package.json`
- `bench/B2-bloat/package-lock.json`
- `.github/*`, `.github/**/*`
- `.claude/*`, `.claude/**/*`
- `MASTER_PLAN.md`
- `docs/*`, `docs/**/*`
- `examples/*`, `examples/**/*`
- `scripts/*`, `scripts/**/*`

### Authority domains touched

- `b2-bloat-harness-esbuild` (state domain — single file, single
  function-internal option)
- `b2-esbuild-resolver` (authority domain — additive `nodePaths` policy)

---

## 8. Decision log

| DEC-ID | Status | Title |
|---|---|---|
| DEC-FIX-706-NODEPATHS-001 | decided | Add `nodePaths: [bench/B2-bloat/node_modules]` to `bundleWithEsbuild()`'s esbuild call so the ajv arm (entry at `tmp/B2-bloat/ajv-entry.mjs`) can resolve bench-local deps. Smallest mechanical fix; preserves canonical `tmp/` scratchlane usage. |
| DEC-FIX-706-NO-PACKAGE-JSON-EDITS-001 | decided | `bench/B2-bloat/package.json` and lockfiles MUST NOT be edited. Bench-local install (`pnpm --dir bench/B2-bloat install`) is the canonical way to materialize `node_modules` per `bench/B2-bloat/package.json` notes. |
| DEC-FIX-706-NO-ENTRY-RELOCATION-001 | decided | The ajv entry file stays at `tmp/B2-bloat/ajv-entry.mjs`. Moving it into `bench/B2-bloat/` would violate Sacred Practice #3 (`tmp/` is the canonical scratch dir). |
| DEC-FIX-706-SMOKE-AS-TEST-001 | decided | Per #706 contract item 5, smoke-run output is the empirical evaluation evidence in lieu of a unit test. No new test file added; the harness IS the test. |

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `nodePaths` does not fix the ajv arm (esbuild's resolver has additional logic that ignores `nodePaths` in some platform mode) | Low | Smoke run W3 catches this before review. esbuild docs confirm `nodePaths` is the canonical equivalent of `NODE_PATH` and is honored for `bundle: true` builds on all platforms. If it does NOT work, stop and ask. |
| The fresh worktree has no `bench/B2-bloat/node_modules` and the implementer forgets the bench-local install (W2) | Medium | W2 is a named wave with explicit command. Pre-PR checklist names it. Reviewer verifies the smoke log shows non-null ajv sizes (which is impossible without the install). |
| Yakcc arm regresses (size or success rate) because esbuild's resolver behaves differently with `nodePaths` set | Low | esbuild's resolver tries the local walk first; `nodePaths` is fallback only. W3 explicitly captures the yakcc arm sizes and the eval contract bounds them at ±10%. |
| Biome / lint config does not cover `.mjs` files and a style drift sneaks in | Low | Implementer manually inspects the diff for indentation/quoting consistency with the surrounding code. The change is < 10 lines. |
| The ajv-arm bundle is huge (~200-400 KB) and gzip is slow, exceeding `bundleWithEsbuild`'s default timeout (none set) | Low | No timeout configured; node default applies. ajv@8 bundles in < 1 s on typical hardware. |
| Sister WI lands on `bench/B2-bloat/harness/run.mjs` mid-PR | Low | Pre-push `git fetch origin && git diff --stat origin/main..HEAD` surfaces the conflict. No active sister WI as of 2026-05-17. |
| `pnpm --dir bench/B2-bloat install` fails because the worktree's pnpm config or registry is misconfigured | Low | Bench install is identical to main repo's install; if main works, the worktree works. If install fails, stop and ask — do NOT attempt to vendor or hand-fetch ajv. |

---

## 10. Out of scope

- **Other bench harnesses** (B1, B3-B10, v0-release-smoke) — all in
  `forbidden_paths`. If any sibling harness has the same `tmp/`-entry vs
  bench-local-deps issue, file a follow-up; do not bundle the fix here.
- **B2 fixtures or README** — frozen.
- **B2 package.json or lockfile** — frozen.
- **JSON Schema validator source** (`examples/json-schema-validator/`) —
  unrelated to esbuild resolution; the validator is the yakcc-arm input only.
- **MASTER_PLAN.md update** — orchestrator concern, forbidden here.
- **Wider esbuild upgrade or config standardization across bench dirs** —
  follow-up if the operator decides; out of scope for #706.
- **B2 "fine"/"medium" granularity slices** — separate WI per the harness
  header notes; #706 is purely an unblock of the existing coarse slice.

---

## 11. Continuation

On guardian land + PR merge:

- Close #706 via `closes #706` in PR body.
- Re-run `node bench/B2-bloat/harness/run.mjs` on `main @ <merge-sha>` to
  confirm post-merge reproducibility (orchestrator-level smoke; not part of
  this WI's eval contract).
- Update any external dashboard or B2 status doc that recorded "ajv arm
  unmeasurable" — operator concern, not implementer.
- Next candidates (operator-adjudicated, runtime-confirmed): triage open
  bench-harness issues for similar `tmp/`-entry resolution gaps in other
  bench dirs; resume the broader B2 fine/medium-granularity slice work that
  was previously blocked on the headline metric being measurable.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Plan for #706 written to plans/wi-706-b2-nodepaths.md; single-file fix adds `nodePaths: [bench/B2-bloat/node_modules]` to `bundleWithEsbuild()` so the ajv arm (entry at tmp/B2-bloat/ajv-entry.mjs) can resolve bench-local deps; W2 bench-local install precondition + W3 smoke-run evidence (ajv non-null + yakcc within ±10%) are the eval contract; scope strictly `bench/B2-bloat/harness/run.mjs` + plan file; ready to provision implementer.
