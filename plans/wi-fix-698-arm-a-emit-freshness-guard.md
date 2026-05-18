# WI-fix-698 — arm-a-emit.mjs freshness guard (prevent stale gold-standard preference)

- **Workflow ID:** `fix-698-arm-a-emit-freshness-guard`
- **Goal ID:** `g-fix-698-arm-a-emit-freshness-guard`
- **Implementer work item:** `fix-698-arm-a-emit-freshness-guard-impl`
- **Branch:** `feature/fix-698-arm-a-emit-freshness-guard`
- **Worktree:** `C:/src/yakcc/.worktrees/feature-fix-698-arm-a-emit-freshness-guard`
- **Ticket:** [#698](https://github.com/cneckar/yakcc/issues/698)
- **Companion ticket (parallel slice, disjoint scope):** [#697](https://github.com/cneckar/yakcc/issues/697) — regenerates the stale `examples/parse-int-list/dist/module.mjs`
- **Predecessor plan:** [`plans/wi-692-b9-axis2-falsepos.md`](./wi-692-b9-axis2-falsepos.md) — root-cause diagnosis + provenance fields landed in PR #693/#700
- **Initiative:** v1 — Benchmark Suite Characterisation Pass → B9 Slice 1 — bug-class follow-ups (per #167 Principle 6)
- **Complexity tier:** **Tier 2 (Standard)** — single source file + single test file, but introduces a new "freshness guard" semantic surface inside an existing authority (`resolveArmAEmit`), is guardian-bound, requires an explicit @decision annotation for the new policy, and ships with a regression test that simulates stale-artifact conditions.

## 1. Problem statement

`bench/B9-min-surface/harness/arm-a-emit.mjs::resolveArmAEmit()` unconditionally
prefers the yakcc-compile output (`examples/parse-int-list/dist/module.mjs`)
over the bench fallback reference whenever the dist file exists (current
`arm-a-emit.mjs` lines 114-123). This "always prefer the gold-standard if
present" rule is unsafe in practice: the gold-standard artifact has no
freshness contract relative to the bench fallback, so when the dist file
predates a relevant fix commit, the harness silently routes through the
**stale** artifact while reporting "yakcc-compile" as the source.

This is exactly the failure mode that produced the 2026-05-18 B9 axis2
false-positive captured in #692:

- `examples/parse-int-list/dist/module.mjs` mtime: **Apr 29 2026**
- Bench fallback `bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs`
  mtime: **post-#636 (May 17 2026)** with the leading-zeros guard
- Result: `listOfInts('[007]')` returned `[7]` against the stale dist file
  instead of throwing the `SyntaxError` the bench reference would throw

The provenance fields added in WI-692 (`emit_mtime_iso`, `emit_sha256_short`,
`emit_path_resolved`, `emit_bytes`) make the *symptom* self-diagnosing post hoc,
but they do not *prevent* the next stale-artifact false-positive — they just
make the forensic root-cause faster.

**Why this is a #167 Principle 6 bug-class WI, not a tuning knob.**
The B9 sweep's headline reads "yakcc atomic emission refuses adversarial
shape inputs." If the harness silently invokes a stale artifact that *doesn't*
refuse, the headline is a measurement artefact, not a property of the
atomization pipeline. Defence-in-depth here keeps the bench honest the next
time a fix lands without a corresponding `yakcc compile` re-run.

This is **complementary** to #697 (regenerate the stale dist artifact).
#697 cures *today's* stale file; this WI prevents the *next* recurrence and
catches it loud rather than silent.

## 2. Architecture / state-authority map

This WI touches a single state authority: **B9 emit-resolution**.

- **Canonical authority:** `bench/B9-min-surface/harness/arm-a-emit.mjs::resolveArmAEmit()` — the sole owner of `(taskId, strategy) → emitPath` resolution.
- **Adjacent authorities (read-only consumers, NOT modified):**
  - `bench/B9-min-surface/harness/run.mjs` (line 449/483) — destructures `resolveArmAEmit` from `arm-a-emit.mjs` and calls it inside the per-task loop. Receives `{ emitPath, source }` today; will continue to receive the same shape (source enum is extended, not narrowed).
  - `bench/B9-min-surface/harness/measure-axis2.mjs` — does not call `resolveArmAEmit` directly; receives `--emit <path>` from the orchestrator. **Not modified.**
  - `bench/B9-min-surface/harness/listAllArmAEmits()` — uses `resolveArmAEmit` internally inside the same file. Continues to work; will surface the guard's new `source` value through `listAllArmAEmits`'s entry shape.
- **Adjacent authorities (NOT touched, deliberately out of scope):**
  - `examples/parse-int-list/dist/module.mjs` — that's #697's scope. This WI must NOT regenerate, delete, or `touch` the artifact. Touching it would defeat the test: a stale-artifact scenario requires a stale artifact.
  - `bench/B10-import-replacement/harness/arm-a-emit.mjs` — B10 has its own `resolveArmAEmit` analog. B10 is out of scope; if B10 needs the same guard it is a follow-up WI.
- **No new DEC ledger entry, but one new file-local @decision annotation.** The new freshness-guard policy is a *refinement* of `DEC-V0-MIN-SURFACE-004` (Arm A granularity sweep) and is documented inline in `arm-a-emit.mjs` as `DEC-B9-EMIT-FRESHNESS-GUARD-001`. It is not a kernel-level decision so it does not need a row in the MASTER_PLAN Decision Log (per Tier 2's policy that file-local refinements live at the call site).

**Architecture preservation check (per CLAUDE.md "Architecture Preservation"):**
- One authority per fact (emit resolution). ✓
- Hooks-as-adapters: this is harness internal logic, not a hook. ✓
- No parallel authorities — the guard extends the existing authority rather than introducing a sibling resolver. ✓
- Bundle change (source + invariant test + provenance source enum) lands in one PR. ✓

## 3. Design decisions (file-local, not kernel)

### DEC-B9-EMIT-FRESHNESS-GUARD-001 — Guard semantics

**@decision DEC-B9-EMIT-FRESHNESS-GUARD-001**
**@title Compare mtime of compiled gold-standard vs bench fallback; fall back when stale.**
**@status accepted by planner; landed in code by implementer.**

**Three candidates considered:**

| Candidate | Behaviour when dist is older than bench fallback | Pros | Cons |
|---|---|---|---|
| **(A) Silent fallback + stderr warning** | Return bench fallback path; print `[arm-a-emit] WARN: yakcc-compile artifact at <path> mtime=<dist-mtime> is older than bench fallback at <fallback-path> mtime=<fallback-mtime>; falling back to bench reference. Pass --force-gold-standard or {forceGoldStandard:true} to override.` to stderr. | Bench runs always produce a working measurement against the freshest reference. Operator gets a loud, greppable warning in stderr. Backward-compatible with the existing `{ emitPath, source }` return shape. | Operator might miss the warning if they only inspect stdout/JSON. |
| **(B) Throw unless `--force-gold-standard` set** | Throw `StaleEmitError`; require explicit opt-in. | Cannot be missed — bench fails closed. | Breaks `run.mjs` and `listAllArmAEmits()` flow when any dev forgets to regenerate `dist/module.mjs` after a touched-source commit. Heavy-handed for a sweep harness whose primary purpose is "produce numbers." |
| **(C) Content-hash allowlist** | Maintain a `known-good-shas.json` of accepted dist SHAs; mismatch → fallback. | Catches *semantic* drift, not just temporal. | Requires hash list maintenance across every dist regenerate. Doubles the surface that can rot. Brittle and gives the appearance of safety without solving the root issue (mtime drift between fixes). |

**Recommendation accepted: (A) silent fallback + stderr warning + opt-in override.**

Rationale (binding for implementer):
- B9 axis2 callers (`run.mjs` per-task loop, `listAllArmAEmits` enumeration) want a *working measurement* against the freshest available reference, not a hard fail that requires operator intervention.
- The stderr warning is loud enough for any honest operator to notice; the JSON output additionally carries the `source` enum value `bench-reference-stale-fallback` so post-hoc inspection of `results-*.json` shows the fallback path was used.
- The opt-in override `--force-gold-standard` (CLI) / `{ forceGoldStandard: true }` (module API) preserves the ability to deliberately measure the older artifact — e.g., regression testing the dist file before regeneration, or comparing pre/post-#636 axis2 numbers.
- (B) is rejected because it breaks `run.mjs`'s sweep iteration on every stale-artifact case; the existing per-task `try/catch` in `run.mjs` would turn into "skip task" rather than "use bench fallback," which produces incomplete results without addressing the root cause.
- (C) is rejected as adding maintenance surface without a corresponding gain: SHA mismatch is a strict subset of mtime drift (any content change updates mtime), and the SHA list itself becomes a new authority to keep in sync.

### DEC-B9-EMIT-FRESHNESS-GUARD-002 — Caller-signalling mechanism

**@decision DEC-B9-EMIT-FRESHNESS-GUARD-002**
**@title Dual signalling: CLI flag `--force-gold-standard` for direct invocation; options-object `{ forceGoldStandard: true }` for module callers.**
**@status accepted.**

`resolveArmAEmit()` is invoked through two paths today:

1. **Module path:** `import { resolveArmAEmit } from './arm-a-emit.mjs'` (`run.mjs` line 449/483; `listAllArmAEmits()` line 157; `test/arm-a-emit.test.mjs`).
2. **CLI path:** `node bench/B9-min-surface/harness/arm-a-emit.mjs --task <id> --strategy <s>`.

**Decision:** the new signal is exposed as an **optional fourth parameter** to `resolveArmAEmit(repoRoot, taskId, strategy, options = {})`, where `options.forceGoldStandard` is the override boolean. The CLI section of the file already uses `parseArgs`; it gains a `"force-gold-standard": { type: "boolean", default: false }` option and forwards `{ forceGoldStandard: cliArgs["force-gold-standard"] }` to `resolveArmAEmit`. `listAllArmAEmits()` receives the same options object as a new optional parameter so callers can choose to enumerate with the override.

Rationale:
- The options-object pattern is JS-idiomatic and backward-compatible (existing 3-arg callers — `run.mjs` line 483, the existing tests' 3-arg calls — keep working unchanged; `options` defaults to `{}` which means "guard enabled, no override").
- Mirrors the existing `parseArgs` style in the CLI block so the CLI surface is uniform with the rest of the file's options.
- Avoids the `process.argv` scan inside `resolveArmAEmit()` itself — making the guard library-pure (no global state read), which the existing unit test convention requires.

**Rejected alternatives:**
- Read `process.argv` from inside `resolveArmAEmit()`: makes the function dependent on global state and untestable without process-arg mocking. Rejected.
- Environment variable `B9_FORCE_GOLD_STANDARD=1`: invisible from the function signature, makes the unit test rely on `process.env` mutation. Rejected.
- Default-on override: defeats the whole point of the guard. Rejected per "do not use `--force-gold-standard` as the DEFAULT" rule in the planner contract.

## 4. Implementer task list (commit-boundary suggestions)

The implementer may collapse these into a single commit if the diff stays tight, but the suggested ordering reflects how to keep `pnpm -w typecheck` green at each step.

**Commit 1 — Guard implementation + provenance enum + @decision annotation.**
- Add `import { statSync } from "node:fs"` to the existing `node:fs` import group in `arm-a-emit.mjs`.
- Extend `resolveArmAEmit(repoRoot, taskId, strategy, options = {})` signature.
- Inside the `parse-int-list` + `A-fine` branch (current lines 114-123):
  1. If `compiledMjs` does not exist → fall through to bench reference (unchanged behaviour).
  2. If `compiledMjs` exists AND `options.forceGoldStandard === true` → return `{ emitPath: compiledMjs, source: "yakcc-compile" }` (unchanged behaviour modulo the override).
  3. If `compiledMjs` exists AND `options.forceGoldStandard !== true`: stat both `compiledMjs` and the bench-reference path. If `compiledMjsStat.mtimeMs >= benchStat.mtimeMs` → return `{ emitPath: compiledMjs, source: "yakcc-compile" }` (today's path when dist is fresh). If `compiledMjsStat.mtimeMs < benchStat.mtimeMs` → emit the stderr warning and return `{ emitPath: benchPath, source: "bench-reference-stale-fallback" }`.
- Add the `@decision DEC-B9-EMIT-FRESHNESS-GUARD-001` block as a comment-header preceding the modified branch (mirror the format of the existing `DEC-V0-MIN-SURFACE-004` header at the top of the file).
- Update the JSDoc for `resolveArmAEmit` to document the new `options` parameter and the extended `source` enum: `"yakcc-compile" | "bench-reference" | "bench-reference-stale-fallback"`.
- Extend `listAllArmAEmits(repoRoot, taskIds, options = {})` to thread `options` through to its internal `resolveArmAEmit` call.
- Extend the CLI `parseArgs` options block with `"force-gold-standard": { type: "boolean", default: false }`. Forward `{ forceGoldStandard: cliArgs["force-gold-standard"] }` to both `resolveArmAEmit` and `listAllArmAEmits` in the CLI dispatch.
- Update the CLI usage string (lines 242-243) to document `--force-gold-standard`.

**Commit 2 — Unit tests.**
- Append to `bench/B9-min-surface/test/arm-a-emit.test.mjs` (do **not** create a new test file — the existing file is the canonical home for `arm-a-emit.mjs` tests per the codebase convention).
- Add three tests:
  1. `arm-a-emit: freshness guard — falls back to bench reference when dist mtime older than fallback` — uses `node:fs/promises.utimes` to backdate a *temporary copy* of the dist file inside `tmp/wi-fix-698-*`, points `repoRoot` at the temp tree (so we don't mutate the real `examples/parse-int-list/dist/module.mjs`), and asserts the return value `{ source: "bench-reference-stale-fallback", emitPath: <bench fallback path> }`.
  2. `arm-a-emit: freshness guard — returns yakcc-compile path when dist mtime newer than fallback` — same setup with a forward-dated dist mtime; asserts `{ source: "yakcc-compile" }`.
  3. `arm-a-emit: --force-gold-standard override returns yakcc-compile path even when dist is stale` — same stale setup, but `resolveArmAEmit(..., { forceGoldStandard: true })`; asserts `{ source: "yakcc-compile" }`. Stderr capture asserts no warning is printed.
- The fixture-building helper writes a minimal stub `dist/module.mjs` and a sibling `tasks/parse-int-list/arm-a/fine.mjs` under a `tmp/wi-fix-698-fixtures/<test-name>/` tree, then backdates whichever file needs to be "older." This avoids any mutation under `examples/` or `bench/B9-min-surface/tasks/`. Use `import { mkdtempSync } from "node:fs"` to create the fixture root if a helper does not already exist.
- A fourth test asserts the **stderr warning content** when the guard fires: captures stderr (via `child_process.spawnSync` invoking the CLI with `--task parse-int-list --strategy A-fine --json` against a stale-fixture repo root), asserts the warning string contains `WARN`, `mtime`, and the fallback path. (Subprocess form mirrors existing Test 8/Test 9 spawnSync pattern in the same file.)
- An optional fifth test (NICE-TO-HAVE, not required for Eval Contract): asserts the CLI `--force-gold-standard` flag round-trips through `parseArgs` and is honoured.

**Commit 3 (optional) — README/inline note.**
- If there is a `bench/B9-min-surface/README.md` section on Arm A reference selection, append a single paragraph documenting the freshness guard. Skip if no such section exists; the @decision block in source is the authoritative documentation.

The implementer should land all three commits before declaring `READY_FOR_REVIEWER`. Do **not** split this WI across multiple PRs.

## 5. Evaluation Contract (binding for implementer + reviewer)

### required_tests
- `node --test bench/B9-min-surface/test/arm-a-emit.test.mjs` — all existing tests still pass (Tests 1-9 from the current file).
- The three new tests from Commit 2 pass on a clean run:
  - GIVEN `compiledMjs` mtime *older* than `benchPath` mtime AND `options.forceGoldStandard !== true` → `resolveArmAEmit` returns `{ source: "bench-reference-stale-fallback", emitPath: <bench fallback path> }` AND prints a warning to stderr containing `WARN`, `mtime`, and the bench fallback path.
  - GIVEN `compiledMjs` mtime *newer* than `benchPath` mtime → `resolveArmAEmit` returns `{ source: "yakcc-compile", emitPath: <compiled dist path> }` AND prints nothing to stderr.
  - GIVEN `compiledMjs` mtime *older* than `benchPath` mtime AND `options.forceGoldStandard === true` → `resolveArmAEmit` returns `{ source: "yakcc-compile", emitPath: <compiled dist path> }` AND prints nothing to stderr.
- Existing B9 axis2 behavior unchanged on the real repo today: `pnpm exec node bench/B9-min-surface/harness/arm-a-emit.mjs --task parse-int-list --strategy A-fine --json` returns whichever source is correct given the **actual** mtimes at HEAD time (today, post-#697 landing, that should be `yakcc-compile`; pre-#697, it is `bench-reference-stale-fallback` and the warning fires — both are correct behaviors).

### required_evidence
- Reviewer attaches the unified diff of `arm-a-emit.mjs` showing the new `@decision DEC-B9-EMIT-FRESHNESS-GUARD-001` block, the extended function signature, and the three-branch resolution logic.
- Reviewer attaches the unified diff of `test/arm-a-emit.test.mjs` showing the three new tests.
- Reviewer attaches the full `node --test bench/B9-min-surface/test/arm-a-emit.test.mjs` output (must show all 12 tests passing — 9 existing + 3 new; the optional 4th-stderr-content / 5th-CLI-flag tests, if added, raise the count further).
- Reviewer attaches stderr capture from one stale-fixture test confirming the warning string format.

### required_real_path_checks
- `pnpm -w lint` — green across full workspace (NEVER `--filter <pkg>` per memory `feedback_eval_contract_match_ci_checks.md`).
- `pnpm -w typecheck` — green across full workspace (NEVER `--filter <pkg>`).
- `node --test bench/B9-min-surface/test/arm-a-emit.test.mjs` — green (the directly-touched test file, all tests including new ones).
- `node bench/B9-min-surface/harness/arm-a-emit.mjs --list --json` — succeeds with exit 0; output JSON parses; 18 entries present; no entry has `error` set. (Smoke test that the existing CLI path still works post-refactor.)

### required_authority_invariants
- `resolveArmAEmit` remains the sole authority over `(taskId, strategy) → emitPath` resolution. No new sibling resolver is introduced.
- The `source` enum is **extended**, not redefined: `"yakcc-compile"` and `"bench-reference"` retain their existing semantics; `"bench-reference-stale-fallback"` is a new third value indicating the guard fired. Existing consumers (`run.mjs`, `listAllArmAEmits`, tests) that switch on `source === "bench-reference" || source === "yakcc-compile"` will see the new value pass-through; the existing Test 3 assertion `source === "bench-reference" || source === "yakcc-compile"` MUST be updated to also accept `"bench-reference-stale-fallback"` (this is the single mechanical change to an existing test; flag in the diff).
- `DEC-V0-MIN-SURFACE-004` (Arm A granularity sweep) remains authoritative; `DEC-B9-EMIT-FRESHNESS-GUARD-001` is a file-local *refinement* of that DEC, not a replacement.
- No mutation of `examples/parse-int-list/dist/module.mjs` mtime or contents in any test or harness code. The stale-condition must be simulated under `tmp/`.
- No mutation of `bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs` mtime or contents in any test or harness code. Same reason.

### required_integration_points
- `run.mjs` line 483 destructure `const { emitPath } = resolveArmAEmit(REPO_ROOT, taskId, strategy);` continues to work unchanged (3-arg call form, `options` defaults to `{}`). Verify by inspecting `run.mjs` post-implementation — no changes required, but the destructure must not break. Reviewer confirms in the change summary.
- `listAllArmAEmits(WORKTREE_ROOT, taskIds)` in `test/measure-axis5.test.mjs` line 248 continues to work unchanged (2-arg call form, `options` defaults to `{}`). Reviewer confirms.
- CLI `arm-a-emit.mjs --task <id> --strategy <s>` continues to print the existing 5 fields (`task_id`, `strategy`, `emit_path`, `entry_function`, `source`). The `source` field may now carry the new third enum value; the CLI text-output formatter does not need changes (it already just prints whatever `source` is).

### forbidden_shortcuts
- Do NOT modify `examples/parse-int-list/dist/*` in any way (regenerate, touch, delete) — that is #697's exclusive scope. This WI must succeed even on a worktree where `dist/module.mjs` is the stale Apr-29 file.
- Do NOT remove or invert the gold-standard preference — the rule remains "prefer dist when fresh; fall back only when stale or absent." Inverting it (always prefer bench fallback) is a wholly different design and is rejected per (C) discussion above.
- Do NOT use `--force-gold-standard` as the DEFAULT — guard must be ON by default; override is opt-in.
- Do NOT use `it.skip`, `t.skip`, `test.skipIf(...)`, or any equivalent on any failing test. If a test cannot pass, escalate to planner via `BLOCKED_BY_PLAN` per the implementer protocol.
- Do NOT broaden scope to refactor `arm-a-emit.mjs` beyond the freshness-guard addition (no helper-function extraction, no CLI option-block restructure beyond adding the one flag, no JSDoc rewrite beyond updating the `resolveArmAEmit` block).
- Do NOT touch `bench/B10-import-replacement/harness/arm-a-emit.mjs` — B10 is out of scope; if it needs the same guard it is a follow-up WI.
- Do NOT touch `bench/B9-min-surface/harness/measure-axis2.mjs` — the provenance fields landed in WI-692 already cover the diagnostic surface; this WI is the *prevention* surface, owned by `arm-a-emit.mjs` exclusively.
- Do NOT introduce cross-package imports (`../../../packages/...`) — only `node:` builtins and same-package relative imports are permitted per memory `feedback_no_cross_package_imports.md`.
- Do NOT mutate global state (`process.env`, `process.argv`, module-level `let` mutation) inside `resolveArmAEmit`. The guard must remain a pure function of its arguments.

### rollback_boundary
Per-file revert is clean. The change is contained to two files (`arm-a-emit.mjs` + `arm-a-emit.test.mjs`). The new `source` enum value is additive — consumers that don't know about it will still see a valid string. Reverting this WI restores today's "always prefer dist when present" behavior without touching any other file.

### ready_for_guardian_definition
- All `required_tests` pass at the implementer's pushed HEAD SHA.
- All four `required_real_path_checks` are green on the implementer's pushed HEAD SHA.
- All `required_authority_invariants` are met (reviewer-verified by inspection of the diff).
- All `required_integration_points` are met (reviewer-verified by inspection of `run.mjs` / `test/measure-axis5.test.mjs` / CLI path — no edits to those files; existing callers unaffected).
- Reviewer issues `REVIEW_VERDICT: ready_for_guardian` against the pushed HEAD SHA.
- PR exists with `closes #698` in the body, links to this plan, and references PR #697 (companion).
- No Guardian-merge-to-main dispatch (per memory `feedback_pr_not_guardian_merge.md`); PR landed via GitHub merge button after CI green + reviewer approval.

## 6. Scope Manifest (mirror in `tmp/scope-fix-698-arm-a-emit-freshness-guard.json`)

### allowed_paths
- `bench/B9-min-surface/harness/arm-a-emit.mjs` — the freshness guard source.
- `bench/B9-min-surface/test/arm-a-emit.test.mjs` — the freshness guard tests (existing file; append new tests; minimally modify Test 3 source-enum assertion).
- `plans/wi-fix-698-arm-a-emit-freshness-guard.md` — this plan, owned by planner.
- `tmp/scope-fix-698-arm-a-emit-freshness-guard.json` — machine scope manifest, owned by planner.
- `tmp/wi-fix-698-*/**` — implementer-owned scratchlane for test fixtures (temp dist+bench file trees for stale-mtime simulation).
- `MASTER_PLAN.md` — owned by planner; **single row append** under the B9 Slice 1 bug-class follow-ups note (see §7 below). Planner-only; implementer must NOT modify.

### required_paths
- `bench/B9-min-surface/harness/arm-a-emit.mjs` — required: the new guard + @decision block + extended signature.
- `bench/B9-min-surface/test/arm-a-emit.test.mjs` — required: 3 new tests + 1 mechanical Test-3 enum-assertion widening.

### forbidden_paths
- `examples/**` — out of scope. Specifically `examples/parse-int-list/dist/module.mjs` is #697's responsibility; touching its mtime or contents from this WI defeats the test premise.
- `bench/B10-import-replacement/**` — B10 has its own analog; out of scope.
- `bench/B9-min-surface/harness/measure-axis2.mjs` — provenance fields already cover the diagnostic surface; this WI owns the prevention surface only.
- `bench/B9-min-surface/harness/measure-axis1.mjs`, `measure-axis3.mjs`, `measure-axis5.mjs`, `classify-arm-b.mjs`, `llm-baseline.mjs`, `run.mjs` — adjacent harness modules; not modified.
- `bench/B9-min-surface/tasks/**`, `bench/B9-min-surface/attack-classes/**`, `bench/B9-min-surface/fixtures/**` — not modified.
- All other `bench/**` directories — `B1`, `B2`, `B4-tokens`, `B4-tokens-v3`, `B6`, `B7`, etc. — out of scope.
- `packages/**` — no package source/test changes. The shave engine, registry, compile pipeline, contracts, IR, CLI, hooks, federation, variance, seeds — none of those are touched.
- `scripts/**`, `tools/**`, `bootstrap/**`, `docs/**`, `patches/**`, `.github/**`, `.claude/**` — not modified.
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `turbo.json`, `biome.json` — root configs untouched.
- All other `plans/**` files — predecessor plan `wi-692-b9-axis2-falsepos.md` is sealed; companion plan for #697 (if/when filed) is a separate slice.

### state_domains
- `b9_emit_resolution` (this WI's authority — read+write: extends behavior with the freshness guard and new `source` enum value).
- `b9_test_invariants` (append-only: 3 new test cases + 1 mechanical assertion widening).

### authority_domains
*(no new control-plane authority created. `DEC-B9-EMIT-FRESHNESS-GUARD-001` and `-002` are file-local refinements of `DEC-V0-MIN-SURFACE-004`, documented at the implementation site.)*

## 7. MASTER_PLAN.md row (append under B9 Slice 1 bug-class follow-ups)

Append a single row to the existing "B9 Slice 1 bug-class follow-ups" ledger area (immediately following the Slice 1 work item table around line 1828). If no such sub-section exists, the planner adds a short sub-heading `**B9 Slice 1 bug-class follow-ups (per #167 Principle 6).**` after the Slice 1 work item table and seeds it with one row for this WI plus a back-reference row for WI-692 / #697.

Row format (mirror existing W-B9-S1-N ledger format):

| ID | Title | Weight | Deps | Gate | Status |
|----|-------|--------|------|------|--------|
| W-B9-S1-BUG-692 | B9 axis2 false `shape_escape` on `[007]` — provenance fields surface emit path/mtime/SHA in JSON output | M | W-B9-S1-4 | review | done — landed via #693 (per `plans/wi-692-b9-axis2-falsepos.md`) |
| W-B9-S1-BUG-697 | Regenerate stale `examples/parse-int-list/dist/module.mjs` from current source (post-#636) | S | — | review | in flight — issue #697 |
| W-B9-S1-BUG-698 | arm-a-emit.mjs freshness guard — fall back to bench reference when dist mtime predates fallback; `--force-gold-standard` opt-in override; `@decision DEC-B9-EMIT-FRESHNESS-GUARD-001` | S | W-B9-S1-7 | review | planned — issue #698 (this plan) |

The implementer does NOT modify MASTER_PLAN.md. The planner appends this section as part of plan delivery (alongside the plan file itself).

## 8. Standing rules referenced

- `memory/feedback_eval_contract_match_ci_checks.md` — full-workspace `pnpm -w lint` AND `pnpm -w typecheck` in eval contract; NEVER `--filter <pkg>`.
- `memory/feedback_pr_not_guardian_merge.md` — land via PR with `closes #698`, NOT via Guardian merge to main.
- `memory/feedback_fetch_before_pr.md` — `git fetch origin && git pull --ff-only origin main` inside the worktree immediately before `gh pr create`.
- `memory/feedback_no_cross_package_imports.md` — N/A (no new package-crossing imports; only `node:` builtins and same-file logic).
- `memory/feedback_planner_writes_to_wrong_cwd.md` — all plan artifacts written inside `C:/src/yakcc/.worktrees/feature-fix-698-arm-a-emit-freshness-guard/`, not main.
- `memory/feedback_worktree_naming_convention.md` — worktree path is `.worktrees/feature-fix-698-arm-a-emit-freshness-guard` (correct `feature-` prefix for `cc-policy worktree retire`).
- `memory/feedback_zero_byte_output_not_failure.md` — N/A here (no API-bearing calls).
- Sacred Practice #2 — no source edits on main; all implementation in the worktree.
- Sacred Practice #4 — nothing done until tested. Required tests are explicit; the implementer must run them locally pre-push.
- Sacred Practice #12 — single source of truth. `resolveArmAEmit` remains the sole emit-resolution authority; the guard is integrated into the existing authority rather than added as a sibling.

## 9. Quality Gate (planner self-check)

- ✅ All dependencies and state authorities are explicitly mapped (§2).
- ✅ Guardian-bound work item has an Evaluation Contract with executable acceptance criteria (§5).
- ✅ Guardian-bound work item has a Scope Manifest with explicit allowed/required/forbidden files (§6).
- ✅ No work item relies on narrative completion language — every contract clause names a runnable command, a greppable string, or a structural invariant.
- ✅ DEC-B9-EMIT-FRESHNESS-GUARD-001 and -002 are documented inline at the implementation site (file-local refinements, not kernel-level — per the Architecture Preservation rules for Tier 2).
- ✅ Three guard-semantic candidates (A/B/C) were explicitly weighed; (A) selected with explicit rationale (§3).
- ✅ Two caller-signal mechanisms (options-object vs `process.argv` scan vs env var) were explicitly weighed; options-object selected with explicit rationale (§3).
- ✅ Forbidden-shortcuts list explicitly bans the most-likely scope-creep paths: `examples/parse-int-list/dist/` (overlap with #697), `it.skip` evasions, default-on override, sibling resolver, global-state reads, and adjacent-file scope creep.
- ✅ Test strategy explicitly avoids mutating real artifacts (`examples/**`, `bench/B9-min-surface/tasks/**`) by simulating staleness under `tmp/wi-fix-698-*/`.
- ✅ Row append plan for MASTER_PLAN.md is planner-only and identifies the exact section (B9 Slice 1 bug-class follow-ups), preserving the immutable Slice 1 work-item table above it.

## 10. Next action

After this plan is written into the worktree, the planner emits
`PLAN_VERDICT: next_work_item` and the runtime dispatches Guardian
(provision) for `fix-698-arm-a-emit-freshness-guard-impl`, followed by
the implementer + reviewer + Guardian (land) canonical chain.
