# Import-Replacement Triad — Coordinated Plan

**Status:** Planning pass (read-only research output).
**Scope:** Coordinates implementation of [#508](https://github.com/cneckar/yakcc/issues/508) (import-intercept hook), [#510](https://github.com/cneckar/yakcc/issues/510) (shadow-npm corpus expansion), and [#512](https://github.com/cneckar/yakcc/issues/512) (B10 import-heavy bench).
**Branch:** `feature/plan-import-replacement-triad`
**Worktree:** `/Users/cris/src/yakcc/.worktrees/feature-plan-import-replacement-triad`
**Authored:** 2026-05-13 (planner stage, workflow `plan-import-replacement-triad`)

This document is a planning artifact. It does not change `MASTER_PLAN.md`, does not modify any TypeScript source, and does not constitute Guardian readiness for any code-bearing slice. Downstream slices implement against the contracts named here.

---

## 1. Desired End State

**Demonstrable artifact:** A B10 bench run committed under `bench/B10-import-replacement/results-<host>-<date>.json` that contains **at least one task** for which:

1. **Arm B** (LLM baseline) emits `import { isEmail } from 'validator'` (or equivalent for the chosen demo library), and the B10 transitive-reachable-surface measurer reports `arm_b.reachable_functions >= 50` and `arm_b.reachable_bytes >= 50_000` traced through `node_modules/validator/**`.
2. **Arm A** (yakcc atom composition, with the import-intercept hook of [#508](https://github.com/cneckar/yakcc/issues/508) active) emits **zero** non-builtin imports for the same task, with `arm_a.reachable_functions <= 0.10 * arm_b.reachable_functions` and `arm_a.reachable_bytes <= 0.10 * arm_b.reachable_bytes`.
3. **The same correctness oracle passes for both arms** on >=20 in-shape fast-check inputs (this is the B9 Axis-3 discipline re-used; see `bench/B9-min-surface/harness/measure-axis3.mjs`).
4. The atoms used by Arm A are content-addressed in the registry and were resolved through `yakcc_resolve(...)` calls triggered by the hook intercept — not hand-stitched into the emitter — i.e. the demo is an end-to-end exercise of the production path documented in `docs/adr/hook-layer-architecture.md` and `docs/adr/discovery-llm-interaction.md`.

This single demo task is the **minimum viable proof** of the value-prop loop. Everything else in the triad (broader corpus, broader intercept rules, larger B10 task set) is "broaden coverage" once the loop is closed.

---

## 2. Dependency Graph

Edges are slice-level dependencies. `*` marks a slice on the **Minimum Viable End-to-End Demo Path (MVDP)**.

```
                 ┌────────────────────────────────────┐
                 │ P0: Foundation decisions (no code) │
                 │  - DEC-IRT-ATOM-NAMING-001         │
                 │  - DEC-IRT-INTERCEPT-GRANULARITY-1 │
                 │  - DEC-IRT-B10-METRIC-001          │
                 └────────────────┬───────────────────┘
                                  │
                                  ▼
            ┌──────────────────────────────────────────────┐
            │ P1: B10 measurement harness (no corpus yet)* │  → #512 slice 1
            │  - Transitive-reachable-surface measurer     │
            │  - Reuses B9 corpus to validate harness      │
            └────────────────┬─────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────────┐
   │ P2: One-library, one-task, one-rule end-to-end demo (MVDP)     │
   │                                                                │
   │   P2a: Seed atoms for chosen demo library*    → #510 slice 1   │
   │   P2b: Hook intercept rule for chosen pkg*    → #508 slice 1   │
   │   P2c: B10 demo task + run + result commit*   → #512 slice 2   │
   │                                                                │
   │   P2a and P2b are parallelizable. P2c is gated on both.        │
   └────────────────┬─────────────────┬─────────────────────────────┘
                    │                 │
                    ▼                 ▼
        ┌────────────────────┐  ┌─────────────────────────┐
        │ P3: Broaden corpus │  │ P4: Broaden intercept   │
        │  → #510 slices 2-N │  │  → #508 slices 2-N      │
        │  (parallelizable)  │  │  (parallelizable)       │
        └──────────┬─────────┘  └────────────┬────────────┘
                   │                         │
                   └────────────┬────────────┘
                                ▼
                  ┌────────────────────────────────┐
                  │ P5: Broaden bench → #512 final │
                  │  - 12-20 task corpus           │
                  │  - Folds in B9 deferred Axis 4 │
                  │    (npm-audit CVE replay)      │
                  └────────────────────────────────┘
```

**Minimum Viable End-to-End Demo Path (MVDP):** `P0 → P1 → P2a + P2b (parallel) → P2c`. At MVDP completion, the triad's value-prop is demonstrated for one library / one task / one rule. P3, P4, P5 are independent broadening tracks gated only on MVDP landing.

**Parallelism summary:** Within P2, slices P2a (#510) and P2b (#508) can be implemented concurrently by separate implementers; both produce inputs P2c consumes. After P2 lands, P3 and P4 run in parallel against an unchanged measurement harness; P5 follows once P3/P4 produce enough atoms+rules to populate the 12-20 task corpus.

---

## 3. Phase Plan

Per-phase format: **Owner WI / Inputs / Outputs / Evaluation Contract / Scope Manifest Hint / Complexity**.

> The Scope Manifest hint here is a *suggestion* for the downstream planner that owns each slice. The triad-level planner (this document) does not set per-slice scope rows in runtime; those are written by each slice's own planner pass via `cc-policy workflow scope-sync`.

### P0 — Foundation Decisions (no code)

**Owner WI:** All three (#508, #510, #512) — but written here as one decision-only slice the triad shares.

**Inputs:**
- Read of #508, #510, #512 issue bodies in full.
- Existing `docs/adr/hook-layer-architecture.md` (atom-first hook architecture).
- Existing `docs/adr/discovery-llm-interaction.md` (`yakcc_resolve` tool surface and `QueryIntentCard` shape).
- Existing `bench/B9-min-surface/corpus-spec.json` (task-corpus shape we'll mirror).

**Outputs (three DECs landed via a docs-only slice):**

1. **`DEC-IRT-ATOM-NAMING-001`** — Shadow-npm atom naming convention. Three options to adjudicate (see §5 — operator decision):
   - **Option A (per-binding):** one atom per imported named binding (`validator::isEmail`, `validator::isURL`). Pro: matches `yakcc_resolve` query shape directly. Con: explodes for packages like `lodash` where each binding is itself a tree of sub-behaviors.
   - **Option B (per-behavior):** one atom per *behavior*, named by what it does, not by the npm path (`validate-rfc5321-email`, not `validator::isEmail`). Pro: aligns with yakcc's content-addressed worldview — the atom is the behavior, not the npm endpoint. Con: requires a mapping table from npm-binding to behavior-name maintained by the intercept hook.
   - **Option C (hybrid):** atom name = behavior; an `npm_aliases` field on the triplet lists the `(package, binding)` pairs it covers. Pro: single atom can satisfy multiple npm-shaped queries; mapping is data in the registry, not code in the hook. Con: requires schema extension to the `blocks` table.

   **Recommended:** **Option C**. Justification: the entire substrate is built on content-addressed *behavior* (see `MASTER_PLAN.md` Identity §"Code is Truth"), so atoms should be named by behavior; the alias table is the cheapest reconciliation surface for the LLM-facing import shape and avoids encoding npm topology into the hook logic. This recommendation is non-binding until operator confirms in §5.

2. **`DEC-IRT-INTERCEPT-GRANULARITY-001`** — Intercept granularity policy. The hook of #508 cannot fire on every import or it will break conversational flow ([#508](https://github.com/cneckar/yakcc/issues/508) explicitly names "compile-time gate refuses unexpanded imports when atom-lookup returned >=1 candidate"). The decision is: *what's the gate condition?*

   - **Option A (always intercept):** every non-builtin import triggers a `yakcc_resolve` query; refuse if the query returns any candidate with `combinedScore >= 0.7`. Pro: maximally aggressive. Con: false positives degrade UX.
   - **Option B (allowlist):** only intercept imports from a configured list of packages (initially the #510 target set). Pro: predictable, low false-positive rate. Con: brittle — adding a package requires both a corpus atom and a config change.
   - **Option C (registry-driven):** the registry itself answers "is there an atom that covers `import { X } from Y`?" via the `npm_aliases` field landed in `DEC-IRT-ATOM-NAMING-001` Option C; the hook intercepts whenever the registry says yes. Pro: zero config; the registry is the authority. Con: requires `DEC-IRT-ATOM-NAMING-001 == C`.

   **Recommended:** **Option C, conditional on Option C of the naming DEC.** The two decisions are coupled: choose `(C, C)` together to keep the hook stateless and the registry the single source of truth. If the operator picks naming Option A or B in §5, intercept granularity defaults to Option B (allowlist) with a follow-up to upgrade once the schema supports aliases.

3. **`DEC-IRT-B10-METRIC-001`** — Transitive-reachable-surface measurement methodology. This is the load-bearing axis difference vs B9 (which deliberately skipped node_modules traversal — see `bench/B9-min-surface/README.md` Axis 1 footnote). Decisions to land:

   - **Resolver:** `ts-morph` Project with `compilerOptions.moduleResolution = "node"`, plus a recursive `import` walker that follows every static `ImportDeclaration` into the resolved `node_modules` source file. Dynamic imports (`import()` with a string template) flagged as "non-static" and counted separately. Justification: B9 Axis 1 already uses ts-morph (`bench/B9-min-surface/harness/measure-axis1.mjs`); extending its walker keeps tooling cost flat.
   - **Cutoff:** depth-unbounded, prod-deps only (`package.json#dependencies`, excluding `devDependencies` and `optionalDependencies`). Peer-deps included when resolvable. This matches a production-emitted bundle's effective surface.
   - **Counts:** (a) reachable functions (FunctionDeclaration + FunctionExpression + ArrowFunction + MethodDeclaration nodes ts-morph encounters in the closure of import-traversed source files), (b) reachable bytes (sum of source-file byte sizes — pre-minification, post-source-map-strip), (c) unique source files.
   - **Folds in B9 Axis 4 deferral:** the measurement script also runs `npm audit --json` against the synthesized package.json of Arm B's transitive set; counts CVE pattern matches as a secondary metric.

   **Recommended:** Land this DEC as one atomic doc + harness contract; no operator decision needed (technical methodology, not product direction). Codified in `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` per P1.

**Evaluation contract:**
- Required evidence: a single PR that lands three ADR entries under `docs/adr/import-replacement-triad/` (one per DEC) **or** three `@decision` comments anchored to canonical surfaces (preferred — code is truth; the DEC lives next to its consumer).
- Required real-path checks: none (decisions, no runtime).
- Required authority invariants: the three DECs do not contradict any prior DEC in `MASTER_PLAN.md` or `docs/adr/`. Specifically must not conflict with `DEC-HOOK-CLAUDE-CODE-PROD-001`, `DEC-HOOK-BASE-001`, or `DEC-HOOK-PHASE-3-L3-MCP-001`.
- Forbidden shortcut: do not begin P1/P2 implementation while these DECs are still ambiguous. Foundation must land first.
- Ready-for-guardian when: ADR/DEC files reviewed; no operator-decision item from §5 is unresolved.

**Scope manifest hint:**
- Allowed: `docs/adr/import-replacement-triad/**`, `MASTER_PLAN.md` (the slice's own planner-pass; *not* this triad-plan pass).
- Required: at least one of the above three DEC anchors created.
- Forbidden: `packages/**`, `bench/**`.

**Complexity:** **S** (decision document; small write surface).

---

### P1 — B10 Measurement Harness (no corpus yet)

**Owner WI:** #512 (slice 1 of B10).

**Inputs:**
- `DEC-IRT-B10-METRIC-001` landed from P0.
- Existing B9 harness modules: `bench/B9-min-surface/harness/{measure-axis1.mjs,measure-axis3.mjs,run.mjs}` as reference patterns.
- Existing B9 corpus (`bench/B9-min-surface/tasks/*`) to validate the measurer produces plausible numbers (expected near-zero on Arm A — atoms only — and small but non-zero on Arm B — `JSON.parse` etc. resolves to TS-lib types only, no node_modules surface).

**Outputs:**
- `bench/B10-import-replacement/` directory skeleton, mirroring B9's layout: `README.md`, `corpus-spec.json` (empty `tasks` array initially), `harness/measure-transitive-surface.mjs`, `harness/run.mjs`, `package.json` declaring `ts-morph` + `@anthropic-ai/sdk` workspace deps.
- A validation run against B9's `parse-int-list` task that reports Arm A reachable-fn = N, Arm B reachable-fn = M, with both numbers small but non-zero, recorded as a B10-harness-smoke-test fixture (not committed as a "real" B10 result — committed only as `bench/B10-import-replacement/test/smoke-fixture-<sha>.json`).
- `bench:import-replacement` script added to root `package.json` (mirrors B9's `bench:min-surface`).

**Evaluation contract:**
- Required tests:
  - `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs` — covers (i) static import traversal, (ii) depth-unbounded prod-deps cutoff, (iii) dynamic-import flagging, (iv) function/byte/file counting on a synthetic fixture with known surface.
  - Smoke test that runs the harness against B9's `parse-int-list` Arm B fixture (`bench/B9-min-surface/fixtures/parse-int-list/arm-b-response.json`) and produces a numerically-bounded result (no NaN, no Infinity, non-negative counts).
- Required real-path checks: `pnpm bench:import-replacement --dry-run` exits 0, prints a tabular summary, writes a smoke fixture under `test/`.
- Required authority invariants: harness must not call the production registry. It is a measurement tool, not a code path. Arm A inputs are read from emitted module files; Arm B inputs are read from fixture JSON or live API per the same dry-run/live split B9 uses.
- Required integration points: `bench:import-replacement` script in root `package.json` follows the existing `bench:*` naming pattern (`bench:min-surface`, `bench:airgap`, etc.).
- Forbidden shortcut: do not seed a B10 task corpus in this phase. The harness must work against B9 inputs first to validate the measurer; coupling harness landing to a new task corpus invites silent harness bugs masked as low-coverage tasks.
- Ready-for-guardian when: tests pass; smoke fixture committed; root script wired; README documents the metric methodology citing `DEC-IRT-B10-METRIC-001`.

**Scope manifest hint:**
- Allowed: `bench/B10-import-replacement/**`, root `package.json`.
- Required: `bench/B10-import-replacement/harness/measure-transitive-surface.mjs`, `bench/B10-import-replacement/test/measure-transitive-surface.test.mjs`, root `package.json` (one line added).
- Forbidden: `packages/**` (no production-code changes; harness is bench-local), `bench/B9-min-surface/**` (do not regress B9).

**Complexity:** **M** (one new measurement axis, ts-morph traversal recursion is non-trivial, npm-audit fold-in is bounded).

---

### P2 — One-Library, One-Task, One-Rule End-to-End Demo (MVDP)

**Owner WI:** all three.
**Recommended demo library:** `validator` (specifically `validator.isEmail`).
**Recommended demo task:** `validate-rfc5321-email`.

Rationale for the choice: `validator.isEmail` is the smallest, most-self-contained binding of any package in #510's target set, has a well-defined RFC backing the correctness oracle (RFC 5321/5322), is the first example in #512's task corpus, and validator's `node_modules` surface is large enough to produce a headline-grade reachable-fn delta (>500 fns in real measurements of validator + its `node_modules` closure, vs. an atom composition of ~5 atoms).

This phase ships **three parallel slices** (P2a + P2b) feeding **one terminal slice** (P2c).

#### P2a — Seed shadow-npm atoms for the demo library (#510 slice 1)

**Inputs:**
- `DEC-IRT-ATOM-NAMING-001` (chosen option from §5).
- Existing seed-atom packaging pattern in `packages/seeds/src/blocks/` (e.g. `comma`, `digit`, `whitespace`).
- RFC 5321/5322 reference for the email-validation oracle.

**Outputs:**
- Seed atoms covering the behavioral surface of `validator.isEmail`:
  - `parse-local-part` (atom)
  - `parse-domain` (atom)
  - `validate-length-rules` (atom)
  - `validate-rfc5321-email` (atom — composition entry point)
- Each atom has the standard triplet: spec.yak (contract), impl (TS), property tests. Each is content-addressed and registered through the existing `yakcc shave` or seed-bootstrap path.
- If `DEC-IRT-ATOM-NAMING-001 == C`, the triplets carry an `npm_aliases: [{ package: "validator", binding: "isEmail" }]` field; the registry schema accepts the field per the DEC's schema-extension clause.

**Evaluation contract:**
- Required tests: each atom has fast-check property tests covering its claimed behavioral surface; the composition `validate-rfc5321-email` passes >=20 fast-check-derived valid RFC-5321 emails byte-equivalently to a reference implementation (test fixture committed under `packages/seeds/test/fixtures/validate-rfc5321-email/`).
- Required real-path checks:
  - `pnpm -r build` succeeds.
  - `pnpm test -- --filter @yakcc/seeds` green.
  - `yakcc_resolve` (called with a `QueryIntentCard` that names "validate email per RFC 5321") returns the new atom set with `combinedScore >= 0.7` against the bge-small-en-v1.5 embedder — the #510 acceptance condition, scoped to the demo binding.
- Required authority invariants: atoms ride the existing block-triplet path. No new state authority. No parallel ingestion mechanism. If the `npm_aliases` schema extension lands, it lands as a registry schema migration in the same slice, not as a separate registry-side feature flag.
- Required integration points: `packages/seeds/src/blocks/` for the atom files; `packages/registry/src/schema.ts` for the `npm_aliases` column if Option C.
- Forbidden shortcut: do not stub the atoms — they must pass real property tests; do not omit the `parse-domain` or length-rules atoms even though `validate-rfc5321-email` could be coded as one block, because the headline number depends on Arm A having a small **decomposed** surface, not a fused monolith.
- Ready-for-guardian when: atom triplets land, registry registers them, `yakcc_resolve` returns them above threshold for the canonical RFC-5321 query.

**Scope manifest hint:**
- Allowed: `packages/seeds/src/blocks/**`, `packages/seeds/test/**`, optionally `packages/registry/src/schema.ts` (if Option C lands schema extension here).
- Required: at least four new atom triplet files (or however many the chosen naming DEC requires).
- Forbidden: `packages/hooks-*/**`, `bench/**`, `MASTER_PLAN.md`.

**Complexity:** **M** (four small atoms + property tests; RFC-5321 oracle is bounded but careful work).

#### P2b — Hook intercept rule for the demo package (#508 slice 1)

**Inputs:**
- `DEC-IRT-INTERCEPT-GRANULARITY-001` (chosen option from §5).
- Existing hook surface at `packages/hooks-claude-code/src/index.ts` and `packages/hooks-base/src/index.ts`.
- Existing tool-call surface `yakcc_resolve` per `DEC-HOOK-PHASE-3-L3-MCP-001`.

**Outputs:**
- A new tool-call-layer interception in `@yakcc/hooks-base` (per D-HOOK-2) that fires on `Edit`/`Write`/`MultiEdit` calls and scans the `new_string` for `import` statements before the write commits to disk (AST-level scan via ts-morph; the existing emit-intent path already exposes the candidate emission, see `executeRegistryQueryWithSubstitution`).
- For each non-builtin `ImportDeclaration`, the pass:
  1. Builds a `QueryIntentCard` (per `docs/adr/discovery-llm-interaction.md`) describing the behavioral surface — the imported binding name(s) plus a short prose intent string.
  2. Calls `yakcc_resolve` (or its embedded-library equivalent, `Registry.findCandidatesByQuery`).
  3. If the result includes a candidate above the intercept threshold (defined by the chosen granularity DEC — registry-driven means "any candidate"; allowlist-driven means "any candidate for an allowlisted package"), refuses the import emission and surfaces the atom-composition suggestion as an inline contract comment per `D-HOOK-4`.
- The pass is **scoped to `validator` for slice 1.** If `DEC-IRT-INTERCEPT-GRANULARITY-001 == C`, this scoping is data in the registry (`npm_aliases` is empty for non-`validator` packages until P3 broadens corpus). If Option B, the scoping is an allowlist with one entry: `"validator"`.
- The hook surfaces a compile-time gate: `@yakcc/compile` rejects modules that contain unexpanded imports whose `yakcc_resolve` query would have returned a hit (the "tool-use rule" of #508). This is the load-bearing enforcement — without it the LLM can ignore the hook's suggestion.

**Evaluation contract:**
- Required tests:
  - Unit test: pre-emit scan correctly identifies non-builtin imports vs builtin (`node:fs`, relative paths, etc.) and ignores type-only imports.
  - Unit test: `QueryIntentCard` is built with the binding name in the right field per `discovery-llm-interaction.md` §Q1.
  - Integration test: a fixture LLM response containing `import { isEmail } from 'validator'` produces an intercept result; a fixture response containing `import { readFile } from 'node:fs'` does not.
  - Integration test: compile-time gate rejects a module with an unexpanded `validator` import when atoms exist; accepts the same module when the import has been replaced by the atom composition.
- Required real-path checks:
  - `pnpm test -- --filter @yakcc/hooks-base --filter @yakcc/hooks-claude-code --filter @yakcc/compile` green.
  - A scripted end-to-end fixture: feed the hook a synthetic emission intent for `validate-rfc5321-email`, observe a `QueryIntentCard` → `yakcc_resolve` → atom-composition suggestion flow.
- Required authority invariants:
  - The new tool-call-layer interception lives inside `@yakcc/hooks-base` (the production hook authority — `DEC-HOOK-BASE-001`). Hooks-claude-code remains an adapter; intercept logic is not duplicated there. **No parallel intercept mechanism.**
  - The compile-time gate is a **new pre-assembly scanning step** in the `@yakcc/compile` pipeline that runs over the input module's TS AST (via ts-morph) and flags any `import` declaration whose specifier is not in the yakcc-internal allow-list (`@yakcc/seeds/blocks/*`, relative paths, and explicitly-allowed builtins). It is NOT a modification of `resolveComposition()` in `packages/compile/src/resolve.ts` — that resolver handles intra-yakcc composition, not external npm imports, and is not the right place for npm-import detection. The new scan runs before composition resolution and can be co-located with the existing pre-resolution validation (or as a sibling module in `packages/compile/src/`). Implementer is free to pick between a sibling module or a pre-step within an existing pre-resolution validator; this is code organization, not an architectural choice.
  - `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` env override (already present per `DEC-HOOK-PHASE-2-001`) also disables import-intercept; do not introduce a second disable knob.
- Required integration points: `packages/hooks-base/src/index.ts`, `packages/hooks-claude-code/src/index.ts` (re-export only), a new pre-assembly scanning module in `packages/compile/src/` (compile-time gate — not `resolve.ts`, which only handles intra-yakcc composition).
- Forbidden shortcut: do not implement the intercept as a regex over the emit string. It must use the existing AST emit path. Regex-on-text intercepts silently fail on quoted-import-string edge cases and create a maintenance hazard.
- Ready-for-guardian when: intercept fires for `validator` end-to-end against a fixture and a live test path; compile-time gate refuses unexpanded imports when atoms exist; all relevant package tests green; new `@decision` annotations land at the modification points naming `DEC-IRT-INTERCEPT-GRANULARITY-001`.

**Scope manifest hint:**
- Allowed: `packages/hooks-base/src/**`, `packages/hooks-claude-code/src/**`, `packages/compile/src/**`, `packages/hooks-base/test/**`, `packages/hooks-claude-code/test/**`, `packages/compile/test/**`.
- Required: at least one new module under `packages/hooks-base/src/` for the pre-emit scan (e.g. `import-intercept.ts`); at least one test file per touched package.
- Forbidden: `bench/**`, `packages/seeds/**` (those are P2a's lane).

**Complexity:** **L** (AST scan, registry query wiring, compile-time gate, three packages touched).

#### P2c — B10 demo task + run + result commit (#512 slice 2)

**Inputs:**
- P1 landed (B10 harness exists).
- P2a landed (atoms for `validate-rfc5321-email` exist in the registry).
- P2b landed (hook intercepts `validator` imports and the compile gate enforces).

**Outputs:**
- A new B10 task at `bench/B10-import-replacement/tasks/validate-rfc5321-email/` with spec.yak, prompt template, Arm B prompt fixture, fast-check oracle (>=20 valid inputs).
- Entry in `bench/B10-import-replacement/corpus-spec.json` for the new task with sha256 fingerprints (mirroring B9's discipline; see `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001`).
- `arm-a-emit.mjs` produces an emission for the task via `yakcc compile` driven by the hook + atoms.
- `llm-baseline.mjs` produces an emission for the task via Anthropic API (live run) or the committed Arm B fixture (dry run).
- A live run produces `bench/B10-import-replacement/results-<host>-<date>.json` containing the headline transitive-reachable-surface delta — the §1 desired-end-state artifact.

**Evaluation contract:**
- Required tests:
  - `bench/B10-import-replacement/test/validate-rfc5321-email.test.mjs` — covers task wiring (spec.yak parses, oracle inputs are well-formed, Arm A emit compiles via `@yakcc/compile` driving the hook+atoms path).
  - Reuses B9's Axis-3 byte-equivalence pattern: >=20 valid RFC-5321 inputs produce byte-equivalent results on both arms.
- Required real-path checks:
  - `pnpm bench:import-replacement -- --task validate-rfc5321-email --dry-run` exits 0 with a tabular summary.
  - One live run (operator-gated; requires `ANTHROPIC_API_KEY`) produces a result JSON; result-JSON commit is gated on §1's desired-end-state numerical thresholds being met (>=10x reduction in reachable-fn and reachable-bytes; correctness oracle passes on >=20 inputs for both arms).
- Required authority invariants:
  - Cost budget enforced per the suite-level **$150 USD `bench:full-pass` cap** (B9=$50 + B4=$75 + $25 reserve) per `DEC-V0-B4-SLICE2-COST-CEILING-004`, which amended the original `DEC-BENCH-SUITE-COST-001` $100 cap. The $25 reserve was explicitly sized for a future B10 slice — OD-4's $25 cap matches that allocation. Slice 2 of B10 carries its own per-slice cap to be set in this phase (suggest `DEC-BENCH-B10-SLICE2-COST-001 = $25`, with the operator confirming in §5 if they want a different bound).
  - No KILL pre-data: directional targets only, per `#167` Principle 1 and B9's discipline. The result JSON appends observed values to the new B10 DEC.
- Required integration points: `bench/B10-import-replacement/corpus-spec.json`, `bench/B10-import-replacement/tasks/validate-rfc5321-email/**`, root-level `bench:full-pass` aggregator (if it exists; otherwise this slice does not need to touch it).
- Forbidden shortcut: do not ship the result with a stubbed Arm B that emits the atom-composed solution directly. Arm B must be a clean Anthropic API call (or live-captured fixture) on a virgin prompt. Otherwise the headline is fraudulent.
- Ready-for-guardian when: results JSON committed, §1 thresholds met, B10 README documents the demo as the MVDP, new DEC anchored at `bench/B10-import-replacement/harness/run.mjs` cites the canonical result file.

**Scope manifest hint:**
- Allowed: `bench/B10-import-replacement/**`.
- Required: `bench/B10-import-replacement/tasks/validate-rfc5321-email/**`, `bench/B10-import-replacement/results-<host>-<date>.json`, updated `corpus-spec.json`.
- Forbidden: `packages/**`, `bench/B9-min-surface/**`, root `package.json` (already touched in P1).

**Complexity:** **M** (one task, one live run, but live-run discipline is non-trivial — cost cap, no-KILL discipline, host-host SHA tracking).

---

### P3 — Broaden Shadow-NPM Corpus (#510 slices 2-N)

**Owner WI:** #510.

**Inputs:** P2 landed. Atom-naming convention is settled and demonstrably works.

**Outputs:** Atom triplets for the rest of #510's target package set, decomposed one library at a time:

- jsonwebtoken (HS256-verify, decode-base64url, parse-jose-header)
- date-fns subset (parseISO, formatISO, addDays, differenceInMs, parse-tz-offset)
- lodash subset (cloneDeep, debounce, throttle, get, set, merge)
- semver (satisfies, coerce, compare, parse-component)
- uuid (v4-generate, v4-validate, v7-generate)
- zod/joi subset (string-min, string-max, regex-match, number-int, array-each)
- bcrypt (hash, verify with constant-time compare)
- nanoid, ms, p-limit, p-throttle

Each library is a **separate slice** with its own atoms + property tests + `npm_aliases` entries. Slices are parallelizable across implementers — they touch disjoint files in `packages/seeds/src/blocks/`.

**Evaluation contract (per slice):**
- Required tests: each atom passes property tests; the package's composition entry satisfies #510's acceptance — `yakcc_resolve` returns `combinedScore >= 0.7` for the natural prose query.
- Required real-path checks: `pnpm -r build` + `pnpm test -- --filter @yakcc/seeds` green; the slice's atoms are findable via `yakcc_resolve` end-to-end.
- Required authority invariants: same as P2a (atoms ride the existing triplet path, no parallel mechanism).
- Forbidden shortcut: **bcrypt slice must not stub constant-time compare.** The whole point of the bcrypt atoms is to ship a content-addressed timing-safe implementation; a naive comparison defeats the value-prop and degrades the headline.
- Ready-for-guardian when: per-slice atoms land + tests green + registry queryability confirmed.

**Scope manifest hint per slice:**
- Allowed: `packages/seeds/src/blocks/<library>/**`, `packages/seeds/test/fixtures/<library>/**`.
- Required: at least one atom per binding the slice claims.
- Forbidden: `packages/hooks-*/**`, `bench/**`, other libraries' atom directories.

**Complexity per slice:** **S–L** depending on library (uuid is **S**, lodash is **L**, date-fns is **L**, ms is **S**, bcrypt is **M** but with timing-safe-compare care).

**Acceptance for P3 as a whole:** >=10 of the #510 target packages have atom coverage with `yakcc_resolve` combinedScore >= 0.7 against canonical queries. Remaining packages may defer to a "long-tail" continuation initiative.

---

### P4 — Broaden Hook Intercept Rule (#508 slices 2-N)

**Owner WI:** #508.

**Inputs:** P2 landed. P3 atoms exist for additional libraries (each P4 slice can be paired with the corresponding P3 slice or follow it, depending on operator preference).

**Outputs:**
- The pre-emit scan generalizes from the validator-only scope to the full set of libraries covered by P3 atoms. If `DEC-IRT-INTERCEPT-GRANULARITY-001 == C`, this is purely data-driven and requires no hook code changes beyond what P2b already shipped (the slice's main artifact is then verifying that the broadening "just works"). If Option B (allowlist), each P4 slice adds an entry to the allowlist.
- The compile-time gate is exercised against multiple packages to confirm it doesn't have package-specific edge cases.
- Telemetry counters added: per-package intercept hit-rate, per-package atom-coverage-found rate. These ride the existing telemetry path (`DEC-HOOK-PHASE-1-001`); no new authority.

**Evaluation contract (per slice):**
- Required tests: integration test per library — fixture emit containing `import { ... } from '<library>'` is intercepted and the gate refuses the unexpanded form.
- Required real-path checks: `pnpm test -- --filter @yakcc/hooks-base --filter @yakcc/hooks-claude-code --filter @yakcc/compile` green.
- Required authority invariants: as P2b. No parallel intercept mechanism. Registry remains the single source of truth for "is there an atom for this binding?"
- Forbidden shortcut: do not hardcode a "skip intercept for library X" carve-out. If a library produces false-positive intercepts, fix the atoms or the granularity DEC; do not paper over with carve-outs.
- Ready-for-guardian when: per-slice fixture green; telemetry confirms expected hit-rates against B10 corpus.

**Scope manifest hint per slice:**
- Allowed: `packages/hooks-base/src/**`, `packages/hooks-claude-code/test/**` (fixtures), `packages/compile/test/**`.
- Forbidden: `bench/**`, `packages/seeds/**`.

**Complexity per slice:** **S–M** (mostly fixture+test work once P2b's mechanism is in place).

**Acceptance for P4 as a whole:** intercept fires correctly across all #510-covered libraries in fixture-driven integration tests; telemetry shows real-world hit-rates in line with directional targets.

---

### P5 — Broaden B10 Bench (#512 final)

**Owner WI:** #512.

**Inputs:** P3 atoms exist for >=10 libraries; P4 intercept rules cover the same set.

**Outputs:**
- B10 task corpus expanded to the full 12-20 task set from #512. Each task wires one (atom-set, intercept-rule) pair through Arms A + B.
- Folds in **B9's deferred Axis 4** (npm-audit CVE replay). The transitive-surface measurer's npm-audit phase already runs per `DEC-IRT-B10-METRIC-001`; P5 adds the per-task CVE-match count to the headline metric, satisfying #167's Slice-2 carry-over for B9 Axis 4.
- Live-run result JSON committed: `bench/B10-import-replacement/results-<host>-<date>.json` with >=12 tasks, satisfying #512's headline acceptance (>=10 of 12-20 tasks show >=90% reduction in reachable-fn and bytes).
- Update `MASTER_PLAN.md` benchmark-suite section to register B10 alongside B9 (this is a separate small slice — the orchestrator dispatches one implementer for it after P5 lands).

**Evaluation contract:**
- Required tests: per-task tests as in P2c; suite-level smoke test confirms all 12-20 tasks run dry-run end-to-end.
- Required real-path checks: live `pnpm bench:import-replacement` run within cost budget; result JSON commit; updated B10 README cites the result.
- Required authority invariants: same B9 discipline (no KILL pre-data, sha256 corpus pinning, cost budget enforcement).
- Required integration points: `bench/B10-import-replacement/corpus-spec.json`, `bench:full-pass` aggregator script (one-line addition if it exists).
- Forbidden shortcut: do not cherry-pick the 10 best results to satisfy "10 of 12-20". Live-run and commit honestly; if fewer than 10 hit thresholds, file a follow-up issue per task rather than re-curating the headline.
- Ready-for-guardian when: full corpus result JSON committed with >=10 tasks meeting thresholds OR with a documented per-task explanation (matching #512's acceptance language).

**Scope manifest hint:**
- Allowed: `bench/B10-import-replacement/**`.
- Forbidden: `packages/**`.

**Complexity:** **L** (12-20 tasks, live API budget, headline reconciliation).

---

## 4. Risk Register

Per phase, top 2-3 risks with concrete mitigations.

### P0 risks

| Risk | Mitigation |
|---|---|
| Operator picks naming Option A or B but planner has assumed C in P2b, requiring P2b rewrite. | §5 names the coupling explicitly; downstream planner for P2b reads the resolved DEC before authoring slice scope. |
| DECs land but no consumer enforces them; "decided" becomes "vibes". | Each DEC must be anchored as `@decision` comment **at the consuming code surface** (per CLAUDE.md "Code is Truth"), not just in a doc. |

### P1 risks

| Risk | Mitigation |
|---|---|
| `ts-morph` can't reliably resolve npm internals (CommonJS interop, `package.json#exports` map, dual-format ESM/CJS packages). | Pin ts-morph to a known-good version; for any unresolvable import, fall back to "file unresolvable, count as 0 functions and emit a `unresolved_imports` field in the result JSON" — Arm B's headline penalty is undercounted but never overcounted. |
| npm-audit invocation is non-deterministic across hosts (database version drift). | Pin the audit DB snapshot via `npm-audit-json --offline` against a committed db fixture; document refresh cadence in the harness README. |
| Smoke fixture on B9's `parse-int-list` produces surprising numbers (Arm B emits `JSON.parse` which the measurer might resolve into TS lib.d.ts and count thousands of fns). | Explicitly exclude TS standard-library files (`lib.*.d.ts`) from the count and document the exclusion in `DEC-IRT-B10-METRIC-001`. |

### P2a risks

| Risk | Mitigation |
|---|---|
| RFC 5321 has many subtle corner cases (IP-literal domains, quoted-local-part, internationalized domain names). The atoms could ship an incomplete oracle that disagrees with `validator.isEmail`'s default behavior. | Adopt `validator.isEmail`'s *documented default* (no IP literals, no quoted local, default options) as the oracle; explicitly out-of-scope the option-flag surface. Document this in the atom's spec.yak. |
| `npm_aliases` schema extension lands without a migration for existing rows. | Default `npm_aliases` to `[]` for all existing rows; migration is a single ALTER TABLE in `packages/registry/src/schema.ts`. |

### P2b risks

| Risk | Mitigation |
|---|---|
| The intercept hook fires too often and degrades conversational UX, breaking adoption. | The granularity DEC explicitly constrains intercept to packages with atom coverage; default behavior in absence of coverage is passthrough. Add a telemetry counter for false-positive complaints and tune. |
| Compile-time gate breaks existing examples that import `validator` or other future P3 packages. | Audit `examples/**` and `packages/seeds/src/blocks/**` for any existing imports of P3 libraries; either pre-convert them in this slice or carve out a documented "examples are not gate-enforced" boundary. Recommendation: carve-out, with `@decision` annotation. |
| AST scan misses dynamic imports or template-literal imports, allowing escapes. | Treat dynamic and template imports as **not intercepted** but log them in telemetry. Document this as a known limitation in `DEC-IRT-INTERCEPT-GRANULARITY-001`. |

### P2c risks

| Risk | Mitigation |
|---|---|
| Live API run cost overshoots the slice cap. | The slice cap (suggested $25) is enforced by the harness's existing `BudgetExceededError` path (`DEC-BENCH-B9-SLICE1-COST-001` discipline). Dry-run first; live-run only when dry-run is green. |
| Arm B emits something other than `import { isEmail } from 'validator'` (e.g. hand-rolls a regex, or uses `email-validator` instead). | Frozen prompt template per B9's discipline (`DEC-V0-MIN-SURFACE-003`); if Arm B emits something other than the targeted import in <50% of `arm_b_n_reps` runs, the task is recharacterized as "not import-heavy for this model" and a different demo task is selected. |

### P3 risks

| Risk | Mitigation |
|---|---|
| Decomposing date-fns or lodash naively explodes into hundreds of atoms (date-fns has ~200 named exports). | #510's target subset is intentionally bounded ("subset"); P3 planner per slice must close on the binding list before authoring atoms. Anything beyond the named target is a separate follow-up issue. |
| Property-test coverage gaps let semantically-broken atoms ship. | Each atom requires fast-check property tests; reviewer pass blocks if coverage < a per-slice threshold. |

### P4 risks

| Risk | Mitigation |
|---|---|
| Real-world LLM emissions use `import * as _ from 'lodash'` rather than named imports; intercept based on named bindings misses these. | Pre-emit scan must handle `ImportDefaultDeclaration`, `ImportNamespaceSpecifier`, and `ImportSpecifier` shapes. Test fixtures per shape per library. |
| Hook telemetry counts `import` lines in *type-only* imports (`import type { ... }`), causing false-positive intercepts. | Filter `importKind === 'type'` and `isTypeOnly` at the AST level; explicit fixture test per language version. |

### P5 risks

| Risk | Mitigation |
|---|---|
| Result JSON commit reveals fewer than 10 of 12-20 tasks meet thresholds. | #512's acceptance language already names "on >=10 of the 12-20 tasks"; if not met, decompose per-task and file follow-ups rather than re-curating the headline. |
| B9 Axis-4 fold-in conflicts with B9 Slice 2's plans for the same axis. | Coordinate with the active benchmark-suite initiative owner before P5 starts; if B9 Slice 2 plans to land Axis 4 first, P5 imports the result rather than re-implementing. (See `MASTER_PLAN.md` benchmark-suite-characterisation section for the live state.) |

---

## 5. Decision Boundaries

These are points where the **operator must adjudicate** before downstream slices can be planned and scoped. Implementer-decidable points are noted separately.

### Operator-decision items (block downstream planning)

| # | Decision | Options | Recommended | Why operator |
|---|---|---|---|---|
| OD-1 | **Atom naming convention** (`DEC-IRT-ATOM-NAMING-001`) | A: per-binding, B: per-behavior, C: behavior + npm_aliases | **C** | Defines the corpus's data shape forever; mid-flight changes invalidate prior atoms. Pairs with OD-2. |
| OD-2 | **Intercept granularity** (`DEC-IRT-INTERCEPT-GRANULARITY-001`) | A: always intercept, B: allowlist, C: registry-driven | **C** *(if OD-1 = C)*, else **B** | UX trade-off; affects conversational flow. Coupled to OD-1. |
| OD-3 | **Demo library for MVDP** | validator (recommended), or alternative from #510 set | **validator** + `validate-rfc5321-email` task | Affects scope of P2a + P2b + P2c; operator may have product-priority reasons to choose differently. |
| OD-4 | **B10 Slice 2 cost cap** | Suggest `DEC-BENCH-B10-SLICE2-COST-001 = $25` | $25 | Spend authority; aligns with B9 Slice 1's $50 cap pattern (`DEC-BENCH-B9-SLICE1-COST-001`). Default is $25, matching the $25 suite reserve in `DEC-V0-B4-SLICE2-COST-CEILING-004`. Operator may adjust only if the B10 task set demands more. |

### Implementer-decidable items (no operator adjudication needed)

- ts-morph version pinning in P1 (technical choice; implementer picks a stable version).
- Property-test sample sizes per atom in P2a / P3 (within bounded heuristic — at least 100 fast-check inputs per atom property).
- Per-slice file layout under `packages/seeds/src/blocks/` (within existing convention).
- Whether P4 slices land paired with P3 slices or after all of P3 lands (sequencing flexibility; operator may steer but does not need to pre-decide).
- Whether `examples/**` is pre-converted or carve-out from the compile-time gate (P2b implementer decides per the documented carve-out option).

### Items that look like operator decisions but aren't

- **"Should we use ts-morph or the TS compiler API directly?"** — implementer-decidable; ts-morph is already a B9 dep and the obviously-right choice. Don't pre-ask.
- **"How many atoms should `validate-rfc5321-email` decompose into?"** — implementer-decidable subject to "decomposed enough that Arm A's reachable-fn count is small."

---

## 6. Out of Scope (explicit)

This triad **does not** do the following. Each item names where the missing concern lives instead.

- **Runtime performance of atom-composed code vs library-imported code.** That's B1-latency's job (`bench/B1-latency/`). B10 measures *surface*, not throughput.
- **Token-usage delta between LLM-with-yakcc vs LLM-without-yakcc on import-heavy tasks.** That's B4-tokens's job (`bench/B4-tokens/`).
- **End-to-end coherence of Arm A's emitted module across many tasks.** That's B5-coherence's job (`bench/B5-coherence/`).
- **Air-gap behavior of the registry under import-intercept load.** That's B6-airgap's job (`bench/B6-airgap/`).
- **Verification-spine attestation level (L0/L1/L2/L3) of the new atoms.** Per `VERIFICATION.md`, atoms enter at their author's claimed level; this triad does not introduce new verification machinery, only new atom content.
- **`yakcc shave` / `universalize` ingestion of new atoms from existing libraries.** That's WI-014's lane (`MASTER_PLAN.md` §"Shave"). P2a/P3 seed atoms via the existing seed-bootstrap path; using `shave` is a possible accelerator but not a triad requirement.
- **MASTER_PLAN.md update to register P0/P1/P2/P3/P4/P5 as a formal initiative.** This is a follow-up slice the orchestrator dispatches once the operator confirms §5 adjudications. The triad-plan is read-only from MASTER_PLAN's perspective.
- **Federation / cross-mesh atom sharing of the new shadow-npm atoms.** Federation discipline applies post-landing per `FEDERATION.md`; the triad ships through the local registry only.
- **Backporting the import-intercept hook to `hooks-cursor` or `hooks-codex`.** Those adapters track behind hooks-claude-code per `DEC-HOOK-BASE-001` rollout discipline; this triad lands hooks-claude-code first. Backports are downstream WIs.
- **Replacing the existing `yakcc_resolve` tool surface or `QueryIntentCard` schema.** P2b consumes the existing surface as-is. Any schema evolution is owned by the discovery initiative, not this triad.

---

## 7. Order of Operations Summary

Linear sequence a future orchestrator can drive without re-deriving dependencies.

1. **Operator adjudicates §5 OD-1, OD-2, OD-3, OD-4.** Block until done.
2. **Dispatch planner** for **P0** (foundation DECs). Outputs `docs/adr/import-replacement-triad/` or `@decision`-anchored DEC stamps. Guardian-land.
3. **Dispatch planner → implementer → reviewer → guardian** for **P1** (B10 harness). Lands `bench/B10-import-replacement/` skeleton + smoke fixture.
4. **Dispatch P2a and P2b planners in parallel.** P2a touches `packages/seeds/**` + (conditionally) `packages/registry/src/schema.ts`; P2b touches `packages/hooks-*/**` + `packages/compile/**`. Disjoint scope manifests; no merge contention. Both run through canonical chain to guardian-land independently.
5. **After P2a and P2b both land**, dispatch planner for **P2c** (B10 demo task + live run). This is the MVDP terminal slice. Guardian-land the result JSON.
6. **Announce MVDP complete.** Headline numbers from `bench/B10-import-replacement/results-<host>-<date>.json` validate the triad's value-prop on one (library, task, rule) triple.
7. **Dispatch P3 slices** (one per library in #510 target set). Parallelizable across implementers. Each lands independently.
8. **Dispatch P4 slices**, paired with or following the corresponding P3 slices. If OD-2 = C, P4 is mostly verification work (the hook generalizes automatically); if OD-2 = B, each P4 slice adds an allowlist entry.
9. **Dispatch P5** once P3 atoms cover >=10 libraries and P4 rules cover the same. Run full B10 corpus; commit result JSON; satisfy #512's acceptance.
10. **Dispatch a small MASTER_PLAN-registration slice** to record the triad's outcome in `MASTER_PLAN.md` benchmark-suite section and close #508, #510, #512.

Throughout: every code-bearing slice carries its own Evaluation Contract and Scope Manifest written by **its slice-level planner**, not by this triad plan. This document only sets the joint contract: phases, dependencies, invariants, and decision boundaries.

---

## Appendix A — Cross-references

- Issues: [#508](https://github.com/cneckar/yakcc/issues/508), [#510](https://github.com/cneckar/yakcc/issues/510), [#512](https://github.com/cneckar/yakcc/issues/512).
- Related issue (B9 deferred Axis 4 carryover): [#446](https://github.com/cneckar/yakcc/issues/446), [#167](https://github.com/cneckar/yakcc/issues/167).
- Related operator-decision pattern: [#143](https://github.com/cneckar/yakcc/issues/143) (operator decision 2026-05-06 model used for §5 framing).
- Hook surface: `packages/hooks-base/src/index.ts`, `packages/hooks-claude-code/src/index.ts`, `packages/hooks-claude-code/src/yakcc-resolve-tool.ts`.
- Tool surface: `yakcc_resolve` per `DEC-HOOK-PHASE-3-L3-MCP-001` and `docs/adr/discovery-llm-interaction.md`.
- Registry surface: `packages/registry/src/{schema.ts,search.ts,select.ts}`.
- Seed-atom pattern: `packages/seeds/src/blocks/**`.
- Bench discipline reference: `bench/B9-min-surface/README.md`, `bench/B9-min-surface/corpus-spec.json`.
- DEC anchors referenced (already in the codebase):
  - `DEC-HOOK-BASE-001` — hooks-base authority.
  - `DEC-HOOK-CLAUDE-CODE-PROD-001` — claude-code adapter production.
  - `DEC-HOOK-PHASE-1-001` — telemetry wire-in.
  - `DEC-HOOK-PHASE-2-001` — substitution wire-in.
  - `DEC-HOOK-PHASE-3-L3-MCP-001` — `yakcc_resolve` MCP tool surface.
  - `DEC-V0-MIN-SURFACE-001` through `005` — B9 discipline pattern this triad mirrors.
  - `DEC-BENCH-SUITE-COST-001` — original $100 suite cap (amended by `DEC-V0-B4-SLICE2-COST-CEILING-004` to $150: B9=$50 + B4=$75 + $25 reserve; the $25 reserve was explicitly sized for a future B10 slice).
  - `DEC-BENCH-B9-SLICE1-COST-001` — $50 per-slice cap pattern.
  - `DEC-BENCH-B7-CORPUS-CANONICAL-LF-001` — LF normalization for sha256 fingerprints.

## Appendix B — DECs this plan proposes

These are *proposed* DECs that downstream slices land. They are not authoritative until written at their consuming code surface.

| DEC | Lands in (proposed) | Decides |
|---|---|---|
| `DEC-IRT-ATOM-NAMING-001` | `packages/seeds/src/blocks/` README or `packages/registry/src/schema.ts` `@decision` | OD-1 |
| `DEC-IRT-INTERCEPT-GRANULARITY-001` | `packages/hooks-base/src/import-intercept.ts` (new) `@decision` | OD-2 |
| `DEC-IRT-B10-METRIC-001` | `bench/B10-import-replacement/harness/measure-transitive-surface.mjs` `@decision` | B10 metric methodology |
| `DEC-BENCH-B10-SLICE2-COST-001` | `bench/B10-import-replacement/harness/run.mjs` `@decision` | OD-4 |

---

*End of plan.*
