# WI-510 Slice 2 — Per-Entry Shave of Four `validator` Headline Bindings

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 2 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (the B-scope dependency-following shave engine) is **landed on `main` as `37ec862`** (PR #526).
**Branch:** `feature/wi-510-s2-headline-bindings`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s2-headline-bindings`
**Authored:** 2026-05-14 (planner stage, workflow `WI-510-S2-HEADLINE-BINDINGS`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan), `plans/import-replacement-triad.md` (the triad coordination doc, §1 desired end state, §3 MVDP).
**Supersedes:** the abandoned `plans/wi-510-s2-validator.md` (last commit `f9c93f0` on the now-retired `feature/wi-510-s2-validator` branch).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. It records new DEC IDs in §8 to be annotated at the implementation point (consistent with how Slice 1 recorded `DEC-WI510-*`).

---

## 1. What changed — why this plan supersedes `wi-510-s2-validator.md`

The previous Slice 2 plan (`plans/wi-510-s2-validator.md`, last commit `f9c93f0` on `feature/wi-510-s2-validator`) shaved the **whole `validator` package** by calling `shavePackage()` against the vendored `validator-13.15.35/` directory with no `entryPath` override. With the default `resolvePackageEntry()` resolution, the entry point becomes `validator/index.js`, which re-exports all ~100 validator behaviors (`isAbaRouting`, `isAfter`, `isAlpha`, …). The BFS recursion produced **`moduleCount=113, stubCount=0, forestTotalLeafCount=1987`**, and even a single shared `beforeAll` traversal blew the default 30-second vitest timeout so hard the abandoned slice forced `testTimeout=3_600_000` (one full hour) on `packages/shave/vitest.config.ts` and ran for **2640 seconds (44 minutes) of pure test wall-clock** to complete §A–§E. The operator killed that approach on 2026-05-14:

> *"we only need to prove what's used in yakcc, the rest will get added later when we do a full shave into the production registry of validator etc"*

The reframe is **not** "shave the package more cleverly." It is: **shave only the four headline behaviors the triad demonstrates — `isEmail`, `isURL`, `isUUID`, `isAlphanumeric` — each as its own small subgraph, not the package as a whole.** Broader validator coverage (the other ~96 behaviors) is explicitly deferred to a later "full shave into the production registry" initiative; this slice does not plan it. The headline bindings are what `#508` Slice 1's import-intercept hook and `#512` Slice 2's B10 Arm A actually consume to demonstrate the triad's value-prop (`plans/import-replacement-triad.md` §1, §3 MVDP). Anything beyond those four is out of scope for Slice 2.

The crucial enabling fact is that the landed engine already supports per-entry shaving without an engine-source change — see §2.

---

## 2. Load-bearing question answered — this is Path A, no engine change needed

**Question:** Does `shavePackage()` currently accept a sub-entry (a single `lib/<binding>.js`), or does it always start from a `package.json` package root?

**Answer: Path A. `shavePackage()` already accepts an `entryPath` override.** Verified against `packages/shave/src/universalize/module-graph.ts` at `37ec862`:

```ts
// module-graph.ts:160-176
export interface ShavePackageOptions {
  readonly registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">;
  /**
   * Override the package entry-point path.
   * When not supplied, resolvePackageEntry(packageRoot) is used.
   */
  readonly entryPath?: string | undefined;
  readonly maxModules?: number | undefined;
}

// module-graph.ts:260
const entryResolved = options.entryPath ?? resolvePackageEntry(normalRoot);
```

The `entryPath` option is a first-class API surface of the landed engine. It is already covered by the engine's unit tests (`module-graph.test.ts` exercises it; the abandoned slice also relied on the default-resolution path). For Slice 2's per-entry shaves we pass:

- `packageRoot = <validator-fixture-root>` — so `isInPackageBoundary()` still scopes the BFS to validator's own directory tree (B-scope predicate untouched), and
- `entryPath = <validator-fixture-root>/lib/<binding>.js` — so the BFS starts at the specific headline behavior's module instead of `index.js`.

The BFS then walks only the transitively-reachable subgraph from that headline binding. No engine-source change in `packages/shave/src/universalize/**`. No new public-API surface. No `shaveModule()` sibling helper. No `shavePackage({ entryOverride })` option addition (because `entryPath` already exists). **The single load-bearing API question collapses to "use the option that's already there."**

This makes Slice 2 a **pure fixture-and-test slice**. The `approve` gate the abandoned plan reserved for Path B (engine amendment) is **not required**; the Slice 2 gate is **`review`**.

**Provenance for the per-entry path:** the abandoned slice's measurement evidence (commit `f9c93f0` message) records per-headline-module entry-kind histograms from inside the whole-package shave — `isEmail.js: novel-glue=3 glue=19 entries=22`, `isURL.js: novel-glue=8 glue=13 entries=21`, `isUUID.js: novel-glue=2 glue=7 entries=9`, `isAlphanumeric.js: novel-glue=2 glue=7 entries=9`. Those histograms confirm each headline module *does* surface real non-glue atoms today; per-entry shaving from the same fixture will produce the same per-headline slice plan structure but bounded to the headline's transitive subgraph rather than the full 113-module forest. The four `combinedScore >= 0.70` targets are therefore expected to remain reachable.

---

## 3. Per-entry subgraph size estimates (read from vendored source)

Estimates are read directly from the abandoned slice's vendored `validator-13.15.35/lib/*.js` (commit `f9c93f0`), counting `require("./…")` and `require("./util/…")` specifiers within the package boundary, then walking one level transitively.

### 3.1 `isEmail.js`

Direct in-package requires (6): `./util/assertString`, `./util/checkHost`, `./isByteLength`, `./isFQDN`, `./isIP`, `./util/merge`.

Transitive (read from `lib/isFQDN.js` and `lib/isIP.js`): `isFQDN` pulls only `./util/assertString` + `./util/merge` (already in the set); `isIP` is self-contained (no in-package requires); `checkHost` pulls `./isIP` (already in set); `isByteLength` pulls `./util/assertString` (already in set); `assertString` and `merge` are leaf utility modules.

**Estimated subgraph: ~9–10 modules** (`isEmail.js`, `isFQDN.js`, `isIP.js`, `isByteLength.js`, plus `util/assertString.js`, `util/checkHost.js`, `util/merge.js`, possibly transitive `util/includes`-style helpers if any). This is the largest of the four.

### 3.2 `isURL.js`

Direct in-package requires (6): `./util/assertString`, `./util/checkHost`, `./util/includesString`, `./isFQDN`, `./isIP`, `./util/merge`. Heavy overlap with `isEmail.js` (5/6 specifiers shared).

**Estimated subgraph: ~9–10 modules** (essentially the same set as `isEmail` minus `isByteLength`, plus `util/includesString.js`).

### 3.3 `isUUID.js`

Direct in-package requires (1): `./util/assertString`.

**Estimated subgraph: ~2 modules** (`isUUID.js`, `util/assertString.js`). Smallest of the four.

### 3.4 `isAlphanumeric.js`

Direct in-package requires (2): `./util/assertString`, `./alpha`.

`./alpha` is the locale character-class constant-table module — read via `git show f9c93f0:packages/shave/src/__fixtures__/module-graph/validator-13.15.35/lib/alpha.js`, it has zero in-package requires (it is `exports.locales`, big regex tables, no inter-module structure).

**Estimated subgraph: ~3 modules** (`isAlphanumeric.js`, `util/assertString.js`, `alpha.js`).

### 3.5 Aggregate footprint and expected wall-clock

If the four shaves are run **independently** (one `shavePackage` call per headline, fresh BFS per entry), the total unique module decomposition count is ~14–16 modules (heavy overlap between `isEmail` and `isURL`; `isUUID` and `isAlphanumeric` are small disjoint subgraphs). Counting per-test (no shared `beforeAll`), the cumulative decomposition is ~24 module-decompositions across all four tests — roughly **20% of the 113-module whole-package shave**, and only the per-headline modules that the abandoned slice already showed have non-trivial slice plans.

The abandoned whole-package shave took 2640 seconds total (44 min) with `testTimeout=3_600_000`. The per-test ratio is **not linear in module count** — much of the abandoned slice's time was in `decompose()` on modules unrelated to the four headlines (e.g. `isCreditCard`, `isFloat`, `isJSON`, the larger validators) plus the §F quality block embedder warm-up. With per-entry shaves bounded to ~10-module subgraphs, each per-headline test is expected to run in **well under 30 seconds wall-clock at default `testTimeout`** (the abandoned slice's `module-graph.test.ts` already exercises 3-module synthetic packages within the 30s default; validator-headline subgraphs are 2-10 modules and structurally similar). If any per-entry shave needs >120s, that is **a flag the operator should see** — see §5.6 acceptance and §6.5 forbidden shortcut.

