# Plan: shave/universalize whole-function preservation — fix store-side fragmentation root cause of #444/#523/#549

**Workflow:** `fix-549-shave-fragmentation`
**Goal:** `g-fix-549`
**Work item:** `wi-fix-549-plan`
**Branch:** `feature/fix-549-shave-fragmentation`
**Status:** plan-only WI (planner). Implementation lands as separate per-slice PRs.

**Closes:** #549 (also closes the residual of #444 / #523 on the store side that the P0–P2 query-enrichment slices intentionally did not touch).
**Cross-refs:**
- Sibling plans: `plans/wi-fix-523-query-enrich-helper.md` (the query-side Option C plan), `plans/wi-fix-494-twopass-nondeterm.md`.
- Merged P-slice PRs from #523: #532 (P0 — `queryIntentCardFromSource` + shared `source-extract`), #536 (P1a — `findCandidatesByQuery` migration), #538 (P1b — hooks-base query enrichment), #540 (P2 — MCP atom-lookup schema enrichment).
- Predecessor plan PR: #528 (plan for #523).
- Open issues: #444 (v0-release-smoke Step 9 round-trip retrieval), #502 (companion of #444), #523 (#444 residual), #535 (canonical query helper), #549 (THIS — store-side fragmentation root cause), #529 (paid B4 reruns deferred).
- Decisions: `DEC-EMBED-QUERY-ENRICH-HELPER-001` (query-side asymmetry resolution principle — store stays as-is on the field-coverage axis), `DEC-V2-GLUE-AWARE-SHAVE-001` (shave-what-shaves + glue framing — the basis for `decompose()`'s fragmentation), `DEC-INTENT-STATIC-001` (primary-declaration preference chain), `DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001` (per-leaf `extractIntent` in multi-leaf trees), `DEC-RECURSION-005` (`DidNotReachAtomError` is reviewer-gate failure).

---

## 1. Desired End State

A demonstrable, evidence-backed close-out of #549 with a single, scoped change inside `@yakcc/shave/universalize`. No threshold changes, no seed-atom removal, no query-side edits, no fixture changes.

- **v0-release-smoke Step 9 PASS** — the BMR atomized for `arrayMedian` in Step 8b reappears in the top-K of the Step 9 same-session enriched query (`combinedScore ≥ 0.70` CONFIDENT_THRESHOLD), deterministic across reruns. PASS observed on the **behavior-only** baseline (no query enrichment), proving the fix is store-side. PASS also observed with the merged P1b enrichment path (it should be strictly better, never worse).
- **B7-commit acceptance violations drop** — the committed darwin run currently records 20 `bmrInTopK: false` failures on utilities including `is-valid-ipv4`, `popcount`, etc. (`bench/B7-commit/results-darwin-2026-05-14-slice3.json:10409+`). Expected post-fix: a **measurable reduction**, with the goal of zero. The exact post-fix number is captured in P1 evidence; the gate is "strict reduction relative to slice 3", not "zero" (see OD-2).
- **No regression in the existing shave test suite.** Targeted re-run before/after of `packages/shave` and `packages/contracts` tests; specifically the 50+ `leafCount`/`maxDepth` assertions in `packages/shave/src/universalize/recursion.test.ts` (lines 48–78 already cover the "single function, atomic root" happy path that the fix relies on; lines 84–158 cover multi-statement / multi-if SourceFiles that the fix MUST NOT touch).
- **One new DEC** records the principle: `DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001`. Fragmentation under `DEC-V2-GLUE-AWARE-SHAVE-001` is correct for files that mix shaveable atoms with glue, but for a file that *is* a single typed exported function with a typed return annotation, preserving the whole function as one atom carries strictly more semantic signal (full signature + JSDoc summary) and is the round-trip-correct choice. This is a refinement, not a reversal, of `DEC-V2-GLUE-AWARE-SHAVE-001`.

**Out of scope:**
- Query-side changes — `DEC-EMBED-QUERY-ENRICH-HELPER-001` already landed (P0–P2); the query side is correct.
- Paid B4 reruns (deferred per #529).
- Smoke-harness fixture changes — `bench/v0-release-smoke/fixtures/novel-glue-flywheel.ts` is correct as written.
- Lowering Step 9's `combinedScore ≥ 0.70` CONFIDENT_THRESHOLD.
- Removing seed atoms from the scratch registry — the typed `arrayMedian` atom should outrank seed atoms once it has a real signature; if it does not, the gap is in the embedder/encoder, not in fragmentation, and the plan EXPLICITLY does not pursue seed-atom removal as a fix.
- Collapsing all `decompose()` outputs to single-atom — that would regress dozens of `recursion.test.ts` assertions and discard the glue-aware-shave value for genuinely multi-shaveable files.

---

## 2. Grounded Code Reading

This section cites the actual source surfaces (`path:line`) so successors can verify the analysis without re-reading every file.

### 2.1. `decompose()` — `packages/shave/src/universalize/recursion.ts:1147`

`decompose(source, registry, options)` builds a `RecursionTree` by parsing `source` into a ts-morph `SourceFile` (line 1156, `useInMemoryFileSystem:true`, no lib), then recursing top-down. The recursion at each node:

- **Lines 1208–1230** — call `isAtom(node, source, registry, options)`. If atomic AND no child matches the registry, emit an `AtomLeaf` and bottom out.
- **Lines 1232–1270** — otherwise, fetch `decomposableChildrenOf(node)`. Empty children + non-atomic = `DidNotReachAtomError` (special-cased for `CallExpression` to emit a verbatim atom under `DEC-V2-SHAVE-CALLEEXPRESSION-GLUE-001`).
- **Lines 1272–1285** — non-empty children → recurse into each, emit a `BranchNode`. **This is the fragmentation path.**

### 2.2. `isAtom()` — `packages/shave/src/universalize/atom-test.ts:161`

Two criteria, applied in order:
- **Lines 167–177** — control-flow boundary count > `maxControlFlowBoundaries` (default `1`, line 31, `DEFAULT_MAX_CF_BOUNDARIES = 1`) ⇒ `isAtom: false, reason: "too-many-cf-boundaries"`.
- **Lines 180–216** — for each top-level statement child, query the registry by `canonicalAstHash`. A hit ⇒ `isAtom: false, reason: "contains-known-primitive"`.

`CF_BOUNDARY_KINDS` (line 42) includes `IfStatement`, four loop kinds, `SwitchStatement`, `TryStatement`, **and `ConditionalExpression`** (the ternary `?:`).

`countControlFlowBoundaries` (line 65) counts the root itself **plus all descendants**. It does not stop at function boundaries. This is why a SourceFile containing a single FunctionDeclaration whose body has 2 CF nodes counts 2 CF boundaries at the SourceFile level.

### 2.3. `decomposableChildrenOf()` — `packages/shave/src/universalize/recursion.ts:726`

- **Lines 729–732** — `SourceFile` → `getStatements()`.
- **Lines 740–756** — `FunctionDeclaration` / `FunctionExpression` / `ArrowFunction` / `MethodDeclaration` / `Constructor` / `GetAccessor` / `SetAccessor`: if body is a `Block`, return `body.getStatements()`. **This is the FunctionDeclaration → body-statements descent that fragments arrayMedian.**

### 2.4. `staticExtract()` — `packages/shave/src/intent/static-extract.ts:106`

- **Line 119** — `pickPrimaryDeclaration(sourceFile)` on the per-fragment source.
- **Lines 122–136** — if `primary === undefined`, return the source-fragment SpecYak:
  ```
  { schemaVersion:1, behavior:"source fragment (N statements, M bytes)",
    inputs:[], outputs:[], preconditions:[], postconditions:[], notes:[], ...envelope }
  ```
  **This is the empty-signature record that propagates to the registry and breaks round-trip retrieval.**

### 2.5. `pickPrimaryDeclaration()` — `packages/contracts/src/source-pick.ts:68`

(Factored from shave under P0 of #523 / `DEC-EMBED-QUERY-ENRICH-HELPER-001`.) Six-priority preference chain. The relevant prefix:
- P1 (lines 72–86) — `export default function|arrow`.
- P2 (lines 94–107) — first **exported** `FunctionDeclaration` or exported `VariableStatement` with arrow/function initializer.
- P3 (lines 112–116) — first non-exported `FunctionDeclaration`.
- ...returns `undefined` at P6 (line 146).

Per-statement source fragments (e.g. `return median.toFixed(1);`) have no exported function declaration ⇒ P6 ⇒ `undefined`.

### 2.6. The smoke Step 8b → atomize call path

`bench/v0-release-smoke/smoke.mjs:678` (Step 8b) calls:
```
executeRegistryQueryWithSubstitution(registry, ctx, code, "Write", opts)
```
from `@yakcc/hooks-base`. That module's `atomize.ts` (P3's traced call site) eventually delegates to `@yakcc/shave/universalize({persist:true, ...})` per `DEC-V2-ATOMIZE-DELEGATES-UNIVERSALIZE-001` (lifted in WI-424). The smoke does NOT call `decompose()` directly.

### 2.7. The multi-leaf intent-attachment loop — `packages/shave/src/index.ts:541-572`

The decisive code path for #549:

- **Line 481** — `extractIntent(candidate.source, …)` runs once on the FULL source. This card has the correct `arrayMedian` signature.
- **Line 492** — `decompose(candidate.source, registry, …)` runs and shatters arrayMedian into 4 leaves.
- **Lines 524–540** — `tree.leafCount === 1 && plan.entries.length === 1`: attach the root `intentCard`. **This is the single-leaf good path.** arrayMedian does not hit it.
- **Lines 541–572** — multi-leaf branch: **per-leaf** `extractIntent(entry.source, …)` (line 551) is called on each statement-source fragment. Inside `extractIntent`, the static strategy calls `staticExtract(unitSource, …)` (intent/extract.ts:205), which calls `pickPrimaryDeclaration` on the per-fragment ts-morph parse, returns `undefined`, emits empty-signature fragments. Each shard is persisted as a registry block.

### 2.8. The behavior-only baseline

P3's earlier B4-tokens / B5-discovery work showed seed atoms (Step 7's parsing primitives) scoring `0.81–0.82` on `"compute median"` vs. the **fragment** atoms scoring `~0.77`. Even WITHOUT query enrichment, the fragmented arrayMedian loses on cosine — because each fragment's embedded behavior text is "source fragment (1 statements, 28 bytes)" rather than the function's JSDoc summary. P0–P2 query enrichment closes the asymmetry on the *query* side; #549 closes it on the *store* side. Both fixes together are strictly better than either alone, and either alone is insufficient.

---

## 3. Problem Decomposition

### 3.1. Why does `decompose()` fragment arrayMedian today?

The fixture is a single exported function. By the numbers:

- `arrayMedian` body has:
  - `if (values.length === 0) return NaN;` → 1 `IfStatement`
  - `sorted.length % 2 === 0 ? … : sorted[mid]!` → 1 `ConditionalExpression`
  - Total = **2 CF boundaries**.
- `DEFAULT_MAX_CF_BOUNDARIES = 1` (atom-test.ts:31).
- `countControlFlowBoundaries` walks **all descendants** — it does not stop at function-scope boundaries.
- `SourceFile` containing `arrayMedian` therefore counts 2 CF descendants → non-atomic at the SourceFile level.
- `FunctionDeclaration` body has 2 CF descendants → also non-atomic.
- `decomposableChildrenOf(FunctionDeclaration)` (recursion.ts:740–756) returns the body block's 4 statements.
- Each statement has ≤ 1 CF → atomic leaves.
- Result: 4 `AtomLeaf` entries → multi-leaf branch in `universalize()` → 4 per-leaf `extractIntent` calls → 4 empty-signature SpecYaks persisted.

### 3.2. Why was this the right default in the first place?

`DEC-V2-GLUE-AWARE-SHAVE-001` (MASTER_PLAN.md:2370) is explicit: real codebases mix shaveable atoms with glue. The slicer's job is to find the *maximal* shaveable subgraphs and emit verbatim `GlueLeafEntry` for the rest, not to insist the whole file be one shape. `DEC-CLOSER-CONSUMER-FIX-001` reinforces this — when shape mismatches surface, the routing principle is "fix the consumer, not filter the corpus." Both DECs are correct AND the current behavior is correct **for files that genuinely have multiple shaveable atoms plus glue.**

The arrayMedian fixture is a degenerate case of the glue-aware rule: a single typed exported function with a typed return annotation and a non-empty JSDoc summary. Under that shape, *the whole function IS the maximal shaveable subgraph* — there is no glue to carve away, and fragmentation strictly destroys signal. The fix is therefore a **shape-conditioned guard** on top of the existing CF-boundary recursion: when the source is "single typed exported function", short-circuit before fragmentation; otherwise proceed unchanged.

### 3.3. The boundary the predicate must encode

The plan adopts the following AST predicate as the precise boundary (the **single-typed-exported-function predicate**, "STEF" for short):

- `SourceFile.getStatements()` contains exactly **one** top-level function-like declaration that meets ALL of:
  - `Node.isFunctionDeclaration(stmt)` returns `true` **OR** `Node.isVariableStatement(stmt)` with exactly one declarator whose initializer is `Node.isArrowFunction(...)` or `Node.isFunctionExpression(...)`.
  - `stmt.hasModifier(SyntaxKind.ExportKeyword)` returns `true` (catches the `export function` shape used by smoke + B7 fixtures and the bulk of real yakcc utilities).
  - The function-like has at least one typed parameter (`param.getTypeNode() !== undefined` for all params, OR zero params permitted — see OD-1).
  - The function-like has a typed return annotation (`fn.getReturnTypeNode() !== undefined`).
  - The function-like (or its enclosing `VariableStatement` for arrow-const) has at least one JSDoc block (`node.getJsDocs().length > 0`).
- All OTHER `SourceFile.getStatements()` entries are non-executing top-level forms that carry no shaveable behavior, restricted to: `ImportDeclaration`, `ExportDeclaration` (re-exports without value semantics), `TypeAliasDeclaration`, `InterfaceDeclaration`. Anything else (a second function, a const initializer, a class, an expression statement) disqualifies the file from STEF.
- The function's body is not empty (`body !== undefined && body.getKind() === SyntaxKind.Block && body.getStatements().length > 0`).

This predicate is intentionally narrow. It is the smallest closed shape under which the answer "preserve the whole function as one atom" is **unambiguously** the round-trip-correct call. Anything outside STEF continues to follow the glue-aware fragmentation path.

OD-1 below records the exceptions the operator must adjudicate.

---

## 4. Option Analysis

Three candidate paths. The recommendation is **Option A** for the v1 fix; **Option C** is the eventual right shape and is recorded so a future slice can extend the fix without re-litigation.

### Option A — Whole-function preservation in `decompose()`

Add a STEF fast-path inside `decompose()` (recursion.ts:1147), evaluated **after** the `Project` / `SourceFile` is constructed (line 1158) and **before** the `recurse(file, 0)` call (line 1288). If the parsed `SourceFile` matches STEF (§3.3), return a single-leaf `RecursionTree` whose root is an `AtomLeaf` covering the entire source range, with `canonicalAstHash` computed over the full source and `atomTest = { isAtom:true, reason:"single-typed-exported-function", controlFlowBoundaryCount: <observed> }`.

**Why inside `decompose()`, not inside `isAtom()`:** STEF is a *whole-file* predicate, not a *node* predicate. `isAtom()` is correctly per-node; pushing STEF into it would conflate two distinct gating concerns and force a new `AtomTestResult.reason` that misrepresents the actual rationale (it is not "the node is atomic"; it is "this file's shape is degenerate-single-function, so we preserve it whole regardless of inner CF count").

**Effect on the rest of the pipeline:**
- `universalize()` (index.ts:489) calls `decompose()`. Result: `tree.leafCount === 1`, `plan.entries.length === 1`. The single-leaf good path at index.ts:524–540 fires. The root `intentCard` extracted at line 481 (which has the real signature) is attached to the lone `NovelGlueEntry`. The empty-signature multi-leaf branch (lines 541–572) is bypassed for STEF files.
- `slice()` (called at index.ts:495) operates on a single-leaf tree → emits one `SlicePlanEntry`. No new code paths to teach.
- The persist step (index.ts:609–) walks the single entry and calls `storeBlock` once with the rich SpecYak. The merkleRoot returned is the BMR that Step 9 must see in top-K.

**Pros:**
- Targeted; one ~30-line guard inside `decompose()`. No new module, no new public surface, no schema changes.
- Closes #549, #444 (the smoke Step 9 failure mode), and reduces B7-commit violations all from one site.
- Backwards-compatible. STEF is narrow enough that existing `recursion.test.ts` happy-path tests at lines 48–78 are already STEF-shaped and remain single-leaf (they already pass because the inner CF count is 0). The multi-statement / multi-if tests at lines 84–158 are NOT STEF (multiple top-level statements) and remain multi-leaf.
- Aligns with `DEC-V2-GLUE-AWARE-SHAVE-001`: STEF is the degenerate case where the maximal shaveable subgraph IS the whole file.

**Cons:**
- Edge cases around the predicate (OD-1).
- Does not address callers that route around `decompose()` directly (none in production today, but `bench/B4-tokens` and follow-on benches might).

**Verdict:** Recommended for v1.

### Option B — Atomize routing change (smoke harness side)

Have Step 8b's `executeRegistryQueryWithSubstitution` call path (in `@yakcc/hooks-base/atomize.ts`) inspect the input source first and, when STEF holds, bypass `decompose()` entirely — emitting a single `SlicePlanEntry` constructed directly from `specFromIntent(intentCard)`.

**Pros:**
- Smaller blast radius inside `@yakcc/shave`. Shave's `decompose()` stays untouched.

**Cons:**
- **Does not fix B7-commit's 20 violations.** B7 atomizes via the same `executeRegistryQueryWithSubstitution` path in real time, but the violations are not exclusively caused by smoke; the bench harness is a different caller and the routing logic would have to be duplicated there to fix B7. Duplication violates Sacred Practice #12 (single source of truth).
- "How does the caller know to route differently?" requires the caller to re-implement STEF detection. The shave package is the right authority for "what shape is shaveable as one atom?" — pushing that knowledge to callers creates a parallel authority on shape detection.
- It bypasses `decompose()`'s atom-leaf registry-collision check (atom-test.ts:180–216). For STEF files whose body is exactly a known primitive in the registry, we WANT decompose to detect that and return a `PointerEntry` rather than re-store. Option B loses that.

**Verdict:** Rejected as a standalone fix. May reappear as an opt-in routing override in Option C.

### Option C — Hybrid (A + caller opt-in)

Option A's `decompose()` STEF guard, plus a new option flag on `universalize({preserveSingleFunction:true, ...})` and on the hook entry point so future callers with richer context can request preservation explicitly for shapes that DON'T match STEF (e.g., an un-exported single function, or a single function without JSDoc).

**Pros:**
- Eventual right shape. Closes #549 today AND gives future callers a documented escape hatch.
- Keeps Option A's authority in shave while letting the harness express intent.

**Cons:**
- Larger scope: new option threading through `universalize()` → `decompose()` → `RecursionOptions`. Surface area to test (the option matrix expands).
- Pushes the decision of "when SHOULD preservation fire?" to callers, which re-introduces the routing-authority ambiguity Option B has.

**Verdict:** Recommended as a follow-up WI if Option A's STEF predicate proves too narrow in practice (e.g., #549's reopen with a new fixture).

