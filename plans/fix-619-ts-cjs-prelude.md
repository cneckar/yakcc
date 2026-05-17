# fix-619 — TS-compiled CJS prelude defeats strict-subset decompose()

**Branch:** `fix/619-ts-cjs-prelude`
**Worktree:** `C:/src/yakcc/.worktrees/fix-619-ts-cjs-prelude`
**Base:** `main @ 75b8a28` (current)
**Closes:** #619
**Relates:** #585 (sibling engine-gap closed by PR #627 with the same `decomposableChildrenOf` pattern); #576 (orthogonal arrow-fn gap surfaced at module scope in `en.cjs`/`types.cjs` — out of scope here)

---

## 1. Problem (verbatim from #619)

Files compiled by `tsc` to CJS begin with a standard interop prelude:

```js
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) { ... }) : (function(o, m, k, k2) { ... }));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) { ... }) : function(o, v) { ... });
var __importStar = (this && this.__importStar) || function (mod) { ... };
var __exportStar = (this && this.__exportStar) || function(m, exports) { ... };
Object.defineProperty(exports, "__esModule", { value: true });
// ...module body
```

`shavePackage()` on the 4 zod entry-point fixtures returns `moduleCount=0, stubCount=1` —
the prelude triggers a `decompose()` throw, the catch in `module-graph.ts::shavePackage()`
(lines 322-333) converts the throw into a `ModuleStubEntry` with reason
`"decompose() failed: <message>"`, and the whole module is lost.

