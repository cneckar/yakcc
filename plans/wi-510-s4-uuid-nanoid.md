# WI-510 Slice 4 — Per-Entry Shave of `uuid` (v4, validate, v7) + `nanoid` Headline Bindings

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 4 of [#510](https://github.com/cneckar/yakcc/issues/510). Slice 1 (engine, PR #526, `37ec862`), Slice 2 (validator, PR #544, `aeec068`), and Slice 3 (semver, PR #570, `b83d46f`) are landed on `main`.
**Branch:** `feature/wi-510-s4-uuid-nanoid`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s4-uuid-nanoid`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s4-uuid-nanoid`)
**Parent docs (on `main`):** `plans/wi-510-shadow-npm-corpus.md` (the reframed #510 engine plan), `plans/wi-510-s2-headline-bindings.md` (Slice 2 template), `plans/wi-510-s3-semver-bindings.md` (Slice 3 template — the immediate structural sibling).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slices 1, 2, 3 recorded their `DEC-WI510-*` entries).

---

## 1. What changed — why Slice 4 exists

Slices 1-3 proved the dependency-following shave engine on `ms`, then `validator` (real-headline Babel-CJS), then `semver` (plain CJS + real-world circular import). Slice 4 advances one rung up the §5 graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md` and covers **two packages at once**:

> *Slice 4 — uuid + nanoid (identifiers; introduces honest effect declaration on the forest)*

Both `uuid` and `nanoid` are identifier-generation primitives, both have zero npm runtime dependencies, and both have small, well-defined headline behaviors. The two are paired in the master plan slice ordering (line 113) because:

1. They share a single conceptual domain (identifier generation).
2. `nanoid`'s primary entry is a tiny 2-module subgraph; alone it would not be a meaningful slice. Coupling with `uuid` produces a balanced slice (4 headline atoms total: 3 from `uuid`, 1 from `nanoid`).
3. Both packages exercise the **node:crypto B-scope-external edge** — the engine has not previously been confronted with a `require('crypto')` builtin module reference in a vendored fixture. (`validator` used pure JS; `semver` had zero external requires.) `crypto` is a Node builtin, not an npm package; the engine must treat it as a `ForeignLeafEntry` (B-scope external) — same handling as an npm dep, just with a builtin name. Slice 4 is the first real-world corroboration that this works.

The four headlines per #510's issue body (and Slice 4's deliverables):

| Issue-body name | Package | Resolution | Notes |
|---|---|---|---|
| `v4-generate` | uuid | `dist/cjs/v4.js` | npm's `v4` IS the v4-generate function (`module.exports.default = v4`). |
| `v4-validate` | uuid | `dist/cjs/validate.js` | npm's `validate(uuid)` validates ANY UUID (regex `[1-8]` covers v1-v8 plus NIL/MAX). It is not v4-specific — see §1.1 below. |
| `v7-generate` | uuid | `dist/cjs/v7.js` | npm's `v7` IS the v7-generate function. |
| (single primary export) | nanoid | `index.cjs` | nanoid@3's main entry exports `{ nanoid, customAlphabet, customRandom, urlAlphabet, random }`. The headline behavior is `nanoid()` itself — generate a URL-friendly secure random ID. |

### 1.1 Binding-name resolution (operator-decision boundaries closed)

**`v4-generate` → `v4`.** npm's `uuid` package exports a function literally named `v4`, not `v4Generate`. The issue body's `v4-generate` is the natural-language description of what `v4()` does (generate a v4 UUID). The corpus query string and intent card behavior text describe the behavior in prose; the shaved atom is the engine's output for `functions/v4.js`. **Documented in `DEC-WI510-S4-UUID-BINDING-NAMES-001` (§8).**

**`v4-validate` → `validate`.** uuid's `validate(uuid)` returns `typeof uuid === 'string' && regex.test(uuid)` where `regex` matches `[1-8][0-9a-f]{3}-[89ab][...]` plus NIL and MAX (`dist/cjs/regex.js`). The regex's version-nibble class `[1-8]` accepts v1-v8 UUIDs, not just v4 — there is no `validate-v4`-specific function in uuid. The issue body's `v4-validate` is interpreted as "validate that a string is a valid UUID (any version), which trivially covers v4." Two consistent paths:

- **Path A (chosen):** Honor the issue-body intent. Map `v4-validate` → `dist/cjs/validate.js` (the only validation entry uuid ships). Corpus query phrases it as "Validate a v4 UUID string". This accepts the imprecise mapping for the same pragmatic reason Slice 3 chose `parse()` for "parse-component" — pick the entry that mostly matches the issue intent and document the imprecision.
- **Path B (rejected):** Demand a v4-specific validator. uuid does not ship one; we would have to either (1) skip the binding, leaving the issue body underdelivered, or (2) hand-author a v4-narrowing wrapper, which is a Sacred-Practice-12 violation (engine output is the only allowed atom source).

Path A is chosen because hand-authoring is forbidden and skipping under-delivers. **Documented in `DEC-WI510-S4-UUID-BINDING-NAMES-001` (§8).** A separate follow-on issue may extend the engine or the fixture set with a v4-specific validator if a future caller needs strict v4-only validation.

**`v7-generate` → `v7`.** Same rationale as `v4-generate`. uuid exports `v7` as the v7-generate function.

**`nanoid` primary export → `nanoid()`.** nanoid@3's `index.cjs` exports five primitives via `module.exports = { nanoid, customAlphabet, customRandom, urlAlphabet, random }`. The package's headline behavior — the one the package's README leads with and that drives 95%+ of usage — is `nanoid()`: "generate a 21-character URL-friendly secure random string." The corpus query and the §F semantic intent card describe that behavior. The full `index.cjs` subgraph is what the shave produces; the headline atom is the entry-module atom. **Documented in `DEC-WI510-S4-NANOID-PRIMARY-EXPORT-001` (§8).** A later slice could split `customAlphabet` / `nanoid` into separate per-entry shaves; for Slice 4, the single primary entry-point shave is sufficient — there is only one `.cjs` file in the primary subgraph, so per-entry decomposition does not gain granularity over per-package decomposition for nanoid.

### 1.2 Version pins

**uuid: `11.1.1`.**

- `uuid@latest` is `14.0.0` as of 2026-05-16, but `14.0.0` is `"type": "module"` ESM-only — it ships no `dist/cjs/` tree. The vendored fixtures in Slices 1-3 are all CJS (`ms-2.1.3`, `validator-13.15.35`, `semver-7.8.0`). The shave engine DOES handle ESM `import` declarations (`module-resolver.ts:extractImportSpecifiers`), so an ESM-only vendor is technically possible — but Slice 4 should not be the slice that pioneers ESM-vendored fixtures. ESM has its own complications (`exports` field with `import` conditions, `.mjs` extensions, top-level `await`) that deserve their own slice if and when the corpus demands it.
- `uuid@11.1.1` is `legacy-11` (still actively supported per npm dist-tags), is the most recent CJS-shipping line, and uses `package.json#exports` with the canonical `{ node: { require: "./dist/cjs/index.js", import: "./dist/esm/index.js" } }` conditional map. The shave engine's `resolveExportValue` prioritizes `node → require → import → default`, so it resolves the `require` path correctly for the package-level entry, AND we can point `entryPath` directly at `dist/cjs/<binding>.js` files to bypass `exports` resolution entirely.
- `uuid@11.1.1` has zero runtime npm dependencies (verified via `npm view uuid@11.1.1 dependencies`). The only external edge is `require('crypto')` — Node builtin, B-scope-external — see §3 below.

**Documented in `DEC-WI510-S4-UUID-VERSION-PIN-001` (§8).** A follow-on initiative may add an ESM-vendored uuid@14 fixture once the corpus demands ESM stress-testing.

**nanoid: `3.3.12`.**

- `nanoid@latest` is `5.1.11` as of 2026-05-16, but nanoid@5 is `"type": "module"` ESM-only — same problem as uuid@14. The CJS-shipping line is nanoid@3.x.
- `nanoid@3.3.12` is the head of the 3.x line (verified via `npm view nanoid versions`). It uses a dual `.js` (ESM) + `.cjs` (CJS) layout with `package.json#exports` carrying `{ require: { default: "./index.cjs" }, import: { default: "./index.js" } }`. The shave engine's resolver picks `require` first, landing on `index.cjs` for the package-level entry — and we point `entryPath` directly at `index.cjs` to skip resolution entirely.
- nanoid@3.x has zero runtime npm dependencies (verified for `nanoid@3.3.12`; note that one historical version `3.1.26` briefly depended on `nanocolors` but that was reverted). The only external edge is `require('crypto')` — same B-scope-external case as uuid.

**Documented in `DEC-WI510-S4-NANOID-VERSION-PIN-001` (§8).**

---

## 2. Path A confirmed (again) — no engine change needed

The engine pattern is settled across Slices 1-3. `shavePackage({ packageRoot, entryPath })` accepts an explicit per-entry override; `isInPackageBoundary()` scopes the BFS to the package's own directory; `extractRequireSpecifiers` walks CJS `require(<string>)` calls; `extractImportSpecifiers` walks ESM `ImportDeclaration` nodes; external edges (npm deps OR Node builtins like `crypto`) become `ForeignLeafEntry` records. No engine source change. No new public-API surface. No `ShavePackageOptions` shape change. Slice 4 is a **pure fixture-and-test slice**; gate is **`review`** (matches Slices 2 and 3).

The single new property Slice 4 exercises — the `require('crypto')` Node-builtin external edge — is handled by the existing B-scope predicate. `isInPackageBoundary` returns false for a resolved path that isn't under `packageRoot/`; for an unresolvable specifier like `'crypto'` (a Node builtin, not on disk), the resolver returns the "unresolvable" signal and the slicer emits a `ForeignLeafEntry`. This is the **best-effort degradation discipline** Slice 1 already proved with the `degradation-pkg/` fixture. Slice 4 corroborates it on real-world npm sources.

---

## 3. Per-entry subgraph size estimates (read from extracted source)

Estimates read directly from the vendored tarballs (`tmp/wi-510-s4/uuid-11/package/` and `tmp/wi-510-s4/nanoid-3/package/`). Each estimate counts in-package `require('./...')` and `require('../...')` specifiers transitively. External edges (`require('crypto')`) are NOT in-package and become `ForeignLeafEntry` records — they do NOT count toward `moduleCount` but they DO count toward `stubCount`.

### 3.1 `uuid/dist/cjs/v4.js` (v4-generate)

Direct requires: `./native.js`, `./rng.js`, `./stringify.js`.

Transitive:
- `native.js` → `require('crypto')` (external, becomes a stub).
- `rng.js` → `require('crypto')` (external, becomes a stub; same crypto reference, deduped at the resolver level — both point at the same unresolvable Node-builtin specifier).
- `stringify.js` → `./validate.js`.
- `validate.js` → `./regex.js`.
- `regex.js` → leaf (no requires).

**Unique in-package module set:** `v4.js`, `native.js`, `rng.js`, `stringify.js`, `validate.js`, `regex.js` = **6 modules**.

**External stubs:** `crypto` (once — referenced twice via `native.js` and `rng.js`, but it's the same specifier; the engine's existing dedup behavior should produce one `ForeignLeafEntry`). **Expected `stubCount = 1`** (the `crypto` Node builtin). This is **NEW** — Slices 1-3 all had `stubCount = 0`. Slice 4 is the first to assert `stubCount > 0` on a real-world fixture.

**Range guidance for §A assertion:** `moduleCount in [4, 9]`, `stubCount in [1, 2]` (width allows for `crypto` being counted once per importer site if the dedup doesn't fire — the upper bound 2 is the worst case; the expected value is 1).

### 3.2 `uuid/dist/cjs/validate.js` (v4-validate / validate-any)

Direct requires: `./regex.js`.

Transitive:
- `regex.js` → leaf.

**Unique in-package module set:** `validate.js`, `regex.js` = **2 modules**.

**External stubs:** 0 (no `crypto` reference in this subgraph).

**Range guidance for §A:** `moduleCount in [2, 4]`, `stubCount = 0`.

### 3.3 `uuid/dist/cjs/v7.js` (v7-generate)

Direct requires: `./rng.js`, `./stringify.js`.

Transitive:
- `rng.js` → `require('crypto')` (external stub).
- `stringify.js` → `./validate.js`.
- `validate.js` → `./regex.js`.
- `regex.js` → leaf.

**Unique in-package module set:** `v7.js`, `rng.js`, `stringify.js`, `validate.js`, `regex.js` = **5 modules**.

**External stubs:** `crypto` (1).

**Range guidance for §A:** `moduleCount in [3, 7]`, `stubCount in [1, 2]`.

### 3.4 `nanoid/index.cjs` (nanoid primary export)

Direct requires: `crypto` (external), `./url-alphabet/index.cjs`.

Transitive:
- `url-alphabet/index.cjs` → leaf (no requires).

**Unique in-package module set:** `index.cjs`, `url-alphabet/index.cjs` = **2 modules**.

**External stubs:** `crypto` (1).

**Range guidance for §A:** `moduleCount in [2, 4]`, `stubCount in [1, 2]`.

### 3.5 Aggregate footprint and expected wall-clock

Total module-decompositions across all four §A–§E tests: ~6 + 2 + 5 + 2 = **~15 decompositions**. This is meaningfully smaller than Slice 3's ~40 (semver) and Slice 2's ~30 (validator). Slice 4's per-headline subgraphs are the smallest of the four landed/planned slices.

Slice 3 measured `satisfies` (18 modules) well under the 120 s per-`it()` ceiling. The largest Slice 4 subgraph is `v4` at 6 modules — should run in seconds.

**Per-headline test budget: <120 s per headline (the Slice 2 ceiling); typical <10 s.** **Cumulative §A–§E budget: <5 minutes.** **§F cumulative (with `DISCOVERY_EVAL_PROVIDER=local`): <8 minutes.** Any binding exceeding 120 s is a **stop-and-report** event, same as Slices 2 and 3.

### 3.6 Stub-count expectation — the new B-scope-external property

For the first time in the WI-510 graduated fixtures, Slice 4 asserts **`stubCount > 0`** on §A and §C tests. Specifically:

- `v4` subgraph: `stubCount in [1, 2]` (expected 1 — the `crypto` Node builtin).
- `validate` subgraph: `stubCount = 0` (no crypto reference).
- `v7` subgraph: `stubCount in [1, 2]` (expected 1).
- `nanoid` subgraph: `stubCount in [1, 2]` (expected 1).

This is the first real-world test of the engine's foreign-leaf emission for **Node builtins** (not npm packages). The shave engine's `extractRequireSpecifiers` doesn't distinguish builtins from npm packages — both are non-relative specifiers. The resolver tries to resolve `'crypto'` via `package.json` lookup, fails to find it, returns the "unresolvable" signal, and the slicer emits a `ForeignLeafEntry`. The §C tests verify the stub points at `crypto` specifically (the `ForeignLeafEntry`'s specifier field). **Documented in `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001` (§8).**

If `stubCount = 0` on §A for `v4`, `v7`, or `nanoid`, that is a **stop-and-report engine-gap finding** — it means the resolver silently dropped the `crypto` edge instead of emitting a foreign leaf, which would be a Slice 1 bug.

---

## 4. Fixture shape — vendored tarballs, mirroring Slices 2 and 3

**Decision: vendor the full `uuid-11.1.1` and `nanoid-3.3.12` published tarballs verbatim.** Same rationale chain Slice 3 documented in `DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`:

1. Honesty about what `node_modules` contains.
2. `isInPackageBoundary` scopes traversal — unreferenced files (e.g., uuid's `bin/uuid-bin.js`, `dist/esm/`, `dist/esm-browser/`, `dist/cjs-browser/`) exist on disk at zero traversal cost.
3. Trimming duplicates maintenance burden.
4. Operator constraint respected (vendor published tarball, not source).

**Fixture acquisition path (already done in `tmp/wi-510-s4/` by the planner; the implementer re-runs for fresh known-good copies):**

- `npm pack uuid@11.1.1` → `uuid-11.1.1.tgz` (SHA1 `f6d81d2e1c65d00762e5e29b16c5d2d995e208ad`, integrity `sha512-vIYxrBCC/N/K+Js3qSN88go7kIfNPssr/hHCesKCQNAjmgvYS2oqr69kIufEG+O4+PfezOH4EbIeHCfFov8ZgQ==`)
- `npm pack nanoid@3.3.12` → `nanoid-3.3.12.tgz` (SHA1 `ab3d912e217a6d0a514f00a72a16543a28982c05`, integrity `sha512-ZB9RH/39qpq5Vu6Y+NmUaFhQR6pp+M2Xt76XBnEwDaGcVAqhlvxrl3B2bKS5D3NH3QR76v3aSrKaF/Kiy7lEtQ==`)
- Extract → `package/` directory → copy contents into `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/` and `nanoid-3.3.12/` respectively.
- Author one `PROVENANCE.md` per fixture (templates in §4.1, §4.2).

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified by Slices 1-3). The `.js` and `.cjs` files are outside `tsc`'s scope (`tsconfig.base.json` does not set `allowJs`/`checkJs`).

### 4.1 `PROVENANCE.md` template — uuid

```
# Provenance — uuid@11.1.1 fixture

- **Package:** uuid
- **Version:** 11.1.1 (latest `legacy-11` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack uuid@11.1.1`)
- **Tarball SHA1:** f6d81d2e1c65d00762e5e29b16c5d2d995e208ad
- **Tarball integrity:** sha512-vIYxrBCC/N/K+Js3qSN88go7kIfNPssr/hHCesKCQNAjmgvYS2oqr69kIufEG+O4+PfezOH4EbIeHCfFov8ZgQ==
- **Retrieved:** 2026-05-16
- **Contents:** ~73 files. dist/ tree carries cjs/, cjs-browser/, esm/, esm-browser/
  variants of every module plus .d.ts files. package.json#main → "./dist/cjs/index.js".