### Recommendation

**Adopt Option A as the v1 fix.** Land Option C as a follow-up only if measured failures recur with shapes that STEF does not catch.

---

## 5. Implementation Slices

Two slices. P0 is the source change; P1 is the empirical verification on the load-bearing harnesses. Both slices are guardian-bound and carry full Evaluation Contracts and Scope Manifests below.

### 5.1. P0 — STEF predicate + whole-function preservation in `decompose()`

**Goal:** introduce the STEF predicate as a fast-path inside `decompose()` so STEF files yield a single-leaf `RecursionTree` whose lone `AtomLeaf` covers the entire source range. Cover with unit + property tests in `packages/shave`. Run the full `packages/shave` + `packages/contracts` test suites and confirm zero regressions.

**Scope Manifest:**
- **Allowed paths:**
  - `packages/shave/src/universalize/recursion.ts`
  - `packages/shave/src/universalize/recursion.test.ts`
  - `packages/shave/src/universalize/recursion.props.ts`
  - `packages/shave/src/universalize/recursion.props.test.ts`
  - `packages/shave/src/universalize/stef.ts` (new — extracted predicate; optional if predicate is inlined)
  - `packages/shave/src/universalize/stef.test.ts` (new)
  - `packages/shave/src/universalize/stef.props.ts` (new)
  - `packages/shave/src/universalize/stef.props.test.ts` (new)
  - `MASTER_PLAN.md` (new DEC row only; no edits to permanent sections)
