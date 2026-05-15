# WI-FIX-545-TWOPASS-VALIDATOR — Two-pass equivalence: 45 divergent block-merkle-roots return after #544

**Status:** plan v1
**Issue:** #545
**Branch:** `feature/wi-fix-545-twopass-validator` (worktree `.worktrees/wi-fix-545-twopass-validator`)
**Parent plan (mechanism authority):** `plans/wi-fix-494-twopass-nondeterm.md` v3 on `origin/main`
**Parent landed fix:** PR #520 (`51febd4`) landed **only Fix A** (seed-triplet sidecars + walk
determinism + T3b). **Fix E (the `*.props.ts` plumbing fix) was never landed.** This plan
finishes the v3 plan.

---

## 0. TL;DR

The 45-divergent-roots regression that surfaced after #544 (WI-510 Slice 2 — validator
headline bindings) merged is, by all available evidence, the same `*.props.ts` proof-manifest
non-determinism that #494 identified. #544 itself adds **no atom-source files** to the corpus:
its 116 vendored validator files all live under `packages/shave/src/__fixtures__/`
(skipped by `bootstrap.ts:shouldSkip` via the `/__fixtures__/` segment guard) and its single
new TS file is `*.test.ts` (skipped by the `.test.ts` filename guard). The `corpus.json` edit
lives under `packages/registry/test/` which is outside the bootstrap walk root.

The standing mechanism (`packages/shave/src/corpus/props-file.ts:extractFromPropsFile`) is
unchanged: when a sibling `*.props.ts` file exists on disk, the corpus extractor records
`path: <atomName>.props.ts` in the proof manifest; when it is absent, the extractor falls
through and a generic path is recorded instead. The `proof_manifest_json.artifacts[].path`
field flows into `proof_root` and therefore into `block_merkle_root`.

The recompiled workspace produced by `yakcc compile-self` rematerialises only files captured
in `workspace_plumbing`. On the current `plumbing-globs.ts` (HEAD), `PLUMBING_INCLUDE_GLOBS`
contains the seed-triplet sidecars from `DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001` but
**zero `*.props.ts` patterns**. So the 73 hand-authored `*.props.ts` siblings are present
during pass 1 (canonical workspace) and absent during pass 2 (recompiled workspace), and the
45 atoms whose proof-extractor falls through differently produce 45 symmetric divergent
`block_merkle_root` values. The cardinality (45) matches #494's `shave×12, contracts×11,
federation×8, variance×4, registry×4, ir×3, compile×3` distribution exactly because the
mechanism is the same and the offending atom population has not materially changed since
#493 landed the 5 seed atoms that drove the original 45-count.

**This plan lands the un-landed v3 Fix E: add two single-segment `*.props.ts` glob patterns
to `PLUMBING_INCLUDE_GLOBS`, add a `T3c` regression guard, regenerate `bootstrap/expected-roots.json`,
and prove `divergent=0` on this branch.**

The implementer MUST run the two-pass on this branch BEFORE editing source. If the 45-root
source-package cluster does not match the props-files hypothesis below, the plan adapts
under the contingency in §7 (the Fix E approach is bounded; an out-of-pattern cluster gets
a new planner cycle, not a workaround).

---

## 1. Re-confirmed evidence (this branch)

| Check | Result |
|---|---|
| `find packages -name '*.props.ts' -not -path '*/node_modules/*' -not -path '*/dist/*'` | **73 files.** 42 at depth 4 (`packages/X/src/Y.props.ts`); 31 at depth 5 (`packages/X/src/Y/Z.props.ts`). Identical to #494 v3's enumeration. |
| `grep 'props\.ts' packages/cli/src/commands/plumbing-globs.ts` | **No matches.** `PLUMBING_INCLUDE_GLOBS` contains `package.json`, `tsconfig*.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `biome.json`, `vitest.config.ts`, and the seed-triplet `packages/*/src/blocks/*/{spec.yak,proof/manifest.json,proof/tests.fast-check.ts}` lines from #520. No `*.props.ts` line. |
| `bootstrap.ts:expandPlumbingGlob` (lines 561-615) | Single-segment `*` matcher only. `**` segments compile to `[^/]*` and match a literal directory named `**`, which does not exist → zero-file expansion. Two literal-depth patterns are exhaustive for the current 73-file population. |
| `bootstrap.ts:shouldSkip` (lines 190-211) | Skips `*.test.ts`, `*.d.ts`, `vitest.config.ts`, `*.props.ts`, and anything under `__tests__/`, `__fixtures__/`, `__snapshots__/`, `node_modules/`, `dist/`. The `.props.ts` filename guard means props files are never shaved as atoms — they only enter the system as corpus inputs to the props-file extractor (`packages/shave/src/corpus/props-file.ts`). |
| `packages/shave/src/corpus/props-file.ts:extractFromPropsFile` | Reads sibling `*.props.ts` via `fs.readFile`. If file present → returns `{ source: "props-file", path: "<atomName>.props.ts", contentHash: blake3(bytes) }`. If file absent → returns `undefined` and the corpus chain falls through to the next source (typically `upstream-test`, `documented-usage`, or `ai-derived`), each of which records a different `path` value. **This is the filesystem-presence-dependent path field that the v3 plan named as the proof-manifest divergence axis.** |
| #544's actual additions (diff vs `d9f1ca7`) | 116 files under `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` (skipped by `/__fixtures__/` guard); 1 new `packages/shave/src/universalize/validator-headline-bindings.test.ts` (skipped by `.test.ts` guard); 4 new entries appended to `packages/registry/test/discovery-benchmark/corpus.json` (outside `packages/*/src/` walk root); 2 plan `.md` files. **#544 contributes zero new atoms to the corpus and zero new files inside the bootstrap walk root.** |