Empirical reproducers (4 zod entry-point fixtures + 1 already-Group-A described file
that is NOT a #619 victim, see §1.1):

| Path | Bytes | Lines | Notes |
|---|---|---|---|
| `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/index.cjs` | 1009 | 34 | TS prelude + 3 `exports.*` assignments + 1 `__importStar(require(...))` + 1 `__exportStar(require(...))` |
| `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/v3/external.cjs` | 765 | 23 | TS prelude (2 helpers only) + 6 `__exportStar(require(...))` calls |
| `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/v3/index.cjs` | 1009 | 34 | Identical-shape sibling of `index.cjs` (require paths differ) |
| `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/v3/types.cjs` | ~190k | 3775 | TS prelude + 39 ClassDeclaration + 131 arrow tokens — hits #619 AND #576 simultaneously |

### 1.1 `en.cjs` is NOT a #619 victim

`packages/shave/src/__fixtures__/module-graph/zod-3.25.76/v3/locales/en.cjs` was added
as a Group-A fixture in WI-510 Slice 8 (line 1113 of `zod-headline-bindings.test.ts`)
but its top-of-file is a stripped-down `Object.defineProperty(exports, "__esModule", { value: true })`
followed immediately by `const errorMap = (issue, _ctx) => { switch(...) }`. The stub
comes from the module-level arrow-fn shape (issue #576-extended), NOT the TS prelude.
**`en.cjs` is out of scope for #619; its describe block must NOT be flipped here.**

---

## 2. Investigation Findings (planner, 2026-05-17)

### 2a. Static analysis identifies the failure as `decompose()` throwing on a prelude descent path

The stub reason is captured at `module-graph.ts:329`:
```ts
reason: `decompose() failed: ${err instanceof Error ? err.message : String(err)}`,
```
The throw originates inside `recursion.ts::recurse()` (lines 1310-1431). Three throws are
possible:
- `RecursionDepthExceededError` (depth > 24)
- `DidNotReachAtomError` (non-atomic node with empty `decomposableChildrenOf` AND not the
  `CallExpression` fallback at 1396-1406)
- Any uncaught `TypeError`/`CanonicalAstParseError` from `safeCanonicalAstHash()` — note
  the existing 3-tier fallback at lines 413-426 should absorb most parse errors, but a
  TypeError from `collectLocalRenames` on JS-as-TS parameter shapes IS guarded
  (DEC-WI585-SAFE-HASH-FALLBACK-CHAIN-001).

### 2b. The current `decomposableChildrenOf` policy already covers the prelude AST shapes — in theory

Tracing `var __createBinding = (this && this.__createBinding) || (Object.create ? (function(){...}) : (function(){...}));`:

1. SourceFile → top-level statements (incl. this VariableStatement). cfCount across the
   whole prelude is ≥ 5 (one ConditionalExpression per helper line) → non-atomic at
   SourceFile level → descend.
2. VariableStatement → `[initializer]` = `[BinaryExpression(LogicalOr, left, right)]`.
3. BinaryExpression → `[left, right]` (line 1120-1126).
   - left = `ParenthesizedExpression(BinaryExpression(LogicalAnd, ThisKeyword, PropertyAccessExpression))`.
   - right = `ParenthesizedExpression(ConditionalExpression(...))`.
4. ParenthesizedExpression → `[inner expression]` (DEC-WI585-PARENTHESIZED-EXPRESSION-UNWRAP-001
   landed by PR #627 — this branch IS present in the current engine).
5. left's inner BinaryExpression(LogicalAnd) → `[ThisKeyword, PropertyAccessExpression]`.
   Each is a leaf with 0 CF → isAtom true → AtomLeaf. **OK.**
6. right's inner ConditionalExpression → `[condition, whenTrue, whenFalse]` (line 1108-1115).
   - condition = `PropertyAccessExpression(Object.create)` → atom.
   - whenTrue = `ParenthesizedExpression(FunctionExpression)` → unwrap → FunctionExpression.
     cfCount = 2 (1 IfStatement inside the body + 1 ConditionalExpression in the if-test) →
     non-atomic → descend to body Block statements. Each statement is decomposable.
   - whenFalse = same shape.

**The static trace suggests the prelude SHOULD decompose. The throw is therefore at a
construct the static trace misses — most likely one of these candidate sites that the
implementer's W1 probe must confirm empirically:**

### 2c. Candidate throw sites (ranked by static likelihood)

| # | Candidate | Mechanism | Notes |
|---|---|---|---|
| **C1** | **`PropertyAccessExpression` (e.g. `m.__esModule`, `Object.prototype.hasOwnProperty.call`) deep inside the FunctionExpression body** appearing as the leaf of a `BinaryExpression([prop, val])` whose isAtom() returns FALSE for some non-CF reason | If `countControlFlowBoundaries` returns >0 due to a transitively-walked CF ancestor (it doesn't — it walks descendants only), or if a known-primitive registry hit fires (no — `emptyRegistry`), this would throw `DidNotReachAtomError` | LOW — but cheapest to rule out via probe |
| **C2** | **`ConditionalExpression` returned to `decomposableChildrenOf` by an ancestor that classifies it under a `kind` branch the engine treats as further-decomposable, but the ternary's WhenTrue is itself a `FunctionExpression` (no Paren wrap)** | The whenFalse of `__setModuleDefault` is `function(o, v) { ... }` directly (NO paren wrap). ConditionalExpression descent returns the FunctionExpression directly → isAtom on FunctionExpression: cfCount=0 → atom. OK. | UNLIKELY to throw |
| **C3** | **`SpreadElement` / `PropertyAccessExpression` chains** in `Object.prototype.hasOwnProperty.call(exports, p)` etc. | All are leaves with 0 CF → atom | UNLIKELY |
| **C4** | **`canonicalAstHash` on a parameter-shape node throws TypeError NOT caught by the SafeHash fallback chain** | DEC-WI585-SAFE-HASH-FALLBACK-CHAIN-001 added a `try { canonicalAstHash(nodeSource); } catch { try { fullSource+range; } catch { raw BLAKE3; } }` fallback (lines 413-426). This SHOULD absorb all TypeErrors. BUT — this is only the fallback in the **end** of safeCanonicalAstHash. The EARLIER paths (CONTEXT_DEPENDENT_STATEMENT_KINDS, LOOP_KINDS, escapes.*) call `canonicalAstHash` directly inside `try/catch` blocks that catch `{}` but rethrow on TypeError from internals NOT wrapped — wait, actually each try{} swallows `catch {}` so any throw IS caught and falls through. Confirmed: safeCanonicalAstHash should never throw. | UNLIKELY but worth confirming probe shows no SafeHash throw |
| **C5** | **`PropertyAccessExpression` on `this`** as a `decomposableChildrenOf` BinaryExpression descent target | `ThisKeyword` (kind 110) and `PropertyAccessExpression` (kind 213) both return [] from `decomposableChildrenOf`. cfCount=0 → isAtom true → AtomLeaf. OK. | UNLIKELY |
| **C6** | **A bare `function(o, m, k, k2) { ... }` PARAMETER list** — destructuring or default values that ts-morph @28 parses oddly when ScriptKind=TS on JS source | Speculative; would manifest as TypeError from `getNameNode()` returning undefined. If the SafeHash chain still throws here, the fallback chain has a gap. | LOW |
| **C7** | **`var p in m` declaration inside `for(var p in m) ...`** where the ForInStatement's `getStatement()` returns a single statement that's an IfStatement, then the IfStatement's thenStatement is itself a ForInStatement-like chain — **HIGH PRIORITY**: in `__exportStar`, the body is `for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);` — IfStatement with NO else, thenStatement = `ExpressionStatement(CallExpression(__createBinding,...))` → CallExpression has no function-like args → fallback atom branch fires. OK. | UNLIKELY |
| **C8** | **`Object.defineProperty(exports, "__esModule", { value: true });`** top-level | ExpressionStatement → CallExpression → args include OLE. OLE → PropertyAssignment(value: true) → initializer = TrueKeyword. TrueKeyword has no decomposableChildrenOf branch → []. cfCount=0 → atom. OK. | UNLIKELY |
| **C9** ⭐ | **`childMatchesRegistry()` (line 1222-1241) walks `decomposableChildrenOf(node)` and calls `safeCanonicalAstHash` on EACH child eagerly.** When isAtom returns true on the OUTER SourceFile (it doesn't here — cfCount > 1), childMatchesRegistry runs. But it only fires when isAtom returned true. Should not be the path. | UNLIKELY |
| **C10** ⭐⭐ | **The `else` branch of `__setModuleDefault`'s ConditionalExpression:** `(Object.create ? (function(o, v) {...}) : function(o, v) { o["default"] = v; })`. The `whenFalse` is a **bare FunctionExpression NOT wrapped in ParenthesizedExpression**. ConditionalExpression descent returns it directly. FunctionExpression body Block → 1 statement: `o["default"] = v;` → ExpressionStatement(BinaryExpression(EqualsToken, ElementAccessExpression, Identifier)). BinaryExpression → [left, right]. **left = ElementAccessExpression(o, "default")**. ElementAccessExpression (kind 211) has NO decomposableChildrenOf branch → []. cfCount=0 → isAtom returns true → AtomLeaf. OK. | UNLIKELY |
| **C11** ⭐⭐⭐ | **The `__esModule` `Object.defineProperty(exports, "__esModule", { value: true })` ExpressionStatement at top level** sits AFTER all the prelude `var` decls. If `getTopLevelStatements(SourceFile)` returns 5 prelude VariableStatements + 1 ExpressionStatement + N body statements, descent into THIS ExpressionStatement → CallExpression(`Object.defineProperty`, [PropertyAccessExpression, StringLiteral, ObjectLiteralExpression]). callee = `Object.defineProperty` (PropertyAccessExpression) → `unwrapCalleeToDecomposable` returns undefined. ObjectLiteralExpression arg IS pushed (line 1075). OLE has 1 PropertyAssignment: `value: true`. PropertyAssignment.initializer = TrueKeyword. TrueKeyword (kind `TrueKeyword`) → no branch → []. cfCount=0 → atom. OK. | UNLIKELY but quick to rule out |
| **C12** ⭐⭐⭐⭐ | **`__exportStar(require("./errors.cjs"), exports);` at top level of `external.cjs`** — ExpressionStatement → CallExpression(`__exportStar`, [CallExpression(`require`, [StringLiteral]), Identifier]). callee = `__exportStar` (Identifier) → `unwrapCalleeToDecomposable` returns undefined. ArrayofArgs: `require(...)` is a CallExpression (NOT in {ArrowFunction, FunctionExpression, ObjectLiteralExpression}) → NOT pushed. `exports` is an Identifier → NOT pushed. **result = []** → CallExpression fallback atom branch at line 1396-1406 fires → AtomLeaf. OK. | OK |

**Best static guess for the actual throw:** none of the above looks airtight as a throw
site. The most plausible failure mode is **a `DidNotReachAtomError` somewhere in the
deep walk of one of the helper FunctionExpression bodies**, on an AST shape that the
static trace above missed. The implementer MUST probe to identify it concretely before
patching.

### 2d. Why the static trace may be wrong

The decompose() recursion walks the AST via `decomposableChildrenOf` which ENUMERATES
specific SyntaxKinds; any kind NOT enumerated (e.g. `ElementAccessExpression`,
`PrefixUnaryExpression`, `SpreadElement`, `NewExpression` with no function-like args,
specific `TemplateExpression` shapes, `TypeOfExpression`, etc.) falls through to the
default `return []` at line 1195. If `isAtom` then returns false (because some descendant
made cfCount exceed maxCF, OR registry-hit, OR the node range == its parent range
triggering the supplemental childMatchesRegistry which itself descends), the node
throws DidNotReachAtomError.

The prelude is dense with non-enumerated expression shapes (Object.create's
PropertyAccessExpression, `mod && mod.__esModule` BinaryExpression, etc.). The probe
will identify the exact kind + range.

### 2e. Sister activity

`git log packages/shave/src/universalize/recursion.ts` last touched at commit `cbefa3c`
(2 commits ago, PR #627 WI-585 land). `git log packages/shave/src/universalize/slicer.ts`
last touched at `b5dff3a` (issue #576 arrow-returns-arrow). **No active sister WI on
`recursion.ts` in any open worktree.** Safe to proceed.

---

## 3. Approach

### 3.1 Diagnostic phase (implementer W1) — REQUIRED before any patch

Add a temporary probe to `packages/shave/src/universalize/module-graph.ts` inside the
`catch (err)` block at line 325:

```ts
} catch (err) {
  if (process.env.FIX_619_PROBE) {
    console.error(`\n[FIX-619 PROBE] decompose() threw on ${filePath}`);
    if (err instanceof Error) {
      console.error(`  ${err.constructor.name}: ${err.message.slice(0, 600)}`);
      if ('node' in err && err.node) {
        const n = err.node as { kind: number; range: { start: number; end: number }; source: string };
        console.error(`  node.kind=${n.kind} (lookup SyntaxKind), range=[${n.range.start},${n.range.end})`);
        console.error(`  node.source: ${String(n.source).slice(0, 400).replace(/\n/g, '\\n')}`);
      }
      if (err.stack) console.error(`  stack(top 8):\n    ${err.stack.split('\n').slice(0, 8).join('\n    ')}`);
    } else {
      console.error(`  non-Error throw: ${String(err)}`);
    }
  }
  nodes.push({ kind: "stub", specifier: filePath, reason: `decompose() failed: ${err instanceof Error ? err.message : String(err)}` });
  ...
```

Run:
```bash
FIX_619_PROBE=1 pnpm -F @yakcc/shave test --no-coverage zod-headline-bindings.test.ts -t "engine-gap corroboration" 2>&1 | grep -A 20 'FIX-619 PROBE'
```

Capture the actual exception class, the node kind (use `ts-morph` SyntaxKind lookup), the
range slice, and the top of the stack trace. **The probe must be removed before commit.**

Expected outcomes:

1. **`DidNotReachAtomError`** → record the AST kind + source slice. Patch
   `decomposableChildrenOf` (or `isAtom` policy in the rare case it's a CF-related
   classification miss) to handle that one specific kind.
2. **`RecursionDepthExceededError`** → unlikely for a 34-line file; would indicate a
   cyclic recursion bug. Investigate before patching.
3. **`TypeError` / `CanonicalAstParseError`** → a gap in the SafeHash 3-tier fallback
   chain (DEC-WI585-SAFE-HASH-FALLBACK-CHAIN-001). Extend the fallback to cover the new
   case.

### 3.2 Fix phase (implementer W2)

Based on the probe outcome, apply the **smallest possible engine change**. The fix MUST
land in one of:

- `packages/shave/src/universalize/recursion.ts` — add a `decomposableChildrenOf` branch
  for the new SyntaxKind, OR extend the SafeHash fallback chain, OR add a narrow `isAtom`
  classification hint.
- `packages/shave/src/universalize/slicer.ts` — only if the throw originates from
  `slice()` (very unlikely — `shavePackage` calls `decompose()` BEFORE `slice()`; stubs
  come from decompose throws).

**Forbidden shortcut:** do NOT add a top-of-file "strip TS prelude" pre-processor in
`module-graph.ts` or anywhere else. The engine must handle the prelude as a natural AST,
not a special-cased text pattern. (Mirrors DEC-WI585-NO-EXTRACT-IIFE-SPECIAL-CASE-001
parallel-authority guard.)

**Recommended fix shape:** narrow, additive `decomposableChildrenOf` branch for the one
SyntaxKind the probe identifies — exactly the pattern PR #627 used for
`ParenthesizedExpression`. Annotate with a fresh
`@decision DEC-FIX-619-<KIND>-DECOMPOSE-001` block in-line at the point of change.

### 3.3 Test phase (implementer W3)

#### New file: `packages/shave/src/universalize/decompose-prelude-walk.test.ts`

Synthetic prelude-shape fixtures (inline strings via ts-morph; no `__fixtures__/` writes).
Follows the structure of `iife-walk.test.ts` precisely. Sections:

- **§A Single-helper prelude:** `"use strict"; var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o,m,k,k2){ if (k2===undefined) k2=k; o[k2]=m[k]; }) : (function(o,m,k,k2){ if(k2===undefined) k2=k; o[k2]=m[k]; })); module.exports = {};` → `decompose()` succeeds, `leafCount >= 1`.
- **§B Two-helper prelude (no `__importStar`):** Mirror of `external.cjs` prelude top
  (`__createBinding` + `__exportStar`) + a single `__exportStar(require("./foo.cjs"), exports);` call → `decompose()` succeeds.
- **§C Four-helper full prelude:** All four helpers (`__createBinding`, `__setModuleDefault`,
  `__importStar`, `__exportStar`) + `Object.defineProperty(exports, "__esModule", { value: true });` → `decompose()` succeeds.
- **§D Full prelude + body re-exports (mirror of `external.cjs`):** Four helpers + the
  `Object.defineProperty(...)` + 6 `__exportStar(require(...))` calls → `decompose()`
  succeeds, `leafCount >= 6`.

Each `it()` carries `{ timeout: 30_000 }` (matching `iife-walk.test.ts`). The §D test may
need `{ timeout: 60_000 }` if the additional `require()` calls slow it down.

#### Update existing: `packages/shave/src/universalize/zod-headline-bindings.test.ts`

**Group A describes to FLIP (the 3 entry points that ARE prelude-only stubs):**

| Describe (line) | Old assertion | New assertion |
|---|---|---|
| `zod/index.cjs` (215) | `forest.moduleCount).toBe(0)` | `forest.moduleCount).toBeGreaterThanOrEqual(1)` |
| `zod/index.cjs` (215) | `forest.stubCount).toBe(1)` | `forest.stubCount).toBe(0)` |
| `zod/index.cjs` (215) | `forestTotalLeafCount(forest)).toBe(0)` | `forestTotalLeafCount(forest)).toBeGreaterThan(0)` |
| `zod/index.cjs` (215) | `allExternal).toEqual([])` | `allExternal).toEqual([])` (UNCHANGED — zod has 0 npm deps; in-package edges via `require('./v3/external.cjs')` resolve to in-boundary, not external) |
| `zod/v3/external.cjs` (310) | same pattern as above | flip to `>= 1 / == 0 / > 0`; externalSpecifiers stays `[]` |
| `zod/v3/index.cjs` (491) | same pattern | flip to `>= 1 / == 0 / > 0`; externalSpecifiers stays `[]` |

**Group A describes to KEEP STUBBED (the 2 fixtures whose stub is NOT a #619 victim):**

| Describe (line) | Reason | Action |
|---|---|---|
| `zod/v3/types.cjs` (399) | **CONDITIONAL:** TS prelude + 3775-line multi-class monolith. Once the prelude is walked, the engine will START walking the body, hitting issue #576 at scale. Likely outcomes: (a) #576 throws → still stubs → keep ALL §A-D assertions as-is, add a comment "#619 fixed but #576 still stubs here at body scale"; (b) #576 ALSO walks through and the file actually decomposes → flip to working assertions AND raise wall-clock timeout to `{ timeout: 600_000 }` for §A and `{ timeout: 1_200_000 }` for §B/C/D. **Implementer MUST run the test empirically post-fix and choose (a) or (b) based on observed behavior.** Document the choice with a fresh `DEC-FIX-619-TYPES-CJS-POST-FIX-001`. | RUN, MEASURE, DECIDE |
| `zod/v3/locales/en.cjs` (1113) | NOT a #619 victim — stubs due to module-level arrow-fn (issue #576-extended). Prelude is just `"use strict"; Object.defineProperty(...)` + 1 require + 1 arrow. | LEAVE UNTOUCHED. Even after #619 lands, this file should still stub because of #576. If the implementer observes en.cjs flipping, that is unexpected and must be reported (and likely indicates over-broad fix). |

**Group B describes (5 describes):** Should remain GREEN with no semantic change.
Implementer must verify by running the FULL `zod-headline-bindings.test.ts` post-fix.
If any Group B test changes shape (e.g. ZodError.cjs's measured leaf count changes),
that is a regression risk — investigate before pushing.

**Compound interaction test (line 1437):** Same — verify still GREEN. The compound
asserts 4 Group B bindings end-to-end; not affected by Group A changes.

#### Update existing: `packages/shave/src/universalize/iife-walk.test.ts`

**NO CHANGE.** PR #627's 4 §A-D synthetic shapes test the IIFE branch of the engine; the
prelude fix does not touch IIFE behavior. Re-run the suite to confirm no regression.

---

## 4. State Authority Map

| Domain | Authority |
|---|---|
| Per-module decomposition | `packages/shave/src/universalize/recursion.ts::decompose` (DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001 — engine is frozen at the public surface; internal extension via new `@decision` annotations is the canonical path) |
| Atom classification (isAtom) | `packages/shave/src/universalize/atom-test.ts` (sole authority — likely untouched here) |
| Decomposable children policy | `packages/shave/src/universalize/recursion.ts::decomposableChildrenOf` (sole descent-policy authority — most likely fix location) |
| Context-safe canonical hashing | `packages/shave/src/universalize/recursion.ts::safeCanonicalAstHash` (3-tier fallback per DEC-WI585-SAFE-HASH-FALLBACK-CHAIN-001 — possible secondary fix location) |
| BFS forest orchestration | `packages/shave/src/universalize/module-graph.ts::shavePackage` (frozen; only the temp probe lives here, must be removed by commit) |
| Stub generation | `packages/shave/src/universalize/module-graph.ts::shavePackage` catch block (stubs are produced HERE when decompose throws) |
| Engine test net | `packages/shave/src/universalize/iife-walk.test.ts` (sibling) + new `decompose-prelude-walk.test.ts` (this PR) |
| Zod headline binding assertions | `packages/shave/src/universalize/zod-headline-bindings.test.ts` (Group A flip authority pre-authorized in WI-510 S8 dispatch contract for engine-reality changes) |

**No new authority introduced.** The fix extends the existing `decomposableChildrenOf`
(or, less likely, `safeCanonicalAstHash`) with a strictly-additive branch. The Group A
assertion flips are a deliberate engine-reality update with a fresh DEC annotation.

---

## 5. Wave Decomposition

| W-ID | Title | Weight | Gate | Deps | Files |
|---|---|---|---|---|---|
| W1 | Empirical probe + capture exception details (one or more of 4 zod entry points) | S | none | — | `module-graph.ts` (temp probe; **MUST be removed by commit**) |
| W2 | Engine fix per probe outcome (narrow, additive) | S | none | W1 | `recursion.ts` (most likely); fallback: `slicer.ts` |
| W3 | New `decompose-prelude-walk.test.ts` (4 synthetic shapes §A-D) | S | none | W2 | new file |
| W4 | Flip Group A assertions for `index.cjs` / `v3/external.cjs` / `v3/index.cjs`; conditionally flip OR document `v3/types.cjs`; leave `en.cjs` untouched | S | none | W3 | `zod-headline-bindings.test.ts` |
| W5 | Full shave-package test sweep — all 10 headline-bindings tests + `iife-walk.test.ts` + `module-graph.test.ts` + `recursion.test.ts` + `slicer.test.ts` + `stef.test.ts` + `atom-test.test.ts` + `wiring.test.ts`. Full-workspace `pnpm -w lint && pnpm -w typecheck && pnpm -w format` | M | review | W2,W3,W4 | (no source edit) |
| W6 | Commit + push + PR with body `closes #619` | S | guardian | W5 | — |

**Critical path:** W1 → W2 → W3 → W4 → W5 → W6 (single thread; no parallelism). The
probe (W1) is load-bearing and gates everything; do not skip it.

---

## 6. Evaluation Contract

### Required tests

- **New `decompose-prelude-walk.test.ts` passes** — 4 synthetic prelude shapes (§A-D)
  each succeed (no throw); each has `leafCount >= 1` (§D has `leafCount >= 6`).
- **`zod-headline-bindings.test.ts` Group A describes flip correctly:**
  - `zod/index.cjs` (line 215): all 4 it() blocks pass with `moduleCount >= 1`,
    `stubCount == 0`, `leafTotal > 0`, `externalSpecifiers == []`. Stub specifier
    assertions in §B remove their stub-shape (or change to `forestModules(forest)` shape).
  - `zod/v3/external.cjs` (line 310): same shape.
  - `zod/v3/index.cjs` (line 491): same shape.
  - `zod/v3/types.cjs` (line 399): EMPIRICAL — implementer runs once post-fix and
    documents the observed behavior. If still stubbed (#576 throws), keep all assertions
    AND add a comment block referencing DEC-FIX-619-TYPES-CJS-POST-FIX-001(a). If
    flipped, raise timeouts AND add a comment referencing DEC-FIX-619-TYPES-CJS-POST-FIX-001(b).
  - `zod/v3/locales/en.cjs` (line 1113): UNCHANGED. Must still stub. If en.cjs flips,
    that is a stop-and-report event (the fix is too broad).
- **`iife-walk.test.ts` (all 7 it() including 3 §P probes + §A-D)** continues to pass
  with no regression.
- **All other headline-bindings tests pass** with no regression:
  - `validator-headline-bindings.test.ts`
  - `semver-headline-bindings.test.ts`
  - `uuid-headline-bindings.test.ts`
  - `nanoid-headline-bindings.test.ts`
  - `date-fns-headline-bindings.test.ts`
  - `jsonwebtoken-headline-bindings.test.ts`
  - `bcryptjs-headline-bindings.test.ts` (currently §A-E SKIPPED per #625; verify still
    loads cleanly)
  - `lodash-headline-bindings.test.ts`
  - `p-limit-headline-bindings.test.ts` / `p-throttle-headline-bindings.test.ts`
- **Engine micro-tests pass:** `module-graph.test.ts`, `recursion.test.ts`,
  `slicer.test.ts`, `stef.test.ts`, `atom-test.test.ts`, `wiring.test.ts`.
- **If any test flips that is NOT in the above expected-flip list (specifically: en.cjs,
  any Group B describe, any compound describe, any other headline-bindings file), STOP
  and document the unexpected flip in PR body with empirical evidence; do NOT silently
  accept it.** This may indicate the fix is too broad.

### Required evidence (in PR body or commit message)

- Diff scoped strictly to `allowed_paths` (see Scope Manifest §7).
- `plans/fix-619-ts-cjs-prelude.md` committed in the same PR.
- W1 probe output captured verbatim (the exception class + node kind + range slice).
  This is the empirical evidence justifying the chosen fix location.
- `pnpm -F @yakcc/shave test` clean output (or partial output if v3/types.cjs is slow;
  worst-case `pnpm -F @yakcc/shave test --testNamePattern "..."` per-binding).
- **Full-workspace** `pnpm -w lint && pnpm -w typecheck` clean output captured in PR
  (NOT package-scoped — per `feedback_eval_contract_match_ci_checks.md`).
- `pnpm -w format` (biome) applied to all modified TS files.
- `git fetch origin && git diff --stat origin/main..HEAD` shows only intended files.

### Required real-path checks

- `packages/shave/src/universalize/module-graph.ts` exists and is **unmodified at commit
  time** (the W1 probe MUST be removed before commit). `git diff` of this file must
  return empty.
- `packages/shave/src/__fixtures__/module-graph/zod-3.25.76/**` exists and is NOT
  modified. All 4 zod entry-point fixtures are in `forbidden_paths`.
- `packages/shave/src/universalize/iife-walk.test.ts` is unmodified (sibling test from
  PR #627 — not in scope).
- The new `packages/shave/src/universalize/decompose-prelude-walk.test.ts` exists and
  has SPDX-License-Identifier MIT header (matches `iife-walk.test.ts` convention).

### Required authority invariants

- `packages/shave/src/index.ts` untouched (public-API surface frozen).
- `packages/shave/src/types.ts` untouched.
- `packages/shave/src/universalize/atom-test.ts` untouched (unless probe identifies the
  fix lives in `isAtom` classification, in which case a scope expansion is requested via
  `cc-policy workflow scope-sync` BEFORE editing).
- `packages/shave/src/universalize/module-resolver.ts` untouched (extractor is correct;
  the throw is in `decompose`, not in specifier extraction).
- `packages/shave/src/universalize/module-graph.ts` net-zero diff (probe added, probe
  removed).
- `packages/shave/src/__fixtures__/**` untouched (fixtures sacred —
  DEC-WI510-S6-FIXTURE-FULL-TARBALL-001).
- `packages/registry/**` untouched (no corpus row changes — Group A files don't bind
  novel atoms anyway).
- `packages/hooks-*/` untouched.
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `bench/**`, `docs/**`, `scripts/**`
  untouched.
- `pnpm-workspace.yaml`, `vitest.config.ts`, `biome.json`, `tsconfig*.json` untouched.

### Required integration points

- `shavePackage()` public signature preserved.
- `decompose()` public signature preserved (DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001:
  engine frozen at public surface).
- `decomposableChildrenOf()` extension is strictly additive — any AST node kind that
  previously decomposed continues to decompose with byte-identical output. No existing
  enumerated branch is reordered or removed.
- New `@decision DEC-FIX-619-<KIND>-DECOMPOSE-001` annotation added at the point of the
  engine change (the canonical extension pattern).
- Determinism: re-running `decompose()` on the same fixture produces byte-identical
  output (WI-V2-09 byte-identical bootstrap invariant; verifiable on the 3 flipped Group
  A describes via two-pass section if added, but mandatory only when the fix changes
  output shape on a previously-decomposing file — which it should NOT).

### Forbidden shortcuts

- **No** top-of-file "strip TS prelude" pre-processor in `module-graph.ts` or anywhere
  else. The engine must handle the prelude as natural AST (mirrors
  DEC-WI585-NO-EXTRACT-IIFE-SPECIAL-CASE-001 parallel-authority guard).
- **No** writes to `packages/shave/src/__fixtures__/**`.
- **No** modification to `iife-walk.test.ts`, `validator-headline-bindings.test.ts`,
  `semver-headline-bindings.test.ts`, `uuid-headline-bindings.test.ts`,
  `nanoid-headline-bindings.test.ts`, `date-fns-headline-bindings.test.ts`,
  `jsonwebtoken-headline-bindings.test.ts`, `bcryptjs-headline-bindings.test.ts`,
  `lodash-headline-bindings.test.ts`, `p-limit-headline-bindings.test.ts`,
  `p-throttle-headline-bindings.test.ts`.
- **No** modification to `vitest.config.ts` — per-`it()` timeouts only (v3/types.cjs may
  need `{ timeout: 600_000 }` per it() in the §B/C/D path; this is package-test-config
  scope, NOT vitest config).
- **No** "expected-failures" allowlist additions (DEC-SLICER-CALLEE-OBJ-LITERAL-001's
  invariant "every shaveable file shaves" applies).
- **No** patching `extractRequireSpecifiers` or `extractImportSpecifiers` — `forEachDescendant`
  already covers prelude bodies; touching extractors would be a parallel-authority bug.
- **No** silent try/catch in module-graph.ts to paper over a remaining throw. If the
  engine fix doesn't fully resolve the failure, **stop and ask**.
- **No** skipping `pnpm lint && pnpm typecheck && biome format` before push (sacred-practice).
- **No** push without `git fetch origin && git diff --stat origin/main..HEAD` confirming
  intended diff (sacred-practice).
- **No** `git push --force` and **no** rebase outside the worktree's own branch.
- **No** landing without reviewer `REVIEW_VERDICT: ready_for_guardian`.

### Rollback boundary

`git revert <single-commit-sha>` returns the engine to its pre-#619 behavior; the 3
flipped Group A describes re-stub; en.cjs and types.cjs unchanged either way. Single
commit, single revert.

### Acceptance notes

- Engine work on `recursion.ts` is shared territory with WI-510 / #576 / #585. No
  active sister WI on this surface as of 2026-05-17. If a sister WI begins editing
  `recursion.ts` mid-PR, **stop and reconcile** via rebase.
- Single PR, single squash-merge.
- Issue label `serenity` MUST be applied to #619 immediately on implementer pickup (per
  MEMORY feedback) to prevent sister-agent double-pick.
- PR title: `feat(shave): #619 — TS-compiled CJS prelude walk in decompose (closes #619)`
- PR body: `closes #619` (lower-case "closes", per durable memory pattern in PR #627).

### Ready for guardian when

- W1 probe output captured and quoted in PR body (the empirical evidence).
- W1 probe code REMOVED from `module-graph.ts` (verified by `git diff module-graph.ts` = empty).
- `decompose-prelude-walk.test.ts` exists and all 4 §A-D synthetic prelude tests pass.
- `zod-headline-bindings.test.ts` Group A flips correctly:
  - `index.cjs`, `v3/external.cjs`, `v3/index.cjs` all 3 describes assert `>= 1 / == 0
    / > 0` shapes; pass green.
  - `v3/types.cjs` documented per (a) or (b) per implementer's empirical measurement,
    with DEC-FIX-619-TYPES-CJS-POST-FIX-001 added.
  - `v3/locales/en.cjs` untouched, still stubs (confirmed by re-running the describe).
- `iife-walk.test.ts` all 7 it() pass with no regression.
- All other headline-bindings tests pass; any unexpected flip is documented.
- All engine micro-tests pass.
- `plans/fix-619-ts-cjs-prelude.md` committed.
- Full-workspace `pnpm -w lint && pnpm -w typecheck` green.
- `biome format` applied; `git diff --stat origin/main..HEAD` matches `allowed_paths`.
- Reviewer issues `REVIEW_VERDICT: ready_for_guardian` with current head SHA.
- PR opened against `main` with body `closes #619` and `serenity` label applied.

---

## 7. Scope Manifest

### Allowed paths

- `packages/shave/src/universalize/recursion.ts` (the primary fix surface)
- `packages/shave/src/universalize/slicer.ts` (only if probe shows the throw originates
  in slice() — likely NOT)
- `packages/shave/src/universalize/module-graph.ts` (W1 probe only; **must be net-zero
  diff at commit time**)
- `packages/shave/src/universalize/decompose-prelude-walk.test.ts` (NEW file)
- `packages/shave/src/universalize/zod-headline-bindings.test.ts` (Group A assertion
  flips on the 3 prelude-only fixtures; v3/types.cjs per empirical measurement; en.cjs
  untouched)
- `plans/fix-619-ts-cjs-prelude.md` (this file)
- `tmp/fix-619/**` (scratchlane for probe captures; NOT committed)

### Required paths

- `plans/fix-619-ts-cjs-prelude.md` (this file — MUST be in commit)
- `packages/shave/src/universalize/decompose-prelude-walk.test.ts` (MUST be created)

### Forbidden paths

- `packages/shave/src/universalize/atom-test.ts` (unless probe shows fix lives there; if
  so, request scope-sync expansion via `cc-policy workflow scope-sync` BEFORE editing)
- `packages/shave/src/universalize/module-resolver.ts`
- `packages/shave/src/universalize/iife-walk.test.ts` (sibling test, not in scope)
- `packages/shave/src/universalize/validator-headline-bindings.test.ts`
- `packages/shave/src/universalize/semver-headline-bindings.test.ts`
- `packages/shave/src/universalize/uuid-headline-bindings.test.ts`
- `packages/shave/src/universalize/nanoid-headline-bindings.test.ts`
- `packages/shave/src/universalize/date-fns-headline-bindings.test.ts`
- `packages/shave/src/universalize/jsonwebtoken-headline-bindings.test.ts`
- `packages/shave/src/universalize/bcryptjs-headline-bindings.test.ts`
- `packages/shave/src/universalize/lodash-headline-bindings.test.ts`
- `packages/shave/src/universalize/p-limit-headline-bindings.test.ts`
- `packages/shave/src/universalize/p-throttle-headline-bindings.test.ts`
- `packages/shave/src/universalize/module-graph.test.ts`
- `packages/shave/src/universalize/recursion.test.ts`
- `packages/shave/src/universalize/slicer.test.ts`
- `packages/shave/src/universalize/stef.test.ts`
- `packages/shave/src/universalize/atom-test.test.ts`
- `packages/shave/src/universalize/wiring.test.ts`
- `packages/shave/src/index.ts`
- `packages/shave/src/types.ts`
- `packages/shave/src/license/**`
- `packages/shave/src/__fixtures__/**`
- `packages/shave/package.json`, `packages/shave/tsconfig*.json`, `packages/shave/vitest.config.ts`
- `packages/registry/**` (no corpus row changes — Group A files don't bind novel atoms)
- `packages/compile/**`, `packages/contracts/**`, `packages/cli/**`,
  `packages/federation/**`, `packages/ir/**`, `packages/seeds/**`, `packages/variance/**`
- `packages/hooks-base/**`, `packages/hooks-claude-code/**`, `packages/hooks-cursor/**`,
  `packages/hooks-codex/**`
- `.github/**`, `.claude/**`, `MASTER_PLAN.md`, `bench/**`, `docs/**`, `scripts/**`,
  `examples/**`
- `pnpm-workspace.yaml`, `vitest.config.ts` (root), `biome.json`, root `tsconfig*.json`

### Authority domains touched

- `shave-decompose-policy` — adding one new SyntaxKind branch to
  `decomposableChildrenOf` (or extending `safeCanonicalAstHash` fallback).
- `shave-universalize-tests` — adding `decompose-prelude-walk.test.ts` and flipping 3
  zod Group A describes.

---

## 8. Decision Log

| DEC-ID | Status | Title |
|---|---|---|
| DEC-FIX-619-PROBE-BEFORE-PATCH-001 | decided | Implementer MUST run W1 empirical probe to identify the exact throw site before patching. The static trace in §2c is candidate-list-only, not load-bearing. |
| DEC-FIX-619-NARROW-DECOMPOSE-BRANCH-001 | proposed | The fix is a single additive `decomposableChildrenOf` branch (or SafeHash fallback extension) keyed on the SyntaxKind the probe identifies — mirrors PR #627's ParenthesizedExpression branch. |
| DEC-FIX-619-NO-PRELUDE-STRIPPING-001 | decided | The engine must handle the TS prelude as natural AST. No top-of-file text-pattern stripping in `module-graph.ts` or anywhere else (parallel-authority guard, mirrors DEC-WI585-NO-EXTRACT-IIFE-SPECIAL-CASE-001). |
| DEC-FIX-619-EN-CJS-OUT-OF-SCOPE-001 | decided | `v3/locales/en.cjs`'s stub is caused by issue #576 (module-level arrow-fn), NOT #619. en.cjs assertions are NOT flipped here. If en.cjs flips post-fix, the fix is too broad and must be narrowed. |
| DEC-FIX-619-TYPES-CJS-POST-FIX-001 | proposed | `v3/types.cjs` empirical post-fix behavior decides between (a) keep stubbed assertions with comment "#619 fixed but #576 still stubs at body scale" or (b) flip assertions with raised timeouts. Implementer measures, chooses, annotates. |
| DEC-FIX-619-GROUP-B-INVARIANT-001 | decided | All 5 Group B describes + compound describe must remain GREEN with byte-identical output. Any flip is a regression and must be investigated before push. |
| DEC-FIX-619-FULL-WORKSPACE-GATES-001 | decided | Eval Contract uses `pnpm -w lint && pnpm -w typecheck` (full-workspace), not `pnpm -F @yakcc/shave lint`. Matches CI shape per `feedback_eval_contract_match_ci_checks.md`. |

---

## 9. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Probe (W1) reveals the throw is NOT in `decomposableChildrenOf` but in `isAtom` classification or `safeCanonicalAstHash` parsing | Medium | Scope-sync expansion via `cc-policy workflow scope-sync` to add `atom-test.ts` to `allowed_paths` BEFORE editing. Document the unexpected location in the PR body. |
| Fix in `recursion.ts` accidentally regresses another headline-binding test (validator/semver/uuid/etc.) | Medium | W5 runs the FULL test suite, not just zod. Any unexpected flip stops the PR. |
| `v3/types.cjs` post-fix wall-clock exceeds 1200s (current it() timeout of 400_000ms is for STUB state; once decomposing the 3775-line monolith, decompose() walks 39 classes + 131 arrows) | High (if (b) path) | Set per-it() `{ timeout: 1_200_000 }` ONLY for v3/types.cjs sections, AND/OR skip type.cjs §B/C/D with `.skip` + follow-up issue (precedent: bcryptjs-headline-bindings.test.ts §A-E .skip per #625, deferred to follow-up). Document the choice with DEC-FIX-619-TYPES-CJS-POST-FIX-001. |
| `v3/types.cjs` STILL stubs post-fix because issue #576 throws on body walk | Medium | Path (a) of DEC-FIX-619-TYPES-CJS-POST-FIX-001 — keep stubbed assertions, add comment, file follow-up issue for #576-at-scale. |
| Fix unmasks ANOTHER engine gap behind #619 (the prelude was masking a body-walk gap) | Medium | Engine-gap-honest pattern — file new issue, do not block on it. Document in PR body. |
| Fix is too broad — flips `en.cjs` (#576 case) or other unexpected fixtures | Medium | The DEC-FIX-619-EN-CJS-OUT-OF-SCOPE-001 invariant catches this. Narrow the fix until only the intended fixtures flip. |
| Sister WI lands on `recursion.ts` mid-PR | Low | Pre-push `git fetch origin && git diff --stat origin/main..HEAD` surfaces the conflict; rebase before push. No active sister WI as of 2026-05-17. |
| `decompose-prelude-walk.test.ts` synthetic tests pass but real zod fixtures still stub (synthetic-vs-real coverage gap) | Low | W5 mandatory run of `zod-headline-bindings.test.ts` is the real-fixture gate. Synthetic tests are necessary but not sufficient. |
| W1 probe is forgotten in the commit (probe code ships) | Medium | `Required real-path checks` includes `git diff module-graph.ts == empty` as a hard gate. Reviewer must verify. |
| Full-workspace `pnpm -w typecheck` flakes on unrelated workspace package (transient) | Low | Re-run; if persistent, file separate issue and document. Do NOT push around typecheck failures. |

---

## 10. Out of Scope

- **Issue #576** (module-level arrow functions / multi-class monolith decompose) — distinct
  engine gap; remains open after #619 lands. `en.cjs` continues to stub on #576; if
  `types.cjs` continues to stub on #576-at-scale post-fix, that is the (a) path of
  DEC-FIX-619-TYPES-CJS-POST-FIX-001.
- **Issue #585** (UMD IIFE atomization) — closed by PR #627 (`cbefa3c`). Sibling test
  (`iife-walk.test.ts`) is untouched here.
- **bcryptjs section unskip** — gated on follow-up issue #625 (per-section perf budget
  tuning). Out of scope for #619.
- **Corpus row updates** — Group A zod entry-point files don't bind novel atoms in the
  Group A describes (the binding atoms come from Group B helper files). No `corpus.json`
  changes needed for #619.
- **Compile / contracts / registry-src changes** — all forbidden.
- **MASTER_PLAN.md update** — orchestrator concern, not in this scope.
- **PR opening for `v3/types.cjs` flip (path b) with new corpus rows** — out of scope;
  file a follow-up if path (b) is chosen and binds new atoms.

---

## 11. Continuation

On guardian land + PR merge:
- Close #619 via `closes #619` in PR body.
- Inspect post-merge state of `v3/types.cjs`: if path (b) was chosen and it now
  decomposes, evaluate whether to file a WI-510 follow-on issue to capture the new atoms
  in corpus.json for that file (operator-adjudicated; orchestrator concern).
- If `v3/types.cjs` is path (a) (still stubs), the standing #576 issue remains open and
  captures the residual gap.
- Next FuckGoblin orchestrator-loop candidates after #619 land (per durable memory
  `workflow_fuckgoblin_orchestrator_loop.md`): triage open shave-engine issues and
  active WI items. Confirm via runtime, do not infer.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Plan for #619 written to plans/fix-619-ts-cjs-prelude.md; W1 probe step is load-bearing and gates engine fix in recursion.ts (narrow decomposableChildrenOf branch, mirror of PR #627); 3 zod Group A describes flip, en.cjs untouched, types.cjs empirical (a-or-b); full-workspace lint/typecheck eval contract; ready to provision implementer.