- **Shape:** TypeScript-compiled CJS (`"use strict"; Object.defineProperty(exports, "__esModule", ...)`).
  Every relative `require()` uses an explicit `.js` extension (e.g. `require("./rng.js")`).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges:** `require('crypto')` (Node builtin — B-scope external, emitted as ForeignLeafEntry).
- **Headline behaviors (this slice):** `v4`, `validate`, `v7` (mapping issue-body
  "v4-generate", "v4-validate", "v7-generate" per DEC-WI510-S4-UUID-BINDING-NAMES-001).
- **Path decision:** Path A (published CJS tarball) — inherits Slice 3
  DEC-WI510-S3-FIXTURE-FULL-TARBALL-001. uuid@14 is ESM-only (DEC-WI510-S4-UUID-VERSION-PIN-001).
- **Why pin 11.1.1:** ESM-only uuid@14 would be the first ESM-vendored fixture in
  the corpus, a deliberately deferred concern. 11.1.1 is the head of the still-supported
  legacy-11 CJS line. Zero runtime npm dependencies (verified `npm view uuid@11.1.1 dependencies`).
- **WI:** WI-510 Slice 4, workflow `wi-510-s4-uuid-nanoid`.
```

### 4.2 `PROVENANCE.md` template — nanoid

```
# Provenance — nanoid@3.3.12 fixture