The reasonable read of "the regression appeared when #544 landed" is that two-pass had not
been exercised under `YAKCC_TWO_PASS=1` between #520's bootstrap regen and #544's branch
merge — `#520`'s commit message says it Closes #494, but #520 only contained Fix A. The
underlying `*.props.ts` divergence has been latent since before #520. The merge of #544
correlates with the *visibility* of the regression (CI exercising the gate), not with
introducing the divergence.

The user-side framing — "Same class as #494" — is correct; this is literally #494's un-landed
Fix E, finishing the work that #520 left undone.

---

## 2. Root cause (carried forward from #494 v3 §1; re-verified above)

The 45 divergent block-merkle-roots are ordinary `L0` functions shaved from yakcc's own
source whose `proof_manifest_json.artifacts[].path` depends on the filesystem presence
of a sibling `*.props.ts` file. `compile-self` does not materialise those siblings into
the recompiled workspace because they are not in `PLUMBING_INCLUDE_GLOBS`. The pass-2 shave
sees no props file, the corpus chain falls through, a different `path` is recorded, a
different `proof_root` is produced, and `block_merkle_root = BLAKE3(spec_hash || impl_hash
|| proof_root)` flips.

`spec_hash` and `impl_hash` are byte-identical between passes. Only the proof manifest
diverges. This is documented in detail in `plans/wi-fix-494-twopass-nondeterm.md` §1
on `origin/main` and the analysis is not re-derived here.

---

## 3. The fix (lifted verbatim from #494 v3 §3 Fix E / Fix F / Fix G; carried forward)

### Fix E (primary) — `packages/cli/src/commands/plumbing-globs.ts`

Add to `PLUMBING_INCLUDE_GLOBS` **two single-segment glob patterns**:

```ts
// *.props.ts hand-authored property-test corpus files (two literal depths).
"packages/*/src/*.props.ts",
"packages/*/src/*/*.props.ts",
```

Place these adjacent to the existing `DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001` block.
Add a new `@decision DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001` immediately above the new
patterns. The rationale block must state:

- Props files are **corpus inputs** to the shave pipeline's props-file extractor, not
  atoms — `bootstrap.ts:200` explicitly skips them from shaving via the `.props.ts`
  filename guard, so capturing them as plumbing never conflicts with atom reconstruction
  (`compile-self`'s "TS source wins" rule from `DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001`
  cannot trigger because props files are never shaved into the `blocks` table in the
  first place).
- **Why two patterns, not `**`:** `expandPlumbingGlob` (`bootstrap.ts:561-615`) supports
  single-segment `*` only (each `*` → regex `[^/]*`). A `**` segment would match a
  literal directory named `**` and expand to zero files. All 73 `*.props.ts` files live
  at exactly two depths under `packages/*/src/` (42 at depth 4, 31 at depth 5), so two
  literal-depth patterns are exhaustive. **If a future `*.props.ts` is added at depth ≥
  2 below `src/`, a third pattern must be added** — the T3c regression guard (Fix F)
  will catch this.
- Amends `DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001` and is a sibling of
  `DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001`.

### Fix F (regression guard) — `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`