- **Required paths:**
  - `packages/shave/src/universalize/recursion.ts` (the actual fix site)
  - At least one new test file asserting STEF preservation and at least one negative test asserting non-STEF files still fragment.
- **Forbidden paths:** every package outside `packages/shave/src/universalize/`. In particular: **no edits to `packages/contracts/src/source-extract.ts`, `packages/contracts/src/source-pick.ts`, or `packages/shave/src/intent/static-extract.ts`** — those are the shared primary-declaration / signature-extraction primitives factored under P0 of #523 (DEC-EMBED-QUERY-ENRICH-HELPER-001) and they are correct as-is. No edits to `packages/shave/src/index.ts` (the universalize entry point is unchanged — it benefits from the new behavior automatically because `decompose()` returns single-leaf for STEF). No bench/, no .github/, no examples/.
- **State authorities touched:**
  - **Algorithmic authority on "is this file a single shaveable atom?"** — `packages/shave/src/universalize` (new STEF predicate). This is a new authority, not a parallel one: `isAtom()` answers "is this node atomic?" (per-node); STEF answers "is this file a single-atom shape?" (per-SourceFile). They are orthogonal.
  - **Registry store path** is unaffected — `storeBlock`'s contract is identical; what changes is the SpecYak it receives (rich vs. fragmented).