- **Package:** nanoid
- **Version:** 3.3.12 (head of `3.x` line as of 2026-05-16; `nanoid@latest` is 5.1.11 ESM-only)
- **Source:** npm tarball (`npm pack nanoid@3.3.12`)
- **Tarball SHA1:** ab3d912e217a6d0a514f00a72a16543a28982c05
- **Tarball integrity:** sha512-ZB9RH/39qpq5Vu6Y+NmUaFhQR6pp+M2Xt76XBnEwDaGcVAqhlvxrl3B2bKS5D3NH3QR76v3aSrKaF/Kiy7lEtQ==
- **Retrieved:** 2026-05-16
- **Contents:** ~26 files. Dual ESM + CJS layout: every entry ships both .js (ESM)
  and .cjs (CJS) variants. package.json#main → "index.cjs". package.json#exports
  ".require.default" → "./index.cjs". Sub-paths: "./async", "./non-secure", "./url-alphabet".
- **Shape:** Hand-written ES2017 CJS (`let crypto = require('crypto')`, `module.exports = { ... }`).
  No "use strict" pragma, no Babel/tsc boilerplate. Cleaner than uuid's compiled CJS.
- **Runtime dependencies:** none. (One historical version, 3.1.26, briefly depended on
  nanocolors; reverted by 3.1.27. 3.3.12 has no dependencies — verified `npm view nanoid@3.3.12 dependencies`.)
