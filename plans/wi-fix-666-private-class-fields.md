# WI fix-666-private-class-fields — shave `decompose()` handles ECMAScript private class fields (#foo)

**Workflow ID:** `fix-666-private-class-fields`
**Branch:** `feature/fix-666-private-class-fields`
**Worktree:** `c:/src/yakcc/.worktrees/fix-666-private-class-fields`
**Closes:** #666
**Relates:** #642 cluster (WI-510 Slice 10 / lru-cache@11.3.6 ships engine-reality-honest pending this fix)
**Predecessor engine-gap pattern:** #576 (PR #604), #585 (PR #627), #619 (PR #639)

---

## 1. Problem (verbatim from #666)

`packages/shave/src/__fixtures__/module-graph/lru-cache-11.3.6/dist/esm/index.js` (TSC-emitted ESM, 1681 LOC) contains ECMAScript private class field declarations (`#foo` syntax) in two classes:

- `Stack` — one static field: `static #constructing = false;`
- `LRUCache` — ~20+ instance and static fields: `#max;`, `#maxSize;`, `#dispose;`, `#onInsert;`, `#disposeAfter;`, `#fetchMethod;`, `#memoMethod;`, `#perf;`, …

Empirical from WI-510 Slice 10 (PR #663, landed engine-reality-honest):

| Metric | Observed | Expected (post-fix) |
|---|---|---|
| `forest.moduleCount` | `0` | `>= 3` |
| `forest.stubCount` | `1` (entry stubs whole) | `0` |
| `forestTotalLeafCount(forest)` | `0` | `> 0` |
| `forestStubs(forest)[0].specifier` | `…/lru-cache-11.3.6/dist/esm/index.js` | n/a (no stubs) |

The shave decomposer's `decompose()` does not survive these classes — the entire entry module degrades to a single `ModuleStubEntry` (`module-graph.ts:296-331`, the try/catch around `decomposeFile()` that catches all errors and emits a stub).

This is a new engine-gap class, distinct from the three closed predecessors:

- **#576** (PR #604, `b5dff3a`) — arrow-returns-arrow HOF inside class bodies. Fixed by extending `decomposableChildrenOf()` to descend into inner function-likes when an expression-body arrow's body is itself a function. **Not this gap** — that fix already landed; private-field classes still stub.
- **#585** (PR #627, `cbefa3c`) — UMD IIFE walk via `ParenthesizedExpression` unwrap. Also added `safeCanonicalAstHash` BLAKE3 fallback chain for `collectLocalRenames` `TypeError`. **Not this gap** — `ParenthesizedExpression` is a wrapper-passthrough; the LRUCache class is not wrapped in parens.
- **#619** (PR #639, `96e5a6a`) — TS-compiled CJS prelude walk. Resolved by W1 probe finding that #585's `ParenthesizedExpression` branch already covered the prelude — no new engine branch needed. **Not this gap** — that probe finding does not extend to private fields.

---

## 2. Root cause analysis

### 2.1 What the existing class branch does (recursion.ts:921-944)

```ts
if (kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.ClassExpression) {
  const cls = node as Node & { getMembers(): readonly Node[] };
  const result: Node[] = [];
  for (const member of cls.getMembers()) {
    const mk = member.getKind();
    if (
      mk === SyntaxKind.MethodDeclaration ||
      mk === SyntaxKind.Constructor ||
      mk === SyntaxKind.GetAccessor ||
      mk === SyntaxKind.SetAccessor ||
      mk === SyntaxKind.ClassStaticBlockDeclaration
    ) {
      result.push(member);
    }
    // PropertyDeclaration with initializer descends to initializer; w/o initializer skipped.
    if (mk === SyntaxKind.PropertyDeclaration) {
      const prop = member as Node & { getInitializer?(): Node | undefined };
      const init = prop.getInitializer?.();
      if (init !== undefined) result.push(init);
    }
  }
  return result;
}
```

Critically: the LRUCache private fields are **PropertyDeclarations without initializers** (`#max;`, `#maxSize;`, …). Per the existing logic, they are skipped — the branch never even inspects the `key` to detect `PrivateIdentifier`. So the stub is **not** triggered by `decomposableChildrenOf()` returning a wrong shape for class members.

The one **with-initializer** private field is `Stack`'s `static #constructing = false;` — a literal initializer (`false`). The existing branch will push that `FalseKeyword` node as a decomposable child. `safeCanonicalAstHash` should handle a literal cleanly.

So `decomposableChildrenOf` itself is most likely **not** the throwing call site.

### 2.2 Where the throw most likely originates

The likely throw site is **`safeCanonicalAstHash` → `canonicalAstHash` → `@yakcc/contracts` canonicalizer**, called from `recursion.ts` lines 1234, 1297, 1326, etc. for any node whose source text contains a `PrivateIdentifier` reference (the field declaration itself, OR the `this.#field` / `Stack.#constructing` usages inside method bodies and accessors).

The canonicalizer's local-rename normalization (`collectLocalRenames` per DEC-WI585-SAFE-HASH-FALLBACK-CHAIN-001) likely does not recognize `PrivateIdentifier` and either:

- (a) trips on `node.kind` of `PrivateIdentifier` in a switch/match that assumes only `Identifier` keys appear on the relevant AST shapes, or
- (b) `canonicalAstHash(fullSource, { start, end })` re-parses a sub-range that contains a `PrivateIdentifier` and the re-parse path errors (TS1108 / similar) when the sub-range is not a syntactically complete unit that can stand on its own with the private-field declaration in scope.

The existing `safeCanonicalAstHash` already has a BLAKE3 fallback chain (PR #585) for `collectLocalRenames TypeError`. **It is plausible the fallback chain is being exercised and succeeding** — in which case the throw is elsewhere (parse phase in `decomposeFile` itself, or `isAtom()` traversal counting `forEachDescendant` over a node that includes a `PrivateIdentifier` in some sub-position the visitor mishandles).

The implementer's first action is a **probe** (per #585 pattern at `iife-walk.test.ts` §P1-§P2): a minimal synthetic source with a single private field, run through `decompose()` directly, and surface the actual exception. **Do not patch before the probe surfaces the real throw site.**

### 2.3 Likely fix shape (subject to probe confirmation)

Based on the predecessor pattern, the fix is almost certainly one of:

1. **Extend `safeCanonicalAstHash` fallback chain** to catch a new exception class raised by the canonicalizer on private-field-bearing input, falling back to the existing BLAKE3-of-source path. **Smallest, lowest-risk surface — strongly preferred** if the probe surfaces a hash-time throw.
2. **Extend `decomposableChildrenOf` ClassDeclaration / ClassExpression branch** to explicitly skip `PropertyDeclaration` members whose `key` is a `PrivateIdentifier` AND whose initializer (if any) trips canonical hashing. **Slightly larger surface; only needed if the probe shows the throw originates from descending into a private-field initializer.**
3. **Patch the upstream canonicalizer in `@yakcc/contracts`** to recognize `PrivateIdentifier` in renaming. **Largest blast radius; reserved as the last option** because `@yakcc/contracts` is a load-bearing dependency for compile, registry, verification, and bench paths. Out of scope for this WI unless options 1 and 2 are both insufficient — in which case the implementer escalates to planner with the probe findings.

The implementer chooses among 1/2/3 based on the probe and records the choice in a DEC at the patch site.

---

## 3. Approach

### 3.1 Phase A — Diagnostic probe (implementer step 1)

Add a new test file `packages/shave/src/universalize/private-class-field-walk.test.ts` (mirrors `iife-walk.test.ts`). §P probe section runs `decompose()` directly on minimal synthetic sources:

- **§P1**: `class C { #x; constructor() {} }` — bare uninitialized private field, no usage.
- **§P2**: `class C { #x = 1; constructor() {} }` — initialized private field.
- **§P3**: `class C { static #flag = false; static create() { C.#flag = true; return new C(); } constructor() {} }` — mirrors `Stack#constructing` shape.
- **§P4**: `class C { #m; constructor() {} get m() { return this.#m; } set m(v) { this.#m = v; } }` — accessors reading/writing a private field (mirrors LRUCache's `get perf() { return this.#perf; }` pattern).
- **§P5**: Permissive `it` that calls `decompose()` on the actual `lru-cache-11.3.6/dist/esm/index.js` source, captures the thrown exception (constructor name, message, stack head), logs it. Initially permissive (no `expect`) — once the engine fix lands, flip to `expect(caughtError).toBeUndefined()`.

The probe surfaces the **exact** throw site. The implementer reads the stack trace and chooses the minimal fix surface per §2.3.

### 3.2 Phase B — Engine patch (implementer step 2)

Apply the fix surface chosen from §2.3 in `packages/shave/src/universalize/recursion.ts` (most likely option 1 or 2). Add a DEC annotation at the patch site:

```
@decision DEC-SHAVE-PRIVATE-CLASS-FIELD-001
title: <one-line title describing the chosen surface>
status: accepted
rationale: <2-4 lines on why this surface vs the alternatives in §2.3>
alternatives:
  A. <other option(s) from §2.3 with one-line rejection rationale each>
consequences:
  - lru-cache-11.3.6/dist/esm/index.js decomposes: moduleCount>=3, stubCount=0, forestTotalLeafCount>0
  - Any other package using ECMAScript private class fields (#foo) now decomposes correctly
  - Compatible with WI-V2-09 byte-identical bootstrap: deterministic descent shape
closes #666
```

§P1-§P5 probe assertions flip from permissive (Phase A) to strict (no caught error; leafCount >= 1).

### 3.3 Phase C — Flip lru-cache-headline-bindings.test.ts to post-fix expectations

The test file `packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` currently asserts the **engine-gap-honest stub state** throughout (DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001). After the engine fix, these assertions are silent regressions in disguise — they will pass against the now-broken stub state and fail against the correctly-decomposed state. The implementer must **invert** them, file-wide:

| Section | Current assertion | Post-fix assertion |
|---|---|---|
| §A | `moduleCount===0`, `stubCount===1`, `forestTotalLeafCount===0`, `allExternal===[]` | `moduleCount>=3`, `stubCount===0`, `forestTotalLeafCount>0`; `allExternal` includes at least `node:diagnostics_channel` (Outcome B per DEC-WI510-S10-DYNAMIC-IMPORT-EMPIRICAL-001 — dynamic import is now reached) |
| §B | first node is `kind: "stub"`, specifier contains `index.js` | first node is `kind: "module"`, filePath ends with `lru-cache-11.3.6/dist/esm/index.js` |
| §C | `modules.length===0`, `stubs.length===1` | `modules.length>=3`, `stubs.length===0`; all module filePaths within `lru-cache-11.3.6/` |
| §D | two-pass byte-identical on stub state | two-pass byte-identical on decomposed state — `paths1.toEqual(paths2)`, leafCount equal, externalSpecifiers equal |
| §E | `plans.length===0` | `plans.length>0` (forest has decomposable modules → at least one slice plan emitted) |
| §F | `it.skipIf(!USE_LOCAL_PROVIDER)` asserts stub state | `it.skipIf(!USE_LOCAL_PROVIDER)` asserts `combinedScore >= 0.70` per DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001 (the original post-fix target) |
| Compound | asserts stub state, plans.length===0 | asserts decomposed state, plans.length>=1 |

The file-header docblock (lines 1-160) must also be rewritten — the empirical "moduleCount=0, stubCount=1 — ENGINE-GAP CORROBORATION" framing is replaced with "post-#666 decomposed state" framing. Add a new DEC at the file header:

```
@decision DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001
title: Slice 10 assertions flipped from engine-gap-honest to post-#666-fix decomposed state
status: accepted
rationale: #666 (this WI) closes the private-class-field engine gap. The Slice 10 test
  file's stub-state assertions become silent regressions against the correctly-decomposed
  engine output. This DEC supersedes DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
  (kept in place as historical record) and DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002
  (Section F now asserts the original >=0.70 target).
consequences:
  - Slice 10 acceptance graduates from engine-reality-honest (PR #663) to fully-decomposed
  - Combined-score fixed floor 0.70 (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001) now binding
closes #666 (in concert with the engine patch DEC-SHAVE-PRIVATE-CLASS-FIELD-001)
```

**The pre-existing DEC headers (DEC-WI510-S10-*) MUST be preserved** as historical record; only their effective force changes (the new DEC-FLIP-001 supersedes them where they conflict with post-fix behavior).

### 3.4 Phase D — Workspace gates

After Phases A-C land in the worktree, the implementer runs the full Evaluation Contract (§5 below). Any failure stops the dispatch; implementer re-iterates within the same worktree until all gates are green.

### 3.5 Phase E — PR landing (per standing rules)

- Push the branch.
- `git fetch origin && git pull --ff-only origin main` (standing rule: always sync main before opening a PR).
- `gh pr create` with `closes #666` in body.
- **Do NOT request Guardian local merge to main.** CI's 2-pass bootstrap check on the PR runs and auto-merges when green.

---

## 4. Scope Manifest

### Allowed
- `packages/shave/src/universalize/recursion.ts` — primary engine patch surface (Phase B).
- `packages/shave/src/universalize/private-class-field-walk.test.ts` — new probe + regression test file (Phase A).
- `packages/shave/src/universalize/lru-cache-headline-bindings.test.ts` — assertion flip (Phase C).
- `plans/wi-fix-666-private-class-fields.md` — this plan (planner output).
- `MASTER_PLAN.md` — Engine-gap WI row addition under v0.7 closure follow-ups (planner output).

### Required
- The engine patch in `recursion.ts` MUST carry a DEC annotation `DEC-SHAVE-PRIVATE-CLASS-FIELD-001` with `closes #666`.
- `lru-cache-headline-bindings.test.ts` §A-§E + §F + Compound MUST be flipped to post-fix expectations per §3.3.
- `private-class-field-walk.test.ts` §P1-§P5 MUST exist and PASS post-fix (synthetic-fixture regression net survives any future related engine churn — same role as `iife-walk.test.ts` for #585).

### Forbidden
- No changes outside `packages/shave/` source/tests except this plan file and the one-line MASTER_PLAN.md row addition.
- **Do NOT modify `packages/shave/src/__fixtures__/module-graph/lru-cache-11.3.6/dist/esm/index.js`** — it is the test input, not editable.
- **Do NOT modify `packages/contracts/` (canonicalizer / `collectLocalRenames`)** unless the probe in §3.1 conclusively shows options 1 and 2 from §2.3 are insufficient. If `@yakcc/contracts` must change, the implementer escalates to planner with the probe findings before patching — `@yakcc/contracts` is load-bearing for compile, registry, verification, and bench paths, and a change there exceeds this WI's scope.
- No `bench/` changes (this is engine work, not benchmark work).
- No `examples/` changes.
- **Do NOT skip / `it.todo` / `it.skipIf(true)` the failing post-fix assertions** to make tests "pass." Forbidden shortcut.
- **Do NOT widen the `decomposeFile` stub-fallback in `module-graph.ts`** to silently swallow the new throw class — the whole point is to *decompose* private-field classes, not stub them more gracefully.
- **Do NOT introduce a new file/mechanism without first checking** whether the existing decomposer entry already has the dispatch site (per §2.3, the existing branch at `recursion.ts:921` or `safeCanonicalAstHash` at `recursion.ts:312` is the expected surface — this is an extension of existing logic, not new infrastructure).

### State authorities touched
- `shave_decomposer_ast` — in-memory only; no DB / shared-state authority changes.
- Test-fixture state (`packages/shave/src/__fixtures__/module-graph/lru-cache-11.3.6/…`) — **read-only**; not modified.

---

## 5. Evaluation Contract (verbatim — implementer + reviewer share this)

The reviewer MUST verify each gate independently. All gates must be green for `REVIEW_VERDICT=ready_for_guardian`.

1. **Repro fixed.** `pnpm -F @yakcc/shave vitest run src/universalize/lru-cache-headline-bindings.test.ts --no-color` — Section F PASSES (when `DISCOVERY_EVAL_PROVIDER=local` is set; otherwise §F skipIf branch is acceptable) with:
   - `forest.combinedScore >= 0.70`
   - `forest.moduleCount >= 3`
   - `forest.stubCount === 0`
   - `forestTotalLeafCount(forest) > 0`
   - All of §A, §B, §C, §D, §E, and the Compound section also PASS against post-fix expectations per §3.3.

2. **Probe regression net green.** `pnpm -F @yakcc/shave vitest run src/universalize/private-class-field-walk.test.ts --no-color` — §P1, §P2, §P3, §P4, §P5 all PASS with strict assertions (`expect(caughtError).toBeUndefined()`, `expect(tree.leafCount).toBeGreaterThanOrEqual(1)`).

3. **No regressions in the shave package.** `pnpm -F @yakcc/shave test` — full shave test suite green. No previously-passing test newly fails. (Specifically: `iife-walk.test.ts`, `decompose-prelude-walk.test.ts`, `bcryptjs-headline-bindings.test.ts`, `semver-headline-bindings.test.ts`, `zod-headline-bindings.test.ts`, `recursion.test.ts`, `recursion.props.test.ts`, `atom-test.test.ts`, `atom-test.props.test.ts`, `slicer.test.ts`, `slicer.props.test.ts`, `stef.test.ts`, `wiring.test.ts`, `module-graph.test.ts` — all must remain green.)

4. **Workspace gates (CI-mirror — NEVER use `--filter`).** Each MUST pass full-workspace:
   - `pnpm -w lint` — green across full workspace.
   - `pnpm -w typecheck` — green across full workspace.
   - `pnpm -w build` — green across full workspace.

5. **DEC annotation present at patch site.** The modified `recursion.ts` (or wherever the fix surface lands per §2.3) MUST contain `@decision DEC-SHAVE-PRIVATE-CLASS-FIELD-001` with `title`, `status: accepted`, `rationale`, `alternatives`, `consequences`, and an explicit `closes #666` reference.

6. **DEC-FLIP-001 present at lru-cache test header.** `lru-cache-headline-bindings.test.ts` header MUST contain `@decision DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001` per §3.3.

7. **Cross-package import discipline.** Any test imports from outside `@yakcc/shave` MUST use `@yakcc/*` workspace aliases — NEVER relative cross-package paths like `../../../packages/contracts/src/…`. (Standing rule from `memory/feedback_no_cross_package_imports.md`.)

8. **PR-based landing.** Implementer pushes the branch and opens a PR with `closes #666` in the body. **Do NOT request Guardian local merge into main.** CI's 2-pass bootstrap check runs on the PR and auto-merges when green. (Standing rule from `memory/feedback_pr_not_guardian_merge.md`.)

### Forbidden shortcuts (re-iterated)
- Do NOT skip / `it.todo` / `it.skipIf(true)` the failing assertions to make tests "pass."
- Do NOT widen the stub fallback in `module-graph.ts` to silently swallow the unknown AST node — the whole point is to **decompose** private-field classes, not stub them more gracefully.
- Do NOT add a new file/mechanism without first checking that the existing decomposer entry (`recursion.ts:921` class branch, or `safeCanonicalAstHash` at line 312) already has the dispatch site — this is an extension of existing logic, not new infrastructure.
- Do NOT modify `@yakcc/contracts` (canonicalizer) without first escalating to planner with the §3.1 probe findings.

### Ready-for-Guardian definition
`REVIEW_VERDICT=ready_for_guardian` on the implementer's commit when all eight gates above are green, with reviewer's output naming each gate explicitly. Guardian local landing is **not** part of this contract — landing is via PR per gate 8.

---

## 6. Decomposition into work items (single implementer slice)

This WI is a single implementer dispatch — the Phase A probe + Phase B patch + Phase C assertion flip are tightly coupled (the probe informs the patch surface; the patch is what makes the flipped assertions pass). Splitting them would require either landing a probe-only PR that doesn't fix anything (wasted CI), or a patch PR that can't validate against the test file because the test still asserts the gap state. One PR closes #666.

| WI | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| fix-666-private-class-fields-impl | `decompose()` handles ECMAScript private class fields (#foo) | Phases A-E per §3. Probe surfaces actual throw site; patch chooses minimal surface (safeCanonicalAstHash fallback chain extension OR class-branch private-field skip); lru-cache-headline-bindings.test.ts assertions flip from engine-gap-honest to post-fix decomposed state; private-class-field-walk.test.ts regression net lands. | (none — WI is unblocked at planner exit) | review | not started — next dispatch |

**Wave**: single wave, single critical path: planner → guardian (provision; worktree already provisioned at `5b13d3c`, lease active) → implementer → reviewer → PR.

---

## 7. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Probe surfaces a throw inside `@yakcc/contracts` that options 1 and 2 from §2.3 cannot work around | low-medium | medium (would expand scope to a load-bearing package) | Implementer escalates to planner with probe findings BEFORE touching `@yakcc/contracts`. Planner re-evaluates scope. Implementer does NOT silently widen scope. |
| Fix introduces a regression in another shave headline-binding test (zod, semver, lodash, etc.) | low | high (would block the PR) | Gate 3 (full shave test suite) catches this. Implementer iterates within the worktree until green. |
| §F gate fails because `DISCOVERY_EVAL_PROVIDER=local` is not set in CI | medium | low | §F is `it.skipIf(!USE_LOCAL_PROVIDER)` — skipping is acceptable in CI. The combinedScore floor is a local-eval gate, not a CI gate. Reviewer notes the skip in their verdict; gate is considered green when §F either PASSES or SKIPS (per the existing `it.skipIf` pattern). |
| lru-cache fixture changes upstream (post-11.3.6 release alters file content) | very low | medium | Fixture is pinned (`lru-cache-11.3.6/`); upstream version bumps go through a separate WI. |
| Two-pass byte-identical determinism (§D) regresses because the new descent introduces a non-deterministic enumeration | low | high | Implementer MUST run §D explicitly and confirm `paths1.toEqual(paths2)` etc. before reviewer dispatch. The patch SHAPE (per §2.3 options 1 and 2) is deterministic by construction — but verify, don't trust. |

---

## 8. Cross-references

- **GitHub issue:** #666
- **WI-510 Slice 10 PR:** #663 (landed engine-reality-honest; this WI graduates it to fully-decomposed)
- **Predecessor engine-gap WIs / plans:**
  - `plans/wi-585-umd-iife-decompose.md` — #585 / PR #627 (template for §3.1 probe and §3.2 patch DEC structure)
  - PR #604 `b5dff3a` — #576 arrow-returns-arrow fix (recursion.ts extension pattern)
  - PR #639 `96e5a6a` — #619 CJS prelude (W1 probe finding pattern: "existing branch already covers")
- **Engine-gap landscape DEC:** `DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001` (lru-cache-headline-bindings.test.ts:46-51)
- **Standing decisions superseded by this WI's outcome:**
  - `DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001` (kept as historical; effective force replaced by DEC-FLIP-001 per §3.3)
  - `DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002` (kept as historical; §F now asserts the original >=0.70 floor)
- **Standing rules applied:**
  - `memory/feedback_pr_not_guardian_merge.md` — gate 8.
  - `memory/feedback_no_cross_package_imports.md` — gate 7.
  - `memory/feedback_eval_contract_match_ci_checks.md` — gate 4 (full-workspace, not `--filter`).
  - `memory/feedback_fetch_before_pr.md` — §3.5 fetch+pull before `gh pr create`.
- **Cluster downstream impact:** #642 cluster (WI-510 S11-S15) — any future slice fixture that uses ECMAScript private fields now decomposes cleanly without re-opening this engine gap.

---

## 9. Implementer hand-off

The implementer is dispatched with this plan, the Evaluation Contract (§5), and the Scope Manifest (§4). The orchestrator has already authority-written the Scope Manifest to runtime via `cc-policy workflow scope-sync` (scope JSON at `tmp/scope-fix-666-private-class-fields.json`).

**Implementer first actions, in order:**

1. Read this plan in full (`plans/wi-fix-666-private-class-fields.md`).
2. Read `plans/wi-585-umd-iife-decompose.md` for the §P probe template and DEC structure.
3. Run the §3.1 probe: write `private-class-field-walk.test.ts` §P1-§P5 (initially permissive), run it, capture the actual throw constructor + message + stack head from §P5.
4. Choose the minimal patch surface from §2.3 based on §3.1 findings. Record the choice in DEC-SHAVE-PRIVATE-CLASS-FIELD-001 at the patch site.
5. Apply the patch. Flip §P probe assertions from permissive to strict.
6. Flip `lru-cache-headline-bindings.test.ts` §A-§F + Compound per §3.3. Add DEC-FLIP-001 at file header.
7. Run the Evaluation Contract (§5 gates 1-7) inside the worktree. Iterate until green.
8. Reviewer is dispatched (auto-routing). On `REVIEW_VERDICT=ready_for_guardian`, implementer pushes the branch and opens the PR (gate 8). On `REVIEW_VERDICT=needs_changes`, iterate.

**On probe finding that the fix surface lies outside the Scope Manifest (`@yakcc/contracts`) per §2.3 option 3:** implementer STOPS, does NOT widen scope, escalates to planner via the standard re-dispatch with the probe findings included verbatim. Planner re-evaluates and either expands the manifest with explicit DEC justification or chooses a different surface.

---

## 10. Decision log entries (planner-authored, this WI)

| ID | Date | Decision | Rationale |
|---|---|---|---|
| DEC-WI666-PROBE-FIRST-001 | 2026-05-17 | Implementer runs §3.1 probe BEFORE patching | Mirrors #585 / `iife-walk.test.ts` §P. The probe surfaces the actual throw site, which determines the minimal patch surface per §2.3. Patching without the probe risks (a) over-broad scope into `@yakcc/contracts`, (b) under-broad scope that misses a second throw site, (c) the wrong surface entirely. The 30-minute probe cost is paid back many times over in scope discipline. |
| DEC-WI666-SCOPE-EXCLUDES-CONTRACTS-001 | 2026-05-17 | `@yakcc/contracts` is FORBIDDEN unless probe conclusively shows options 1 and 2 from §2.3 are insufficient AND planner re-approves | `@yakcc/contracts` is load-bearing for compile, registry, verification, and bench paths. A change there has a blast radius far exceeding this WI's intent. Implementer's probe-then-escalate path is the discipline that keeps scope honest. |
| DEC-WI666-TEST-FLIP-NOT-DEFER-001 | 2026-05-17 | `lru-cache-headline-bindings.test.ts` assertions flip in the same PR as the engine patch | Splitting (engine patch in PR-N, test flip in PR-N+1) leaves a window where (a) the engine is correct but the tests assert the old gap state (silent regression), or (b) the tests assert post-fix state but the engine still stubs (red CI). Single PR closes #666 with green CI throughout. |
| DEC-WI666-SINGLE-WI-NOT-WAVES-001 | 2026-05-17 | This WI is one implementer slice, not split into probe-PR + patch-PR + test-flip-PR | Per §6: the three phases are tightly coupled. A probe-only PR doesn't fix anything (wasted CI). A patch-PR without the test flip can't validate. A test-flip-PR without the patch is red. One coherent PR closes the engine gap. |

---

**End of plan. Implementer dispatch is next.**