**Evaluation Contract (P0):**
- **Required tests (must be added and passing):**
  - `recursion.test.ts` (or new `stef.test.ts`):
    - "decompose preserves STEF source as a single AtomLeaf": fixture identical to `bench/v0-release-smoke/fixtures/novel-glue-flywheel.ts` → `tree.leafCount === 1`, `tree.root.kind === "atom"`, `tree.root.sourceRange.start === 0`, `tree.root.sourceRange.end === source.length`, `tree.root.atomTest.isAtom === true`, `tree.root.atomTest.reason === "single-typed-exported-function"`.
    - "decompose does NOT preserve a multi-function file": a source with two `export function foo(...) {...}` declarations → `tree.leafCount > 1` (current fragmentation behavior preserved).
    - "decompose does NOT preserve a function without JSDoc": `export function bar(x: number): number { if (x>0) return x; return -x; }` (typed but no JSDoc) → STEF declines, multi-leaf behavior preserved (regression test on §3.3 boundary).
    - "decompose does NOT preserve a function without typed return": `export function baz(x: number) { if (x>0) return x; return -x; }` (no return type) → STEF declines.
    - "decompose preserves arrow-const STEF": `/** … */ export const f = (x: number): number => x>0 ? x : -x;` → single leaf.
    - "decompose preserves STEF alongside type/import noise": same arrayMedian with a leading `import` and a trailing `export type Foo = number;` → single leaf covering the function only? NO — STEF is a *whole-file* predicate and the type/import noise is permitted per §3.3 "non-executing top-level forms"; the resulting AtomLeaf covers the entire SourceFile range. Asserts that the file remains single-leaf.
  - `recursion.props.test.ts`: idempotence property — re-running `decompose()` on the same STEF source produces an identical `canonicalAstHash`.
