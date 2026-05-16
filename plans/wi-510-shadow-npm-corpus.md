# WI-510 — Dependency-Following Shave Engine

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Implements [#510](https://github.com/cneckar/yakcc/issues/510). **REFRAMED 2026-05-14** — see below.
**Branch:** `feature/wi-510-shadow-npm-corpus`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-shadow-npm-corpus`
**Authored:** 2026-05-14 (planner stage, workflow `WI-510-SHADOW-NPM-CORPUS`)
**Parent coordination doc:** `plans/import-replacement-triad.md` (reframed in the same pass; supersedes the pre-#517 version).

> **THIS DOCUMENT REPLACES THE STALE ORIGINAL.** The first WI-510 plan (commit `5344541`) framed #510 as "hand-author ~30 shadow-npm atoms across 11 packages, validators-first." That framing is **retired.** The operator adjudicated, through a steering session, that hand-authoring a flat atom list alongside the real shave engine is a Sacred-Practice-12 (single-source-of-truth) violation — it builds a parallel mechanism for "what an atom is" next to the engine that already produces atoms.
>
> **#510's real deliverable is a `@yakcc/shave` ENGINE change:** teach the shave pipeline to follow dependency/import edges across the package boundary, so it recurses into a target package's own source and decomposes it down to a connected call-graph atom forest. The 11 npm packages in the issue body become **graduated acceptance fixtures** that prove the engine works — they are not the deliverable themselves.

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice.

---

## 1. Root Cause / The Verified Capability Gap

**The problem, restated.** yakcc's headline value proposition is dependency replacement — "instead of `import { isEmail } from 'validator'`, compose content-addressed atoms that do the same thing with a tiny reachable surface." For that to fire, the registry needs atoms that implement the behaviors LLMs reach for. The original plan proposed *hand-authoring* those atoms. But yakcc **already has an engine that produces atoms from source** — `@yakcc/shave`. The right move is not to hand-author a parallel corpus; it is to teach that engine to cross the package boundary so it can produce the corpus itself, deterministically, content-addressed, from real package source.

**The verified gap (confirmed against the worktree at planning time):**

`packages/shave/src/universalize/recursion.ts :: decompose(source, registry, options)` takes **one source string**. It creates **one** ts-morph `Project` (`new Project({ useInMemoryFileSystem: true, ... })`) and **one** `SourceFile` (`project.createSourceFile("anonymous.ts", source, ...)`), then walks that file's AST top-down. At each node it calls `isAtom()`; if non-atomic it descends into `decomposableChildrenOf(node)`.

`decomposableChildrenOf()` is the structural-descent policy. It has rich cases for descending into syntactic structure **within a file**: `SourceFile`/`Block` → statements; function-likes → body statements; `IfStatement` → branches; loops → body (with escaping-CF guard); `SwitchStatement`, `TryStatement`, `ClassDeclaration`, `ExpressionStatement`, `VariableStatement`, `CallExpression`, `NewExpression`, `ConditionalExpression`, `BinaryExpression`, `ReturnStatement`, `ObjectLiteralExpression`. **There is NO case for an `ImportDeclaration` / `require()` that resolves the module and descends into the imported file's AST.** `ImportDeclaration` falls through to the default `return []`.

The slicer (`packages/shave/src/universalize/slicer.ts`) is where static `import` edges are handled — and where they **stop**. `classifyForeign(source)` parses the source, walks `ImportDeclaration` nodes, skips type-only / relative / `@yakcc/` workspace imports, and emits one `ForeignLeafEntry` per binding for everything else. In both `walkNodeStrict` and `walkNodeGlueAware`, an unmatched `AtomLeaf` runs `classifyForeign()` **before** falling through to `NovelGlueEntry`: if it is a foreign import, the slicer pushes `ForeignLeafEntry` records and **`return`s** — it never recurses across the edge into the imported module's source.

`--foreign-policy` (`ShaveOptions.foreignPolicy`, values `allow` / `reject` / `tag`, default `tag` per `FOREIGN_POLICY_DEFAULT`) governs what `shave()` *does* with the `ForeignLeafEntry` records **after** `slice()` returns (the foreign-policy gate is enforced in `index.ts`, not inside the slicer). **None of `allow`/`reject`/`tag` means "decompose the foreign package's source."**

**Consequence.** Pointed at `validator/index.js`, `shave()` would: read that one file, `decompose()` its glue into a recursion tree, `slice()` it — and treat every `require('./lib/isEmail')` as a `ForeignLeafEntry`. It would **not** produce the granular `isEmail` atom tree. The capability to descend across the import edge does not exist.

**The signature is the constraint.** `decompose()`'s `(source: string, ...)` signature, its single `Project`, and its single `createSourceFile` are *themselves* what blocks module recursion. To follow edges you need:
- a **module resolver** — given the importing module's path and a specifier, resolve to an on-disk source file (respecting `package.json#exports` / `main`, `.js`/`.ts`/`.mjs`/`.cjs`, index files);
- a **visited-set cycle guard** — npm packages have circular imports; without a visited-set keyed by resolved module path, recursion does not terminate;
- a **per-module `Project`** (or per-module `SourceFile` in a shared `Project`) — not a single in-memory `createSourceFile("anonymous.ts", ...)`.

**Build on what exists.** `glue-aware` mode already applies the IR strict-subset predicate **per-subgraph** instead of per-file (`DEC-V2-SLICER-SEARCH-001`, `DEC-V2-GLUE-AWARE-SHAVE-001`). That best-effort partial-tolerance substrate — "this subgraph shaves, that one becomes a `GlueLeafEntry`, the file still produces a useful plan" — is exactly the discipline module recursion needs across module boundaries. #510 Slice 1 extends that discipline from per-subgraph-within-a-file to per-module-across-an-edge.

---

## 2. The Connected-Forest Architecture

The output of the dependency-following engine is **one connected call-graph atom forest**, not a monolithic tree and not N disconnected per-module trees.

When shave follows an import edge from `validator/index.js` into `validator/lib/isEmail.js`, that module's call-graph subgraphs **join the same selectable forest**. Concretely:

- **Every internal node is independently selectable.** A consumer can select `parse-local-part` at fine grain, or `validate-domain`, or the whole `validate-rfc5321-email` root at coarse grain — all from the *same* decomposition. Each function/subgraph is a content-addressed (`blockMerkleRoot`), independently-addressable root.
- **Subgraphs recompose into NEW merkle roots expressing arbitrary subsets.** A URL validator that needs only "reject consecutive dots" composes a new root from that subtree **without dragging in the rest of email validation**. This is the whole point of call-graph-derived decomposition over file-derived decomposition.
- **The package boundary is NOT a wall in the OUTPUT.** It only governs how far the *resolver* walks (the B-scope predicate, §3). In the forest itself, an atom from `validator/lib/isFQDN.js` and an atom from `validator/lib/isEmail.js` are peer nodes in the same connected structure — `isEmail`'s subgraph references `isFQDN`'s subgraph the same way it would if they were in one file.

This is consistent with the existing substrate: `slice()` already produces a `SlicePlan` of `PointerEntry | NovelGlueEntry | ForeignLeafEntry | GlueLeafEntry` with `matchedPrimitives` deduplicated by `canonicalAstHash`, and persistence (`persist/triplet.ts`, `persist/atom-persist.ts`) threads `parentBlockRoot` lineage. The forest is the natural multi-module generalization of the single-file `RecursionTree` → `SlicePlan` the engine already builds. `storeBlock` is idempotent (`INSERT OR IGNORE` keyed by the content-derived `blockMerkleRoot`), so the same atom reached via two import paths dedups for free.

---

## 3. Recursion Scope = B (within-package boundary)

**#510 Slice 1's scope is B:** follow import edges **WITHIN the target package boundary only**; treat EXTERNAL npm deps as foreign leaves still.

- Shaving `validator` recurses through all of `validator/lib/**` (validator's own source) but **stops at validator's own `dependencies`** — those edges remain `ForeignLeafEntry` records, exactly as today.
- A dep that is itself later named as a shave target gets shaved then; because identity is content-addressed and `storeBlock` is idempotent, **a dep shaved later retroactively benefits everything** that referenced it.
- The B-scope predicate is literally: *"is this resolved edge inside the target package's own directory tree?"* If yes, recurse. If no, `ForeignLeafEntry`.

**Options A and C are explicit follow-on issues, not this slice.** A = whole-`node_modules` transitive (follow every resolvable edge). C = depth/budget-bounded transitive. The B→C boundary is **one predicate** ("inside the package boundary?" becomes "inside the package boundary OR within depth/budget?") — the resolver, visited-set, per-module Project, and connected-forest structure are all unchanged. C-track follow-on issue detail is in §8.

**The operator may revisit B→A/C.** This is the one remaining point in the reframed architecture the operator reserved the right to change. Even if they do, it does not invalidate Slice 1 — it extends it. Slice 1 is written as B; A/C are additive.

---

## 4. Alternatives Gate — Where Module-Resolution-Aware Recursion Lives

Two reasonable architectures for *where* the module-resolution recursion lives. They differ significantly in blast radius and in whether they touch the (possibly constitutional) `decompose()` signature.

### Option 1 — Extend `decompose()` to be resolver-driven

`decompose()` gains an optional resolver/context parameter. When present, `decomposableChildrenOf` (or a sibling policy) gets an `ImportDeclaration` case that resolves the module, parses it into a `SourceFile`, and yields its top-level nodes as decomposable children — recursing across the edge inside the existing `recurse()` loop. The visited-set and per-module `Project`/`SourceFile` management live inside `decompose()`.

- **Pro:** one engine, one recursion loop; the forest is naturally connected because it is one `recurse()` call tree; reuses all of `safeCanonicalAstHash`, the escaping-CF guards, depth limiting.
- **Con:** `decompose()`'s `(source: string, ...)` signature changes — and `packages/shave/src/types.ts` carries a **"frozen-for-L5" constraint** the prior planner flagged. **CONFIRMED:** `types.ts` is the public-surface authority for `@yakcc/shave` (`ShaveOptions`, `ShaveResult`, `UniversalizeResult`, `UniversalizeOptions`, `ShaveRegistryView`, `CandidateBlock`, `IntentExtractionHook`) — every type is heavily `@decision`-annotated and several are explicitly described as stable public API (e.g. `DEC-UNIVERSALIZE-WIRING-001`, `DEC-UNIVERSALIZE-PERSIST-API-001`). `decompose()` itself is **not** exported from `types.ts` — it is an internal function in `recursion.ts` with `RecursionOptions` from `universalize/types.ts`. So a `decompose()` signature change is **internal to `@yakcc/shave`**, not a `types.ts` public-surface break — **provided** the change stays in `recursion.ts` + `universalize/types.ts` and does not alter `ShaveOptions`/`ShaveResult`/`UniversalizeResult`. The "frozen-for-L5" constraint applies to the *public* `types.ts` surface; the implementer must design the resolver parameter as a `RecursionOptions` extension (or a new internal context type) and NOT widen the public `ShaveOptions`/`UniversalizeOptions` shape unless a follow-up explicitly re-opens it. If the engine genuinely needs a new *public* option (e.g. `ShaveOptions.followDependencies`), that single additive optional field is the maximum permitted public-surface change and must be `@decision`-annotated as such.

### Option 2 — A new orchestration layer above `decompose()`

A new module (e.g. `packages/shave/src/universalize/module-graph.ts`) owns module resolution, the visited-set, and per-module `Project` creation. It calls the *existing* `decompose(source, ...)` once per module, then stitches the per-module `RecursionTree`s into one connected forest by resolving `ForeignLeafEntry` records that point inside the package boundary into edges to the corresponding module's tree.

- **Pro:** `decompose()` is untouched — zero risk to the per-file engine and its large `@decision` history; the new layer is a clean, separately-testable unit; cycle guard and resolver are isolated.
- **Con:** "stitch per-module trees into a connected forest" is real work — the connectivity has to be *constructed* rather than falling out of one recursion; risk of producing N-trees-with-edges that is subtly not the same as one forest (the §2 requirement that every internal node is independently selectable from the *same* decomposition must be explicitly preserved by the stitching logic).

### Recommendation: **Option 2 — new orchestration layer**, with one carefully-designed seam.

Rationale: `decompose()` carries an extraordinary `@decision` history (`DEC-RECURSION-005` and ~8 slicer-policy DECs, each documenting a hard-won self-shave success-rate gain). Reaching into its `recurse()` loop to add cross-module descent risks regressing that. Option 2 keeps the per-file engine frozen and proven, and isolates the genuinely new concern (module graph traversal) in its own testable module. The Option 2 "con" — constructing connectivity rather than getting it for free — is mitigated by making the orchestration layer emit a **single forest data structure** (not a list of trees) whose nodes are the union of all per-module recursion-tree nodes, with in-package `ForeignLeafEntry` records *replaced* by direct edges to the resolved module's subtree root. The slicer then runs over the forest, and `matchedPrimitives` dedup by `canonicalAstHash` does the rest. The implementer designs that forest type in `universalize/types.ts` (internal surface — allowed).

**Implementer latitude:** if, during implementation, the stitching seam proves to require a `decompose()` internal change after all (e.g. `decompose()` must expose per-node resolved-module provenance), that is an internal `recursion.ts` change and is permitted **within the Scope Manifest** — but it must NOT touch the public `types.ts` surface, and any such change must be `@decision`-annotated explaining why Option 2's pure-orchestration seam was insufficient.

---

## 5. Slicing Plan

**Slice 1 = the engine.** Slices 2-N = the 11 packages as graduated fixtures, ordered by call-graph complexity.

```
Slice 1 (THIS PLAN, fully specified §6-§7)
   The module-resolution-aware recursion engine — B-scope.
   - module resolver + visited-set cycle guard + per-module Project
   - connected call-graph forest output (Option 2 orchestration layer)
   - best-effort degradation throughout
   - two-pass byte-identical determinism
   - single gentle real fixture: `ms` (pure, near-single-file)
        │
        ▼  (engine proven on `ms`)
Slice 2 — validator        (the triad's named demo library; unblocks #508 + #512)
Slice 3 — semver           (small, mostly-pure version-range logic)
Slice 4 — uuid + nanoid    (identifiers; introduces honest effect declaration on the forest)
Slice 5 — date-fns subset  (larger call graph; many small pure modules)
Slice 6 — jsonwebtoken + bcrypt  (crypto/token; shared constant-time-compare subgraph)
Slice 7 — lodash subset    (largest call graph)
Slice 8 — zod/joi subset   (validator-builder DSL; deepest call graphs)
Slice 9 — p-limit/p-throttle (async orchestration; effectful)
```

**Why `ms` before `validator` for Slice 1's fixture.** Slice 1's job is to prove the *engine*, not to ship a headline package. `ms` is pure, near-single-file, with a tiny well-defined grammar and at most a shallow internal structure — it exercises "resolve an edge, decompose the resolved module, join the forest, terminate" without the call-graph breadth of `validator/lib/**`. If the engine works on `ms` it works; `validator` (Slice 2) then stress-tests breadth. (The triad coordination doc names `validator` as the *demo library* — that is Slice 2's role; Slice 1 uses `ms` as the gentle engine-proof fixture.)

**Ordering rationale (Slices 2-N).** `validator` first because it is the triad's MVDP demo binding and unblocks #508/#512. Then ascending call-graph complexity: `semver` → `uuid`/`nanoid` → `date-fns` (many small modules) → `jsonwebtoken`/`bcrypt` (crypto, shared subgraph) → `lodash` (largest) → `zod`/`joi` (deepest DSL graphs) → `p-limit`/`p-throttle` (effectful async). The exact per-fixture binding list inherits the issue body's enumeration.

**Dependency edges.** Slices 2-N each depend only on Slice 1 (engine proven) and are otherwise mutually independent — parallelizable across implementers, touching disjoint registry rows and disjoint test fixtures. **Slices 2-N do NOT change `@yakcc/shave` engine source** — the engine is frozen after Slice 1. A fixture slice that hits an engine gap files a bug against the engine; it does not patch the engine in-slice.

**Per-slice gate.** `review` (reviewer verifies the Evaluation Contract). Slice 1 may warrant `approve` if the implementer's design ends up touching the public `types.ts` surface (see §4) — that is a constitutional edit. If Slice 1 stays within `recursion.ts` + `universalize/**` internal surface (the recommended Option 2 path), `review` suffices.

**Critical path:** Slice 1 → Slice 2 (validator) → [#508 Slice 1, #512 Slice 2]. Max width after Slice 1: 8 parallel fixture slices.

**Slice 2 reframe (2026-05-14).** A first attempt at Slice 2 (`plans/wi-510-s2-validator.md` on the now-retired `feature/wi-510-s2-validator` branch, last commit `f9c93f0`) shaved the *whole* `validator` package by calling `shavePackage()` against `validator-13.15.35/` with no `entryPath` override. The default entry resolution lands on `validator/index.js`, which re-exports all ~100 behaviors; the BFS produced `moduleCount=113, leafCount=1987`, ran for 44 minutes, and forced `testTimeout=3_600_000` on `packages/shave/vitest.config.ts`. The operator killed that approach: *"we only need to prove what's used in yakcc, the rest will get added later when we do a full shave into the production registry of validator etc."* The reframed Slice 2 is specified in `plans/wi-510-s2-headline-bindings.md` — it shaves **only the four headline bindings the triad demonstrates** (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`), each as its own ~2-10-module subgraph via `shavePackage({ entryPath: <validator>/lib/<binding>.js })`. The landed engine's `ShavePackageOptions.entryPath` field already supports this; Slice 2 remains a pure fixture-and-test slice (`review` gate, no engine source change). Broader validator coverage (the other ~96 behaviors) and the other graduated Slices 3-N (`semver` through `p-limit`) remain out of Slice 2's scope and are deferred to a later "full shave into the production registry" initiative the operator named explicitly.

**Slice 2 status (2026-05-15):** **LANDED** as PR #544, commit `aeec068`. The four `validator` headline bindings (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`) are now per-entry shaved through the real `shavePackage({ entryPath })` path and persisted via `collectForestSlicePlans` → `maybePersistNovelGlueAtom`; `combinedScore >= 0.70` confirmed for all four. The vendored `validator-13.15.35/` tarball at `packages/shave/src/__fixtures__/module-graph/validator-13.15.35/` is the canonical Slice 2-N fixture pattern; subsequent slices vendor their own sibling directory.

**Slice 3 status (2026-05-16).** Slice 3 — per-entry shave of four `semver@7.8.0` headline bindings (`satisfies`, `coerce`, `compare`, `parse`) — is planned in `plans/wi-510-s3-semver-bindings.md`. Same pattern as Slice 2: vendor the published tarball, shave each headline via `shavePackage({ entryPath })`, append four `synthetic-tasks` corpus rows, `review` gate. semver's `classes/range.js` ⇄ `classes/comparator.js` cycle is the first real-world corroboration of Slice 1's circular-import cycle guard (per `DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001`). Engine source remains frozen. **Slice 3 LANDED 2026-05-16 as PR #570, commit `b83d46f`.**

**Slice 4 status (2026-05-16).** Slice 4 — per-entry shave of three `uuid@11.1.1` headline bindings (`v4`, `validate`, `v7`) + one `nanoid@3.3.12` primary export (`nanoid`) — is planned in `plans/wi-510-s4-uuid-nanoid.md`. Same fixture-and-test pattern as Slices 2 and 3. Two new properties exercised for the first time in the WI-510 fixture suite: (a) **two packages vendored in one slice** (uuid + nanoid as paired identifier-generation primitives per master plan line 113); (b) **first real-world `require('crypto')` Node-builtin foreign-leaf emission** — both packages reference the `crypto` Node builtin, which the engine must emit as a `ForeignLeafEntry` via the B-scope predicate (per `DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001`). Subgraphs are the smallest of any landed/planned slice (~2-9 modules per headline; cumulative ~15 decompositions vs Slice 3's ~40). Both packages pinned to their latest CJS-shipping lines because `uuid@14` and `nanoid@5` are ESM-only; ESM-vendored fixtures are deliberately deferred to a later initiative (per `DEC-WI510-S4-UUID-VERSION-PIN-001`, `DEC-WI510-S4-NANOID-VERSION-PIN-001`). Issue-body binding-name mapping resolved: `v4-generate` → `v4`, `v4-validate` → `validate` (any-version validator; uuid does not ship a v4-specific one), `v7-generate` → `v7` (per `DEC-WI510-S4-UUID-BINDING-NAMES-001`). Engine source remains frozen. `review` gate.

---

## 6. Evaluation Contract — Slice 1 (the engine)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for guardian" is defined at the end.

### 6.1 Required tests

- **`pnpm --filter @yakcc/shave test`** — the full shave suite passes, including the existing `recursion.test.ts`, `slicer.test.ts`, `wiring.test.ts`, `atom-test.test.ts`. **No existing test regresses** — the per-file engine behavior is unchanged when no resolver/module-graph context is supplied (Option 2: `decompose()` is literally untouched; the new orchestration layer is additive).
- **`pnpm --filter @yakcc/shave build`** — `tsc -p .` compiles clean.
- **`pnpm --filter @yakcc/shave typecheck`** — no type errors.
- **New unit tests for the module resolver** — cover: resolve a relative `./lib/x` edge; resolve via `package.json#main`; resolve via `package.json#exports`; resolve an index file; an unresolvable specifier returns the "unresolvable" signal (does NOT throw — best-effort discipline).
- **New unit tests for the cycle guard** — a fixture with a deliberate circular import (`a.js` imports `b.js` imports `a.js`) terminates and produces a finite forest; the visited-set prevents re-descent.
- **New unit tests for the connected forest** — given a 3-module in-package graph, the emitted forest has every function/subgraph as an independently-addressable node; a node in module B is reachable as a peer in the same forest as a node in module A; in-package `ForeignLeafEntry` records are replaced by edges, external ones are retained.
- **New determinism test** — `shave`/decompose the `ms` fixture twice; the emitted forest (and its serialized atom set / merkle roots) is **byte-identical** across the two passes.
- **New best-effort degradation test** — a fixture package with one deliberately unresolvable edge and one `.d.ts`-only dep still produces a forest for the resolvable remainder; the unresolvable/`.d.ts` edges become foreign leaves or stubs; the shave does NOT fail wholesale.

### 6.2 Required real-path checks

- **The `ms` fixture, end-to-end through the production shave path:** run the dependency-following engine against the real `ms` package source (vendored as a test fixture or resolved from `node_modules`). It must produce a connected forest of behavior atoms for `ms`'s parse/format behaviors — not a single `ForeignLeafEntry`-dominated plan. The reviewer inspects the emitted forest and confirms it contains granular atoms (e.g. a duration-parsing subgraph), not just glue.
- **`combinedScore >= 0.7` is emergent.** With `ms`'s atoms in the registry (via the production `storeBlock` persist path), a `findCandidatesByQuery` for the natural-prose query describing `ms`'s duration-parsing behavior returns an `ms` atom with `combinedScore >= 0.70` (the discovery-eval `confident` band floor). This is the issue's acceptance criterion — but in the reframe it is **emergent from the shaved forest**, not from a hand-authored `behavior` string. The atoms are findable because they are real, content-addressed registry rows produced by the engine.
- **Two-pass determinism on the real path.** The `ms` shave run, executed twice via the real entry point, is byte-identical (this is the production-sequence verification of the §6.1 determinism unit test). This aligns with the WI-V2-09 byte-identical-bootstrap discipline.

### 6.3 Required authority invariants

- **One engine, one decomposition authority.** The dependency-following recursion is an extension of the existing `@yakcc/shave` engine — NOT a parallel mechanism. There is exactly one path from "package target" to "atom forest." If Option 2 is taken, `decompose()` remains the single per-module decomposition authority and the orchestration layer is the single module-graph authority.
- **`blockMerkleRoot` integrity.** Atom identity is `hash(specHash ‖ implHash ‖ proofRoot)`, derived by `blockMerkleRoot()` in `@yakcc/contracts`. The engine never writes a merkle root directly; it produces triplets and the existing `persist/triplet.ts` / `persist/atom-persist.ts` path derives identity. Cross-package dedup is the existing idempotent `storeBlock` (`INSERT OR IGNORE`), not new dedup code.
- **The public `types.ts` surface is frozen-for-L5.** `ShaveResult`, `UniversalizeResult`, `UniversalizeOptions`, `ShaveRegistryView`, `CandidateBlock`, `IntentExtractionHook` MUST NOT change shape. The single permitted public-surface change is an additive optional `ShaveOptions` field IF the engine genuinely needs a public follow-dependencies switch — and that must be independently `@decision`-annotated. The recommended Option 2 path needs no public-surface change at all.
- **Glue-aware substrate is reused, not reinvented.** Best-effort partial tolerance across module edges builds on the existing `glue-aware` per-subgraph predicate discipline (`DEC-V2-SLICER-SEARCH-001`). The engine does not introduce a second partial-tolerance mechanism.
- **B-scope predicate is explicit and single-sourced.** "Is this edge inside the target package boundary?" is one named predicate function — not an inline check duplicated at multiple sites. C-track will extend exactly that predicate.

### 6.4 Required integration points

- `packages/shave/src/universalize/` — the new module-graph orchestration layer (Option 2) or the `decompose()` extension (Option 1) lives here.
- `packages/shave/src/universalize/types.ts` — internal types for the connected-forest data structure and the resolver context. Internal surface — additions allowed.
- `packages/shave/src/persist/` — the engine's forest output flows through the **existing** `persist/triplet.ts` / `persist/atom-persist.ts` path unchanged. If the forest's multi-module lineage needs `parentBlockRoot` threading beyond what exists, that is a reviewer-flagged integration point — but the expectation is the existing lineage threading suffices.
- `packages/registry/test/discovery-benchmark/corpus.json` — one query entry for the `ms` headline behavior, `expectedAtomName` set to the `ms` atom's directory/identity, so the §6.2 `combinedScore` check is mechanized. Must satisfy the per-category invariants of `discovery-eval-full-corpus.test.ts` (category assignment, ≥8-per-category, positive+negative).
- Test fixtures — the `ms` package source and the synthetic resolver/cycle/degradation fixtures live under `packages/shave/src/__fixtures__/` (the existing fixtures directory) or `packages/shave/test/fixtures/`.

### 6.5 Forbidden shortcuts

- **No parallel decomposition mechanism.** The dependency-following engine extends the existing shave engine. Building a separate "npm package shaver" beside `decompose()`/`slice()` is the exact Sacred-Practice-12 violation this reframe exists to avoid.
- **No regex-based import detection.** Module edges are found via the AST (`getImportDeclarations()` / ts-morph), exactly as `classifyForeign()` already does. Regex-on-source for import edges is a maintenance hazard and silently fails on edge cases.
- **No throw-on-unresolvable.** An unresolvable edge, a non-strict-subset module, or a `.d.ts`-only dep degrades to a foreign leaf or stub — the rest of the package still shaves. Wholesale failure on one bad edge violates the best-effort discipline. (Genuinely unparseable source that makes ts-morph throw still propagates — best-effort is not a blanket exception handler, per `DEC-V2-SLICER-SEARCH-001` point 5.)
- **No public `types.ts` surface break.** See §6.3. The recommended path needs zero public-surface change.
- **No cycle-guard-by-depth-limit alone.** The depth limit (`DEFAULT_MAX_DEPTH = 24`) is a pathological-shape backstop, not a cycle guard. Module recursion needs a real visited-set keyed by resolved module path — npm circular imports are common and legitimate, not pathological.
- **No non-determinism.** `readdir`-order dependence, `Map`-iteration-order dependence, or timestamp/path-absolute leakage into the forest breaks two-pass byte-identical bootstrap. The resolver and forest construction must be deterministic.
- **No hand-authored atoms smuggled in.** Slice 1 ships the engine and proves it on `ms`. It does NOT hand-author `ms` atoms — the atoms are the engine's output. (This is the whole reframe.)
- **No edits to `packages/ir/**` (strict-subset validator) or `packages/contracts/**` (`blockMerkleRoot`).** Those are constitutional and the engine *uses* them.

### 6.6 Ready-for-Guardian definition (Slice 1)

Slice 1 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/shave typecheck && pnpm --filter @yakcc/shave test` all green, with **zero regressions** in the existing shave suite.
2. The new resolver / cycle-guard / connected-forest / determinism / best-effort-degradation unit tests (§6.1) are present and green.
3. The `ms` fixture, run through the real dependency-following path, produces a **connected forest of granular behavior atoms** — the reviewer inspects the emitted forest and confirms it is not `ForeignLeafEntry`-dominated glue.
4. Two-pass determinism: the `ms` shave run is **byte-identical** across two passes (forest structure + atom set + merkle roots).
5. `combinedScore >= 0.70` for the `ms` headline-behavior corpus query, measured via `findCandidatesByQuery` against a registry populated by the engine's own `storeBlock` output — the quality describe blocks **ran (not skipped)**, and the reviewer pastes the per-entry score as evidence. If the bootstrap registry / embedder is absent so the quality blocks skip, the slice is **blocked**, not ready.
6. Best-effort degradation proven: a fixture with an unresolvable edge still shaves the resolvable remainder (§6.1 test green + reviewer confirms the forest is partial-but-useful, not empty).
7. Cycle-guard proven: the circular-import fixture terminates with a finite forest.
8. The B-scope predicate is a single named function; external-package edges remain `ForeignLeafEntry`; in-package edges are followed. Reviewer confirms `validator`-style external deps would NOT be recursed (B-scope, not A).
9. The public `packages/shave/src/types.ts` surface is confirmed unchanged, OR carries exactly one additive optional `ShaveOptions` field with its own `@decision` annotation and an `approve` gate was applied.
10. New `@decision` annotations are present at the engine modification points, recording the design choice (Option 1 vs Option 2 as built, the resolver strategy, the cycle-guard key, the B-scope predicate). New DEC IDs recorded — see §9.

---

## 7. Scope Manifest — Slice 1 (the engine)

**Allowed paths (implementer may touch):**
- `packages/shave/src/universalize/**` — the new module-graph orchestration layer, internal types, and (if Option 1 / a proven-necessary seam) internal `recursion.ts` changes.
- `packages/shave/src/persist/**` — ONLY if the forest's multi-module lineage threading provably needs it; default expectation is untouched.
- `packages/shave/src/__fixtures__/**` (or `packages/shave/test/fixtures/**`) — new test fixtures (`ms` source, synthetic resolver/cycle/degradation fixtures).
- `packages/shave/src/**/*.test.ts`, `packages/shave/src/**/*.props.ts`, `packages/shave/src/**/*.props.test.ts` — new and updated tests for the engine.
- `packages/registry/test/discovery-benchmark/corpus.json` — one `ms` headline-behavior query entry (append only).
- `plans/wi-510-shadow-npm-corpus.md`, `plans/import-replacement-triad.md` — status updates only.

**Required paths (implementer MUST modify):**
- `packages/shave/src/universalize/**` — at minimum the new module-resolution-aware recursion layer and its internal types.
- `packages/shave/src/universalize/**/*.test.ts` — the new resolver / cycle-guard / connected-forest / determinism / best-effort tests.
- `packages/shave/src/__fixtures__/**` (or `test/fixtures/**`) — the `ms` fixture and synthetic fixtures.
- `packages/registry/test/discovery-benchmark/corpus.json` — the `ms` query entry.

**Forbidden touch points (must not change without re-approval):**
- `packages/shave/src/types.ts` — the frozen-for-L5 public surface. Exception: exactly one additive optional `ShaveOptions` field IF genuinely required, independently `approve`-gated and `@decision`-annotated.
- `packages/ir/**` — the strict-subset validator and block parser are constitutional; the engine *uses* `validateStrictSubset`, does not modify it.
- `packages/contracts/**` — `blockMerkleRoot`, `canonicalAstHash` are constitutional.
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — the registry schema and discovery-eval harness are constitutional; Slice 1 *uses* them. **No `npm_aliases` field — the reframe eliminates the need for it.**
- `packages/hooks-*/**`, `packages/compile/**`, `bench/**` — those are #508's and #512's lanes.
- `packages/seeds/src/blocks/**` and all 26 existing seed atoms — NOT modified. Slice 1 produces atoms via the engine from `ms` source; it does not hand-author seed atoms.
- `packages/cli/src/commands/plumbing-globs.ts`, `packages/seeds/src/_scripts/copy-triplets.mjs`, `packages/cli/src/commands/bootstrap.ts` — workspace plumbing owned elsewhere.
- `MASTER_PLAN.md` — permanent sections untouched.

**Expected state authorities touched:**
- **Shave decomposition engine** — canonical authority: `decompose()` in `packages/shave/src/universalize/recursion.ts` (per-module) and the NEW module-graph orchestration layer (cross-module). Slice 1 adds the cross-module authority; it does not fork the per-module one.
- **Slice plan / atom forest** — canonical authority: `slice()` in `slicer.ts` consuming the recursion structure. Slice 1 feeds it a connected forest instead of a single-file `RecursionTree`; the slicer's `PointerEntry`/`NovelGlueEntry`/`ForeignLeafEntry`/`GlueLeafEntry` discrimination is unchanged.
- **Atom identity + registry block store** — canonical authority: `blockMerkleRoot()` (`@yakcc/contracts`) and the idempotent `storeBlock()` (`@yakcc/registry`). Slice 1 produces new identities by shaving `ms`; it never writes a root directly and relies on existing content-addressed dedup.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`. Slice 1 appends one entry.
- **Module resolution** — a NEW state-adjacent concern owned solely by the new orchestration layer's resolver. There is no pre-existing module-resolution authority in `@yakcc/shave` to diverge from; the implementer must ensure exactly one resolver exists after this slice.

---

## 8. C-Track Follow-On Issue(s) — to be filed by the orchestrator

#510 Slice 1 is **B-scope**. The operator explicitly tracks transitive cross-package recursion as follow-on work. The orchestrator should file the following GitHub issue(s) once #510 Slice 1 lands. Enough detail is given here that the orchestrator can file them directly.

### C-track issue (file this)

**Title:** `WI: Depth/budget-bounded transitive cross-package shave recursion (C-scope)`

**Body:**
> #510 Slice 1 shipped the dependency-following shave engine at **B-scope**: it follows import edges *within* a target package's own boundary and treats the package's external `dependencies` as foreign leaves. This issue extends the engine to **C-scope**: follow those external-dependency edges too, **bounded** by a depth limit and/or a byte/atom budget.
>
> **Why bounded (C) and not unbounded (A):** unbounded transitive recursion can pull a large fraction of `node_modules` into a single `shave()` call — useful but expensive and harder to keep deterministic. C adds `maxPackageDepth` and/or `maxAtoms`/`maxBytes` so a single shave is predictable and budget-capped.
>
> **The boundary is one predicate.** Slice 1's B-scope predicate ("is this resolved edge inside the target package boundary?") becomes C-scope's ("...inside the package boundary OR within the configured depth/budget?"). The resolver, visited-set cycle guard, per-module Project handling, and connected-forest output structure from Slice 1 are all **unchanged** — C is a predicate change plus a budget accumulator.
>
> **Dependencies:** #510 Slice 1 (the B-scope engine). Cannot start before it.
>
> **Acceptance sketch:** `shave('validator', { transitive: { maxPackageDepth: 2, maxAtoms: 500 } })` produces a connected forest that includes atoms from `validator`'s direct dependencies, terminates within budget, remains two-pass byte-identical deterministic, and the budget cutoff degrades cleanly to foreign leaves (Slice 1's best-effort discipline preserved). Existing B-scope behavior is unchanged when no `transitive` option is supplied.
>
> **Scope hint:** `packages/shave/src/universalize/**` — extends the Slice 1 orchestration layer's boundary predicate and adds a budget accumulator. The public `types.ts` surface may need one additive optional `transitive` field on `ShaveOptions` (constitutional, `approve`-gated).

### A-track issue (file ONLY if the operator revisits OD-1 to A)

**Title:** `WI: Unbounded whole-node_modules transitive shave recursion (A-scope)`

**Body sketch:** Same engine as B/C; the boundary predicate is relaxed to "follow every resolvable edge." Likely subsumed by C-scope with a very large budget. File only if the operator explicitly upgrades the recursion scope decision (triad doc OD-1) from B to A.

---

## 9. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-DEP-FOLLOWING-ENGINE-001` | #510 is a `@yakcc/shave` engine change (dependency-following recursion), not a hand-authored atom corpus | Hand-authoring ~30 npm-function atoms beside the real shave engine is a Sacred-Practice-12 (single-source-of-truth) violation — two authorities for "what an atom is." #510's deliverable is teaching `@yakcc/shave` to follow import edges across the package boundary and emit a connected call-graph atom forest. The 11 npm packages are graduated acceptance fixtures, not the deliverable. Operator-adjudicated reframe. |
| `DEC-WI510-RECURSION-SCOPE-B-001` | Slice 1 recursion scope is B (within-package boundary); A/C are follow-on issues | Follow import edges within the target package's own source; external `dependencies` remain `ForeignLeafEntry`. Content-addressed identity means a dep shaved later retroactively benefits all referrers. The B→C boundary is one predicate. Operator reserved the right to revisit B→A/C; doing so extends Slice 1, does not invalidate it. |
| `DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001` | Module-resolution-aware recursion lives in a new orchestration layer above `decompose()`, not inside it | `decompose()` carries an extraordinary `@decision` history (`DEC-RECURSION-005` + ~8 slicer-policy DECs, each a hard-won self-shave success gain). A new `universalize/module-graph.ts`-style layer owns module resolution, the visited-set cycle guard, and per-module Project creation, calling the *unchanged* `decompose()` per module and stitching results into one connected forest. Keeps the proven per-file engine frozen; isolates the new concern. Option 1 (extend `decompose()`'s signature) rejected as higher blast radius. Implementer may make a proven-necessary internal `recursion.ts` seam change within scope, but not a public `types.ts` break. |
| `DEC-WI510-FOREST-CONNECTED-NOT-NESTED-001` | Engine output is one connected call-graph forest; every internal node independently selectable | Not a monolithic tree, not N disconnected per-module trees. In-package `ForeignLeafEntry` edges are replaced by direct edges to the resolved module's subtree; the slicer runs over the unified forest; `matchedPrimitives` dedup by `canonicalAstHash` handles shared subgraphs. Subgraphs recompose into new merkle roots expressing arbitrary subsets. The package boundary governs resolver reach, not output topology. |
| `DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001` | Unresolvable edge / non-strict-subset module / `.d.ts`-only dep degrades to foreign leaf or stub; the rest still shaves | Extends the existing `glue-aware` per-subgraph best-effort discipline (`DEC-V2-SLICER-SEARCH-001`) from per-subgraph-within-a-file to per-module-across-an-edge. No throw-on-bad-edge. Genuinely unparseable source still propagates — best-effort is not a blanket exception handler. |
| `DEC-WI510-MS-FIXTURE-FIRST-001` | Slice 1's engine-proof fixture is `ms`, not `validator` | Slice 1 proves the engine, not a headline package. `ms` is pure and near-single-file with a shallow internal structure — it exercises resolve-decompose-join-terminate without `validator/lib/**`'s call-graph breadth. `validator` is Slice 2, where it stress-tests breadth and serves as the triad MVDP demo binding. |

These are recorded in the relevant `@decision` annotation blocks at the engine modification points and, if the operator wants them in the project-level log, appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of a source slice.

---

## 10. Risks

| Risk | Mitigation |
|------|-----------|
| Connected-forest construction (Option 2 stitching) produces "N trees with edges" that is subtly NOT one forest — some internal nodes not independently selectable from the same decomposition. | §6.1 connected-forest unit test explicitly asserts cross-module peer-addressability; §6.6 criterion 3 makes the reviewer inspect the emitted forest. The forest is a single data structure (union of per-module nodes with in-package edges resolved), not a list — designed in `universalize/types.ts`. |
| The implementer reaches into `decompose()`'s `recurse()` loop and regresses one of the ~8 hard-won slicer-policy DECs. | Recommended Option 2 keeps `decompose()` untouched. §6.1 requires zero regressions in the existing shave suite; any internal `recursion.ts` seam change must be `@decision`-annotated justifying why pure orchestration was insufficient. |
| Module resolver mishandles `package.json#exports` conditional maps / dual ESM-CJS packages → wrong file resolved or unresolvable. | §6.1 resolver unit tests cover `main`, `exports`, index, relative; unresolvable returns a signal (not a throw) → best-effort degradation. `ms` (Slice 1 fixture) is deliberately simple to de-risk; `exports`-map stress comes with later fixture slices. |
| npm circular imports cause non-termination. | Real visited-set keyed by resolved module path is a §6.5 forbidden-shortcut-to-omit and a §6.6 criterion-7 gate; dedicated circular-import fixture test in §6.1. |
| Non-determinism (readdir order, Map iteration, absolute-path leakage) breaks two-pass byte-identical bootstrap. | §6.5 forbidden shortcut; §6.1 + §6.2 two-pass determinism tests; §6.6 criterion 4. Mirrors the existing WI-V2-09 discipline the per-file engine already honors. |
| `combinedScore >= 0.7` not reached for `ms` because the engine-derived `behavior`/intent text is too terse for the embedder. | The intent text is produced by the existing `extractIntent` path (static strategy), which the per-file engine already uses successfully. If `ms`'s atom under-scores, that surfaces in the discovery-eval per-entry JSON — investigate the intent-extraction output, not the recursion engine. The threshold is the harness's `confident` band floor. |
| The engine genuinely needs a public `ShaveOptions` field (e.g. `followDependencies`) → `types.ts` frozen-for-L5 break. | §6.3 / §7 permit exactly one additive optional field, independently `approve`-gated and `@decision`-annotated. The recommended Option 2 path needs none — the orchestration layer is a new entry point, not a flag on the old one. |
| A fixture slice (2-N) discovers an engine gap and an implementer patches the engine in-slice, forking the authority. | §5: fixture slices do NOT change engine source; an engine gap is a bug filed against the engine. Each fixture slice's Scope Manifest forbids `packages/shave/src/universalize/**` engine source edits. |

---

## 11. What This Plan Does NOT Cover (Non-Goals)

- **The import-intercept hook (#508).** #510 produces the shaved forest; #508 intercepts the `import` and queries the registry for it. Separate WI.
- **The B10 bench (#512).** #512 Slice 1 (harness + transitive-reachability resolver) is already merged (`950afdc`); Slices 2-3 consume #510's forest. Separate WI.
- **A-scope and C-scope transitive recursion.** B-scope only for Slice 1; A/C are §8 follow-on issues.
- **Hand-authoring any atoms.** The entire reframe: atoms are the engine's output, not hand-written. The 26 existing seed atoms are untouched.
- **`npm_aliases` registry schema field.** The reframe eliminates the hand-naming step that field existed to support — shave produces behavior atoms; #508 queries by `QueryIntentCard` semantics.
- **Modifying the discovery-eval harness, registry schema/storage, the strict-subset validator, or `blockMerkleRoot`.** All constitutional; the engine *uses* them.
- **Adjudicating B vs A vs C.** Slice 1 is B by operator decision; the operator may revisit (triad doc OD-1). That is the one remaining operator-relevant point and it extends, not invalidates, Slice 1.
