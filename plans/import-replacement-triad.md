# Import-Replacement Triad — Coordinated Plan (REFRAMED)

**Status:** Planning pass (read-only research output). Reframed 2026-05-14.
**Scope:** Coordinates implementation of [#508](https://github.com/cneckar/yakcc/issues/508) (import-intercept hook), [#510](https://github.com/cneckar/yakcc/issues/510) (dependency-following shave engine), and [#512](https://github.com/cneckar/yakcc/issues/512) (B10 import-heavy bench).
**Branch:** `feature/wi-510-shadow-npm-corpus` (this reframe); original triad branch `feature/plan-import-replacement-triad`.
**Authored:** 2026-05-13 (original); **reframed 2026-05-14** (planner stage, workflow `WI-510-SHADOW-NPM-CORPUS`).

> **THIS DOCUMENT SUPERSEDES THE PRE-#517 VERSION.** The original triad plan (merged in PR #517) assumed #510 was "hand-author a flat list of ~30 npm-function atoms" and left `DEC-IRT-ATOM-NAMING-001` as an open operator decision. **Both of those framings are retired.** The operator adjudicated, through a steering session, that hand-authoring a parallel atom list alongside the real shave engine is a Sacred-Practice-12 (single-source-of-truth) violation. #510's real deliverable is a **`@yakcc/shave` engine change** — teach the shave pipeline to follow dependency/import edges across the package boundary and decompose a target package's own source into a connected call-graph atom forest. The 11 npm packages in #510's issue body are **graduated acceptance fixtures** that prove the engine works, not the deliverable.
>
> The atom-naming question (`DEC-IRT-ATOM-NAMING-001`) is **resolved by construction**: shave *produces* behavior-named atoms because the decomposition is call-graph-derived. There is no hand-naming step left to debate. Atoms are content-addressed by `blockMerkleRoot`; the human-facing directory name is the behavior. `npm_aliases` is not needed — see §5.

This document is a planning artifact. It does not change `MASTER_PLAN.md`, does not modify any TypeScript source, and does not constitute Guardian readiness for any code-bearing slice. Downstream slices implement against the contracts named here.

---

## 1. Desired End State

**Demonstrable artifact:** A B10 bench run committed under `bench/B10-import-replacement/results-<host>-<date>.json` that contains **at least one task** for which:

1. **Arm B** (LLM baseline) emits `import { isEmail } from 'validator'` (or equivalent for the chosen demo library), and the B10 transitive-reachable-surface measurer reports `arm_b.reachable_functions >= 50` and `arm_b.reachable_bytes >= 50_000` traced through `node_modules/validator/**`.
2. **Arm A** (yakcc atom composition, with the import-intercept hook of #508 active) emits **zero** non-builtin imports for the same task, with `arm_a.reachable_functions <= 0.10 * arm_b.reachable_functions` and `arm_a.reachable_bytes <= 0.10 * arm_b.reachable_bytes`.
3. **The same correctness oracle passes for both arms** on >=20 in-shape fast-check inputs (the B9 Axis-3 discipline re-used; see `bench/B9-min-surface/harness/measure-axis3.mjs`).
4. The atoms used by Arm A are content-addressed in the registry and were **produced by the #510 dependency-following shave engine** decomposing `validator`'s own source — not hand-authored, not hand-stitched into the emitter. The atom forest is the real output of `shave('validator')` recursing across `validator/lib/**`.

This single demo task is the **minimum viable proof** of the value-prop loop. Everything else in the triad (more fixture packages, broader intercept rules, larger B10 task set) is "broaden coverage" once the loop is closed.

---

## 2. The Reframe — What Each Issue Is Now

### #510 — The dependency-following, call-graph-forest-emitting shave engine

**Verified capability gap.** `decompose()` (in `packages/shave/src/universalize/recursion.ts`) takes **one source string** and walks its AST top-down. `decomposableChildrenOf()` is the structural-descent policy — it descends into syntactic structure *within a file* (statements, blocks, functions, loops, ternaries, call expressions, class members) but has **no case for an `ImportDeclaration` / `require()` that resolves the module and descends into the imported file's AST.** The slicer (`packages/shave/src/universalize/slicer.ts`) handles static `import` edges via `classifyForeign()` → `ForeignLeafEntry`: it classifies the edge and **stops** — it never recurses across it. `--foreign-policy` (`allow` / `reject` / `tag`) governs what to *do* with a foreign ref; none of those values means "decompose the foreign package's source."

So today, pointed at `validator/index.js`, shave would decompose that one file's glue and treat every `require('./lib/isEmail')` as a `ForeignLeafEntry` — it would **not** produce the granular `isEmail` atom tree.

**`decompose()`'s "one source string" signature is itself the constraint to break.** Module recursion needs: a **module resolver**, a **visited-set cycle guard** (npm packages have circular imports), and a **per-module Project** — not a single `createSourceFile`. Note: `glue-aware` mode already applies the IR strict-subset predicate **per-subgraph** instead of per-file (`DEC-V2-SLICER-SEARCH-001`) — that best-effort partial-tolerance substrate already exists and #510 builds on it.

**The architecture — connected forest, every internal node independently selectable.** When shave follows an import edge into `./lib/isEmail`, that module's call-graph subgraphs **join the SAME selectable forest**. NOT one monolithic tree; NOT N disconnected per-module trees. The decomposition emits a call-graph-derived forest where every function/subgraph is a content-addressed, independently-addressable root. A consumer can select `parse-local-part` at fine grain or the whole `validate-rfc5321-email` root at coarse grain from the *same* decomposition; subgraphs recompose into NEW merkle roots expressing arbitrary subsets. The package boundary is **not a wall in the OUTPUT** — it only governs how far the resolver walks.

**Recursion scope boundary = B (within-package only).** Follow edges WITHIN the target package boundary; treat EXTERNAL npm deps as foreign leaves still. Shaving `validator` recurses through all of `validator/lib/**` but stops at validator's own `dependencies`. Those deps get shaved when they are themselves a named target — and because identity is content-addressed (`blockMerkleRoot`, idempotent `storeBlock`), a dep shaved later **retroactively benefits everything**. Options A (whole-`node_modules` transitive) and C (depth/budget-bounded transitive) are tracked as explicit follow-on issues — see §6. The B→C boundary is literally one predicate ("is this edge inside the package boundary?").

### #508 — The import-intercept hook (forest-consuming)

The original plan treated #508 as needing a hand-maintained npm-binding→behavior mapping table. **The reframe makes #508 cleaner:** since #510 produces a real shaved forest in the registry, #508 intercepts the `import`, queries the registry, and gets the connected atom tree. The atom-naming question resolves to behavior-named atoms because **shave PRODUCES behavior atoms** — there is no hand-naming step left to debate, and no `npm_aliases` schema field is required. #508's job is: detect the non-builtin `import`, build a `QueryIntentCard`, call `findCandidatesByQuery`, and if a candidate clears the intercept threshold, refuse the unexpanded import and surface the atom composition.

### #512 — The B10 import-heavy bench

**#512 Slice 1 (harness + transitive-reachability resolver) IS ALREADY IMPLEMENTED AND MERGED TO MAIN** — PR #521, commit `950afdc`. #512's remaining Slices 2–3 **consume #510's shaved forest** for Arm A. They do not block #510; they are gated on #510 producing a real `validator` forest plus #508 intercepting the import.

---

## 3. Dependency Graph

Edges are slice-level dependencies. `*` marks a slice on the **Minimum Viable End-to-End Demo Path (MVDP)**.

```
   ┌─────────────────────────────────────────────────────────────┐
   │ #512 Slice 1: B10 harness + transitive-reachability resolver │  ✅ DONE — PR #521 / 950afdc
   │  (merged to main; not a blocker for anything below)          │
   └─────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │ #510 Slice 1: module-resolution-aware recursion engine (B-scope)* │  → THE engine change
   │  - module resolver + visited-set cycle guard + per-module Project │
   │  - connected call-graph forest output                            │
   │  - best-effort degradation throughout                            │
   │  - single gentle real fixture: `ms` (pure, near-single-file)     │
   └────────────────────────────┬─────────────────────────────────────┘
                                │  (engine proven on `ms`)
                                ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ #510 Slices 2-N: the 11 packages as graduated fixtures*           │
   │  ordered by call-graph complexity (validator is Slice 2 — the     │
   │  triad's named demo library)                                      │
   └──────────────┬───────────────────────────────────────────────────┘
                  │  (validator forest exists in registry)
                  ▼
   ┌────────────────────────────────────┐   ┌──────────────────────────────┐
   │ #508 Slice 1: import-intercept hook*│   │ #510 Slices 3-N: more         │
   │  for the validator demo binding     │   │ fixture packages (parallel)   │
   └──────────────┬──────────────────────┘   └──────────────────────────────┘
                  │  (hook intercepts `import {isEmail} from 'validator'`)
                  ▼
   ┌────────────────────────────────────────────┐
   │ #512 Slice 2: B10 demo task + run + commit* │  → §1 desired-end-state artifact
   └──────────────┬─────────────────────────────┘
                  ▼
   ┌────────────────────────────────────────────┐
   │ #512 Slice 3: broaden B10 task corpus       │
   │ #508 Slices 2-N: broaden intercept coverage │
   │ C-track follow-on: transitive recursion      │  (see §6)
   └────────────────────────────────────────────┘
```

**MVDP:** `#510 Slice 1 → #510 Slice 2 (validator) → #508 Slice 1 → #512 Slice 2`. At MVDP completion the triad's value-prop is demonstrated for one library / one task / one rule.

**Parallelism:** After #510 Slice 1 lands, #510 Slices 3-N (non-validator fixtures) are mutually independent and parallelizable across implementers — they touch disjoint registry rows. #508 Slice 1 is gated only on #510 Slice 2 (validator forest exists). #512 Slice 2 is gated on both #510 Slice 2 and #508 Slice 1.

---

## 4. Phase Plan

Per-slice format: **Owner WI / Inputs / Outputs / Evaluation Contract hint / Scope Manifest hint / Complexity**. Each code-bearing slice carries its own full Evaluation Contract + Scope Manifest written by its slice-level planner. This document sets the joint contract. **#510 Slice 1's full contract is in `plans/wi-510-shadow-npm-corpus.md` §6–§7.**

### #510 Slice 1 — Module-resolution-aware recursion engine (B-scope)

**Owner WI:** #510. **THE engine change.** Fully specified in `plans/wi-510-shadow-npm-corpus.md`.

**Inputs:** the verified `decompose()` / `decomposableChildrenOf()` / `classifyForeign()` internals; the `glue-aware` per-subgraph substrate; the `ms` npm package as the single gentle real fixture.

**Outputs:** a module-resolution-aware recursion layer in `@yakcc/shave` that, given a package target, resolves and follows in-package import edges, decomposes each resolved module via the existing per-module machinery, and emits a single connected call-graph atom forest. Cycle guard via a visited-set keyed by resolved module path. Best-effort degradation: an unresolvable edge / non-strict-subset module / `.d.ts`-only dep becomes a foreign leaf or stub; the rest still shaves. Determinism: two-pass byte-identical.

**Evaluation Contract hint:** `combinedScore >= 0.7` is emergent from the shaved forest (the atoms are findable). PLUS engine-level checks: forest connectivity (every internal node independently addressable; subgraphs share the forest), best-effort degradation proof (a fixture with a deliberately unresolvable edge still shaves the rest), cycle-guard proof (a fixture with a circular import terminates), two-pass determinism (byte-identical on re-run). Full contract: `plans/wi-510-shadow-npm-corpus.md` §6.

**Scope Manifest hint:** `@yakcc/shave` is the touched authority — `packages/shave/src/universalize/**`, possibly `packages/shave/src/types.ts` (the `decompose()` signature change may be constitutional — see `plans/wi-510-shadow-npm-corpus.md` §4 Alternatives Gate and §3 the L5-frozen note). Forbidden: `packages/ir/**` (strict-subset validator is constitutional), `packages/registry/src/schema.ts`, `packages/contracts/**`. Full manifest: `plans/wi-510-shadow-npm-corpus.md` §7.

**Complexity:** **L** (new module-resolution layer, cycle guard, determinism discipline, signature change that may be constitutional).

### #510 Slices 2-N — The 11 packages as graduated fixtures

**Owner WI:** #510. Ordered by call-graph complexity. **Slice 2 = `validator`** (the triad's named demo library — Slice 2 doubles as the #508/#512 unblocker). Subsequent slices: `semver`, `uuid`/`nanoid`, `date-fns`, `jsonwebtoken`/`bcrypt`, `lodash` subset, `zod`/`joi` subset, `p-limit`/`p-throttle` — see `plans/wi-510-shadow-npm-corpus.md` §5 for the full ordering and rationale. Each fixture slice is "point the proven engine at package X, confirm the forest is connected and findable" — they exercise the engine, they do not change it.

**Evaluation Contract hint (per fixture slice):** the package's headline behavior resolves via `findCandidatesByQuery` with `combinedScore >= 0.7`; the forest for that package is connected; two-pass determinism holds.

**Scope Manifest hint (per fixture slice):** no `@yakcc/shave` engine source changes (the engine is frozen after Slice 1) — fixture slices touch only test fixtures, corpus query entries, and any seed/bootstrap registration the engine output needs. If a fixture slice discovers an engine gap, that is a bug filed against the engine, not an in-slice engine edit.

**Complexity per slice:** **S–M** (engine is done; these are fixture + verification work). `lodash` and `date-fns` are the largest call graphs.

### #508 Slice 1 — Import-intercept hook for the validator demo binding

**Owner WI:** #508. Gated on #510 Slice 2 (validator forest in registry).

**Inputs:** the validator atom forest produced by #510 Slice 2; the existing hook surface (`packages/hooks-base/src/index.ts`, `packages/hooks-claude-code/src/`); the `yakcc_resolve` / `findCandidatesByQuery` surface.

**Outputs:** a tool-call-layer interception in `@yakcc/hooks-base` that scans `Edit`/`Write`/`MultiEdit` payloads for non-builtin `import` declarations (AST-level via ts-morph, not regex), builds a `QueryIntentCard`, calls the registry, and refuses the unexpanded import when a candidate clears the intercept threshold — surfacing the atom composition. Compile-time gate in `@yakcc/compile` rejects modules with unexpanded imports that have registry coverage. Scoped to `validator` for Slice 1 (allowlist of one, or registry-driven — see §5).

**Evaluation Contract hint:** intercept fires for `import { isEmail } from 'validator'` end-to-end; does NOT fire for `import { readFile } from 'node:fs'` or type-only imports; compile gate refuses the unexpanded form and accepts the atom-composed form; `pnpm test` green for `@yakcc/hooks-base`, `@yakcc/hooks-claude-code`, `@yakcc/compile`.

**Scope Manifest hint:** `packages/hooks-base/src/**`, `packages/hooks-claude-code/src/**` (re-export only — no duplicated intercept logic; `DEC-HOOK-BASE-001`), a new pre-assembly scan module under `packages/compile/src/` (NOT `resolve.ts`). Forbidden: `packages/seeds/**`, `packages/shave/**`, `bench/**`.

**Complexity:** **L** (AST scan, registry wiring, compile gate, three packages).

### #512 Slice 2 — B10 demo task + run + commit (MVDP terminal)

**Owner WI:** #512. Gated on #510 Slice 2 + #508 Slice 1.

**Inputs:** #512 Slice 1 harness (already merged, `950afdc`); the validator forest; the validator intercept hook.

**Outputs:** a B10 task at `bench/B10-import-replacement/tasks/validate-rfc5321-email/`; a corpus-spec entry with sha256 fingerprints; `arm-a-emit` driven by `yakcc compile` + hook + atoms; `llm-baseline` via Anthropic API (live) or committed fixture (dry); a live-run `results-<host>-<date>.json` carrying the headline transitive-reachable-surface delta — the §1 artifact.

**Evaluation Contract hint:** task wiring tests pass; B9 Axis-3 byte-equivalence on >=20 valid RFC-5321 inputs both arms; `pnpm bench:import-replacement -- --task validate-rfc5321-email --dry-run` exits 0; one operator-gated live run meets §1's thresholds; cost within the B10 slice cap.

**Scope Manifest hint:** `bench/B10-import-replacement/**`. Forbidden: `packages/**`, `bench/B9-min-surface/**`.

**Complexity:** **M** (one task, one live run, live-run discipline).

### #512 Slice 3 / #508 Slices 2-N — Broadening tracks

After MVDP: #512 Slice 3 expands the B10 task corpus to consume more #510 fixture forests; #508 Slices 2-N broaden intercept coverage to the additional packages. These follow the broadening discipline in the original plan (un-superseded — the original §3 P3/P4/P5 risk registers and forbidden-shortcut lists still apply to *these* tracks). They are gated on the corresponding #510 fixture slices landing.

---

## 5. Decision Boundaries

### Resolved by the reframe (no longer open)

| Was | Now |
|---|---|
| **`DEC-IRT-ATOM-NAMING-001`** — per-binding vs per-behavior vs behavior+`npm_aliases` | **RESOLVED by construction.** Shave produces call-graph-derived atoms; the atom *is* the behavior, content-addressed by `blockMerkleRoot`. The directory name is the behavior name. No `npm_aliases` schema field — #508 queries the registry by `QueryIntentCard` semantics, not by an npm-topology lookup table. The hand-naming step that the original options A/B/C were arguing over **does not exist** in the reframed pipeline. |
| **#510 = hand-author ~30 atoms** | **RETIRED.** #510 = the `@yakcc/shave` engine change. Hand-authoring a parallel atom list is a Sacred-Practice-12 violation (two authorities for "what an atom is"). |
| **`DEC-IRT-INTERCEPT-GRANULARITY-001`** — always / allowlist / registry-driven | Still a real #508-internal choice but **simplified**: with a real shaved forest in the registry, registry-driven ("intercept whenever the registry has a covering candidate above threshold") is the natural default and needs no schema extension. #508 Slice 1 may start with an allowlist-of-one (`validator`) for blast-radius control and generalize in #508 Slices 2-N. This is a #508-internal implementer/planner decision, not an operator gate. |

### Still operator-relevant — the ONE remaining revisit point

| # | Decision | Default | Why operator may revisit |
|---|---|---|---|
| OD-1 | **Recursion scope: B vs A vs C.** #510 Slice 1 is written as **B** (follow edges within the target package boundary only; external npm deps stay foreign leaves). | **B** | The operator adjudicated B as the engine slice's scope. They explicitly reserved the right to upgrade to **A** (whole-`node_modules` transitive) or **C** (depth/budget-bounded transitive). The B→C boundary is one predicate. This is the only point in the reframed architecture the operator may still want to change — and even then it does not invalidate Slice 1, it extends it. C-track follow-on issues are drafted in `plans/wi-510-shadow-npm-corpus.md` §8 / triad §6 so the orchestrator can file them. |

### `DEC-IRT-B10-METRIC-001`

Unchanged from the original plan — the B10 transitive-reachable-surface methodology landed with #512 Slice 1 (`950afdc`). Not re-litigated here.

### Implementer-decidable (no operator adjudication)

- The module resolver implementation (`ts-morph`'s resolution, Node's `require.resolve`, or a hand-rolled `package.json#exports`/`main` walker) — `plans/wi-510-shadow-npm-corpus.md` §4 presents the trade-off; implementer picks within the planner's recommendation.
- The visited-set key shape (resolved absolute path vs normalized specifier).
- Per-fixture-slice corpus query phrasing.
- #508 Slice 1 allowlist-of-one vs registry-driven start.

---

## 6. C-Track Follow-On — Transitive Cross-Package Recursion

#510 Slice 1 is **B-scope**. The operator explicitly tracks A and C as follow-on work. The orchestrator should file these as GitHub issues once #510 Slice 1 lands:

**C-track issue — "Depth/budget-bounded transitive cross-package shave recursion"**
- **Premise:** B-scope stops at the target package's own `dependencies`. C-scope follows those edges too, bounded by a depth limit and/or a byte/atom budget, so a single `shave('validator')` can also pull in `validator`'s deps' atoms in one pass instead of waiting for each dep to be a named target.
- **Why bounded, not unbounded (that is A):** unbounded transitive recursion (A) can pull a large fraction of `node_modules` into one shave call — useful but expensive and hard to make deterministic. C adds a `maxPackageDepth` and/or `maxAtoms`/`maxBytes` budget so the recursion is predictable.
- **The boundary is one predicate.** B-scope's "is this edge inside the package boundary?" check becomes C-scope's "is this edge inside the package boundary OR within budget/depth?" — the engine structure (resolver, visited-set, per-module Project, connected forest) is unchanged. C is a predicate + a budget accumulator on top of the Slice 1 engine.
- **Dependencies:** #510 Slice 1 (the engine). Cannot start before the B-scope engine exists.
- **Acceptance sketch:** `shave('validator', { transitive: { maxPackageDepth: 2, maxAtoms: 500 } })` produces a forest that includes atoms from validator's direct deps, terminates within budget, stays two-pass deterministic, and the budget cutoff degrades to foreign leaves (best-effort discipline preserved).

**A-track issue — "Unbounded whole-`node_modules` transitive shave recursion"** (optional, lower priority)
- Same engine, predicate relaxed to "follow every resolvable edge." File only if the operator upgrades OD-1 to A. Likely subsumed by C with a very large budget.

The orchestrator files the C-track issue as a tracked follow-on; the A-track issue only if OD-1 is revisited to A.

---

## 7. Out of Scope (explicit)

- **Runtime performance** of atom-composed vs library-imported code — B1-latency's job.
- **Token-usage delta** — B4-tokens's job.
- **Verification-spine attestation level** of engine-produced atoms — atoms enter at their claimed level per `VERIFICATION.md`; this triad introduces no verification machinery.
- **Federation / cross-mesh sharing** of shaved atoms — `@yakcc/federation` is a read-only content-addressed mirror (`pullBlock`/`pullSpec`/`mirrorRegistry`); it has **no npm-package ingestion path**. "Follow dependencies" is a `@yakcc/shave` engine change, NOT a shave→federation wiring task. Federation discipline applies post-landing per `FEDERATION.md`.
- **A-scope and C-scope transitive recursion** — tracked as §6 follow-on issues; #510 Slice 1 is B-scope.
- **`MASTER_PLAN.md` initiative registration** — a follow-up doc-only slice the orchestrator dispatches once #510 Slice 1's contract is approved.
- **Replacing `yakcc_resolve` / `QueryIntentCard`** — #508 consumes the existing surface as-is.

---

## Appendix — Cross-references

- Issues: [#508](https://github.com/cneckar/yakcc/issues/508), [#510](https://github.com/cneckar/yakcc/issues/510), [#512](https://github.com/cneckar/yakcc/issues/512). Original triad PR: #517. #512 Slice 1 merged: PR #521 / `950afdc`.
- Engine internals: `packages/shave/src/universalize/recursion.ts` (`decompose`, `decomposableChildrenOf`), `packages/shave/src/universalize/slicer.ts` (`classifyForeign`, `ForeignLeafEntry`, `walkNodeStrict`, `walkNodeGlueAware`), `packages/shave/src/index.ts` (`shave`, `universalize` entry points), `packages/shave/src/types.ts` (public surface, `ShaveOptions`, `ShaveRegistryView`).
- Persist path: `packages/shave/src/persist/triplet.ts`, `packages/shave/src/persist/atom-persist.ts` — `storeBlock` is idempotent (`INSERT OR IGNORE` keyed by content-derived `blockMerkleRoot`), so cross-package dedup is free once recursion crosses the boundary.
- Glue-aware substrate: `DEC-V2-SLICER-SEARCH-001`, `DEC-V2-GLUE-AWARE-SHAVE-001`.
- Strict-subset predicate (constitutional): `packages/ir/src/strict-subset.ts`.
- Discovery-eval / `combinedScore`: `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/test/discovery-benchmark/corpus.json`, `discovery-eval-full-corpus.test.ts`.
- DEC anchors already in the codebase: `DEC-HOOK-BASE-001`, `DEC-HOOK-CLAUDE-CODE-PROD-001`, `DEC-RECURSION-005`, `DEC-SLICER-NOVEL-GLUE-004`, `DEC-V2-FOREIGN-BLOCK-SCHEMA-001`, `DEC-CONTINUOUS-SHAVE-022`.

*End of reframed plan.*