- **Required real-path checks:**
  - `pnpm -F @yakcc/shave test` → all tests pass, including the existing `leafCount`/`maxDepth` assertions (no regressions on the 50+ existing assertions in `recursion.test.ts`).
  - `pnpm -F @yakcc/contracts test` → all tests pass (no `source-extract` / `source-pick` regressions).
  - `pnpm -r build` (or the workspace equivalent) → clean type-check on the new code.
- **Required authority invariants:**
  - `DEC-V2-GLUE-AWARE-SHAVE-001` is refined, not reversed: the change applies ONLY to STEF-shaped files; all other shapes continue to fragment per the existing algorithm.
  - `isAtom()` is not modified. STEF is a SourceFile-level predicate that runs in `decompose()` before `recurse(file, 0)`.
  - `pickPrimaryDeclaration` and `extractSignatureFromNode` are not modified. The shared P0 primitives under `DEC-EMBED-QUERY-ENRICH-HELPER-001` stay byte-identical.
  - `RecursionTree` shape (`leafCount`, `maxDepth`, `root`) is unchanged.
- **Required integration points (read-only or no-touch):**
  - `packages/shave/src/index.ts:489–572` — the single-leaf branch (lines 524–540) is the path STEF files take post-fix. No code change needed there; behavior change is mediated entirely through `decompose()`'s return shape.
  - `packages/shave/src/intent/static-extract.ts:106` — receives the FULL source string when STEF fires, so `pickPrimaryDeclaration` finds the exported function declaration at priority 2, returning a rich SpecYak.
  - `packages/contracts/src/source-extract.ts` — the signature extraction it provides is invoked with the full source under STEF, so all `inputs`/`outputs`/`behavior`/`notes` are populated.
- **Forbidden shortcuts:**
  - Do NOT modify `DEFAULT_MAX_CF_BOUNDARIES` (atom-test.ts:31). That would affect every node test, not just STEF files.
  - Do NOT change `countControlFlowBoundaries` to stop at function boundaries — that would affect `isAtom()` semantics for embedded function expressions inside non-STEF files.
  - Do NOT collapse all `FunctionDeclaration` recursion to single-leaf. The STEF predicate REQUIRES the whole-file shape.
  - Do NOT delete or weaken any existing `recursion.test.ts` assertion. If an existing assertion would regress, treat it as a sign the STEF predicate is too wide and tighten it (per OD-3, default: tighten).
  - Do NOT touch any path under `packages/contracts/` or `packages/hooks-base/` (the merged P0–P2 query-side work is correct; this WI fixes the orthogonal store-side gap).
- **Ready-for-guardian definition:** all required tests added and passing; all required real-path checks green; new `DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001` row appended to MASTER_PLAN.md Decision Log; commit message references #549, #444, #523, and cites both `DEC-V2-GLUE-AWARE-SHAVE-001` and `DEC-EMBED-QUERY-ENRICH-HELPER-001` so the relationship is permanent in git history.

### 5.2. P1 — Empirical verification: v0-smoke Step 9 + B7-commit

**Goal:** observe Step 9 PASS and B7-commit acceptance violations strictly reduced (target 0). No source changes; this slice is bench-only and produces evidence artifacts.

**Scope Manifest:**
- **Allowed paths:** `tmp/wi-fix-549-evidence/**`, `bench/B7-commit/results-<platform>-<date>-p1.json` (new run artifact only; no harness edits), `bench/v0-release-smoke/results-<platform>-<date>-p1.txt` (run log only).
- **Required paths:** at minimum one new B7-commit results file capturing post-fix metrics, and a Step 9 run log showing PASS.
- **Forbidden paths:** `packages/**` (no source edits in P1), `bench/B7-commit/PLAN.md`, `bench/B7-commit/corpus-spec.json`, `bench/B7-commit/harness/**` (no harness changes), `bench/v0-release-smoke/smoke.mjs` (no smoke edits), `bench/v0-release-smoke/fixtures/**`, MASTER_PLAN.md (unless adding evidence references to an existing initiative section is required), `examples/**`, `.github/**`.
- **State authorities touched:** none — read-only re-runs of existing harnesses.

**Evaluation Contract (P1):**
- **Required real-path checks:**
  - `pnpm -F @yakcc/v0-release-smoke smoke` (or the documented invocation) → Step 9 prints PASS with `bmrInTopK === true` and `combinedScore >= 0.70`.
  - `pnpm -F @yakcc/b7-commit bench` (or documented invocation) on darwin slice 3 corpus → output JSON `failures` array length is strictly less than the 20 entries currently committed at `bench/B7-commit/results-darwin-2026-05-14-slice3.json:10409`. Target: 0. Acceptable: any number <20 documented with the post-fix metric and a per-utility delta table.
  - `pnpm -F @yakcc/shave test` and `pnpm -F @yakcc/contracts test` → still passing on the same head SHA as P0's landing.
- **Required evidence (in `tmp/wi-fix-549-evidence/`):**
  - `step9-before.txt` and `step9-after.txt` — the smoke output capture for the same fixture on pre-fix and post-fix HEADs (clearly labelled with SHAs).
  - `b7-delta-darwin.md` — per-utility table: utility name, pre-fix `bmrInTopK`, pre-fix `combinedScore`, post-fix `bmrInTopK`, post-fix `combinedScore`, post-fix `candidateCount`. Source of pre-fix numbers: `results-darwin-2026-05-14-slice3.json`. Source of post-fix: the new results file.
  - `summary.md` — one paragraph: pre-fix and post-fix headline numbers, the deltas, and any utility that did NOT improve (with a hypothesis for why — likely STEF-decline because the source has multiple exports or no JSDoc).
