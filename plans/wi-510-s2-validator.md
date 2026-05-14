# WI-510 Slice 2 — `validator` as the first real npm fixture through the dependency-following engine

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 2 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (the B-scope dependency-following shave engine) is **landed on `main` as `37ec862`** (PR #526).
**Branch:** `feature/wi-510-s2-validator`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s2-validator`
**Authored:** 2026-05-14 (planner stage, workflow `WI-510-S2-VALIDATOR`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan — §5 slicing, §10 risks), `plans/import-replacement-triad.md` (the triad coordination doc — §1 desired end state, §3 MVDP).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. It records new DEC IDs in §9 to be annotated at the implementation point (consistent with how Slice 1 recorded `DEC-WI510-*`).

---

## 1. What Slice 2 is — and the honest scoping question up front

Per `plans/wi-510-shadow-npm-corpus.md` §5, Slices 2-N are the 11 npm packages as **graduated acceptance fixtures**, ordered by call-graph complexity. **Slice 2 = `validator`** — the first real npm package shaved through the now-landed engine, and the triad's MVDP unblocker: #508 Slice 1's import-intercept hook and #512 Slice 2's B10 Arm A both consume `validator`'s forest (`plans/import-replacement-triad.md` §3).

The reframed plan's intent for Slices 2-N is: *"point the proven engine at package X, confirm the forest is connected and findable — they exercise the engine, they do not change it"* (§5; `plans/import-replacement-triad.md` §4 Scope Manifest hint). The Scope Manifest for fixture slices was written to **forbid `packages/shave/src/universalize/**` engine source edits** (`plans/wi-510-shadow-npm-corpus.md` §10 last risk row: *"a fixture slice that hits an engine gap files a bug against the engine; it does not patch the engine in-slice"*).

**The honest scoping finding (verified against the real `validator@13.15.35` package and the landed engine — see §3): Slice 2 is NOT a pure "exercise the engine" slice.** `validator`'s published `lib/**` is **Babel-transpiled CommonJS**, not hand-written source. The landed Slice 1 engine was proven only on `ms@2.1.3` (clean hand-written near-single-file CJS) and three synthetic fixtures. Babel-transpiled CJS exposes at least two engine-adjacent gaps (§3.3): the `_interopRequireDefault` / `_typeof` / `Object.defineProperty(exports, …)` boilerplate that Babel emits is structurally heavy and the per-module `decompose()` has never been exercised on it. Slice 2 must **surface these gaps honestly and decide their disposition** (§3.4): either (a) they degrade cleanly under the engine's existing best-effort discipline and the forest is still connected-and-findable (then Slice 2 stays a fixture slice), or (b) they require an engine-source change (then Slice 2 carries a **scoped, `approve`-gated** engine-source amendment, and that is a scope decision surfaced here — see §7 and DEC-WI510-S2-FIXTURE-SOURCE-FORM-001).

This plan is written so the implementer **measures first** (§6.0 is a mandatory measurement gate before any fixture-shape or engine decision is locked) and the reviewer adjudicates the fork against recorded evidence, not narrative.

---

## 2. The landed engine — verified API surface (what Slice 2 builds on)

Verified against `packages/shave/src/universalize/module-graph.ts`, `module-resolver.ts`, and `module-graph.test.ts` at `37ec862`.

### 2.1 `shavePackage(packageRoot, options)` — `module-graph.ts`

```
shavePackage(
  packageRoot: string,
  options: { registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">;
             entryPath?: string;
             maxModules?: number /* default 500 */ }
): Promise<ModuleForest>
```

Algorithm (B-scope BFS): resolve entry-point via `resolvePackageEntry()` → BFS queue → per file: read source, `decompose(source, registry)` → `RecursionTree`, extract import + `require()` specifiers via ts-morph, resolve each via `resolveModuleEdge()`, classify in-package (enqueue + record `inPackageEdges`) vs external (`externalSpecifiers`). Emits a `ModuleForest`:

- `ModuleForest = { nodes: ModuleForestEntry[]; entryPath; packageRoot; moduleCount; stubCount }`
- `ModuleForestEntry = ModuleForestNode | ModuleStubEntry`
- `ModuleForestNode = { kind: "module"; filePath; tree: RecursionTree; inPackageEdges[]; externalSpecifiers[] }`
- `ModuleStubEntry = { kind: "stub"; specifier; reason }`

Best-effort: unreadable file, `.d.ts`-only, or `decompose()` throw → `ModuleStubEntry`; `moduleCount`/`stubCount` accumulate; never throws wholesale. `maxModules` cap → remaining queue entries become stubs.

### 2.2 Forest helpers — `module-graph.ts`

- `forestModules(forest)` → `ModuleForestNode[]`
- `forestStubs(forest)` → `ModuleStubEntry[]`
- `forestTotalLeafCount(forest)` → number (sum of `tree.leafCount`)
- `collectForestSlicePlans(forest, sliceFn, registry, mode = "glue-aware")` → `{ filePath; slicePlan: SlicePlan }[]` — the bridge from forest to the existing `slice()` in `slicer.ts`. `sliceFn` is injected to avoid a circular import.

### 2.3 `module-resolver.ts`

- `resolveModuleEdge(specifier, importerDir, packageRoot)` → resolved path | `UNRESOLVABLE` (symbol). Relative specifiers resolved from `importerDir`; bare specifiers resolve only if they equal the package's own `name` (self-reference); everything else → `UNRESOLVABLE`.
- `resolvePackageEntry(packageRoot)` → `package.json#exports["."]` → `#main` → `index.*` probe.
- `isInPackageBoundary(resolvedPath, packageRoot)` → the **single named B-scope predicate**.
- `extractImportSpecifiers(source, filePath)` / `extractRequireSpecifiers(source, filePath)` → sorted dedup'd specifier lists via ts-morph; never throw (return `[]` on parse failure).
- `probeFile` / `probeIndex` / `resolveFromExports` / `resolveExportValue` / `readPackageJson` — resolver internals.

