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
| `DEC-WI508-SHARED-IMPORT-CLASSIFIER-001` | A single import-classification predicate (type-only / relative / `node:`-or-core builtin / `@yakcc/` workspace exclusions) is shared by `import-intercept.ts` and `import-gate.ts`, mirroring `classifyForeign()` | `classifyForeign()` in `@yakcc/shave` already encodes the "is this a non-builtin external import?" discipline. #508 must not spawn two divergent classifiers. One rule set, AST-based (`getImportDeclarations()`), never regex. |
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

*End of plan.*