- **Required authority invariants:**
  - No threshold edits in P1. Step 9 PASS must be against the existing `combinedScore >= 0.70` CONFIDENT_THRESHOLD.
  - No fixture edits in P1.
  - No seed-atom removal in P1.
- **Forbidden shortcuts:**
  - Do NOT re-bootstrap the registry to "fresh state" to make numbers look better — the in-test scratch registry that v0-smoke uses (Step 8b → Step 9) is the load-bearing path; B7's own corpus + workspace are the load-bearing path for that bench. Both must show improvement from the SAME store-side fix without any harness-level rigging.
  - Do NOT silently filter B7 failures whose root cause is unrelated to fragmentation. If a residual failure is not STEF-shaped (e.g., the utility has multiple exports), document it in `summary.md` as out-of-scope-for-this-fix rather than hiding it. The acceptance gate is "fewer", not "zero with unrelated failures filtered out."
- **Ready-for-guardian definition:** Step 9 PASS captured; B7 results JSON committed for at least darwin with strict reduction vs. slice 3 baseline; `summary.md` posted; if any utility regressed (BMR was in top-K pre-fix and is not post-fix — the inverse outcome), that utility's diagnostic captured before landing. Inverse outcomes block landing pending operator review.

---

## 6. Risk Register

| ID | Risk | Likelihood | Severity | Specific test/source surface | Mitigation |
|----|------|-----------|----------|------------------------------|------------|
| R1 | One of the existing `recursion.test.ts` assertions regresses because the test source happens to be STEF-shaped. | Low | High | `recursion.test.ts:48–78` (single-function happy path) is ALREADY single-leaf via the existing atomic-root path; STEF only widens the set of cases that reach single-leaf, so these assertions strengthen rather than break. `recursion.test.ts:84–158` use multi-statement SourceFiles (multiple `declare const` + `if`-statements) — they are NOT STEF (multiple top-level statements, none of which is a function-like) and remain multi-leaf. The risk is concentrated in `recursion.test.ts:285–321` ("registry-driven branch") and `recursion.test.ts:358–451` ("loop with escaping control flow"), which use single-`function`-decl sources. Verify these test sources fail at least one STEF clause (e.g., no JSDoc, or no typed return) before landing P0. If any of them ARE STEF-shaped, update the assertion to reflect the new correct semantics (per OD-3) AND document the change in the test's @decision annotation. |
| R2 | B7-commit violations do not drop because the failing utilities are not STEF-shaped (multiple exports / no JSDoc / no typed return). | Medium | Medium | `bench/B7-commit/corpus/**` — audit the 20 failing utilities under `failures[*].utilityName` (e.g., `is-valid-ipv4`, `popcount`). For each, inspect the source and record whether it matches STEF. If <50% of failures are STEF-shaped, the headline "B7 reduction" claim is weakened and the plan should record that residual non-STEF failures are out of scope for this WI and likely require Option C (caller opt-in) or a STEF widening in a follow-up. | P1's `summary.md` must enumerate the per-utility STEF status, not just the aggregate delta. |
| R3 | The STEF AST predicate is ambiguous on a real edge case the plan didn't anticipate. | Medium | Low | OD-1 below. Examples: generic functions (`function f<T>(x: T): T`), overloaded function declarations, default exports, exported `function*` generators, exported async functions, methods of an exported class. | The default predicate (§3.3) requires `export` + typed params + typed return + JSDoc + FunctionDeclaration|VariableStatement-with-arrow-or-function-expression. Generators and async functions count as `FunctionDeclaration` (ts-morph) and pass. Overloads have multiple declarations; the predicate counts top-level statements, so two `export function foo(…)` overload signatures + one implementation is THREE top-level statements ⇒ STEF declines. That is the conservative outcome. Document this conservativeness in the new DEC. |
| R4 | A STEF file that contains a CallExpression body matching `DEC-V2-SHAVE-CALLEEXPRESSION-GLUE-001` (recursion.ts:1235) is forced into single-leaf, bypassing the explicit verbatim-CallExpression-glue handling. | Low | Medium | recursion.ts:1235–1261. The CallExpression-glue path runs inside `recurse()` for children with `kind === SyntaxKind.CallExpression`. Under STEF, `recurse` is never called — the whole SourceFile is one leaf. | Verify that under STEF, the AtomLeaf covers the function declaration, which transitively contains any CallExpression. The CallExpression-glue case targets *bare* CallExpressions at non-leaf branches; under STEF the function declaration IS the leaf, so no bare CallExpression is exposed. Add a test fixture: STEF function whose body is a single CallExpression statement → expect single leaf at the SourceFile level (not at the CallExpression level). |
| R5 | The new DEC partially supersedes `DEC-V2-GLUE-AWARE-SHAVE-001` and a future contributor reads them as conflicting. | Low | Low | MASTER_PLAN.md:2370. | The new DEC's text MUST explicitly say "refinement, not reversal" and cite `DEC-V2-GLUE-AWARE-SHAVE-001` by ID; supersession-or-refinement language must be in the DEC body. |
| R6 | `canonicalAstHash` for a STEF whole-file leaf collides with the inner-FunctionDeclaration hash that a non-STEF caller might emit. | Low | High | recursion.ts:1181 (`safeCanonicalAstHash`) — the leaf hash is computed over the SourceFile's full source under STEF. Under non-STEF, the same function's hash would be computed over the FunctionDeclaration's range only. | If the SourceFile under STEF contains ONLY the function declaration (no imports/types), the two ranges are byte-equal and the hashes match — which is desirable (round-trip identity). If the SourceFile contains the function plus imports/type aliases, the STEF leaf's range covers the whole file, including the noise, and the hash differs from a bare-function hash. Document this: STEF preserves the file as a whole, not just the function; downstream consumers who index the file via STEF and look up the function via a stripped form get different hashes. The fix is that registry consumers should not perform such mixed lookups; if a future bench shows otherwise, this is the trigger to escalate. |

