# WI-373 — Wire in-pipeline atom persistence in `universalize()`

**GitHub Issue:** #373 — `WI-UNIVERSALIZE-PERSIST`
**Status:** planned (this document)
**Branch:** `feature/wi-373-universalize-persist`
**Worktree:** `.worktrees/wi-373-plan`
**Complexity tier:** Tier 2 (Standard) — multi-file but bounded; one cross-package edit + tests; no architectural unknowns once the API surface decision is made.
**Owner suggestion:** FuckGoblin (per issue body); spike-shaped, one slice.

---

## 1. Problem statement (evidence-grounded)

### Verbatim source of the gap

`packages/compile/src/assemble-candidate.ts:140-148` (read by planner 2026-05-12):

```typescript
  // kind === "novel-glue": universalize() does not call maybePersistNovelGlueAtom
  // (only shave() does). The atom is not yet in the registry, so we cannot produce
  // a stable merkleRoot here without modifying the universalize() contract.
  // TODO(future-WI): when universalize() gains in-pipeline atom persistence,
  // surface the stored merkleRoot from the NovelGlueEntry and remove this error.
  throw new CandidateNotResolvableError(
    "single novel-glue entry — atom persistence in universalize() pipeline pending; use `yakcc shave` to persist first, then assemble() directly",
  );
```

`packages/shave/src/index.ts:567-581` — today's `universalize()` returns the slice plan but **never** calls `maybePersistNovelGlueAtom`. That side-effect lives only in `shave()` (`packages/shave/src/index.ts:741-779`).

`packages/compile/src/assemble-candidate.test.ts:356-379` — current Test 4 *asserts* that a single-leaf novel-glue source throws. This test must invert direction.

### Who has the problem