Add `it("T3c: recompiled workspace contains every *.props.ts corpus file")` immediately
after the existing T3b block. Implementation pattern (carried from #494 v3 §3 Fix F):

- Recursively enumerate every `*.props.ts` under `packages/*/src/` in `REPO_ROOT`. Use a
  filesystem walk (not the two glob patterns) so a depth-≥2 props file that the glob
  patterns would miss is caught by this test.
- For each `propsAbsPath`, compute the workspace-relative path and assert
  `existsSync(join(DIST_RECOMPILED_DIR, relPath))`.
- Same hard-fail precondition pattern as T3b: throw on missing
  `registryAAvailable / reportAAvailable / cliBinAvailable` (per
  `DEC-V2-TWO-PASS-PRECONDITION-001`).
- Loud failure message naming the missing relative path(s) and citing
  `DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001`.
- New `@decision DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001`.

T3b stays unchanged. T3c is a sibling guard for a distinct file class. Conflating them
would muddy diagnosis.

### Fix G (bootstrap regen) — `bootstrap/{expected-roots.json,expected-failures.json,CORPUS_STATS.md}` and `bootstrap/yakcc.registry.sqlite` (untracked)

After Fix E lands, regenerate the bootstrap artifacts. **Ordering is contract-critical:**

1. Edit `plumbing-globs.ts` (Fix E).
2. `pnpm -r build` — then **verify** `packages/cli/dist/commands/plumbing-globs.js` mtime
   advances past the `.ts` edit. Stale `dist/` is the trap the v3 plan called out
   (`FS-4`). If the `.ts` edit does not reach the compiled CLI, the regen runs against
   the old globs and the fix silently no-ops.
3. `yakcc bootstrap` — regen `bootstrap/` artifacts. Expected: ~73 new `workspace_plumbing`
   rows (one per props file); zero changes to `block_merkle_root` values (the originals
   were already correct in pass 1; the 45 divergent values were a pass-2 artifact).
4. Add the T3c test (Fix F).
5. Run the eval contract (§5).

**Pre-flight dry-run check (mandatory before regen).** Before running step 3, invoke a
one-shot expansion check to prove the new globs are not zero-matches:

```bash
node -e "
const { PLUMBING_INCLUDE_GLOBS } = require('./packages/cli/dist/commands/plumbing-globs.js');
console.log('patterns:', PLUMBING_INCLUDE_GLOBS.filter(p => p.endsWith('.props.ts')));
"
```

Then walk the workspace manually (or via the bootstrap CLI's verbose mode if available)
to confirm 73 `*.props.ts` files are captured. **Zero matches means the glob is broken**
(the exact v2-of-#494 bug) — do **not** proceed to regen until the count is 73.

**Do NOT** touch `packages/seeds/`, `packages/shave/src/corpus/`, `packages/shave/src/__fixtures__/`,
or any atom source. The fix is confined to one glob list + one test + regenerated `bootstrap/`
artifacts.

---

## 4. Scope Manifest

**Allowed (implementer may modify):**

- `packages/cli/src/commands/plumbing-globs.ts` — add 2 glob entries + 1 `@decision` block.
- `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts` — add 1 new `it()` (T3c).
- `bootstrap/expected-roots.json` — regenerated.
- `bootstrap/expected-failures.json` — regenerated if the bootstrap CLI rewrites it.
- `bootstrap/CORPUS_STATS.md` — regenerated if the bootstrap CLI rewrites it.
- `plans/wi-fix-545-twopass-validator.md` — this file; the implementer may append an
  "Implementation notes / divergent-cluster confirmation" appendix.

**Required (must be modified for the fix to be complete):**

- `packages/cli/src/commands/plumbing-globs.ts`
- `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`
- `bootstrap/expected-roots.json`

**Forbidden (must not be touched):**

- Anything under `packages/seeds/`.
- Anything under `packages/shave/src/corpus/` (including `props-file.ts`, the props
  extractor — fixing the path drift there is the rejected alternative escalation per
  #494 v3 §6; out of scope for this fix).
- Anything under `packages/shave/src/__fixtures__/` (the #544 vendored validator tarball).
- Anything under `packages/contracts/`, `packages/compile/`, `packages/registry/`,
  `packages/ir/`, `packages/variance/`, `packages/federation/`, `packages/hooks-*/`,
  `packages/seeds/_scripts/copy-triplets.mjs`.
- `packages/cli/src/commands/bootstrap.ts` — the matcher and walker stay as-is.
  (`expandPlumbingGlob`'s sort-readdir and the `shouldSkip` rules are correct and
  unchanged; touching them is out of scope and would invalidate the v3 invariant set.)
- Any source file under `packages/*/src/` other than the two listed above.

**State authorities touched:**

- **Plumbing-glob authority** (`packages/cli/src/commands/plumbing-globs.ts`) —
  `DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001`'s single-authority surface gains one decision
  amendment.
- **Bootstrap reproducibility authority** (`bootstrap/expected-roots.json`) — regenerated.
  No `block_merkle_root` values should change; only `workspace_plumbing` rows are added.
- **Two-pass invariant authority** (`examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`)
  — `DEC-V2-HARNESS-STRICT-EQUALITY-001` is preserved (not weakened); a new sibling
  test T3c is added.

**Decisions emitted by this plan:**

- `DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001` (Fix E)
- `DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001` (Fix F)

These are siblings of, not supersessions of, the existing decisions from #520:
`DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001`, `DEC-V2-PLUMBING-WALK-DETERMINISM-001`,
`DEC-V2-HARNESS-SEED-SIDECAR-CHECK-001`. The latter remain valid and untouched.

---

## 5. Evaluation Contract

### Required tests (must pass)

1. **T3 divergent=0 (the crown-jewel gate):**
   ```
   YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test
   ```
   must produce:
   ```
   [two-pass] BYTE-IDENTITY: PASS | S1=<N> S3=<N> included=<N> excluded=0..2 | divergent=0
   ✓ T3: every included blockMerkleRoot from S1 exists byte-identically in S3
   ```
   **`divergent=0` is the hard gate.** `DEC-V2-HARNESS-STRICT-EQUALITY-001` is invariant
   authority; relaxing the threshold is `FS-1` below and is forbidden.

2. **T3b (seed-sidecar regression guard) still passes:** the existing assertion from #520
   that every seed atom's `spec.yak` and `proof/manifest.json` exists in
   `dist-recompiled/`. Should pass unchanged.

3. **T3c (props-corpus regression guard) passes:** every `*.props.ts` enumerated under
   `packages/*/src/` in the canonical workspace exists at the same workspace-relative
   path inside `dist-recompiled/`. Must pass; loud failure naming the missing relative
   path(s).

4. **Default test suite stays green:** `pnpm -r test` (without `YAKCC_TWO_PASS=1`) passes
   with no new failures and no new skips.

5. **`packages/cli` builds clean:** `pnpm --filter @yakcc/cli build` succeeds; the
   compiled `packages/cli/dist/commands/plumbing-globs.js` contains the two new patterns.

### Required real-path checks (production-sequence verifications)

1. **Glob expansion proof.** Before regenerating `bootstrap/expected-roots.json`, prove
   the two new patterns expand to 73 files in the canonical workspace (the dry-run
   snippet in §3 / Fix G). A zero-match result blocks the regen — that is the v2 bug
   re-occurring.

2. **`dist/` mtime check.** `packages/cli/dist/commands/plumbing-globs.js` mtime is
   newer than `packages/cli/src/commands/plumbing-globs.ts` mtime after `pnpm -r build`.
   If false → stale `dist/`; halt and rebuild before regen.

3. **`workspace_plumbing` row delta.** After regen, the new
   `bootstrap/yakcc.registry.sqlite` (untracked locally) must contain exactly 73 more
   `workspace_plumbing` rows than the pre-fix state (one per props file). Implementer
   reports the observed count. Tolerance: ±2 for any concurrent props additions while
   working in the branch; if the delta is off by more than that, halt and explain.

4. **No `blocks`-table `block_merkle_root` value churn.** Run a SQL `SELECT
   block_merkle_root FROM blocks` against the pre-fix and post-fix
   `bootstrap/yakcc.registry.sqlite` and confirm zero `block_merkle_root` values
   changed. The pass-1 proof manifest values were already correct (props files exist
   on disk in pass 1) — the 45 changes were a pass-2 artifact. **If any
   `block_merkle_root` value changes, halt and escalate** — that is a separate axis
   not in this fix's scope.

5. **Divergent-cluster confirmation (FIRST, before any code edit).** Before editing
   any source, the implementer runs the two-pass on this branch and reports:
   - The 45 (or whatever count) divergent root list from T3's failure log.
   - The source-package breakdown via `regA.listOccurrencesByMerkleRoot(root)` for the
     divergent roots — does it match the `shave×12, contracts×11, federation×8,
     variance×4, registry×4, ir×3, compile×3` distribution from #494 v3, or is it a
     different cluster?
   - For at least one sampled divergent atom: the per-pass `proof_manifest_json.artifacts[].path`
     value (pass 1 vs pass 2). Confirm pass 1 carries `<fnName>.props.ts` and pass 2
     carries `property-tests.fast-check.ts` (or another generic fallback path).

   **If the cluster matches the props-files pattern**, proceed with Fix E. **If the
   cluster does not match the props-files pattern**, halt and escalate per §7 — do
   not attempt to fix an unknown axis with the props-files patch.

### Required authority invariants

- `DEC-V2-HARNESS-STRICT-EQUALITY-001`'s byte-identity invariant is preserved (not
  relaxed). `divergent=0` is the hard gate.
- `DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001`'s "single authority for plumbing globs" is
  preserved; the new globs are added to `plumbing-globs.ts` only (no second authority).
- `DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001`'s seed-triplet globs and
  `DEC-V2-PLUMBING-WALK-DETERMINISM-001`'s sorted-readdir are unchanged.
- `bootstrap.ts:shouldSkip` is unchanged; props files remain non-atoms.

### Required integration points

- `PLUMBING_INCLUDE_GLOBS` → consumed by `bootstrap.ts:expandPlumbingGlob` → after regen,
  `workspace_plumbing` must contain ~73 `*.props.ts` rows.
- `workspace_plumbing` → consumed by `packages/cli/src/commands/compile-self.ts` → after
  the next `compile-self` run, `dist-recompiled/packages/*/src/**/*.props.ts` exists at
  the same relative paths as the canonical workspace.
- `packages/shave/src/corpus/props-file.ts:extractFromPropsFile` reads those files
  during pass 2 → pass-2 `proof_manifest_json` matches pass-1 for the 45 blocks → 45
  divergent → 0.

### Forbidden shortcuts

- **FS-1.** NEVER relax the `divergent` assertion threshold above 0. The invariant is
  `DEC-V2-HARNESS-STRICT-EQUALITY-001`.
- **FS-2.** NEVER add the 45 divergent root hashes or any `*.props.ts`-related paths
  to the test's exclusion set / `report.json` failure list to mask divergence.
- **FS-3.** NEVER edit `packages/shave/src/corpus/props-file.ts` to hardcode a
  filesystem-independent path. That is the rejected alternative escalation (#494 v3 §6
  / §7 rollback boundary); it changes every corpus root and needs its own planner cycle.
- **FS-4.** NEVER skip the `pnpm -r build` before `yakcc bootstrap` and never proceed
  with a stale `packages/cli/dist/commands/plumbing-globs.js`. Stale `dist/` is the
  trap that made the prior v2-of-#494 attempt unverifiable. Mtime check is mandatory.
- **FS-5.** NEVER use a `**` segment in a `PLUMBING_INCLUDE_GLOBS` pattern. The matcher
  silently expands it to zero files (#494 v3 §0). Single-segment `*` only. Two literal-depth
  patterns are the only correct shape.
- **FS-6.** NEVER bundle unrelated changes (e.g., a `bootstrap.ts` cleanup, a
  `props-file.ts` refactor, a copy-triplets.mjs tweak) into this fix. The Scope Manifest
  in §4 is binding.
- **FS-7.** NEVER claim the fix is complete based on T3b passing alone (T3b only guards
  seed sidecars; the 45 divergent roots are non-seed L0 atoms — props-files coverage
  is a different invariant).
- **FS-8.** NEVER assume the hypothesis is confirmed; the implementer's first action
  is the divergent-cluster confirmation in §5 / Required real-path check 5. If the
  cluster is unknown, halt per §7.

### Ready-for-Guardian checklist (numbered)

The reviewer may declare `REVIEW_VERDICT=ready_for_guardian` only when all of the
following are demonstrably true. Item 1 is the top-line gate the user named explicitly.

1. **Two-pass T3 passes (0 divergent roots) on this branch.** Full log output of
   `YAKCC_TWO_PASS=1 pnpm --filter @yakcc/v2-self-shave-poc test` is in the PR
   description showing `[two-pass] BYTE-IDENTITY: PASS | S1=<N> S3=<N> included=<N>
   excluded=0..2 | divergent=0` and `✓ T3: every included blockMerkleRoot from S1
   exists byte-identically in S3`.
2. **Divergent-cluster confirmation pre-fix** is captured in the PR description: the
   list of 45 (or actual count) divergent roots from the pre-fix run, with the
   source-package distribution and the sampled per-pass `proof_manifest_json`
   diff for at least one atom showing the `path` field flipping from `<fnName>.props.ts`
   to a generic fallback.
3. **T3b (seed-sidecar guard) still passes.**
4. **T3c (props-corpus guard) passes,** loudly fails when even one `*.props.ts` is
   missing from `dist-recompiled/`.
5. **`pnpm -r test` (default, no `YAKCC_TWO_PASS`) is green** with no new failures
   and no new skips.
6. **`packages/cli` builds clean** and `packages/cli/dist/commands/plumbing-globs.js`
   contains the two new `*.props.ts` patterns.
7. **`workspace_plumbing` row delta** is +73 (±2). Implementer reports the observed
   integer.
8. **No `blocks`-table `block_merkle_root` value churn** between pre-fix and post-fix
   `bootstrap/yakcc.registry.sqlite`. Implementer reports the diff command and its
   empty output.
9. **`bootstrap/expected-roots.json` regenerated** and committed. Diff is dominated by
   `workspace_plumbing`-derived entries (~73 new entries) and zero existing
   `block_merkle_root` values changed.
10. **Two new `@decision` annotations are in place** with full rationale:
    `DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001` in `plumbing-globs.ts`, and
    `DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001` in `two-pass-equivalence.test.ts`.
11. **Scope Manifest compliance** verified by reviewer — no forbidden file modified.
12. **`*.props.ts` glob did not expand to zero** (mtime check pass + dry-run expansion
    showing 73 matches before the regen ran).

---

## 6. Risks / rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| `**` glob silently no-ops (v2-of-#494 trap) | — | FS-5 forbids `**`; mandatory dry-run expansion check; T3c uses a recursive walk that catches any depth-≥2 props file the glob would miss. |
| Stale `dist/` makes the regen run with old globs | Medium | FS-4 forbids skipping `pnpm -r build`; mandatory mtime check on `plumbing-globs.js`. |
| `*.props.ts` glob accidentally matches `*.props.test.ts` | None | No `*.props.test.ts` filename exists in the codebase that wouldn't already be skipped by the `.test.ts` filter; the regex `^…\.props\.ts$` is anchored — `foo.props.test.ts` does not end in exactly `.props.ts`. |
| A future `*.props.ts` is added at depth ≥ 2 below `src/` | Low | The two glob patterns would miss it. T3c uses a recursive walk that will fail loudly and name the missed file. The `@decision` block documents that a third pattern must be added. |
| Props files import helpers absent in `dist-recompiled/` | None | Props files are corpus **bytes**, hashed verbatim; never compiled by the shave pipeline. Only the file content's blake3 hash + the `path` field feed `proof_root`. |
| Bootstrap regen produces a *different* set of divergent roots (a second axis) | Low | If `divergent` → 0, done. If `divergent` is reduced but non-zero, the residual is a new axis → file a new WI, do NOT expand this fix's scope. |
| **Blast radius on main:** does adding `*.props.ts` to plumbing change any existing `block_merkle_root` values? | Low — explicit check | It should NOT change pass-1 (the canonical workspace already has every `*.props.ts` on disk; pass-1 `proof_manifest_json` is unchanged). It changes only pass-2 reconstruction (the recompiled workspace gains the 73 files it was missing). The regen adds ~73 `workspace_plumbing` rows but should not alter any `blocks`-table `block_merkle_root`. **Required real-path check 4 makes this explicit:** diff the `blocks` table pre/post regen — only `workspace_plumbing` rows should differ; zero `block_merkle_root` changes. If any `block_merkle_root` changes, STOP and escalate. |
| Hypothesis is wrong: the 45 divergent roots are NOT from `*.props.ts` siblings | Low (evidence is strong; see §1) | §5 Required real-path check 5 + §7 contingency: the implementer's FIRST action is divergent-cluster confirmation. If the cluster is a different file class, halt — do not patch the wrong axis. New planner cycle. |
| Two-pass wall-time (~60-90 min) blocks rapid iteration | Medium | Implementer runs the two-pass at most twice: once pre-fix to confirm cluster, once post-fix to verify divergent=0. T3c can be unit-tested in isolation (recursive walk + missing-file synthesis) without re-running the full cycle. The bootstrap regen is the dominant cost — plan budget includes one regen, not multiple. |

**Rollback boundary:** revert Fix E's 2 glob lines + Fix F's `it()` block + restore
`bootstrap/expected-roots.json` (and any sibling `bootstrap/` files regenerated) from
the pre-fix commit. The fix is purely additive; nothing else in the codebase depends on
the new globs. The #520 Fix A (seed triplets) is independent and untouched.

If capture-as-plumbing proves insufficient (e.g., divergent reduces but does not hit 0
after the regen), escalate to the rejected alternative — filesystem-independent corpus
artifact paths — as a new planner cycle. That path changes every corpus root and needs
its own plan + full `expected-roots` regen + a different review gate.

---

## 7. Contingency: hypothesis wrong

If the divergent-cluster confirmation in §5 / Required real-path check 5 produces a
cluster that does NOT match the `*.props.ts` pattern (e.g., the 45 roots come from
`packages/shave/src/__fixtures__/validator-13.15.35/` files somehow making it into
the shave path despite `shouldSkip`, or from `corpus.json` loading into a registry
seed table that flows into `proof_manifest`, or from a #539-introduced atom in
`packages/hooks-base/src/import-classifier.ts` / `import-intercept.ts` /
`packages/compile/src/import-gate.ts`), the implementer:

1. **Halts** at the confirmation step. No source edits.
2. **Reports back** with `REVIEW_VERDICT=blocked_by_plan` (if dispatched as
   implementer→reviewer→guardian flow) or a planner re-dispatch request (if the chain
   is still under planner control). The report names the actual cluster, the actual
   per-pass proof-manifest path values, and any new source files in the cluster
   relative to `d9f1ca7` (the last known green main).
3. **Does NOT** attempt to fix the unknown axis with the props-files patch — that would
   add globs that match nothing in the unknown-axis case and waste a regen cycle.

The strong evidence (mechanism unchanged since #494, glob list literally missing the
props patterns, 73-file count matches the v3 enumeration exactly) places this contingency
at low probability, but the planner does not assume — the data does.

The next planner cycle, if reached, would investigate:

- **Hypothesis B**: `#539` (WI-508 Slice 1) added new atom-source files
  (`packages/hooks-base/src/import-classifier.ts`, `import-intercept.ts`,
  `packages/compile/src/import-gate.ts`). If their proof manifests are
  filesystem-dependent on something in the new file tree, a different plumbing surface
  is missing. The dispatching prompt's note that #539's CI run flagged "two-pass
  bootstrap equivalence" as a failing job (but their PR fixed only a `package.json`
  exports map) is a thread to pull on.
- **Hypothesis C**: a corpus extractor other than `props-file.ts` has filesystem-presence
  -dependent path output that was always latent. #494 v3 §8 Q3 explicitly flagged this
  as an open follow-up; if confirmed here, file a new WI to make every corpus extractor's
  artifact path filesystem-independent.

These hypotheses are documented for planner continuity, not for this work item to chase.

---

## 8. Open questions for implementer

- **Q1 (resolved by §1 / §3).** Are the `*.props.ts` patterns in `PLUMBING_INCLUDE_GLOBS`
  today? **No.** Only the seed-triplet globs from #520. Fix E adds them.
- **Q2 (resolved by §1).** Are all 73 `*.props.ts` files within the two literal-depth
  glob patterns? **Yes** — 42 at depth 4, 31 at depth 5. T3c's recursive walk guards
  against future drift.
- **Q3 (open; resolution required at implementer step 1).** Does the divergent-cluster
  confirmation (§5 / Required real-path check 5) match the `*.props.ts` pattern? If not,
  halt per §7.
- **Q4 (open; carryover from #494 v3 §8 Q3).** Do other corpus extractors
  (`upstream-test.ts`, `documented-usage.ts`, `ai-derived.ts`) emit filesystem-presence-
  dependent `path` values for their artifacts? Out of scope for this fix; file a
  follow-up WI if a grep finds another such extractor whose sidecar inputs aren't
  captured as plumbing.

---

## 9. Cross-references

- `plans/wi-fix-494-twopass-nondeterm.md` on `origin/main` — v3 plan, mechanism authority
  for this fix.
- `plans/wi-510-s2-headline-bindings.md` on `origin/main` — #544's plan; documents that
  no atom-source files were added by Slice 2.
- PR #520 commit `51febd4` — landed Fix A (seed triplets) but not Fix E (props files).
- Issue #545 — current issue.
- Issue #494 — original issue. `#520 Closes #494` was premature.

---

## 10. MASTER_PLAN.md amendment (deferred; orchestrator-write-gated)

The planner attempted to amend `MASTER_PLAN.md`'s `Slice 2.5 work items` table and
`Decision Log` to record this WI in-line. The governance-markdown write was denied by
the pre-edit policy hook (governance markdown is gated to a specific writer identity
the current actor does not satisfy). Rather than block the plan deliverable, the
amendment is captured here verbatim so the next planner pass (or a reviewer/guardian
landing-time merge) can apply it as a documentation slice.

### Amendment 10.1 — update WI-FIX-494 row in `Slice 2.5 work items` table

In `MASTER_PLAN.md` under `### Initiative: WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` →
`#### Slice 2 / Slice 2.5 …` (line ~1950 on `origin/main`), the existing row:

```
| WI-FIX-494-TWOPASS-NONDETERM | … | L | WI-B4-MATRIX-REAL-RUN-001 (so validation isn't blocked) | review | 2 |
```

…gains a state-marker suffix in the same row pattern as other completed WIs in the
file (`[x] done — landed at <sha>`):

```
… | L | WI-B4-MATRIX-REAL-RUN-001 (so validation isn't blocked) | review | 2 | [x] partially landed at `51febd4` (PR #520) — Fix A (seed-triplet sidecars) only. Fix E (`*.props.ts` plumbing) was never landed; the v3 plan's Fix E carries forward into WI-FIX-545-TWOPASS-VALIDATOR below. #520's "Closes #494" was premature; #545 finishes the work. |
```

### Amendment 10.2 — insert WI-FIX-545 row immediately after WI-FIX-494

A new row, same table:

```
| WI-FIX-545-TWOPASS-VALIDATOR | Two-pass equivalence regression visible after PR #544 (WI-510 Slice 2 — validator headline bindings) merged: 45 divergent `block_merkle_root` values between registry A (pass 1) and registry B (pass 2) on `origin/main` (issue #545). Evidence (`plans/wi-fix-545-twopass-validator.md` §1) shows this is the un-landed v3 Fix E from #494: `PLUMBING_INCLUDE_GLOBS` contains zero `*.props.ts` patterns; 73 hand-authored `*.props.ts` files exist at depths 4/5 under `packages/*/src/`; `props-file.ts:extractFromPropsFile` records a filesystem-presence-dependent `path` in the proof manifest, driving merkle divergence in pass 2 when `compile-self` does not rematerialise those files. Implementer MUST FIRST run two-pass on this branch and confirm divergent-cluster matches the props-files pattern; if not, halt per §7. Fix on confirmation: add two single-segment `packages/*/src/*.props.ts` + `packages/*/src/*/*.props.ts` patterns; add T3c regression guard; regenerate `bootstrap/expected-roots.json`. Emits DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001 and DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001. | M | WI-FIX-494-TWOPASS-NONDETERM (mechanism authority) | review | 2 |
```

### Amendment 10.3 — Decision Log additions

In `MASTER_PLAN.md` under `## Decision Log` (line ~2300), append two new rows
following the existing chronological order convention:

```
| DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001 | `*.props.ts` hand-authored property-test corpus files (two literal depths: `packages/*/src/*.props.ts` and `packages/*/src/*/*.props.ts`) are workspace plumbing. Amends DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001 and is a sibling of DEC-V2-WORKSPACE-PLUMBING-SEED-TRIPLETS-001. | Props files are corpus inputs to the shave pipeline's props-file extractor (packages/shave/src/corpus/props-file.ts:extractFromPropsFile), not atoms — bootstrap.ts:200 explicitly skips them from shaving via the `.props.ts` filename guard, so capturing them as plumbing never conflicts with atom reconstruction. The extractor records a filesystem-presence-dependent `path` in the proof manifest (`<atomName>.props.ts` when present; a generic fallback when absent), so proof_root and block_merkle_root depend on whether the recompiled workspace rematerialises the props file. Capturing them as plumbing makes compile-self rematerialise them, closing the divergence. Two single-segment patterns (not `**`) are required because `bootstrap.ts:expandPlumbingGlob` supports single-segment `*` only; `**` segments compile to `[^/]*` and match a literal directory named `**`, which does not exist. The 73 props files split 42 at depth 4 / 31 at depth 5; two literal-depth patterns are exhaustive. A future depth-≥2 props file would be missed by the globs and caught by T3c. |
| DEC-V2-HARNESS-PROPS-CORPUS-CHECK-001 | Two-pass harness asserts every `*.props.ts` enumerated under `packages/*/src/` in the canonical workspace exists at the same workspace-relative path inside `dist-recompiled/`. New `it("T3c: …")` in `examples/v2-self-shave-poc/test/two-pass-equivalence.test.ts`, sibling of T3b (seed sidecars). | Upstream regression guard for DEC-V2-WORKSPACE-PLUMBING-PROPS-CORPUS-001. The recursive walk (not a glob expansion) catches a depth-≥2 props file that the two glob patterns would silently miss, naming the missed file in the failure message rather than waiting for the downstream root-divergence failure to surface abstract hashes. Same hard-fail precondition pattern as T3b (DEC-V2-TWO-PASS-PRECONDITION-001). |
```

### Amendment 10.4 (optional housekeeping)

The "Slice 2.5 directional outcomes" bullet under the existing
`### Initiative: WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` body that reads
*"Byte-identity invariant restored: pass-1 ≡ pass-2 strict-Set equality across all
included blockMerkleRoots"* may have its date-of-closure deferred until WI-FIX-545
lands (this WI, not #494, is the one that actually closes the byte-identity invariant
restoration). No change to wording required; the closure footnote will follow when the
fix actually lands.