---

## 7. Operator Decision Boundaries

**OD-1: STEF predicate boundary.**
Should the STEF predicate require an `export` modifier? Should it require a non-empty JSDoc? Should it require typed parameters (or only a typed return)? Should arrow-const declarations qualify?

- **Default (proposed):** YES to all four. The conservative predicate of §3.3 is: `export` modifier + at least one JSDoc block + typed return annotation + every parameter has a type annotation (or the function has zero parameters) + the file's only other top-level statements are imports / type-only / export-type-only.
- **Alternatives:** drop the JSDoc requirement (would catch more files, including some that today produce `behavior:"signature string"` fallbacks via `static-extract.ts:142` and would still be a strict improvement over `behavior:"source fragment (N statements, M bytes)"`); drop the `export` requirement (would catch utility modules with helper non-exported functions but risks misclassifying internal helpers as primary).
- **Operator call required before P0 lands.** The plan defaults stand unless the operator chooses otherwise; if defaults stand, no explicit OD-1 resolution is needed.

**OD-2: B7 acceptance gate.**
Is the goal zero post-fix B7-commit acceptance violations, or strictly fewer than the slice-3 darwin baseline of 20?

- **Default (proposed):** strictly fewer is the gate; zero is the ambition. Some of the 20 failing utilities may have shapes the conservative STEF predicate does not catch (multiple exports / no JSDoc); those residual failures are out-of-scope for this WI and would require a follow-up (Option C or STEF widening).
- **Operator may** elect to require zero and block landing P1 until either every failing utility is STEF-shaped OR the predicate is widened (which re-opens OD-1).
- **Operator call required before P1 reports ready-for-guardian.**

**OD-3: Test-conflict resolution.**
If an existing `recursion.test.ts` assertion would regress under the new STEF behavior (i.e., the test source is unexpectedly STEF-shaped and the test expected `leafCount > 1`), do we update the test (it reflected the old wrong semantics) or tighten the STEF predicate (it was too wide)?

- **Default (proposed):** update the test if and only if the new behavior is unambiguously the more correct round-trip output for the same source AND no other test breaks; otherwise tighten the predicate. The bias is toward tightening — the STEF predicate is intentionally narrow, and a single surprising regression suggests the predicate is one clause short.
- **Operator call required only if any existing assertion actually regresses.** Likelihood is low (R1); P0's pre-landing must enumerate any affected tests in the PR description.

---

## 8. Out of Scope (Explicit Restatement)