- **External edges:** `require('crypto')` (Node builtin — B-scope external, emitted as ForeignLeafEntry).
- **Headline behaviors (this slice):** `nanoid` (the primary export; the package's
  README headline behavior). Other primitives (`customAlphabet`, `customRandom`,
  `urlAlphabet`, `random`) are co-exported from the same `index.cjs` but are not
  separately addressable as per-entry shaves because they share the same entry file.
- **Path decision:** Path A (published CJS tarball) — same as Slice 3 fixture.
- **Why pin 3.3.12:** ESM-only nanoid@5.x is the first-ESM-fixture deferral
  (DEC-WI510-S4-NANOID-VERSION-PIN-001). 3.x is the last CJS-shipping line, still
  widely installed via npm.
- **WI:** WI-510 Slice 4, workflow `wi-510-s4-uuid-nanoid`.
```

---

## 5. Evaluation Contract — Slice 4 (per-entry shave of `uuid` v4/validate/v7 + `nanoid`)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1), `validator-headline-bindings.test.ts` (Slice 2), and `semver-headline-bindings.test.ts` (Slice 3) **with zero regressions**, plus the new per-entry uuid + nanoid headline tests.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **Workspace-wide `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`)** — clean across all packages. Carry-over from Slices 2-3; `--filter`-scoped passing is necessary but not sufficient.
- **Per-entry headline tests** — TWO new test files:
  - `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — three `describe` blocks (`v4`, `validate`, `v7`), each with sections A–F. Plus a compound interaction test at the end (real production sequence).
  - `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — one `describe` block (`nanoid`), sections A–F. Plus a compound interaction test at the end.
  - Each `describe` is independent (no shared `beforeAll` across bindings) — Slice 2 / Slice 3 per-entry isolation invariant carries forward.
- **Compound interaction tests** — at least one test per package exercising the real production sequence `shavePackage → collectForestSlicePlans → maybePersistNovelGlueAtom` end-to-end, mirroring the Slice 3 pattern. This is the load-bearing "real-path" check, not a unit-mocked one.

### 5.2 Required real-path checks

- **Per-headline real-path forest:** for each of the four headlines, `shavePackage(<fixture-root>, { registry, entryPath: <fixture-root>/<binding-path> })` produces a `ModuleForest` whose `moduleCount` falls inside the §3 range for that binding:
  - uuid `v4`: `moduleCount in [4, 9]`, `stubCount in [1, 2]`.
  - uuid `validate`: `moduleCount in [2, 4]`, `stubCount = 0`.
  - uuid `v7`: `moduleCount in [3, 7]`, `stubCount in [1, 2]`.
  - nanoid `nanoid`: `moduleCount in [2, 4]`, `stubCount in [1, 2]`.
  - The reviewer inspects `forest.nodes` and `forestStubs(forest)` to confirm `forest.nodes[0].filePath` ends in the expected entry file and that any stub points at `crypto` (the Node builtin specifier).
- **`crypto` foreign-leaf emission proven:** for `v4`, `v7`, and `nanoid`, the §C tests explicitly assert that `forestStubs(forest)` is non-empty AND that at least one stub has its specifier (or filePath proxy) referencing `crypto`. This is the first real-world Node-builtin foreign-leaf assertion in the WI-510 fixture suite. **§5.6 criterion 12 is the explicit Slice 4 acceptance gate for this property.**
- **`combinedScore >= 0.70`** for each of the four headline behaviors (§F), measured via `findCandidatesByQuery` against an in-memory registry populated by the engine's own real-path `storeBlock` output. Each test uses `withSemanticIntentCard` (the Slice 2 helper, carried forward verbatim in Slice 3) with a behaviorText that mirrors each binding's `corpus.json` query string. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, **the slice is blocked, not ready** — reviewer must run with the local provider and paste the four scores.
- **Two-pass byte-identical determinism per headline:** for each of the four headlines, `shavePackage` is invoked twice with the same `entryPath`; `moduleCount`, `stubCount`, `forestTotalLeafCount`, BFS-ordered `filePath` list, AND the sorted set of every leaf `canonicalAstHash` are byte-identical across passes (per-headline, not aggregated — same property Slices 2 and 3 assert).
- **Forest persisted via the real `storeBlock` path per headline:** for each headline, the slice plans from `collectForestSlicePlans` are iterated and each `NovelGlueEntry` flows through `maybePersistNovelGlueAtom`, not a `buildTriplet`-on-entry-source shortcut. Registry has `> 0` blocks after each headline's persist; the headline atom is retrievable. (Carry-over from Slices 2 and 3.)

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 4 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **No engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** No new public API surface in `packages/shave/src/types.ts`.
- **B-scope predicate untouched and corroborated.** `isInPackageBoundary` is unchanged. The `crypto` Node-builtin edge is correctly treated as B-scope external because it does not resolve to any path under the fixture root. Slice 4 must not introduce a parallel "is this a Node builtin?" check.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives.
- **Public `types.ts` surface frozen-for-L5.** No public-surface change.
- **`corpus.json` is append-only.** Slice 4 appends four new `synthetic-tasks` entries (`cat1-uuid-v4-001`, `cat1-uuid-validate-001`, `cat1-uuid-v7-001`, `cat1-nanoid-001`). No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change.
- **Fixture isolation.** The vendored sources live ONLY under `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/` and `nanoid-3.3.12/`. Biome-ignored, outside `tsc`'s `.js` scope.
- **Per-entry isolation guarantee.** Each of the four headline bindings is shaved by its own `shavePackage` call with its own `entryPath`. No shared `beforeAll` across bindings.
- **Predecessor fixtures untouched.** `validator-13.15.35/**`, `semver-7.8.0/**`, `ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` are read-only for Slice 4. Reviewer can spot-check with `git diff main -- packages/shave/src/__fixtures__/module-graph/{validator-13.15.35,semver-7.8.0,ms-2.1.3,circular-pkg,degradation-pkg,three-module-pkg}/` showing no changes.
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. The Slice 2 invariant `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` carries forward.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — vendored uuid tarball + `PROVENANCE.md`. Required.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — vendored nanoid tarball + `PROVENANCE.md`. Required.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — new Slice 4 test file (three headline `describe` blocks + compound test). Required.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — new Slice 4 test file (one headline `describe` block + compound test). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append four `synthetic-tasks` entries:
  - `cat1-uuid-v4-001` — query: "Generate a cryptographically random v4 UUID string in RFC 4122 canonical hyphenated form"
  - `cat1-uuid-validate-001` — query: "Validate that a string is a well-formed UUID in canonical hyphenated form"
  - `cat1-uuid-v7-001` — query: "Generate a v7 UUID containing a Unix timestamp with millisecond precision plus random bits"
  - `cat1-nanoid-001` — query: "Generate a 21-character URL-friendly cryptographically secure random unique identifier"
  Append-only. Required.
- `plans/wi-510-s4-uuid-nanoid.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 4 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s4/**` — planner scratch (tarballs + extracted `package/` trees). Implementer may use the same directory for re-acquisition; not part of the commit.

### 5.5 Forbidden shortcuts

- **No whole-package shave.** Calling `shavePackage(<fixture-root>, { registry })` without an `entryPath` override is **forbidden** in Slice 4 — same as Slices 2 and 3. Every `shavePackage` invocation in the new tests must pass an explicit `entryPath` pointing at one of the four headline files.
- **No `vitest.config.ts` timeout raise.** Per-`it()` overrides bounded to 120 s with measurement-citing comments. >120 s = stop-and-report (same as Slices 2-3).
- **No shared `beforeAll` across the four bindings** (per-entry isolation).
- **No engine-source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1. If an engine gap surfaces (most likely class: incorrect handling of `crypto` Node builtin → silent drop instead of foreign-leaf emission), it is filed as a separate bug against the engine and is **not** patched in-slice. Slice 4 stops and reports.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's `combinedScore` and the §5.1 per-headline persist check must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path.
- **No hand-authored `uuid` or `nanoid` atoms.** The four headline atoms are the engine's output from vendored source.
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 4 only appends `synthetic-tasks` rows.
- **No silent `maxModules` truncation.** Each per-entry shave's expected `moduleCount` is tiny (§3, max ~9 for v4). If any headline test sees `moduleCount` approaching `maxModules` (default 500), that indicates a B-scope leak or fixture-vendoring error. Implementer stops and reports. Do not raise `maxModules` to hide the symptom.
- **No non-determinism.** Each per-headline subgraph must be two-pass byte-identical. `readdir`-order / `Map`-iteration / absolute-path leakage in any helper added by Slice 4 is forbidden.
- **No public `types.ts` surface break.**
- **No reach into predecessor fixtures.** `validator-13.15.35/`, `semver-7.8.0/`, `ms-2.1.3/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 4.
- **No new fixture vendoring beyond `uuid-11.1.1` and `nanoid-3.3.12`.** Slices 5-9 (date-fns, jsonwebtoken+bcrypt, lodash, zod/joi, p-limit+p-throttle) remain out of scope.
- **No ESM-vendored uuid@14 or nanoid@5.** Deferred (§1.2). If a follow-on issue wants ESM stress-testing, that is a separate slice.
- **No `void (async () => {...})()` patterns in test files.** Per the Slice 3 lesson learned from PR #566: the shave engine cannot atomize `VoidExpression` of an IIFE. Test orchestration must use plain `await`-in-`async`-`it()`.
- **No skipping `biome format --write` before commit.** Per the Slice 3 lesson learned from PR #570: local turbo cache can hide format violations that CI catches. Run `pnpm biome format --write packages/shave/src/universalize/uuid-headline-bindings.test.ts packages/shave/src/universalize/nanoid-headline-bindings.test.ts` (and any other touched files) before staging.

### 5.6 Ready-for-Guardian definition (Slice 4)

Slice 4 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **Workspace-wide** `pnpm lint` (`turbo run lint`) and `pnpm typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes the output (this was the CI failure pattern on Slice 1's PR; package-scoped passing is necessary but not sufficient).
3. **Per-headline measurement evidence in the PR body and the plan status update**: for each of the four bindings (`uuid/v4`, `uuid/validate`, `uuid/v7`, `nanoid/nanoid`), the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list (so the reviewer can verify the subgraph contains only transitively-reachable modules and no unrelated package behaviors), the **merkle root of the headline binding's atom** (the entry-module's persisted atom root), the **stub specifier list** (the `forestStubs(forest)` output — proving `crypto` is correctly captured as a foreign leaf for v4/v7/nanoid), and the wall-clock time of that headline's `shavePackage` invocation. The §3 estimates are the reviewer's anchor for "does this look right?"
4. Each of the four headline bindings produces a connected `ModuleForest` whose nodes are exactly the headline's transitive in-package subgraph — reviewer confirms via §3 inspection that no unrelated package behavior modules are present.
5. **Each per-headline test completes in <120 seconds wall-clock** with the default vitest config (no `testTimeout`/`hookTimeout` raise). A test exceeding 120 s — even with a per-`it()` override — is a blocking flag, not a passing condition. Cumulative §A–§E wall-clock <5 minutes; cumulative including §F (with `DISCOVERY_EVAL_PROVIDER=local`) <8 minutes. Slice 4's subgraphs are the smallest of any landed slice, so a >120 s headline is a loud red flag.
6. Two-pass byte-identical determinism per headline.
7. `combinedScore >= 0.70` for **each** of the four headline behaviors, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (not skipped)**, reviewer pastes the four per-behavior scores. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the quality block skips, the slice is **blocked, not ready**.
8. Each headline's forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — not the single-source-`buildTriplet` shortcut.
9. `corpus.json` carries exactly the four appended `synthetic-tasks` entries (`expectedAtom: null`), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes.
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Predecessor fixtures untouched.** Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/{validator-13.15.35,semver-7.8.0,ms-2.1.3,circular-pkg,degradation-pkg,three-module-pkg}/` shows no changes.
12. **`crypto` Node-builtin foreign-leaf emission proven on real-world fixtures.** For `v4`, `v7`, and `nanoid` (the three subgraphs that reference `crypto`), reviewer confirms `forestStubs(forest)` contains at least one stub whose specifier is `'crypto'` (or whose recorded filePath/source proxy makes that obvious). This is the load-bearing real-world B-scope-external corroboration the slice exists to deliver beyond pure throughput.
13. New `@decision` annotations are present at the Slice 4 modification points (the two test files; the two `PROVENANCE.md` files cite the DEC IDs in §8). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 4 (per-entry shave of `uuid` + `nanoid`)

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — vendored uuid fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + copy.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — vendored nanoid fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + copy.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — new Slice 4 test file (three `describe` blocks + compound test).
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — new Slice 4 test file (one `describe` block + compound test).
- `packages/registry/test/discovery-benchmark/corpus.json` — append four `synthetic-tasks` headline query entries. Append-only.
- `plans/wi-510-s4-uuid-nanoid.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s4/**` — scratch (tarballs + extracted packages); not committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — the vendored uuid fixture tree (~73 files) + `PROVENANCE.md`.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — the vendored nanoid fixture tree (~26 files) + `PROVENANCE.md`.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — the new uuid test file.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — the new nanoid test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the four `synthetic-tasks` query entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — `testTimeout=30_000` / `hookTimeout=30_000` defaults carry forward `DEC-WI510-S2-NO-TIMEOUT-RAISE-001` verbatim.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1 per master plan §5.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2's test file.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — Slice 3's test file.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1's engine tests.
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — Slice 2 fixture.
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — Slice 3 fixture.
- `packages/shave/src/__fixtures__/module-graph/ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slice 1 fixtures.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**` — used by the test; not modified.
- `packages/shave/src/cache/**`, `packages/shave/src/intent/**` — used by the test (existing `withStubIntentCard` / `withSemanticIntentCard` helpers consume `sourceHash`, `STATIC_MODEL_TAG`, `STATIC_PROMPT_VERSION`); not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`, embedding providers).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 4 produces atoms via the engine; hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**`, `examples/**`, `.worktrees/**` — adjacent lanes (#508, #512, benches) outside Slice 4's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**`; no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.
- All other `plans/*.md` files — Slice 4 owns only `plans/wi-510-s4-uuid-nanoid.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 4 **calls** these with an explicit `entryPath` option per headline; does not fork, modify, or extend them.
- **Module resolver — B-scope predicate** — canonical authority: `isInPackageBoundary()` and `resolveSpecifier()` in `module-resolver.ts`. Slice 4 **exercises** the predicate on the new `crypto` Node-builtin case (first such case in WI-510 fixtures). It does not modify the predicate.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 4 produces four headline-atom-rooted subgraphs.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 4 appends four `synthetic-tasks` entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 4 does not modify; per-entry shave size is tiny (§3 max ~9 modules) so default `testTimeout=30_000` is more than sufficient.
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 4 adds two sibling directories (`uuid-11.1.1/` and `nanoid-3.3.12/`) next to the existing six.

---

## 7. Slicing / dependency position

Slice 4 is a single work item. Dependencies: **Slice 1 (landed `37ec862` on `main`)**, **Slice 2 (landed `aeec068` on `main`)**, and **Slice 3 (landed `b83d46f` on `main`)** for pattern continuity (Slice 4 imports no Slice 2/3 source, but its test files are structurally siblings-by-copy of `semver-headline-bindings.test.ts` and `validator-headline-bindings.test.ts`).

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing uuid+nanoid as Slice 4 is the proximate consumer; the triad (#508, #512) currently focuses on the validator headline bindings — uuid+nanoid atoms are corpus completeness, not the next demo binding.

- **Weight:** **M** (two small-to-tiny fixtures vendored + four small per-entry shaves + test orchestration + first real-world B-scope-external corroboration + measurement-evidence discipline). Lighter than Slice 3 in raw module count (~15 decompositions vs ~40), but slightly more complex in structure because TWO packages are vendored simultaneously and the `crypto` foreign-leaf property is a new assertion class.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S4-PER-ENTRY-SHAVE-001` | Slice 4 shaves uuid v4/validate/v7 + nanoid headline bindings per-entry, not the whole packages | Inherits the structural pattern from Slices 2 and 3. Each of the four bindings is its own `shavePackage({ entryPath })` call producing a 2-9-module subgraph (§3 estimates), comfortable inside the default 30 s `testTimeout`. The four headlines are the bindings #510's issue body names for uuid + nanoid; broader coverage (uuid's other ~10 dist/cjs files, nanoid's `non-secure` / `async` sub-paths) is deferred to a later production-corpus initiative. |
| `DEC-WI510-S4-UUID-BINDING-NAMES-001` | Issue-body "v4-generate" → `v4`, "v4-validate" → `validate`, "v7-generate" → `v7` | npm uuid exports `v4`/`v7` as functions, not `v4Generate`/`v7Generate`. The issue body uses verb-form names for clarity; the actual files are `v4.js`/`v7.js`. uuid's `validate()` validates any UUID version (regex `[1-8]`), not v4-specifically — there is no v4-validator file. We accept the imprecise mapping for the same pragmatic reason Slice 3 mapped "parse-component" → `parse()`. A separate follow-on issue may add a v4-narrowing validator if a future caller needs strict v4-only validation. |
| `DEC-WI510-S4-NANOID-PRIMARY-EXPORT-001` | nanoid primary export resolves to `index.cjs`'s `nanoid()` function | nanoid@3's `index.cjs` exports `{ nanoid, customAlphabet, customRandom, urlAlphabet, random }` via a single `module.exports = { ... }` statement. The headline behavior — the one the README leads with and that drives the package's value proposition — is `nanoid()`. Since all five primitives share the same entry file, per-entry decomposition does not gain granularity over per-package decomposition for nanoid. A later slice may split these into separate per-export shaves if and when the engine grows per-named-export entry resolution. |
| `DEC-WI510-S4-UUID-VERSION-PIN-001` | Pin to `uuid@11.1.1` (latest CJS-shipping line; uuid@14 is ESM-only) | uuid@latest is 14.0.0 as of 2026-05-16 but is `"type": "module"` ESM-only with no `dist/cjs/` tree. ESM-vendored fixtures are a deliberately deferred concern (Slices 1-3 are all CJS); Slice 4 should not pioneer ESM vendoring. uuid@11.1.1 is the head of the still-supported `legacy-11` CJS line, has zero npm dependencies, ships a clean `dist/cjs/` tree, and uses `package.json#exports` with the canonical `node→require` conditional precedence the engine's resolver honors. |
| `DEC-WI510-S4-NANOID-VERSION-PIN-001` | Pin to `nanoid@3.3.12` (latest CJS-shipping line; nanoid@5 is ESM-only) | nanoid@latest is 5.1.11 as of 2026-05-16 but is `"type": "module"` ESM-only. nanoid@3.3.12 is the head of the 3.x line, has zero npm dependencies, ships dual `.js` (ESM) + `.cjs` (CJS) variants with `exports[".require.default"]` pointing at `index.cjs`. The engine's resolver prefers `require` over `import`, landing on the CJS variant naturally. |
| `DEC-WI510-S4-FIXTURE-FULL-TARBALL-001` | Vendor the full `uuid-11.1.1` and `nanoid-3.3.12` published tarballs verbatim | Inherits Slice 3 rationale (`DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`): honest about what `node_modules` contains, lets `isInPackageBoundary` scope traversal at zero cost for unreferenced files (uuid's `dist/esm-browser/`, `dist/cjs-browser/`, `bin/uuid-bin.js`, etc.; nanoid's `async/`, `non-secure/`, `url-alphabet/`, `bin/nanoid.cjs`, `.browser.js` variants), avoids the maintenance burden of hand-trimming. Both fixtures live under `packages/shave/src/__fixtures__/module-graph/` and are biome-ignored. |
| `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001` | uuid/v4, uuid/v7, and nanoid each reference `require('crypto')` — a Node builtin treated as B-scope external (ForeignLeafEntry) | First real-world WI-510 fixture to exercise the engine's foreign-leaf emission on a Node builtin (not an npm package). The resolver fails to resolve `'crypto'` via `package.json` lookup, returns the "unresolvable" signal, and the slicer emits a `ForeignLeafEntry`. §5.6 criterion 12 makes this an explicit Slice 4 acceptance gate. If the engine silently drops the `crypto` edge instead of emitting a foreign leaf, that is a Slice 1 cycle/resolver bug filed as a separate issue — Slice 4 stops and reports. |

These DECs are recorded in `@decision` annotation blocks at the Slice 4 modification points (the two new test files primarily; the two `PROVENANCE.md` files cite the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| The engine silently drops `require('crypto')` instead of emitting a `ForeignLeafEntry` → `stubCount = 0` on `v4`/`v7`/`nanoid` → the §5.6 criterion 12 check fails. | §5.6 criterion 12 makes this an explicit acceptance gate. If observed, file a Slice 1 engine bug ("module-resolver silently drops unresolvable specifiers instead of emitting foreign leaves") and **do NOT patch the engine in Slice 4**. The slice stops and reports. The most likely failure mode is the resolver's "unresolvable" branch returning `undefined` to the slicer without a ForeignLeafEntry construction — verify in `module-resolver.ts:resolveSpecifier()` and `module-graph.ts:enqueueImports()` before filing. |
| The `crypto` reference appears twice (once in `v4` subgraph via both `native.js` and `rng.js`) but is counted as two separate stubs instead of one (no dedup). | §5.2 range guidance allows `stubCount in [1, 2]` for v4 / v7 / nanoid. Either outcome (deduped to 1, or duplicated to 2) is acceptable as long as the foreign-leaf property holds. Reviewer notes the actual value in measurement evidence. The engine's existing dedup behavior is by `canonicalAstHash` for atoms; for foreign leaves, dedup is by specifier — which would yield 1 for `'crypto'` referenced twice. If the actual value is 2, that surfaces a possibly-intentional behavior (per-importer stub records), which is fine for now but flagged in measurement evidence for a future engine-tightening issue. |
| nanoid's `index.cjs` has only 2 modules total (`index.cjs` + `url-alphabet/index.cjs`) — combinedScore may fall short of 0.70 because the engine-derived intent text from a tiny module is too terse to embed well. | Same mitigation as Slice 2 §9 / Slice 3 §9. The `withSemanticIntentCard` helper takes an explicit `behaviorText` that mirrors the corpus query string; Slice 4 reuses it. If under-scores, extend `semanticHints` (which map to `IntentCard.preconditions`) with domain-specific keyword phrases ("random URL-friendly identifier", "nanoid", "21-character secure ID", "URL-safe base64-like alphabet"). Reviewer escalates only if even with semantic hints the score stays <0.70 — that is a genuine quality finding, not a Slice 4 design failure. |
| uuid's TypeScript-compiled CJS uses `__esModule` interop boilerplate (`Object.defineProperty(exports, "__esModule", ...)`, `exports.default = v4`) — the engine may not extract the right atomization for the default export. | The shave engine handled validator's Babel-CJS `_interopRequireDefault` boilerplate (Slice 2 `DEC-WI510-S2-PER-ENTRY-SHAVE-001`); uuid's tsc-compiled boilerplate is structurally similar. If atom extraction is silently incomplete, §5.6 criterion 4 (reviewer inspects forest topology) catches it. If extraction is loud-broken, the test fails fast. Either way, file a Slice 1 engine bug — do not patch in-slice. |
| TWO fixtures vendored in one slice may double the chance of a vendoring mistake (wrong file checked in, missing `PROVENANCE.md`, biome-ignore drift). | Implementer follows Slices 2 / 3 step-by-step (download tarball, verify SHA1, extract, copy contents, author PROVENANCE.md, verify biome doesn't complain). §5.6 criterion 11 explicitly checks predecessor fixtures are untouched. Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/` to confirm exactly two new sibling directories. |
| Implementer reaches for `void (async () => {...})()` IIFE pattern in test orchestration (e.g. for parallel-shave optimization) and hits the VoidExpression atomization gap from PR #566. | §5.5 forbids `void (async () => {...})()` patterns explicitly. All test orchestration uses plain `await`-in-`async`-`it()`. The compound interaction test runs the four bindings sequentially (per-entry isolation requirement), so there is no parallelism temptation. |
| Implementer skips `biome format --write` before committing → local turbo cache hides format violations → CI fails on the PR. | §5.5 explicitly requires `pnpm biome format --write` on the two new test files before staging. Per Slice 3 lesson learned (PR #570 had this exact failure mode). |
| The four `corpus.json` entries fail the `discovery-eval-full-corpus.test.ts` per-category invariants (≥8-per-category, positive+negative balance). | `cat1` is already well-populated with ~16 existing entries (10 original + 4 validator + 4 semver, per the `grep` survey). Appending 4 more puts cat1 at ~20 entries; the ≥8 invariant is comfortably satisfied. The positive+negative balance invariant applies to entries with `expectedAtom` — since all four new entries have `expectedAtom: null` (`synthetic-tasks`), they are neither positive nor negative for that balance check (consistent with Slices 2/3). |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **uuid's other ~10 dist/cjs/ behaviors** (`v1`, `v3`, `v5`, `v6`, `parse`, `stringify`, `v1ToV6`, `v6ToV1`, `MAX`, `NIL`). Deferred.
- **nanoid's sub-path entries** (`./async`, `./non-secure`, `./url-alphabet`). Deferred.
- **A v4-specific UUID validator.** uuid does not ship one; we use the any-version `validate` and document the imprecise mapping (`DEC-WI510-S4-UUID-BINDING-NAMES-001`).
- **ESM-vendored uuid@14 or nanoid@5 fixtures.** Deferred (`DEC-WI510-S4-UUID-VERSION-PIN-001`, `DEC-WI510-S4-NANOID-VERSION-PIN-001`). A follow-on initiative may add ESM stress-testing.
- **A whole-package shave path.** Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Engine frozen after Slice 1.
- **Slices 5-9 graduated fixtures** (date-fns, jsonwebtoken+bcrypt, lodash, zod/joi, p-limit+p-throttle). Out of scope.
- **`vitest.config.ts` adjustments.** Forbidden touch point.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 4 produces the four headline-binding atoms in the corpus, `#508` Slice 2 already shipped with validator as the demo binding.
- **The B10 bench (`#512`).** Separate WI; uuid+nanoid atoms are corpus completeness, not the demo path.

---

*End of Slice 4 plan — per-entry shave of `v4`, `validate`, `v7` (uuid headline bindings) + `nanoid` (nanoid primary export) per #510 Slice 4 of 9.*
