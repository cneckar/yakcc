# WI-510 Slice 7 — Per-Entry Shave of Six `lodash@4.17.21` Modular Headline Bindings (`cloneDeep`, `debounce`, `throttle`, `get`, `set`, `merge`)

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 7 of [#510](https://github.com/cneckar/yakcc/issues/510). Slices 1 (engine, PR #526, `37ec862`), 2 (validator, PR #544, `aeec068`), 3 (semver, PR #570+#571, `b83d46f`), 4 (uuid+nanoid, PR #573, `5d8bde1`), 5 (date-fns, PR #584, `935f109`), and 6 (jsonwebtoken+bcryptjs, PR #586, `a69e0ca`) are all landed on `main`.
**Branch:** `feature/wi-510-s7-lodash`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s7-lodash`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s7-lodash`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (parent), `plans/wi-510-s6-jsonwebtoken-bcrypt.md` (most-recent multi-binding template), `plans/wi-510-s5-date-fns.md` (trimmed-vendor pattern), `plans/wi-510-s2-headline-bindings.md` (Slice 2 origin).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slices 1–6 recorded their `DEC-WI510-*` entries).

---

## 1. What changed — why Slice 7 exists

Slices 1–6 proved the dependency-following shave engine on `ms`, `validator` (Babel-CJS), `semver` (plain CJS with a real-world cycle), `uuid`+`nanoid` (compiled CJS + first Node-builtin foreign-leaf), `date-fns` (trimmed-vendor + breadth-not-depth), and `jsonwebtoken`+`bcryptjs` (multi-npm external fan-out + single-module-package UMD IIFE). Slice 7 advances one rung up the §5 graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md`:

> *Slice 7 — lodash subset (largest call graph)*

The issue body (#510) names six lodash headline bindings:

> *lodash subset: cloneDeep / debounce / throttle / get / set / merge*

The parent plan flags Slice 7 as the **"largest call graph"** of the entire WI-510 suite, with the expectation of multiple engine-gap risks. After empirical inspection of the lodash source (§3), the risks dramatically de-escalate **once the modular-not-bundled decision is taken** (§1.2). The bound subgraphs are large (108-module cloneDeep is the largest individual binding in the entire WI-510 suite) but the call graph is structurally tame: pure CJS, no classes, no UMD, no top-level external `require()`. This is a **breadth-not-novelty** slice — the engine is exercised at its largest BFS scale to date with no new structural patterns relative to Slice 5 / Slice 6.

### 1.1 Binding-name resolution (operator-decision boundaries closed — all six are direct file matches)

Unlike Slices 2-6, lodash's modular layout means every issue-body headline corresponds **exactly** to a top-level `<name>.js` file in the package root. There are no substitutions, no collapses, no operator-decision boundaries to resolve.

| Issue-body name | npm export | Resolved entry | Notes |
|---|---|---|---|
| `cloneDeep` | `cloneDeep(value)` | `cloneDeep.js` | Recursive deep copy. 30 lines; wraps `_baseClone` with `CLONE_DEEP_FLAG | CLONE_SYMBOLS_FLAG`. |
| `debounce` | `debounce(func, wait, options)` | `debounce.js` | Timing primitive with leading/trailing/maxWait options. ~190 lines. |
| `throttle` | `throttle(func, wait, options)` | `throttle.js` | Wraps `debounce` with `maxWait: wait`. ~75 lines. |
| `get` | `get(object, path, defaultValue)` | `get.js` | Path-based property access. 32 lines; wraps `_baseGet`. |
| `set` | `set(object, path, value)` | `set.js` | Symmetric with `get`. 32 lines; wraps `_baseSet`. |
| `merge` | `merge(object, ...sources)` | `merge.js` | Recursive merge. ~40 lines; uses `_createAssigner(_baseMerge)`. |

**Net result:** **six issue-body headlines → six entryPath shaves → six per-binding atom merkle roots**. No collapses, no substitutions, no DEC-bearing binding resolutions. The corpus appends **six** `synthetic-tasks` rows, one per binding, each pointing at a distinct atom merkle root.

### 1.2 Modular vs bundled — the constitutive operator-decision boundary (closed)

lodash@4 publishes two parallel ways to consume the library:

- **(a) Modular ESM-style imports**: `require('lodash/cloneDeep')`, `require('lodash/debounce')`, etc. Each binding is its own file at the package root (`cloneDeep.js`, `debounce.js`, …). Internal helpers are prefixed with `_` (`_baseClone.js`, `_baseGet.js`, …). The `package.json#main` is `lodash.js`, but **individual file imports bypass the main bundle entirely**. This is the path the lodash docs recommend for tree-shakeable bundlers; it is also how every modern repository's lockfile actually consumes lodash when the user writes `import cloneDeep from 'lodash/cloneDeep'`.