**Total per-entry test budget: <2 minutes per headline test, <8 minutes cumulative for all four §A-§E tests.** §F (the `combinedScore` quality block, gated on `DISCOVERY_EVAL_PROVIDER=local`) adds embedder warm-up; budget that block at <60 seconds per headline, <4 minutes cumulative. Grand total: **<12 minutes** for the full Slice 2 test suite — comfortable margin against the default 30s `testTimeout` per individual `it()` and the global vitest run time.

---

## 4. Fixture shape decision — re-use the existing vendored Babel CJS

**Two candidates, both already established in the precedent:**

- **Candidate 1: re-vendor the full `validator-13.15.35/` Babel-CJS tarball** (116 files, identical to what `f9c93f0` vendored). The abandoned slice already proved (a) the vendoring is lint-safe and typecheck-safe by construction (the `__fixtures__/module-graph/**` glob is biome-ignored and `tsconfig.base.json` does not `allowJs`/`checkJs`), and (b) `extractRequireSpecifiers` correctly extracts the Babel `_interopRequireDefault(require("…"))` wrapper specifiers (the abandoned slice produced `stubCount=0` over the full 113-module shave — every edge resolved).
- **Candidate 2: vendor only the modules the 4 headline entries transitively need** (~14–16 modules: the four headline files + their util/transitive deps). This is structurally a "Path C" trimmed subset.