### 2.4 The persist path — `packages/shave/src/persist/`

- `persistNovelGlueAtom(entry: NovelGlueEntry, registry: Registry, options?)` and `maybePersistNovelGlueAtom(entry, registryView, options?)` (`atom-persist.ts`) — the canonical "atom → content-addressed registry row" path. Only `NovelGlueEntry` with an `intentCard` persists; `PointerEntry` / `ForeignLeafEntry` are skipped. `buildTriplet()` (`triplet.ts`) derives `(specHash, impl, manifest)` and `blockMerkleRoot()` (`@yakcc/contracts`) the identity; `storeBlock` is idempotent (`INSERT OR IGNORE`).
- `slice()` does **not** itself persist — `shave()` (`index.ts:608-640`) iterates the `SlicePlan` and calls `maybePersistNovelGlueAtom` per entry when `persist:true`. **There is no `persistForest()` helper today.** The forest → registry path for Slice 1's `ms` quality test (`module-graph.test.ts §10`) is: `shavePackage()` → take entry module source → `buildTriplet()` directly → `storeBlock()` on an `openRegistry(":memory:")`. That is the real `storeBlock` path but it bypasses the per-leaf `slice()` → `maybePersistNovelGlueAtom` loop. Slice 2's Evaluation Contract (§6) requires the forest be persisted via the **real `slice()` → `maybePersistNovelGlueAtom`** path, not the single-source-`buildTriplet` shortcut — see §6.3 and DEC-WI510-S2-FOREST-PERSIST-PATH-001.

### 2.5 How Slice 1 wired the corpus — `corpus.json`

Slice 1 appended exactly one entry to `packages/registry/test/discovery-benchmark/corpus.json`:

```json
{
  "id": "cat1-ms-duration-parse-001",
  "source": "synthetic-tasks",
  "category": "behavior-only",
  "query": { "behavior": "Parse a human-readable duration string such as '2 days' or '1h' into a number of milliseconds" },
  "expectedAtom": null,
  "rationale": "WI-510 Slice 1: ms fixture entry. ... combinedScore >= 0.70 is verified by module-graph.test.ts §10 quality test ..."
}
```

`source: "synthetic-tasks"` with `expectedAtom: null` means the entry does **not** participate in the seed-corpus per-category invariants of `discovery-eval-full-corpus.test.ts` (those gate `seed-derived` entries: ≥8-per-category, positive+negative). The `combinedScore >= 0.70` check is mechanized **inside the shave package's own test** (`module-graph.test.ts §10`, `it.skipIf(!USE_LOCAL_PROVIDER)`), not in the registry full-corpus harness. **Slice 2 mirrors this pattern exactly** (DEC-WI510-S2-CORPUS-ENTRY-001): append `validator` headline-behavior entries as `source: "synthetic-tasks"`, `expectedAtom: null`; mechanize the score check in a Slice-2 quality test in the shave package; do not touch the `discovery-eval-full-corpus.test.ts` harness or its per-category invariants.

---

## 3. `validator` against the engine — fixture shape, expected forest, and engine gaps

### 3.1 The `validator@13.15.35` package shape (verified via `npm pack`)

- `package.json#main = "index.js"`, no `#exports` field, `"sideEffects": false`, **no runtime `dependencies`** (validator is dependency-free — confirmed: its `package.json` has only `devDependencies`). This is important: B-scope vs C-scope is moot for `validator` — there are **no external runtime deps to stop at**. Every edge `shavePackage` follows is in-package.
- `index.js` — Babel-transpiled CJS. ~110 `require("./lib/<isX>")` calls, each wrapped `var _isX = _interopRequireDefault(require("./lib/isX"));`, then a single `exports.default = { toDate: _toDate.default, … }` aggregation object.
- `lib/**` — **113 `.js` files**, each a Babel-transpiled validator (`isEmail.js`, `isURL.js`, `isUUID.js`, `isFQDN.js`, `isAlphanumeric.js`, …) plus `lib/util/**` (10 files: `assertString.js`, `checkHost.js`, `merge.js`, `algorithms.js`, `multilineRegex.js`, `toString.js`, `typeOf.js`, `nullUndefinedCheck.js`, `includesArray.js`, `includesString.js`).
- The headline behaviors named in `plans/import-replacement-triad.md` §1 and `plans/wi-510-shadow-npm-corpus.md`: `isEmail`, `isURL`, `isUUID`, `isAlphanumeric`. Each `require()`s a small set of `lib/util/**` helpers and sibling `lib/is*.js` validators — e.g. `isEmail.js` requires `./util/assertString`, `./util/checkHost`, `./isByteLength`, `./isFQDN`, `./isIP`, `./util/merge`. This is the **call-graph breadth** the reframed plan said `validator` would stress-test (`plans/wi-510-shadow-npm-corpus.md` §5).

### 3.2 Expected forest shape (the hypothesis the implementer must verify in §6.0)

Pointing `shavePackage(<validator-fixture-root>, { registry })` at the vendored `validator` should:

