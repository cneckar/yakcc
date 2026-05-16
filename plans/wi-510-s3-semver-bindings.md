# WI-510 Slice 3 — Per-Entry Shave of Four `semver` Headline Bindings

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 3 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (the B-scope dependency-following shave engine) is **landed on `main`** (PR #526, commit `37ec862`). Slice 2 (per-entry shave of four `validator` headline bindings) is **landed on `main`** (PR #544, commit `aeec068`).
**Branch:** `feature/wi-510-s3-semver-bindings`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s3-semver-bindings`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s3-semver-bindings`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan), `plans/wi-510-s2-headline-bindings.md` (the Slice 2 template this plan inherits from).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slice 1 and Slice 2 recorded their `DEC-WI510-*` entries).

---

## 1. What changed — why Slice 3 exists

Slice 1 proved the dependency-following shave engine on `ms`. Slice 2 proved it on real-headline `validator` bindings (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`) via per-entry `shavePackage({ entryPath })`. Slice 3 advances exactly one rung up the §5 graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md`:

> *Slice 3 — semver (small, mostly-pure version-range logic)*

The issue body (#510) names the four semver headline bindings:

> *semver: satisfies / coerce / compare / parse-component*

Slice 3 shaves those four bindings, **each as its own subgraph**, mirroring the structural pattern Slice 2 established for `validator`. The engine is frozen after Slice 1 (master plan §5); this is a pure fixture-and-test slice. Slice 2's `review` gate carries forward.

### 1.1 Bindings → file mapping (operator-decision boundary closed)

The issue body's `parse-component` does not name a literal file in semver's source. The candidates are:

| Issue-body name | Candidate file | Note |
|---|---|---|
| `satisfies` | `package/functions/satisfies.js` | Direct match. |
| `coerce` | `package/functions/coerce.js` | Direct match. |
| `compare` | `package/functions/compare.js` | Direct match. |
| `parse-component` | `package/functions/parse.js` | **Selected.** `parse()` is semver's canonical "string → component structure" entry — given `"1.2.3-beta.4"` it returns a `SemVer` instance whose `major/minor/patch/prerelease/build` fields are the semantic components. `major()/minor()/patch()` are thin extractors that themselves call `parse()`. Choosing `parse()` honors the issue's intent ("parse a version into components"), gives a richer subgraph than the extractors, and avoids picking arbitrarily among the three. |

**Documented in `DEC-WI510-S3-PARSE-COMPONENT-BINDING-001` (§8).** If the operator later wants a separate `major`/`minor`/`patch` slice, that is a follow-on issue — each is a ~7-module shave (same chain as `compare`).

### 1.2 Version pin

**Selected: `semver@7.8.0`.**

- `7.8.0` is the current `latest` dist-tag (verified via `npm view semver dist-tags` on 2026-05-16). `legacy: 5.7.2`, `latest-6: 6.3.1`, `latest: 7.8.0`.
- The semver@7 line has **no runtime dependencies** (`npm view semver@7.8.0 dependencies` returns empty). This keeps the B-scope predicate ungated by an external-dep boundary surprise — same property `validator@13.15.35` has.
- semver source is **plain modern Node.js CJS** (`'use strict'\nconst Range = require('../classes/range')\nmodule.exports = satisfies`), **not Babel-transpiled**. This is structurally simpler than the validator fixture: every `require()` is a top-level `require(<string-literal>)`, no `_interopRequireDefault` wrapper interposed. The landed engine's `extractRequireSpecifiers` (in `module-resolver.ts`) walks every `CallExpression` for `require(<literal>)` calls, so it handles both shapes uniformly — the plain shape is a strictly easier case than the Babel one Slice 2 already proved.

**Documented in `DEC-WI510-S3-VERSION-PIN-001` (§8).** Lock to `7.8.0` for byte-identical fixture vendoring; a later production-corpus initiative may broaden the pin set.

---

## 2. Path A confirmed (again) — no engine change needed

The load-bearing question Slice 2 answered ("does `shavePackage()` accept a sub-entry?") is already settled. The landed engine's `ShavePackageOptions.entryPath` field (`packages/shave/src/universalize/module-graph.ts:170`, consumed at line 260 as `options.entryPath ?? resolvePackageEntry(normalRoot)`) is the per-entry interface. Slice 3 calls it verbatim:

- `packageRoot = <semver-fixture-root>` — `isInPackageBoundary()` scopes the BFS to semver's own directory tree (B-scope predicate unchanged).
- `entryPath = <semver-fixture-root>/functions/<binding>.js` — the BFS starts at the specific headline behavior's module.

No engine-source change. No new public-API surface. No `shaveModule()` sibling helper. No `ShavePackageOptions` shape change. Slice 3 is a **pure fixture-and-test slice**; gate is **`review`** (matches Slice 2).

---

## 3. Per-entry subgraph size estimates (read from extracted source)

Estimates read directly from the `semver@7.8.0` tarball (extracted to `tmp/wi-510-s3/package/` for planning; the vendored fixture in the implementation will live at `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/`). Each estimate counts in-package `require('./...')` and `require('../...')` specifiers transitively. semver has no runtime npm dependencies (no `require('<bare-pkg>')` to skip), so every `require()` is an in-package edge.

### 3.1 `satisfies.js` (the largest subgraph)

Direct requires: `../classes/range`.

Transitive (depth-2+):
- `classes/range.js` → `internal/lrucache`, `internal/parse-options`, `classes/comparator`, `internal/debug`, `classes/semver`, `internal/constants`.
- `classes/comparator.js` → `internal/parse-options`, `internal/re`, `functions/cmp`, `internal/debug`, `classes/semver`, `classes/range` *(circular — `comparator` ⇄ `range`)*.
- `classes/semver.js` → `internal/debug`, `internal/constants`, `internal/re`, `internal/parse-options`, `internal/identifiers`.
- `internal/re.js` → `internal/debug`.
- `functions/cmp.js` → `functions/eq`, `functions/neq`, `functions/gt`, `functions/gte`, `functions/lt`, `functions/lte`.
- Each of `eq/neq/gt/gte/lt/lte.js` → `functions/compare`.
- `functions/compare.js` → `classes/semver`.

**Unique module set (deduplicated):** `satisfies.js`, `classes/range.js`, `classes/comparator.js`, `classes/semver.js`, `internal/lrucache.js`, `internal/parse-options.js`, `internal/constants.js`, `internal/debug.js`, `internal/re.js`, `internal/identifiers.js`, `functions/cmp.js`, `functions/eq.js`, `functions/neq.js`, `functions/gt.js`, `functions/gte.js`, `functions/lt.js`, `functions/lte.js`, `functions/compare.js` = **~18 modules**.

This is the largest of the four. It is **larger than any single validator headline subgraph** (Slice 2's biggest was `isEmail` at 7–12 modules), and notably it **exercises the engine's cycle guard** (`range` ⇄ `comparator`). That makes Slice 3 a real cross-package corroboration of Slice 1's circular-import termination work, not just a repeat of Slice 2.

**Range guidance for the test (§A assertion):** `moduleCount in [14, 22]`. Width allows for ts-morph occasionally surfacing additional in-package nodes the static-source survey missed; the upper bound catches a B-scope leak (semver has 53 files total, so a leak would push toward 25+).

### 3.2 `coerce.js`

Direct requires: `../classes/semver`, `./parse`, `../internal/re`.

Transitive:
- `classes/semver.js` chain → `debug`, `constants`, `re`, `parse-options`, `identifiers`.
- `functions/parse.js` → `classes/semver` (already in set).
- `internal/re.js` → `debug` (already in set).

**Unique module set:** `coerce.js`, `parse.js`, `classes/semver.js`, `internal/re.js`, `internal/debug.js`, `internal/constants.js`, `internal/parse-options.js`, `internal/identifiers.js` = **~8 modules**.

**Range guidance (§A):** `moduleCount in [6, 12]`.

### 3.3 `compare.js`

Direct requires: `../classes/semver`.

Transitive:
- `classes/semver.js` chain → `debug`, `constants`, `re`, `parse-options`, `identifiers`.
- `internal/re.js` → `debug` (already in set).

**Unique module set:** `compare.js`, `classes/semver.js`, `internal/debug.js`, `internal/constants.js`, `internal/re.js`, `internal/parse-options.js`, `internal/identifiers.js` = **~7 modules**.

**Range guidance (§A):** `moduleCount in [5, 10]`.

### 3.4 `parse.js`

Direct requires: `../classes/semver`.

Transitive: identical to `compare.js`'s chain.

**Unique module set:** `parse.js`, `classes/semver.js`, `internal/debug.js`, `internal/constants.js`, `internal/re.js`, `internal/parse-options.js`, `internal/identifiers.js` = **~7 modules**.

**Range guidance (§A):** `moduleCount in [5, 10]`.

### 3.5 Aggregate footprint and expected wall-clock

Per-entry shaves are independent (§5.3 per-entry isolation invariant), so each shave decomposes its own module set fresh. Total module-decompositions across all four §A–§E tests: ~18 + 8 + 7 + 7 = **~40 decompositions**. The four bindings share the `classes/semver.js` chain (semver/debug/constants/re/parse-options/identifiers = ~6 modules) but per-entry isolation means each test pays the decompose cost independently — that is the deliberate design from Slice 2 `DEC-WI510-S2-PER-ENTRY-ISOLATION-001`.

Slice 2 measured per-headline shaves of ~7–12-module validator subgraphs at well under 30 s per `it()` block (no per-`it()` timeout overrides in §A–§E that I am aware of beyond the precautionary 120 s ceiling). semver's modules are smaller and structurally simpler than validator's (no Babel boilerplate; smaller per-file function bodies). Even the 18-module `satisfies` shave should comfortably fit inside the 120 s per-`it()` ceiling Slice 2 set.

**Per-headline test budget: <120 s per headline (the Slice 2 ceiling); typical <30 s.** **Cumulative §A–§E budget: <8 minutes.** **§F cumulative (with `DISCOVERY_EVAL_PROVIDER=local`): <12 minutes.** Any binding exceeding 120 s is a **stop-and-report** event, same as Slice 2 `DEC-WI510-S2-NO-TIMEOUT-RAISE-001`.

### 3.6 Stub-count expectation

The `package.json#files` list for `semver@7.8.0` is `["bin/", "lib/", "classes/", "functions/", "internal/", "ranges/", "index.js", "preload.js", "range.bnf"]`. The `lib/` entry is historical — semver@7 no longer has a `lib/` directory; the file list is harmless drift. The fixture tarball contents (verified) are `index.js`, `preload.js`, `bin/`, `classes/`, `functions/`, `internal/`, `ranges/`, `range.bnf`, `package.json`, `LICENSE`, `README.md`. **No edge from any of the four headline bindings escapes this tree.** Expected `stubCount = 0` for all four §A tests — same expectation as Slice 2's `validator` shaves.

---

## 4. Fixture shape — vendored tarball, mirroring Slice 2

**Decision: vendor the full `semver-7.8.0` published tarball verbatim.** Same rationale chain Slice 2 documented in `DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001`:

1. **Honesty about what `node_modules` contains.** When `#508`'s import-intercept hook fires on `import { satisfies } from 'semver'`, what it sees is the published tarball. Vendoring the real tarball preserves the property that the atoms Slice 3 produces are the *same atoms* `#508`/`#512` will see in production. A hand-trimmed fixture risks atoms whose `canonicalAstHash` diverges from the production-resolved file's hash.
2. **`isInPackageBoundary` already scopes traversal.** Files semver ships that no headline binding transitively references (e.g. `bin/semver.js`, `preload.js`, the ~30 `functions/*` and `ranges/*` files not in the four subgraphs) **exist on disk at zero traversal cost** — the BFS never enqueues them.
3. **Trimming duplicates maintenance burden.** A hand-trimmed fixture means re-deciding inclusion on every binding addition; vendoring the whole tarball is one decision recorded in `PROVENANCE.md`.
4. **Operator constraint respected.** "vendor published tarball, not source" was the constraint that produced Slice 2's `DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001`. Slice 3 inherits it.

**Fixture acquisition path:**
- Run `npm pack semver@7.8.0` in `tmp/wi-510-s3/` (planner has already done this for measurement; the implementer re-runs to obtain a fresh known-good copy).
- Extract `tar -xzf semver-7.8.0.tgz` into a `package/` directory; the resulting tree is the fixture root.
- Copy `package/*` into `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/`.
- Author `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/PROVENANCE.md` (template below in §4.1) recording the version, tarball SHA1, integrity, retrieval date, headline behaviors, and DEC IDs.

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified in the worktree) and is outside `tsc`'s `.js` scope (`tsconfig.base.json` does not set `allowJs`/`checkJs`).

### 4.1 `PROVENANCE.md` template

```
# Provenance — semver@7.8.0 fixture

- **Package:** semver
- **Version:** 7.8.0 (latest `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack semver@7.8.0`)
- **Tarball SHA1:** <fill from `npm pack` output or `shasum -a 1 semver-7.8.0.tgz`>
- **Tarball integrity:** <fill from `npm view semver@7.8.0 dist.integrity`>
- **Retrieved:** 2026-05-16
- **Contents:** `package.json`, `index.js`, `preload.js`, `range.bnf`, `bin/`, `classes/`, `functions/`, `internal/`, `ranges/` — 53 files total
- **Shape:** Plain modern Node.js CommonJS. Every `*.js` opens with `'use strict'`
  and uses `const x = require('<rel-path>')` for in-package edges. NOT Babel-transpiled
  (contrast with validator-13.15.35 which is Babel-CJS with `_interopRequireDefault` wrappers).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **Headline behaviors (this slice):** `satisfies`, `coerce`, `compare`, `parse`
  (the "parse-component" binding from #510's issue body resolves to `functions/parse.js`;
  see DEC-WI510-S3-PARSE-COMPONENT-BINDING-001).
- **Path decision:** Path A (published CJS tarball) — same as Slice 2's
  validator-13.15.35 fixture per DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001.
- **WI:** WI-510 Slice 3, workflow `wi-510-s3-semver-bindings`.
```

---

## 5. Evaluation Contract — Slice 3 (per-entry shave of 4 semver headline bindings)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1's engine tests) and `validator-headline-bindings.test.ts` (Slice 2's per-entry tests) **with zero regressions**, plus the new per-entry semver headline tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Workspace-wide `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all packages. (Carry-over from Slice 2 §5.1; `--filter`-scoped passing is necessary but not sufficient — workspace-scoped is the CI parity check.)
- **Per-entry headline tests** — one `describe` block per headline binding (`satisfies`, `coerce`, `compare`, `parse`), each with sections A–F mirroring Slice 2's `validator-headline-bindings.test.ts`. Planner recommendation: a single new test file at `packages/shave/src/universalize/semver-headline-bindings.test.ts` (sibling to `validator-headline-bindings.test.ts`). A `beforeAll` per `describe` is permitted if measurement justifies it; a `beforeAll` *across* bindings is forbidden (defeats per-entry isolation — see §5.5).

### 5.2 Required real-path checks

- **Per-headline real-path forest:** for each of the four headlines, `shavePackage(<semver-fixture-root>, { registry, entryPath: <semver-fixture-root>/functions/<binding>.js })` produces a `ModuleForest` whose `moduleCount` falls inside the §3 range for that binding (`satisfies` in `[14, 22]`, `coerce` in `[6, 12]`, `compare` in `[5, 10]`, `parse` in `[5, 10]`). The reviewer inspects `forest.nodes` and confirms:
  - `forest.nodes[0]` is a `ModuleForestNode` whose `filePath` ends in `functions/<binding>.js`,
  - every other module is a real transitive dep of that headline binding (no unrelated semver behaviors such as `ranges/min-version.js`, `functions/inc.js`, `functions/diff.js`),
  - `stubCount == 0` (semver has no external runtime deps; every in-package edge resolves — see §3.6).
- **Circular-import termination on `satisfies`:** `satisfies.js`'s subgraph includes the `classes/range.js` ⇄ `classes/comparator.js` circular import (verified §3.1). The §A test for `satisfies` exercises Slice 1's cycle guard; the test passes (no hang, no recursion error). This is the **first real-world circular-import case in the Slice 2-N graduated fixtures** — Slice 1 used a synthetic `circular-pkg` fixture for the same property. The reviewer confirms `satisfies` shave terminates inside its 120 s ceiling.
- **`combinedScore >= 0.70`** for each of the four headline behaviors (§F), measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. Test uses `withSemanticIntentCard` (introduced by Slice 2 in `DEC-WI510-S2-SEMANTIC-INTENT-CARD-001`) with a behaviorText that mirrors each binding's `corpus.json` query string. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, **the slice is blocked, not ready** — reviewer must run with the local provider and paste the four scores.
- **Two-pass byte-identical determinism per headline:** for each of the four headlines, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, and the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (per-headline, not aggregated — same property Slice 2 asserts).
- **Forest persisted via the real `storeBlock` path per headline:** for each headline, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom`, not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after each headline's persist; the headline atom is retrievable. (Carry-over from Slice 2 §5.2.)

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 3 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** No new public API surface in `packages/shave/src/types.ts`. The `entryPath` option is consumed as-is.
- **B-scope predicate untouched.** `isInPackageBoundary` is unchanged. semver has no runtime deps, so the B-scope predicate is not exercised at an external-package edge — but the predicate stays single-sourced. Slice 3 must not introduce a parallel "is this module in the headline's reachable subgraph?" check beside it.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives. If a thin composition helper is added, it is composition-only (no `blockMerkleRoot` writes, no triplet construction logic, no identity derivation). The Slice 2 `persistForest`-style helper that may already exist is reused as-is.
- **Public `types.ts` surface frozen-for-L5.** `ShaveOptions`, `ShaveResult`, `UniversalizeResult`, `UniversalizeOptions`, `ShaveRegistryView`, `CandidateBlock`, `IntentExtractionHook` MUST NOT change shape. Slice 3 needs no public-surface change.
- **`corpus.json` is append-only.** Slice 3 appends four new `synthetic-tasks` entries (`cat1-semver-satisfies-001`, `cat1-semver-coerce-001`, `cat1-semver-compare-001`, `cat1-semver-parse-001`). No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change. The appended entries must satisfy the per-category invariants of `discovery-eval-full-corpus.test.ts` (category assignment, ≥8-per-category, positive+negative balance) — Slice 2 already added four `cat1-validator-*` entries and `cat1` is well-populated; appending four `cat1-semver-*` entries does not destabilize the invariants.
- **Fixture isolation.** The vendored `semver` source lives only under `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/` (biome-ignored, outside `tsc`'s `.js` scope per the precedent established by Slices 1 and 2). No vendored npm source leaks into `packages/shave/src/` proper.
- **Per-entry isolation guarantee.** Each of the four headline bindings is shaved by its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across bindings, no precomputed multi-binding forest reused across `it()` blocks. (Inherits Slice 2 `DEC-WI510-S2-PER-ENTRY-ISOLATION-001`.)
- **Validator fixture untouched.** `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` is read-only for Slice 3 — Slice 2's fixture is constitutional. The reviewer can spot-check with `git diff aeec068 -- packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` showing no changes.
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. The Slice 2 invariant `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` carries forward unchanged. Per-`it()` overrides up to 120 s are permitted with measurement-citing comments; >120 s is stop-and-report.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — the new vendored `semver@7.8.0` tarball + `PROVENANCE.md`. Required.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — the new Slice 3 test file with four `describe` blocks (`satisfies`, `coerce`, `compare`, `parse`), each with sections A–F mirroring Slice 2. Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `synthetic-tasks` `semver` headline query entries (`cat1-semver-satisfies-001`, `cat1-semver-coerce-001`, `cat1-semver-compare-001`, `cat1-semver-parse-001`). Append-only. Required.
- `plans/wi-510-s3-semver-bindings.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 3 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s3/**` — planner scratch (`semver-7.8.0.tgz`, extracted `package/`). Implementer may use the same directory for re-acquisition; not part of the commit.

### 5.5 Forbidden shortcuts

- **No whole-package shave.** Calling `shavePackage(<semver-fixture-root>, { registry })` without an `entryPath` override is **forbidden** in Slice 3 — that is the abandoned-Slice-2 failure mode and the entire reason the per-entry pattern exists. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the four headline files (`functions/satisfies.js`, `functions/coerce.js`, `functions/compare.js`, `functions/parse.js`).
- **No `vitest.config.ts` timeout raise.** `packages/shave/vitest.config.ts` stays at `testTimeout=30_000`, `hookTimeout=30_000`. Per-`it()` overrides bounded to 120 s with measurement-citing comments (carry-over from Slice 2).
- **No shared `beforeAll` across the four bindings.** Per-entry isolation invariant (Slice 2 `DEC-WI510-S2-PER-ENTRY-ISOLATION-001`).
- **No engine-source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1 per master plan §5. If an engine gap surfaces (semver should not surface any — the engine handled validator's Babel-CJS with `stubCount=0` and semver's plain CJS is structurally simpler), it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 3 stops and reports. The most likely class of engine-gap surprises here is around (a) the `range` ⇄ `comparator` circular import — Slice 1's cycle guard is supposed to handle this; if it doesn't, that is a Slice 1 bug; (b) ts-morph's handling of `const { x, y } = require('z')` destructuring — `extractRequireSpecifiers` walks `require(<string>)` calls regardless of the assignment context, but the implementer should sanity-check this is actually true with a one-off `console.log` in §A if a destructuring-using module like `classes/comparator.js` looks under-resolved.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path. (Carry-over from Slice 2 §5.5.)
- **No hand-authored `semver` atoms.** The four headline atoms are the engine's output from vendored source. (Sacred Practice 12.)
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 3 only appends `synthetic-tasks` rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is small (§3, max ~22); if any headline test sees `moduleCount` approaching `maxModules` (default 500), that indicates a B-scope leak or fixture-vendoring error. Implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical; `readdir`-order / `Map`-iteration / absolute-path leakage in any helper added by Slice 3 is forbidden. (Carry-over from Slice 2 §5.5.)
- **No public `types.ts` surface break.**
- **No reach into Slice 2's fixture.** `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` is read-only for Slice 3.
- **No new fixture vendoring beyond `semver-7.8.0`.** Slices 4-N (uuid+nanoid, date-fns, jsonwebtoken+bcrypt, lodash, zod/joi, p-limit+p-throttle) remain out of scope.

### 5.6 Ready-for-Guardian definition (Slice 3)

Slice 3 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **Workspace-wide** `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes the output (this was the CI failure pattern on Slice 1's PR; package-scoped passing is necessary but not sufficient).
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the four bindings (`satisfies`, `coerce`, `compare`, `parse`), the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules and no unrelated semver behaviors), the **merkle root of the headline binding's atom** (the entry-module's persisted atom root), and the wall-clock time of that headline's `shavePackage` invocation. The §3 estimates are the reviewer's anchor for "does this look right?"
4. Each of the four headline bindings produces a connected `ModuleForest` whose nodes are exactly the headline's transitive in-package subgraph — reviewer confirms via the §3 inspection that no unrelated semver behavior modules are present.
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise). A test exceeding 120 s — even with a per-`it()` override — is a blocking flag, not a passing condition. Cumulative §A–§E wall-clock <8 minutes; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) <12 minutes.
6. Two-pass byte-identical determinism per headline.
7. `combinedScore >= 0.70` for **each** of the four headline behaviors, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (not skipped)**, reviewer pastes the four per-behavior scores. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut.
9. `corpus.json` carries exactly the four appended `synthetic-tasks` `semver` headline entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes.
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Slice 2 fixture untouched.** Reviewer spot-checks `git diff aeec068 -- packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` shows no changes.
12. **`satisfies` circular-import termination proven.** Reviewer confirms `satisfies` test passes and that the BFS visited both `classes/range.js` and `classes/comparator.js` once each — the circular edge between them did not cause re-visit or hang. This is the load-bearing real-world cycle-guard check.
13. New `@decision` annotations are present at the Slice 3 modification points (the test file; the `PROVENANCE.md` cites the DEC IDs in §8). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 3 (per-entry shave of 4 semver headline bindings)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — the new vendored fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + copy.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — the new Slice 3 test file with four headline `describe` blocks.
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `synthetic-tasks` `semver` headline query entries. Append-only.
- `plans/wi-510-s3-semver-bindings.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s3/**` — scratch (tarball + extracted package); not committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — the vendored fixture tree (51-53 files; the `package/` contents minus `bin/semver.js` if the implementer chooses to drop the unused CLI binary — but the recommended approach is full carryover for honesty per `DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`).
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/PROVENANCE.md` — the provenance document per §4.1 template.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — the new test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the four `semver` headline-behavior query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — **the testTimeout=30_000 / hookTimeout=30_000 defaults are forbidden touches.** This carries forward `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` verbatim.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1 per master plan §5.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2's test file. Slice 3 adds a *new* test file; it does not edit Slice 2's.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1's engine tests. Frozen.
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — Slice 2's vendored fixture. Read-only for Slice 3.
- `packages/shave/src/__fixtures__/module-graph/ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slice 1's fixtures. Read-only.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**` — used by the test; not modified by Slice 3 (the existing `maybePersistNovelGlueAtom` is sufficient).
- `packages/shave/src/cache/**`, `packages/shave/src/intent/**` — used by the test (Slice 2's `withStubIntentCard` / `withSemanticIntentCard` helpers consume `sourceHash`, `STATIC_MODEL_TAG`, `STATIC_PROMPT_VERSION`); not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`, embedding providers).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 3 produces atoms via the engine from `semver` source; hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**`, `examples/**`, `.worktrees/**` — adjacent lanes (`#508`, `#512`, benches) outside Slice 3's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**` from Slice 1; no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.
- All other `plans/*.md` files — Slice 3 owns only `plans/wi-510-s3-semver-bindings.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 3 **calls** these with an explicit `entryPath` option per headline; does not fork, modify, or extend them.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 3 produces four headline-atom-rooted subgraphs by shaving `semver/functions/<binding>.js` per entry; never writes a root directly.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 3 appends four `synthetic-tasks` entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 3 does not modify this authority; per-entry shave size is bounded by §3 estimates so the default `testTimeout=30_000` is sufficient (per-`it()` 120 s override permitted, >120 s = stop-and-report).
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 3 adds one sibling directory `semver-7.8.0/` next to the existing `ms-2.1.3/`, `validator-13.15.35/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/`.

---

## 7. Slicing / dependency position

Slice 3 is a single work item. Dependencies: **Slice 1 (landed `37ec862` on `main`)** and **Slice 2 (landed `aeec068` on `main`)** for pattern continuity (Slice 3 imports no Slice 2 source, but its test file is structurally a sibling-by-copy of Slice 2's `validator-headline-bindings.test.ts`, so Slice 2's `@decision` annotations and helper functions like `withStubIntentCard`/`withSemanticIntentCard` are the canonical references the Slice 3 implementer reuses).

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing semver as Slice 3 is the proximate consumer; the broader triad (#508 import-intercept hook, #512 B10 bench) currently focuses on the validator headline bindings (Slice 2's deliverable) — semver is in the corpus for completeness, not as the next demo binding.

- **Weight:** **M** (four small-to-medium per-entry shaves + test orchestration + measurement-evidence discipline + fixture vendoring; no engine change). Slightly heavier than Slice 2 because `satisfies` is ~18 modules vs validator's max ~12 modules and exercises the cycle guard.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S3-PER-ENTRY-SHAVE-001` | Slice 3 shaves the four semver headline bindings per-entry, not the whole package | Inherits the structural pattern from Slice 2 (`DEC-WI510-S2-PER-ENTRY-SHAVE-001`). Each of the four bindings is its own `shavePackage({ entryPath })` call producing a 5-22-module subgraph (§3 estimates), comfortable inside the default 30 s `testTimeout` and bounded by the Slice 2 120 s per-`it()` ceiling. The four headlines (`satisfies`, `coerce`, `compare`, `parse`) are the bindings #510's issue body names; broader semver coverage (~40 other behaviors in `functions/` and `ranges/`) is deferred to a later production-corpus initiative the master plan §5 reserves. |
| `DEC-WI510-S3-PARSE-COMPONENT-BINDING-001` | "parse-component" from #510 issue body resolves to `functions/parse.js` | The issue body names "parse-component" but semver has no file by that literal name. The candidate set is `functions/parse.js` (full parser returning a `SemVer` with `major/minor/patch/prerelease/build` component fields) and `functions/major.js`/`minor.js`/`patch.js` (thin extractors that themselves call `parse()`). Selected `parse()` because it is semver's canonical "string → component structure" entry point; the extractors are derivatives. A later slice may add a separate `major`/`minor`/`patch` shave (each is a ~7-module chain identical to `compare`'s); that is a follow-on issue, not a Slice 3 widening. |
| `DEC-WI510-S3-VERSION-PIN-001` | Pin to `semver@7.8.0` | `7.8.0` is the current `latest` dist-tag (verified 2026-05-16 via `npm view`). The 7.x line has zero runtime dependencies (matches `validator@13.15.35`'s property); semver's source is plain modern Node.js CJS (no Babel `_interopRequireDefault` wrapper, structurally simpler than the validator fixture). The pin is for byte-identical fixture vendoring; a later production-corpus initiative may broaden the pin set. |
| `DEC-WI510-S3-FIXTURE-FULL-TARBALL-001` | Vendor the full `semver-7.8.0` published tarball verbatim, not a hand-trimmed subset | Inherits the Slice 2 rationale (`DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001`): honest about what `node_modules` contains, lets `isInPackageBoundary` scope traversal at zero cost for unreferenced files, avoids the maintenance burden of a hand-trimmed subset. The fixture lives at `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/` and is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob. |
| `DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001` | The `satisfies` shave is the first real-world cross-package corroboration of Slice 1's circular-import cycle guard | semver's `classes/range.js` ⇄ `classes/comparator.js` is a genuine circular import in published-npm source (verified §3.1). Slice 1's cycle guard (`DEC-WI510-DEP-FOLLOWING-ENGINE-001`-class invariants) was proven against a synthetic `circular-pkg/` fixture; this slice corroborates that proof against a real-world npm package. §5.6 criterion 12 makes the reviewer confirm termination explicitly. If the satisfies shave hangs or re-visits, that is a Slice 1 bug filed as a separate issue, not patched in-slice. |

These DECs are recorded in `@decision` annotation blocks at the Slice 3 modification points (the new test file primarily; the `PROVENANCE.md` cites the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| `extractRequireSpecifiers` mis-handles a `const { x, y } = require('z')` destructuring pattern in semver source (`classes/comparator.js` uses `const { safeRe: re, t } = require('../internal/re')`, `classes/semver.js` uses `const { MAX_LENGTH, MAX_SAFE_INTEGER } = require('../internal/constants')`) → an in-package edge is silently lost → the test passes but the forest is incomplete. | `extractRequireSpecifiers` walks all `CallExpression` nodes for `require(<string-literal>)` regardless of the assignment context (verified at `packages/shave/src/universalize/module-resolver.ts:325-358`); destructuring on the LHS does not affect the `require()` CallExpression node on the RHS. §5.2 §A range checks (`moduleCount` lower bounds) and §5.6 criterion 4 (reviewer inspects BFS `filePath` list) catch a missing transitive dep as an under-count. Implementer optionally adds a one-off `console.log` in §A for `satisfies` showing the `range.js` BFS-order resolved-dep list to sanity-check destructuring resolution. |
| `satisfies` exceeds the 120 s per-`it()` ceiling because its 18-module subgraph is meaningfully larger than any Slice 2 binding. | §5.5 forbids the global timeout raise; §5.6 criterion 5 makes >120 s a stop-and-report event. The implementer measures wall-clock per headline and records it in the PR body. If `satisfies` lands at, e.g., 90 s, that is within ceiling but loud — the implementer should record it visibly so the reviewer can flag whether the per-`it()` override comment cites the §3 ~18-module estimate. |
| The `range` ⇄ `comparator` cycle is not handled correctly by Slice 1's cycle guard → `satisfies` shave hangs or recurses to depth limit → §A test times out. | §5.6 criterion 12 makes circular-import termination an explicit Slice 3 acceptance gate. If the cycle guard fails on this real-world case, that is a Slice 1 bug — file a new issue against the engine, do NOT patch it in Slice 3. Slice 3 stops and reports. The Slice 1 cycle guard has unit-test coverage against a synthetic `circular-pkg/` fixture; the most likely failure mode is a subtle visited-set keying choice that works on a 2-module synthetic cycle but breaks on a 3+-module cycle — Slice 3's semver case is a real-world stress test, which is its value beyond just adding to the corpus. |
| `combinedScore < 0.70` for one of the four semver behaviors because the engine-derived intent text is too terse for the embedder, or because semver's behavior strings ("satisfies", "compare") have less semantic surface area than validator's ("isEmail"). | Same risk and mitigation as Slice 2 §9. The `withSemanticIntentCard` helper (Slice 2 `DEC-WI510-S2-SEMANTIC-INTENT-CARD-001`) takes an explicit behaviorText that mirrors the corpus query string; Slice 3 reuses it. If a binding under-scores, the implementer extends `semanticHints` (which map to `IntentCard.preconditions` → `SpecYak.preconditions` in the canonicalized embedding JSON) with domain-specific keyword phrases (e.g. "semver", "version range", "satisfies constraint"). Reviewer escalates only if even with semantic hints the score stays <0.70 — that is a genuine quality finding, not a Slice 3 design failure, and might prompt a follow-up issue on the intent-extraction strategy. |
| Per-entry isolation is broken in implementation — a shared module-graph cache or in-memory project reuse causes one headline's shave to influence another's. | The shave engine's per-`decompose` call uses a fresh in-memory `Project` (verified in `recursion.ts` during Slice 1); there is no engine-level cache to invalidate. §5.5 forbids shared `beforeAll` across bindings. Two-pass byte-identical determinism per headline (§5.6 criterion 6) is the empirical check. |
| A future implementer reads "headline bindings" and adds a fifth binding (e.g. `inc`, `valid`, one of the `ranges/*`) to Slice 3's scope without operator approval. | §1.1 and §6 are explicit: "the four headlines `satisfies`, `coerce`, `compare`, `parse`"; broader semver coverage is "deferred to a later production-corpus initiative." Adding a fifth binding requires a user-decision boundary, same as Slice 2's structural defense. |
| The semver source uses some pattern the engine has not previously seen (e.g. `module.exports = { a, b, c }` object literal export, or `module.exports.x = ...` per-line attribute export). | semver source uses neither — every `*.js` file uses `module.exports = <single-binding>` (verified in §3 source reads for `satisfies.js`, `coerce.js`, `compare.js`, `parse.js`, `cmp.js`, `eq/neq/gt/gte/lt/lte`). The engine handled validator's identical `module.exports = <single-binding>` shape with `stubCount=0`. If a transitive module surfaces a novel shape, that is a Slice 1 engine gap (file a bug) — Slice 3 stops and reports. |
| The `package.json#files` list mentions `lib/` but the tarball has no `lib/` directory (semver@7 dropped `lib/`). | Harmless drift. The resolver follows actual `require()` edges, not the `files` array; no `require('./lib/...')` exists in the source. Implementer copies the actual tarball contents (no `lib/`); `PROVENANCE.md` notes the drift. |
| The vendored fixture acquisition is non-reproducible (`npm pack` produces a different tarball SHA1 on different days because the registry re-packs metadata). | `npm pack semver@7.8.0` is deterministic for a frozen package version (npm publishes immutable tarballs; `dist.shasum` and `dist.integrity` are fixed for a published version). The `PROVENANCE.md` records the SHA1 and integrity; a re-acquisition that produces a different SHA1 is a red flag the reviewer catches. The file-tree content is what matters for reproducibility; SHA1 is provenance audit metadata. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **The other ~40 `semver` behaviors** (`inc`, `valid`, `diff`, `clean`, the `ranges/*` family, the `classes/*` exports beyond what the four headlines transitively pull). Deferred to a later production-corpus initiative per master plan §5.
- **`major`/`minor`/`patch` as separate bindings.** "parse-component" resolves to `parse()` per `DEC-WI510-S3-PARSE-COMPONENT-BINDING-001`. A separate slice for the three extractor bindings is a follow-on issue.
- **A whole-package shave path.** Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Engine frozen after Slice 1 per master plan §5.
- **Slice 4-N graduated fixtures** (uuid+nanoid, date-fns, jsonwebtoken+bcrypt, lodash, zod/joi, p-limit+p-throttle). Out of Slice 3 scope.
- **`vitest.config.ts` adjustments.** Forbidden touch point — Slice 2 invariant carries forward.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 3 produces the four headline-binding atoms in the corpus, `#508` Slice 2 already shipped with validator as the demo binding.
- **The B10 bench (`#512`).** Separate WI; semver atoms are corpus completeness, not the demo path.

---

*End of Slice 3 plan — per-entry shave of `satisfies`, `coerce`, `compare`, `parse` (the four `semver` headline bindings per #510).*