**Decision: Candidate 1 (full vendored Babel-CJS tarball, identical to `f9c93f0`).** Rationale:

1. **Re-use, not re-do.** The full tarball was already vendored with a `PROVENANCE.md`. Pulling the whole tarball forward into this slice is a single file-tree carryover (a `git read-tree`-shaped copy), not a re-vendoring exercise. Trimming would mean re-deciding what to include, hand-verifying the trim covers the transitive subgraph, and maintaining a second provenance note about what was excised.
2. **Honesty about what's in `node_modules`.** What the production import-intercept hook (#508) and the B10 bench (#512) will see when a user writes `import { isEmail } from 'validator'` is the published Babel CJS, not a hand-trimmed subset. Vendoring the real tarball preserves the property that the atoms the engine produces in Slice 2 are the *same atoms* `#508`/`#512` will need to find.
3. **`isInPackageBoundary` already scopes the BFS.** With `entryPath=lib/isEmail.js` and `packageRoot=<validator-13.15.35-root>`, the BFS only walks edges resolvable inside that root — but it only **enqueues** edges the headline binding's source actually references, so the other ~95 unrelated validator behaviors *are never visited even though their files exist in the fixture*. The cost of having those files on disk is zero traversal cost; they are not opened.
4. **Operator constraint respected.** The operator explicitly declined "vendor un-transpiled `src/`" in the previous slice's adjudication; Candidate 1 honors that.

The single change vs the abandoned slice's fixture strategy is **how the fixture is consumed**: per-entry `entryPath` overrides instead of one whole-package shave. The vendored tree itself is identical.

**Fixture carryover scope:** the implementer pulls the entire `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` subtree forward from commit `f9c93f0` unchanged (including its `PROVENANCE.md`). This is straight file-tree carryover, not authoring.

---

## 5. Evaluation Contract — Slice 2 (per-entry shave of 4 headline bindings)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at the end (§5.6).

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1's engine tests) and `slicer.test.ts` **with zero regressions**, plus the new per-entry headline-binding tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Full-workspace `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all 38 packages. This was the CI failure on Slice 1's PR #526 (package-scoped passed, workspace-scoped caught it); the reviewer runs the workspace-level commands and pastes the output. Slice 2 must not regress workspace-level discipline.
- **Per-entry headline tests** — one test (or one `describe` block) per headline binding, exercising the real `shavePackage` path with `entryPath` pointing at the headline's `lib/<binding>.js`. Test file path is the implementer's call; the planner's recommendation is a single `validator-headline-bindings.test.ts` with §A–§F structure per-headline-block (mirrors `module-graph.test.ts`'s `§N` convention; keeps the four bindings co-located so cross-binding patterns are obvious). If the implementer measures and finds shared-fixture cost worth the complexity, a single `beforeAll` per binding within that file is permitted; a single `beforeAll` *across* bindings is forbidden (defeats the per-entry isolation guarantee — see §5.5).