1. Resolve entry-point `index.js` via `package.json#main`.
2. BFS-follow all ~110 `require("./lib/isX")` edges from `index.js` — all in-package, all enqueued.
3. Recurse from each `lib/is*.js` into its `lib/util/**` and sibling `lib/is*.js` `require()` edges.
4. Terminate via the visited-set cycle guard (`validator` has shared-helper diamonds — `assertString` is required by nearly every validator — and may have cycles; the visited-set keyed by normalized path handles both).
5. Hit the `maxModules` default of **500** comfortably (123 source files total) — but the implementer must confirm `maxModules` is not the limiting factor; if the real module count is unexpectedly high, the Evaluation Contract requires setting `maxModules` explicitly with a recorded rationale, not silently truncating.
6. Emit a `ModuleForest` with `moduleCount ≈ 123`, `stubCount` low (ideally 0), every `lib/is*.js` an independently-addressable `ModuleForestNode` peer in the same `nodes[]` array (the connected-forest property — `plans/wi-510-shadow-npm-corpus.md` §2).

### 3.3 The engine gaps `validator` exposes — verified, honest

`validator/lib/**` is **Babel-transpiled CJS**. The landed engine was proven on `ms@2.1.3` (clean hand-written near-single-file CJS) and three synthetic hand-written fixtures (`circular-pkg`, `degradation-pkg`, `three-module-pkg`). Babel output is structurally different in ways the engine has never been exercised against:

- **GAP-1 — Babel interop boilerplate dominates each module.** Every `lib/*.js` starts with `"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.default = isX; function _interopRequireDefault(e) { … }` plus per-import `var _dep = _interopRequireDefault(require("./dep"));`. The per-module `decompose()` walks this AST top-down. The risk: `decompose()` / `decomposableChildrenOf()` / the strict-subset predicate (`@yakcc/ir`) may classify the `_interopRequireDefault` helper, the `Object.defineProperty` call, and the `_typeof` polyfill (in `index.js`) as glue — and in `glue-aware` mode they degrade to `GlueLeafEntry`, which is *correct best-effort behavior* but means the forest could be **`GlueLeafEntry`-dominated** rather than yielding granular `isEmail`-behavior atoms. Slice 1's `ms` end-to-end test explicitly asserted "not `ForeignLeafEntry`-dominated"; Slice 2 must assert "not `GlueLeafEntry`-dominated to the point of uselessness" — the *headline behavior* (`isEmail`'s actual validation logic) must surface as a real atom/`NovelGlueEntry`, even if the Babel wrapper around it is glue.
- **GAP-2 — `decompose()` has never run on `exports.default = function isX(…)` shape.** `validator`'s validators are `exports.default = function isEmail(str, options) { … }` (named function expression assigned to `exports.default`). `ms` was `module.exports = function (val, options) { … }` (anonymous) plus top-level `function parse(str)` declarations. Whether `decompose()` finds the behavior body inside `exports.default = function isEmail(…)` and recurses into it — or stalls at the `ExpressionStatement` / `BinaryExpression` of the assignment — is **unverified**. (`decomposableChildrenOf` *does* have `ExpressionStatement` and `BinaryExpression` cases per `plans/wi-510-shadow-npm-corpus.md` §1, so this may just work — but it is unproven and §6.0 must measure it.)
- **GAP-3 — `extractRequireSpecifiers` on Babel output.** The landed `extractRequireSpecifiers` looks for `require("<literal>")` `CallExpression`s with an `Identifier` callee named `require` and exactly one string-literal argument. Babel emits exactly that shape (`require("./lib/isEmail")`), so this *should* work — but Babel also emits `_interopRequireDefault(require("./dep"))` (nested call) and `require` is sometimes shadowed. The implementer must confirm `extractRequireSpecifiers` finds the nested-call `require()` specifiers in Babel output (the ts-morph `forEachDescendant` walk should reach them — but verify in §6.0).

### 3.4 Disposition of the gaps — the fork

This is the scope fork the reviewer adjudicates against §6.0 measurement evidence:

