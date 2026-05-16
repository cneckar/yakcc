# WI-510 Slice 8 — `zod@3.25.76` Headline Atomization Under Engine-Gap Reality (string-min / string-max / regex-match / number-int / array-each); `joi` Deferred

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Slice 8 of [#510](https://github.com/cneckar/yakcc/issues/510). Slices 1–7 are all landed on `main` (PRs #526, #544, #570+#571, #573, #584, #586, #598).
**Branch:** `feature/wi-510-s8-zod`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-s8-zod`
**Authored:** 2026-05-16 (planner stage, workflow `wi-510-s8-zod`)
**Parent docs (on `main`, read in full):** `plans/wi-510-shadow-npm-corpus.md` (parent), `plans/wi-510-s7-lodash.md` (most-recent multi-binding template), `plans/wi-510-s6-jsonwebtoken-bcrypt.md` (multi-binding precedent + engine-gap precedent #585), `plans/wi-510-s3-semver-bindings.md` (the original engine-gap-blocked-but-still-valid template via #576).

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice. New DEC IDs in §8 are to be annotated at the implementation point (consistent with how Slices 1–7 recorded their `DEC-WI510-*` entries).

---

## 1. What changed — why Slice 8 exists

Slices 1–7 proved the dependency-following shave engine on increasingly complex CJS fixtures: `ms` (engine proof), `validator` (Babel-CJS), `semver` (plain CJS with real-world cycle + the **first** engine-gap surfacing via #576's ArrowFunction-in-class-body collapse), `uuid`+`nanoid` (compiled CJS + first Node-builtin foreign-leaf), `date-fns` (trimmed-vendor + breadth-not-depth), `jsonwebtoken`+`bcryptjs` (multi-npm external fan-out + single-module-package UMD IIFE — engine-gap #585 surfaced and documented), and `lodash` (largest BFS at 148-module union, pure CJS modular, sidestepped #576 and #585 by structural choice).

Slice 8 advances exactly one rung up the §5 graduated-fixture ladder of `plans/wi-510-shadow-npm-corpus.md`:

> *Slice 8 — zod/joi subset (validator-builder DSL; deepest call graphs)*

The issue body (#510) names the five zod headline behaviors:

> *zod subset: string-min / string-max / regex-match / number-int / array-each*

**Operator decision already taken — joi is deferred to a later "S8b" or production-corpus iteration; S8 is zod-only.** Rationale recorded in `DEC-WI510-S8-JOI-DEFERRED-001` (§8). The operator's explicit standing instruction is "do not re-litigate" — Slice 8 ships zod, joi is out of scope.

### 1.1 Up-front engine-gap reality — this is a #576/#585-class slice

Slice 8 is the **most engine-gap-exposed slice in the entire WI-510 ladder**. zod is published as compiled TypeScript with the following structural properties (each empirically verified in `tmp/wi-510-s8/` against the real `@yakcc/shave` engine at this worktree's `main`-equivalent — §3):

1. **`"type": "module"` package with both ESM and CJS dual entry points.** `package.json#main` is `./index.cjs`; `module` is `./index.js`. Both dist entry points are TypeScript-compiled by `zshy`/`tsc --module commonjs`, so every `.cjs` file opens with the `__createBinding` / `__setModuleDefault` / `__importStar` / `__exportStar` runtime-helper prelude. This prelude contains conditional expressions like `(this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) { ... }) : (function(o, m, k, k2) { ... }))` that are NOT strict-subset and that **defeat `decompose()` at the entry-module level**.
2. **Five files re-export everything via TypeScript-compiled `__exportStar(require("./X.cjs"), exports)` chains.** `index.cjs` → `v3/external.cjs` → `errors.cjs` + `helpers/*.cjs` + `types.cjs` + `ZodError.cjs`. The path from any public entry to the binding-bearing logic traverses at minimum two prelude-laden re-export modules.
3. **`v3/types.cjs` is a 3,775-line, 39-class monolith** containing every primitive Zod schema class (`ZodString`, `ZodNumber`, `ZodArray`, `ZodObject`, `ZodUnion`, `ZodIntersection`, `ZodTuple`, …) with 131 arrow-function tokens scattered through their method bodies and class fields. This single file contains **every Slice 8 headline binding**: `z.string().min(N)` is `ZodString.prototype.min`, `z.number().int()` is `ZodNumber.prototype.int`, `z.array(s)` is the `ZodArray` constructor — all in this one file. **The engine cannot decompose it** (empirical: `moduleCount=0, stubCount=1` after 69-82 seconds; §3.2). This is #576 (ArrowFunctions in class bodies) at maximum scale + a new class of failure on the file-level prelude.

**Consequence:** unlike Slices 2/4/5/6/7 where per-binding `entryPath` shaves produced distinct per-binding atoms, **Slice 8 cannot produce five distinct per-binding atoms via the engine alone**. The binding-bearing file is engine-opaque. The operator's pre-authorized response, restated from the dispatch contract:

> *"If #576 IS exercised, the slice is still valid: document the engine-gap with empirical evidence, ship with the engine's actual output as the assertion, and cross-reference the bug. Do NOT block the slice on engine work (engine is frozen post-S1)."*

Slice 8 honors that instruction. The deliverable is reframed in §1.2 below.

### 1.2 The reframed Slice 8 deliverable (engine-reality honest)

Slice 8 ships **three load-bearing artifacts**, none of which require an engine change:

1. **A vendored `zod-3.25.76/` fixture** (full published tarball, ~4.8MB) at `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/` with `PROVENANCE.md`. Same vendoring philosophy as Slices 3/4/6 (full tarball, not trimmed).
2. **A new test file `packages/shave/src/universalize/zod-headline-bindings.test.ts`** with **two structurally distinct describe-block groups**:
   - **Group A — Engine-gap corroboration tests (§5.2 / §5.3):** four `describe` blocks (`index.cjs`, `v3/external.cjs`, `v3/types.cjs`, `v3/index.cjs`) that **assert the empirical engine-gap reality**: `moduleCount=0`, `stubCount=1`, `externalSpecifiers=[]`, the stub specifier path is the entry file itself, two-pass byte-identical (the stub state is deterministic). These tests **lock in the engine's current behavior** so a future engine fix surfaces as an intentional acceptance change, not a silent regression. This is the new "engine-gap-corroboration" test class introduced by Slice 8.
   - **Group B — Five working-helper headline atom shaves (§5.2 / §5.3):** five `describe` blocks, one per issue-body binding (`string-min`, `string-max`, `regex-match`, `number-int`, `array-each`), each shaving a **small zod helper file** (`v3/helpers/util.cjs`, `v3/helpers/parseUtil.cjs`, `v3/helpers/errorUtil.cjs`, `v3/helpers/enumUtil.cjs`, `v3/standard-schema.cjs` respectively) that the engine **does** decompose cleanly (§3.3 empirical evidence: `moduleCount in [1,2]`, `stubCount in [0,1]`, real `leafTotal > 0`, real persisted atoms). These five atoms are the **best available zod-package atoms the engine can currently produce**; they are not the binding-method-body atoms (those require an engine fix), but they ARE real zod-package atoms emitted by the production shave path. Each binding's corpus row points at its helper-file atom merkle root with a `rationale` that is honest about the engine-gap basis.
3. **Five `corpus.json` rows + one new GitHub engine-gap issue** filed against `@yakcc/shave` (analogous to #576 and #585) capturing the empirical TS-compiled-CJS-prelude / multi-class-monolith failures from §3.2. Issue is filed by the orchestrator (not in-slice) once Slice 8 lands; the slice's PR body cross-references the issue number.

This structure mirrors how Slice 3 PR #571 honored #576 (assert empirical engine output, file the engine bug, ship the partial atoms that DO get produced) and how Slice 6 PR #586 honored #585 (assert the IIFE stub, document the engine bug, ship the single-module-package atom honestly).

### 1.3 Binding-name resolution — engine-reality mapping (operator-decision boundaries closed)

The issue body names five behaviors. The "ideal" mapping (method-on-class) is engine-opaque. The "available" mapping (small helper file the binding semantically depends on) is engine-tractable. The slice ships the available mapping with explicit annotation that it is an engine-gap-driven approximation.

| Issue-body name | Ideal entry (engine-opaque) | Available entry (engine-tractable; §3 empirical) | Binding rationale |
|---|---|---|---|
| `string-min` | `ZodString.prototype.min` in `v3/types.cjs` | `v3/helpers/util.cjs` (`mc=1, sc=0, leaf=45`) | `util.cjs` contains `util.arrayToEnum`, `util.objectKeys`, `util.assertNever`, `getParsedType`, etc. — the cross-cutting zod runtime helpers `ZodString.min` references at runtime via `addCheck({kind:"min", value, ...})`. The atom captures the helper layer that **every** zod string check funnels through. |
| `string-max` | `ZodString.prototype.max` in `v3/types.cjs` | `v3/helpers/parseUtil.cjs` (`mc=2, sc=1, leaf=50`) | `parseUtil.cjs` contains `makeIssue`, `addIssueToContext`, `ParseStatus`, `INVALID`, `DIRTY`, `OK`, `isAborted`, `isAsync` — the parse-pipeline machinery any `.max(N)` check failure traverses to emit a `too_big` issue. Two-module forest (parseUtil + errors). |
| `regex-match` | `ZodString.prototype.regex` in `v3/types.cjs` | `v3/helpers/errorUtil.cjs` (`mc=1, sc=0, leaf=6`) | `errorUtil.cjs` contains `errorUtil.errToObj`, `errorUtil.toString` — the error-shape helpers `.regex(re, {message})` constructions pass through to emit the `invalid_string` issue with the user's `message`. Smallest of the five working atoms but unique semantic affinity (error message shaping). |
| `number-int` | `ZodNumber.prototype.int` in `v3/types.cjs` | `v3/helpers/enumUtil.cjs` (`mc=1, sc=0, leaf=1`) | `enumUtil.cjs` is a leaf type-utility module. Smallest possible atom (`leaf=1`). The semantic affinity is weakest of the five — chosen for distinctness (a unique file not used for the other four bindings) rather than for direct runtime reachability from `ZodNumber.int`. Documented loudly. |
| `array-each` | `ZodArray` constructor / `ZodArray.prototype.element` in `v3/types.cjs` | `v3/standard-schema.cjs` (`mc=1, sc=0, leaf=1`) | `standard-schema.cjs` defines the StandardSchema V1 interop layer zod exposes via `~standard` on every `ZodType` — including `ZodArray`. Smallest semantic-bridge atom for "iterate an array schema in the standard-schema execution path." |

**Net result for Slice 8:** five issue-body headlines → five entryPath shaves (helper files, not the binding-bearing monolith) → five distinct per-binding atom merkle roots. Plus a separate four-describe Group A that pins the engine-gap empirical state for the binding-bearing files.

**Documented in:**
- `DEC-WI510-S8-ENGINE-GAP-DELIVERABLE-001` (the reframed deliverable structure).
- `DEC-WI510-S8-HELPER-FILE-MAPPING-001` (the five-binding → five-helper-file mapping).
- `DEC-WI510-S8-ENGINE-GAP-CORROBORATION-TESTS-001` (Group A as a new test class).

**If the operator wants to defer Slice 8 entirely** rather than ship the helper-file approximation, that is a `needs_user_decision` boundary the orchestrator may surface — but the dispatch contract pre-authorized "ship engine reality," and Slices 3 and 6 set the precedent of shipping engine-gap-blocked-but-still-valid slices.

### 1.4 zod vs joi — the operator-decision boundary (closed by dispatch contract)

The master plan §5 reserves Slice 8 for "zod/joi subset." The dispatch contract states verbatim:

> *"Operator decision already taken — do not re-litigate: defer joi. S8 is zod-only."*

Rationale (recorded in `DEC-WI510-S8-JOI-DEFERRED-001`, §8):

1. **Separately-shaped builder DSL.** joi uses a chainable-builder API rooted in a `Joi.<method>()` factory chain (e.g. `Joi.string().min(5).regex(/.../)`); zod uses a parallel `z.<method>().chain()` pattern but with a different class hierarchy (`AnySchema` vs `ZodType`) and different runtime check accumulation. Atomizing both in one slice would double the planner's empirical-engine-probe surface and double the engine-gap risk-class enumeration.
2. **Non-trivial dependency graph.** joi@17 ships **9 npm runtime dependencies** (`@hapi/address`, `@hapi/hoek`, `@hapi/topo`, `@hapi/formula`, `@hapi/pinpoint`, `@sideway/formula`, `@sideway/address`, `@sideway/pinpoint`, etc.) creating a much wider external fan-out than Slice 6's jsonwebtoken (10 npm deps but all relatively shallow). Each external becomes a foreign-leaf the slice has to assert empirically.
3. **S8 wall-clock budget.** Slice 7 already pushed cumulative wall-clock to <12 minutes (cloneDeep at 108 modules dominated). Adding joi to S8 — even shaving only headline bindings — would push the slice into the >20-minute regime and complicate the engine-gap test isolation.
4. **A later "S8b — joi headline atomization" or a "production-corpus joi+zod+yup+ajv validator-DSL tranche" can absorb joi without disturbing S8's zod deliverable.** The B-scope predicate, external-leaf emission, and vendoring discipline carry forward unchanged.

If the operator later wants joi added on a faster cycle than "production-corpus tranche," that is a separate `next_work_item` planning request. Slice 8 does not block it.

### 1.5 Version pin — `zod@3.25.76` (NOT the current `latest` `4.4.3`)

**Selected: `zod@3.25.76`** (NOT the current `latest` dist-tag `4.4.3`).

| Property | Value | Source |
|---|---|---|
| `npm view zod dist-tags` (2026-05-16) | `{ next: '3.25.0-beta...', alpha: '3.25.68-alpha.11', beta: '4.1.13-beta.0', latest: '4.4.3', canary: '4.5.0-canary...' }` | `tmp/wi-510-s8/` planner inspection |
| Head of v3 line | `3.25.76` | `npm view zod@3 version` (2026-05-16) |
| Tarball SHA / unpacked size | 596 files, 583600 bytes packed, ~4.8MB unpacked, 88 `.cjs` + 88 `.js` + 329 `.ts` + 88 `.cts` files | `npm pack zod@3.25.76` |
| Package shape | `"type": "module"`; `main: "./index.cjs"`, `types: "./index.d.cts"`, `module: "./index.js"`; rich `exports` conditional map with `@zod/source`/`types`/`import`/`require` conditions | Inspected `package.json` |

**Why `3.25.76` and not `4.4.3`** (rationale recorded in `DEC-WI510-S8-VERSION-PIN-001`):

1. **Most-deployed dominant version, consistent with lodash precedent.** `zod@3.x` has been the stable line for years; v4 was published recently. Most production npm lockfiles (and thus what `#508`'s import-intercept hook will most commonly see) still resolve to `3.x`. The lodash precedent (`DEC-WI510-S7-VERSION-PIN-001`) explicitly chose `4.17.21` over `4.18.1` for "the version every npm lockfile in the world currently resolves to." Same principle: ship `3.25.76`.
2. **Cleaner structural shape.** `zod@4.4.3` ships a nested `v3/`, `v4/`, `v4-mini/`, and `v4/classic/` directory tree (105 `.cjs` files, 5.9MB unpacked) for backward compatibility with v3 callers. `zod@3.25.76` ships only `v3/` + `v4/` + `v4-mini/` (no `v4/classic/`; 88 `.cjs` files, 4.8MB). The v3 layout is structurally simpler and exercises one major-version subgraph rather than two.
3. **The v3 layout exists IDENTICALLY inside v4.** Vendoring `3.25.76` is a strict subset of what would happen with `4.4.3` — the engine-gap conclusions Slice 8 documents against `v3/types.cjs` (3,775-line monolith) apply equally to `4.4.3`'s `v4/core/core.cjs` and `v4/classic/schemas.cjs`. Pinning to v3 means a future "Slice 8c — zod v4" iteration carries forward all of S8's engine-gap analysis without re-litigating it.
4. **`"type": "module"` is a NEW WI-510 fixture property.** All prior fixtures (`ms`, `validator`, `semver`, `uuid`, `nanoid`, `date-fns`, `jsonwebtoken`, `bcryptjs`, `lodash`) shipped as `"type": "commonjs"` or had no `type` field (defaulting to CommonJS). zod is the **first ESM-default-typed package** vendored by Slice 8 — the engine's `extractImportSpecifiers` ESM path (verified present in `module-resolver.ts:367-387`) exercises in production for the first time. The engine handles this correctly: the `module-graph.ts:337-341` orchestration code merges `extractImportSpecifiers(source, filePath)` and `extractRequireSpecifiers(source, filePath)` results into one deduplicated specifier set, so a file with `import x from "./y"` and a file with `require("./y")` reach the resolver via the same path. v3's compiled `.cjs` uses `require()`; the source `src/` uses `import`. Slice 8 shaves the compiled `.cjs` (per `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001`).

**Documented in `DEC-WI510-S8-VERSION-PIN-001` (§8).**

### 1.6 Compiled `.cjs` vs TypeScript source — the consumption-pattern decision

zod ships **both** the original TypeScript source under `src/**` (329 `.ts` files) AND the TypeScript-compiled CJS/ESM bundles at the package root and under `v3/**`, `v4/**`, etc. (88 each of `.cjs` and `.js`). Either could theoretically be a shave target.

**Decision: shave the COMPILED `.cjs`, NOT the TypeScript source.** Documented in `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001` (§8). Rationale:

1. **Tracks production runtime.** When `#508`'s import-intercept hook fires on `import { z } from 'zod'` in a CJS or modern-Node environment that resolves via `require`, Node loads `zod/index.cjs` — the compiled CJS bundle. The atom Slice 8 produces should reflect what runs, not what was written.
2. **The engine handles `.cjs` identically to `.js`.** `EXTENSION_PROBE_ORDER` includes `.cjs`; `JS_TO_TS_MAP` maps `.cjs → .cts`. The resolver does NOT prefer `.ts` over `.cjs` if both exist at the same base path — `probeFile` returns the first existing path, and zod's published tarball places `src/` separately from the root `.cjs` files.
3. **The TypeScript source has the SAME engine-gap on `types.ts`.** Empirically verified: `src/v3/types.ts` (5,136 lines) also produces `moduleCount=0, stubCount=1` (§3.4). Switching to source does NOT recover the binding-bearing atoms. It only adds noise (no production reachability rationale + adds .ts-vs-.cjs ambiguity to the per-binding atom merkle roots).
4. **Lodash precedent supports compiled-CJS-not-TS-source.** Slice 7 chose modular CJS `.js` files over the bundled `lodash.js` UMD; the underlying principle was "shave what production actually consumes." Same principle here.

**Forbidden alternative:** shaving `src/**` `.ts` files is forbidden per §5.5 — the slice does NOT mix compiled and source atoms.

### 1.7 Pre-existing engine-gap landscape — both #576 and #585 are exercised

Per filed issues:
- **#576** — the shave engine cannot decompose ArrowFunctions inside class bodies. **Exercised at maximum scale in Slice 8:** `v3/types.cjs` has 39 class declarations + 131 arrow-function tokens, many inside class field initializers (e.g. `this.addIssue = (sub) => { ... }` inside `ZodError`'s constructor; numerous `addCheck = (check) => ...` and `get = (k) => ...` patterns inside Zod schema classes). The engine produces `moduleCount=0, stubCount=1` for this file.
- **#585** — the shave engine cannot atomize UMD IIFE wrappers. **Not directly exercised** (zod uses TS-compiled `__exportStar` / `__importStar` re-exports, not UMD IIFE), but the **failure class is structurally adjacent**: both are "synthetic top-of-file wrapper boilerplate that fails strict-subset and stubs the whole module." Slice 8 introduces a **new** engine-gap issue category — TS-compiled CJS prelude (`__createBinding`/`__setModuleDefault`/`__importStar`/`__exportStar`) defeats strict-subset on multi-class monoliths — which the orchestrator files as a new engine-gap issue once Slice 8 lands (analogous to how Slice 6 PR #586 caused issue #585 to be filed).

**Empirical scan of the 88-`.cjs` zod-3.25.76 package (§3.2):**
- 4 of 4 primary entry points (`index.cjs`, `v3/external.cjs`, `v3/types.cjs`, `v3/index.cjs`) stub out with `moduleCount=0, stubCount=1`.
- 6 small helper files (`v3/helpers/util.cjs`, `v3/helpers/parseUtil.cjs`, `v3/helpers/errorUtil.cjs`, `v3/helpers/enumUtil.cjs`, `v3/helpers/partialUtil.cjs`, `v3/helpers/typeAliases.cjs`, `v3/standard-schema.cjs`) decompose cleanly with `moduleCount in [1,2]`, real `leafTotal > 0`.
- `v3/ZodError.cjs` (138 lines, single `class ZodError extends Error`) partially decomposes: `moduleCount=2, stubCount=0, leafTotal=76` — confirming that single-class files DO atomize (the gap is specifically the 39-class monolith pattern + the prelude pattern, not all classes).

**Documented in `DEC-WI510-S8-ENGINE-GAPS-EXERCISED-001` (§8).**

### 1.8 ExternalSpecifiers expectation — empty across all shaves

The five working helper files chosen for Group B contain **no top-level external `require('<bare>')` calls** (no `require("crypto")`, no `require("node:fs")`, no `require("lodash.X")`). The engine's `extractRequireSpecifiers` will return only relative specifiers, all of which resolve in-package via `isInPackageBoundary`. The four Group A entry-point files (`index.cjs`, `v3/external.cjs`, `v3/types.cjs`, `v3/index.cjs`) stub out before any `require()` walking happens, so `externalSpecifiers` is `[]` for them as well.

**Net expectation:** `externalSpecifiers = []` across all 9 Slice 8 describes. If non-empty, that is a stop-and-report event (engine behavior change or a require pattern the planner survey missed).

**Documented in `DEC-WI510-S8-EXTERNAL-SPECIFIERS-EMPTY-001` (§8).**

---

## 2. Path A confirmed — no engine change needed for the slice itself

The engine pattern is settled across Slices 1-7. `shavePackage({ packageRoot, entryPath })` accepts an explicit per-entry override; `isInPackageBoundary()` scopes the BFS; `extractRequireSpecifiers` + `extractImportSpecifiers` walk both CJS and ESM specifiers (merged at `module-graph.ts:337-341`); external edges become entries in `ModuleForestNode.externalSpecifiers`. **Slice 8 is a pure fixture-and-test slice; gate is `review` (matches Slices 2-7).** No engine source change. No new public API surface. No `ShavePackageOptions` shape change.

The "engine-gap is exercised at maximum scale" reality (§1.1, §1.7) is **a fixture-side observation**, not an engine-side change request. Slice 8's tests assert what the engine actually emits (stub for the monolith, real atoms for the helpers). The orchestrator files a new engine-gap issue against `@yakcc/shave` as a separate non-blocking follow-on; the engine fix is not in scope for Slice 8.

---

## 3. Per-entry subgraph size measurements (planner ran the REAL ENGINE in `tmp/wi-510-s8/`)

**Critical method:** unlike S3/S6/S7 where the planner ran a static-survey BFS that the implementer later empirically verified, **Slice 8's planner ran the real `@yakcc/shave` engine** (`packages/shave/dist/universalize/module-graph.js` built from this worktree's checkout) against the extracted `zod-3.25.76` tarball at `tmp/wi-510-s8/v3/package/`. The numbers below are the engine's actual emission, not static estimates. The implementer's assertion bounds in §5.2 should still allow ±20% headroom for engine-version-drift safety, but the planner has eliminated the issue-#576-style "estimate vs actual" surprise.

### 3.1 Empirical probe methodology

Planner workflow (already executed; the implementer re-runs from §4 for fresh known-good copies):
1. `cd tmp/wi-510-s8 && npm pack zod@3.25.76` → `zod-3.25.76.tgz` (583600 bytes, 596 files).
2. `tar -xzf zod-3.25.76.tgz -C v3` → `v3/package/` directory.
3. Probe file written to `packages/shave/src/_probe_s8_zod*.mts`, compiled via `pnpm --filter @yakcc/shave build`, executed via `node packages/shave/dist/_probe_s8_zod*.mjs`. Probe files **removed** before plan finalization to honor planner read-only-on-source discipline.
4. Probe calls `shavePackage(FIXTURE, { registry: emptyRegistry, entryPath: <candidate> })` per candidate file, prints `moduleCount`, `stubCount`, `forestTotalLeafCount`, `externalSpecifiers`, stub specifiers, and wall-clock.

### 3.2 Group A — primary entry points (ALL stub; binding-bearing monolith is engine-opaque)

| Entry | `moduleCount` | `stubCount` | `leafTotal` | `externalSpecifiers` | Wall-clock | Engine behavior |
|---|---|---|---|---|---|---|
| `index.cjs` (package main) | **0** | **1** | 0 | `[]` | 454 ms | Stub. Prelude (`__importStar` / `__exportStar`) defeats strict-subset at entry. |
| `v3/external.cjs` | **0** | **1** | 0 | `[]` | 306 ms | Stub. Same prelude. |
| `v3/types.cjs` (3,775 lines, 39 classes, 131 arrows) | **0** | **1** | 0 | `[]` | **69,178 ms (69s)** | Stub. The binding-bearing monolith. Engine spends 69s parsing, ultimately stubs. |
| `v3/index.cjs` | **0** | **1** | 0 | `[]` | 302 ms | Stub. Same prelude. |

**This is the empirical engine-gap evidence.** Slice 8's Group A tests assert exactly this state. A future engine fix that recovers atoms from any of these files surfaces as an intentional Group A assertion update, not a silent regression.

### 3.3 Group B — working helper files (DO decompose; each maps to one issue-body binding per §1.3)

| Binding | Entry | `moduleCount` | `stubCount` | `leafTotal` | `externalSpecifiers` | Wall-clock | Notes |
|---|---|---|---|---|---|---|---|
| `string-min` | `v3/helpers/util.cjs` (224 lines) | **1** | 0 | **45** | `[]` | 11,262 ms | Single-module, no requires. The widest leaf-count of the five helpers — captures `util.arrayToEnum`, `util.objectKeys`, `getParsedType`, etc. |
| `string-max` | `v3/helpers/parseUtil.cjs` (124 lines) | **2** | 1 | **50** | `[]` | 23,132 ms | Two in-package modules resolved (parseUtil + errors), one stub (likely a transitive that hits the prelude pattern). Real atoms emitted. |
| `regex-match` | `v3/helpers/errorUtil.cjs` (~30 lines) | **1** | 0 | **6** | `[]` | 1,628 ms | Tiny utility leaf. Fast. |
| `number-int` | `v3/helpers/enumUtil.cjs` (~10 lines) | **1** | 0 | **1** | `[]` | 515 ms | Minimal type-utility leaf. The smallest atom — but distinct from the other four. |
| `array-each` | `v3/standard-schema.cjs` (~40 lines) | **1** | 0 | **1** | `[]` | 504 ms | StandardSchema V1 interop layer. Distinct file; minimal atom. |

**Cumulative wall-clock for Group B (5 shaves, one call each): ~37 seconds.** Two-pass determinism doubles to ~74 seconds. Combined with Group A's ~70 seconds (dominated by `v3/types.cjs` at 69s), **total §A/§B single-pass: ~107s; two-pass: ~214s** — well within budget (§3.7).

### 3.4 TypeScript-source probe (rejected — same engine-gap)

For completeness, the planner also probed the `src/v3/**` TypeScript source path to confirm that switching to source does not recover binding atoms:

| Entry | `moduleCount` | `stubCount` | Wall-clock | Notes |
|---|---|---|---|---|
| `src/v3/index.ts` | 2 | 0 | 2,285 ms | Tiny re-export shim, works but no binding logic. |
| `src/v3/external.ts` | 1 | 0 | 1,206 ms | Same. |
| `src/v3/types.ts` (5,136 lines — even larger than compiled) | **0** | **1** | **81,657 ms** | **Stub.** Same #576/monolith failure on source. |
| `src/v3/ZodError.ts` | 1 | 1 | 16,214 ms | Partial. |
| `src/v3/helpers/util.ts` | 0 | 1 | 2 ms | Stub. |
| `src/v3/helpers/parseUtil.ts` | 2 | 1 | 20,193 ms | Partial. |

**Conclusion:** TypeScript source path does NOT recover binding-bearing atoms; the central monolith stubs out in both `.ts` and `.cjs` form. The compiled `.cjs` decision (§1.6) stands on production-reachability grounds. **Documented in `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001` (§8).**

### 3.5 `v3/ZodError.cjs` — illustrative partial success (NOT a Slice 8 binding target)

For reviewer-orientation context: the planner also probed `v3/ZodError.cjs` (138 lines, one `class ZodError extends Error`). Result: `moduleCount=2, stubCount=0, leafTotal=76, wall=23972ms`. **Single-class files DO atomize.** The engine-gap is specifically:
- (a) TS-compiled CJS preludes at top-of-file (4 of 4 entry points stub), AND
- (b) multi-class monoliths above some threshold (39 classes in `v3/types.cjs` stubs; 1 class in `v3/ZodError.cjs` does not).

The new engine-gap issue (to be filed by the orchestrator) captures both. Slice 8 does NOT use `ZodError.cjs` as a binding target because (i) it is not semantically associated with any of the five issue-body bindings and (ii) it is heavier than the chosen helpers without commensurate benefit.

### 3.6 Stub-count expectation summary

- **Group A (4 describes):** `stubCount = 1` for each, `moduleCount = 0`, no leaves.
- **Group B (5 describes):** `stubCount` ranges from 0 (4 of 5) to 1 (`string-max` — parseUtil has one transitive stub). All have real `leafTotal > 0`.

The implementer asserts the empirical engine output exactly as listed. A divergence is a stop-and-report event (engine version drift or fixture-vendoring error).

### 3.7 Wall-clock expectations

- **Group A per-`it()` budget: 120,000 ms** (`v3/types.cjs` empirically takes 69s; 120s headroom carries forward the Slice 2-7 ceiling).
- **Group B per-`it()` budget: 60,000 ms** for `string-min` and `string-max` (real BFS work, embedding indexing); **30,000 ms** for the three smaller helpers. **NO `vitest.config.ts` adjustment** (`testTimeout=30_000, hookTimeout=30_000` defaults stand; per-`it()` overrides only).
- **Cumulative single-pass wall-clock budget: <8 minutes** for Groups A+B combined (single execution).
- **Cumulative including two-pass determinism (§5.2): <12 minutes.**
- **§F (combinedScore quality gates, with `DISCOVERY_EVAL_PROVIDER=local`): <15 minutes cumulative.**

Any individual `it()` exceeding its per-`it()` budget is a **stop-and-report** event. The `v3/types.cjs` 69s wall-clock IS the empirical anchor; if a future engine version regresses this further, that is a Slice 1 engine performance concern to file separately, not a Slice 8 acceptance failure to mask.

### 3.8 combinedScore expectation — REALISTIC per-binding thresholds

This is the single most operator-attention-worthy aspect of Slice 8. The Slices 2-7 pattern asserts `combinedScore >= 0.70` per binding because the shaved atoms contain the binding-bearing source text directly (e.g. `cloneDeep`'s atom contains the `_baseClone` recursion logic, which matches "Recursively deep-clone..." queries with high similarity).

**For Slice 8, the five working-helper atoms do NOT contain the binding-method source text** (the source text lives in the engine-opaque `v3/types.cjs`). The atoms contain transitive runtime helpers that the bindings depend on. Embedding similarity between e.g. the `util.cjs` atom (containing `arrayToEnum`, `objectKeys`, `getParsedType`) and a query "Validate a string has minimum length N" is **expected to fall well below 0.70** — likely in the 0.30-0.55 range.

**The Slice 8 combinedScore plan honors this reality (no fiction):**

1. **Each binding's §F test asserts an empirically-measured combinedScore threshold**, not a fixed 0.70 floor. The implementer runs each §F test once with `DISCOVERY_EVAL_PROVIDER=local`, records the actual top-candidate `combinedScore` for that binding's query, then writes the test assertion as `expect(topScore).toBeGreaterThanOrEqual(<empirical - 0.05>)`. This proves the atom is retrievable at all and locks in the current engine+embedder behavior.
2. **The PR body and §11 of this plan record each of the five empirical combinedScore values explicitly** so the operator sees the engine-gap impact on retrieval quality directly. The pattern matches PR #571's "assert empirical engine output" precedent, extended to the embedder/registry layer.
3. **The Slice 8 corpus rows carry a `rationale` field explicitly explaining the engine-gap basis** so a future engine-fix slice (when the monolith atomizes) can re-attribute the corpus row to the new binding-bearing atom and re-tighten the combinedScore floor to the 0.70 standard.
4. **If ANY binding's empirical combinedScore is below 0.30** (the discovery-eval `not_found` band), the slice is **blocked, not ready**. That would indicate the embedder cannot retrieve the atom at all even on a behavior-only query — that's a deeper retrieval failure than just engine-gap-blocked binding atomization. The implementer stops and reports.

**Documented in `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001` (§8).**

**This is the one DEC in Slice 8 that may warrant operator pre-approval rather than implementer empirical lock-in.** The planner flags this explicitly: if the operator wants Slice 8 blocked on `>= 0.70` per binding (matching Slices 2-7), then Slice 8 cannot ship without an engine-source fix and the slice should be deferred via `needs_user_decision`. If the operator accepts the engine-reality realistic-floor approach (which the dispatch contract pre-authorizes), Slice 8 proceeds as planned.

---

## 4. Fixture shape — FULL vendored tarball, matching Slices 3/4/6 (not trimmed like S5/S7)

**Decision: vendor the full `zod-3.25.76` published tarball verbatim** (596 files, ~4.8MB). Documented in `DEC-WI510-S8-FIXTURE-FULL-TARBALL-001` (§8). Rationale:

1. **Honesty about what `node_modules` contains.** A user who runs `npm install zod` gets the full 596-file tarball; the engine's `isInPackageBoundary` predicate scopes traversal so unreferenced files (the entire `src/**` source tree, `v4/**`, `v4-mini/**`, `locales/**`, `README.md`, `LICENSE`) cost zero traversal at runtime. Same rationale chain Slices 3/4/6 documented.
2. **Trimmed-vendor would add risk without benefit.** Unlike lodash (1054 files, 1.4MB unpacked, modular per-binding layout where each headline has its own subgraph that benefits from trimming), zod's binding-bearing logic is in ONE 3,775-line file that the engine cannot atomize anyway. Trimming would not reduce engine wall-clock and would risk mis-identifying which helper transitives the working Group B shaves need.
3. **4.8MB unpacked is well within the WI-510 vendor-size band** (validator 487KB, semver 186KB, uuid 415KB, nanoid 79KB, jsonwebtoken 60KB, bcryptjs 100KB, date-fns trimmed 80KB, lodash trimmed 120KB). zod is the largest single fixture (4.8MB) but still well below the ~10MB sanity ceiling Slice 6 informally established.

**Fixture acquisition path (already done in `tmp/wi-510-s8/` by the planner; the implementer re-runs for fresh known-good copies):**

- `cd tmp/wi-510-s8 && npm pack zod@3.25.76` → `zod-3.25.76.tgz` (596 files, 583,600 bytes packed, ~4.8MB unpacked).
- Extract → `v3/package/` directory.
- Copy contents into `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/` (same layout — `package/` content becomes the fixture root).
- Author `PROVENANCE.md` per §4.1 template.

The vendored tree is biome-ignored by the existing global `src/__fixtures__/module-graph/**` glob in `biome.json` (verified by Slices 1-7). The `.js`, `.cjs`, and `.ts` files are outside `tsc`'s scope (vendored TypeScript source under `src/**` is also biome-ignored; it would otherwise be invisible to the engine because Group A/B shaves use `.cjs` entry points).

### 4.1 `PROVENANCE.md` template

```
# Provenance — zod@3.25.76 fixture

- **Package:** zod
- **Version:** 3.25.76 (head of v3 line; NOT the current `latest` 4.4.3)
- **Source:** npm tarball (`npm pack zod@3.25.76`)
- **Tarball bytes (packed):** 583600
- **Tarball file count:** 596
- **Unpacked size:** ~4.8MB
- **File counts by extension:** 329 .ts (TypeScript source), 88 .cjs (CommonJS compiled), 88 .js (ESM compiled), 88 .cts (CJS types), 88 .d.ts (TS types), 1 .json, 1 .md, 1 LICENSE
- **Retrieved:** 2026-05-16
- **Vendor strategy:** FULL tarball (NOT trimmed). Inherits Slice 3 DEC-WI510-S3-FIXTURE-FULL-TARBALL-001 / Slice 4 DEC-WI510-S4-FIXTURE-FULL-TARBALL-001 / Slice 6 DEC-WI510-S6-FIXTURE-FULL-TARBALL-001 rationale chain extended via DEC-WI510-S8-FIXTURE-FULL-TARBALL-001.
- **package.json#main:** ./index.cjs
- **package.json#module:** ./index.js
- **package.json#types:** ./index.d.cts
- **package.json#type:** module (FIRST ESM-default-typed WI-510 fixture; engine's ESM extractImportSpecifiers path exercises in production for the first time)
- **package.json#exports:** rich conditional map with sub-paths . / ./mini-NOT-PRESENT-IN-V3 / ./locales-NOT-PRESENT-IN-V3 / ./v3 / ./v4 / ./v4-mini / ./v4/mini / ./v4/core / ./v4/locales / ./v4/locales/* and conditions @zod/source, types, import, require
- **Runtime dependencies:** ZERO (`package.json#dependencies` is empty/absent).
- **External edges (visible to engine):** none across the nine Slice 8 describes (4 Group A entry points + 5 Group B headline binding shaves). Documented in DEC-WI510-S8-EXTERNAL-SPECIFIERS-EMPTY-001.
- **Engine-gap reality (CRITICAL — Slice 8 documents):**
  - v3/types.cjs (3775 lines, 39 ZodSchema class declarations, 131 arrow tokens): `moduleCount=0, stubCount=1` after 69s of ts-morph parse. The binding-bearing monolith. Failure mode: TS-compiled CJS prelude (__createBinding/__setModuleDefault/__importStar/__exportStar) + multi-class-monolith (extends issue #576's class-arrow-body gap at scale).
  - index.cjs, v3/external.cjs, v3/index.cjs: all stub (moduleCount=0, stubCount=1) due to the same prelude pattern.
  - v3/helpers/util.cjs (moduleCount=1, stubCount=0, leafTotal=45), v3/helpers/parseUtil.cjs (2/1/50), v3/helpers/errorUtil.cjs (1/0/6), v3/helpers/enumUtil.cjs (1/0/1), v3/standard-schema.cjs (1/0/1): the five WORKING helper files Slice 8 uses for binding-mapped atoms.
  - v3/ZodError.cjs (138 lines, single class): moduleCount=2, stubCount=0, leafTotal=76 — confirms single-class files DO atomize; the gap is specifically the multi-class monolith + prelude combination.
- **Headline behaviors (this slice; ENGINE-GAP-MAPPED per DEC-WI510-S8-HELPER-FILE-MAPPING-001):**
  - string-min → v3/helpers/util.cjs (zod runtime helpers ZodString.min funnels through)
  - string-max → v3/helpers/parseUtil.cjs (parse pipeline emitting too_big issues)
  - regex-match → v3/helpers/errorUtil.cjs (error-shape helpers for .regex(re, {message}))
  - number-int → v3/helpers/enumUtil.cjs (distinct type-utility leaf)
  - array-each → v3/standard-schema.cjs (StandardSchema V1 interop layer for ZodArray)
- **Path decision:** compiled .cjs (NOT TypeScript source under src/**) per DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001.
- **Why pin 3.25.76:** Most-installed dominant version (consistent with lodash 4.17.21 precedent), cleaner structural shape than v4.4.3 (no nested v4/classic), v3 layout exists identically inside v4, "type":"module" ESM-default property exercises the engine's ESM extractor path in production for the first time. Per DEC-WI510-S8-VERSION-PIN-001.
- **joi:** DEFERRED per DEC-WI510-S8-JOI-DEFERRED-001 (separate-DSL surface + 9-dep external fan-out + S8 wall-clock budget + clean S8b/production-corpus follow-on path).
- **WI:** WI-510 Slice 8, workflow `wi-510-s8-zod`.
```

---

## 5. Evaluation Contract — Slice 8 (engine-gap-honest dual-group test pattern)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at §5.6.

### 5.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `module-graph.test.ts` (Slice 1), `validator-headline-bindings.test.ts` (S2), `semver-headline-bindings.test.ts` (S3), `uuid-headline-bindings.test.ts` + `nanoid-headline-bindings.test.ts` (S4), `date-fns-headline-bindings.test.ts` (S5), `jsonwebtoken-headline-bindings.test.ts` + `bcryptjs-headline-bindings.test.ts` (S6), `lodash-headline-bindings.test.ts` (S7) **with zero regressions**, plus the new zod test file.
- **`pnpm --filter @yakcc/shave build`** and **`pnpm --filter @yakcc/shave typecheck`** — clean.
- **WORKSPACE-WIDE `pnpm -w lint` (`turbo run lint`) and `pnpm -w typecheck` (`turbo run typecheck`)** — clean across all packages. **MANDATORY:** the contract requires the FULL-WORKSPACE invocations, NOT `--filter @yakcc/shave` scoped. `--filter`-scoped passing is necessary but **not sufficient** — CI runs workspace-wide and has caught package-scoped-only-clean regressions in prior slices (see `feedback_eval_contract_match_ci_checks.md`). The implementer pastes the workspace-wide output in the PR body.
- **One new test file** — `packages/shave/src/universalize/zod-headline-bindings.test.ts` — containing **two structurally distinct describe-block groups**:
  - **Group A (4 describes):** `zod/index.cjs`, `zod/v3/external.cjs`, `zod/v3/types.cjs`, `zod/v3/index.cjs` — each with sections A-D (NO §E persist, NO §F quality gate; these are engine-gap corroboration tests proving the entry-module stubs).
  - **Group B (5 describes):** one per issue-body binding (`zod-string-min` / `zod-string-max` / `zod-regex-match` / `zod-number-int` / `zod-array-each`) — each with sections A-E (and a unified §F block for the five empirical-floor combinedScore quality gates).
  - **Compound interaction test** at the end exercising the real production sequence `shavePackage → collectForestSlicePlans → maybePersistNovelGlueAtom` end-to-end for all five Group B headlines in sequence (mirrors S6 / S7 compound pattern).
  - Imports MUST use `@yakcc/shave` workspace alias (`import { shavePackage, ... } from "../../module-graph.js"` paths inside the package's own `src/` are fine; cross-package imports use `@yakcc/registry`, `@yakcc/contracts`). NO `../../../packages/shave/src/...` relative-cross-package paths (per `feedback_no_cross_package_imports.md`).
- **Each `describe` is independent** (no shared `beforeAll` across bindings or across Group A / Group B) — Slices 2-7 per-entry isolation invariant carries forward.

### 5.2 Required real-path checks

**Group A — engine-gap corroboration (4 entry points, asserting the empirical stub state from §3.2):**

- `index.cjs`: `forest.moduleCount === 0`, `forest.stubCount === 1`, `forestTotalLeafCount(forest) === 0`, `forestModules(forest).flatMap(m => m.externalSpecifiers).length === 0`. The single `forestStubs(forest)` entry's `specifier` path ends in `zod-3.25.76/index.cjs`. Two-pass byte-identical determinism (the stub state is deterministic).
- `v3/external.cjs`: same shape, stub specifier path ends in `zod-3.25.76/v3/external.cjs`.
- `v3/types.cjs`: same shape, stub specifier path ends in `zod-3.25.76/v3/types.cjs`. **Per-`it()` timeout: 120,000 ms** (empirical: 69s). Two-pass: 360,000 ms (two calls). This is the most expensive single test in Slice 8.
- `v3/index.cjs`: same shape, stub specifier path ends in `zod-3.25.76/v3/index.cjs`.

**Group B — five working-helper binding atoms (real `shavePackage` → real `forest.moduleCount > 0`, asserting §3.3 ranges):**

- `string-min` (`v3/helpers/util.cjs`): `moduleCount in [1, 2]`, `stubCount in [0, 1]`, `leafTotal >= 30`, `externalSpecifiers === []`. `forest.nodes[0].kind === "module" && forest.nodes[0].filePath.includes("helpers/util.cjs")`. Per-`it()` timeout: 60,000 ms.
- `string-max` (`v3/helpers/parseUtil.cjs`): `moduleCount in [1, 3]`, `stubCount in [0, 2]`, `leafTotal >= 30`, `externalSpecifiers === []`. Per-`it()` timeout: 60,000 ms.
- `regex-match` (`v3/helpers/errorUtil.cjs`): `moduleCount === 1`, `stubCount === 0`, `leafTotal >= 3`, `externalSpecifiers === []`. Per-`it()` timeout: 30,000 ms.
- `number-int` (`v3/helpers/enumUtil.cjs`): `moduleCount === 1`, `stubCount === 0`, `leafTotal >= 1`, `externalSpecifiers === []`. Per-`it()` timeout: 30,000 ms.
- `array-each` (`v3/standard-schema.cjs`): `moduleCount === 1`, `stubCount === 0`, `leafTotal >= 1`, `externalSpecifiers === []`. Per-`it()` timeout: 30,000 ms.
- **Two-pass byte-identical determinism** per Group B binding (5 × 2 = 10 shaves): `moduleCount`, `stubCount`, `forestTotalLeafCount`, sorted BFS `filePath` list, sorted `externalSpecifiers`, sorted set of every leaf `canonicalAstHash` — byte-identical across passes (per-binding, not aggregated).
- **Each Group B forest persisted via the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path** (NOT `buildTriplet`-on-entry-source shortcut). Each binding's registry has `> 0` blocks after persist; the headline atom is retrievable via `registry.getBlock(<merkle-root>)`.
- **Five distinct atom merkle roots** — reviewer collects the five entry-atom merkle roots from `collectForestSlicePlans` and confirms they are pairwise distinct (the bindings map to five distinct files; their canonical AST hashes should differ).

**§F — combinedScore empirical-floor quality gates (5 describes, `it.skipIf(!USE_LOCAL_PROVIDER)`):**

- Each §F block runs `shavePackage` against its binding's entryPath, persists via `maybePersistNovelGlueAtom` with `withSemanticIntentCard(entry, <behavior-text>)`, then `findCandidatesByQuery({ behavior: <same-text>, topK: 10 })`. Asserts `result.candidates.length > 0` AND `result.candidates[0].combinedScore >= <empirical-floor>` where the empirical floor is captured **at first implementer run** and locked into the test body with a measurement-citing comment. Per `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001`.
- **The implementer's measurement run is recorded in the PR body** for each of the five bindings: `<binding>: <topScore> (assertion floor: <topScore - 0.05>)`. The reviewer confirms the assertion floor is `>= 0.30` (the discovery-eval `not_found` band; anything below means the embedder cannot retrieve the atom at all and the slice is BLOCKED).
- If `DISCOVERY_EVAL_PROVIDER=local` is absent so the §F block skips, **the slice is BLOCKED, not ready** — same rule as Slices 2-7. Reviewer pastes the five scores explicitly.

### 5.3 Required authority invariants

- **The engine is used, not forked.** Slice 8 calls the landed `shavePackage` / `collectForestSlicePlans` / `module-resolver` exports verbatim. **NO engine-source change in `packages/shave/src/universalize/**` (`recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts`).** NO new public API surface in `packages/shave/src/types.ts`. The engine-gap reality is asserted as test data (Group A) and accommodated by helper-file mapping (Group B); it is NOT patched in-slice.
- **B-scope predicate untouched and exercised on first ESM-default-typed fixture.** `isInPackageBoundary` is unchanged. Slice 8 is the first fixture with `"type": "module"`; the engine's merged `extractImportSpecifiers` + `extractRequireSpecifiers` orchestration code at `module-graph.ts:337-341` handles the case correctly because zod's compiled `.cjs` uses `require()` syntax (the ESM `.js` siblings are NOT shaved by Slice 8). If a future Slice 8b shaves the ESM dist (`.js` files), the engine's `extractImportSpecifiers` path will be exercised on production fixture for the first time.
- **One persist authority.** The forest → registry path uses the existing `maybePersistNovelGlueAtom` / `buildTriplet` / idempotent `storeBlock` primitives. Group A describes do NOT persist (the stubs have no novel-glue entries to persist); Group B describes do.
- **Per-entry isolation invariant.** Each of the 4 Group A + 5 Group B describes uses its own `shavePackage` call with its own `entryPath`. No shared `beforeAll`. Any in-registry state created by §E or §F is local to that `describe`'s `await openRegistry(":memory:", ...)` block.
- **Public `types.ts` surface frozen-for-L5.** No public-surface change.
- **`corpus.json` is append-only.** Slice 8 appends **five** new `synthetic-tasks` / `seed-derived` entries (matching the S7 schema variant — see §5.4): `cat1-zod-string-min-001`, `cat1-zod-string-max-001`, `cat1-zod-regex-match-001`, `cat1-zod-number-int-001`, `cat1-zod-array-each-001`. No existing entry modified, no category list edit, no `discovery-eval-full-corpus.test.ts` harness change.
- **Fixture isolation.** The vendored sources live ONLY under `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/`. Biome-ignored, outside `tsc`'s `.js`/`.cjs` scope. The vendored `src/**` TypeScript files are NEITHER imported by tests NOR shaved (the `.cjs` decision per §1.6).
- **Predecessor fixtures untouched.** `validator-13.15.35/**`, `semver-7.8.0/**`, `uuid-11.1.1/**`, `nanoid-3.3.12/**`, `ms-2.1.3/**`, `date-fns-4.1.0/**`, `jsonwebtoken-9.0.2/**`, `bcryptjs-2.4.3/**`, `lodash-4.17.21/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` are read-only for Slice 8. Reviewer spot-checks with `git diff main -- packages/shave/src/__fixtures__/module-graph/` showing exactly one new sibling directory (`zod-3.25.76/`).
- **`vitest.config.ts` unchanged.** `testTimeout=30_000`, `hookTimeout=30_000`. Per-`it()` `{ timeout: 120_000 }` overrides only (for `v3/types.cjs` shaves; matches S7's `cloneDeep` pattern). DEC-WI510-S2-NO-TIMEOUT-RAISE-001 carries forward.
- **No engine-gap silent suppression.** Group A's assertions explicitly lock in `moduleCount=0, stubCount=1` for the four primary entry points. A future engine fix that recovers atoms surfaces as an intentional assertion update (with a fresh DEC), NOT a silent regression. This is the load-bearing invariant for the engine-gap-corroboration test class introduced by Slice 8.

### 5.4 Required integration points

- `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/**` — full vendored zod fixture + `PROVENANCE.md` (596 tarball files + `PROVENANCE.md` = 597 files). Required.
- `packages/shave/src/universalize/zod-headline-bindings.test.ts` — new Slice 8 test file (4 Group A describes + 5 Group B describes + 1 compound interaction test + 5 §F quality-gate describes = ~15 top-level `describe`/`it` blocks). Required.
- `packages/registry/test/discovery-benchmark/corpus.json` — append five entries (suggested query strings; the implementer may refine wording to match the embedder's known-good idioms, the reviewer signs off on final wording):
  - `cat1-zod-string-min-001` — query: "Validate that a string has at least a specified minimum length using a chainable schema builder, producing a structured issue when the input is shorter than the minimum"
  - `cat1-zod-string-max-001` — query: "Validate that a string does not exceed a specified maximum length using a chainable schema builder, producing a structured issue when the input is longer than the maximum"
  - `cat1-zod-regex-match-001` — query: "Validate that a string matches a regular expression pattern using a chainable schema builder, producing a structured issue with a custom error message when the input does not match"
  - `cat1-zod-number-int-001` — query: "Validate that a number is an integer (no fractional component) using a chainable schema builder, producing a structured issue when the input is not an integer"
  - `cat1-zod-array-each-001` — query: "Validate each element of an array against a per-element schema using a chainable schema builder, producing per-index structured issues when individual elements fail validation"
  - Each row matches the S7 schema variant: `"source": "seed-derived"`, `"category": "behavior-only"`, `"expectedAtom": null`, `"expectedAtomName": "zod-<binding>"`, `"rationale": "Behavior-only query for zod/<binding> (WI-510 Slice 8). ENGINE-GAP-MAPPED: <binding> source lives in v3/types.cjs which the engine cannot atomize (DEC-WI510-S8-HELPER-FILE-MAPPING-001); the atom is the working helper file <helper-path> the binding semantically depends on. combinedScore empirical floor measured at implementation per DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001."`
  Append-only. Required.
- `plans/wi-510-s8-zod.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only (mark Slice 8 as in-progress / landed). No permanent-section edits. Allowed.
- `tmp/wi-510-s8/**` — planner scratch (tarball + extracted `v3/package/` tree + probe scripts already executed). Implementer may use the same directory for re-acquisition and re-running probe verification; not part of the commit.

### 5.5 Forbidden shortcuts

- **No engine source change in `packages/shave/src/universalize/**`.** Engine is frozen after Slice 1. The new engine-gap (TS-compiled CJS prelude defeats strict-subset; multi-class monolith atomization failure) is **filed by the orchestrator as a separate engine-gap issue once Slice 8 lands**, NOT patched in-slice. Slice 8 stops and reports if the implementer is tempted to patch.
- **No `vitest.config.ts` timeout raise.** Per-`it()` overrides ONLY. `v3/types.cjs` describes use `{ timeout: 120_000 }` (single-call) or `{ timeout: 360_000 }` (two-pass); helper describes use `{ timeout: 60_000 }` or `{ timeout: 30_000 }`. Anything beyond per-`it()` is forbidden.
- **No shared `beforeAll` across Group A / Group B / §F describes.** Per-entry isolation invariant from Slices 2-7 carries forward.
- **No hand-authored zod atoms.** The Group B atoms are the engine's output from vendored compiled source. The Group A "atoms" are explicitly stubs the test asserts (the engine emits a `ModuleStubEntry`; the test confirms it; there is no novel-glue atom to persist for Group A). Sacred Practice 12.
- **No single-source-`buildTriplet` shortcut for the persist check.** §5.2's combinedScore gates and the §5.1 per-binding §E persist checks must run through the real `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path.
- **No `discovery-eval-full-corpus.test.ts` / registry-schema edit.** Constitutional; Slice 8 only appends corpus rows.
- **No silent assertion loosening to mask engine-gap.** If the empirical engine output differs from §3.2/§3.3 (e.g. `v3/types.cjs` does NOT stub, OR `v3/helpers/util.cjs` DOES stub), that is a stop-and-report event. The implementer investigates (engine version drift? fixture vendoring error?), documents, and either updates the assertion with a citation comment OR files a new engine bug.
- **No reach into predecessor fixtures.** `validator-13.15.35/`, `semver-7.8.0/`, `uuid-11.1.1/`, `nanoid-3.3.12/`, `ms-2.1.3/`, `date-fns-4.1.0/`, `jsonwebtoken-9.0.2/`, `bcryptjs-2.4.3/`, `lodash-4.17.21/`, `circular-pkg/`, `degradation-pkg/`, `three-module-pkg/` are read-only for Slice 8.
- **No new fixture vendoring beyond `zod-3.25.76`.** Slice 9 (`p-limit`/`p-throttle`) remains out of scope. **joi remains out of scope** per `DEC-WI510-S8-JOI-DEFERRED-001`.
- **No vendoring of zod v4 alongside zod v3 in this slice.** A future "Slice 8c — zod v4" iteration adds `zod-4.4.3/` as a separate sibling fixture.
- **No shaving of TypeScript source under `zod-3.25.76/src/**`.** §1.6 / `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001` — compiled `.cjs` ONLY. The vendored `src/**` files exist for fidelity-with-real-tarball reasons (mirrors how Slice 7 retains `lodash.js` UMD bundle in the trimmed vendor as a sentinel even though no test shaves it) but are NOT traversed by any `entryPath` Slice 8 uses.
- **No shaving of zod's ESM `.js` siblings.** The compiled `.js` bundles use modern ESM `import`/`export` syntax which routes through `extractImportSpecifiers` rather than `extractRequireSpecifiers`. The merged-extractor orchestration code (`module-graph.ts:337-341`) handles both, but Slice 8's empirical probes were done against `.cjs` entries only; switching to `.js` would invalidate the §3.2/§3.3 assertion data. A future Slice 8d may exercise the `.js` ESM path explicitly.
- **No assertion against fixed `>= 0.70` combinedScore for Group B headlines.** The §F assertions use the empirical-floor pattern per `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001`. Asserting a fixed 0.70 floor (matching Slices 2-7) is impossible here because the binding-bearing source text is NOT in the helper-file atoms.
- **No `void (async () => {...})()` patterns in test files.** Per PR #566 / issue inheriting through Slices 3-7: the shave engine cannot atomize `VoidExpression` of an IIFE. Test orchestration uses plain `await`-in-`async`-`it()`. If parallelism is desired, use `queueMicrotask`.
- **No skipping `pnpm biome format --write` before commit.** Per Slice 3 lesson learned from PR #570: local turbo cache can hide format violations CI catches. Run on the new test file + the corpus.json edit + the plan status update before staging.
- **No `Closes #510`** in the PR description. Slice 8 of 9; use `Refs #510 (Slice 8 of 9)` only.
- **No cross-package relative imports.** Test imports use `@yakcc/registry`, `@yakcc/contracts` workspace aliases. NO `../../../../packages/registry/...` style (per `feedback_no_cross_package_imports.md`).
- **No package-scoped lint/typecheck as proof of CI green.** Per `feedback_eval_contract_match_ci_checks.md`: `pnpm --filter @yakcc/shave lint` passing is necessary but not sufficient; the contract requires `pnpm -w lint` AND `pnpm -w typecheck` PASTED in the PR body.

### 5.6 Ready-for-Guardian definition (Slice 8)

Slice 8 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in `module-graph.test.ts`, `validator-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, `uuid-headline-bindings.test.ts`, `nanoid-headline-bindings.test.ts`, `date-fns-headline-bindings.test.ts`, `jsonwebtoken-headline-bindings.test.ts`, `bcryptjs-headline-bindings.test.ts`, `lodash-headline-bindings.test.ts`, and the rest of the existing shave suite.
2. **WORKSPACE-WIDE** `pnpm -w lint` (`turbo run lint`) AND `pnpm -w typecheck` (`turbo run typecheck`) are clean across all packages — reviewer pastes BOTH outputs (package-scoped passing is necessary but NOT sufficient; the CI failure pattern from `feedback_eval_contract_match_ci_checks.md`).
3. **Group A engine-gap evidence in the PR body and §11 of this plan:** for each of the four primary entry points (`index.cjs`, `v3/external.cjs`, `v3/types.cjs`, `v3/index.cjs`), the implementer records `moduleCount` (must be `0`), `stubCount` (must be `1`), `externalSpecifiers` (must be `[]`), the stub specifier path (must end in the entry file name), and the wall-clock time. `v3/types.cjs` is the marker assertion: wall-clock empirically ~69s; if `<10s` or `>120s` that is a stop-and-report event.
4. **Group B per-headline measurement evidence in the PR body and §11:** for each of the five binding shaves, the implementer records `moduleCount`, `stubCount`, `forestTotalLeafCount`, the BFS-ordered `filePath` list, the **merkle root of the headline binding's atom**, the **externalSpecifiers list** (must be `[]`), and the wall-clock time of that headline's `shavePackage` invocation. The §3.3 numbers are the reviewer's anchor; the empirical values are the source of truth.
5. **Each Group B per-headline test completes in <60 seconds wall-clock** (with the test's per-`it()` override). `string-min` and `string-max` are the most likely to approach this; the reviewer accepts up to 60s for those bindings with measurement evidence. Group A's `v3/types.cjs` is the only individual test allowed up to 120s.
6. **Two-pass byte-identical determinism** per binding (5 Group B + 4 Group A = 9 describes each running two passes). Reviewer confirms the byte-identical assertion passes for all 9.
7. **`combinedScore >= <empirical-floor>` (>= 0.30 hard minimum) for EACH of the five Group B corpus query strings**, measured via `findCandidatesByQuery` against a registry populated by the engine's own real-path `storeBlock` output — quality block(s) **ran (NOT skipped)**, reviewer pastes the five per-query scores. The empirical-floor pattern per `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001` is recorded with the implementer's measurement run and locked into the test body. If `DISCOVERY_EVAL_PROVIDER=local` is absent so the §F block skips, the slice is **BLOCKED, not ready**.
8. Each Group B forest is persisted via the **real** `collectForestSlicePlans` → `maybePersistNovelGlueAtom` per-leaf path — NOT the single-source-`buildTriplet` shortcut. Each `describe`'s `persistedCount > 0`.
9. `corpus.json` carries exactly the five appended entries with the schema specified in §5.4 (matching S7's `"source": "seed-derived"` + `"expectedAtomName": "zod-<binding>"` form), no existing entry modified, and `discovery-eval-full-corpus.test.ts` still passes (the per-category `>= 8` invariant is comfortably satisfied — `cat1` has many more rows than 8 after Slices 1-7).
10. `packages/shave/vitest.config.ts` is unchanged.
11. **Predecessor fixtures untouched.** Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/` shows exactly one new sibling directory (`zod-3.25.76/`) added next to the existing twelve. No diff in any other fixture directory.
12. **`externalSpecifiers === []` proven across all nine shaves** (4 Group A + 5 Group B). Reviewer confirms via §5.2 assertions and PR body output paste.
13. **Five distinct atom merkle roots for the Group B headlines** — reviewer collects the five entry-atom merkle roots from `collectForestSlicePlans` and confirms pairwise distinctness (the five bindings map to five distinct files; the canonical AST hashes must differ).
14. **`v3/types.cjs` stub evidence captured for the new engine-gap issue.** The implementer records the empirical evidence (`moduleCount=0, stubCount=1, wall=~69s`, file SHA of the vendored `v3/types.cjs`) in a comment block at the top of the Group A `v3/types.cjs` describe AND in the PR body, formatted suitably for the orchestrator to file the new engine-gap issue after Slice 8 lands. Per `DEC-WI510-S8-ENGINE-GAPS-EXERCISED-001`.
15. **New `@decision` annotations are present at the Slice 8 modification points** (the test file's top-of-file decoration block; the `PROVENANCE.md` cites the DEC IDs). New DEC IDs per §8.

---

## 6. Scope Manifest — Slice 8

**Allowed paths (implementer may touch):**
- `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/**` — full vendored zod fixture + `PROVENANCE.md`. Pure tarball acquisition + extraction + verbatim copy.
- `packages/shave/src/universalize/zod-headline-bindings.test.ts` — new Slice 8 test file (Group A + Group B + §F + compound describes).
- `packages/registry/test/discovery-benchmark/corpus.json` — append five entries. Append-only.
- `plans/wi-510-s8-zod.md` — this plan. Owner.
- `plans/wi-510-shadow-npm-corpus.md` — one-paragraph status update only. No permanent-section edits.
- `tmp/wi-510-s8/**` — scratch (tarball + extracted package + probe scripts the planner already ran). Implementer may use the same directory for re-verification; NOT committed.

**Required paths (implementer MUST modify):**
- `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/**` — the full vendored zod fixture tree (596 tarball files + `PROVENANCE.md`).
- `packages/shave/src/universalize/zod-headline-bindings.test.ts` — the new zod test file.
- `packages/registry/test/discovery-benchmark/corpus.json` — the five appended entries.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/vitest.config.ts` — `testTimeout=30_000` / `hookTimeout=30_000` defaults carry forward DEC-WI510-S2-NO-TIMEOUT-RAISE-001 verbatim.
- `packages/shave/src/universalize/recursion.ts`, `slicer.ts`, `module-resolver.ts`, `module-graph.ts`, `types.ts`, `stef.ts`, `variance-rank.ts`, `atom-test.ts` — the entire engine surface. Frozen after Slice 1.
- `packages/shave/src/universalize/validator-headline-bindings.test.ts` — Slice 2 test file.
- `packages/shave/src/universalize/semver-headline-bindings.test.ts` — Slice 3 test file.
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts` — Slice 4 test file.
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts` — Slice 5 test file.
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts` — Slice 6 test file.
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts` — Slice 6 test file.
- `packages/shave/src/universalize/lodash-headline-bindings.test.ts` — Slice 7 test file.
- `packages/shave/src/universalize/module-graph.test.ts` — Slice 1 engine tests.
- `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/**` — Slice 2 fixture.
- `packages/shave/src/__fixtures__/module-graph/semver-7.8.0/**` — Slice 3 fixture.
- `packages/shave/src/__fixtures__/module-graph/uuid-11.1.1/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/nanoid-3.3.12/**` — Slice 4 fixture.
- `packages/shave/src/__fixtures__/module-graph/date-fns-4.1.0/**` — Slice 5 fixture.
- `packages/shave/src/__fixtures__/module-graph/jsonwebtoken-9.0.2/**` — Slice 6 fixture.
- `packages/shave/src/__fixtures__/module-graph/bcryptjs-2.4.3/**` — Slice 6 fixture.
- `packages/shave/src/__fixtures__/module-graph/lodash-4.17.21/**` — Slice 7 fixture.
- `packages/shave/src/__fixtures__/module-graph/ms-2.1.3/**`, `circular-pkg/**`, `degradation-pkg/**`, `three-module-pkg/**` — Slice 1 fixtures.
- `packages/shave/src/types.ts` — frozen-for-L5 public surface.
- `packages/shave/src/persist/**` — used by the test; not modified.
- `packages/shave/src/cache/**`, `packages/shave/src/intent/**` — used by the test (existing `withStubIntentCard` / `withSemanticIntentCard` helper patterns consume `sourceHash`, `STATIC_MODEL_TAG`, `STATIC_PROMPT_VERSION`); not modified.
- `packages/ir/**`, `packages/contracts/**` — constitutional (`validateStrictSubset`, `blockMerkleRoot`, `canonicalAstHash`, embedding providers).
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/test/discovery-benchmark/discovery-eval-full-corpus.test.ts` — constitutional registry surface and discovery-eval harness.
- `packages/seeds/src/blocks/**` and all existing seed atoms — Slice 8 produces atoms via the engine; hand-authors nothing.
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**`, `examples/**`, `.worktrees/**` — adjacent lanes (#508, #512, benches) outside Slice 8's scope.
- `biome.json` — already covers `__fixtures__/module-graph/**`; no change needed.
- `MASTER_PLAN.md` — permanent sections untouched.
- All other `plans/*.md` files — Slice 8 owns only `plans/wi-510-s8-zod.md` and the one-paragraph status update on `plans/wi-510-shadow-npm-corpus.md`.

**Expected state authorities touched:**
- **Shave module-graph engine** — canonical authority: the landed `shavePackage()` / `collectForestSlicePlans()` in `module-graph.ts`, `decompose()` in `recursion.ts`, `slice()` in `slicer.ts`. Slice 8 **calls** these with an explicit `entryPath` option per Group A entry point and per Group B headline; does not fork, modify, or extend them.
- **Module resolver — B-scope predicate** — canonical authority: `isInPackageBoundary()` and `resolveSpecifier()` in `module-resolver.ts`. Slice 8 **exercises** the predicate on the first ESM-default-typed fixture (`"type": "module"` package shaved via `.cjs` entry points). The orchestration code at `module-graph.ts:337-341` correctly merges `extractImportSpecifiers` + `extractRequireSpecifiers` results; Slice 8's `.cjs` shaves stay on the `extractRequireSpecifiers` path.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and idempotent `storeBlock()` (`@yakcc/registry`), reached via `maybePersistNovelGlueAtom` / `buildTriplet`. Slice 8 produces five distinct binding-mapped atoms (Group B); Group A's stubs do NOT have novel-glue entries to persist.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 8 appends five entries.
- **Vitest test-execution discipline** — canonical authority: `packages/shave/vitest.config.ts`. Slice 8 does not modify; per-`it()` `{ timeout: 30_000 | 60_000 | 120_000 | 360_000 }` overrides ONLY (with measurement-citing comments).
- **Fixture directory** — canonical authority: `packages/shave/src/__fixtures__/module-graph/`. Slice 8 adds one sibling directory (`zod-3.25.76/`) next to the existing twelve.
- **Engine-gap evidence corpus** — NEW state authority introduced by Slice 8 (Group A test class): the test file's Group A describes ARE the canonical record of the engine's current behavior on TS-compiled CJS preludes / multi-class monoliths. A future engine fix updates these assertions intentionally (with a new DEC); a regression breaks them.

---

## 7. Slicing / dependency position

Slice 8 is a single work item. Dependencies: **Slices 1-7 all landed on `main`** (PRs #526, #544, #570+#571, #573, #584, #586, #598). Slice 8 imports no Slice 2-7 source; its test file is a structural sibling-by-copy of `lodash-headline-bindings.test.ts` (S7), extended with the new Group A engine-gap-corroboration describe class.

Downstream consumers: none currently named. The shadow-npm corpus expansion (#510) listing zod as Slice 8 is the proximate consumer; the triad (#508, #512) currently focuses on the validator headline bindings — zod atoms are corpus completeness, not the next demo binding. Slice 9 (`p-limit`/`p-throttle`) depends only on Slice 1 (engine proven), not on Slice 8.

- **Weight:** **M-to-L** (one full-tarball fixture vendored with 596 files + nine entryPath shaves [4 stub Group A + 5 working Group B] + test orchestration for nine describes + first ESM-default-typed fixture + new Group A engine-gap-corroboration test class + empirical-floor combinedScore pattern + one new GitHub engine-gap issue to be filed by orchestrator). Heavier than Slice 6 (jsonwebtoken+bcryptjs at M weight) because of the empirical-engine-probe novelty + the realistic-combinedScore pattern; lighter than Slice 7 (lodash at M-to-L weight) because the per-headline subgraphs are smaller.
- **Gate:** **`review`** (no engine source change; no public-surface change; no constitutional file touched; the engine-gap-corroboration pattern and empirical-floor combinedScore are constitutional decisions but baked into the per-slice DECs rather than requiring user approval at implementation time — provided the operator accepts the dispatch-contract pre-authorization that engine-reality slices are valid; see §3.8 for the one explicit operator-attention point).
- **Landing policy:** default grant — branch checkpoint allowed, reviewer handoff allowed, autoland allowed once `ready_for_guardian`, `no_ff` merge.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-S8-VERSION-PIN-001` | Pin to `zod@3.25.76` (head of v3 line; NOT the current `latest` `4.4.3`) | Most-deployed dominant version (consistent with `DEC-WI510-S7-VERSION-PIN-001` lodash precedent — pick what npm lockfiles actually resolve to, not the latest publish). Cleaner structural shape than v4 (no nested `v4/classic`; 88 vs 105 `.cjs` files; 4.8MB vs 5.9MB). v3 layout exists IDENTICALLY inside v4 — Slice 8's engine-gap analysis carries forward unchanged to a future Slice 8c zod-v4 iteration. `"type": "module"` is a NEW WI-510 fixture property exercising the engine's ESM extractor path in production for the first time. |
| `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001` | Shave compiled `.cjs` bundles, NOT TypeScript source under `src/**` | Tracks production runtime (a user who does `require('zod')` loads `zod/index.cjs`). The engine handles `.cjs` identically to `.js` via `EXTENSION_PROBE_ORDER`. TypeScript source has the SAME engine-gap on `types.ts` (empirical §3.4: `src/v3/types.ts` 5,136 lines stubs out in 81s, same as compiled `v3/types.cjs` 3,775 lines in 69s). Switching to source recovers no binding atoms and adds .ts-vs-.cjs ambiguity to merkle roots. Lodash modular-not-bundled precedent applies. |
| `DEC-WI510-S8-FIXTURE-FULL-TARBALL-001` | Vendor the full `zod-3.25.76` published tarball verbatim (596 files, ~4.8MB) | Inherits Slices 3/4/6 full-tarball rationale chain (`DEC-WI510-S3-FIXTURE-FULL-TARBALL-001`, etc.). Trimming would not reduce engine wall-clock (the binding-bearing monolith is engine-opaque regardless) and would risk mis-identifying which helper transitives the Group B shaves need. 4.8MB is within the WI-510 vendor-size band; `isInPackageBoundary` scopes traversal so unreferenced files cost zero. |
| `DEC-WI510-S8-ENGINE-GAP-DELIVERABLE-001` | Slice 8's deliverable is engine-gap-honest: assert empirical stub state for binding-bearing monolith + ship working-helper atoms as binding approximations + file new engine-gap issue post-land | The binding-bearing logic lives in `v3/types.cjs` which the engine cannot atomize (empirical §3.2). Per the dispatch-contract pre-authorization ("If #576 IS exercised, the slice is still valid: document the engine-gap with empirical evidence, ship with the engine's actual output as the assertion, and cross-reference the bug. Do NOT block the slice on engine work (engine is frozen post-S1)."), Slice 8 ships engine reality: Group A tests pin the stub state; Group B tests ship five distinct atoms from small helper files that DO decompose; the orchestrator files a new engine-gap issue post-land. The slice does NOT block on the engine fix. |
| `DEC-WI510-S8-HELPER-FILE-MAPPING-001` | Five issue-body bindings (`string-min`/`string-max`/`regex-match`/`number-int`/`array-each`) map to five small zod helper files the engine CAN decompose | The "ideal" entry (method-on-class in `v3/types.cjs`) is engine-opaque. The "available" entry (small helper file the binding semantically depends on) is engine-tractable. Mapping per §1.3 table: `string-min → v3/helpers/util.cjs` (runtime helpers), `string-max → v3/helpers/parseUtil.cjs` (parse pipeline), `regex-match → v3/helpers/errorUtil.cjs` (error shape), `number-int → v3/helpers/enumUtil.cjs` (distinct leaf), `array-each → v3/standard-schema.cjs` (StandardSchema interop). Documented loudly as engine-gap approximations; corpus row `rationale` makes the engine-gap basis explicit. A future engine-fix slice re-attributes the corpus rows to the new binding-bearing atoms. |
| `DEC-WI510-S8-ENGINE-GAP-CORROBORATION-TESTS-001` | Group A introduces a new test class: engine-gap corroboration tests that pin the empirical stub state for binding-bearing files | Four `describe` blocks (`index.cjs`, `v3/external.cjs`, `v3/types.cjs`, `v3/index.cjs`) assert `moduleCount=0, stubCount=1, externalSpecifiers=[]` plus stub-specifier-path identity. These tests LOCK IN the engine's current behavior so a future fix that recovers atoms surfaces as an intentional assertion update (with a fresh DEC), NOT a silent regression. Distinct from Group B (which ships working atoms). Sister class to the existing positive-shave tests in Slices 2-7. |
| `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001` | combinedScore quality gates use empirical-measured floors per-binding (>= 0.30 hard minimum), NOT the fixed `>= 0.70` of Slices 2-7 | The Group B atoms do NOT contain the binding-bearing source text (that lives in the engine-opaque monolith). Embedding similarity between e.g. `util.cjs`'s atom and "Validate string min length" is expected in the 0.30-0.55 range. Fixed 0.70 would be a fiction. Implementer runs each §F test once, records the empirical top-candidate `combinedScore`, asserts `>= empirical - 0.05`. >= 0.30 is the hard minimum (the discovery-eval `not_found` band floor); below that the slice is BLOCKED. PR body records each of the five values explicitly so the operator sees engine-gap retrieval impact. A future engine-fix slice re-tightens the floor to 0.70 once binding-bearing atoms exist. |
| `DEC-WI510-S8-ENGINE-GAPS-EXERCISED-001` | Slice 8 exercises both #576 (ArrowFunctions in class bodies) at maximum scale AND a NEW engine-gap (TS-compiled CJS prelude defeats strict-subset on multi-class monoliths) | Empirical scan of zod-3.25.76: 4 of 4 primary entry points stub due to TS-compiled CJS prelude; `v3/types.cjs` (39 classes + 131 arrow tokens) stubs due to compound effect. Distinct from #585 (UMD IIFE) — zod uses `__exportStar`/`__importStar`, not UMD. The new engine-gap is filed by orchestrator as a separate GitHub issue post-land (analogous to how Slice 6 PR #586 caused issue #585 to be filed). Single-class files DO atomize (`ZodError.cjs` empirical proof, §3.5). |
| `DEC-WI510-S8-EXTERNAL-SPECIFIERS-EMPTY-001` | Expected `externalSpecifiers = []` across all nine Slice 8 describes (4 Group A + 5 Group B) | The 5 Group B helper files contain no top-level external `require()`. The 4 Group A entry points stub before any `require()` walking. zod@3.25.76 has zero npm dependencies. If non-empty for any of the nine, that is a stop-and-report event (engine behavior change or fixture-vendoring error). |
| `DEC-WI510-S8-JOI-DEFERRED-001` | joi is deferred to a later "S8b" or production-corpus iteration; Slice 8 ships zod-only | Operator decision pre-taken per dispatch contract; do not re-litigate. Rationale: (1) separately-shaped builder DSL (joi `AnySchema` vs zod `ZodType`), (2) joi@17 ships 9 npm runtime dependencies creating a wider external fan-out than Slice 6's jsonwebtoken (also 10 deps but shallower), (3) S8 wall-clock budget would push to >20 min if joi added, (4) a clean "S8b joi headline atomization" or "production-corpus validator-DSL tranche (zod+joi+yup+ajv)" follow-on path exists. Does NOT block on Slice 8. |

These DECs are recorded in `@decision` annotation blocks at the Slice 8 modification points (primarily the test file; the `PROVENANCE.md` cites the DEC IDs). If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — NOT part of this slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| The empirical-floor combinedScore pattern is operator-rejected — the operator wants Slice 8 blocked on `>= 0.70` matching Slices 2-7. | §3.8 flags this explicitly as the one operator-attention DEC. If pre-implementation operator feedback says "no, must be 0.70," Slice 8 is deferred until an engine fix exists; the orchestrator surfaces `needs_user_decision`. The dispatch contract pre-authorizes the empirical-floor approach, so the default path is to proceed. The PR body's per-binding combinedScore record gives the operator clear visibility to re-decide post-land if desired. |
| `v3/types.cjs` does NOT stub at engine evaluation time — engine version drift since planner's empirical probe recovers atoms. | Group A's stub-state assertion would fail loudly. The implementer investigates: (a) was there an engine change since planner ran? (b) was the empirical probe environment different? Either way it is a stop-and-report event. If the engine has been fixed, Slice 8 reframes: Group A asserts the NEW recovery shape (with a fresh DEC); Group B reconsiders the helper-file-mapping; corpus rows may re-attribute to binding-bearing atoms. The reviewer signs off on the reframe before landing. |
| A Group B helper file (e.g. `v3/helpers/util.cjs`) STARTS stubbing at engine evaluation time — empirical recovery from §3.3 doesn't hold. | The §5.2 assertion fails loudly. Implementer reproduces locally; if confirmed, surfaces as a new engine-gap issue and either (a) finds an alternative working helper file the binding can map to (and updates `DEC-WI510-S8-HELPER-FILE-MAPPING-001`), or (b) collapses the affected binding into Group A's stub-corroboration class (4 → 5 Group A describes, 5 → 4 Group B describes; corpus row reattributed accordingly). |
| The five Group B atoms are too semantically distant from the binding queries — empirical combinedScore falls below the 0.30 hard minimum for one or more bindings. | The §5.6 criterion 7 makes this a BLOCKED state. Implementer investigates: (a) try alternative helper-file mappings (e.g. `string-min → v3/helpers/parseUtil.cjs` instead of `util.cjs`), (b) refine the corpus query string to better match the helper-file content (without crossing into fiction — the rationale field must still honestly describe the engine-gap basis), (c) escalate to the operator if no helper-file mapping produces a >= 0.30 combinedScore — that is genuinely a slice-blocking finding. |
| `v3/types.cjs`'s 69-second `decompose()` wall-clock regresses to >120s under engine-version drift or different machine specs. | §5.6 criterion 3 makes this a stop-and-report event. Reviewer accepts up to 120s with measurement evidence; above that the implementer files a Slice 1 engine performance concern (separate issue) and stops. NOT a Slice 8 acceptance failure to mask. |
| The Group A engine-gap-corroboration tests are themselves brittle to vitest-version drift, ts-morph-version drift, or non-determinism in the stub-emission path. | Two-pass byte-identical determinism (§5.2) is required for Group A. If the stub state varies non-deterministically, that is itself an engine bug worth filing (the stub path must be deterministic to be a valid corroboration target). Two-pass failure is a stop-and-report event. |
| The implementer mistakes `src/**` TypeScript sources for shave targets (looks easier than chasing compiled `.cjs`). | §5.5 explicitly forbids shaving `src/**` `.ts` files. §3.4 empirical evidence shows source has the same engine-gap. `DEC-WI510-S8-COMPILED-CJS-NOT-TS-SOURCE-001` documents the rationale. Reviewer spot-checks every `entryPath` in the test file ends in `.cjs`. |
| The implementer accidentally shaves the ESM `.js` siblings instead of `.cjs` (probeFile order, copy-paste error from a future slice draft). | §5.5 forbids the `.js` shave. The empirical-probe data in §3.2/§3.3 was collected against `.cjs`; `.js` may produce different results because `extractImportSpecifiers` takes a different code path than `extractRequireSpecifiers`. Reviewer asserts every `entryPath` value in the test file matches one of the nine planned paths exactly. |
| The implementer adds `joi-17.x/` vendored fixture inadvertently (slice scope creep). | §5.5 explicitly forbids new fixtures beyond `zod-3.25.76`. `DEC-WI510-S8-JOI-DEFERRED-001` is constitutional for Slice 8. Reviewer spot-checks `git diff main -- packages/shave/src/__fixtures__/module-graph/` shows exactly one new sibling directory. |
| The orchestrator forgets to file the new engine-gap issue post-land — the engine-gap evidence rots without action. | §5.6 criterion 14 requires the implementer to embed the evidence in a Group A `v3/types.cjs` describe top-of-file comment AND the PR body, formatted for direct issue filing. The orchestrator's continuation logic (after Guardian lands Slice 8) inspects the PR body / plan §11 and files the issue as a follow-up `next_work_item` task. The implementer flags it explicitly in the PR body's "follow-ups" section. |
| The empirical-floor combinedScore values change run-to-run because the embedder is sensitive to atom-source-content microstate changes. | Two-pass determinism per Group B binding (§5.2) requires byte-identical leaf canonical hashes — the atom content IS deterministic. If embedder output varies across runs given identical atom content, that is an embedder-determinism bug (file separately). The §F test asserts the floor with `>= empirical - 0.05` headroom precisely to absorb minor float-precision noise. |
| `pnpm install` in the new worktree changes lockfile contents and CI fails on stale-lockfile check. | The fresh-install at planning time used the existing `pnpm-lock.yaml`. The implementer runs `pnpm install` only when needed and pastes `git status` before staging to confirm `pnpm-lock.yaml` is NOT modified by the slice. If it IS modified, investigate before staging — likely a workspace-dependency drift independent of Slice 8. |
| The five `corpus.json` entries fail the `discovery-eval-full-corpus.test.ts` per-category invariants (>=8-per-category, positive+negative balance). | `cat1` is well-populated after Slices 1-7 (estimated >40 rows). Appending 5 more puts it at >45. The >=8 invariant is comfortably satisfied. Positive+negative balance applies only to entries with `expectedAtom` set — Slice 8's five new entries have `expectedAtom: null` (`source: "seed-derived"` matching the S7 schema variant), so they are neither positive nor negative for that balance check. |
| The vendored 4.8MB fixture inflates the package's test-runtime working set noticeably. | Same property as Slice 6 (60+100KB) and Slice 7 (120KB trimmed of 1.4MB) — vendored fixtures are biome-ignored, outside tsc scope, loaded by tests on-demand. The 4.8MB does not enter the runtime npm package surface; it is committed source for the test fixture only. |
| Implementer reaches for `void (async () => {...})()` IIFE pattern in test orchestration and hits the VoidExpression atomization gap. | §5.5 forbids the pattern explicitly. All test orchestration uses plain `await`-in-`async`-`it()`. |
| Implementer skips `pnpm biome format --write` before commit → local turbo cache hides format violations → CI fails on the PR. | §5.5 explicitly requires `pnpm biome format --write` on the new test file + corpus.json edit + plan status update before staging. |
| `pnpm pack zod@3.25.76` produces a different tarball SHA than the planner's reference (npm re-publish / mirror drift). | The implementer's PROVENANCE.md records the implementer's actual tarball file count + unpacked size, not the planner's reference SHA. If counts diverge meaningfully (e.g. file count differs by more than ±5), investigate before vendoring. zod@3.25.76 is a published-and-immutable npm version; counts should match within negligible variance. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **joi.** Deferred per `DEC-WI510-S8-JOI-DEFERRED-001`. A future "S8b" or production-corpus validator-DSL tranche owns joi.
- **zod v4 (`4.4.3`).** A future "Slice 8c" iteration adds `zod-4.4.3/` as a separate sibling fixture. The engine-gap conclusions Slice 8 documents carry forward unchanged because v3's structure is nested identically inside v4.
- **zod-mini, zod ESM `.js` siblings, zod `src/**` TypeScript sources.** Out of scope. Future slices may exercise these paths.
- **Engine fixes for the new TS-compiled-CJS-prelude / multi-class-monolith gap.** Engine is frozen post-S1. Slice 8 ships engine reality; the new gap is filed as a separate issue post-land.
- **Engine fixes for #576 (ArrowFunctions in class bodies at scale).** Same.
- **Other 9 issue-body packages from #510 (Slice 9: p-limit, p-throttle).** Out of scope.
- **A whole-package shave path** (calling `shavePackage(<zod-fixture-root>, { registry })` without an `entryPath` override). Forbidden — §5.5.
- **Any engine-source change in `packages/shave/src/universalize/**`.** Frozen post-S1.
- **`vitest.config.ts` adjustments.** Forbidden touch point.
- **`MASTER_PLAN.md` initiative registration.** Doc-only slice the orchestrator dispatches separately if/when the user wants it.
- **The import-intercept hook (`#508`).** Separate WI; Slice 8 produces the engine-gap-mapped zod atoms in the corpus.
- **The B10 bench (`#512`).** Separate WI; zod atoms are corpus completeness, not the demo path.
- **Retroactive re-attribution of S8's corpus rows to binding-bearing atoms once an engine fix exists.** That is the engine-fix slice's job; Slice 8 only sets up the corpus rows + DECs that make the re-attribution mechanical (the row IDs `cat1-zod-<binding>-001` stay; the `rationale` field is updated; the `expectedAtomName` may change).

---

## 11. Implementer Measurement-Evidence Section (template for PR body and post-implementation status update)

The implementer fills this section in this plan AND the PR body once the test runs are complete. Reviewer uses these values to confirm §5.6 readiness.

**Group A — engine-gap corroboration (each must show `moduleCount=0, stubCount=1, externalSpecifiers=[]`):**

| Entry | `moduleCount` | `stubCount` | Stub specifier path tail | Wall-clock (s) | Two-pass identical |
|---|---|---|---|---|---|
| `index.cjs` | _ | _ | `…/zod-3.25.76/index.cjs` | _ | _ |
| `v3/external.cjs` | _ | _ | `…/zod-3.25.76/v3/external.cjs` | _ | _ |
| `v3/types.cjs` | _ | _ | `…/zod-3.25.76/v3/types.cjs` | ~69 (planner) | _ |
| `v3/index.cjs` | _ | _ | `…/zod-3.25.76/v3/index.cjs` | _ | _ |

**Group B — five working-helper binding atoms (each must show `moduleCount>=1, stubCount in expected range, leafTotal>0, externalSpecifiers=[]`):**

| Binding | Entry | `moduleCount` | `stubCount` | `leafTotal` | Entry-atom merkle root | Wall-clock (s) | Two-pass identical |
|---|---|---|---|---|---|---|---|
| string-min | `v3/helpers/util.cjs` | _ | _ | _ | _ | _ | _ |
| string-max | `v3/helpers/parseUtil.cjs` | _ | _ | _ | _ | _ | _ |
| regex-match | `v3/helpers/errorUtil.cjs` | _ | _ | _ | _ | _ | _ |
| number-int | `v3/helpers/enumUtil.cjs` | _ | _ | _ | _ | _ | _ |
| array-each | `v3/standard-schema.cjs` | _ | _ | _ | _ | _ | _ |

**Five distinct merkle roots confirmed pairwise:** _yes / no_

**§F combinedScore empirical floors (per `DEC-WI510-S8-COMBINED-SCORE-EMPIRICAL-FLOOR-001`):**

| Binding | Top-candidate `combinedScore` | Test assertion floor | >= 0.30 hard minimum? |
|---|---|---|---|
| string-min | _ | _ - 0.05 | _ |
| string-max | _ | _ - 0.05 | _ |
| regex-match | _ | _ - 0.05 | _ |
| number-int | _ | _ - 0.05 | _ |
| array-each | _ | _ - 0.05 | _ |

**Workspace-wide gates:** `pnpm -w lint` and `pnpm -w typecheck` paste (both must be clean):

```
[implementer pastes the workspace-wide outputs here]
```

**New engine-gap issue evidence (for orchestrator to file post-land):**

- File: `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/v3/types.cjs`
- File SHA: _ (sha256)
- Line count: 3,775
- Class count: 39
- Arrow-function token count: 131
- Engine emission: `moduleCount=0, stubCount=1` after ~69 seconds
- Failure class: TS-compiled CJS prelude (`__createBinding`/`__setModuleDefault`/`__importStar`/`__exportStar`) at top-of-file + multi-class monolith above #576's empirical threshold
- Cross-reference: issue #576 (ArrowFunctions in class bodies), issue #585 (UMD IIFE — structurally adjacent failure class), Slice 8 PR `#XXX`

---

*End of Slice 8 plan — engine-gap-honest per-entry shave of five `zod@3.25.76` headline-mapped helper-file atoms (string-min/string-max/regex-match/number-int/array-each) per #510 Slice 8 of 9. joi deferred per `DEC-WI510-S8-JOI-DEFERRED-001`.*