### 5.2 Required real-path checks

- **Per-headline real-path forest:** `shavePackage(<validator-fixture-root>, { registry, entryPath: <validator-fixture-root>/lib/<binding>.js })` produces a `ModuleForest` whose `moduleCount` is bounded to the headline's transitive in-package subgraph (per §3 estimates, 2–10 modules). The reviewer inspects the `forest.nodes` list and confirms:
  - the headline binding itself is `forest.nodes[0]` as a `ModuleForestNode`,
  - every other `ModuleForestNode` is a real transitive dep of that headline binding (and no unrelated validator behavior modules — e.g. `isCreditCard.js`, `isJSON.js` — are present),
  - `stubCount == 0` (no fixture-internal edges fail to resolve; matches the abandoned slice's `stubCount=0` precedent for these bindings).
- **`combinedScore >= 0.70`** for each of the four headline behaviors, measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. The reviewer pastes the per-behavior score as evidence. If the local provider is absent so the quality block skips, **the slice is blocked, not ready** — the reviewer must run with `DISCOVERY_EVAL_PROVIDER=local` and paste the four scores.
- **Two-pass byte-identical determinism per headline:** for each of the four headlines, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, and the sorted set of every leaf `canonicalAstHash` are byte-identical across passes. (Mirrors `module-graph.test.ts §7`, but scoped per-entry. Determinism is per-headline, not aggregated, so a regression in any single headline's BFS order shows up directly.)
- **Forest persisted via the real `storeBlock` path per headline:** for each headline, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom` (the real per-leaf persist path used in `index.ts`'s `shave()` loop), not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after each headline's persist; the headline atom is retrievable. (Same authority requirement the abandoned slice carried over from §6.3 of the previous plan — preserved verbatim because it is independent of the per-entry reframe.)

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 2 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`). No new public API surface in `packages/shave/src/types.ts`. The `entryPath` option is consumed as-is.
- **B-scope predicate untouched.** `isInPackageBoundary` is unchanged. Validator has no runtime deps in the published tarball (`package.json` `dependencies` field is empty / absent), so B-scope is not exercised at a boundary edge — but the predicate stays single-sourced and Slice 2 must not introduce a parallel "is this module in the headline's reachable subgraph?" check beside it.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives. If a thin `persistForest`-shaped helper is added to compose them, it lives in `packages/shave/src/universalize/module-graph.ts` or `packages/shave/src/persist/` as a **composition** of existing primitives — it does not reimplement triplet construction or identity derivation, and `blockMerkleRoot` is never written directly. (Carryover from the abandoned plan's §6.3.)
- **Public `types.ts` surface frozen-for-L5.** `ShaveOptions`, `ShaveResult`, `UniversalizeResult`, `UniversalizeOptions`, `ShaveRegistryView`, `CandidateBlock`, `IntentExtractionHook` MUST NOT change shape. Slice 2 needs no public-surface change.
- **`corpus.json` is append-only.** Slice 2 appends `synthetic-tasks` entries; it does not modify existing entries, the category list, or the `discovery-eval-full-corpus.test.ts` harness. (The four corpus entries already drafted by the abandoned slice — `cat1-validator-is-email-001`, `cat1-validator-is-url-001`, `cat1-validator-is-uuid-001`, `cat1-validator-is-alphanumeric-001` — are carried over verbatim from commit `f9c93f0`; their `rationale` text references "Path A" which is still accurate.)
- **Fixture isolation.** The vendored `validator` source lives only under `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` (biome-ignored, outside `tsc`'s `.js` scope per the precedent established by Slice 1). No vendored npm source leaks into `packages/shave/src/` proper.
- **Per-entry isolation guarantee.** Each of the four headline bindings is shaved by its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across bindings, no precomputed multi-binding forest reused across `it()` blocks. This is the **structural defense** against the abandoned slice's failure mode: if `isEmail`'s shave hangs or asserts unexpectedly, only `isEmail`'s test fails — `isURL`/`isUUID`/`isAlphanumeric` still run, still produce evidence, still gate Guardian readiness independently. A future implementer or operator who wants to investigate one binding does not have to wait for the other three.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — the full vendored Babel-CJS tarball + `PROVENANCE.md`, carried over verbatim from commit `f9c93f0`. Required.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` (or per-binding test files if the implementer prefers; planner recommendation is one file with four `describe` blocks). The new Slice 2 test(s). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `validator` headline-behavior query entries (`cat1-validator-is-email-001`, `cat1-validator-is-url-001`, `cat1-validator-is-uuid-001`, `cat1-validator-is-alphanumeric-001`), carried over verbatim from commit `f9c93f0`. Append-only. Required.
- `packages/shave/src/universalize/module-graph.ts` or `packages/shave/src/persist/` — ONLY if a thin `persistForest` composition helper is added (optional; composes existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` primitives, no engine-recursion change). Allowed.
- `plans/wi-510-s2-headline-bindings.md`, `plans/wi-510-shadow-npm-corpus.md` — this plan and a one-paragraph status update on the master Slice plan. Allowed (status updates only on the master).

### 5.5 Forbidden shortcuts

- **No whole-package shave.** Calling `shavePackage(<validator-fixture-root>, { registry })` without an `entryPath` override is **forbidden** in Slice 2 — that is the abandoned slice's failure mode and the entire reason this plan exists. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the four headline `lib/<binding>.js` files.
- **No `vitest.config.ts` timeout raise.** `packages/shave/vitest.config.ts` stays at `testTimeout=30_000` and `hookTimeout=30_000` (the defaults). The abandoned slice's `testTimeout=3_600_000` (one hour) is the **symptom** of the bad design Slice 2 exists to avoid. If any per-entry headline test cannot complete inside the default 30-second per-`it()` timeout, the implementer **stops and reports** — that is a flag the operator must see, not a thing to paper over with a global timeout bump. The implementer may pass a per-`it()` timeout override (the third argument to `it()` / `test()`) for an individual headline test if measurement shows a specific binding needs ~60-90s — but the **per-`it()` override ceiling is 120 seconds**, and any per-`it()` override must carry an inline comment recording the measured wall-clock and citing the §3 estimate it diverged from. A binding needing >120s is a stop-and-report event.
- **No shared `beforeAll` across the four bindings.** Each headline is shaved in its own scope (`describe` block + `beforeAll`-per-`describe` if shared structure within one binding is justified, or fresh per-`it()` setup). A single `beforeAll` that shaves all four at once defeats §5.3's per-entry isolation guarantee.
- **No engine-source change in `packages/shave/src/universalize/**`.** No new `shaveModule()` helper, no `entryOverride` option addition to `ShavePackageOptions` (the option exists as `entryPath`), no signature change to `shavePackage`, no slicer policy edits, no resolver predicate edits. If, during implementation, an engine gap surfaces that an `entryPath`-driven shave exposes (the abandoned slice did NOT surface any — `stubCount=0` with full traversal), it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 2 stops and reports.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path. (Carryover from the abandoned plan's §6.5 — preserved because it is independent of the per-entry reframe.)
- **No hand-authored `validator` atoms.** The four headline atoms are the engine's output from vendored source. (Sacred Practice 12.)
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** The corpus harness and schema are constitutional; Slice 2 only appends `synthetic-tasks` corpus rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is small (§3); if any headline test sees `moduleCount` approaching `maxModules` (default 500), that indicates a B-scope leak or a fixture-vendoring error — the implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical; `readdir`-order / `Map`-iteration / absolute-path leakage in any helper added by Slice 2 is forbidden. (Carryover from the abandoned plan's §6.5.)
- **No public `types.ts` surface break.**

### 5.6 Ready-for-Guardian definition (Slice 2)

Slice 2 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts` and the rest of the existing shave suite.
2. Full-workspace `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — the reviewer runs the workspace-level commands and pastes the output.
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the four bindings, the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules and no unrelated validator behaviors), and the wall-clock time of that headline's `shavePackage` invocation. The §3 estimates are the reviewer's anchor for "does this look right?"
4. Each of the four headline bindings (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`) produces a connected `ModuleForest` whose nodes are exactly the headline's transitive in-package subgraph — reviewer confirms via the §3 inspection that no unrelated validator behavior modules are present.
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise in `packages/shave/vitest.config.ts`). A test exceeding 120s — even with a per-`it()` override — is a blocking flag, not a passing condition. Cumulative Slice 2 test wall-clock (all four §A-§E blocks) is **<8 minutes**; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) is **<12 minutes**.
6. Two-pass byte-identical determinism per headline: each of the four `shavePackage` calls is byte-identical across two passes (`moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS `filePath` order, sorted leaf `canonicalAstHash` set). The test asserts this per-headline, not aggregated.
7. `combinedScore >= 0.70` for **each** of the four headline behaviors, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — the quality block(s) **ran (not skipped)**, and the reviewer pastes the four per-behavior scores. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut.
9. `corpus.json` carries exactly the four appended `synthetic-tasks` `validator` headline entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes (the appended entries do not trip its invariants).
10. `packages/shave/vitest.config.ts` is unchanged (still `testTimeout=30_000`, `hookTimeout=30_000`); the abandoned slice's `testTimeout=3_600_000` raise is NOT carried forward.
11. The vendored `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` subtree matches `f9c93f0`'s vendored tree byte-for-byte (the reviewer can spot-check this with `git diff f9c93f0 -- packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` showing no changes).
12. New `@decision` annotations are present at the Slice 2 modification points (the per-entry shaving choice, the headline-binding scoping, the `persistForest` helper if added). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 2 (per-entry shave of 4 headline bindings)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — the vendored fixture + `PROVENANCE.md`, carried over verbatim from commit `f9c93f0`. Pure file-tree carryover.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` (or per-binding split if preferred) — the new Slice 2 test(s) with four headline blocks.
- `packages/shave/src/universalize/module-graph.ts` — ONLY to add a thin `persistForest` composition helper (optional; composes existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` primitives; no engine-recursion change, no public-API change, no `entryPath`-option change).
- `packages/shave/src/persist/**` — ONLY if the `persistForest` helper is better placed here; same constraint (composition only).
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `validator` headline-behavior query entries carried over from commit `f9c93f0`. Append-only.
- `plans/wi-510-s2-headline-bindings.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (the master Slice plan); no permanent-section edits.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — the vendored fixture carryover.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — the new Slice 2 test(s).
- `packages/registry/test/discovery-benchmark/corpus.json` — the four `validator` headline-behavior query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — **the global timeout raise must NOT be carried forward**. `testTimeout` stays at `30_000`, `hookTimeout` stays at `30_000`. This is the single most load-bearing forbidden touch in this Slice — it is the structural defense against the abandoned slice's design flaw.
- `packages/shave/src/universalize/recursion.ts` — the `decompose()` / `recurse()` per-file engine. Frozen.
- `packages/shave/src/universalize/slicer.ts` — the `slice()` slicer policy. Frozen after Slice 1.
- `packages/shave/src/universalize/module-resolver.ts` — the resolver + `isInPackageBoundary` B-scope predicate. Frozen after Slice 1.
- `packages/shave/src/universalize/module-graph.ts` (excluding the optional thin `persistForest` composition helper allowed above) — the `shavePackage` algorithm, the `ShavePackageOptions` interface, the visited-set logic, the BFS loop. Frozen.
- `packages/shave/src/universalize/types.ts` — internal universalize types. Frozen.
- `packages/shave/src/types.ts` — the frozen-for-L5 public surface. No change.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1's engine tests. Slice 2 adds a *new* test file; it does not edit Slice 1's.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — the registry schema and discovery-eval harness are constitutional.
- `packages/seeds/src/blocks/**` and all 26 existing seed atoms — Slice 2 produces atoms via the engine from `validator` source; it hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**` — `#508`'s and `#512`'s lanes.
- `biome.json` — already covers the fixture dir (Slice 1 added the globs); no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 2 **calls** these with an explicit `entryPath` option per headline; it does not fork, modify, or extend them.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 2 produces four headline-atom-rooted subgraphs by shaving `validator/lib/<binding>.js` per entry; it never writes a root directly.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 2 appends four `synthetic-tasks` entries (carried over from `f9c93f0`).
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 2 does not modify this authority; per-entry shave size is bounded by §3 estimates so the default `testTimeout=30_000` is sufficient.

---

## 7. Slicing / dependency position

Slice 2 is a single work item. Dependencies: **Slice 1 (landed `37ec862` on `main`)** only. Downstream: **`#508` Slice 1** and **`#512` Slice 2** both gate on Slice 2 producing the four headline-binding atoms in the registry — the triad's MVDP unblocker remains intact under the per-entry reframe (each of the four headlines becomes individually consumable by `#508`'s import-intercept hook, which is structurally what `#508` Slice 1 needs anyway: it intercepts `import { isEmail } from 'validator'` for *one named binding at a time*, not a whole-package import).

- **Weight:** **M** (four small per-entry shaves + test orchestration + measurement-evidence discipline + fixture carryover; no engine change).
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S2-PER-ENTRY-SHAVE-001` | Slice 2 shaves the four headline bindings per-entry, not the whole `validator` package | Operator-adjudicated 2026-05-14: "we only need to prove what's used in yakcc, the rest will get added later when we do a full shave into the production registry of validator etc." The previous whole-package approach (commit `f9c93f0`, abandoned) produced `moduleCount=113, leafCount=1987`, ran for 44 minutes, forced `testTimeout=3_600_000`. Per-entry shaving via `shavePackage({ entryPath: <validator>/lib/<binding>.js })` bounds each test to a ~2-10-module transitive subgraph (§3 estimates), comfortable inside the default 30s `testTimeout`. The four headlines (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`) are the bindings `#508`/`#512` MVDP actually demonstrates; broader validator coverage is explicitly deferred. |
| `DEC-WI510-S2-PATH-A-CONFIRMED-001` | `shavePackage`'s existing `entryPath` option suffices for per-entry shaving; no engine API change | The landed `ShavePackageOptions.entryPath` field (`module-graph.ts:170`) is consumed verbatim in line 260 (`options.entryPath ?? resolvePackageEntry(normalRoot)`). It already short-circuits package-root entry resolution and starts the BFS at the override path; `isInPackageBoundary` continues to scope the recursion to the `packageRoot` subtree. Slice 2 needs no `shaveModule()` sibling, no `entryOverride` option addition, no signature change. Pure fixture-and-test slice; `review` gate (not `approve`). |
| `DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001` | Re-use the abandoned slice's vendored Babel-CJS tarball verbatim | The full `validator-13.15.35/` tree from commit `f9c93f0` (116 files, biome-ignored, outside `tsc`'s `.js` scope) is carried over byte-for-byte. Honest about what production `import { isEmail } from 'validator'` actually pulls in. `isInPackageBoundary` ensures the per-entry BFS only walks the headline's transitive subgraph; the other ~95 unrelated validator behavior files exist on disk at zero traversal cost. Trimming the fixture to a hand-vendored subset was considered and rejected — it duplicates the maintenance burden and diverges from what `#508`/`#512` will see. |
| `DEC-WI510-S2-PER-ENTRY-ISOLATION-001` | Each of the four headlines is shaved by its own `shavePackage` call; no shared multi-binding `beforeAll` | Per-entry isolation is the structural defense against the abandoned slice's failure mode. If one headline's shave hangs or asserts unexpectedly, only that one's test fails; the other three still run, still produce evidence, still gate Guardian readiness independently. A shared `beforeAll` across all four bindings (which the abandoned slice used to amortize its 44-minute whole-package shave) is forbidden — it defeats the isolation guarantee and re-introduces the cumulative-blow-up failure mode. A `beforeAll` *within* a single binding's `describe` block is permitted if measurement justifies it. |
| `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` | `packages/shave/vitest.config.ts` stays at `testTimeout=30_000`; the abandoned `3_600_000` raise is the symptom of the bad design, not a pattern to inherit | A global one-hour `testTimeout` is the loudest possible signal that a test is doing too much. Slice 2's per-entry shaves are sized (§3 estimates) to fit comfortably in the default 30s per-`it()` budget. A per-`it()` override up to 120s is permitted with an inline measurement-citing comment; >120s is a stop-and-report event, not something to absorb with a config change. The Architecture-Preservation discipline: "make the right path automatic" — keeping the global default tight means any future binding that blows up advertises itself loudly. |

These DECs are recorded in `@decision` annotation blocks at the Slice 2 modification points (the new test file primarily; the `persistForest` helper if added) and, if the operator wants them in the project-level log, appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| `extractRequireSpecifiers` mis-handles a Babel `_interopRequireDefault(require("…"))` pattern in one of the four headline modules → an in-package edge is silently lost → the test passes but the forest is incomplete. | The abandoned slice's `stubCount=0` over the full 113-module shave is the evidence that Babel-CJS `require()` extraction works. §5.2 requires the reviewer to inspect the per-headline `forest.nodes` BFS list against the §3 estimates — a missing transitive dep (e.g. `isEmail.js` without `isFQDN.js`) shows up immediately as a too-small `moduleCount`. |
| A per-entry shave exceeds the 30s default `testTimeout` despite the §3 estimates — measurement is wrong. | §5.5 forbids the global timeout raise; §5.6 criterion 5 makes >120s a stop-and-report event; per-`it()` overrides are bounded to 120s with mandatory measurement-citing comments. The implementer measures wall-clock per headline and records it in the PR body so the reviewer can flag any unexpected blow-up. |
| `combinedScore < 0.70` for one of the four headline behaviors because the engine-derived intent text is too terse for the embedder. | Same risk and mitigation as the master plan §10. The intent text is produced by the existing `extractIntent` static strategy, which the per-file engine already uses successfully on `ms`. If a headline under-scores, investigate the intent-extraction output, not the recursion engine. The threshold is the harness's `confident` band floor (`DISCOVERY_EVAL_DISCOVERY_CONFIDENT_FLOOR = 0.70`); reviewer escalates if the score is, e.g., 0.65 — that is a genuine quality finding, not a Slice 2 design failure, and might prompt a follow-up issue. |
| Per-entry isolation is broken in implementation — a shared module-graph cache or in-memory project reuse causes one headline's shave to influence another's. | The shave engine's per-`decompose` call uses a fresh in-memory `Project` (verified in `recursion.ts`); there is no engine-level cache to invalidate. §5.5 forbids shared `beforeAll` across bindings. Two-pass byte-identical determinism per headline (§5.6 criterion 6) is the empirical check: if isolation is broken, one of the four headlines will be non-deterministic across passes when run after the others have polluted shared state. |
| A future implementer reads "headline bindings" and adds a fifth binding to Slice 2's scope without operator approval. | §1 and §6 are explicit: "the four headlines `isEmail`, `isURL`, `isUUID`, `isAlphanumeric`"; broader validator coverage is "explicitly deferred to a later 'full shave into the production registry' initiative." Adding a fifth binding requires the user-decision boundary that triggered this plan's existence in the first place. |
| The `persistForest` composition helper, if added, drifts toward duplicating triplet construction logic instead of composing existing primitives. | §5.3 and §6 are explicit: composition only, no `blockMerkleRoot` writes, no triplet logic. The reviewer reads the helper diff (if added) and confirms it is `<50` lines of pure orchestration over `collectForestSlicePlans` + `maybePersistNovelGlueAtom`. If it grows beyond that, it is a refactor that doesn't belong in Slice 2. |
| The vendored fixture carryover from `f9c93f0` misses a file because of an incomplete copy. | §5.6 criterion 11: reviewer runs `git diff f9c93f0 -- packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` and confirms no changes. The fixture tree is content-addressed by the commit; any drift is mechanically detectable. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **The other ~96 `validator` behaviors.** Operator deferral: "the rest will get added later when we do a full shave into the production registry of validator etc." Slice 2 is bounded to the four headline bindings (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`) only.
- **A whole-package shave path.** §5.5 explicitly forbids calling `shavePackage` without an `entryPath` override in Slice 2. The whole-package approach is what was abandoned.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Pure fixture-and-test slice. Path A confirmed in §2.
- **A `shaveModule()` sibling helper or new public API surface.** `ShavePackageOptions.entryPath` is already the per-entry interface.
- **The import-intercept hook (`#508`).** Separate WI. Slice 2 produces the four headline-binding atoms; `#508` Slice 1 intercepts the import.
- **The B10 bench (`#512`).** Separate WI. `#512` Slice 2 consumes the four headline-binding forests; this slice does not produce bench results.
- **`vitest.config.ts` adjustments.** Forbidden touch point — the global timeout stays at 30s.
- **`MASTER_PLAN.md` initiative registration.** Per `plans/import-replacement-triad.md` §7, that is a separate doc-only slice the orchestrator dispatches if/when the user wants it.

---

*End of Slice 2 plan — per-entry shave of `isEmail`, `isURL`, `isUUID`, `isAlphanumeric`.*