- **(b) Bundled UMD via `lodash.js` (the package's `main` entry, 17,000+ lines)**: a single UMD IIFE that exports the entire `_` namespace. Structurally identical to the bcryptjs UMD pattern (Slice 6) but two orders of magnitude larger. Wraps `(function() { var undefined; ... var _ = runInContext(); ... if (freeModule) { (freeModule.exports = _)._ = _; freeExports._ = _; } else { root._ = _; } }.call(this));`.

**Path (a) — modular — chosen.** Documented in `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001`. Rationale:

1. **Tracks how lodash is actually consumed in real code.** The headline-bindings story (#510) is "what behaviors do LLM-emitted imports reach for?". `import cloneDeep from 'lodash/cloneDeep'` and `import { cloneDeep } from 'lodash-es'` are vastly more common in modern codebases than `import _ from 'lodash'; _.cloneDeep(…)`. The shaved atoms are correspondingly more useful for `#508` import-intercept matching.
2. **Each binding gets its own atom merkle root.** Per-entry decomposition produces six independently-addressable atoms (one per binding), which is the right granularity for the registry's `combinedScore` ranking — `get` and `set` and `merge` are semantically very different behaviors and deserve distinct atoms, not one giant `_.*` mega-atom.
3. **Avoids the engine-gap landmine.** The bundled UMD `lodash.js` is structurally identical to bcryptjs's `dist/bcrypt.js` (Slice 6) but much larger; if Slice 6's bcryptjs IIFE successfully atomized (which we will confirm against the landed PR #586), the lodash UMD would presumably work too — but it would produce ONE 17,000-line atom whose `combinedScore` against any per-binding query would be diluted by 95% of irrelevant content. The modular path sidesteps both the risk and the dilution.
4. **Path (b) is deferred, not rejected.** A later production-corpus initiative may add `lodash`-bundled-atom for the case `import _ from 'lodash'` — that is exactly the bcryptjs single-module-package shape from Slice 6, scaled up. Out of Slice 7's scope.

**Documented in `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001` (§8).**

### 1.3 Pre-existing engine-gap landscape — neither #576 nor #585 applies

Per filed issues:
- **#576** — the shave engine cannot decompose ArrowFunctions inside class bodies. Slice 3's `semver/satisfies` hit this and produces `moduleCount=1, stubCount=1` instead of the planner-estimated `~18`. The Slice 3 PR #571 fix was to align test assertions with engine reality.
- **#585** — the shave engine cannot atomize UMD IIFE wrappers cleanly. Slice 6's bcryptjs `dist/bcrypt.js` produced empirical evidence; PR #586 documents what the engine actually does with the IIFE. (Modular lodash sidesteps this entirely.)

**Empirical scan of the 148-file Slice 7 union subgraph (§3.7) confirms ZERO class declarations and ZERO UMD patterns.** Issue #576 and #585 are **structurally not exercised** by Slice 7 with the modular path chosen. Risk class declarations: `0` files (out of 148). Risk UMD patterns: `0` files. The slice's primary risk is therefore **breadth / wall-clock**, not engine-gap surfacing — see §3 / §3.8.

**Documented in `DEC-WI510-S7-ENGINE-GAPS-NOT-EXERCISED-001` (§8).**

### 1.4 Version pin — `lodash@4.17.21`

**Selected: `lodash@4.17.21`** (NOT the current `latest` dist-tag `4.18.1` — see below).

- `4.18.1` is the **current `latest` dist-tag** as of 2026-05-16 (`npm view lodash dist-tags` returns `{ latest: '4.18.1' }`). It was published recently (post-4.17.x line). Its tarball weighs in at 1.4MB unpacked (~1051 files); pinning to it would still be valid since the modular layout is unchanged between 4.17.x and 4.18.x.
- **However, `4.17.21` is the universally-deployed CJS-friendly version** with ~30M weekly downloads — the version every npm lockfile in the world currently resolves to. It is the **most-installed lodash version ever** and is what `#508`'s import-intercept hook will most often see in user code. Its package layout is identical to `4.18.1`'s for the six target bindings (verified by inspecting both tarballs); pinning to `4.17.21` ensures the atom merkle roots reflect what `#508` will actually encounter at import-intercept time.
- **Source shape: clean CJS.** Every `.js` file opens with top-of-file `var x = require('./<rel>')` declarations followed by a `function name(...) {}` and `module.exports = name;`. NOT Babel-transpiled, NOT TypeScript-compiled, NOT IIFE-wrapped. Structurally the simplest of any landed/planned fixture — pure CJS, every binding is a one-page function.
- **Zero npm dependencies.** Verified: `package.json` has no `dependencies` field.
- **Tarball SHA1 `679591c564c3bffaae8454cf0b3df370c3d6911c`, integrity `sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==`** (verified by `npm pack lodash@4.17.21`, 1054 files, 1413741 unpacked bytes).

**Documented in `DEC-WI510-S7-VERSION-PIN-001` (§8).**

### 1.5 Externalspecifiers expectation — empty across all six bindings

Slice 5 (date-fns) demonstrated the "pure-JS, no `require('<bare>')`" regime: `stubCount = 0` AND `externalSpecifiers = []` across all five headlines because the package contains no top-level external `require()` calls.

lodash@4.17.21 modular is **the same regime** for the six target bindings, with one caveat:

- `_nodeUtil.js` (transitive of `cloneDeep` + `merge`) contains a **conditional indirect require** at line 19:
  ```js
  var types = freeModule && freeModule.require && freeModule.require('util').types;
  ```
  This is `freeModule.require('util')` — a property-access call (`freeModule.require`) whose argument is the string literal `'util'`. The shave engine's `extractRequireSpecifiers` (in `module-resolver.ts`, lines 325-358) walks every `CallExpression` whose callee is an **`Identifier` named `require`** with a single string-literal argument. A property-access `freeModule.require(...)` has callee kind `PropertyAccessExpression`, NOT `Identifier` — the extractor **skips it**. Verified by reading the extractor source.

**Consequence:** `externalSpecifiers = []` AND `stubCount = 0` is the expected empirical state for **all six** Slice 7 headline shaves. The `util` indirect require in `_nodeUtil.js` is invisible to the engine by design (it would otherwise pollute every lodash-using package with a spurious `util` external edge).

**If `externalSpecifiers` is non-empty for any of the six shaves, that is a stop-and-report event** — it would indicate either (a) a change in the extractor's behavior between Slices 5/6 and Slice 7 (unlikely, no engine source change), or (b) a require pattern in lodash source I missed (the §3.7 union scan covered the union of all six subgraphs and found none — but the implementer asserts empirical truth, not the planner survey). Document loudly and either widen the assertion with a citation or file an engine bug.

**Documented in `DEC-WI510-S7-EXTERNAL-SPECIFIERS-EMPTY-001` (§8).**

---

## 2. Path A confirmed — no engine change needed

The engine pattern is settled across Slices 1-6. `shavePackage({ packageRoot, entryPath })` accepts an explicit per-entry override; `isInPackageBoundary()` scopes the BFS to the package's own directory; `extractRequireSpecifiers` walks CJS `require(<string>)` calls; external edges become entries in `ModuleForestNode.externalSpecifiers` (Slice 6 PR #586 corroborated the multi-element npm fan-out path). No engine source change. No new public-API surface. No `ShavePackageOptions` shape change. **Slice 7 is a pure fixture-and-test slice; gate is `review` (matches Slices 2-6).**

The one new property Slice 7 exercises beyond prior corroborations is **largest call graph at this scale**: `cloneDeep` is **108 modules**, `merge` is **96**, `set` is **56**, `get` is **52** — versus the prior maximum of ~12 (jsonwebtoken `verify`). Six headlines totaling 148 unique files in the union (with substantial sharing: `_root.js`, `_freeGlobal.js`, `_baseGetTag.js`, `isObject.js`, `isObjectLike.js` appear in all 6 subgraphs). This corroborates the engine's BFS at one order of magnitude larger scale than any prior fixture — useful production-corpus evidence even though Slice 7 does not formally introduce a new acceptance gate for it.

---

## 3. Per-entry subgraph size measurements (planner ran a BFS in `tmp/wi-510-s7/`)

**Critical lesson learned (PR #571, issue #576):** the planner's estimates of `moduleCount` have a known failure mode. The implementer **asserts what the engine actually emits**. The §3.x numbers below are read from a real recursive `require()`-walk over the extracted `lodash-4.17.21` tarball (the planner ran `tmp/wi-510-s7/bfs.js` against the union of all relative `require()` edges); they are anchors for the implementer's empirical assertion, NOT absolute requirements.

**The wide assertion bounds in §5.2 honor the §3.7 measured numbers but allow ±20% headroom for engine-specific resolution behavior the planner cannot anticipate from a pure-static survey.**

### 3.1 `cloneDeep.js` — the largest subgraph of any WI-510 fixture

Direct requires (1): `./_baseClone`.

Transitive: `_baseClone.js` is the high-fan-in root; it requires 22 helpers (Stack, arrayEach, assignValue, baseAssign, baseAssignIn, cloneBuffer, copyArray, copySymbols, copySymbolsIn, getAllKeys, getAllKeysIn, getTag, initCloneArray, initCloneByTag, initCloneObject, isArray, isBuffer, isMap, isObject, isSet, keys, keysIn). Each of those pulls in further helpers (`_DataView`, `_Hash`, `_Map`, `_MapCache`, `_Set`, `_Symbol`, `_WeakMap`, `_baseGetTag`, `_freeGlobal`, `_getNative`, `_objectToString`, `_root`, `_toSource`, `eq`, `isFunction`, `isLength`, `isObjectLike`, `isPrototype`, `isTypedArray`, …).

**Measured (BFS in `tmp/wi-510-s7/package/` via `tmp/bfs.js`):** **108 unique in-package modules**. Zero relative requires resolved as missing. Zero external bare-`require()` calls visible to `extractRequireSpecifiers` (the only `util` reference is the indirect `freeModule.require('util')` in `_nodeUtil.js`, invisible to the engine — §1.5).

**Range guidance for §A assertion:** `moduleCount in [85, 130]`, `stubCount = 0`, `externalSpecifiers = []`. The lower bound 85 allows for any engine-resolver edge cases that the static survey couldn't anticipate (e.g. an `index.js` resolution that falls through differently); the upper bound 130 catches a B-scope leak (the lodash package has 640 files total; a leak would push past 200 rapidly).

### 3.2 `debounce.js`

Direct requires (3): `./isObject`, `./now`, `./toNumber`.

Transitive: `isObject.js` (leaf), `now.js` → `./_root`, `toNumber.js` → `./_baseTrim`, `./isObject`, `./isSymbol`. Plus their transitives (`_root`, `_freeGlobal`, `_Symbol`, `_baseGetTag`, `_getRawTag`, `_objectToString`, `_trimmedEndIndex`, `_baseTrim`, `isObjectLike`, `isSymbol`).

**Measured:** **14 unique in-package modules**. Zero external.

**Range guidance for §A:** `moduleCount in [10, 20]`, `stubCount = 0`, `externalSpecifiers = []`.

### 3.3 `throttle.js`

Direct requires (2): `./debounce`, `./isObject`.

Transitive: identical to `debounce.js`'s subgraph plus `throttle.js` itself.

**Measured:** **15 unique in-package modules** (debounce subgraph + throttle.js itself). Zero external.

**Range guidance for §A:** `moduleCount in [11, 21]`, `stubCount = 0`, `externalSpecifiers = []`.

**Note:** Slice 7's `throttle` subgraph is **a strict superset of `debounce`** (throttle requires debounce). The shared 14 modules — including `now.js`, `toNumber.js`, all 12 helpers — are re-decomposed per-entry per the per-entry isolation invariant (`DEC-WI510-S2-PER-ENTRY-ISOLATION-001`). The registry's idempotent `storeBlock` dedupes at the atom level via `canonicalAstHash`. Both `debounce` and `throttle` atoms will share the same merkle roots for their shared helper atoms; the entry atom merkle roots differ (`debounce.js`'s atom and `throttle.js`'s atom are distinct).

### 3.4 `get.js`

Direct requires (1): `./_baseGet`.

Transitive: `_baseGet.js` → `_castPath`, `_toKey`. `_castPath.js` → `isArray`, `_isKey`, `_stringToPath`, `toString`. `_stringToPath.js` → `_memoizeCapped` → `memoize` → `_MapCache` (the same Hash/ListCache/Map/MapCache atoms cloneDeep uses for the Map polyfill). Plus the standard `_freeGlobal`, `_root`, `_getNative`, `_baseGetTag`, `_objectToString` chain.

**Measured:** **52 unique in-package modules**. Zero external.

**Range guidance for §A:** `moduleCount in [40, 65]`, `stubCount = 0`, `externalSpecifiers = []`.

### 3.5 `set.js`

Direct requires (1): `./_baseSet`.

Transitive: `_baseSet.js` → `_assignValue`, `_castPath`, `_isIndex`, `isObject`, `_toKey`. The `_castPath` chain is shared with `get`. `_assignValue.js` → `_baseAssignValue` → `_defineProperty` → `_getNative` (shared chain).

**Measured:** **56 unique in-package modules**. Zero external.

**Range guidance for §A:** `moduleCount in [44, 70]`, `stubCount = 0`, `externalSpecifiers = []`.

### 3.6 `merge.js`

Direct requires (2): `./_baseMerge`, `./_createAssigner`.

Transitive: `_baseMerge.js` → `_Stack`, `_assignMergeValue`, `_baseFor`, `_baseMergeDeep`, `isObject`, `keysIn`, `_safeGet`. `_baseMergeDeep.js` → 13 helpers including `_initCloneObject`, `_cloneArrayBuffer`, `_cloneBuffer`, `_cloneTypedArray`, `isArguments`, `isArrayLikeObject`, `isFunction`, `isPlainObject`, `isTypedArray`, `_safeGet`, `toPlainObject`. `_createAssigner.js` → `_baseRest`, `_isIterateeCall`.

**Measured:** **96 unique in-package modules**. Zero external.

**Range guidance for §A:** `moduleCount in [76, 120]`, `stubCount = 0`, `externalSpecifiers = []`.

### 3.7 Aggregate footprint, shared-chain redundancy, and union measurement

**Union of all six subgraphs (measured via `tmp/wi-510-s7/union.js`):** **148 unique in-package modules, ~113KB total bytes** (across all 148 `.js` files).

Per-entry isolation means each test pays its own decompose cost — that is the deliberate design from Slice 2 (`DEC-WI510-S2-PER-ENTRY-ISOLATION-001`). Cumulative module-decompositions across all six §A-§E tests: 108 + 14 + 15 + 52 + 56 + 96 = **341 decompositions**.

This is a meaningful step up from prior slices (Slice 6: ~12, Slice 5: ~21, Slice 4: ~15, Slice 3: ~40). The per-module work is small (lodash modular files are tiny — most are 10-50 lines), but `cloneDeep`'s 108-module BFS is the **single largest decomposition operation in WI-510**.

**Wall-clock expectations:** lodash modular files are pure CJS without classes / IIFE / Babel boilerplate — `decompose()` should be near its best-case. The per-headline budgets below honor the §3 measurements with safety headroom for engine variance:

- `debounce`, `throttle`, `get`, `set`: <30 seconds each.
- `merge`: <60 seconds (96 modules).
- `cloneDeep`: <120 seconds (108 modules — the largest individual headline budget).

**Per-headline test budget: <120 s per headline** (the Slice 2-6 ceiling carried forward). **Cumulative §A-§E budget: <12 minutes** (a step up from prior slices' <5-8 minute budgets, justified by the 341 decompositions vs prior <50). **§F cumulative (with `DISCOVERY_EVAL_PROVIDER=local`): <20 minutes**. Any binding exceeding 120 s is a **stop-and-report** event — even for `cloneDeep`. If `cloneDeep` exceeds 120 s, that is a Slice 1 engine performance concern to file separately, not a Slice 7 acceptance failure to mask.

### 3.8 Stub-count expectation — `stubCount = 0` across all six

Same regime as Slice 5: no external `require()` calls visible to the extractor (§1.5), so `stubCount = 0` is the canonical expectation for all six headlines. If any §A test produces `stubCount > 0`, that is a **stop-and-report event**: either the resolver is mis-categorizing an in-package edge as external (a B-scope leak in the *other* direction), or a require pattern I missed in the §3.x BFS exists. Investigate before declaring readiness.

### 3.9 The 17,000-line `lodash.js` (UMD `main` bundle) is NOT shaved by this slice

`package.json#main` is `lodash.js` — the full UMD bundle. Slice 7 does **not** call `shavePackage(<lodash-fixture-root>)` without an `entryPath` override; every `shavePackage()` invocation passes `entryPath: <fixture-root>/<binding>.js` per `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001`. The `lodash.js` UMD bundle remains on disk for fidelity-with-real-tarball reasons but is never traversed by any of the six test invocations.

**Forbidden shortcut explicitly:** §5.5 forbids the whole-package-shave path (calling `shavePackage(<lodash-fixture-root>, { registry })` without `entryPath`). This would attempt to decompose the 17,000-line UMD bundle — almost certainly producing one giant atom or hitting issue #585. The slice does NOT attempt it.

---

## 4. Fixture shape — TRIMMED vendored tarball (deviation, same rationale as Slice 5)

**Decision: vendor a TRIMMED subset of the `lodash-4.17.21` published tarball.** Same rationale chain Slice 5 documented (`DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001`):

The full lodash@4.17.21 tarball is **~1.4MB unpacked across 1054 files**. ~95% of those files are NOT transitively reachable from any of the six Slice 7 headline subgraphs:

- ~245 `<name>.js` public bindings outside the six target headlines (e.g. `chunk.js`, `compact.js`, `add.js`, `after.js`, `flatten.js`, …).
- ~330 `_<name>.js` internal helpers used only by those other bindings.
- `lodash.js` — the 17,000-line UMD bundle (NOT traversed by Slice 7 per §3.9 — but kept in trimmed vendor as `package.json#main`-fidelity sentinel; see "What we retain anyway" below).
- `fp/` subdirectory — entire auto-curried functional wrapper layer (~330 files; out of scope).
- `core.js`, `core.min.js`, `lodash.min.js` — minified browser variants (not traversed).

**Trimmed vendor manifest (what we keep):**

- `package.json` — required for `package.json#exports` / `main` resolution if the engine traverses to it.
- `LICENSE` — vendored-source license carry-forward.
- `PROVENANCE.md` — authored to §4.1 template.
- **The 6 headline `.js` files**: `cloneDeep.js`, `debounce.js`, `throttle.js`, `get.js`, `set.js`, `merge.js`.
- **All 142 shared transitive `.js` files** (measured §3.7 union minus the 6 headline files). Explicitly: `_DataView.js`, `_Hash.js`, `_ListCache.js`, `_Map.js`, `_MapCache.js`, `_Promise.js`, `_Set.js`, `_Stack.js`, `_Symbol.js`, `_Uint8Array.js`, `_WeakMap.js`, `_apply.js`, `_arrayEach.js`, `_arrayFilter.js`, `_arrayLikeKeys.js`, `_arrayMap.js`, `_arrayPush.js`, `_assignMergeValue.js`, `_assignValue.js`, `_assocIndexOf.js`, `_baseAssign.js`, `_baseAssignIn.js`, `_baseAssignValue.js`, `_baseClone.js`, `_baseCreate.js`, `_baseFor.js`, `_baseGet.js`, `_baseGetAllKeys.js`, `_baseGetTag.js`, `_baseIsArguments.js`, `_baseIsMap.js`, `_baseIsNative.js`, `_baseIsSet.js`, `_baseIsTypedArray.js`, `_baseKeys.js`, `_baseKeysIn.js`, `_baseMerge.js`, `_baseMergeDeep.js`, `_baseRest.js`, `_baseSet.js`, `_baseSetToString.js`, `_baseTimes.js`, `_baseToString.js`, `_baseTrim.js`, `_baseUnary.js`, `_castPath.js`, `_cloneArrayBuffer.js`, `_cloneBuffer.js`, `_cloneDataView.js`, `_cloneRegExp.js`, `_cloneSymbol.js`, `_cloneTypedArray.js`, `_copyArray.js`, `_copyObject.js`, `_copySymbols.js`, `_copySymbolsIn.js`, `_coreJsData.js`, `_createAssigner.js`, `_createBaseFor.js`, `_defineProperty.js`, `_freeGlobal.js`, `_getAllKeys.js`, `_getAllKeysIn.js`, `_getMapData.js`, `_getNative.js`, `_getPrototype.js`, `_getRawTag.js`, `_getSymbols.js`, `_getSymbolsIn.js`, `_getTag.js`, `_getValue.js`, `_hashClear.js`, `_hashDelete.js`, `_hashGet.js`, `_hashHas.js`, `_hashSet.js`, `_initCloneArray.js`, `_initCloneByTag.js`, `_initCloneObject.js`, `_isIndex.js`, `_isIterateeCall.js`, `_isKey.js`, `_isKeyable.js`, `_isMasked.js`, `_isPrototype.js`, `_listCacheClear.js`, `_listCacheDelete.js`, `_listCacheGet.js`, `_listCacheHas.js`, `_listCacheSet.js`, `_mapCacheClear.js`, `_mapCacheDelete.js`, `_mapCacheGet.js`, `_mapCacheHas.js`, `_mapCacheSet.js`, `_memoizeCapped.js`, `_nativeCreate.js`, `_nativeKeys.js`, `_nativeKeysIn.js`, `_nodeUtil.js`, `_objectToString.js`, `_overArg.js`, `_overRest.js`, `_root.js`, `_safeGet.js`, `_setToString.js`, `_shortOut.js`, `_stackClear.js`, `_stackDelete.js`, `_stackGet.js`, `_stackHas.js`, `_stackSet.js`, `_stringToPath.js`, `_toKey.js`, `_toSource.js`, `_trimmedEndIndex.js`, `constant.js`, `eq.js`, `identity.js`, `isArguments.js`, `isArray.js`, `isArrayLike.js`, `isArrayLikeObject.js`, `isBuffer.js`, `isFunction.js`, `isLength.js`, `isMap.js`, `isObject.js`, `isObjectLike.js`, `isPlainObject.js`, `isSet.js`, `isSymbol.js`, `isTypedArray.js`, `keys.js`, `keysIn.js`, `memoize.js`, `now.js`, `stubArray.js`, `stubFalse.js`, `toNumber.js`, `toPlainObject.js`, `toString.js`.

**Trimmed vendor size estimate: ~113KB across 148 `.js` files + `package.json` + `LICENSE` + `PROVENANCE.md` = ~120KB total.** That fits cleanly in the same 50-500KB regime as every prior fixture (validator 487KB, semver 186KB, uuid 415KB, nanoid 79KB, jsonwebtoken 60KB, bcryptjs 100KB, date-fns trimmed 80KB). **Smaller than the average vendored fixture.**

**What this trimmed vendor does NOT do — and is honest about not doing:**

- It does NOT vendor the ~487 other top-level bindings (`chunk`, `compact`, `flatten`, `pick`, `omit`, `map`, `filter`, `reduce`, … and ~480 more). Those are deferred to a later production-corpus initiative the master plan §5 reserves.
- It does NOT vendor `fp/`, `core.js`, `core.min.js`, `lodash.min.js`, or `lodash.js` (the 17,000-line UMD bundle). The bundle remains unvendored to avoid (a) ~600KB of dead weight and (b) the engine encountering it at all (`isInPackageBoundary` would gladly skip it during BFS, but a future implementer who accidentally drops `entryPath` would shave it).
- It does NOT vendor `_<helper>.js` files outside the §3.7 union of all six headline subgraphs. If the implementer's actual BFS at runtime discovers an additional `_<helper>` edge the static survey missed, the test will surface it as either an unresolvable edge (file an issue, do NOT silently vendor more) or as a B-scope leak (stop-and-report).
- It does NOT vendor `README.md` — not required by any traversal, not load-bearing.

**Documented in `DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001` (§8).**

**Fixture acquisition path (already done in `tmp/wi-510-s7/` by the planner; the implementer re-runs for fresh known-good copies):**

- `cd tmp/wi-510-s7 && npm pack lodash@4.17.21` → `lodash-4.17.21.tgz` (SHA1 `679591c564c3bffaae8454cf0b3df370c3d6911c`, integrity `sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==`, 1054 files, 1413741 unpacked bytes).
- Extract → `package/` directory.
- Copy the trimmed manifest (148 `.js` files + `package.json` + `LICENSE`) to `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/`.
- Author `PROVENANCE.md` per §4.1 template; it MUST explicitly cite `DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001` and list the excluded directories.

**Implementer-aid: a deterministic copy script.** Because the trimmed vendor manifest is 148 explicitly-enumerated files, the implementer SHOULD use a deterministic script (e.g. a Node one-liner that reads the §4 list verbatim and copies each file from the extracted tarball) rather than hand-copying 148 files. The planner has already verified the list against a live BFS (`tmp/wi-510-s7/union.js`); the implementer can re-run the same BFS to verify the list at acquisition time.

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified by Slices 1-6). The `.js` files are outside `tsc`'s scope.

### 4.1 `PROVENANCE.md` template

```
# Provenance — lodash@4.17.21 fixture (TRIMMED)

- **Package:** lodash
- **Version:** 4.17.21 (NOT the current `latest` 4.18.1; see DEC-WI510-S7-VERSION-PIN-001)
- **Source:** npm tarball (`npm pack lodash@4.17.21`)
- **Tarball SHA1:** 679591c564c3bffaae8454cf0b3df370c3d6911c
- **Tarball integrity:** sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==
- **Tarball file count:** 1054
- **Tarball unpacked bytes:** 1413741
- **Retrieved:** 2026-05-16
- **Vendor strategy:** TRIMMED (NOT full-tarball as Slices 3/4/6 used).
  Rationale: the full tarball is ~1.4MB across 1054 files; only 148 are transitively
  reachable from the six Slice 7 headline subgraphs. Trimmed vendor retains those
  148 files + package.json + LICENSE. Trimmed size: ~120KB total.
  Inherits Slice 5 rationale (DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001) extended to
  lodash via DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001.
- **Retained files (148 .js + package.json + LICENSE + this PROVENANCE.md):**
  Headlines: cloneDeep.js, debounce.js, throttle.js, get.js, set.js, merge.js.
  Shared transitives: <list the 142 _<helper>.js + plain-name files from §4 of plan>
- **Excluded files / directories (deliberately NOT vendored):**
  - lodash.js (17,000-line UMD bundle — never traversed by Slice 7; see DEC-WI510-S7-MODULAR-NOT-BUNDLED-001)
  - core.js, core.min.js, lodash.min.js (browser bundles)
  - fp/ (auto-curried functional wrappers, ~330 files)
  - ~480 other public binding .js files (add, after, chunk, compact, flatten, pick, …)
  - ~330 _<helper>.js internal files used only by the excluded bindings
  - README.md
- **Shape:** Pure modern Node.js CommonJS. Every .js opens with top-of-file `var x = require('./<rel>')`
  declarations followed by `function name(...) {}` and `module.exports = name;`. NOT
  Babel-transpiled. NOT TypeScript-compiled. NOT IIFE-wrapped (the modular files are NOT UMD;
  the UMD bundle is in the excluded lodash.js).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges (visible to engine):** none. _nodeUtil.js (a transitive of cloneDeep + merge)
  contains a `freeModule.require('util')` indirect property-access call, NOT a bare `require('util')`;
  the engine's extractRequireSpecifiers skips it by design (DEC-WI510-S7-EXTERNAL-SPECIFIERS-EMPTY-001).
  Expected `stubCount = 0` and `externalSpecifiers = []` for ALL six Slice 7 headlines.
- **Headline behaviors (this slice):** cloneDeep, debounce, throttle, get, set, merge —
  each one a distinct entryPath shave producing its own atom merkle root. No collapses,
  no substitutions (per §1.1 — modular lodash gives every binding its own file).
- **Path decision:** Modular (a), not bundled (b) — per DEC-WI510-S7-MODULAR-NOT-BUNDLED-001.
- **Why pin 4.17.21:** Universally-deployed CJS-friendly version; ~30M weekly downloads;
  the version every npm lockfile in the world currently resolves to. Modular layout
  identical to 4.18.1 for the six target bindings (DEC-WI510-S7-VERSION-PIN-001).
- **WI:** WI-510 Slice 7, workflow `wi-510-s7-lodash`.
```

---

## 5. Evaluation Contract — Slice 7 (per-entry shave of six modular lodash headline bindings)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1), `validator-headline-bindings.test.ts` (Slice 2), `semver-headline-bindings.test.ts` (Slice 3), `uuid-headline-bindings.test.ts` + `nanoid-headline-bindings.test.ts` (Slice 4), `date-fns-headline-bindings.test.ts` (Slice 5), `jsonwebtoken-headline-bindings.test.ts` + `bcryptjs-headline-bindings.test.ts` (Slice 6) **with zero regressions**, plus the new lodash headline tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Workspace-wide `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all packages. Carry-over from Slices 2-6; `--filter`-scoped passing is necessary but not sufficient (CI fails on workspace-scoped lint/typecheck).
- **Per-entry headline tests** — ONE new test file:
  - `packages/shave/src/universalize/lodash-headline-bindings.test.ts` — SIX `describe` blocks (one per headline: `cloneDeep`, `debounce`, `throttle`, `get`, `set`, `merge`), each with sections A-E (and a unified F block for the six `combinedScore` quality gates). Plus a compound interaction test at the end (real production sequence).
  - Each `describe` is independent (no shared `beforeAll` across bindings) — Slices 2-6 per-entry isolation invariant carries forward.
- **Compound interaction test** — at least one test exercising the real production sequence `shavePackage → collectForestSlicePlans → maybePersistNovelGlueAtom` end-to-end for all six headlines in sequence. This is the load-bearing "real-path" check, not a unit-mocked one. (Mirrors the Slice 6 compound test pattern with six entries instead of two.)

### 5.2 Required real-path checks

- **Per-headline real-path forest:** for each of the six entryPath shaves, `shavePackage(<fixture-root>, { registry, entryPath: <fixture-root>/<binding>.js })` produces a `ModuleForest` whose `moduleCount` falls inside the §3 range for that binding:
  - `cloneDeep` (`cloneDeep.js`): `moduleCount in [85, 130]`, `stubCount = 0`, `externalSpecifiers = []` (or document the empirical non-zero state loudly per §3.8 / §1.5).
  - `debounce` (`debounce.js`): `moduleCount in [10, 20]`, `stubCount = 0`, `externalSpecifiers = []`.
  - `throttle` (`throttle.js`): `moduleCount in [11, 21]`, `stubCount = 0`, `externalSpecifiers = []`.
  - `get` (`get.js`): `moduleCount in [40, 65]`, `stubCount = 0`, `externalSpecifiers = []`.
  - `set` (`set.js`): `moduleCount in [44, 70]`, `stubCount = 0`, `externalSpecifiers = []`.
  - `merge` (`merge.js`): `moduleCount in [76, 120]`, `stubCount = 0`, `externalSpecifiers = []`.
  - The reviewer inspects `forest.nodes` and `forestStubs(forest)` to confirm `forest.nodes[0].filePath` ends in the expected entry file (`cloneDeep.js`, `debounce.js`, etc.) and that `externalSpecifiers` is empty.
- **`combinedScore >= 0.70`** for **each** of the **six** corpus query strings (§F):
  - `cat1-lodash-cloneDeep-001` — points at `cloneDeep.js` atom merkle root.
  - `cat1-lodash-debounce-001` — points at `debounce.js` atom merkle root.
  - `cat1-lodash-throttle-001` — points at `throttle.js` atom merkle root.
  - `cat1-lodash-get-001` — points at `get.js` atom merkle root.
  - `cat1-lodash-set-001` — points at `set.js` atom merkle root.
  - `cat1-lodash-merge-001` — points at `merge.js` atom merkle root.
  Measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. Each test uses `withSemanticIntentCard` (the Slice 2 helper, carried forward verbatim in Slices 3-6) with a behaviorText that mirrors each row's `corpus.json` query string. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, **the slice is blocked, not ready** — reviewer must run with the local provider and paste the six scores.
- **Per-entry isolation proven at scale:** `debounce` and `throttle` share 14 of the same in-package modules (throttle's subgraph is a strict superset of debounce's). Both shaves emit those 14 modules independently per the per-entry isolation invariant. The registry layer dedupes at the atom level (`canonicalAstHash` via idempotent `INSERT OR IGNORE`); the atom merkle roots for the shared helper atoms (e.g. `now.js`, `toNumber.js`, `isObject.js`, `_Symbol.js`, `_baseGetTag.js`, etc.) MUST be byte-identical between `debounce` and `throttle` test invocations. The reviewer confirms by collecting the union of leaf canonical hashes from both shaves and verifying the 14-module overlap matches.
- **Two-pass byte-identical determinism per headline:** for each of the six entryPath shaves, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, `externalSpecifiers` (sorted, should be `[]`), AND the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (per-headline, not aggregated — same property Slices 2-6 assert).
- **Forest persisted via the real `storeBlock` path per headline:** for each of the six shaves, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom`, not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after each shave's persist; the headline atom is retrievable. (Carry-over from Slices 2-6.)

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 7 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** No new public API surface in `packages/shave/src/types.ts`.
- **B-scope predicate untouched and corroborated at largest BFS scale to date.** `isInPackageBoundary` is unchanged. The 148-module union BFS is the largest test of the B-scope predicate's correctness; the implementer must explicitly assert (via the §5.2 `externalSpecifiers = []` check) that no in-package edge is misclassified as external.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives.
- **Per-entry isolation invariant.** Each of the six entryPath shaves uses its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across the six describe blocks within the lodash test file. Shared atoms between bindings are deduplicated at the registry layer (`storeBlock` idempotency), NOT by hoisting `shavePackage` calls to module scope.
- **Public `types.ts` surface frozen-for-L5.** No public-surface change.
- **`corpus.json` is append-only.** Slice 7 appends **six** new `synthetic-tasks` entries (`cat1-lodash-cloneDeep-001`, `cat1-lodash-debounce-001`, `cat1-lodash-throttle-001`, `cat1-lodash-get-001`, `cat1-lodash-set-001`, `cat1-lodash-merge-001`). No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change.
- **Fixture isolation.** The vendored sources live ONLY under `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/`. Biome-ignored, outside `tsc`'s `.js` scope.
- **Predecessor fixtures untouched.** `validator-13.15.35/**`, `semver-7.8.0/**`, `uuid-11.1.1/**`, `nanoid-3.3.12/**`, `ms-2.1.3/**`, `date-fns-4.1.0/**`, `jsonwebtoken-9.0.2/**`, `bcryptjs-2.4.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` are read-only for Slice 7. Reviewer can spot-check with `git diff main -- packages/shave/src/__fixtures__/module-graph/` showing exactly one new sibling directory.
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. The Slice 2 invariant `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` carries forward. Per-`it()` overrides (e.g. `{ timeout: 120_000 }`) are permitted for the larger bindings but must include a measurement-citing comment.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/**` — trimmed vendored lodash fixture + `PROVENANCE.md` (148 `.js` files + `package.json` + `LICENSE` + `PROVENANCE.md` = ~151 files). Required.
- `packages/shave/src/universalize/lodash-headline-bindings.test.ts` — new Slice 7 test file (six headline `describe` blocks + compound test). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append six `synthetic-tasks` entries (suggested query strings; the implementer may refine wording to match the embedder's known-good idioms, the reviewer signs off on final wording):
  - `cat1-lodash-cloneDeep-001` — query: "Recursively deep-clone a JavaScript value including nested objects, arrays, dates, maps, sets, and symbols, returning a new value with no shared references"
  - `cat1-lodash-debounce-001` — query: "Create a debounced version of a function that delays execution until after a specified wait period of inactivity has elapsed since the last call"
  - `cat1-lodash-throttle-001` — query: "Create a throttled version of a function that limits invocation to at most once per specified time window"
  - `cat1-lodash-get-001` — query: "Safely read a nested property value from an object using a dotted-string or array path with a default fallback if the path resolves to undefined"
  - `cat1-lodash-set-001` — query: "Set a nested property value on an object at a dotted-string or array path, creating intermediate objects or arrays as needed"
  - `cat1-lodash-merge-001` — query: "Recursively merge own and inherited enumerable properties of source objects into a destination object, replacing arrays and plain objects deeply"
  Append-only. Required.
- `plans/wi-510-s7-lodash.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 7 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s7/**` — planner scratch (tarball + extracted `package/` tree + BFS helper scripts). Implementer may use the same directory for re-acquisition and re-running the BFS verification script; not part of the commit.

### 5.5 Forbidden shortcuts

- **No whole-package shave path.** Calling `shavePackage(<lodash-fixture-root>, { registry })` without an `entryPath` override is **forbidden** — same as Slices 2-6. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the six headline files (`cloneDeep.js`, `debounce.js`, `throttle.js`, `get.js`, `set.js`, `merge.js`). The 17,000-line `lodash.js` UMD bundle (the package's `main` entry) MUST NEVER be shaved by Slice 7 — see `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001`.
- **No `vitest.config.ts` timeout raise.** Per-`it()` overrides bounded to 120 s with measurement-citing comments. >120 s = stop-and-report.
- **No shared `beforeAll` across the six bindings.**
- **No engine-source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1. If an engine gap surfaces, it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 7 stops and reports.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path.
- **No hand-authored `lodash` atoms.** The atoms are the engine's output from vendored source. (Sacred Practice 12.)
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 7 only appends `synthetic-tasks` rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is at most ~130 (cloneDeep). `maxModules` default is 500 — none of the six should approach it. If any headline test sees `moduleCount` approaching `maxModules`, that indicates a B-scope leak or fixture-vendoring error (likely: the implementer accidentally vendored `lodash.js`'s UMD bundle and dropped the `entryPath` override). Implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical. `readdir`-order / `Map`-iteration / absolute-path leakage in any helper added by Slice 7 is forbidden.
- **No public `types.ts` surface break.**
- **No reach into predecessor fixtures.** `validator-13.15.35/`, `semver-7.8.0/`, `uuid-11.1.1/`, `nanoid-3.3.12/`, `ms-2.1.3/`, `date-fns-4.1.0/`, `jsonwebtoken-9.0.2/`, `bcryptjs-2.4.3/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 7.
- **No new fixture vendoring beyond `lodash-4.17.21`.** Slices 8, 9 (zod/joi, p-limit+p-throttle) remain out of scope.
- **No vendoring of excluded lodash files.** `lodash.js` (UMD bundle), `core.js`, `core.min.js`, `lodash.min.js`, `fp/`, and the ~480 other public bindings + ~330 transitive helpers are explicitly **NOT** vendored per `DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001`. If the implementer's BFS at runtime discovers an additional `_<helper>` edge the static survey missed, the test surfaces it as an unresolvable edge — file an engine bug or extend the trimmed manifest with a fresh planner pass; do NOT silently vendor more.
- **No `void (async () => {...})()` patterns in test files.** Per the Slice 3 lesson learned from PR #566: the shave engine cannot atomize `VoidExpression` of an IIFE. Test orchestration uses plain `await`-in-`async`-`it()`. If parallelism is desired, use `queueMicrotask` per the same lesson.
- **No skipping `biome format --write` before commit.** Per the Slice 3 lesson learned from PR #570: local turbo cache can hide format violations that CI catches. Run `pnpm biome format --write packages/shave/src/universalize/lodash-headline-bindings.test.ts` (and any other touched files) before staging.
- **No `Closes #510`** in the PR description. Slice 7 of 9; use `Refs #510 (Slice 7 of 9)` only.
- **No assertion against planner-estimated `moduleCount` without empirical verification.** Per the PR #571 / issue #576 lesson: the planner's estimates are anchors, not certainties. The implementer **runs the shave first** to discover the actual `moduleCount` / `externalSpecifiers` / `stubCount`, then writes assertions that honor the empirical output. If the empirical value falls outside the §3 range, the implementer either widens the assertion with a citation comment OR investigates the divergence (engine gap, fixture error). The §3 ranges are deliberately wide for the same reason.
- **No bundled-lodash path.** `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001` is constitutional for Slice 7.

### 5.6 Ready-for-Guardian definition (Slice 7)

Slice 7 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, `uuid-headline-bindings.test.ts`, `nanoid-headline-bindings.test.ts`, `date-fns-headline-bindings.test.ts`, `jsonwebtoken-headline-bindings.test.ts`, `bcryptjs-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **Workspace-wide** `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes the output (package-scoped passing is necessary but not sufficient — the CI failure pattern from earlier slices).
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the six entryPath shaves (`cloneDeep`, `debounce`, `throttle`, `get`, `set`, `merge`), the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules), the **merkle root of the headline binding's atom** (the entry-module's persisted atom root), the **externalSpecifiers list** (must be `[]`), and the wall-clock time of that headline's `shavePackage` invocation. The §3 measurements are the reviewer's anchor for "does this look right?" — but the empirical values are the source of truth.
4. Each of the six entryPath shaves produces a `ModuleForest` whose nodes are the headline's transitive in-package subgraph — reviewer confirms via §3 inspection that no unrelated lodash binding modules are present (e.g. `cloneDeep`'s subgraph contains NONE of the `_baseMerge`/`_assignMergeValue` chain; `merge`'s subgraph contains NONE of `_baseClone`'s `_initCloneByTag` etc.).
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise). `cloneDeep` (108 modules) is the most likely to approach this; the reviewer accepts up to 120 s for that headline with measurement evidence. A test exceeding 120 s is a blocking flag, not a passing condition — even for `cloneDeep`. Cumulative §A-§E wall-clock <12 minutes; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) <20 minutes.
6. Two-pass byte-identical determinism per headline (all six).
7. `combinedScore >= 0.70` for **each** of the **six** corpus query strings, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (not skipped)**, reviewer pastes the six per-query scores. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut.
9. `corpus.json` carries exactly the six appended `synthetic-tasks` entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes (the per-category `>= 8` invariant is comfortably satisfied — cat1 has many more rows than 8 after Slices 2-6 land six headline rows + Slice 7 adds six more).
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Predecessor fixtures untouched.** Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/{validator-13.15.35,semver-7.8.0,uuid-11.1.1,nanoid-3.3.12,ms-2.1.3,date-fns-4.1.0,jsonwebtoken-9.0.2,bcryptjs-2.4.3,circular-pkg,degradation-pkg,three-module-pkg}/` shows no changes; only `lodash-4.17.21/` is added as a new sibling.
12. **`externalSpecifiers = []` proven across all six shaves.** Reviewer confirms that for each of the six headlines, `forestModules(forest).flatMap(m => m.externalSpecifiers)` is `[]`. This is the Slice 7-specific corroboration that the engine correctly handles the "pure CJS, no top-level external require" regime at largest BFS scale to date (148-module union), without spurious external emission from the `freeModule.require('util')` indirect call in `_nodeUtil.js`.
13. **Six distinct atom merkle roots** — one per headline. Reviewer collects the six entry-atom merkle roots and confirms they are pairwise distinct (the bindings are semantically different functions; their canonical AST hashes should differ).
14. **Shared transitive atom dedup proven.** The 14-module overlap between `debounce` and `throttle` subgraphs produces 14 byte-identical leaf-atom merkle roots when both shaves are run against the same in-memory registry. Reviewer confirms by collecting the union of leaf canonical hashes from both shaves and verifying the overlap count.
15. New `@decision` annotations are present at the Slice 7 modification points (the test file's top-of-file decoration block; the `PROVENANCE.md` cites the DEC IDs). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 7 (per-entry shave of six modular lodash headline bindings)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/**` — trimmed vendored lodash fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + trimmed copy.
- `packages/shave/src/universalize/lodash-headline-bindings.test.ts` — new Slice 7 test file (six headline `describe` blocks + compound test).
- `packages/registry/test/discovery-benchmark/corpus.json` — append six `synthetic-tasks` headline query entries. Append-only.
- `plans/wi-510-s7-lodash.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s7/**` — scratch (tarball + extracted package + BFS helper scripts); not committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/**` — the trimmed vendored lodash fixture tree (148 `.js` files + `package.json` + `LICENSE` + `PROVENANCE.md`).
- `packages/shave/src/universalize/lodash-headline-bindings.test.ts` — the new lodash test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the six `synthetic-tasks` query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — `testTimeout=30_000` / `hookTimeout=30_000` defaults carry forward `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` verbatim.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2 test file.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — Slice 3 test file.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — Slice 5 test file.
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — Slice 6 test file.
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — Slice 6 test file.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1 engine tests.
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — Slice 2 fixture.
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — Slice 3 fixture.
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/**` — Slice 5 fixture.
- `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/**` — Slice 6 fixture.
- `packages/shave/src/__fixtures__/module-graph/bcryptjs-2.4.3/**` — Slice 6 fixture.
- `packages/shave/src/__fixtures__/module-graph/ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slice 1 fixtures.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**` — used by the test; not modified.
- `packages/shave/src/cache/**`, `packages/shave/src/intent/**` — used by the test (existing `withStubIntentCard` / `withSemanticIntentCard` helpers consume `sourceHash`, `STATIC_MODEL_TAG`, `STATIC_PROMPT_VERSION`); not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`, embedding providers).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/test/discovery-benchmark/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 7 produces atoms via the engine; hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**`, `examples/**`, `.worktrees/**` — adjacent lanes (#508, #512, benches) outside Slice 7's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**`; no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.
- All other `plans/*.md` files — Slice 7 owns only `plans/wi-510-s7-lodash.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 7 **calls** these with an explicit `entryPath` option per headline; does not fork, modify, or extend them.
- **Module resolver — B-scope predicate** — canonical authority: `isInPackageBoundary()` and `resolveSpecifier()` in `module-resolver.ts`. Slice 7 **exercises** the predicate at the largest BFS scale to date (148-module union, 341 cumulative decompositions).
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 7 produces six headline-atom-rooted subgraphs; the shared transitive helpers (14 modules common to `debounce`+`throttle`; many more shared between `cloneDeep`+`merge`, `get`+`set`) deduplicate at the atom layer via canonical hash idempotency.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 7 appends six `synthetic-tasks` entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 7 does not modify; the larger bindings (`cloneDeep`, `merge`) use per-`it()` `{ timeout: 120_000 }` overrides with measurement-citing comments.
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 7 adds one sibling directory (`lodash-4.17.21/`) next to the existing eleven.

---

## 7. Slicing / dependency position

Slice 7 is a single work item. Dependencies: **Slices 1-6 all landed on `main`** (PRs #526, #544, #570+#571, #573, #584, #586). Slice 7 imports no Slice 2-6 source; its test file is a structural sibling-by-copy of `jsonwebtoken-headline-bindings.test.ts` and `date-fns-headline-bindings.test.ts`, extended to six describe blocks.

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing lodash as Slice 7 is the proximate consumer; the triad (#508, #512) currently focuses on the validator headline bindings — lodash atoms are corpus completeness, not the next demo binding.

- **Weight:** **M-to-L** (one trimmed fixture vendored with 148 files + six small entryPath shaves + test orchestration for six describes + the largest BFS scale to date for `cloneDeep` and `merge`). Heavier than Slice 5 / Slice 6 because the cumulative module decomposition count is 341 (vs Slice 5: ~21, Slice 6: ~12) and the cloneDeep individual subgraph is the largest in the entire WI-510 suite. Lighter than what the parent plan §1 "largest call graph" warning anticipated because the structural patterns (pure CJS, no classes, no UMD) are tame.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched; modular-vs-bundled decision is constitutional but baked into `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001` rather than requiring user approval at implementation time).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S7-PER-ENTRY-SHAVE-001` | Slice 7 shaves six lodash modular headline bindings per-entry, not the whole package | Inherits the structural pattern from Slices 2-6. Six `shavePackage({ entryPath })` calls (`cloneDeep.js`, `debounce.js`, `throttle.js`, `get.js`, `set.js`, `merge.js`) producing 14-130-module subgraphs (§3 measurements). All six are comfortable inside the per-`it()` 120 s budget; most are <60 s. Broader coverage (the ~480 other lodash bindings) is deferred to a later production-corpus initiative the master plan §5 reserves. |
| `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001` | Slice 7 uses lodash modular per-binding files, NOT the 17,000-line `lodash.js` UMD bundle | The modular path tracks how lodash is actually consumed in modern code (`import cloneDeep from 'lodash/cloneDeep'`), produces per-binding atom merkle roots (the right granularity for `combinedScore` ranking), and sidesteps the engine-gap risk of UMD IIFE atomization at 17,000-line scale. The bundled UMD path is deferred to a future "single-module-package atom" initiative analogous to Slice 6's bcryptjs treatment. Path A chosen; path B explicitly rejected (would produce one giant atom with diluted `combinedScore` for every per-binding query). |
| `DEC-WI510-S7-VERSION-PIN-001` | Pin to `lodash@4.17.21` (NOT the current `latest` dist-tag `4.18.1`) | 4.17.21 is the universally-deployed CJS-friendly version with ~30M weekly downloads — the version every npm lockfile in the world currently resolves to, and what `#508`'s import-intercept hook will most often see in user code. 4.18.1 is a recent publish with identical modular layout for the six target bindings but vastly less production deployment. Atom merkle roots reflecting 4.17.21 are more useful than ones reflecting 4.18.1 for the registry's intended use case. |
| `DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001` | Vendor a TRIMMED 148-file subset of `lodash-4.17.21` published tarball | Same rationale as Slice 5 (`DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001`) extended to lodash: full tarball is 1.4MB across 1054 files, 95% of which are not transitively reachable from the six headline subgraphs. Trimmed vendor retains the 148 `.js` files measured via BFS in `tmp/wi-510-s7/union.js` plus `package.json` + `LICENSE`. Trimmed size ~120KB. Smaller than every existing fixture (validator 487KB, semver 186KB, uuid 415KB) by ~40%. Excluded: `lodash.js` (UMD bundle, never traversed), `core.js`, `core.min.js`, `lodash.min.js`, `fp/`, the ~480 other public bindings, the ~330 transitive helpers used only by them. |
| `DEC-WI510-S7-ENGINE-GAPS-NOT-EXERCISED-001` | Slice 7 does NOT exercise engine gaps #576 (arrow-in-class-body) or #585 (UMD IIFE) | The 148-file Slice 7 union subgraph contains ZERO class declarations and ZERO UMD patterns (verified by `tmp/wi-510-s7/union.js` static scan). #576's class-arrow gap is structurally not exercised because lodash modular files use pure function declarations, never classes. #585's UMD gap is structurally not exercised because the modular files are NOT UMD-wrapped (the UMD bundle is `lodash.js`, explicitly excluded from Slice 7 per `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001`). The parent plan's "largest call graph" risk anticipated multiple engine-gap surfacings; the modular-path decision dissolves both anticipated risks. Slice 7's primary risk is wall-clock (cloneDeep at 108 modules), not engine-gap. |
| `DEC-WI510-S7-EXTERNAL-SPECIFIERS-EMPTY-001` | Expected `externalSpecifiers = []` and `stubCount = 0` across all six headline shaves | The 148-file union subgraph has no top-level external `require('<bare>')` calls visible to `extractRequireSpecifiers`. The one external-looking reference (`freeModule.require('util')` in `_nodeUtil.js`) is a property-access call whose callee is `freeModule.require`, not the bare `Identifier` named `require` — the extractor (lines 325-358 of `module-resolver.ts`) walks `CallExpression` nodes whose callee is `SyntaxKind.Identifier` named `require` AND skips property-access callees by design. Verified by reading the extractor source. The slice's externalSpecifiers should be empty; if non-empty, that is a stop-and-report event (engine behavior change or a require pattern the static survey missed). |

These DECs are recorded in `@decision` annotation blocks at the Slice 7 modification points (primarily the test file; the `PROVENANCE.md` cites the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| `cloneDeep`'s 108-module BFS approaches or exceeds the 120 s per-`it()` budget. | The §3.7 measured count is the upper-bound static survey; the actual engine may decompose faster (most modules are 10-50 lines and structurally simple). Per-`it()` `{ timeout: 120_000 }` override gives 120 s. If `cloneDeep` exceeds 120 s, the implementer files an engine performance concern as a separate issue (not a Slice 7 acceptance failure to mask) and stops. The slice does NOT raise `vitest.config.ts` defaults — §5.3 invariant. |
| The 148-file vendored trim misses a transitive `_<helper>` edge the static survey couldn't see (e.g. a `require()` inside a conditional branch the regex didn't traverse). | The BFS in `tmp/wi-510-s7/bfs.js` follows the same regex-based extraction the engine uses; the union scan in `tmp/wi-510-s7/union.js` covers all six headlines. If the implementer's runtime BFS surfaces a missed edge, the test fails loudly (the engine reports an unresolvable edge for the missing file). The implementer re-runs the BFS verification script, expands the trimmed manifest as needed, and updates the §4 manifest list. The fix is NOT to vendor the whole tarball — the trimmed-vendor decision stands. |
| `freeModule.require('util')` in `_nodeUtil.js` is somehow picked up by the extractor (extractor behavior changed since Slice 5/6, OR my reading of the extractor source is wrong) — `externalSpecifiers` is non-empty for `cloneDeep` and `merge`. | The §5.6 criterion 12 makes this explicit: if `externalSpecifiers` is non-empty for any of the six shaves, that is a stop-and-report event. The implementer documents the surfaced specifier and either (a) files a Slice 1 engine bug claiming the extractor regressed (if the extractor is in fact picking up property-access requires now), OR (b) updates the §5.2 / §5.6 expectations with an empirical citation comment. The slice does NOT silently allow a spurious external specifier. |
| The `combinedScore >= 0.70` quality gate under-scores on a binding because the embedded source mentions too many adjacent concepts (`cloneDeep`'s 108-module subgraph includes Set/Map/Buffer/DataView/Symbol type-detection code that dilutes the "deep-clone" signal). | Same mitigation as Slices 2-6 §9. The `withSemanticIntentCard` helper takes an explicit `behaviorText` that mirrors the corpus query string. The implementer extends `semanticHints` with domain-specific keyword phrases ("recursive deep copy", "preserves Date / RegExp / Map / Set semantics", "returns independent value with no shared references"). Reviewer escalates only if even with semantic hints the score stays <0.70 — that is a genuine quality finding, not a Slice 7 design failure. |
| `debounce` and `throttle` produce nearly-identical atom merkle roots (throttle's subgraph is debounce's superset + `throttle.js`); the registry layer's idempotency may surprise the test if it deduplicates more aggressively than expected. | The registry idempotency is at the leaf-atom level (`canonicalAstHash`), not the forest level. Both shaves produce distinct *entry-atom* merkle roots (`debounce.js`'s atom hash != `throttle.js`'s atom hash because the source files differ). The 14 shared transitive atoms produce 14 byte-identical leaf-atom hashes (the deduplication target). §5.6 criterion 14 makes the expected shared-leaf-atom count explicit; the reviewer verifies the dedup behavior on the real path. |
| Implementer reaches for `void (async () => {...})()` IIFE pattern in test orchestration and hits the VoidExpression atomization gap from PR #566. | §5.5 forbids `void (async () => {...})()` patterns explicitly. All test orchestration uses plain `await`-in-`async`-`it()`. |
| Implementer skips `biome format --write` before committing → local turbo cache hides format violations → CI fails on the PR. | §5.5 explicitly requires `pnpm biome format --write` on the new test file before staging. |
| The six `corpus.json` entries fail the `discovery-eval-full-corpus.test.ts` per-category invariants (≥8-per-category, positive+negative balance). | `cat1` is well-populated. After Slices 1-6 land, cat1 has comfortably more than 8 entries; appending 6 more puts it at ~40. The ≥8 invariant is comfortably satisfied. Positive+negative balance applies to entries with `expectedAtom` — since all six new entries have `expectedAtom: null` (`synthetic-tasks`), they are neither positive nor negative for that balance check (consistent with Slices 2-6). |
| The vendored fixture inadvertently includes the 17,000-line `lodash.js` UMD bundle (or a future implementer mistakenly drops `entryPath` and shaves it). | §4 trimmed manifest explicitly excludes `lodash.js`. §5.5 forbids the no-`entryPath` shave. If a future Slice 7b extends to bundled-lodash, it does so as a separate slice with its own DEC and its own engine-gap risk analysis (analogous to Slice 6's bcryptjs treatment, scaled up). |
| Vendoring 148 files by hand is error-prone (typos, missed files, included excluded files). | §4 plan section explicitly recommends a deterministic copy script (Node one-liner that reads the §4 manifest list verbatim). The implementer SHOULD re-run `tmp/wi-510-s7/union.js` against the extracted tarball at acquisition time to verify the trimmed list matches the planner's expectation; if any difference, investigate before proceeding. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **The other ~480 lodash bindings** (`chunk`, `compact`, `flatten`, `pick`, `omit`, `map`, `filter`, `reduce`, …). Out of scope. A future production-corpus initiative may add them in tranches.
- **The bundled `lodash.js` UMD as a single-module package atom.** Out of scope per `DEC-WI510-S7-MODULAR-NOT-BUNDLED-001`. A future slice (analogous to Slice 6's bcryptjs treatment, scaled up) may add it.
- **`lodash-es`** (the ESM-only variant). The shave engine processes CJS via `require()`; the ESM-only variant would need engine work for ES module `import` resolution. Out of scope.
- **The `fp/` subdirectory** (auto-curried functional-programming wrappers). Out of scope.
- **A whole-package shave path.** Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Engine frozen after Slice 1.
- **Slices 8, 9 graduated fixtures** (zod/joi, p-limit+p-throttle). Out of scope.
- **`vitest.config.ts` adjustments.** Forbidden touch point.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 7 produces the headline-binding atoms in the corpus.
- **The B10 bench (`#512`).** Separate WI; lodash atoms are corpus completeness, not the demo path.
- **The shave engine's ArrowFunction-in-class-body gap (#576).** Not exercised by Slice 7 (§1.3, `DEC-WI510-S7-ENGINE-GAPS-NOT-EXERCISED-001`).
- **The shave engine's UMD IIFE atomization gap (#585).** Not exercised by Slice 7 (§1.3, `DEC-WI510-S7-ENGINE-GAPS-NOT-EXERCISED-001`).

---

*End of Slice 7 plan — per-entry shave of six modular `lodash@4.17.21` headline bindings (`cloneDeep`, `debounce`, `throttle`, `get`, `set`, `merge`) per #510 Slice 7 of 9.*