- **Path A (Slice 2 stays a pure fixture slice).** GAP-2 and GAP-3 just work; GAP-1 degrades cleanly — the Babel boilerplate becomes `GlueLeafEntry`s under `glue-aware` mode, the *headline validator behaviors still surface as real atoms*, the forest is connected, two-pass deterministic, and `combinedScore >= 0.70` is reachable for the headline behaviors. Then Slice 2 touches **only** the vendored fixture, a Slice-2 quality test, and `corpus.json` — no engine source. This is the expected/hoped path.
- **Path B (Slice 2 carries a scoped engine amendment).** Measurement shows a real engine gap — e.g. `decompose()` genuinely stalls on the `exports.default = function` shape and the headline behavior never surfaces as an atom, OR the Babel boilerplate is so dominant the forest is useless. Then Slice 2's scope **expands** to a bounded, `@decision`-annotated engine-source change inside `packages/shave/src/universalize/**` (NOT `recursion.ts`'s `recurse()` loop unless proven necessary, NOT the public `types.ts` surface), the gate escalates to **`approve`**, and the change ships as a bundle (source + invariant tests + this plan's status update) per the Architecture-Preservation discipline. The reframed plan's "fixture slices do not change engine source" rule (`plans/wi-510-shadow-npm-corpus.md` §10) is **explicitly re-opened for Slice 2 only, and only if §6.0 proves it necessary** — recorded as DEC-WI510-S2-FIXTURE-SOURCE-FORM-001.
- **Path C (vendor a TS-rewritten or de-Babel'd `validator` subset).** If Babel output is intractable for v0.7's engine within Slice 2's timeline, the fixture is reduced to a hand-vendored, un-transpiled subset of `validator`'s headline validators (the `isEmail`/`isURL`/`isUUID`/`isAlphanumeric` source plus their `lib/util` helpers, taken from `validator`'s **`src/`** GitHub source which is plain ES modules, not the published Babel `lib/`). This is the precedent set by WI-015's `mri` fork point (`MASTER_PLAN.md` v0.7 ledger: *"if the JS-tolerant shave path is too hard … scope reduces to a vendored TS rewrite … acknowledged as a demo deliverable"*). Path C keeps Slice 2 a fixture slice (no engine source) but is **honest that the fixture is not the published npm artifact byte-for-byte** — recorded in DEC-WI510-S2-FIXTURE-SOURCE-FORM-001.

**The implementer does §6.0 measurement first and records which path the evidence supports. The reviewer adjudicates. The planner's recommendation: attempt Path A; if GAP-2 is real, prefer Path C over Path B** — vendoring `validator`'s own `src/` ES-module source (which is what Babel compiles *from*) is a fixture-shape choice, not an engine change, and keeps the engine frozen as the reframe intends. Path B (engine amendment) is the last resort and must be genuinely justified by §6.0 evidence that no fixture-shape choice avoids it.

### 3.5 `validator` version pin

**Pin `validator@13.15.35`** (latest stable as of 2026-05-14, verified via `npm view validator version`). The vendored fixture directory records the exact version in its path and a `PROVENANCE` note (mirroring `ms-2.1.3/`'s version-in-path convention). If Path C is taken, vendor from the `validator@13.15.35` git tag's `src/` tree and record the source tree + commit in the provenance note.

---

## 4. Implementation approach (fully specified)

### 4.1 Vendor the `validator` fixture

Mirror the `ms-2.1.3/` precedent under `packages/shave/src/__fixtures__/module-graph/`:

- **Path A/B:** vendor the published `validator@13.15.35` npm tarball contents needed for the shave: `package.json`, `index.js`, `lib/**` (all 113 files + `lib/util/**`). Directory: `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/`. The `lib/**` Babel CJS is large but the `ms-2.1.3` fixture established that vendored npm source belongs here, and **both `biome.json` ignore globs already cover `packages/shave/src/__fixtures__/module-graph/**`** (verified — Slice 1 added them at `37ec862`), so the vendored `.js` is not linted. `tsconfig.base.json` has **no `allowJs`/`checkJs`** (verified) so `tsc` does not type-check `.js` fixture files either. The vendored fixture is therefore lint-safe and typecheck-safe by construction.
- **Path C:** vendor only the headline-behavior subset from `validator`'s git `src/` tree (`src/lib/isEmail.js`, `isURL.js`, `isUUID.js`, `isAlphanumeric.js`, `isFQDN.js`, `isIP.js`, `isByteLength.js`, and the `src/lib/util/**` helpers they transitively reach), plus a minimal `package.json` and an `index.js` entry that re-exports them. Same directory naming with a `-src-subset` suffix to be honest about the shape. Record the exact subset and the upstream commit in a `PROVENANCE.md` inside the fixture dir.
- Add a `PROVENANCE` note in the fixture directory either way: package name, version `13.15.35`, source (npm tarball vs git `src/` tree), retrieval date, and which headline behaviors the fixture is expected to yield.

### 4.2 The Slice 2 test file

New test: `packages/shave/src/universalize/validator-fixture.test.ts` (mirrors `module-graph.test.ts`'s structure and the `§N` describe-block convention). It exercises the **landed** `shavePackage` / `collectForestSlicePlans` / forest helpers against the vendored `validator` fixture — it does not re-test the engine internals (Slice 1 owns those). Sections:

- **§A Measurement gate (§6.0).** Mandatory: run `shavePackage` against the fixture, log `moduleCount`, `stubCount`, per-stub `reason`, `forestTotalLeafCount`, and for each headline-behavior module the `tree.leafCount` and the `slice()` entry-kind histogram (`pointer` / `novel-glue` / `foreign-leaf` / `glue-leaf` counts). This test always runs and always passes (it is a measurement, not an assertion) but its `console.log` output is the **evidence the reviewer reads to adjudicate the §3.4 fork**. The implementer copies the salient numbers into the plan's status update and the PR body.
- **§B Forest connectivity.** Assert `moduleCount` is in the expected range, the headline-behavior modules (`isEmail.js`, `isURL.js`, `isUUID.js`, `isAlphanumeric.js`) are all present as `ModuleForestNode` peers in `forest.nodes`, shared helpers (`lib/util/assertString.js`) appear exactly once (visited-set dedup), and `inPackageEdges` on `isEmail.js`'s node point at its real `require()` targets.
- **§C Headline behaviors are real atoms, not glue-dominated.** For each of the four headline behaviors, run `collectForestSlicePlans` and assert the module's `slicePlan` contains at least one `NovelGlueEntry` (or `PointerEntry`) whose source is the validator's actual logic — i.e. the forest is **not** `GlueLeafEntry`-dominated to uselessness. This is the GAP-1 gate. The exact assertion threshold (e.g. "≥1 non-glue-leaf entry per headline module") is the implementer's call, recorded in a DEC, but the *intent* is fixed: a consumer must be able to select `isEmail`'s validation behavior as an addressable atom.
- **§D Two-pass byte-identical determinism.** Run `shavePackage` twice over the `validator` fixture; assert `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, and the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (mirrors `module-graph.test.ts §7`, scaled to `validator`'s breadth). Timeout generous (`validator` is 123 modules — likely needs `{ timeout: 120_000 }` or higher; the implementer measures and pins).
- **§E Forest persisted via the real `storeBlock` path.** Open `openRegistry(":memory:")`, run `shavePackage` → `collectForestSlicePlans` → iterate every `slicePlan` entry → `maybePersistNovelGlueAtom(entry, registry, …)` (the **real** per-leaf persist path from `index.ts`'s shave loop, not the single-source-`buildTriplet` shortcut Slice 1's §10 test used). Assert the registry has > 0 blocks after, and the headline-behavior atoms are retrievable. This is the DEC-WI510-S2-FOREST-PERSIST-PATH-001 requirement. If a `persistForest`-shaped helper is the cleanest way to express "iterate forest → slice → persist", the implementer **may** add it inside `packages/shave/src/universalize/module-graph.ts` or `packages/shave/src/persist/` as a thin wrapper over the existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` primitives — that is a **new orchestration helper, not an engine-recursion change**, and is in-scope for Slice 2 (recorded in DEC-WI510-S2-FOREST-PERSIST-PATH-001). It must not duplicate persistence logic — it composes the existing primitives.
- **§F `combinedScore >= 0.70` quality gate.** Mirror `module-graph.test.ts §10`: `it.skipIf(!USE_LOCAL_PROVIDER)` gated on `DISCOVERY_EVAL_PROVIDER=local`. For each headline behavior, shave the `validator` fixture, persist the headline atom via the real path (§E), open `openRegistry(":memory:", { embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384) })`, query `findCandidatesByQuery({ behavior: <corpus query for that behavior> })`, assert top `combinedScore >= 0.70`, and `console.log` the per-behavior score as reviewer evidence. Per §6.6 #6: if the local provider is absent so this block skips, the slice is **blocked, not ready** — the reviewer must run it with the provider and paste the scores.

### 4.3 `corpus.json` entries

Append (append-only, per Slice 1's precedent) **one entry per headline behavior** to `packages/registry/test/discovery-benchmark/corpus.json`, each `source: "synthetic-tasks"`, `category: "behavior-only"`, `expectedAtom: null`, with a natural-prose `query.behavior` describing that validator's behavior and a `rationale` that names this as a WI-510 Slice 2 `validator` fixture entry and points at `validator-fixture.test.ts §F` as the mechanized score check. Suggested IDs: `cat1-validator-is-email-001`, `cat1-validator-is-url-001`, `cat1-validator-is-uuid-001`, `cat1-validator-is-alphanumeric-001`. Because these are `synthetic-tasks` with `expectedAtom: null`, they do **not** trip the `discovery-eval-full-corpus.test.ts` per-category seed invariants — verified that `cat1-ms-duration-parse-001` (the Slice 1 precedent) is the same shape and the harness does not gate `synthetic-tasks` entries on the ≥8/positive+negative rules.

### 4.4 What Slice 2 does NOT do

- Does not modify `recursion.ts`'s `decompose()` / `recurse()` loop or the public `types.ts` surface (Path B, if forced, is bounded to `universalize/**` non-`recursion.ts` and `approve`-gated).
- Does not modify the `slice()` slicer policy, `@yakcc/ir` strict-subset validator, `@yakcc/contracts` `blockMerkleRoot`, or the `discovery-eval-full-corpus.test.ts` harness / registry schema.
- Does not hand-author `validator` atoms — the atoms are the engine's output from the vendored source.
- Does not touch `#508` (hooks) or `#512` (bench) lanes.

---

## 5. Slicing / dependency position

Slice 2 is a single work item. Dependencies: **Slice 1 (landed `37ec862`)** only. Downstream: **#508 Slice 1** and **#512 Slice 2** both gate on Slice 2 producing a real `validator` forest in the registry (`plans/import-replacement-triad.md` §3 MVDP). No other #510 fixture slice depends on Slice 2 — Slices 3-N are mutually independent.

- **Weight:** **M** if §6.0 supports Path A or Path C (fixture + verification work, no engine change). **L** if §6.0 forces Path B (engine amendment + invariant tests).
- **Gate:** **`review`** for Path A / Path C. **`approve`** for Path B (engine-source change is a scope/constitutional decision).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff required, `no_ff` merge. The Path-A→Path-B fork is the one operation class that, if hit, requires user adjudication before the engine-source change lands (it re-opens the reframe's "no engine edits in fixture slices" rule).

---

## 6. Evaluation Contract — Slice 2 (`validator` fixture)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at the end.

### 6.0 Required measurement gate (run FIRST, before any path decision is locked)

- `validator-fixture.test.ts §A` runs `shavePackage` against the vendored `validator` fixture and logs: `moduleCount`, `stubCount`, every stub `reason`, `forestTotalLeafCount`, and per-headline-behavior-module the `tree.leafCount` + `slice()` entry-kind histogram. The implementer records these numbers in the plan status update and the PR body. The reviewer reads them to adjudicate the §3.4 fork. **A Slice 2 PR that does not include this measurement evidence is not reviewable.**

### 6.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1's engine tests) **with zero regressions**, plus the new `validator-fixture.test.ts`.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **`validator-fixture.test.ts §B`** — forest connectivity: `moduleCount` in the measured-expected range, the four headline-behavior modules present as peers in `forest.nodes`, shared helper dedup confirmed, `inPackageEdges` correct on `isEmail.js`.
- **`validator-fixture.test.ts §C`** — GAP-1 gate: each headline behavior surfaces at least one non-`glue-leaf` slice entry; the forest is not glue-dominated to uselessness.
- **`validator-fixture.test.ts §D`** — two-pass byte-identical determinism over the full `validator` forest (`moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS `filePath` order, sorted leaf `canonicalAstHash` set).
- **`validator-fixture.test.ts §E`** — the forest persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path into `openRegistry(":memory:")`; registry has > 0 blocks; headline atoms retrievable.

### 6.2 Required real-path checks

- **The `validator` fixture, end-to-end through the production shave path:** `shavePackage(<validator-fixture-root>, { registry })` produces a connected `ModuleForest` of `validator`'s validator behaviors — the reviewer inspects the emitted forest (via the §A measurement output and §B/§C assertions) and confirms it contains granular validator-behavior atoms (e.g. an `isEmail` validation subgraph), not a `GlueLeafEntry`/`ForeignLeafEntry`-dominated plan.
- **`combinedScore >= 0.70` for `validator`'s headline behaviors** (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`), each measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output (`validator-fixture.test.ts §F`, `DISCOVERY_EVAL_PROVIDER=local`). The reviewer pastes the per-behavior score as evidence. If the local provider is absent so §F skips, the slice is **blocked, not ready**.
- **Two-pass determinism on the real path** — `validator-fixture.test.ts §D` is the production-sequence verification.

### 6.3 Required authority invariants

- **The engine is used, not forked.** Slice 2 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports. If Path B is forced, the engine change is bounded to `packages/shave/src/universalize/**` (excluding `recursion.ts`'s `recurse()` loop unless §6.0 proves it necessary), is `@decision`-annotated, and ships as a bundle (source + invariant tests + plan status update). No parallel "validator shaver" beside `shavePackage`.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives. A `persistForest` wrapper, if added, **composes** those primitives — it does not reimplement triplet construction or identity derivation. `blockMerkleRoot` is never written directly.
- **B-scope predicate untouched.** `isInPackageBoundary` is unchanged. (`validator` has no runtime deps so B-scope is not even exercised at a boundary — every edge is in-package — but the predicate stays single-sourced.)
- **Public `types.ts` surface frozen-for-L5.** `ShaveOptions`, `ShaveResult`, `UniversalizeResult`, `UniversalizeOptions`, `ShaveRegistryView`, `CandidateBlock`, `IntentExtractionHook` MUST NOT change shape. Slice 2 needs no public-surface change.
- **`corpus.json` is append-only.** Slice 2 appends `synthetic-tasks` entries; it does not modify existing entries, the category list, or the `discovery-eval-full-corpus.test.ts` harness.
- **Fixture isolation.** The vendored `validator` source lives only under `packages/shave/src/__fixtures__/module-graph/` (already biome-ignored, already outside `tsc`'s `.js` scope). No vendored npm source leaks into `packages/shave/src/` proper.

### 6.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` (or `-src-subset` for Path C) — the vendored fixture + `PROVENANCE` note.
- `packages/shave/src/universalize/validator-fixture.test.ts` — the new Slice 2 test (§A-§F).
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `validator` headline-behavior query entries.
- `packages/shave/src/universalize/module-graph.ts` or `packages/shave/src/persist/` — ONLY if a thin `persistForest` composition helper is added (optional; composes existing primitives).
- `packages/shave/src/universalize/**` (non-`recursion.ts`) — ONLY under Path B, `approve`-gated, `@decision`-annotated.
- `plans/wi-510-s2-validator.md`, `plans/wi-510-shadow-npm-corpus.md`, `plans/import-replacement-triad.md` — status updates only.

### 6.5 Forbidden shortcuts

- **No single-source-`buildTriplet` shortcut for the persist check.** §6.2's `combinedScore` and §6.1's §E persist check must run through the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path, not the `buildTriplet`-on-entry-source shortcut that Slice 1's `module-graph.test.ts §10` used (that was acceptable for a single-file `ms`; `validator`'s multi-module forest must persist the way `shave()`'s real loop does).
- **No hand-authored `validator` atoms.** The atoms are the engine's output from vendored source.
- **No engine `recursion.ts` edit without §6.0 proof.** Path B is last-resort and bounded; the implementer must show §6.0 measurement evidence that no fixture-shape choice (Path A / Path C) avoids the engine change.
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** The corpus harness and schema are constitutional; Slice 2 only appends `synthetic-tasks` corpus rows.
- **No silent `maxModules` truncation.** If `validator`'s real module count approaches the 500 default, set `maxModules` explicitly with a recorded rationale; do not let the forest silently truncate to stubs.
- **No non-determinism.** `validator`'s 123-module forest must be two-pass byte-identical; `readdir`-order / `Map`-iteration / absolute-path leakage is forbidden (the landed engine already sorts; Slice 2 must not reintroduce non-determinism in any helper it adds).
- **No skipping the measurement gate.** §6.0 evidence is mandatory in the PR.
- **No public `types.ts` surface break.**

### 6.6 Ready-for-Guardian definition (Slice 2)

Slice 2 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts` and the rest of the existing shave suite.
2. **Full-workspace `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean** — not just `--filter @yakcc/shave`. This was the CI failure on Slice 1's PR #526 (package-scoped passed, workspace-scoped caught it); the reviewer runs the workspace-level commands and pastes the output.
3. The §6.0 measurement gate ran and its evidence (`moduleCount`, `stubCount`, stub reasons, per-headline `leafCount` + entry-kind histogram) is in the PR body and the plan status update.
4. The `validator` fixture, run through the real `shavePackage` path, produces a **connected forest of granular validator-behavior atoms** — `validator-fixture.test.ts §B` + §C green, and the reviewer confirms via the §A output that the forest is not `GlueLeafEntry`/`ForeignLeafEntry`-dominated to uselessness.
5. Two-pass determinism: the `validator` shave run is **byte-identical** across two passes (`§D` green).
6. `combinedScore >= 0.70` for each of the four headline behaviors (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`), measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — `validator-fixture.test.ts §F` **ran (not skipped)**, and the reviewer pastes the per-behavior scores. If the local provider is absent so §F skips, the slice is **blocked, not ready**.
7. The forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path (`§E` green) — not the single-source-`buildTriplet` shortcut.
8. `corpus.json` carries exactly the four appended `synthetic-tasks` `validator` entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes (the appended entries do not trip its invariants).
9. The §3.4 path is recorded: the implementer states which path (A / B / C) the §6.0 evidence supported, the reviewer confirms it against the evidence, and **if Path B**, the engine-source change is bounded to `universalize/**` (non-`recursion.ts`), `@decision`-annotated, an `approve` gate was applied, and the user adjudicated re-opening the reframe's no-engine-edit rule.
10. New `@decision` annotations are present at the Slice 2 modification points (the fixture provenance choice, the §C glue-domination threshold, the `persistForest` helper if added, the path A/B/C disposition). New DEC IDs per §9.

---

## 7. Scope Manifest — Slice 2 (`validator` fixture)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` (or `validator-13.15.35-src-subset/**` for Path C) — the vendored `validator` fixture + `PROVENANCE` note.
- `packages/shave/src/universalize/validator-fixture.test.ts` — the new Slice 2 test.
- `packages/shave/src/universalize/module-graph.ts` — ONLY to add a thin `persistForest` composition helper (optional; composes existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` primitives; no engine-recursion change).
- `packages/shave/src/persist/**` — ONLY if the `persistForest` helper is better placed here; same constraint (composition only).
- `packages/registry/test/discovery-benchmark/corpus.json` — append the four `validator` headline-behavior query entries (append-only).
- `packages/shave/src/universalize/**` (excluding `recursion.ts`'s `recurse()` loop and the public `types.ts` surface) — **ONLY under Path B**, if and only if §6.0 measurement proves a fixture-shape choice cannot avoid an engine gap. `approve`-gated, `@decision`-annotated, ships as a bundle.
- `plans/wi-510-s2-validator.md`, `plans/wi-510-shadow-npm-corpus.md`, `plans/import-replacement-triad.md` — status updates only.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` (or `-src-subset`) — the vendored fixture.
- `packages/shave/src/universalize/validator-fixture.test.ts` — the Slice 2 test with §A-§F.
- `packages/registry/test/discovery-benchmark/corpus.json` — the four `validator` query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/src/universalize/recursion.ts` — the `decompose()` / `recurse()` per-file engine. Slice 2 does not touch it. (Path B is bounded to *other* `universalize/**` files.)
- `packages/shave/src/universalize/slicer.ts` — the `slice()` slicer policy is frozen after Slice 1.
- `packages/shave/src/universalize/module-resolver.ts` — the resolver + `isInPackageBoundary` B-scope predicate are frozen after Slice 1.
- `packages/shave/src/types.ts` — the frozen-for-L5 public surface. No change.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1's engine tests. Slice 2 adds a *new* test file; it does not edit Slice 1's.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`). The engine *uses* them.
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — the registry schema and discovery-eval harness are constitutional.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 2 produces atoms via the engine from `validator` source; it hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**` — #508's and #512's lanes.
- `biome.json` — already covers the fixture dir (Slice 1 added the globs); no change needed.
- `MASTER_PLAN.md` — permanent sections untouched; the Slice 2 initiative row is the only addition (this planner pass).

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts` and `decompose()` in `recursion.ts`. Slice 2 **calls** these; it does not fork or modify them (Path B, if forced, is a bounded, approve-gated amendment to `universalize/**` non-`recursion.ts`, recorded as a deliberate scope expansion).
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 2 produces new identities by shaving `validator`; it never writes a root directly.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 2 appends four `synthetic-tasks` entries.
- **Forest → registry orchestration** — a thin `persistForest` composition helper, IF added, is a new orchestration-layer authority that *composes* the existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` primitives. There must be exactly one such helper after Slice 2 if one is added at all; it must not duplicate persist logic.

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| `validator`'s Babel-transpiled `lib/**` produces a `GlueLeafEntry`-dominated forest — the headline behaviors never surface as addressable atoms (GAP-1). | §6.0 measurement gate runs first and quantifies it; §6.1 §C gate asserts each headline behavior surfaces a non-glue-leaf entry. If §6.0 shows the forest is useless, Path C (vendor `validator`'s un-transpiled `src/` subset) is the recommended escape — a fixture-shape choice, not an engine change. Path B (engine amendment) only if §6.0 proves no fixture shape avoids it. |
| `decompose()` stalls on `exports.default = function isX(…)` and never recurses into the validation body (GAP-2). | §6.0 measures per-headline `tree.leafCount`; if it is degenerate (1, i.e. the whole module is one atom/glue blob), the evidence triggers the §3.4 fork. `decomposableChildrenOf` *does* have `ExpressionStatement`/`BinaryExpression` cases so this may just work — but it is unproven and the measurement gate exists precisely to catch it. |
| `extractRequireSpecifiers` misses Babel's nested `_interopRequireDefault(require("./dep"))` calls (GAP-3) → the forest is disconnected, headline modules unreachable. | §6.0 logs `moduleCount`; if it is far below ~123, the `require()` extraction is dropping edges. ts-morph's `forEachDescendant` walk *should* reach nested calls, but §6.0 verifies it. If edges are dropped, that is a real engine gap → §3.4 fork (Path B for `extractRequireSpecifiers`, which is in `module-resolver.ts` — note `module-resolver.ts` is in the forbidden list, so this specific gap would need explicit re-approval; the planner flags it as the most likely Path-B trigger if any). |
| `validator`'s 123-module forest blows the `maxModules` 500 default or is slow enough to flake test timeouts. | 123 < 500 so the default is fine, but §6.5 forbids silent truncation and requires an explicit `maxModules` + rationale if the real count is unexpected; §6.1 §D requires a measured, pinned generous timeout. |
| The reviewer cannot tell Path A from Path B/C because the PR lacks measurement evidence. | §6.0 makes the measurement evidence a hard PR requirement; §6.6 #3 makes "evidence in PR body" a ready-for-Guardian gate; a PR without it is explicitly "not reviewable." |
| Full-workspace `lint`/`typecheck` fails in CI even though `--filter @yakcc/shave` passed (the exact Slice 1 PR #526 failure). | §6.6 #2 makes workspace-level `turbo run lint` + `turbo run typecheck` a hard ready-for-Guardian gate with pasted output. The vendored `.js` fixture is biome-ignored and outside `tsc`'s `.js` scope (both verified), so the fixture itself is safe — the risk is in the new `.test.ts` and any `persistForest` helper, which the workspace-level commands catch. |
| Adding a `persistForest` helper drifts into a second persistence authority. | §6.3 + §7 constrain it to *composition* of existing primitives; it may not reimplement `buildTriplet`/identity/`storeBlock`; exactly one such helper if any. |
| Path B re-opens the reframe's "fixture slices do not change engine source" rule without operator awareness. | §5 landing policy + §6.6 #9 require user adjudication before any Path-B engine-source change lands; DEC-WI510-S2-FIXTURE-SOURCE-FORM-001 records the decision. |

---

## 9. Decision Log Entries (new — to be recorded as `@decision` annotations at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S2-FIXTURE-SOURCE-FORM-001` | Slice 2's `validator` fixture shape — published Babel CJS vs vendored `src/` subset — is a measured decision, and Path B (engine-source change) re-opens the reframe's no-engine-edit rule for fixture slices | `validator@13.15.35`'s published `lib/**` is Babel-transpiled CJS the landed engine has never been exercised against. Slice 2 measures first (§6.0), then takes Path A (published CJS works under best-effort), Path C (vendor un-transpiled `src/` subset — a fixture-shape choice, planner-preferred escape), or Path B (bounded `approve`-gated engine amendment to `universalize/**` non-`recursion.ts`, last resort). Path B explicitly re-opens `plans/wi-510-shadow-npm-corpus.md` §10's "fixture slices do not change engine source" rule for Slice 2 only, and only on §6.0 evidence; it requires user adjudication. |
| `DEC-WI510-S2-FOREST-PERSIST-PATH-001` | Slice 2 persists the `validator` forest via the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path; a thin `persistForest` composition helper may be added but must not fork persist authority | Slice 1's `module-graph.test.ts §10` used a `buildTriplet`-on-entry-source shortcut acceptable for single-file `ms`. `validator`'s multi-module forest must persist the way `shave()`'s real loop does — iterate the `SlicePlan`, call `maybePersistNovelGlueAtom` per `NovelGlueEntry`. A `persistForest` wrapper, if added, composes the existing `collectForestSlicePlans` + `maybePersistNovelGlueAtom` + idempotent `storeBlock` primitives — it does not reimplement triplet construction or identity. Exactly one such helper if any. |
| `DEC-WI510-S2-CORPUS-ENTRY-001` | Slice 2 appends four `validator` headline-behavior corpus entries as `source: "synthetic-tasks"`, `expectedAtom: null` — mirroring the Slice 1 `ms` precedent | `cat1-ms-duration-parse-001` established that fixture-slice corpus entries are `synthetic-tasks` with `expectedAtom: null`, which keeps them out of `discovery-eval-full-corpus.test.ts`'s per-category seed invariants (≥8/category, positive+negative). The `combinedScore >= 0.70` check is mechanized in the shave package's own test (`validator-fixture.test.ts §F`, `DISCOVERY_EVAL_PROVIDER=local`), not the registry full-corpus harness. Slice 2 mirrors this exactly: append-only, four entries (`isEmail`/`isURL`/`isUUID`/`isAlphanumeric`), no harness or schema change. |
| `DEC-WI510-S2-MEASUREMENT-FIRST-001` | Slice 2 runs a mandatory measurement gate (§6.0) before any path/fixture-shape decision is locked; the measurement evidence is a hard PR requirement | `validator` is the first real npm package through the engine and its Babel-CJS shape exposes unverified engine-adjacent behavior (GAP-1/2/3). Locking a path decision by narrative is forbidden — the implementer runs `shavePackage` against the fixture, logs the forest shape (`moduleCount`, `stubCount`, stub reasons, per-headline `leafCount` + entry-kind histogram), and the reviewer adjudicates the §3.4 fork against that evidence. A Slice 2 PR without the measurement evidence is not reviewable. |

These are recorded in the relevant `@decision` annotation blocks at the Slice 2 modification points. They are NOT appended to `MASTER_PLAN.md`'s permanent `## Decision Log` by this planner pass — consistent with how Slice 1's `DEC-WI510-*` IDs live in the source annotations and the plan doc, not the permanent log.

---

## 10. What this plan does NOT cover (Non-Goals)

- **The import-intercept hook (#508).** Slice 2 produces the `validator` forest; #508 Slice 1 intercepts the `import { isEmail } from 'validator'` and queries the registry for it. Separate WI, gated on Slice 2.
- **The B10 bench (#512).** #512 Slice 2 consumes Slice 2's `validator` forest for Arm A. Separate WI, gated on Slice 2 + #508 Slice 1.
- **#510 Slices 3-N** (`semver`, `uuid`/`nanoid`, `date-fns`, `jsonwebtoken`/`bcrypt`, `lodash`, `zod`/`joi`, `p-limit`/`p-throttle`). Mutually independent fixture slices, each its own planner pass.
- **A-scope / C-scope transitive recursion.** `validator` has no runtime deps so B-scope is not even exercised at a boundary; the C-track follow-on issue (`plans/wi-510-shadow-npm-corpus.md` §8) is unaffected by Slice 2.
- **Engine redesign.** Path B, if forced, is a *bounded* amendment justified by §6.0 evidence — not a redesign. The reframe's intent (the engine is frozen after Slice 1) holds unless §6.0 proves a specific, narrow gap.
- **Hand-authoring atoms.** The `validator` atoms are the engine's output from vendored source.
- **`MASTER_PLAN.md` permanent-section edits.** Only the Active-Initiatives Slice 2 row is added by this pass.

*End of WI-510 Slice 2 plan.*