- **Query-side changes.** P0–P2 of #523 already landed (`DEC-EMBED-QUERY-ENRICH-HELPER-001`). The query helpers, hook enrichment, and MCP schema widening are correct.
- **Paid B4-tokens reruns** (deferred per #529). P1 does NOT include a B4 rerun.
- **Smoke fixture edits.** `bench/v0-release-smoke/fixtures/novel-glue-flywheel.ts` is the load-bearing canonical fixture and is not edited.
- **Threshold edits.** Step 9's `combinedScore >= 0.70` CONFIDENT_THRESHOLD stands.
- **Seed-atom culling.** The scratch registry's seed atoms (Step 7 parsing primitives) remain in the registry. The post-fix prediction is that the typed `arrayMedian` atom out-ranks the seeds; if that prediction fails, the gap is in the embedder/encoder, not in fragmentation, and the plan EXPLICITLY does not pursue seed-atom culling as a fix.
- **Hook routing changes.** `executeRegistryQueryWithSubstitution` is unchanged. The fix is entirely inside `@yakcc/shave/universalize/recursion.ts`.
- **MASTER_PLAN.md permanent-section edits.** P0 may append one new DEC row to the Decision Log table; it must not touch Identity, Architecture, Principles, or existing Decision-Log rows.

---

## 9. Linear Order of Operations

For the next orchestrator / planner instance:

1. **Planner closes this plan** (this document). Verdict: `next_work_item` → guardian provision for P0.
2. **Guardian (provision)** opens a fresh worktree for `wi-fix-549-p0-stef-predicate` from `feature/fix-549-shave-fragmentation` or directly from a clean main, depending on whether this plan PR has landed. Issues the implementer lease with the P0 Scope Manifest from §5.1 above (sync via `cc-policy workflow scope-sync`).
3. **Implementer (P0)** lands the STEF predicate in `packages/shave/src/universalize/recursion.ts` plus tests. Runs `pnpm -F @yakcc/shave test` and `pnpm -F @yakcc/contracts test`. Appends `DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001` to the MASTER_PLAN Decision Log. Codex critic verifies STEF behavior.
4. **Reviewer (P0)** verifies the Evaluation Contract from §5.1 line-by-line, captures `pnpm -F @yakcc/shave test` and `pnpm -F @yakcc/contracts test` output, and confirms no permanent-section edits. Emits `REVIEW_VERDICT=ready_for_guardian` (or `needs_changes`/`blocked_by_plan`).
5. **Guardian (land)** commits + merges P0 into main (no force push, no history rewrite). Single small PR.
6. **Planner continuation** (this same plan) dispatches Guardian provision for P1 against post-P0 main.
7. **Implementer (P1)** runs v0-smoke Step 9 and B7-commit, captures evidence into `tmp/wi-fix-549-evidence/`, writes `summary.md` and the delta table.
8. **Reviewer (P1)** verifies the Evaluation Contract from §5.2, including the strict-reduction check on B7 darwin slice-3 baseline.
9. **Guardian (land)** commits the evidence files (no source changes in P1). Closes #549; cross-references #444, #523 in the close-out commit and on GitHub.
10. **Planner verdict after P1 lands:** `goal_complete` if all acceptance gates hold; `needs_user_decision` only if OD-2 (zero-vs-strict-reduction) requires operator adjudication.

---

## 10. Source Citations Index

For successor agents and reviewers, the load-bearing source surfaces this plan references:

- `packages/shave/src/universalize/recursion.ts:726` — `decomposableChildrenOf` (`FunctionDeclaration` → body statements at lines 740–756).
- `packages/shave/src/universalize/recursion.ts:1147` — `decompose()` entry point (fix site).
- `packages/shave/src/universalize/recursion.ts:1208–1230` — atomic-leaf bottom-out.
- `packages/shave/src/universalize/recursion.ts:1272–1285` — branch-node fragmentation emission.
- `packages/shave/src/universalize/atom-test.ts:31` — `DEFAULT_MAX_CF_BOUNDARIES = 1`.
- `packages/shave/src/universalize/atom-test.ts:42` — `CF_BOUNDARY_KINDS` set including `ConditionalExpression`.
- `packages/shave/src/universalize/atom-test.ts:65` — `countControlFlowBoundaries` (descendant walk).
- `packages/shave/src/universalize/atom-test.ts:161` — `isAtom` two-criterion gate.
- `packages/shave/src/intent/static-extract.ts:106` — `staticExtract` entry.
- `packages/shave/src/intent/static-extract.ts:119` — `pickPrimaryDeclaration` call.
- `packages/shave/src/intent/static-extract.ts:122–136` — empty-signature fragment fallback.
- `packages/contracts/src/source-pick.ts:68` — `pickPrimaryDeclaration` preference chain (P0 shared primitive).
- `packages/contracts/src/source-extract.ts` — `extractSignatureFromNode`, `extractJsDoc` (P0 shared primitives, no edits).
- `packages/shave/src/index.ts:481` — root `extractIntent` call (rich card).
- `packages/shave/src/index.ts:489–572` — single-leaf vs. multi-leaf branch — STEF makes single-leaf the only path for STEF files.
- `packages/shave/src/universalize/recursion.test.ts:48–78` — single-function happy path (already single-leaf via atomic-root; strengthened under STEF).
- `packages/shave/src/universalize/recursion.test.ts:84–158` — multi-statement / multi-if SourceFiles (NOT STEF; remain multi-leaf).
- `bench/v0-release-smoke/smoke.mjs:634–722` — Step 8b atomize + Step 9 round-trip (the load-bearing harness).
- `bench/v0-release-smoke/fixtures/novel-glue-flywheel.ts` — the canonical STEF fixture.
- `bench/B7-commit/results-darwin-2026-05-14-slice3.json:10409+` — the 20 pre-fix violations.

---

## 11. New Decision Log Row (to be appended in P0)

```
| DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001 | **WI-FIX-549 (#549, P0).** `@yakcc/shave/universalize/decompose()` adds a "single-typed-exported-function" (STEF) fast-path that, when the parsed `SourceFile` contains exactly one exported function-like declaration with typed parameters, a typed return annotation, and a non-empty JSDoc block (and whose other top-level statements are restricted to imports / type-only / export-type-only forms), returns a single-leaf `RecursionTree` covering the entire source range rather than fragmenting the function body into statement-level atoms. **Refinement, not reversal, of `DEC-V2-GLUE-AWARE-SHAVE-001`:** for STEF files the *maximal* shaveable subgraph IS the whole file, so fragmentation strictly destroys signal (the per-fragment SpecYak has `inputs:[]`, `outputs:[]`, `behavior:"source fragment (…)"` — see `packages/shave/src/intent/static-extract.ts:122–136`). For all non-STEF files the existing fragmentation algorithm applies unchanged. **Companion to `DEC-EMBED-QUERY-ENRICH-HELPER-001`:** that decision closed the query-side field-coverage asymmetry behind #444/#523; this decision closes the store-side fragmentation root cause behind #549. Together they constitute the complete fix for the v0 round-trip retrieval failure. **Evidence:** v0-release-smoke Step 9 PASS post-fix; B7-commit darwin acceptance violations strictly reduced vs. slice-3 baseline (post-fix delta table in `tmp/wi-fix-549-evidence/b7-delta-darwin.md`). | Operator-authorized 2026-05-13. Closes #549; resolves residual #444/#523 on the store side. STEF predicate is intentionally narrow (R1/R3); widening is a follow-up if a future bench surfaces a shape the predicate does not catch. Authority invariant: STEF is a SourceFile-level predicate inside `packages/shave/src/universalize/recursion.ts`; it does NOT modify `isAtom()` (per-node) or `pickPrimaryDeclaration` (P0 shared primitive). |
```

---

## 12. Quality-Gate Self-Check

- All dependencies and states mapped: ✓ (§2 grounded reading covers `decompose` → `isAtom` → `decomposableChildrenOf` → `recurse` multi-leaf branch → `extractIntent` per-leaf → `staticExtract` → `pickPrimaryDeclaration` → empty-signature SpecYak).
- Every guardian-bound work item has an Evaluation Contract with executable acceptance criteria: ✓ (§5.1, §5.2).
- Every guardian-bound work item has a Scope Manifest with explicit file boundaries: ✓ (§5.1, §5.2).
- No work item relies on narrative completion language: ✓ (every gate is a measurable test or a measurable bench-output delta).
- Plan does not modify permanent MASTER_PLAN.md sections: ✓ (only one new DEC row appended in P0).
- Plan honors `DEC-EMBED-QUERY-ENRICH-HELPER-001`: ✓ (query side unchanged; store side is the fix surface).
- Plan does not propose paid B4 runs: ✓ (out of scope per §1, §8).
- Plan does not lower thresholds, edit fixtures, or remove seed atoms: ✓ (out of scope per §1, §8).
- Plan does not propose query-side fixes: ✓ (out of scope per §1, §8).
- Plan does not collapse all `decompose` outputs to single-atom: ✓ (STEF is narrow; non-STEF behavior preserved per §4 Option A "Pros").
