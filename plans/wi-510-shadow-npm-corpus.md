# WI-510 — Shadow-NPM Atom Corpus Expansion

**Status:** Planning pass (read-only research output). Not Guardian readiness for any code slice.
**Scope:** Implements [#510](https://github.com/cneckar/yakcc/issues/510) — expand the seed registry corpus with shadow-npm atoms for the top LLM-imported packages.
**Branch:** `feature/wi-510-shadow-npm-corpus`
**Worktree:** `C:/src/yakcc/.worktrees/wi-510-shadow-npm-corpus`
**Authored:** 2026-05-14 (planner stage, workflow `WI-510-SHADOW-NPM-CORPUS`)
**Parent coordination doc:** `plans/import-replacement-triad.md` (PR #517, merged). This plan is the **#510-specific expansion** of that triad's P2a + P3 lanes. Where the triad doc and this doc conflict, the triad doc's cross-cutting decisions (`DEC-IRT-*`) win; this doc only refines the #510-internal authoring process, slicing, and evaluation contract.

This document changes no TypeScript source, does not modify `MASTER_PLAN.md` permanent sections, and does not constitute Guardian readiness for any code-bearing slice.

---

## 1. Root Cause / Motivation

**The problem, restated:** yakcc's headline value proposition is dependency replacement — "instead of `import { isEmail } from 'validator'`, compose content-addressed atoms that do the same thing with a tiny reachable surface." Issue #508 (import-intercept hook, demand side) and #512 (B10 import-heavy bench, measurement side) both **structurally depend on a supply of atoms** that implement the behaviors LLMs actually reach for. Today that supply does not exist.

**Current state (verified):** `packages/seeds/src/blocks/` contains exactly **26** atoms. Every one is a parsing-character primitive (`digit`, `comma`, `optional-whitespace`, `bracket`, `peek-char`, …) or a small generic utility (`memoize`, `lru-node`, `queue-drain`, `timer-handle`). The single most "shadow-npm-shaped" atom is `semver-component-parser` — and even that was authored to support a *B4 internal task*, not to shadow the `semver` npm package's public surface.

**Consequence:** The import-intercept hook (`packages/hooks-base/src/yakcc-resolve.ts` / `substitute.ts`), when handed `import { isEmail } from 'validator'`, queries the registry and gets `{atoms:[]}` — not because the hook is broken, but because there is nothing to find. The corpus is the gating bottleneck for the entire import-replacement triad.

**What "done" means for #510 (from the issue):**
1. Each top-20 npm package has **≥1 atom** for its most-imported function.
2. The registry answers atom-lookup for any of those queries with **`combinedScore >= 0.7`** against the bge-small-en-v1.5 embedder.

This plan treats criterion (2) as the load-bearing, mechanically-verifiable acceptance gate and pins the exact measurement procedure in §6 (Evaluation Contract).

---

## 2. How the Existing Substrate Works (System Map)

Every claim below was verified against the worktree at planning time.

### 2.1 Atom = 4-file triplet directory

A seed atom is a directory `packages/seeds/src/blocks/<atom-name>/` containing:

| File | Role | Authority |
|------|------|-----------|
| `impl.ts` | The implementation. Must pass the **strict-TS-subset validator** (`packages/ir/src/strict-subset.ts`). Carries a `@decision` annotation block. | `parseBlockTriplet` (`@yakcc/ir`) validates it; `seedRegistry` stores `implSource`. |
| `spec.yak` | JSON contract: `name`, `inputs`, `outputs`, `preconditions`, `postconditions`, `invariants`, `effects`, `level`, `behavior`, `guarantees`, `errorConditions`, `nonFunctional`, `propertyTests`. **The `behavior` string is what gets embedded** and is therefore the lever for `combinedScore`. | `validateSpecYak` (`@yakcc/ir`); `canonicalize` (`@yakcc/contracts`) produces `specCanonicalBytes`; `storeBlock` embeds it. |
| `proof/manifest.json` | `{ "artifacts": [{ "kind": "property_tests", "path": "tests.fast-check.ts" }] }` | Parsed by `parseBlockTriplet`; bytes feed `blockMerkleRoot`. |
| `proof/tests.fast-check.ts` | Property-test artifact. **Note:** in the current 26 atoms this file is just `export * from "../impl.js";` plus a header listing the `propertyTests` IDs declared in `spec.yak`. The declared `propertyTests` array in `spec.yak` is the actual contract; the `.ts` file is a re-export shell so runners can import the impl. | `parseBlockTriplet` captures it as an artifact; bytes feed `blockMerkleRoot`. |

`blockMerkleRoot = hash(specHash ‖ implHash ‖ proofRoot)` — all three sidecar files are content-addressed into the atom's identity.

### 2.2 Loading path

`packages/seeds/src/seed.ts :: seedRegistry(registry)` enumerates `blocks/` directories (sorted, deterministic), calls `parseBlockTriplet(blockDir)` on each — which (a) reads the 3 sidecar files, (b) runs `validateSpecYak`, (c) runs the strict-subset validator on `impl.ts`, (d) derives `blockMerkleRoot`, `specHash`, `canonicalAstHash` — then builds a `BlockTripletRow` and calls `registry.storeBlock(row)` (idempotent `INSERT OR IGNORE`). Adding a new atom directory means it is **automatically** picked up; no registration list to edit. `index.ts` re-exports each block function by name — a new atom that needs a public re-export adds one line here (optional; only needed if other yakcc code imports the function directly).

### 2.3 Workspace-plumbing interaction with PR #520 (verified — NO collision)

PR #520 (`feature/wi-fix-494-twopass-nondeterm`) declares `packages/*/src/blocks/*/{spec.yak,proof/manifest.json,proof/tests.fast-check.ts}` as `PLUMBING_INCLUDE_GLOBS` in `packages/cli/src/commands/plumbing-globs.ts`, so `compile-self` materializes the sidecars into `dist-recompiled/`. These are **pattern globs** — any new atom directory under `packages/seeds/src/blocks/` that ships exactly those three sidecar filenames is covered for free. **The only obligation #520 imposes on WI-510:** every new atom MUST ship `spec.yak`, `proof/manifest.json`, and `proof/tests.fast-check.ts` with exactly those names (no extra/renamed sidecars), or two-pass equivalence regresses. This is already the required triplet shape, so the constraint is "follow the existing pattern." PR #520 also sorts `readdir` for deterministic walk — new directories slot in alphabetically with no action needed. **WI-510 must not touch `plumbing-globs.ts` or `copy-triplets.mjs`.**

### 2.4 Discovery-eval harness — how `combinedScore` is actually measured

`packages/registry/src/discovery-eval-helpers.ts` is the metric authority. Verified facts:

- **`combinedScore` band boundaries** (`assignScoreBand`): `strong ≥ 0.85`, `confident ≥ 0.70`, `weak ≥ 0.50`, `poor < 0.50`. The issue's `>= 0.7` acceptance threshold is **exactly the `confident` band floor.**
- `findCandidatesByQuery(card: QueryIntentCard)` returns `QueryCandidate[]` each carrying a `combinedScore` already in `[0,1]` (computed inside `storage.ts` via the corrected L2→score formula `1 - d²/4`, `DEC-V3-DISCOVERY-CALIBRATION-FIX-002`). This is the path WI-510's eval must use — **not** `findCandidatesByIntent` (asymmetric text derivation, legacy smoke-test path).
- **Provider:** the issue names `bge-small-en-v1.5`. The harness's local provider is `createLocalEmbeddingProvider(modelId, dim)` and the full-corpus test reads `DISCOVERY_EMBED_MODEL` / `DISCOVERY_EMBED_DIM` env vars (default `Xenova/all-MiniLM-L6-v2`, 384-dim). bge-small-en-v1.5 is a 384-dim model, so it fits the existing `FLOAT[384]` schema (`DEC-EMBED-010`) — **no schema migration needed.** The Xenova mirror is `Xenova/bge-small-en-v1.5`. (See §5 open question — confirm the model ID string the operator wants pinned.)
- `discovery-eval-full-corpus.test.ts` is the natural home for WI-510's acceptance queries: it loads the full bootstrap registry, re-embeds with the semantic provider, **loads referenced seed atoms by `expectedAtomName`** (resolving `blockMerkleRoot` from the on-disk seed files at test time — no hardcoded hashes), and runs the corpus through `findCandidatesByQuery`. WI-510 extends `packages/registry/test/discovery-benchmark/corpus.json` with one entry per shadow-npm atom.
- The corpus query entries with `expectedAtomName` resolve the atom by its **seed directory name**, so the atom directory name is the join key between the corpus query and the atom.

### 2.5 Strict-TS-subset constraint on `impl.ts`

`packages/ir/src/strict-subset.ts` rejects `any` (explicit, `as any`, `<any>`, generic-arg, return, param). The worked examples (`memoize/impl.ts`) show the discipline: inputs/outputs typed as `unknown` where generics would otherwise need `any`, with callers casting at the use site. **Every WI-510 atom `impl.ts` must pass `pnpm --filter @yakcc/seeds strict-subset` (or the `parseBlockTriplet` validation that `seedRegistry` runs).** Atoms must use the `@yakcc/...` workspace alias for any cross-package import, never `../../../packages/...` (MEMORY: tsc rootDir constraint).

---

## 3. Atom Selection — Packages, Functions, Priority

The issue's methodology is "harvest call sites from a corpus of real TS/JS projects, rank by frequency, seed atoms for top-N." Running a full GitHub-corpus harvest is itself a multi-day data-engineering task and is **out of scope as a blocking prerequisite** — see §3.2. Instead this plan uses the issue's own explicitly-enumerated target set as the ranked list (the issue author already did the frequency triage; the bullet order in the issue *is* the priority order), and defines a *lightweight, reproducible* harvesting check (§3.2) that an implementer runs to confirm each chosen function is genuinely the most-imported binding of its package before authoring its atom.

### 3.1 Target set, decomposed by package family

Priority tier follows the issue's ordering. "Headline function" = the single most-imported binding (the ≥1-atom acceptance target); "extended" = additional bindings authored within the same slice if the family is small.

| # | Package | Headline function (≥1-atom target) | Extended bindings (same slice) | Family | Notes |
|---|---------|-----------------------------------|-------------------------------|--------|-------|
| 1 | `validator` | `isEmail` (RFC 5321 default-options) | `isURL`, `isUUID`, `isAlphanumeric` | **validators** | Slice 1 anchor. Triad doc §5 names `validator.isEmail` as the demo binding. |
| 2 | `semver` | `satisfies` | `coerce`, `compare`, `valid`/`parse` | **versioning** | `semver-component-parser` already exists — reuse as a *composition input*, do not duplicate. |
| 3 | `uuid` | `v4` (generate) | `validate` (v4), `v7` (generate) | **identifiers** | v4 generate is non-pure (RNG effect) — declare the `effects` field honestly in `spec.yak`. |
| 4 | `nanoid` | `nanoid` (generate, default 21-char) | — | **identifiers** | Single binding; pairs with `uuid` family slice. |
| 5 | `ms` | `parseDuration` (`ms('2h')` → number) | `format` (number → `'2h'`) | **time** | Pure, small, well-defined grammar — good early win. |
| 6 | `date-fns` | `parseISO` | `formatISO`, `addDays`, `differenceInMilliseconds` | **time** | `parse-tz-offset` is a useful sub-atom that the others compose. |
| 7 | `lodash` (subset) | `cloneDeep` | `get`, `set`, `merge`, `debounce`, `throttle` | **collection/fn** | Largest family; `debounce`/`throttle` carry timer effects — reuse `timer-handle` seed atom. |
| 8 | `jsonwebtoken` | `verify` (HS256) | `decode` (base64url), `parseJoseHeader` | **crypto/token** | HS256-verify composes a constant-time-compare sub-atom (see `bcrypt` family). |
| 9 | `bcrypt` | `compare` (constant-time verify) | `hash` | **crypto/token** | Constant-time compare is a shared sub-atom for `jsonwebtoken` HS256-verify. |
| 10 | `zod` / `joi` (subset) | `string().min()` validator | `string().max()`, `regex`, `number().int()`, `array().each()` | **validators** | Author as standalone predicate atoms, not a schema-builder DSL. |
| 11 | `p-limit` / `p-throttle` | `pLimit` (sliding-window concurrency cap) | — | **async/fn** | Effectful; declare honestly. Lowest priority — depends on a promise-orchestration sub-atom. |

**Acceptance arithmetic:** the issue says "each top-20 npm package has ≥1 atom." The 11 packages above are the issue's explicit set. The headline-function column gives the ≥1-atom guarantee per package. If the operator's "top-20" is strictly 20 packages, the long-tail 9 (e.g. `axios`/`node-fetch`, `chalk`, `commander`, `glob`, `dotenv`, `csv-parse`, `ajv`, `jsonpointer`, `pino`) are folded into a continuation initiative (§4, P3-tail) — flagged as an open question in §5 because some of those (`axios`, `chalk`) are I/O-bound or terminal-bound and may not be atom-shaped at all.

### 3.2 Lightweight harvesting check (per-function, reproducible, non-blocking)

The implementer, before authoring each atom, runs this check to confirm the chosen function is genuinely the package's most-imported binding. This replaces a full GitHub-corpus crawl with a fast, reproducible proxy:

1. **npm-registry signal:** `npm view <pkg>` for the package's own docs ordering is a weak signal; stronger:
2. **Typed-surface signal:** read the package's `.d.ts` (`node_modules/<pkg>/index.d.ts`) — the export ordering and the JSDoc `@example` blocks reveal the maintainer's view of the primary surface.
3. **Issue-set anchor:** the issue body already enumerates the target functions per package. Treat the issue's named function as the default; the check only needs to *not contradict* it.
4. **Record the evidence:** each atom's `spec.yak` `behavior` string, and its `@decision` annotation in `impl.ts`, cite *why this binding* (e.g. "`validator.isEmail` is the first-listed export and the only one with a dedicated RFC backing"). The `@decision` block is the durable harvest record — no separate harvest doc.

This keeps "harvesting" honest and reproducible without making a data-engineering crawl a blocking dependency. If the operator wants a real frequency-ranked crawl, that is a **separate, parallel WI** feeding a *future* re-prioritization — it does not block authoring the issue's already-named set.

---

## 4. Slicing Recommendation

This WI is large (≈30+ atoms across 11 packages). It is sliced **by package family**, smallest-and-most-self-contained first, so each slice is an independently shippable PR that moves the acceptance counter and de-risks the next slice.

```
Slice 1 (THIS PLAN, fully specified below)  — validators family: validator
        ├─ atoms: validate-rfc5321-email (+ isURL, isUUID, isAlphanumeric behaviors)
        ├─ corpus.json query entries for each
        └─ proves the end-to-end authoring + eval loop on the triad's demo library
                  │
                  ▼  (loop proven; subsequent slices parallelizable)
Slice 2 — time family: ms + date-fns        (pure, well-defined grammars)
Slice 3 — identifiers family: uuid + nanoid (introduces honest `effects` declaration)
Slice 4 — versioning family: semver          (reuses semver-component-parser as composition input)
Slice 5 — crypto/token family: bcrypt + jsonwebtoken (shared constant-time-compare sub-atom)
Slice 6 — collection/fn family: lodash subset (largest; reuses timer-handle)
Slice 7 — validators family wave 2: zod/joi predicate subset
Slice 8 — async/fn family: p-limit/p-throttle (lowest priority; promise-orchestration sub-atom)
Slice T (continuation initiative) — long-tail packages to reach "top-20" if operator requires it
```

**Dependency edges:** Slices 2–8 each depend only on Slice 1 (loop proven) and are otherwise mutually independent — they can be dispatched to parallel implementers. Slice 5's `jsonwebtoken` HS256-verify atom depends on Slice 5's own `bcrypt` constant-time-compare sub-atom (intra-slice ordering, not a cross-slice edge). Slice 4 reads the existing `semver-component-parser` atom but does not modify it.

**Critical path:** Slice 1 → (any of 2–8). Max width after Slice 1: 7 parallel slices.

**Per-slice gate:** `review` (reviewer verifies the Evaluation Contract). No slice needs `approve` *unless* `DEC-IRT-ATOM-NAMING-001` (§5) lands as Option C, which adds a registry-schema field — that schema change, if it happens, is a `guardian`-bound constitutional edit and gets its own `approve` gate in whichever slice first needs the field.

---

## 5. Open Questions — Operator Decision Required (posted to issue #510)

Two genuine product-judgment boundaries block *full* specification. They are posted as a comment on issue #510. Slice 1 is specified below in a way that **holds regardless of the answers**, so planning is not stalled — but the answers determine atom *naming* and the *top-20 ceiling*.

1. **`DEC-IRT-ATOM-NAMING-001` is still unadjudicated.** The triad coordination doc (`plans/import-replacement-triad.md` §5) lists three options (A: per-binding `validator::isEmail`; B: per-behavior `validate-rfc5321-email`; C: per-behavior **plus** an `npm_aliases` registry-schema field). #508 is closed but shipped no separate implementation PR — it was folded into the triad plan, so the decision was never actually made. This decision determines: (a) every atom's directory name, (b) whether WI-510 ships a `schema.ts` field addition (a constitutional edit needing `approve`), (c) how #508's eventual intercept hook joins an `import` specifier to an atom. **Slice 1 below is authored against Option B** (the planner's recommendation: it aligns with yakcc's content-addressed worldview — the atom is the behavior, not the npm endpoint — and needs no schema change) **with a documented migration note**: if the operator picks C, Slice 1's atoms gain an `npm_aliases` field and the schema addition is pulled forward into Slice 1. If A, the directory names are re-keyed to `validator__isEmail` form. The corpus-query `expectedAtomName` join key adjusts mechanically either way.
2. **"Top-20" ceiling.** The issue says "each top-20 npm package." This plan's §3.1 names 11 packages (the issue's own explicit set). Does the acceptance bar require literally 20 distinct packages — pulling in long-tail packages some of which (`axios`, `chalk`, `commander`) are I/O-/terminal-bound and arguably *not atom-shaped* — or is "the enumerated target set, fully covered" the real bar, with a documented carve-out for non-atom-shaped packages?

These are posted to #510, not surfaced as chat questions, per the orchestration contract.

---

## 6. Evaluation Contract — Slice 1 (validator family)

This is the exact, executable acceptance target. A reviewer runs every check; "ready for guardian" is defined at the end.

### 6.1 Required tests

- **`pnpm --filter @yakcc/seeds test`** — `seed.test.ts` must pass with the new atom count. The current suite asserts a fixed row count from `seedRegistry()`; Slice 1 updates that assertion to `26 + <new atom count>` and the suite must be green. This proves every new atom passes `parseBlockTriplet` (spec-yak validation + strict-subset validation + merkle derivation).
- **`pnpm --filter @yakcc/seeds strict-subset`** (or equivalent `parseBlockTriplet` path) — every new `impl.ts` passes the strict-TS-subset validator with zero violations.
- **`pnpm --filter @yakcc/seeds build`** — `tsc -p .` compiles clean and `copy-triplets.mjs` materializes the new triplets (proves the `@yakcc/...` alias discipline held and the sidecars are well-formed).
- **`pnpm --filter @yakcc/seeds typecheck`** — no type errors.
- **Per-atom property tests** — the `propertyTests` array in each new `spec.yak` declares ≥6 named property cases covering: nominal-true, nominal-false, boundary, malformed-input, empty-input, and one adversarial case. The reviewer confirms each declared `propertyTests[].id` corresponds to a real, meaningful assertion (the `tests.fast-check.ts` re-export shell pattern is followed; the contract lives in `spec.yak` per the existing 26-atom convention).
- **Registry build + corpus-schema test** — `pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts` passes its **infrastructure-correctness** describe blocks (corpus.json parseable, IDs unique, required fields present, ≥50 entries, all 5 categories ≥8 entries) with the new corpus entries added.

### 6.2 Required real-path checks

- **The acceptance measurement (the issue's `combinedScore >= 0.7`):** run the full-corpus discovery eval with the semantic provider against the bootstrap registry:
  ```
  # from packages/registry/
  DISCOVERY_EVAL_PROVIDER=local \
  DISCOVERY_EMBED_MODEL=Xenova/bge-small-en-v1.5 \
  DISCOVERY_EMBED_DIM=384 \
  pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts
  ```
  Prerequisite: `bootstrap/yakcc.registry.sqlite` exists (run `pnpm bootstrap` if absent — the test skips gracefully without it, so the reviewer MUST confirm it is present and the quality describe blocks actually ran, not skipped).
  **Pass condition:** for each Slice 1 atom, its `corpus.json` query entry's top-1 result resolves to that atom's `blockMerkleRoot` (`top1Correct === true`) **and** `top1Score >= 0.70` (`confident` band or better). The reviewer reads the emitted `tmp/discovery-eval/baseline-single-vector-full-corpus-*.json` and confirms the per-entry scores for the `validator`-family entries.
- **The atom is reachable through the production seed-load path:** `seedRegistry()` stores the new atoms (proven by the updated `seed.test.ts` row count) — i.e. the atom is not just on disk, it is in the registry the bootstrap process produces.

### 6.3 Required authority invariants

- **One atom = one triplet directory, picked up by directory enumeration.** No edit to a hand-maintained block list (there is none — `seed.ts` enumerates). `index.ts` re-export is optional and only added if yakcc code imports the function directly.
- **`blockMerkleRoot` integrity:** the atom's identity is `hash(specHash ‖ implHash ‖ proofRoot)`. The reviewer does not hand-edit any merkle root anywhere; corpus entries reference atoms by `expectedAtomName` (directory name), resolved to the root at test time.
- **Workspace-plumbing globs are derived, not authored:** Slice 1 ships exactly the three sidecars (`spec.yak`, `proof/manifest.json`, `proof/tests.fast-check.ts`) with those exact names so PR #520's pattern globs cover them. The reviewer confirms `plumbing-globs.ts` and `copy-triplets.mjs` are **untouched**.
- **Embedding schema unchanged:** bge-small-en-v1.5 is 384-dim; the `FLOAT[384]` schema (`DEC-EMBED-010`) is not migrated. The reviewer confirms `schema.ts` is untouched **unless** `DEC-IRT-ATOM-NAMING-001 == C` was chosen, in which case the `npm_aliases` field addition is the *only* schema delta and is independently `approve`-gated.

### 6.4 Required integration points

- `packages/seeds/src/blocks/` — new atom directories slot in alphabetically; `seedRegistry` enumeration covers them.
- `packages/registry/test/discovery-benchmark/corpus.json` — new query entries, one per Slice 1 atom, `source: "seed-derived"`, with `expectedAtomName` set to the new atom's directory name and `expectedAtom: null` (resolved at test time, per the existing corpus convention). Each new entry MUST be assigned a `category` and the per-category ≥8-entry / has-positive-and-negative invariants in `discovery-eval-full-corpus.test.ts` MUST still hold.
- `packages/seeds/src/seed.test.ts` — row-count assertion updated to the new total.
- `packages/seeds/src/index.ts` — re-export lines added **only if** another yakcc package imports the atom function directly (Slice 1: not required; the atoms are consumed via composition/registry, not direct import).

### 6.5 Forbidden shortcuts

- **No `any`** anywhere in `impl.ts` — the strict-subset validator must pass with zero violations. Typing escape hatches use `unknown` + caller-side cast, per `memoize/impl.ts`.
- **No vendoring the npm package's source.** Atoms are *re-implementations* of the behavior from the spec/RFC, not copy-pastes of `node_modules/validator/src/lib/isEmail.js`. The `@decision` annotation must state the behavioral reference (RFC 5321 for email, etc.), not "ported from validator."
- **No hardcoded `blockMerkleRoot` hashes** in `corpus.json` or tests — `expectedAtomName` resolution only.
- **No `tests.fast-check.ts` that asserts nothing** — the file follows the re-export-shell pattern, but the `spec.yak` `propertyTests` array MUST declare real, specific cases (not placeholder IDs).
- **No edits to `plumbing-globs.ts`, `copy-triplets.mjs`, `bootstrap.ts`, or `schema.ts`** (the last unless Option C, independently gated).
- **No new embedding provider, no schema-dimension change.**
- **No frequency-crawl data-engineering** smuggled into this slice — the lightweight §3.2 check is the bar; a real crawl is a separate WI.

### 6.6 Ready-for-Guardian definition (Slice 1)

Slice 1 is ready for Guardian when **all** of the following are simultaneously true on the current HEAD:

1. `pnpm --filter @yakcc/seeds build && pnpm --filter @yakcc/seeds typecheck && pnpm --filter @yakcc/seeds test` all green, with `seed.test.ts` asserting the new row count.
2. `pnpm --filter @yakcc/seeds strict-subset` reports zero violations across the new `impl.ts` files.
3. `pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts` infrastructure-correctness blocks green with the new corpus entries.
4. The semantic-provider full-corpus run (§6.2) was executed against a **present** `bootstrap/yakcc.registry.sqlite` with `DISCOVERY_EMBED_MODEL=Xenova/bge-small-en-v1.5`, the quality describe blocks **ran (not skipped)**, and the emitted baseline JSON shows, for **every** Slice 1 `validator`-family corpus entry, `top1Correct === true` AND `top1Score >= 0.70`. The reviewer pastes the relevant per-entry rows from the baseline JSON as evidence.
5. Every new `impl.ts` carries a `@decision` annotation block citing the behavioral reference and (per §3.2) why this binding was chosen.
6. `plumbing-globs.ts`, `copy-triplets.mjs`, `bootstrap.ts`, `schema.ts` are confirmed untouched (or, if `DEC-IRT-ATOM-NAMING-001 == C`, `schema.ts` carries *only* the `npm_aliases` field addition and that change passed its own `approve` gate).
7. New `@decision` IDs are recorded (see §8).

If criterion 4 cannot be met because the bootstrap registry is absent or the model cannot be fetched, the slice is **blocked**, not ready — the reviewer reports the blocker; it is not waved through on infrastructure-test-only evidence.

---

## 7. Scope Manifest — Slice 1 (validator family)

**Allowed paths (implementer may touch):**
- `packages/seeds/src/blocks/<validator-family-atom-dirs>/**` — new atom triplet directories (the `impl.ts`, `spec.yak`, `proof/manifest.json`, `proof/tests.fast-check.ts` for each).
- `packages/seeds/src/seed.test.ts` — row-count assertion update only.
- `packages/seeds/src/index.ts` — re-export additions, **only if** required by a direct importer (Slice 1: expected untouched).
- `packages/registry/test/discovery-benchmark/corpus.json` — new query entries for the new atoms.
- `plans/wi-510-shadow-npm-corpus.md` — this plan (status updates only).

**Required paths (implementer MUST modify):**
- `packages/seeds/src/blocks/<validator-family-atom-dirs>/**` — at minimum the `validator.isEmail` headline atom; per §3.1 also `isURL`, `isUUID`, `isAlphanumeric` behaviors.
- `packages/seeds/src/seed.test.ts` — the row count WILL change.
- `packages/registry/test/discovery-benchmark/corpus.json` — one entry per new atom.

**Forbidden touch points (must not change without re-approval):**
- `packages/cli/src/commands/plumbing-globs.ts`, `packages/seeds/src/_scripts/copy-triplets.mjs`, `packages/cli/src/commands/bootstrap.ts` — owned by PR #520; pattern globs already cover new atoms.
- `packages/registry/src/schema.ts`, `packages/registry/src/storage.ts`, `packages/registry/src/discovery-eval-helpers.ts`, `packages/registry/src/discovery-eval-full-corpus.test.ts` — the discovery-eval harness and registry schema are constitutional; Slice 1 *uses* them, does not modify them. (Exception: `schema.ts` `npm_aliases` field iff `DEC-IRT-ATOM-NAMING-001 == C`, independently `approve`-gated.)
- `packages/seeds/src/seed.ts`, `packages/seeds/src/index.ts` barrel mechanics, `packages/ir/src/**` (strict-subset validator, block parser).
- `packages/seeds/src/blocks/semver-component-parser/**` and all 25 other existing atoms — not modified.
- `MASTER_PLAN.md` — permanent sections untouched.
- `bootstrap/expected-roots.json` — regenerated by the bootstrap process, not hand-edited; if the seed atom count change shifts it, that regeneration is a Guardian-stage concern, not an implementer hand-edit.

**Expected state authorities touched:**
- **Seed atom corpus** — canonical authority: the `packages/seeds/src/blocks/` directory tree, enumerated by `seedRegistry()` in `seed.ts`. Slice 1 adds rows; it does not change the enumeration mechanism.
- **Discovery-eval query corpus** — canonical authority: `packages/registry/test/discovery-benchmark/corpus.json`, consumed by `discovery-eval-full-corpus.test.ts`. Slice 1 appends entries.
- **Registry block store** — canonical authority: the SQLite `blocks` + `contract_embeddings` tables via `storeBlock()`. Slice 1 touches this only *transitively* (the seed-load and the eval test write to in-memory / bootstrap registries); no direct schema or storage-code change.
- **Atom identity** — canonical authority: `blockMerkleRoot` derived by `parseBlockTriplet`/`blockMerkleRoot()`. Slice 1 produces new identities by adding triplets; it never writes a root directly.

---

## 8. Decision Log Entries (new — to be recorded at implementation)

| DEC-ID | Title | Rationale summary |
|--------|-------|-------------------|
| `DEC-WI510-SLICE-BY-FAMILY-001` | WI-510 sliced by npm package family, validators-first | Each family is an independently shippable PR; smallest-self-contained-first (validators) proves the authoring + eval loop before parallel fan-out. Validator is also the triad's named demo library, so Slice 1 doubles as the #512/#508 unblocker. |
| `DEC-WI510-HARVEST-LIGHTWEIGHT-001` | Lightweight per-function harvesting check, not a blocking GitHub crawl | A full frequency crawl is multi-day data engineering. The issue already enumerated the target set (the author did the triage). The `.d.ts`-surface + issue-anchor check (§3.2) is a fast, reproducible proxy; the per-atom `@decision` block is the durable harvest record. A real crawl, if wanted, is a separate parallel WI feeding future re-prioritization. |
| `DEC-WI510-ATOM-NAMING-INHERIT-001` | WI-510 atom naming inherits `DEC-IRT-ATOM-NAMING-001`; Slice 1 authored against Option B with a documented A/C migration path | `DEC-IRT-ATOM-NAMING-001` is the triad-level authority and is still unadjudicated (§5). WI-510 does not re-decide it; Slice 1 is built to be mechanically re-keyable if the operator picks A or C. |
| `DEC-WI510-EVAL-VIA-FULL-CORPUS-001` | `combinedScore >= 0.7` measured by extending `discovery-eval-full-corpus.test.ts` corpus.json with semantic-provider runs, not a new harness | The full-corpus eval already does exactly the needed thing: full registry + `findCandidatesByQuery` + semantic provider + `expectedAtomName` resolution. Reusing it avoids a parallel measurement authority (Sacred Practice #12). The `0.7` threshold is exactly the harness's `confident` band floor. |

These are recorded in the relevant `impl.ts` `@decision` blocks and, if the operator wants them in the project-level log, appended to `MASTER_PLAN.md` `## Decision Log` as a separate doc-only change — not part of a source slice.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| `combinedScore >= 0.7` not reached for a given atom because the `behavior` string is too terse or too jargon-heavy for bge-small-en-v1.5. | The `behavior` string is the embedding lever. Author it as natural prose describing *what the function does for the caller* (mirror the issue's own phrasings: "validate that a string is a well-formed email address"). If a specific atom still under-scores, that is a *corpus-authoring* fix (reword `behavior`), surfaced by the per-entry baseline JSON — not a harness change. |
| `bootstrap/yakcc.registry.sqlite` absent in the reviewer's environment → quality describe blocks skip silently → false "green." | Ready-for-Guardian criterion 4 explicitly requires the reviewer to confirm the blocks **ran**, with pasted per-entry evidence. A skipped quality block is a blocked slice, not a passed one. |
| bge-small-en-v1.5 model ID / Xenova mirror name is wrong → local provider fails to load. | §5 open question 1 asks the operator to confirm the exact model ID string to pin. Default assumption `Xenova/bge-small-en-v1.5`; if the operator's harness already pins a different MiniLM model and bge is a *change*, that is itself worth confirming before Slice 1. |
| `DEC-IRT-ATOM-NAMING-001 == C` lands mid-WI → schema change needed. | Slice 1 is Option-B-authored and re-keyable. The `npm_aliases` schema field, if chosen, is pulled into whichever slice first needs it as an independently `approve`-gated constitutional edit — it does not retroactively invalidate earlier slices' atoms (the field is additive). |
| New `corpus.json` entries violate the per-category invariants (`≥8 entries each`, `has positive and negative`) enforced by `discovery-eval-full-corpus.test.ts`. | Each new entry is assigned a `category` deliberately; the Evaluation Contract §6.1 makes the infrastructure-correctness test a required gate, so a violation fails the slice loudly. |
| Effectful atoms (`uuid.v4`, `debounce`, `pLimit`) tempt an implementer to fudge purity in `spec.yak`. | The `spec.yak` `effects` and `nonFunctional.purity` fields must be declared honestly (`semver-component-parser` shows the pure case; effectful atoms declare their effect). This is a forbidden-shortcut item in later slices' contracts. |

---

## 10. What This Plan Does NOT Cover (Non-Goals)

- **The import-intercept hook (#508 / triad P2b/P4).** WI-510 is supply-side only. It produces atoms; it does not make the hook fire on them.
- **The B10 bench (#512 / triad P1/P3/P5).** WI-510 produces the corpus B10 consumes; it does not run or build B10.
- **A real GitHub-corpus frequency crawl.** Explicitly deferred to a separate parallel WI (§3.2, `DEC-WI510-HARVEST-LIGHTWEIGHT-001`).
- **Schema migration for non-384-dim embedders.** bge-small-en-v1.5 is 384-dim; no migration. Larger models are out of scope.
- **Adjudicating `DEC-IRT-ATOM-NAMING-001` or the "top-20" ceiling.** Those are operator decisions, posted to #510.
- **Modifying the discovery-eval harness or registry schema/storage.** WI-510 *uses* the harness; the harness is constitutional.
