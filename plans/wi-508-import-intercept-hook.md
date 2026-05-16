# WI-508 — Import-Intercept Hook

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Implements [#508](https://github.com/cneckar/yakcc/issues/508). Subordinate to the reframed triad coordination doc.
**Branch:** `feature/wi-508-import-intercept`
**Worktree:** `C:/src/yakcc/.worktrees/wi-508-import-intercept`
**Authored:** 2026-05-14 (planner stage, workflow `WI-508-IMPORT-INTERCEPT`)
**Parent coordination doc:** `plans/import-replacement-triad.md` (reframed 2026-05-14 — see note below).
**Sibling slice plan (the pattern this doc follows):** `plans/wi-510-shadow-npm-corpus.md`, `plans/wi-512-b10-import-heavy-bench.md`.

> **CONSISTENCY NOTE — the triad reframe.** The triad coordination doc was reframed on 2026-05-14 (the reframed version currently lives on `feature/wi-510-shadow-npm-corpus`; it supersedes the pre-#517 version still on `main`). The reframe changes #510 from "hand-author ~30 shadow-npm atoms" to a **`@yakcc/shave` engine change** that follows dependency edges and emits a connected call-graph atom forest into the registry. **This makes #508 cleaner, not harder.** Because #510's engine *produces* behavior-named, content-addressed atoms, #508 has **no atom-naming question to resolve and no `npm_aliases` mapping table to maintain.** #508's job is purely: detect the non-builtin `import`, build a `QueryIntentCard`, query the registry, and — if a candidate clears the intercept threshold — refuse the unexpanded import and surface the atom composition. This plan is written to be consistent with the reframed triad doc; if the orchestrator lands #508 work before the reframed triad doc is merged to `main`, the reframed triad doc (not the pre-#517 version) is the authority.

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice.

---

## 1. Root Cause / The Verified Capability Gap

**The problem, restated.** yakcc's atom-first hook (`@yakcc/hooks-base`) fires at **function-emission boundaries**: when an agent's `Edit`/`Write`/`MultiEdit` tool call carries emitted code, `executeRegistryQueryWithSubstitution()` runs a registry query and — under the D2 auto-accept rule — can substitute a content-addressed atom for a hand-rolled function. That is the *demand-side* of yakcc's value proposition for **functions the agent writes**.

But yakcc's headline value proposition is **dependency replacement** — "instead of `import { isEmail } from 'validator'`, compose content-addressed atoms with a tiny reachable surface." That value lands at the `import` boundary, and **there is no intercept there.** The hook fires when an agent *writes a function*; it does **not** fire when an agent *writes an import statement*. So today, dependency replacement only happens if the LLM *opportunistically* chooses atoms over an import — it is not load-bearing.

**The verified gap (confirmed against the worktree at planning time):**

1. **`packages/hooks-base/src/index.ts :: executeRegistryQueryWithSubstitution()`** is the production emit-boundary entry point. It builds an `IntentQuery` from the `EmissionContext` (prose intent + optional source context), calls `registry.findCandidatesByIntent()`, then runs `executeSubstitution()` (D2 gate → `extractBindingShape()` → `renderSubstitution()`). **Nothing in this path inspects `import` declarations.** `buildIntentCardQuery()` produces `{ behavior, inputs: [], outputs: [] }` from prose only — it never decomposes an import specifier into a behavioral query.

2. **`packages/hooks-base/src/substitute.ts :: executeSubstitution()`** operates on a single *binding* snippet (`const x = fn(...)` via `extractBindingShape()` in `@yakcc/ir`). There is no `ImportDeclaration`-shaped path. `renderSubstitution()` emits `import { <atomName> } from "@yakcc/atoms/<atomName>"` — it *produces* atom imports; it never *consumes/refuses* an npm import.

3. **`packages/compile/src/assemble.ts :: assemble()`** takes a `BlockMerkleRoot` entry (an already-registered atom) and resolves its composition graph. **It never sees a raw input module**, so it has no place to reject "this module imports `validator` and atoms exist for that surface." `resolveComposition()` in `resolve.ts` walks `import type` lines for *intra-yakcc* sub-block paths (`./x.js`, `@yakcc/seeds/blocks/x`) — it is explicitly **not** an external-npm-import detector and is the wrong place to add one (this is also called out in the reframed triad doc §4).

4. **`packages/hooks-base/` has no ts-morph dependency.** AST work in hooks-base is done by lazy-importing `@yakcc/ir` (`extractBindingShape`). `packages/compile/` *does* depend on ts-morph. The existing AST import classifier in the codebase is `classifyForeign()` in `packages/shave/src/universalize/slicer.ts` — it already handles `isTypeOnly()`, relative (`.`-prefixed), `node:` builtins (`NODE_BUILTIN_PREFIX`), and `@yakcc/` workspace specifiers. **#508 must reuse that classification discipline, not reinvent it.**

**Consequence.** An agent that writes `import { isEmail } from 'validator'` sails straight through the production hook untouched, and the compiled output carries `validator`'s entire transitive `node_modules` reachable surface. The intercept that would turn that import into a composed atom tree **does not exist**. #508 builds it.

---

## 2. Architecture

#508 has two enforcement points, deliberately layered:

### 2.1 The pre-emit scan — in `@yakcc/hooks-base` (the SUGGESTION layer)

A new module **`packages/hooks-base/src/import-intercept.ts`** owns the pre-emit import scan. It is invoked from inside `executeRegistryQueryWithSubstitution()` in `index.ts` — the **existing** production emit-boundary entry point — as an **additive branch**, exactly the way the Phase 3 atomize path (`DEC-HOOK-ATOM-CAPTURE-001`) was added: it runs, it can enrich the returned response, and **it never breaks the observe-don't-mutate fallback.**

Flow for one `Edit`/`Write`/`MultiEdit` payload:

1. **AST scan (never regex).** Parse the tool call's emitted text (`new_string` / `content`) with ts-morph and call `getImportDeclarations()`. For each `ImportDeclaration`:
   - **Skip** if `isTypeOnly()` is true (type-only import).
   - **Skip** if the module specifier is relative (starts with `.`).
   - **Skip** if the specifier is a `node:` builtin or a bare Node core module (`fs`, `path`, …) — reuse the `classifyForeign()` builtin set / `NODE_BUILTIN_PREFIX` discipline from `packages/shave/src/universalize/slicer.ts`; do not hand-roll a second builtin list.
   - **Skip** if the specifier is a `@yakcc/` workspace import (already-yakcc, nothing to intercept).
   - Otherwise it is a **non-builtin external import** — a candidate for intercept. Capture its named / default / namespace specifiers (`ImportSpecifier`, `ImportClause` default name, `NamespaceImport`).
   - **Dynamic / template-literal imports** (`import(...)`) are **not intercepted** in Slice 1 — they are logged to telemetry as a known limitation (see §5 risk). Static `ImportDeclaration`s only.
2. **`QueryIntentCard` construction.** For each intercept candidate, build a `QueryIntentCard` (the `@yakcc/contracts` type, fields per `docs/adr/discovery-llm-interaction.md` / `docs/adr/discovery-query-language.md`). The `behavior` field is a prose intent string derived from **(a)** the imported binding name(s) and **(b)** the surrounding `EmissionContext.intent` — e.g. for `import { isEmail } from 'validator'` with intent "validate a user-supplied email", `behavior = "validate email — isEmail from validator"`. The binding name is the load-bearing token; the prose intent disambiguates. (One `QueryIntentCard` per import declaration; multiple named bindings from one declaration share the declaration's card with all binding names folded into `behavior`. Per-binding cards are a #508 Slices 2-N refinement, not Slice 1.)
3. **Registry query.** Call the **embedded** registry query path — `yakccResolve(registry, intentCard)` from `packages/hooks-base/src/yakcc-resolve.ts`, which wraps `registry.findCandidatesByQuery()` and returns the D4 `ResolveResult` envelope (`status: "matched" | "weak_only" | "no_match"`, ranked `EvidenceProjection[]`). This is the **same** registry-query authority the rest of hooks-base uses (`DEC-HOOK-PHASE-3-L3-MCP-001`) — no parallel query mechanism.
4. **Intercept decision.** If `ResolveResult.status === "matched"` (i.e. at least one candidate at `combinedScore >= CONFIDENT_THRESHOLD`, the existing `0.70` constant in `yakcc-resolve.ts`) for an intercept-eligible package, the import is **intercepted**: the hook surfaces the atom-composition suggestion as an inline contract comment (the existing `renderContractComment()` mechanism from `substitute.ts`, `DEC-HOOK-PHASE-3-001`) above the offending import, naming the matched atom(s). When `status` is `weak_only` / `no_match` (the registry has no covering atom — e.g. before #510's `validator` forest lands), the scan is a **graceful no-op**: the import passes through untouched, exactly as today.
5. **Disable knob.** The pre-emit scan rides the **existing** `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` env override (`DEC-HOOK-PHASE-2-001`). **No second disable knob.** When that var is `"1"`, the import scan is bypassed along with substitution.
6. **Slice-1 scoping.** For Slice 1 the intercept is **scoped to `validator`**. The recommended mechanism is an **allowlist-of-one** (`["validator"]`) — a single named constant in `import-intercept.ts` — because it gives the smallest blast radius and is trivially auditable. The reframed triad doc notes registry-driven granularity ("intercept whenever the registry has a covering candidate") is the natural generalization for #508 Slices 2-N; that generalization needs **no schema extension** in the reframe (the registry already answers "is there a covering candidate?" via `findCandidatesByQuery`). Allowlist-of-one vs registry-driven-start is an **implementer/planner-decidable** point per the reframed triad doc §5 — Slice 1 is written as allowlist-of-one.

The pre-emit scan is the **suggestion** layer: it tells the agent "atoms exist for this import." It is observe-and-enrich; it does not, by itself, *prevent* an unexpanded import from reaching a build.

### 2.2 The compile-time gate — in `@yakcc/compile` (the ENFORCEMENT layer)

The suggestion layer can be ignored by the LLM. The **load-bearing enforcement** is a compile-time gate: a NEW pre-assembly scanning step in `@yakcc/compile` that **refuses** a module carrying an unexpanded non-builtin import when the registry has covering atoms.

- **New module: `packages/compile/src/import-gate.ts`.** It exports a function that takes an input module's TS source (or a ts-morph `SourceFile`) plus a `Registry`, runs the **same** AST-based import classification as §2.1 (non-builtin / non-type-only / non-relative / non-`@yakcc` external imports), queries the registry per import via the same `findCandidatesByQuery` path, and **throws a typed error** (e.g. `UnexpandedImportError`, modeled on the existing `ResolutionError` / `GlueLeafInWasmModeError` typed-error pattern in `@yakcc/compile`) when an import has registry coverage at/above the intercept threshold.
- **This is NOT a modification of `resolve.ts`.** `resolveComposition()` handles intra-yakcc composition (`import type` sub-block paths) — it is explicitly the wrong place (reframed triad doc §4; `@decision DEC-COMPILE-RESOLVE-002`). The import gate is a **sibling module** that runs **before** composition resolution. The implementer may co-locate it with existing pre-resolution validation or keep it a standalone sibling — that is code-organization latitude, not an architectural choice.
- **It is wired as an opt-in pre-step**, not silently injected into `assemble()`. `assemble()` consumes a `BlockMerkleRoot` (an already-registered atom), not a raw module — so the gate is invoked by the caller that *has* a raw input module (the `yakcc compile` CLI path / the B10 `arm-a-emit` driver), passing the module source through `import-gate.ts` before it reaches assembly. The gate is **exported from `packages/compile/src/index.ts`** so those callers can invoke it. Slice 1 wires the gate and proves it; broad CLI adoption across every compile entry point is a #508 Slices 2-N concern.
- **The yakcc-internal allowlist** for the gate is: `@yakcc/seeds/blocks/*`, `@yakcc/atoms/*` (the substitution import convention from `DEC-HOOK-PHASE-2-001`), relative paths, `node:`/core builtins, and `@yakcc/*` workspace packages. Everything else is an external import subject to the registry-coverage check.
- **`examples/**` carve-out.** Existing `examples/**` may import npm packages and must not be retroactively broken. Slice 1's gate is invoked only by the explicit `yakcc compile` / B10-driver path on the modules those callers pass; it is **not** a global lint over the repo. If a later slice wires the gate into a path that would touch `examples/**`, that slice carves `examples/**` out with an `@decision` annotation. Slice 1 does not need the carve-out because Slice 1 does not wire the gate into any `examples/**`-touching path.

### 2.3 State-Authority Map

| State domain | Canonical authority | #508's relationship |
|---|---|---|
| Emit-boundary hook policy | `@yakcc/hooks-base` (`DEC-HOOK-BASE-001`) — `index.ts` `executeRegistryQueryWithSubstitution()` | #508 adds `import-intercept.ts` **inside** this authority as an additive branch. **Not** duplicated into `hooks-claude-code`. |
| Registry query / candidate scoring | `Registry.findCandidatesByQuery()` via `yakccResolve()` (`DEC-HOOK-PHASE-3-L3-MCP-001`) | #508 **consumes** this surface unchanged. No new query path. |
| Intercept threshold | `CONFIDENT_THRESHOLD = 0.70` in `packages/hooks-base/src/yakcc-resolve.ts` | #508 **reuses** this constant. No new threshold constant. |
| Hook disable knob | `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` (`DEC-HOOK-PHASE-2-001`) | #508 **rides** this knob. No second knob. |
| AST import classification | `classifyForeign()` discipline in `packages/shave/src/universalize/slicer.ts` (type-only / relative / `node:` builtin / `@yakcc/` workspace) | #508 **mirrors** this classification in `import-intercept.ts` and `import-gate.ts`. The shared rule set may be lifted to a small shared helper if the reviewer flags duplication, but it must be **one** rule set, not two divergent ones. |
| Compile-time gate / pre-assembly validation | NEW — `packages/compile/src/import-gate.ts`. There is no pre-existing external-npm-import gate in `@yakcc/compile`. | #508 creates this authority. It must be the **only** external-import gate after this slice. |
| Telemetry | `packages/hooks-base/src/telemetry.ts` (`DEC-HOOK-PHASE-1-001`) | #508 emits intercept events through the **existing** telemetry path. No new telemetry authority. |
| Contract comment rendering | `renderContractComment()` in `substitute.ts` (`DEC-HOOK-PHASE-3-001`) | #508 **reuses** this for the inline atom-composition suggestion. |

---

## 3. Slicing Plan

```
Slice 1 (THIS PLAN, fully specified §4-§6) — PROVABLE NOW
   The import-intercept MECHANISM, end-to-end, against synthetic/fixture atoms.
   - import-intercept.ts: AST pre-emit scan + QueryIntentCard construction
     + registry query wiring + intercept decision, wired into
       executeRegistryQueryWithSubstitution() as an additive branch
   - import-gate.ts: compile-time gate (new pre-assembly scan module in @yakcc/compile)
   - validator-scoped (allowlist-of-one) for Slice 1
   - graceful no-op when the registry has no covering atom (returns {atoms:[]}-equivalent)
   - proven with SYNTHETIC fixture atoms — does NOT depend on #510's real forest
        │
        ▼  (mechanism proven; #510 Slice 2 lands a real `validator` forest)
Slice 2 — End-to-end validator demo  [GATED ON #510 Slice 2]
   Point the proven mechanism at #510's real shaved `validator` forest:
   intercept a real `import { isEmail } from 'validator'`, get back the
   connected atom tree, compile-gate refuses the unexpanded import.
   This is triad phase P2b's true end-to-end exercise and unblocks #512 Slice 2.
        │
        ▼
Slice 3-N — Broaden intercept coverage  [each GATED ON the corresponding #510 fixture slice]
   Generalize from validator-only to the rest of #510's fixture packages.
   With registry-driven granularity this is mostly verification + telemetry work
   (the mechanism generalizes; each slice confirms "it just works" + adds fixtures).
   Per-binding QueryIntentCard refinement and namespace-import (`import * as _`)
   handling live here. Telemetry: per-package intercept hit-rate counters.
```

**Why the mechanism is provable now (Slice 1 is NOT gated on #510).** The pre-emit AST scan, `QueryIntentCard` construction, registry-query wiring, intercept decision, and the compile-time gate are all exercisable with **synthetic fixture atoms** seeded into a test registry. The mechanism's defining behavior — "query the registry; if `status === matched` intercept, else graceful no-op" — returns the no-op path correctly when the registry has no coverage. Slice 1 proves both halves: (a) intercept fires when a fixture atom covers the import; (b) graceful no-op when it does not. The **real** `validator` forest is only needed for the **end-to-end demo** (Slice 2), and that dependency on #510 Slice 2 is named explicitly.

**Dependency edges.** Slice 1 → Slice 2 (`#510 Slice 2` co-dependency) → [#512 Slice 2]. Slices 3-N each depend on Slice 1 (mechanism) + the corresponding #510 fixture slice. Slices 3-N do **not** change the Slice 1 mechanism core — a mechanism gap discovered in a coverage slice is a bug filed against the mechanism, not an in-slice rewrite.

**Per-slice gate.** `review` (reviewer verifies the Evaluation Contract). Slice 1 stays within `@yakcc/hooks-base` + `@yakcc/compile` internal/public-additive surface — `review` suffices; no constitutional edit.

**Critical path:** Slice 1 → Slice 2 (with #510 Slice 2) → #512 Slice 2 (MVDP terminal). Max width after Slice 1: the #510-fixture-paired coverage slices, parallelizable.

---

## 4. Evaluation Contract — Slice 1 (the mechanism)

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at the end (§6).

### 4.1 Required tests

- **`pnpm --filter @yakcc/hooks-base test`** — the full hooks-base suite passes, **zero regressions**. The new `import-intercept.ts` branch is additive: when no non-builtin import is present, `executeRegistryQueryWithSubstitution()` behaves byte-identically to today (the existing `index.test.ts`, `substitute.test.ts`, `telemetry.test.ts`, `atomize.test.ts`, `substitution-integration.test.ts`, and all `*.props.test.ts` stay green).
- **`pnpm --filter @yakcc/compile test`** — the full compile suite passes, **zero regressions**. `resolve.ts`, `assemble.ts`, `assemble-candidate.ts`, `slice-plan.ts` behavior is unchanged; `import-gate.ts` is a new sibling module.
- **`pnpm --filter @yakcc/hooks-claude-code test`** — green; the adapter is touched only for re-export wiring (if anything), no policy duplication.
- **`pnpm --filter @yakcc/hooks-base build && pnpm --filter @yakcc/compile build`** — `tsc` compiles clean for both packages.
- **`pnpm --filter @yakcc/hooks-base typecheck && pnpm --filter @yakcc/compile typecheck`** — no type errors.
- **New unit tests — import classification (`import-intercept.ts`):** a fixture set of emitted-code strings proves the scan correctly:
  - identifies `import { isEmail } from 'validator'` as an **intercept candidate**;
  - **skips** `import { readFile } from 'node:fs'` (builtin), `import { x } from 'fs'` (bare core), `import { y } from './local.js'` (relative), `import { z } from '@yakcc/contracts'` (workspace);
  - **skips** `import type { T } from 'validator'` (type-only) and `import { type T, isEmail } from 'validator'` correctly isolates the value binding;
  - captures named (`ImportSpecifier`), default (`ImportClause`), and namespace (`NamespaceImport`) specifier names;
  - treats `import(...)` dynamic/template-literal imports as **not intercepted** (and the test asserts they are logged, not silently dropped).
- **New unit tests — `QueryIntentCard` construction (`import-intercept.ts`):** for `import { isEmail } from 'validator'` with a given `EmissionContext.intent`, the produced `QueryIntentCard` has the binding name (`isEmail`) present in the `behavior` field and is a structurally valid `QueryIntentCard` (per `@yakcc/contracts`). Verifies the binding token is load-bearing, not dropped.
- **New unit tests — intercept decision (`import-intercept.ts`):** with a stub/fake `Registry` returning `status: "matched"` (candidate at `combinedScore >= 0.70`), the scan **intercepts** and produces a contract-comment suggestion naming the matched atom; with the registry returning `weak_only` / `no_match`, the scan is a **graceful no-op** (import passes through, response unchanged). With `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` set, the scan is **bypassed** entirely.
- **New integration test — pre-emit scan inside the hook:** a fixture `EmissionContext` + emitted-code payload containing `import { isEmail } from 'validator'`, run through `executeRegistryQueryWithSubstitution()` against a test registry seeded with a **synthetic** `validator`-covering atom, produces a response carrying the intercept suggestion; the same payload run against an **empty** registry passes through unchanged. (This is the mechanism's end-to-end-within-Slice-1 proof; it uses a synthetic atom, NOT #510's real forest.)
- **New unit + integration tests — compile-time gate (`import-gate.ts`):** the gate **throws `UnexpandedImportError`** for a module containing `import { isEmail } from 'validator'` when the test registry has a covering atom; the gate **accepts** (does not throw) the same module when (a) the registry has no covering atom, or (b) the `validator` import has been replaced by the atom-composition form (`@yakcc/atoms/...`); the gate **accepts** modules whose only imports are `node:`/core builtins, relative paths, `@yakcc/seeds/*`, `@yakcc/atoms/*`, or `@yakcc/*` workspace specifiers.

### 4.2 Required real-path checks

- **Pre-emit scan on the production hook path.** A scripted exercise feeds `executeRegistryQueryWithSubstitution()` (the **real** production entry point, not a test-only shim) a synthetic emission payload containing `import { isEmail } from 'validator'` against a registry seeded with a synthetic `validator`-covering atom. The reviewer confirms the returned `HookResponseWithSubstitution` carries the intercept suggestion, and confirms the same call against an empty registry returns the unmodified passthrough response — proving the production sequence (`QueryIntentCard` → `findCandidatesByQuery` → intercept decision) actually runs and actually no-ops gracefully.
- **Compile-time gate on the `@yakcc/compile` public surface.** The gate is invoked through its **exported** `index.ts` entry point (the real surface a `yakcc compile` caller would use), proving `UnexpandedImportError` is thrown for an unexpanded covered import and not thrown for the atom-composed form.
- **Disable knob proven on the real path.** With `YAKCC_HOOK_DISABLE_SUBSTITUTE=1`, the production hook path is shown to skip the import scan (same passthrough as a no-coverage registry) — confirming #508 rides the existing knob and introduces no second one.

### 4.3 Required authority invariants

- **One emit-boundary hook authority.** `import-intercept.ts` lives **inside `@yakcc/hooks-base`** and is invoked from `executeRegistryQueryWithSubstitution()` in `index.ts`. The intercept **policy** is NOT duplicated into `packages/hooks-claude-code/` — that package stays an adapter (re-exports + harness-shaping only), consistent with `DEC-HOOK-BASE-001` and `DEC-HOOK-CLAUDE-CODE-PROD-001`. **No parallel intercept mechanism.**
- **One registry-query authority.** The scan and the gate both query the registry via the **existing** `findCandidatesByQuery` path (`yakccResolve` in hooks-base; a direct `findCandidatesByQuery` call in `@yakcc/compile`). No new registry-query function, no new scoring path.
- **One disable knob.** `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` (`DEC-HOOK-PHASE-2-001`) gates the import scan. Introducing a second env var is forbidden.
- **One intercept threshold.** The intercept fires at `CONFIDENT_THRESHOLD = 0.70` (the existing constant in `yakcc-resolve.ts`). No new threshold constant; if Slice 1 needs a distinct value it must `@decision`-justify reusing-vs-introducing — but the recommended path reuses `CONFIDENT_THRESHOLD`.
- **One import-classification rule set.** The "is this a non-builtin external import?" predicate (type-only / relative / `node:`-or-core builtin / `@yakcc/` workspace exclusions) must be a single rule set shared by `import-intercept.ts` and `import-gate.ts`, mirroring `classifyForeign()`'s discipline. Two divergent classifiers is a bug.
- **One compile-time external-import gate.** `import-gate.ts` is the only external-npm-import gate in `@yakcc/compile` after this slice. It is NOT a modification of `resolveComposition()`.
- **Observe-don't-mutate is preserved in the hook.** The `import-intercept.ts` branch, like the Phase 3 atomize path, **never** breaks the fallback: any failure inside the scan (ts-morph parse error, registry error) returns the original `HookResponse` unchanged. The hook's primary function must never be degraded by the import scan.
- **No registry schema change.** The reframe eliminates `npm_aliases`. #508 Slice 1 adds **no** column, table, or migration to `@yakcc/registry`.

### 4.4 Required integration points

- `packages/hooks-base/src/import-intercept.ts` — **new module**, the pre-emit scan + `QueryIntentCard` construction + intercept decision.
- `packages/hooks-base/src/index.ts` — wire the `import-intercept.ts` branch into `executeRegistryQueryWithSubstitution()` as an additive branch; export the new module's public surface as needed.
- `packages/hooks-base/src/yakcc-resolve.ts` — **consumed unchanged** (the `yakccResolve` / `CONFIDENT_THRESHOLD` surface). If a non-additive change to this file proves necessary, that is a reviewer-flagged scope escalation.
- `packages/hooks-base/src/substitute.ts` — `renderContractComment()` **consumed unchanged** for the inline suggestion.
- `packages/hooks-base/src/telemetry.ts` — intercept events emitted through the **existing** telemetry path; if a new telemetry field is needed it is **additive** to the existing event schema (backward-compatible), mirroring how Phase 2/3 fields were added.
- `packages/compile/src/import-gate.ts` — **new module**, the compile-time gate + `UnexpandedImportError`.
- `packages/compile/src/index.ts` — export `import-gate.ts`'s public surface (`UnexpandedImportError`, the gate function) so `yakcc compile` / B10-driver callers can invoke it.
- `packages/hooks-claude-code/src/index.ts` — re-export only, if the new hooks-base surface needs to be visible through the adapter. **No policy logic.**
- Test fixtures — emitted-code strings, synthetic covering atoms, and test-registry seeding live under `packages/hooks-base/test/` and `packages/compile/src/*.test.ts` (the existing test layout for each package).

### 4.5 Forbidden shortcuts

- **No regex-based import detection.** Import declarations are found via the AST (`getImportDeclarations()` / ts-morph), exactly as `classifyForeign()` already does. Regex-on-source silently fails on quoted-import-string edge cases, multi-line imports, and comment-embedded import text — it is a maintenance hazard and an enforcement hole.
- **No intercept policy in `hooks-claude-code`.** The adapter re-exports; it does not re-implement the scan. Duplicating policy into the adapter is the exact `DEC-HOOK-BASE-001` violation to avoid.
- **No second disable knob.** Ride `YAKCC_HOOK_DISABLE_SUBSTITUTE=1`.
- **No modification of `resolveComposition()` / `resolve.ts`** to add npm-import detection. The gate is a new sibling module. `resolve.ts` handles intra-yakcc composition only (`@decision DEC-COMPILE-RESOLVE-002`).
- **No throw-on-parse-failure in the hook path.** If ts-morph cannot parse the emitted payload (partial snippet, syntactically incomplete edit), the import scan degrades to a no-op and the hook returns the original response. Wholesale hook failure on an unparseable snippet violates observe-don't-mutate. (The **compile-time gate** may surface a typed error — it operates on a complete input module, not a partial edit snippet — but it must throw a *typed* `UnexpandedImportError`, not a bare `Error`, so callers can distinguish "unexpanded import" from "syntax error".)
- **No registry schema change / no `npm_aliases`.** The reframe eliminates the hand-naming step that field existed to support.
- **No new registry-query function.** Consume `findCandidatesByQuery` via the existing surfaces.
- **No hand-stitched atoms.** Slice 1 proves the mechanism with **synthetic** fixture atoms in a test registry. It does not hand-author "validator atoms" — those are #510's engine output (Slice 2 consumes the real forest).
- **No edits to `@yakcc/registry`, `@yakcc/contracts`, or `@yakcc/ir` source.** #508 *uses* `QueryIntentCard` (contracts), `findCandidatesByQuery` (registry), and ts-morph-based AST parsing — it does not modify those packages. (If the AST parse helper genuinely needs an `@yakcc/ir` addition, that is a reviewer-flagged scope escalation requiring re-approval — the default expectation is hooks-base/compile already have or can add ts-morph as a direct dep.)
- **No gate wiring into `examples/**`-touching compile paths in Slice 1.** Slice 1 wires the gate into the explicit `yakcc compile` / B10-driver path only. A path that would lint `examples/**` is a later slice and carries the documented carve-out.

### 4.6 Ready-for-Guardian definition (Slice 1)

Slice 1 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/hooks-base build && typecheck && test` all green, **zero regressions** in the existing hooks-base suite.
2. `pnpm --filter @yakcc/compile build && typecheck && test` all green, **zero regressions** in the existing compile suite.
3. `pnpm --filter @yakcc/hooks-claude-code test` green; the reviewer confirms the adapter carries **no** intercept policy (re-export only).
4. The new import-classification unit tests (§4.1) are present and green: `validator` import is an intercept candidate; `node:fs` / bare-core / relative / `@yakcc/*` / type-only imports are correctly skipped; named/default/namespace specifiers are captured; dynamic imports are logged-not-dropped.
5. The new `QueryIntentCard`-construction unit tests are present and green: the binding name is present in `behavior`; the card is structurally valid.
6. The new intercept-decision unit tests are present and green: `matched` → intercept + contract-comment suggestion; `weak_only`/`no_match` → graceful no-op; `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` → bypass.
7. The pre-emit-scan integration test passes against the **real** `executeRegistryQueryWithSubstitution()` entry point: synthetic-covering-atom registry → intercept; empty registry → unchanged passthrough. The reviewer pastes the observed `HookResponseWithSubstitution` for both cases as evidence.
8. The compile-time-gate tests pass: `UnexpandedImportError` thrown for an unexpanded covered import via the **exported** `@yakcc/compile` surface; not thrown for the atom-composed form or for a no-coverage registry; builtins/relative/`@yakcc/*` imports accepted.
9. The disable knob is proven on the real path: `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` skips the import scan (reviewer confirms parity with the no-coverage passthrough).
10. The shared import-classification rule set is confirmed single-sourced (one predicate used by both `import-intercept.ts` and `import-gate.ts`); the intercept threshold is confirmed to reuse `CONFIDENT_THRESHOLD`; no second disable knob, no new registry-query function, no registry schema change exist in the diff.
11. New `@decision` annotations are present at the modification points — `import-intercept.ts`, the `index.ts` wiring branch, and `import-gate.ts` — recording the design choices (additive-branch placement, allowlist-of-one Slice-1 scoping, the compile-gate-as-sibling-module decision, the shared-classifier decision). New DEC IDs recorded — see §8.
12. The reviewer confirms the diff touches **only** Scope-Manifest-allowed paths (§7) and that `examples/**` is not gate-linted by any path Slice 1 wires.

---

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| The pre-emit scan fires too often and degrades conversational UX (every benign import flagged), hurting adoption. | Slice 1 is **allowlist-of-one** (`validator`) — the smallest possible blast radius. The intercept only fires when the registry has a `matched` covering candidate; absent coverage it is a guaranteed no-op (§4.1 test). #508 Slices 2-N add per-package telemetry hit-rate counters so widening is data-driven. |
| ts-morph cannot parse a partial / syntactically-incomplete `Edit` snippet, and the scan throws — breaking the hook. | §4.5 forbidden shortcut + §4.6 criterion 7: a parse failure in the scan degrades to a no-op and returns the original response. Observe-don't-mutate is the §4.3 invariant; the integration test exercises an unparseable-snippet fixture. |
| The compile-time gate retroactively breaks existing `examples/**` that import npm packages. | §2.2 + §4.5: Slice 1 wires the gate **only** into the explicit `yakcc compile` / B10-driver path, not as a global repo lint. `examples/**` is untouched by any Slice-1-wired path; a later slice that needs broader wiring carries an `@decision`-annotated `examples/**` carve-out. §4.6 criterion 12 makes the reviewer confirm this. |
| Dynamic / namespace imports (`import(...)`, `import * as _ from 'lodash'`) let unexpanded dependencies escape the intercept. | Slice 1 explicitly scopes to **static `ImportDeclaration`s**; dynamic/template-literal imports are **logged to telemetry, not silently dropped** (§2.1, §4.1 test). Namespace-import (`import * as`) *capture* is in Slice 1's scan; full namespace-surface decomposition (which behaviors of `_` are actually used) is a #508 Slices 2-N refinement. The known limitation is documented in the `@decision` annotation. |
| Two divergent import classifiers drift (one in `import-intercept.ts`, one in `import-gate.ts`, plus the existing `classifyForeign()`). | §4.3 invariant: **one** rule set shared by both new modules, mirroring `classifyForeign()`. The reviewer may require lifting it to a shared helper if duplication is flagged. §4.6 criterion 10 gates on single-sourcing. |
| The mechanism is built but, because #510's real `validator` forest does not exist yet, it can never be proven to actually intercept a real import — "works in theory." | Slice 1's §4.1 integration test and §4.2 real-path check use **synthetic covering atoms** seeded into a test registry — the mechanism IS proven end-to-end (intercept fires; gate throws) without #510. Slice 2 then swaps the synthetic atom for #510's real forest; that dependency is named explicitly in §3. The mechanism's correctness does not wait on #510. |
| The intercept's `QueryIntentCard` `behavior` text is too terse for the embedder, so `findCandidatesByQuery` under-scores a real covering atom and the intercept misses. | Slice 1 folds **both** the binding name and the surrounding `EmissionContext.intent` into `behavior` (§2.1 step 2). If a real atom under-scores in Slice 2, that surfaces as a discovery-eval signal — investigate the `QueryIntentCard` construction, not the scan plumbing. Slice 1's synthetic atoms are authored to score above `0.70` for their fixture query, isolating the plumbing test from embedder calibration. |
| `@yakcc/hooks-base` does not currently depend on ts-morph; adding a heavy dep to the hook package bloats it / affects hook latency. | hooks-base already lazy-imports `@yakcc/ir` for AST work (`extractBindingShape`). The implementer should follow the **same lazy-import discipline** for the import scan's ts-morph use, keeping it off the hot path when no scan is needed, and the D-HOOK-3 latency budget (`HOOK_LATENCY_BUDGET_MS = 200`) still bounds the total. If a direct ts-morph dep is added to `hooks-base`, it is `@decision`-annotated; the reviewer confirms latency-budget telemetry is unaffected. |

---

## 6. Scope Manifest — Slice 1 (the mechanism)

**Allowed paths (implementer may touch):**
- `packages/hooks-base/src/import-intercept.ts` — **new** — the pre-emit scan, `QueryIntentCard` construction, intercept decision.
- `packages/hooks-base/src/index.ts` — wire the additive `import-intercept` branch into `executeRegistryQueryWithSubstitution()`; export the new module's public surface.
- `packages/hooks-base/src/import-intercept.props.ts`, `packages/hooks-base/test/**` — new and updated tests for the scan.
- `packages/hooks-base/src/telemetry.ts` — **only** an additive, backward-compatible field on the existing telemetry event if an intercept counter is needed; default expectation is the existing schema suffices.
- `packages/hooks-base/package.json` — **only** if a direct `ts-morph` dependency must be declared (default: follow the lazy-import-of-`@yakcc/ir` pattern; declaring ts-morph directly is allowed but `@decision`-annotated).
- `packages/compile/src/import-gate.ts` — **new** — the compile-time gate + `UnexpandedImportError`.
- `packages/compile/src/index.ts` — export `import-gate.ts`'s public surface.
- `packages/compile/src/import-gate.props.ts`, `packages/compile/src/import-gate.test.ts`, `packages/compile/src/import-gate.props.test.ts` — new tests for the gate.
- `packages/hooks-claude-code/src/index.ts` — **re-export only**, if the new hooks-base surface must be visible through the adapter.
- `plans/wi-508-import-intercept-hook.md`, `plans/import-replacement-triad.md` — **status updates only**.

**Required paths (implementer MUST modify):**
- `packages/hooks-base/src/import-intercept.ts` — the new scan module.
- `packages/hooks-base/src/index.ts` — the additive wiring branch.
- `packages/compile/src/import-gate.ts` — the new compile-time gate module.
- `packages/compile/src/index.ts` — the gate's public-surface export.
- At least one test file per touched package proving the §4.1 cases: `packages/hooks-base/test/**` (scan + intercept-decision + integration) and `packages/compile/src/import-gate.test.ts` (gate accept/reject).

**Forbidden touch points (must not change without re-approval):**
- `packages/hooks-base/src/yakcc-resolve.ts` — consumed unchanged (the `yakccResolve` / `CONFIDENT_THRESHOLD` surface). Additive consumption only.
- `packages/hooks-base/src/substitute.ts`, `packages/hooks-base/src/atomize.ts` — consumed unchanged (`renderContractComment`, the atomize branch pattern). No behavior change.
- `packages/compile/src/resolve.ts`, `packages/compile/src/assemble.ts`, `packages/compile/src/assemble-candidate.ts`, `packages/compile/src/slice-plan.ts`, `packages/compile/src/manifest.ts`, `packages/compile/src/ts-backend.ts`, `packages/compile/src/as-backend.ts` — the existing compile pipeline. The gate is a **new sibling**, not a modification of these.
- `packages/registry/**` — `findCandidatesByQuery` and the schema are consumed unchanged. **No `npm_aliases`, no migration, no schema edit.**
- `packages/contracts/**` — `QueryIntentCard` is consumed unchanged.
- `packages/ir/**` — AST helpers consumed; not modified (a genuine need is a reviewer-flagged escalation).
- `packages/shave/**` — `classifyForeign()`'s discipline is **mirrored**, not imported-and-modified; the shave engine is #510's lane.
- `packages/seeds/src/blocks/**` and all existing seed atoms — NOT modified. Slice 1 uses **synthetic** fixture atoms in a test registry.
- `bench/**` — #512's lane.
- `MASTER_PLAN.md` — permanent sections untouched. (A Decision-Log append for the §8 DECs, if the operator wants them in the project-level log, is a separate doc-only change — not part of this source slice.)

**Expected state authorities touched:**
- **Emit-boundary hook policy** — canonical authority: `@yakcc/hooks-base` `index.ts` `executeRegistryQueryWithSubstitution()`. Slice 1 adds the `import-intercept` branch *inside* this authority; it does not fork it and does not duplicate it into the adapter.
- **Compile-time external-import gate** — a NEW authority created by Slice 1 (`packages/compile/src/import-gate.ts`). There is no pre-existing external-npm-import gate to diverge from; the implementer must ensure exactly one exists after this slice.
- **Registry query** — canonical authority: `Registry.findCandidatesByQuery()` via `yakccResolve()`. Slice 1 **consumes** it; it never writes a new query path.
- **Telemetry event log** — canonical authority: `packages/hooks-base/src/telemetry.ts`. Slice 1 emits through it; any field addition is additive and backward-compatible.
- **Import classification** — a rule set whose discipline is owned by `classifyForeign()` in `@yakcc/shave`. Slice 1 mirrors it into a single shared predicate used by both new modules; after this slice there must be exactly one #508-side classifier (not two).

---

## 7. C-Track / Follow-On Issues — to be filed by the orchestrator

#508 Slice 1 ships the **mechanism**. The following follow-on work is tracked; the orchestrator files these as GitHub issues (or as #508 sub-slices in the triad) once Slice 1 lands:

- **#508 Slice 2 — End-to-end validator demo.** Gated on **#510 Slice 2** (the real `validator` forest in the registry). Point the proven mechanism at the real forest; intercept a real `import { isEmail } from 'validator'`; compile-gate refuses the unexpanded import. This is triad phase P2b's true end-to-end exercise and unblocks #512 Slice 2. Not a new GitHub issue — a #508 sub-slice the orchestrator dispatches a planner for once #510 Slice 2 lands.
- **#508 Slices 3-N — Broaden intercept coverage.** Generalize from validator-only (allowlist-of-one) to registry-driven granularity across #510's fixture packages; add per-package telemetry hit-rate counters; add per-binding `QueryIntentCard` refinement and full namespace-import (`import * as _`) surface decomposition. Each paired with the corresponding #510 fixture slice.
- **Dynamic-import intercept (optional, lower priority).** Slice 1 logs-but-does-not-intercept `import(...)` / template-literal imports. A follow-on can extend the scan to statically-analyzable dynamic imports (string-literal specifier). File only if telemetry shows dynamic-import escapes are material.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI508-IMPORT-INTERCEPT-IN-HOOKS-BASE-001` | The import-intercept pre-emit scan lives in `@yakcc/hooks-base` as an additive branch of `executeRegistryQueryWithSubstitution()`, not in the IDE adapter | `@yakcc/hooks-base` is the production hook authority (`DEC-HOOK-BASE-001`); `hooks-claude-code` is an adapter. The intercept is policy, so it belongs in hooks-base. It is wired as an additive, observe-don't-mutate branch exactly like the Phase 3 atomize path (`DEC-HOOK-ATOM-CAPTURE-001`) — any failure in the scan returns the original `HookResponse` unchanged. No parallel intercept mechanism, no policy duplication into the adapter. |
| `DEC-WI508-COMPILE-GATE-SIBLING-MODULE-001` | The compile-time gate is a new pre-assembly sibling module (`packages/compile/src/import-gate.ts`), NOT a modification of `resolveComposition()` | `resolveComposition()` (`resolve.ts`, `DEC-COMPILE-RESOLVE-002`) handles intra-yakcc composition (`import type` sub-block paths) — it is the wrong place for external-npm-import detection. `assemble()` consumes a `BlockMerkleRoot`, not a raw module, so it has no input-module to gate. The gate is a new sibling that runs before composition resolution, invoked explicitly by `yakcc compile` / B10-driver callers via the exported `@yakcc/compile` surface, throwing a typed `UnexpandedImportError`. It is the only external-import gate in `@yakcc/compile` after this slice. |
| `DEC-WI508-INTERCEPT-SCOPE-ALLOWLIST-OF-ONE-001` | #508 Slice 1's intercept is scoped to `validator` via an allowlist-of-one; registry-driven granularity is the #508 Slices 2-N generalization | Smallest possible blast radius for the mechanism slice. The reframed triad doc resolves the granularity question: with #510 producing a real shaved forest, registry-driven granularity ("intercept when the registry has a covering candidate at/above `CONFIDENT_THRESHOLD`") needs no schema extension. Slice 1 starts allowlist-of-one for auditability; Slices 2-N generalize. Allowlist-of-one vs registry-driven-start is implementer/planner-decidable per the reframed triad doc §5. |
| `DEC-WI508-RIDE-EXISTING-DISABLE-KNOB-001` | Import-intercept rides the existing `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` env override; no second disable knob | `DEC-HOOK-PHASE-2-001` established `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` as the per-session hook escape hatch. Import-intercept is part of the same emit-boundary hook surface; a second env var would fragment the disable authority. One knob, one authority (Sacred Practice #12). |
| `DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001` | A single import-classification predicate (type-only / relative / `node:`-or-core builtin / `@yakcc/` workspace exclusions) is shared by `import-intercept.ts` and `import-gate.ts`, mirroring `classifyForeign()` | `classifyForeign()` in `@yakcc/shave` already encodes the "is this a non-builtin external import?" discipline. #508 must not spawn two divergent classifiers. One rule set, AST-based (`getImportDeclarations()`), never regex. |
| `DEC-WI508-MECHANISM-PROVABLE-WITHOUT-510-001` | #508 Slice 1 (the mechanism) is proven with synthetic fixture atoms and does not depend on #510's real forest; only the end-to-end demo (Slice 2) is gated on #510 Slice 2 | The scan, `QueryIntentCard` construction, registry-query wiring, intercept decision, and compile-gate are all exercisable against synthetic covering atoms in a test registry. The mechanism's graceful-no-op-on-no-coverage behavior is itself a Slice-1 test. This decouples #508's critical path from #510's engine timeline — #508 Slice 1 and #510 Slice 1 are parallelizable. |

These are recorded as `@decision` annotation blocks at the modification points. If the operator wants them in the project-level log, they are appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of a source slice.

---

## 9. What This Plan Does NOT Cover (Non-Goals)

- **The dependency-following shave engine (#510).** #510 produces the shaved `validator` forest; #508 intercepts the import and queries the registry for it. Separate WI; #508 Slice 2 consumes #510 Slice 2's output.
- **The B10 bench (#512).** #512 Slice 1 (harness + transitive-reachability resolver) is already merged (`950afdc`); #512 Slice 2 consumes the #508 intercept + #510 forest. Separate WI.
- **Hand-authoring any atoms.** Slice 1 proves the mechanism with synthetic fixture atoms in a test registry. Real atoms are #510's engine output. The existing seed atoms are untouched.
- **`npm_aliases` registry schema field.** The reframe eliminates the hand-naming step that field existed to support — shave produces behavior-named atoms; #508 queries by `QueryIntentCard` semantics.
- **Dynamic / template-literal import interception.** Slice 1 logs-but-does-not-intercept `import(...)`; a §7 follow-on may extend to statically-analyzable dynamic imports.
- **Backporting the intercept to `hooks-cursor` / `hooks-codex`.** Those adapters track behind `hooks-claude-code` per `DEC-HOOK-BASE-001` rollout discipline. Backports are downstream WIs.
- **Replacing `yakcc_resolve` / `QueryIntentCard` / `findCandidatesByQuery`.** #508 consumes the existing discovery surface as-is. Any schema evolution is owned by the discovery initiative.
- **Modifying the registry, contracts, IR, or shave packages.** All consumed; none modified. `classifyForeign()`'s discipline is mirrored, not imported-and-changed.
- **`MASTER_PLAN.md` initiative registration.** A follow-up doc-only slice the orchestrator dispatches once the triad's slices land — consistent with the reframed triad doc §7.

---

## 10. Slice 2 — End-to-end validator demo + self-bootstrapping miss path

**Status:** Slice 2 planning pass (read-only research output, authored 2026-05-15 on `feature/wi-fix-551-twopass-compile-self-reconstruction` via planner stage for `wi-508-s2-validator-demo`). Slice 1 has landed (PR #539 `5f660c4`). #510 Slice 2 has landed (PR #544 `aeec068`) — the engine emits per-entry forests for `isEmail`/`isURL`/`isUUID`/`isAlphanumeric` from a vendored validator fixture, but those atoms were **not** seeded into `bootstrap/yakcc.registry.sqlite`. That gap is the load-bearing fact this slice exploits.

This slice does NOT change `MASTER_PLAN.md` permanent sections and does NOT constitute Guardian readiness for any code-bearing slice.

### 10.1 The two parts (Part A and Part B are one slice)

The operator (issue #508 [comment 4457079594](https://github.com/cneckar/yakcc/issues/508#issuecomment-4457079594), 2026-05-14) reframes Slice 2 as **not a passthrough on miss**. On miss the hook must **self-bootstrap**: shave the imported package, persist the resulting atoms, locally assemble the minimally-viable composition, submit it as a root atom, and use it to satisfy the original import. Async, telemetry-instrumented.

That reframe collapses Part A (end-to-end validator demo, the triad's P2b) and Part B (self-bootstrap miss path) into one coherent slice. Slice 2 ships both:

- **Part A — end-to-end validator demo (triad §P2b).** Hook fires on a real `import { isEmail } from 'validator'` against a real registry containing the four validator headline atoms; intercept returns the matched atom address; compile-gate refuses the unexpanded import.
- **Part B — self-bootstrapping miss path (operator addendum).** First occurrence of a covered miss triggers shave-on-miss against the imported package; the resulting per-entry forest is persisted via `maybePersistNovelGlueAtom`; the entry-rooted atom becomes the minimally-viable composition; subsequent occurrences hit the registry directly.

The link: Part B IS how Part A's registry gets populated for the demo. The vendored validator fixture from PR #544 is already present in the worktree (`packages/shave/src/universalize/__fixtures__/module-graph/validator-13.15.35/`); Slice 2 wires `shavePackage({ entryPath: <fixture>/lib/<binding>.js })` into the miss-path branch and proves the first→second sequence end-to-end.

### 10.2 Why the slice fits one work-item (not two)

The §1 desired end-state of the triad is the value-prop loop demonstrated **once**. The operator's "two wins per miss" framing (corpus growth + reconstruction discovery) makes the loop self-contained: Slice 2 alone shows shave-on-miss bootstrapping the registry and a subsequent hit returning the atom. Splitting Part A and Part B would force one of them to mock the other — Part A would need a synthetic seed step that Part B replaces, or Part B would need a fake demo trigger. The single-slice framing eliminates the synthetic-then-real coupling.

The slice carries one Evaluation Contract and one Scope Manifest covering both parts.

### 10.3 Architecture

#### 10.3.1 Resolved decision boundaries

The contract surfaced four operator-decidable points that proved to be answerable from the operator's own addendum text or from existing-authority precedent. None of them are genuine open decisions for Slice 2.

| Decision | Resolution | Source |
|---|---|---|
| **Composition algorithm.** "Locally assemble minimally-viable composition" needs an algorithm. | **The entry-rooted forest from `shavePackage({ entryPath: <pkg>/lib/<binding>.js })` IS the minimally-viable composition by construction.** A per-entry shave produces a connected forest rooted at the entry; that root is the atom that satisfies the binding-specific intent. No separate assembly algorithm is added in Slice 2. `DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001`. | PR #544's per-entry shave shape (validated by the `cat1-validator-is-{email,url,uuid,alphanumeric}-001` corpus entries). The "minimally-viable composition for the requested binding" the operator describes is literally what shave produces when given the binding's entry-path. |
| **Async semantics — first import vs subsequent.** Does the first request wait or get passthrough? | **First occurrence: passthrough now, shave-in-background. Second occurrence: registry hit.** The operator's addendum text explicitly says: "passthrough-now-and-shave-in-background for the first occurrence, so the *second* occurrence becomes a hit." `DEC-WI508-S2-ASYNC-BACKGROUND-001`. | Operator addendum, issue #508 comment 4457079594. |
| **Where to shave from.** `node_modules` / configurable corpus / fetched-on-demand. | **Configurable corpus dir via `YAKCC_SHAVE_ON_MISS_CORPUS_DIR`; default to `<projectRoot>/node_modules`.** Slice 2's demo uses the vendored fixture path (the validator-13.15.35 tree under `packages/shave/src/universalize/__fixtures__/module-graph/`) by setting the env var in the test; production callers default to `node_modules`. No new authority — env-var-driven path config matches `YAKCC_TELEMETRY_DIR` (`DEC-HOOK-PHASE-1-001`) and `YAKCC_HOOK_DISABLE_SUBSTITUTE` (`DEC-HOOK-PHASE-2-001`). `DEC-WI508-S2-SHAVE-CORPUS-DIR-001`. | Existing env-var-config pattern in `@yakcc/hooks-base`; no new schema, no new authority. |
| **Compile-gate behavior during async window.** Does the gate refuse during the shave-in-background window? | **The gate accepts during the async window.** It only refuses when the registry HAS a covering atom. Operator's "passthrough now, hit second time" semantics REQUIRES the first compile to succeed (otherwise the second compile never happens). The gate's job is "no covered import escapes a build that has coverage available" — when coverage does not yet exist, there is nothing to enforce. Once shave-on-miss has populated the registry, subsequent compiles of the same module will trip the gate, exactly as designed. `DEC-WI508-S2-GATE-ALLOWS-DURING-ASYNC-001`. | Operator addendum's "two wins per miss" + gate's existing semantics — the gate consults the registry; if the registry has no covering atom, the gate accepts. The async window is identical to a no-coverage state from the gate's perspective. |
| **Failure semantics on shave-on-miss error.** What if `shavePackage()` throws? | **Observe-don't-mutate, same discipline as Slice 1 (`DEC-WI508-INTERCEPT-004`).** Any failure in shave-on-miss is caught, logged to telemetry as a `shave-on-miss-error` event, and the hook returns the base passthrough response unchanged. No second authority for failure handling. `DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001`. | Existing `applyImportIntercept()` try/catch envelope in Slice 1's `import-intercept.ts`. |

These resolutions are recorded as `@decision` annotations at the implementation sites. They are not litigated again in the Evaluation Contract.

#### 10.3.2 The shave-on-miss path — sequence

A new module **`packages/hooks-base/src/shave-on-miss.ts`** owns the self-bootstrap path. It is invoked from inside `applyImportIntercept()` in `import-intercept.ts` as the miss branch (replacing the current `return base` on `intercepted=false`). It is **additive** — the existing observe-don't-mutate envelope wraps it, so any failure returns `base` unchanged.

Sequence for one `import { isEmail } from 'validator'` that misses the registry:

1. **Pre-emit scan and registry query unchanged.** Slice 1's flow runs: `scanImportsForIntercept()` extracts the candidate; `runImportIntercept()` calls `yakccResolve()`; result is `status: "no_match"` or `"weak_only"`.
2. **Resolve the package entry-path.** For binding `isEmail` from `validator`:
   - Look up the binding's module path inside the package via Node-style resolution: `<corpusDir>/<package>/lib/<binding>.js` (with `package.json#exports` / `#main` fallback when no `lib/<binding>.js` exists). The lookup is best-effort: if the entry cannot be resolved, log a `shave-on-miss-unresolvable` telemetry event and return `base`.
   - `corpusDir` defaults to `<projectRoot>/node_modules`; overridden by `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` (the test sets this to the vendored fixture path).
3. **Enqueue an in-process background shave.** Slice 2 ships an in-process background queue (single-process, single-worker, idempotent by `(packageName, entryPath)` key) — NOT a worker_thread, NOT a child process. The queue lives in module scope inside `shave-on-miss.ts`. Already-queued or already-shaved keys are skipped (the `(packageName, entryPath)` key is the dedup authority). `DEC-WI508-S2-IN-PROC-BACKGROUND-001`.
4. **Return `base` from the hook immediately.** First-occurrence semantics: passthrough now, shave in background. The hook's response carries an additive `importInterceptResults` entry with `intercepted: false` and a new `shaveOnMissEnqueued: true` field, so callers (and telemetry) can observe that a background shave was queued. `DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001`.
5. **Background work — shave + persist.** When the worker drains the queue entry it calls `shavePackage(<corpusDir>/<package>, { entryPath: <resolved>, registry: <persistRegistry> })`. The returned `ModuleForest` is iterated; each `NovelGlueEntry` in the forest is offered to `maybePersistNovelGlueAtom(entry, registry)` — the EXISTING shave-side persist authority (`packages/shave/src/persist/atom-persist.ts`). No new persist path. `DEC-WI508-S2-PERSIST-VIA-MAYBE-PERSIST-001`.
6. **Telemetry emit on completion.** When the background shave finishes, emit a `shave-on-miss-completed` event (additive `outcome` value) carrying `packageName`, `binding`, `atomsCreated[]` (BMR prefixes), wall-clock duration, and `shaveError` (null on success). The event uses the **existing** `captureTelemetry()` API and **existing** event schema — only the `outcome` enum gains the new values (`"shave-on-miss-enqueued" | "shave-on-miss-completed" | "shave-on-miss-error"`). Additive, backward-compatible. `DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001`.
7. **Second occurrence: hit.** When the same import comes through after the background shave has completed, `findCandidatesByQuery` returns the persisted atom at `combinedScore >= 0.70` and the intercept fires per Slice 1's path. The `import-gate` then refuses the unexpanded import.

#### 10.3.3 Registry surface — what writes vs reads

The shave-on-miss path needs a **writable** registry handle (for `storeBlock` via `maybePersistNovelGlueAtom`). Slice 1's `applyImportIntercept()` already receives a `Registry` instance from `executeRegistryQueryWithSubstitution()`. That instance's `storeBlock` is the canonical authority — Slice 2 uses it, does not duplicate it. The `bootstrap/yakcc.registry.sqlite` file is NOT modified by Slice 2's tests; the tests construct ephemeral test registries under `tmp/wi-508-s2/` and shave into those.

In production, the registry instance is the same one used for queries — `storeBlock`'s idempotent INSERT-OR-IGNORE (`DEC-STORAGE-IDEMPOTENT-001`) means the shave-on-miss writes are safe against concurrent processes. No new locking, no new SQLite tables. `DEC-WI508-S2-REGISTRY-IS-CANONICAL-001`.

#### 10.3.4 State-Authority Map — Slice 2 additions

| State domain | Canonical authority | Slice 2's relationship |
|---|---|---|
| Shave-on-miss background queue | **NEW — `packages/hooks-base/src/shave-on-miss.ts` module-scope queue.** | Slice 2 creates this authority. It is single-process, single-worker, deduped by `(packageName, entryPath)`. No cross-process coordination; concurrent processes will each enqueue independently, but `storeBlock` idempotence makes that safe. |
| Shave engine | `@yakcc/shave` `shavePackage()` (`DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001`) | Slice 2 **consumes** unchanged. No new shave entry point. |
| Atom persistence | `@yakcc/shave` `maybePersistNovelGlueAtom` (`DEC-ATOM-PERSIST-001`) | Slice 2 **consumes** unchanged. The persist authority lives in shave; hook-side does not write to the registry directly. |
| Registry storeBlock | `@yakcc/registry` `Registry.storeBlock` (`DEC-STORAGE-IDEMPOTENT-001`) | Slice 2 **consumes** indirectly via `maybePersistNovelGlueAtom`. No direct call. |
| Telemetry outcome enum | `packages/hooks-base/src/telemetry.ts` `TelemetryEvent.outcome` field | Slice 2 **adds three values** to the union: `"shave-on-miss-enqueued"`, `"shave-on-miss-completed"`, `"shave-on-miss-error"`. Backward-compatible — old consumers see them as unrecognized enum values; new consumers branch on them. |
| Corpus-dir config | `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` env var (NEW) | Slice 2 creates this env-var authority. Matches the existing pattern of `YAKCC_TELEMETRY_DIR` and `YAKCC_HOOK_DISABLE_SUBSTITUTE`. |
| All Slice 1 authorities | Slice 1 (`DEC-WI508-INTERCEPT-001..006`, `DEC-WI508-IMPORT-GATE-001`) | Slice 2 **extends** the miss branch of `applyImportIntercept()`; does not replace the matched branch. The compile-gate is unchanged in behavior — its registry-query semantics already produce the desired async-window-allows behavior. |

### 10.4 Evaluation Contract — Slice 2

This is the exact, executable acceptance target. A reviewer runs every check. "Ready for Guardian" is defined at the end (§10.6).

#### 10.4.1 Required tests

- **`pnpm lint` and `pnpm typecheck`** at the workspace root pass clean — full-workspace, NOT `--filter` scoped (per the operator's standing rule that Eval Contracts must match CI checks). Both must exit 0.
- **`pnpm --filter @yakcc/hooks-base test`** — full suite passes, **zero regressions** in Slice 1's 24 unit + 4 integration tests. The new shave-on-miss branch is additive: when no miss occurs, behavior is byte-identical to Slice 1.
- **`pnpm --filter @yakcc/compile test`** — full suite passes, **zero regressions** in Slice 1's 18 import-gate tests.
- **`pnpm --filter @yakcc/registry test`** — green; no schema or storage changes touch this package.
- **`pnpm --filter @yakcc/shave test`** — green; the shave engine is consumed, not modified.
- **New unit tests — `shave-on-miss.ts` core behavior:**
  - Entry-path resolution for `(pkg='validator', binding='isEmail')` against the fixture corpus returns `<fixture>/validator-13.15.35/lib/isEmail.js`; for unresolvable bindings returns `undefined`.
  - The background queue dedups by `(packageName, entryPath)` — enqueueing the same key twice produces one worker invocation.
  - `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` env override is honored.
  - Failure inside `shavePackage()` is caught and emits a `shave-on-miss-error` telemetry event; the public API does not throw.
  - When `maybePersistNovelGlueAtom` returns `undefined` (registry lacks `storeBlock`), the path degrades gracefully (no throw, telemetry records `atomsCreated: []`).
- **New integration test — end-to-end first→second sequence (the headline test):**
  - Construct an ephemeral test registry under `tmp/wi-508-s2/` with `storeBlock` enabled (the same in-memory + tmp file pattern existing shave/persist tests use).
  - Set `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` to the vendored fixture path.
  - First call: `applyImportIntercept(base, "import { isEmail } from 'validator';", ctx, registry)` returns `base` unchanged (intercept did not fire) and `importInterceptResults` carries `{intercepted: false, shaveOnMissEnqueued: true}`. The reviewer captures the response shape as evidence.
  - Await the background queue's drain promise (Slice 2 exposes a test-only `awaitShaveOnMissDrain()` for deterministic awaiting — production callers do not need to await).
  - Confirm via direct registry query that at least one new `block_merkle_root` exists corresponding to the `isEmail` entry forest. The reviewer captures `atomsCreated[]` from the telemetry event as evidence.
  - Second call (same import, same ctx, same registry): `intercepted: true`, `address` non-null, `score >= 0.70`. The reviewer captures the response.
  - Confirm `assertNoUnexpandedImports()` (the Slice 1 compile-gate) **throws `UnexpandedImportError`** for the same import string after the first→second sequence has completed (the gate's behavior naturally tightens as the registry grows; this proves it).
- **New integration test — async-window passthrough:**
  - First call returns immediately (assert wall-clock < 100 ms — the shave must NOT block emission).
  - Before awaiting drain, `assertNoUnexpandedImports()` for the same import does NOT throw (covers the async-window-allows decision).
- **New integration test — Part A (validator demo, registry pre-populated):**
  - This is the triad's named P2b exercise expressed as an integration test. Seed a fresh test registry with the four validator headline atoms (by running shave-on-miss synchronously up front, or by direct `storeBlock` for the test-only path).
  - For each of the four bindings (`isEmail`, `isURL`, `isUUID`, `isAlphanumeric`): run `applyImportIntercept()` with `import { <binding> } from 'validator';`, assert `intercepted: true`, assert `address` resolves to a registered block, assert `assertNoUnexpandedImports()` throws.
  - Capture all four `(binding, address, score)` triples in the PR description as the headline demo trace.
- **New unit tests — telemetry outcome additions:** the three new `outcome` values round-trip through `captureTelemetry()` and `appendTelemetryEvent()` without throwing; old consumers (reading old JSONL files) are unaffected; new consumers reading new JSONL files can switch on the new values.

#### 10.4.2 Required real-path checks

- **Production sequence end-to-end.** The headline test runs through the **real** `applyImportIntercept()` function (not a test-only shim), with the **real** `shavePackage()` engine (not a mock), with the **real** `maybePersistNovelGlueAtom()` (not a stub), against a SQLite test registry (the real `Registry` class with `storeBlock` enabled, just pointed at a `tmp/wi-508-s2/` database file). The reviewer confirms the production sequence runs end-to-end.
- **Atoms persisted are queryable post-test.** After the headline test completes, a direct `findCandidatesByQuery({behavior: "validator -- isEmail for: <ctx.intent>"})` call against the same registry returns the persisted atom at `combinedScore >= 0.70`. The reviewer captures the candidate's `address` and `score` as evidence.
- **Telemetry trace pasted in PR description.** The reviewer extracts the JSONL telemetry events from `~/.yakcc/telemetry/<session>.jsonl` (or `YAKCC_TELEMETRY_DIR` if set) generated during the headline test and pastes representative events into the PR description — at least one `shave-on-miss-enqueued`, one `shave-on-miss-completed` with non-empty `atomsCreated`, and (for the second-call hit) one `registry-hit` outcome event. This is the telemetry-instrumentation proof Part B requires.
- **Bootstrap registry not mutated.** A `git status` after the test suite runs shows zero changes to `bootstrap/yakcc.registry.sqlite`. The reviewer confirms.
- **No new SQLite tables.** A `sqlite3 tmp/wi-508-s2/test.db ".schema"` after the test shows only the existing `blocks` / `block_occurrences` / `contract_embeddings` / etc. tables — no new tables created by Slice 2.

#### 10.4.3 Required authority invariants

- **One hook implementation.** `shave-on-miss.ts` lives **inside `@yakcc/hooks-base`** and is invoked from the miss branch of `applyImportIntercept()`. The intercept policy stays single-sourced — no parallel "old passthrough + new bootstrap" branch; the miss branch IS replaced (`{intercepted: false}` still returns `base`, but the side-effect of background-enqueue is added).
- **One shave engine.** `shavePackage()` is the single shave entry point. Slice 2 does not introduce a "shave-lite" or "shave-on-miss-specific" engine variant.
- **One atom persistence path.** `maybePersistNovelGlueAtom` is the single authority. Slice 2 does not call `storeBlock` directly.
- **One registry instance.** The same `Registry` handle passed to `applyImportIntercept()` is the one shaved-atoms are persisted to. No parallel "shave-on-miss registry" handle.
- **One telemetry authority.** `captureTelemetry()` / the existing `TelemetryEvent` schema. The three new `outcome` values are additive.
- **One env-var-config pattern.** `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` matches `YAKCC_TELEMETRY_DIR` / `YAKCC_HOOK_DISABLE_SUBSTITUTE` shape. No new config file.
- **No new SQLite schema.** The existing tables hold the shaved atoms via `storeBlock`. No migration, no `SCHEMA_VERSION` bump.
- **Observe-don't-mutate preserved.** Any failure in shave-on-miss (entry-path resolution, shave engine throw, persist failure, queue worker crash) returns `base` unchanged. The hook's primary function is never degraded.
- **First-occurrence latency budget honored.** Slice 1's D-HOOK-3 `HOOK_LATENCY_BUDGET_MS = 200` still bounds the hook's synchronous path. The background shave's wall-clock is NOT counted against this budget because it runs after the response returns. The integration test asserts first-call wall-clock < 100 ms.

#### 10.4.4 Required integration points

- `packages/hooks-base/src/shave-on-miss.ts` — **new module.** The background-queue worker, entry-path resolution, telemetry-event emit, and the miss-branch entry function `applyShaveOnMiss(binding, ctx, registry) → Promise<ShaveOnMissResult>`. Exposes a test-only `awaitShaveOnMissDrain()` for deterministic test sync.
- `packages/hooks-base/src/import-intercept.ts` — wire `applyShaveOnMiss()` into the miss branch of `applyImportIntercept()`. Add the additive `shaveOnMissEnqueued: boolean` field to `ImportInterceptResult`. Slice 1's matched-branch path is unchanged.
- `packages/hooks-base/src/telemetry.ts` — add three new `outcome` enum values (`"shave-on-miss-enqueued" | "shave-on-miss-completed" | "shave-on-miss-error"`). Update the `outcome` field type union. Additive and backward-compatible.
- `packages/hooks-base/src/index.ts` — export `applyShaveOnMiss`, `awaitShaveOnMissDrain` (test surface), `ShaveOnMissResult` type. The `HookResponseWithSubstitution.importInterceptResults` element type gains the additive `shaveOnMissEnqueued` field.
- `packages/hooks-base/package.json` — add `@yakcc/shave` as a `dependencies` entry (the slice imports `shavePackage` and `maybePersistNovelGlueAtom`). Workspace-protocol dependency, no version bump elsewhere.
- `packages/hooks-base/test/shave-on-miss.test.ts` — **new** — unit tests for entry-path resolution, queue dedup, env-var override, failure-handling.
- `packages/hooks-base/test/shave-on-miss-integration.test.ts` — **new** — the headline first→second sequence test, the async-window-passthrough test, the Part A four-binding demo test.
- `packages/compile/src/import-gate.ts` — **consumed unchanged.** The gate's "throws when registry has coverage" semantics naturally produces the "tightens after shave-on-miss" behavior; no code change. (A new test confirming the gate's post-shave behavior is part of the integration test in `packages/hooks-base/test/shave-on-miss-integration.test.ts` — the gate is exported from `@yakcc/compile` and called from the integration test; no test files added under `packages/compile/`.)

#### 10.4.5 Forbidden shortcuts

- **No widening compile-gate to bypass refusal.** The gate is unchanged. Production callers can opt out only via `AssertNoUnexpandedImportsOptions.disabled` (the Slice 1 surface).
- **No mocking `shavePackage()`.** The integration test uses the real shave engine against the vendored validator fixture. A mock would invalidate the "production sequence" proof.
- **No synchronous shave-on-miss that blocks emission.** First-call wall-clock < 100 ms is an integration-test invariant.
- **No new SQLite tables / no schema bump.** The existing `blocks` / `block_occurrences` / `contract_embeddings` tables hold the shaved atoms.
- **No carve-out for the demo case.** The four validator headlines flow through the same code path as any other miss; the demo test is just a parameterized instance of the headline test.
- **No worker_thread / child_process / IPC.** The background queue is in-process module-scope. Cross-process coordination is a later slice (the §10.7 follow-ons).
- **No second env-var-config pattern.** `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` matches the existing shape; an `.env`-file mechanism or a `~/.yakccrc` is out of scope.
- **No second disable knob.** Slice 1's `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` disables the entire import-intercept path including shave-on-miss (which only runs when the matched branch did not fire, which only runs when the disable knob is not set).
- **No edits to `@yakcc/registry`, `@yakcc/contracts`, `@yakcc/ir`, `@yakcc/shave` source.** All consumed unchanged. (`@yakcc/shave` becomes a `@yakcc/hooks-base` dependency, but its source is not modified.)
- **No regeneration of `bootstrap/yakcc.registry.sqlite`.** Read-only fact-check only.
- **No publish path to `metrics.yakcc.com`.** Slice 2 instruments via the **existing** in-process JSONL telemetry; #546 is the separate WI that builds the export pipeline. Slice 2 does NOT pre-empt or duplicate #546's work.

#### 10.4.6 Ready-for-Guardian definition (Slice 2)

Slice 2 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. Workspace-wide `pnpm lint` and `pnpm typecheck` are green (exit 0, no warnings escalated to errors).
2. `pnpm --filter @yakcc/hooks-base test` — all green, zero regressions in Slice 1's 28 tests. New tests added (per §10.4.1) are green.
3. `pnpm --filter @yakcc/compile test` — all green, zero regressions in Slice 1's 18 import-gate tests.
4. `pnpm --filter @yakcc/registry test` and `pnpm --filter @yakcc/shave test` — green.
5. The headline first→second integration test is present and green: first call returns passthrough + enqueues background shave; second call hits the registry; compile-gate throws on the unexpanded import after the shave completes.
6. The async-window passthrough test is present and green: first call wall-clock < 100 ms; gate accepts before drain.
7. The Part A four-binding demo test is present and green: `isEmail`, `isURL`, `isUUID`, `isAlphanumeric` all return `intercepted: true` with non-null `address` and `score >= 0.70`.
8. The PR description contains:
   - A **before** trace: a snippet showing Slice 1 alone (the matched-branch off-path) producing `{atoms:[]}`-equivalent passthrough for a miss.
   - An **after** trace: the headline first→second sequence — observed `HookResponseWithSubstitution` for the first call (with `shaveOnMissEnqueued: true`), the telemetry JSONL extract showing `shave-on-miss-enqueued` → `shave-on-miss-completed` → second-call `registry-hit`, and the response for the second call (with `address` and `score`).
   - The Part A demo trace: the four `(binding, address, score)` triples.
9. Direct registry query (post-test) against the test registry returns the persisted atoms; the reviewer pastes the `findCandidatesByQuery` output as evidence.
10. `git status` shows zero changes to `bootstrap/yakcc.registry.sqlite`.
11. `sqlite3 tmp/wi-508-s2/test.db ".schema"` shows no new tables created by Slice 2.
12. New `@decision` annotations are present at the modification points — `shave-on-miss.ts`, the `import-intercept.ts` miss-branch wiring, the `telemetry.ts` outcome-enum addition. The seven new DEC IDs (`DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001`, `DEC-WI508-S2-ASYNC-BACKGROUND-001`, `DEC-WI508-S2-SHAVE-CORPUS-DIR-001`, `DEC-WI508-S2-GATE-ALLOWS-DURING-ASYNC-001`, `DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001`, `DEC-WI508-S2-IN-PROC-BACKGROUND-001`, `DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001`, `DEC-WI508-S2-PERSIST-VIA-MAYBE-PERSIST-001`, `DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001`, `DEC-WI508-S2-REGISTRY-IS-CANONICAL-001`) are recorded as `@decision` annotations at their respective implementation sites.
13. The reviewer confirms the diff touches only Scope-Manifest-allowed paths (§10.5) and that `bootstrap/yakcc.registry.sqlite`, `MASTER_PLAN.md`, `packages/registry/**`, `packages/shave/**` (source), `packages/contracts/**`, `packages/ir/**`, `examples/**`, `bench/**`, and `.worktrees/**` are untouched.
14. The reviewer notes — but does NOT block on — any CI hits on `packages/shave/src/cache/cache.test.ts` Windows EPERM flakes (issue #525, addressed by PR #557; if any reappear in this slice's CI they are pre-existing infra noise per the operator's standing instruction).

If criterion 12 fails because a DEC ID is missing, the implementer adds the missing annotation and re-pushes; the implementer does NOT renumber the DEC IDs in this plan doc.

### 10.5 Scope Manifest — Slice 2

**Allowed paths (implementer may touch):**
- `packages/hooks-base/src/shave-on-miss.ts` — **new module** (the background queue, entry-path resolver, miss-branch entry function).
- `packages/hooks-base/src/import-intercept.ts` — miss-branch wiring; additive `shaveOnMissEnqueued: boolean` field on `ImportInterceptResult`. Slice 1's matched-branch and observe-don't-mutate envelope are unchanged.
- `packages/hooks-base/src/telemetry.ts` — add three values to the `outcome` enum union. Backward-compatible.
- `packages/hooks-base/src/index.ts` — export `applyShaveOnMiss`, `awaitShaveOnMissDrain`, `ShaveOnMissResult`.
- `packages/hooks-base/test/shave-on-miss.test.ts` — **new** unit tests.
- `packages/hooks-base/test/shave-on-miss-integration.test.ts` — **new** integration tests (headline first→second, async-window passthrough, Part A four-binding demo).
- `packages/hooks-base/package.json` — add `@yakcc/shave` as workspace-protocol dependency.
- `tmp/wi-508-s2/**` — ephemeral test registries and scratch files (gitignored).
- `plans/wi-508-import-intercept-hook.md` — status-only updates appending to §10 if the implementer needs to record an addendum.

**Required paths (implementer MUST modify):**
- `packages/hooks-base/src/shave-on-miss.ts` — the new module exists at end of slice.
- `packages/hooks-base/src/import-intercept.ts` — miss-branch wires into `applyShaveOnMiss`; `ImportInterceptResult` gains `shaveOnMissEnqueued`.
- `packages/hooks-base/src/telemetry.ts` — the three new `outcome` values are added.
- `packages/hooks-base/src/index.ts` — the new exports are present.
- `packages/hooks-base/test/shave-on-miss.test.ts` AND `packages/hooks-base/test/shave-on-miss-integration.test.ts` — both new test files exist with the §10.4.1 test cases.
- `packages/hooks-base/package.json` — `@yakcc/shave` is a workspace dependency.

**Forbidden touch points (must not change without re-approval):**
- `bootstrap/yakcc.registry.sqlite` — **read-only fact-check only.** Never written. Never regenerated.
- `MASTER_PLAN.md` — permanent sections untouched. (A separate doc-only WI may add a Decision Log entry for the new DECs; that is not part of this source slice.)
- All other plan docs except `plans/wi-508-import-intercept-hook.md`.
- `packages/registry/**` — `Registry.storeBlock` and `Registry.findCandidatesByQuery` are consumed unchanged. No schema edit, no new table, no migration, no source change.
- `packages/shave/**` — `shavePackage()` and `maybePersistNovelGlueAtom()` are consumed unchanged. The engine is frozen per #510's plan.
- `packages/contracts/**` — `QueryIntentCard` is consumed unchanged.
- `packages/ir/**` — not used by Slice 2.
- `packages/compile/src/import-gate.ts` and the rest of `packages/compile/src/**` — the gate's behavior is unchanged in Slice 2; the new integration test imports it from `@yakcc/compile` to verify the post-shave throw behavior, but does not modify it. `resolve.ts` / `assemble.ts` / `slice-plan.ts` / etc. are untouched.
- `packages/seeds/**` — Slice 2 does not seed atoms into the production seed corpus. The shave-on-miss writes happen to ephemeral test registries only.
- `packages/registry/test/discovery-benchmark/corpus.json` — not modified by Slice 2 (the four validator headlines were added by PR #544; Slice 2 does not re-touch).
- `examples/**`, `bench/**`, `.worktrees/**` — not touched.

**Expected state authorities touched:**
- **Hook miss-branch policy** — canonical authority: `@yakcc/hooks-base` `applyImportIntercept()` in `import-intercept.ts`. Slice 2 wires the new `applyShaveOnMiss()` into the miss-branch; matched-branch unchanged.
- **Shave-on-miss background queue** — NEW authority created by Slice 2 (`packages/hooks-base/src/shave-on-miss.ts` module scope).
- **Telemetry outcome enum** — canonical authority: `packages/hooks-base/src/telemetry.ts` `TelemetryEvent.outcome` field. Slice 2 adds three values; consumers branch additively.
- **Corpus-dir config** — NEW env-var authority `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` (matches existing pattern; no new config file).
- **Shave engine** — canonical authority: `@yakcc/shave` `shavePackage()`. Slice 2 consumes unchanged.
- **Atom persistence** — canonical authority: `@yakcc/shave` `maybePersistNovelGlueAtom`. Slice 2 consumes unchanged.
- **Registry storeBlock** — canonical authority: `@yakcc/registry` `Registry.storeBlock`. Slice 2 consumes indirectly via `maybePersistNovelGlueAtom`.

The Scope Manifest is materialized as `tmp/wi-508-s2-scope.json` and synced to runtime via `cc-policy workflow scope-sync wi-508-s2-validator-demo --work-item-id wi-508-s2-impl --scope-file tmp/wi-508-s2-scope.json`.

### 10.6 Risks — Slice 2

| Risk | Mitigation |
|------|-----------|
| The background shave never completes in CI (test deadlock or worker stuck). | `awaitShaveOnMissDrain()` is the test-only sync point. The integration test awaits it with a finite timeout (default: 60 s, matching the per-headline budget established by PR #544's per-entry test). On timeout the test fails loudly with the queue state captured for diagnosis. |
| The first-call passthrough triggers the operator's "you broke yakcc's value-prop" sense — it looks like the hook gave up. | The `shaveOnMissEnqueued: true` flag on the response makes the side-effect observable, and the `shave-on-miss-enqueued` telemetry event is emitted synchronously before return. The PR description's before/after trace shows the second call hitting; the "first miss = passthrough" semantics is the operator's explicitly-chosen behavior (DEC-WI508-S2-ASYNC-BACKGROUND-001). |
| Worker dedup race — two concurrent first-calls for the same binding produce two shave invocations. | The `(packageName, entryPath)` dedup key is checked under a synchronous mutex inside the queue. The unit test exercises a fan-out fixture; integration test does not need to (single-call sequencing is the primary path). Cross-process dedup is NOT solved by this slice — `storeBlock` idempotence is the cross-process safety net. |
| The shaved atoms' query `behavior` text does not match the binding's `QueryIntentCard.behavior` text closely enough for `combinedScore >= 0.70`. | The integration test asserts the second-call hit explicitly. If the score falls below 0.70 the test fails; the implementer must reconcile the shave-side behavior-name authoring with the hook-side `buildImportIntentCard()` output. Slice 2 does NOT add a third "intent translation" authority — both sides must agree via the same `QueryIntentCard` schema. If the gap is real and persistent, that is a discovery-eval signal escalated to the discovery initiative. |
| Background shave error spam fills telemetry JSONL files. | The `shave-on-miss-error` event carries the error type but NOT the stack trace (truncated). Per-(packageName, entryPath) retry is NOT attempted in Slice 2 — once a key has been queued and errored, it is removed from the queue and not retried until the process restarts. This bounds error-event frequency per process. |
| `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` mis-resolution silently shaves the wrong tree. | The unit test for entry-path resolution asserts both the success and unresolvable cases against absolute fixture paths. Production users who set this var to a wrong directory will see `shave-on-miss-error` events with `unresolvable-entry-path` — observable, not silent. |
| `pnpm` resolution of `@yakcc/shave` as a new dependency of `@yakcc/hooks-base` introduces a build-order regression on CI. | The dependency is workspace-protocol (`"@yakcc/shave": "workspace:*"`), so pnpm resolves it locally with no version bump. Turborepo's package-graph automatically reorders the build to put `@yakcc/shave` before `@yakcc/hooks-base`. The first CI run after the slice lands will surface any unforeseen graph issue; the workspace-wide `pnpm typecheck` is the canary. |
| Telemetry-outcome enum expansion breaks an external consumer parsing the JSONL. | The TelemetryEvent type's `outcome` field is a string union. Old JSONL files do not carry the new values. New JSONL files may. External consumers that switch on `outcome` need a default branch — this is standard discriminated-union evolution discipline. The expansion is recorded as `DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001`. The downstream telemetry-export WI (#546) explicitly cross-references this slice. |
| Windows EPERM flake on `packages/shave/src/cache/cache.test.ts` reappears in CI. | Pre-existing issue #525, addressed by PR #557. Per the operator's standing instruction (memory `feedback_actionable_vs_blocked_parallelism.md` and the contract's standing-constraints), this slice does NOT attempt to fix it; if it appears in this slice's CI the reviewer notes it but does not block on it. |

### 10.7 Follow-ons after Slice 2

Slice 2 ships the self-bootstrap mechanism for the static-import case against per-entry-resolvable bindings. The following follow-ons are tracked; the orchestrator files these as GitHub issues (or as #508 sub-slices) once Slice 2 lands:

- **#508 Slice 3 — telemetry-driven shave-skip tuning.** Operator framing in the addendum: "skip shaving sub-modules that already have tightly-fitting intents in the registry; fine-tune once Slice 2 measures the overhead." Slice 3 reads Slice 2's emitted telemetry and tunes the in-shave skip predicate.
- **Cross-process dedup of the background queue.** Slice 2 is single-process. Production deployment with multiple Claude Code sessions running in parallel will produce duplicate shaves (safe because `storeBlock` is idempotent, but wasteful). A SQLite-backed work-queue would dedup cross-process; defer until measured to be worth it.
- **Namespace-import surface decomposition.** Slice 2 covers named imports (`import { isEmail } from 'validator'`). `import * as v from 'validator'` is a known Slice 1 limitation (captured in the scan but not converted into bindings). A follow-on extends the shave-on-miss path to namespace imports by detecting which member-access expressions on `v.*` are statically resolvable.
- **Dynamic-import (`import("...")`) intercept.** Slice 1 logs-but-does-not-intercept; Slice 2 inherits this limitation. A follow-on extends to statically-analyzable dynamic imports.
- **Validator atoms in production seed corpus.** PR #544 shaved the four headline bindings but did NOT register them in `bootstrap/yakcc.registry.sqlite`. After Slice 2 proves shave-on-miss, a separate doc/seeds WI may promote the four headlines into the production seed corpus so a first-cold-start Claude Code session hits immediately without needing the background shave. This is a corpus-shape decision the operator may want to make explicitly; it is out of scope for Slice 2.
- **#546 telemetry export sink.** The export pipeline for these events lives in #546 — separate WI, no Slice 2 work.

### 10.8 Decision Log Entries — Slice 2 (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001` | The entry-rooted forest from `shavePackage({entryPath:<pkg>/lib/<binding>.js})` IS the minimally-viable composition | No separate "local-assembly algorithm" is added. A per-entry shave produces a connected forest whose root atom satisfies the binding-specific intent by construction. The operator's "minimally-viable composition for the requested binding" is literally what the existing per-entry shave produces. |
| `DEC-WI508-S2-ASYNC-BACKGROUND-001` | First-occurrence semantics: passthrough now, shave-in-background; second occurrence: registry hit | Operator addendum (issue #508 comment 4457079594) explicitly chose this semantics. Synchronous shave would block emission and violate the D-HOOK-3 200ms latency budget. |
| `DEC-WI508-S2-SHAVE-CORPUS-DIR-001` | `YAKCC_SHAVE_ON_MISS_CORPUS_DIR` env var configures the shave corpus path; default `<projectRoot>/node_modules` | Matches the existing `YAKCC_TELEMETRY_DIR` / `YAKCC_HOOK_DISABLE_SUBSTITUTE` env-var pattern. No new config-file authority. The test sets it to the vendored fixture path to avoid depending on `node_modules`. |
| `DEC-WI508-S2-GATE-ALLOWS-DURING-ASYNC-001` | The compile-time import gate accepts during the shave-in-background async window; it tightens naturally as the registry grows | The gate's existing semantics (refuse iff registry has covering atom) make this automatic. The async window from the gate's perspective is identical to a no-coverage state. Refusing during the window would permanently block the first occurrence and break the operator's "two wins per miss" semantics. |
| `DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001` | Shave-on-miss failures are observe-don't-mutate: caught, logged to telemetry, hook returns `base` unchanged | Same discipline as Slice 1's `DEC-WI508-INTERCEPT-004`. One failure-handling authority for the import-intercept surface. |
| `DEC-WI508-S2-IN-PROC-BACKGROUND-001` | The shave-on-miss background queue is in-process module-scope (single-process, single-worker, dedup by `(packageName, entryPath)`); cross-process coordination is deferred | Simplest path that satisfies the async requirement. `storeBlock` idempotence makes cross-process safe (wasteful but correct). Cross-process dedup is a §10.7 follow-on. |
| `DEC-WI508-S2-RESPONSE-ENRICH-ADDITIVE-001` | The `ImportInterceptResult` shape gains an additive `shaveOnMissEnqueued: boolean` field | Makes the side-effect observable on the response without changing existing field shapes. Slice 1 consumers see `shaveOnMissEnqueued: false` (or undefined-then-narrowed); Slice 2 consumers branch on it. |
| `DEC-WI508-S2-PERSIST-VIA-MAYBE-PERSIST-001` | Shaved atoms persist via the existing `maybePersistNovelGlueAtom` (`packages/shave/src/persist/atom-persist.ts`); the hook does NOT call `storeBlock` directly | Single persistence authority. The shave-side persist module is the canonical entry point per `DEC-ATOM-PERSIST-001`; the hook consumes it. No parallel "hook-side storeBlock" path. |
| `DEC-WI508-S2-TELEMETRY-OUTCOME-ADDITIVE-001` | The `TelemetryEvent.outcome` union gains three values: `"shave-on-miss-enqueued"`, `"shave-on-miss-completed"`, `"shave-on-miss-error"` | Backward-compatible additive expansion. Old JSONL consumers see new values as unrecognized; new consumers branch on them. Downstream telemetry-export WI #546 cross-references this slice for the new event shapes. |
| `DEC-WI508-S2-REGISTRY-IS-CANONICAL-001` | The Registry instance passed into `applyImportIntercept()` is the single canonical registry for both the query path and the shave-on-miss write path | No parallel "shave-on-miss registry" handle. The same SQLite database is queried for the matched-branch decision and written for the bootstrapped atoms. |

---

*End of Slice 2 plan section.*

---

*End of plan.*