- **`yakcc compile <candidate>` users** — every user-typed source that is not already in the registry hits the throw on `assembleCandidate()`'s second invocation (the first time you compile fresh code).
- **v0.5 hook layer (Phase 2 substitution, #194)** — when an agent emits novel code and the hook tries to ingest it via the assemble-candidate path, it hits the same throw. Hook layer Phase 2 is not yet filed as a sub-issue, but `docs/adr/hook-layer-architecture.md:152, 206` enumerate it as the next phase.
- **v0.7 MRI demo** (`examples/v0.7-mri-demo/test/acceptance.test.ts`) and **v1 federation demo** consume `universalize()` directly; they currently work around persistence by calling `shave()` instead. This is a documented two-step workaround.

### Cost of not solving

Today's workaround is "run `yakcc shave <path>` to persist, then `yakcc compile <path>`". This is the documented v0.5 thesis path being two-step instead of one-step. Every downstream benchmark and hook-layer phase that assumes one-step ingestion has either to:

1. Add a `yakcc shave` step (extra round-trip, extra latency, extra wiring), or
2. Skip the assemble-candidate path entirely (defeats the purpose of `assembleCandidate()`).

This is a *thesis-path* bug — the closed-as-completed parent (WI-014-05 / #4) claims the universalize → compile-resolver scope is done, but the novel-glue branch is unwired. The plan-implication divergence is itself a Code-is-Truth violation.

### Dominant constraint

**Simplicity + composition (Sacred Practice #12: no parallel mechanisms).** This problem already has a working persistence primitive (`maybePersistNovelGlueAtom` in `packages/shave/src/persist/atom-persist.ts:221-236`). The WI is not "build new persistence"; it is "give `universalize()` the option to call the existing primitive in the right place with the right inputs, and surface the resulting `BlockMerkleRoot` to its caller".

Performance and security are not dominant: persistence is already opt-in (graceful no-op when `storeBlock` is absent), and the license gate already runs before persistence would.

---

## 2. Goals / non-goals / acceptance

### Goals (REQ-GOAL-xxx)

- **REQ-GOAL-001**: `universalize({persist: true})` resolves a single-leaf novel-glue candidate end-to-end, producing a `BlockMerkleRoot` on the `NovelGlueEntry`, with **zero** changes to today's default (no-persist) behavior.
- **REQ-GOAL-002**: `assembleCandidate()` no longer throws `CandidateNotResolvableError` for the single-novel-glue case when given a full `Registry` (which it already requires per its signature on line 178).
- **REQ-GOAL-003**: `shave()` continues to work bit-for-bit identically. Its existing manual postorder persistence loop (`packages/shave/src/index.ts:741-813`) is either replaced by an internal `persist: true` call or left in place; both options are evaluated in §3 below. Whichever is chosen must consolidate onto the same persistence primitive (no parallel mechanism).
- **REQ-GOAL-004**: Multi-leaf novel-glue resolution through `assembleCandidate()` is *not* a goal of this WI — the multi-leaf branch in `assemble-candidate.ts:124-128` remains a follow-up.

### Non-goals (REQ-NOGO-xxx)

- **REQ-NOGO-001**: No registry schema changes. The persistence primitive (`storeBlock` writing `BlockTripletRow`) is unchanged.
- **REQ-NOGO-002**: No CLI surface change. `yakcc compile` and `yakcc shave` keep their existing flags.
- **REQ-NOGO-003**: No multi-leaf assembly. The multi-leaf branch (`assemble-candidate.ts:124-128`) still throws. That is a separate WI.
- **REQ-NOGO-004**: No federation push. Atoms persisted by `universalize({persist:true})` go to the local registry only, same as `shave()`.
- **REQ-NOGO-005**: No license-policy changes. The existing license gate at `universalize()` step 1 stays. License-refused candidates do not reach the persistence step.
- **REQ-NOGO-006**: No changes to `ShaveOptions.sourceContext`, `parentBlockRoot`, or `sourceFilePath` plumbing. `universalize({persist:true})` calling from `assembleCandidate()` may pass them as undefined/null (the interactive-shave default).

### Acceptance criteria (operator-checkable)

P0 — required for merge:

- [ ] **A1**: Running `yakcc compile <novel-glue-source.ts>` against a source file with one expression-body arrow function NOT in the registry produces a valid `Artifact` with non-empty `source` and a manifest entry referencing the newly-persisted `BlockMerkleRoot`. Reference the existing PointerEntry test in `assemble-candidate.test.ts:282-291` for the shape of the assertion.
- [ ] **A2**: The persisted atom's `BlockMerkleRoot` matches what `yakcc shave <same-source.ts>` would produce for the same source (determinism + content-addressing preserved). Verified by storing-via-`shave()` vs. storing-via-`universalize({persist:true})` and asserting `BlockMerkleRoot` equality.
- [ ] **A3**: `assemble-candidate.ts:140-148` — the `TODO(future-WI)` comment is deleted; the throw for `kind === "novel-glue"` is replaced by a successful resolution path that lifts `NovelGlueEntry.merkleRoot` into the `BlockMerkleRoot` passed to `assemble()`.
- [ ] **A4**: `Test 4` in `assemble-candidate.test.ts:356-379` ("throws CandidateNotResolvableError with 'atom persistence in universalize' in message") is **inverted** — it now asserts the artifact is produced. A new test asserts that omitting `persist:true` and calling `universalize()` directly *still* yields the old "no merkleRoot on the novel-glue entry" shape (backwards-compat for shave's old behavior).
- [ ] **A5**: `pnpm --filter @yakcc/compile test`, `pnpm --filter @yakcc/shave test`, and `pnpm -r build` are all green. The B6 air-gap discipline (no network) is preserved — tests run offline with `intentStrategy: "static"` per the existing pattern in `multi-leaf-persist.test.ts`.
- [ ] **A6**: License-refused candidates still throw `LicenseRefusedError` before any persistence side-effect (no row written for refused source). Verified by a test that asserts `registry.getBlock(...)` returns nothing after a refused-license `assembleCandidate()` throws.
- [ ] **A7**: `shave()` and `universalize({persist:true})` produce identical registry state for the same input source. Verified by a comparison test: shave the source via `shave()`, capture registry rows; reset registry; run `universalize({persist:true})` on the same source; assert row-set equality on `(blockMerkleRoot, parentBlockRoot, specHash)` tuples.

P1 — nice-to-have:

- [ ] **A8**: The hook-layer `atomize.ts` (`packages/hooks-base/src/atomize.ts:540-572`) — which today calls `universalize()` then manually iterates the slice plan and calls `buildBlockRow` + `storeBlock` — is identified as a candidate for consolidation onto `universalize({persist:true})`. Out of scope for this WI; flag as a follow-up in the implementer's @decision.

---

## 3. Design decisions

### DEC-UNIVERSALIZE-PERSIST-API-001 — API surface

**Options evaluated:**

**Option A: `universalize({persist: true})`** — add an optional flag to `ShaveOptions` (or a sibling `UniversalizeOptions`). When true, `universalize()` runs the existing postorder persistence loop internally and surfaces the persisted `BlockMerkleRoot` on each `NovelGlueEntry`.

- Pros: minimal API surface delta; backwards-compatible by default (`persist === undefined` is treated as `false`); the call site in `assembleCandidate()` adds one line; `shave()` could later be refactored to delegate to this path, consolidating per Sacred Practice #12; symmetric with the existing `intentStrategy` / `foreignPolicy` flags on `ShaveOptions`.
- Cons: `ShaveOptions` is the options bag for both `shave()` and `universalize()` (per `types.ts:55`); adding a flag that one of them ignores is a leak. **Mitigation**: define `persist` in a new `UniversalizeOptions extends ShaveOptions` type so it only appears where it's meaningful; or document that `shave()` already persists unconditionally so `persist` is a no-op there.
- Cons: requires extending the `NovelGlueEntry` discriminated-union type to carry an optional `merkleRoot` field. Today `NovelGlueEntry` has no `merkleRoot` slot (`packages/shave/src/universalize/types.ts:209-216`). Adding one is structurally compatible — `PointerEntry` already has it — but it's a type-surface change every external consumer sees.
- Cons: requires `universalize()` to accept a full `Registry` (with `storeBlock`) instead of `ShaveRegistryView` (where `storeBlock` is optional). The runtime check (`typeof registry.storeBlock !== "function"` in `atom-persist.ts:228`) already handles graceful degradation: when `persist: true` is requested but the registry view has no `storeBlock`, the implementer must decide between (1) throwing a clear error and (2) silently returning the entry without merkleRoot. **Recommended**: throw a clear `PersistRequestedButNotSupportedError` to fail loudly per Sacred Practice #5.

**Option B: New `universalizeAndPersist()` function** — separate top-level export.

- Pros: zero risk to existing `universalize()` callers; clear API segregation; no type changes to `NovelGlueEntry`.
- Cons: two near-identical functions to maintain; duplicates the slice-plan-walking logic; violates Sacred Practice #12 (no parallel mechanisms); pushes complexity onto callers who must now decide between two entry points; the only difference between them is one line (the persist loop). Strongly rejected.

**Option C: Caller-side wrapping** — `assembleCandidate()` calls `universalize()`, then iterates the slice plan and calls `maybePersistNovelGlueAtom()` itself before resolving.

- Pros: zero changes to `universalize()` or its types; localized to `assemble-candidate.ts`.
- Cons: the persistence logic in `shave()` (postorder lineage threading, `parentBlockRoot` propagation, `sourceContext` per-atom offset) is non-trivial (`packages/shave/src/index.ts:741-779` is 39 lines of tightly-coupled logic). Duplicating it in `assembleCandidate()` violates Sacred Practice #12; both the hook-layer and any future caller would also have to duplicate. Strongly rejected.

**Chosen: Option A** with the following refinements:

1. Add a new exported type `UniversalizeOptions extends ShaveOptions` carrying the optional `persist?: boolean`. This keeps `shave()`'s `ShaveOptions` clean and signals the asymmetry.
2. Extend `NovelGlueEntry` with an optional `merkleRoot?: BlockMerkleRoot` field. Document that the field is populated **only** when persistence ran (either via `shave()` or `universalize({persist:true})`). Default-undefined preserves backwards compat for every existing consumer.
3. Refactor `shave()` (in a tightly-scoped second slice, see §6) so it delegates to `universalize({persist:true, sourceContext, parentBlockRoot})` instead of running its own postorder loop. This is the Sacred Practice #12 consolidation step.
4. If `persist:true` is passed but `registry.storeBlock` is absent at runtime, throw a new `PersistRequestedButNotSupportedError` (loud-fail per Sacred Practice #5).

**Addresses: REQ-GOAL-001, REQ-GOAL-002, REQ-GOAL-003**

### DEC-UNIVERSALIZE-PERSIST-PIPELINE-001 — Pipeline order and return shape

**Decision:** `maybePersistNovelGlueAtom()` is called inside `universalize()` after step 5 (intentCard attachment), as a new step 6, with the same postorder semantics that `shave()` uses today.

**Concrete pipeline (revised `universalize()`):**

```
Step 1: license gate          (unchanged — runs first, fail-fast)
Step 2: extractIntent         (unchanged — root intent card)
Step 3: decompose             (unchanged — RecursionTree)
Step 4: slice                 (unchanged — SlicePlan)
Step 5: per-leaf extractIntent (unchanged — attach intentCard to novel-glue entries)
Step 6 (NEW, gated on options.persist === true):
        For each entry in plan (in DFS order):
          if entry.kind === "novel-glue":
            merkleRoot = maybePersistNovelGlueAtom(entry, registry, {
              cacheDir: options.cacheDir,
              sourceFilePath: options.sourceFilePath,
              parentBlockRoot: lastNovelMerkleRoot ?? null,
              sourceContext: derive-per-atom from options.sourceContext + entry.sourceRange.start,
            });
            entry' = { ...entry, merkleRoot };
            lastNovelMerkleRoot = merkleRoot ?? lastNovelMerkleRoot;
          else:
            entry' = entry  (pass through)
        slicePlan = enrichedEntries
Step 7: return UniversalizeResult (unchanged shape — slicePlan entries may now
        carry merkleRoot on novel-glue entries when persist:true was requested)
```

**Return shape:** `NovelGlueEntry` gains the optional `merkleRoot?: BlockMerkleRoot` field. When persistence ran and succeeded, the field is set; otherwise undefined. `assembleCandidate()`'s `resolveToMerkleRoot()` is updated to: if `only.kind === "novel-glue"` and `only.merkleRoot !== undefined`, return it; otherwise throw a clearer error ("persist was not requested or storeBlock not supported").

**Why postorder (DFS) order:** the existing `shave()` loop (`index.ts:741-779`) already establishes this contract per `DEC-REGISTRY-PARENT-BLOCK-004`. Children persist before parents so each entry's `parentBlockRoot` is the LITERAL value returned by the prior persist call (no re-derivation, content-address purity preserved). Universalize's persist step must use the same order.

**Why an empty/no-persist path stays identical:** when `options.persist` is undefined or false, step 6 is a no-op and the existing return shape is preserved verbatim. This satisfies REQ-GOAL-001's "zero changes to today's default behavior" clause.

**Addresses: REQ-GOAL-001, REQ-GOAL-002, REQ-GOAL-003**

### DEC-UNIVERSALIZE-PERSIST-ERR-001 — Error handling

**Decision:** Persistence errors propagate unwrapped, matching the existing license-gate / decompose / slice error semantics (`universalize()` is documented in `index.ts:441-446` to propagate all step errors unwrapped).

Specifically:

- License gate rejection (`LicenseRefusedError`): thrown by step 1 — persistence step 6 never runs. No row written. **Acceptance A6 covers this.**
- `findByCanonicalAstHash` mismatch / atom-test failure: today `maybePersistNovelGlueAtom` does not run atom-test gates internally; gating happens upstream in the slicer (atoms reach `NovelGlueEntry` only after passing `isAtom()`). No new error class needed.
- `registry.storeBlock` throws: propagate unwrapped (SQLite errors etc.). Already the contract of `shave()`.
- `persist: true` requested but `registry.storeBlock` is absent: throw new `PersistRequestedButNotSupportedError` (loud-fail). Located in `packages/shave/src/errors.ts` alongside existing error classes.

**Addresses: REQ-GOAL-001, A6**

---

## 4. Backwards compatibility audit

Every call site that imports `universalize` or `@yakcc/shave` was checked (planner used `grep -rn "universalize(" packages/`):

| Call site | File | Lines | Impact |
| --- | --- | --- | --- |
| `assembleCandidate()` (the consumer this WI is about) | `packages/compile/src/assemble-candidate.ts:188-192` | Active | **Will change** to pass `persist: true`. Today throws on novel-glue; after WI it returns the artifact. |
| `shave()` (the file wrapper) | `packages/shave/src/index.ts:647` | Active | **Unchanged in slice 1.** In slice 2 (optional), refactored to pass `persist: true` and delete its own postorder loop. Net behavior identical (REQ-GOAL-003). |
| `createIntentExtractionHook()` | `packages/shave/src/index.ts:858-864` | Active | Unchanged — hook factory delegates to `universalize()` with caller-supplied options. Caller decides whether to pass `persist`. |
| `atomize()` (hook layer) | `packages/hooks-base/src/atomize.ts:510-517` | Active | Unchanged — calls `universalize()` without `persist:true`, then does its own per-entry `buildBlockRow` + `storeBlock` loop. **Flag as P1 follow-up consolidation candidate.** |
| `wiring.test.ts` | `packages/shave/src/universalize/wiring.test.ts:161, 197, 238, 261, 288, 348` | Test | Unchanged — these tests call `universalize()` without `persist`; default path is preserved. The line-342 regression test (`single-leaf entry from universalize() persists with defined merkleRoot`) manually calls `maybePersistNovelGlueAtom` after — this can stay or be migrated to a one-call `universalize({persist:true})` form. |
| `assemble-candidate.test.ts` Test 4 | `packages/compile/src/assemble-candidate.test.ts:356-379` | Test | **Inverts**. Today asserts the throw; after WI asserts the artifact. |
| `assemble-candidate.test.ts` Test 1, 2, 3 | `packages/compile/src/assemble-candidate.test.ts:~140-340` | Test | Unchanged — license-refused (Test 1), PointerEntry (Test 2), multi-leaf (Test 3) paths are orthogonal. |
| `skeleton.test.ts` | `packages/shave/src/skeleton.test.ts:60-70` | Test | Unchanged — live-wiring smoke test with no registry. |
| Examples: `v0.7-mri-demo/test/acceptance.test.ts`, `v1-federation-demo/test/acceptance.test.ts`, `v1-wave-3-wasm-lower-demo/test/cache.test.ts` | examples | Active | Use `shave()`, not `universalize()` directly. Unchanged. |

**Net assessment:** the only production caller whose behavior changes is `assembleCandidate()`. Every other caller defaults to `persist: undefined` and preserves today's semantics bit-for-bit.

**Tests that would have asserted the throw** (Test 4 above) must be inverted. No call sites accidentally relying on the throw behavior have been found; the throw is plumbing-incomplete, not load-bearing.

**Addresses: REQ-GOAL-003**

---

## 5. Test plan

All tests run with `intentStrategy: "static"` (B6 air-gap compliant — no Anthropic API call) and `openRegistry(":memory:")` (real SQLite, no mocking of the persistence boundary, per `DEC-REGISTRY-PARENT-BLOCK-004` and the precedent in `multi-leaf-persist.test.ts`).

### T1 — Single novel-glue, persist:true, end-to-end through `assembleCandidate()` (CORE)

- Location: `packages/compile/src/assemble-candidate.test.ts` (inverts Test 4).
- Source: single expression-body arrow function not in registry.
- Assertions:
  - `assembleCandidate(source, registry)` resolves; returns an `Artifact` with `source.length > 0`.
  - The artifact's `manifest.entries` includes one entry whose `blockMerkleRoot` matches the persisted atom.
  - `registry.getBlock(blockMerkleRoot)` returns a non-null row with `parentBlockRoot === null`, `canonicalAstHash` matching the source's canonical AST hash, and a populated `specHash`.

### T2 — Default path (persist:undefined) is unchanged

- Location: `packages/shave/src/universalize/wiring.test.ts` (extend or add a sibling test).
- Source: same single novel-glue source as T1.
- Assertions:
  - `universalize({source}, registry)` (no `persist` flag) returns a slice plan whose single `NovelGlueEntry` has `merkleRoot === undefined`.
  - `registry.getBlock(...)` for the expected hash returns null/undefined — nothing persisted.
- Purpose: pin the backwards-compat contract.

### T3 — `persist:true` + license-refused source

- Location: `packages/compile/src/assemble-candidate.test.ts`.
- Source: a GPL-licensed source string.
- Assertions:
  - `assembleCandidate(source, registry)` throws `LicenseRefusedError`.
  - `registry.getBlock(...)` for any plausible hash derivable from the source returns null — **no rows written**.
- Addresses A6.

### T4 — `persist:true` + registry without `storeBlock` → loud error

- Location: new test in `packages/shave/src/universalize/wiring.test.ts` (alongside the existing persist-regression test).
- Source: any valid novel-glue source.
- Registry: a `ShaveRegistryView` stub WITHOUT `storeBlock`.
- Assertions:
  - `universalize({source}, view, {persist: true})` throws `PersistRequestedButNotSupportedError`.
  - No silent no-op.

### T5 — Determinism vs. `shave()` (REQ-GOAL-A2, A7)

- Location: new test in `packages/shave/src/persist/atom-persist.test.ts` or a new sibling file.
- Source: a single-leaf novel-glue source (use the ATOMIC_SOURCE fixture).
- Procedure: open two `:memory:` registries. Call `shave(tmpFile, registry1, {...})` and `universalize({source}, registry2, {persist:true, ...})`. Compare row sets.
- Assertions:
  - Both registries contain exactly one block.
  - The `blockMerkleRoot`, `specHash`, `canonicalAstHash`, and `parentBlockRoot` are identical.
  - The `proofManifestJson` and `specCanonicalBytes` are byte-identical.
- Purpose: proves persistence path consolidation is real (Sacred Practice #12).

### T6 — Multi-leaf novel-glue: persists each entry, surfaces merkleRoot on each, but assembleCandidate still throws

- Location: `packages/shave/src/persist/multi-leaf-persist.test.ts` extension OR a new test in the wiring file.
- Source: the existing multi-leaf fixture (two top-level if-statements, each becomes its own atom).
- Assertions:
  - `universalize({source}, registry, {persist:true})` returns a slice plan where every `NovelGlueEntry` carries a defined `merkleRoot`.
  - Each row's `parentBlockRoot` lineage matches the existing `multi-leaf-persist.test.ts` expectations (lineage chain preserved).
  - `assembleCandidate(source, registry)` still throws the multi-leaf `CandidateNotResolvableError` (multi-leaf assembly is out of scope per REQ-NOGO-003).
- Purpose: proves the persistence step does the right thing for multi-leaf even though the assembly resolver doesn't yet.

### T7 — `shave()` regression suite still passes

- Location: existing `packages/shave/src/persist/multi-leaf-persist.test.ts`, `atom-persist.test.ts`, plus all `wiring.test.ts` tests.
- No change required to these tests in slice 1. In slice 2 (if `shave()` is refactored to delegate), these tests are the regression suite that proves slice 2 changed nothing observable.

---

## 6. Slicing recommendation

**Recommendation: one slice is sufficient and preferred.** The work is bounded:

- 1 type extension (`NovelGlueEntry.merkleRoot?` + new `UniversalizeOptions`).
- 1 new error class (`PersistRequestedButNotSupportedError`).
- 1 new step in `universalize()` (gated on `options.persist`).
- 1 deletion + replacement in `assemble-candidate.ts:140-148`.
- 1 test inversion + ~5 new tests.

Estimated agent effort: **M (15-40 turns)**. The implementer's burden is mostly test scaffolding (seed cache, seed registry, assert merkle roots), not novel logic — the persistence primitive already exists and the lineage-threading semantics are already proven by `shave()`.

**Optional slice 2 (P1, defer to follow-up WI):** refactor `shave()` to delegate to `universalize({persist:true, sourceContext, ...})` instead of running its own postorder loop. This is the Sacred Practice #12 consolidation; it deletes ~40 lines from `index.ts` and ensures there is one persistence path, not two. **Defer because:** it's mechanical, risk-isolated, and benefits more from a tester pass-over than from inclusion in the slice-1 scope. Flag at the implementer's @decision so the next-WI handoff is clean.

**Do NOT slice further.** Splitting the type change from the implementation, or splitting the universalize change from the assemble-candidate change, would create intermediate states that don't compile or don't pass tests. The change is naturally atomic.

---

## 7. Hook-layer interaction (issue body §"Why this matters")

The hook-layer Phase 2 substitution issue (WI-HOOK-PHASE-2-SUBSTITUTION) is **enumerated in the hook-layer ADR (`docs/adr/hook-layer-architecture.md:206`) but not yet filed as a discrete GitHub issue**. Per `docs/adr/hook-layer-architecture.md:206`: *"WI-HOOK-PHASE-2-SUBSTITUTION: Smart substitution: rewrite tool-call output per D-HOOK-2; integrate D2 findCandidatesByQuery post-WI-V3-DISCOVERY-IMPL-QUERY"*.

**Existing hook-layer code already handles persistence on its own.** `packages/hooks-base/src/atomize.ts:510-572` does:

```
universalize(source, registry, {intentStrategy:"static", offline:true})
  → for each novel-glue entry:
      buildBlockRow(entry)         (uses extractCorpus + buildTriplet equivalent)
      registry.storeBlock(row)     (idempotent)
```

This is **parallel to `maybePersistNovelGlueAtom`** — a Sacred Practice #12 violation that pre-dates this WI. It's out of scope to fix here, but **flag it for slice 2 / a follow-up WI**: once `universalize({persist:true})` lands, `atomize.ts` should consolidate onto it.

**Does Phase 2 substitution need to call `universalize({persist:true})` directly, or does the assemble-candidate path cover it?**

- If Phase 2 substitution uses the **assemble-candidate path** (i.e., it takes raw source text and produces a compiled artifact), it gets `universalize({persist:true})` for free once this WI lands. **Recommended path.**
- If Phase 2 substitution uses its **own ingestion path** (like `atomize.ts` does today — call `universalize()` then iterate the slice plan), it should consolidate onto `universalize({persist:true})` for the same reason `atomize.ts` should. This is the slice-2 consolidation work.

**Net dependency direction:** Phase 2 substitution **depends on** this WI (or it duplicates the work, which is the parallel-mechanism violation). The hook-layer ADR's estimate of "~4 weeks" for Phase 2 assumes some ingestion plumbing — landing WI-373 first **shortens** that estimate by removing one work item from Phase 2's scope.

**Action item for orchestrator:** when WI-HOOK-PHASE-2-SUBSTITUTION is filed, cross-reference WI-373 as a prereq and `atomize.ts` consolidation as a sub-task.

**Addresses: REQ-GOAL-001 unblocks Phase 2 ingestion**

---

## 8. Out of scope (explicit non-goals)

This WI does NOT cover:

- **Multi-leaf assembly resolution** (`assemble-candidate.ts:124-128` — multi-leaf slice still throws). Separate WI.
- **`atomize.ts` consolidation** (`packages/hooks-base/src/atomize.ts:540-572` — its parallel `buildBlockRow` + `storeBlock` loop stays for now). Flag as follow-up, see §7.
- **`shave()` refactor to delegate to `universalize({persist:true})`** — optional slice 2, see §6.
- **Federation push** of newly-persisted atoms. The local registry stores; nothing pushes upstream.
- **License-policy changes**. The existing license gate semantics are preserved.
- **Schema changes** to `BlockTripletRow`, registry tables, or `BlockMerkleRoot` derivation.
- **CLI flag changes** to `yakcc compile` or `yakcc shave`. The behavior change is transparent to operators.
- **Per-leaf `sourceContext` derivation for multi-leaf source files via the assemble-candidate path.** When `assembleCandidate()` calls `universalize({persist:true})`, it has no `sourceContext` to forward (interactive use). Atoms persist with null provenance, which is correct for non-bootstrap runners per `DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001`.

---

## 9. Implementation checklist (for the implementer)

In suggested order:

1. **Read** `packages/shave/src/types.ts`, `packages/shave/src/universalize/types.ts`, `packages/shave/src/index.ts` (universalize + shave bodies), `packages/shave/src/persist/atom-persist.ts`, and `packages/compile/src/assemble-candidate.ts`. Cross-reference this plan.
2. **Add type** `UniversalizeOptions extends ShaveOptions { readonly persist?: boolean }` in `packages/shave/src/types.ts`. Export from `packages/shave/src/index.ts`.
3. **Extend** `NovelGlueEntry` in `packages/shave/src/universalize/types.ts:209-216` with `readonly merkleRoot?: BlockMerkleRoot`. Document the field is populated only after persistence ran.
4. **Add error** `PersistRequestedButNotSupportedError` in `packages/shave/src/errors.ts`. Export from `index.ts`.
5. **Modify** `universalize()` in `packages/shave/src/index.ts:452-581`:
   - Accept the new options type (or keep `ShaveOptions` and add `persist?: boolean` there — implementer's call, justify in @decision).
   - Add step 6: if `options.persist === true`, run the postorder persistence loop (lift logic from `shave()`'s `index.ts:741-779` block — preserve `parentBlockRoot` lineage threading exactly).
   - Surface `merkleRoot` on each persisted `NovelGlueEntry`.
   - If `persist:true` but `storeBlock` missing, throw `PersistRequestedButNotSupportedError`.
6. **Modify** `assembleCandidate()` in `packages/compile/src/assemble-candidate.ts:177-200`:
   - Pass `persist: true` in the `universalize()` call (merging with `options.shaveOptions`).
   - Update `resolveToMerkleRoot()` (lines 117-148): for `kind === "novel-glue"`, return `only.merkleRoot` if defined; otherwise throw a clearer error (no more TODO).
   - Delete the `TODO(future-WI)` comment.
7. **Invert** Test 4 in `packages/compile/src/assemble-candidate.test.ts:356-379`. Add T1, T3, T4, T5, T6 per §5. Keep T7 as the existing regression suite.
8. **Run** `pnpm --filter @yakcc/shave test`, `pnpm --filter @yakcc/compile test`, `pnpm -r build`. All green.
9. **Document** the decision in two `@decision` annotations at the call sites: `DEC-UNIVERSALIZE-PERSIST-API-001` on the new `universalize()` step 6 block, and `DEC-UNIVERSALIZE-PERSIST-PIPELINE-001` on the modified `assembleCandidate()`.
10. **Optional (P1)**: flag the `shave()` consolidation and `atomize.ts` consolidation as follow-up issues in the PR description (do not implement them in this slice).

---

## 10. Critical files (for handoff)

| File | Role |
| --- | --- |
| `packages/shave/src/index.ts` | `universalize()` body — modified (new step 6); `shave()` body — unchanged in slice 1. |
| `packages/shave/src/types.ts` | `ShaveOptions` — possibly extended; new `UniversalizeOptions` type. |
| `packages/shave/src/universalize/types.ts` | `NovelGlueEntry` — gains optional `merkleRoot`. |
| `packages/shave/src/persist/atom-persist.ts` | Unchanged — the primitive being reused. |
| `packages/shave/src/errors.ts` | New `PersistRequestedButNotSupportedError`. |
| `packages/compile/src/assemble-candidate.ts` | `resolveToMerkleRoot()` and `assembleCandidate()` — modified. |
| `packages/compile/src/assemble-candidate.test.ts` | Test 4 inverted; new tests added. |
| `packages/shave/src/universalize/wiring.test.ts` | New T2, T4 added (default-path, loud-fail). |
| `packages/shave/src/persist/atom-persist.test.ts` or sibling | New T5 (determinism vs. shave). |
| `packages/shave/src/persist/multi-leaf-persist.test.ts` | New T6 (multi-leaf persist works through universalize). |

---

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| `NovelGlueEntry` type extension breaks an external consumer (downstream `@yakcc/shave` users). | Low — it's optional. | Document as a strictly-additive change in PR description; no version bump required for opt-in fields. |
| Postorder logic lifted from `shave()` (lineage threading) is subtly different in `universalize()` context. | Medium. | T5 (determinism vs. shave) is the regression gate. Implementer should lift the loop verbatim, not paraphrase. |
| `assembleCandidate()` callers in tests rely on the throw. | Low — only Test 4 found; documented. | Test 4 inversion is part of this WI. |
| Hook-layer `atomize.ts` continues to use the parallel path. | Acknowledged. | Out of scope; flagged for follow-up per §7. |
| Slice 2 (`shave()` delegation) is deferred and never lands. | Medium. | Implementer flags it explicitly in @decision; orchestrator files the follow-up issue at PR merge time. |

---

## 12. Decision Log (for MASTER_PLAN.md amendment after merge)

The orchestrator should append these rows to `MASTER_PLAN.md`'s `## Decision Log` table when the WI lands:

| Date | DEC-ID | Initiative | Title | Rationale |
| --- | --- | --- | --- | --- |
| 2026-05-12 | DEC-UNIVERSALIZE-PERSIST-API-001 | WI-373 | `universalize({persist:true})` opt-in flag with `NovelGlueEntry.merkleRoot?` extension | Minimal surface delta; backwards-compatible by default; consolidates onto existing `maybePersistNovelGlueAtom` primitive (Sacred Practice #12); enables `assembleCandidate()` to resolve novel-glue and unblocks v0.5 hook layer Phase 2. |
| 2026-05-12 | DEC-UNIVERSALIZE-PERSIST-PIPELINE-001 | WI-373 | Persistence step 6 runs after intentCard attachment, in DFS postorder, with `parentBlockRoot` lineage threading lifted verbatim from `shave()` | Preserves `DEC-REGISTRY-PARENT-BLOCK-004` content-address purity; identical semantics to existing `shave()` path; T5 determinism test gates regressions. |
| 2026-05-12 | DEC-UNIVERSALIZE-PERSIST-ERR-001 | WI-373 | Persistence errors propagate unwrapped; `PersistRequestedButNotSupportedError` thrown when `persist:true` and `storeBlock` absent | Sacred Practice #5 (loud failure); matches existing `universalize()` error-propagation contract. |
