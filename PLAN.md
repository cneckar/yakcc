# PLAN — WI-888 shave-python: SmallStatement Expr handling for docstrings + bare calls

> Planner output for [`#888`](https://github.com/cneckar/yakcc/issues/888)
> (`shave-python: SmallStatement Expr blocks docstrings and side-effectful calls (real-Python killer)`).
> Workflow `wi-888-expr-stmts`, work item `wi-888-plan`, goal `g-888`.
> Branch `feature/888-expr-stmts` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-888-expr-stmts`.
>
> Operator dispatch (2026-05-29): bs4 4.14.3 e2e exploration produced
> 0/15 functions raised. 7 of the 15 hit a single error bucket —
> `Unsupported Python construct for raise to TS-subset IR: SmallStatement Expr`.
> That bucket conflates two distinct constructs: **docstrings** (universal,
> harmless, must be skipped) and **bare expression calls / statements**
> (side-effectful, must be rejected as impure, not as "unsupported").
> The current `_stmt_inner()` in `libcst-parse.py` returns
> `{"type": "Unsupported", "reason": "SmallStatement Expr"}` for every
> `libcst.Expr` SmallStatement.

---

## 0 — Headline

Teach `_stmt_inner()` in `packages/shave-python/scripts/libcst-parse.py` to
recognize three SmallStatement-Expr shapes and emit two new wire-node types:

1. **`{"type": "Docstring", "value": "<str>"}`** — when the Expr wraps a
   string-literal expression (`SimpleString`, `ConcatenatedString`, or
   `FormattedString`) **and** this is the first statement of the function
   body. The TS `renderStmt` silently skips this node.
2. **`{"type": "ImpureStatement", "construct": "bare_call" | "bare_expression", "detail": "<str>"}`** —
   when the Expr wraps a `Call` (bare-call shape: `print(...)`, method calls)
   or any other expression-statement that isn't a docstring. The TS
   `renderStmt` throws `ImpureFunctionError` with `kind: "forbidden_construct"`.
3. Extend `ImpurityKind` in `purity-check.ts` from
   `"forbidden_import" | "forbidden_call" | "forbidden_attr" | "global_decl"`
   to include `"forbidden_construct"`.

This is a wire-additive change. Existing wire-node types (`Return`, `Pass`,
`Raise`, `Unsupported`) are unchanged. `raise-body.ts` gains two new switch
arms in `renderStmt`. `purity-check.ts` gains one `ImpurityKind` member.
The libcst-parse.py change is localized to `_stmt_inner()` (and an
optional first-stmt flag piped through `_function_envelope` so the docstring
detection can fire only on the first body element).

---

## 1 — Problem decomposition (challenge the requirement first)

### Restated in my own words

In production Python, every PEP-257-compliant function starts with a triple-
quoted docstring. Today the libcst parser sees that string expression-
statement, can't classify it, and emits a generic `Unsupported SmallStatement
Expr` wire node. The TS-side `renderStmt` then throws
`UnsupportedAstError("SmallStatement Expr")`. End result: 100% of PEP-257
functions fail to raise, masking the real downstream failures.

The same generic error also fires for bare expression-statements with side
effects: `print(x)`, `parser.feed(data)`, `sys.stdout.write(...)`. Those
should also fail, but they should fail as **impurity violations**, not as
"unsupported syntax." The error taxonomy is the load-bearing claim — users
seeing `UnsupportedAstError` will file bugs asking for support; users seeing
`ImpureFunctionError` understand they're using a feature outside the pure
shave context.

### Goals (measurable)

1. **G1** — A function whose first body statement is a docstring raises
   successfully (no error from raise-body), with the docstring value silently
   dropped from emitted TS-subset IR. Verified by a new e2e test in
   `raise-function.test.ts`.
2. **G2** — A function whose body contains a bare expression-statement
   (e.g. `print(x)`) throws `ImpureFunctionError` with `kind:
   "forbidden_construct"`, NOT `UnsupportedAstError`. Verified by a new test
   in `raise-body.test.ts` and an e2e test in `raise-function.test.ts`.
3. **G3** — All other existing wire shapes (`Return`, `Pass`, `Raise`,
   `Unsupported`, expressions) behave byte-identically to pre-WI HEAD.
   Verified by existing `raise-body.test.ts` + `libcst-parser.test.ts` +
   `purity-check.test.ts` suites staying green.
4. **G4** — Post-merge, re-running the bs4 exploration (out of scope here,
   but documented as a follow-up validation step in #888) shows the 7
   SmallStatement-Expr blockers drop from the failure tally. This is the
   real-world success metric for the issue.

### Non-goals (explicit exclusions)

- **Class-level docstrings.** PEP-257 also defines class-body docstrings;
  this WI handles function-body docstrings only. Class docstrings are
  tracked in follow-up #890 (class-method extraction) and re-raised there.
- **Module-level docstrings.** Same reasoning — out of scope; deferred.
- **`Expr(Yield)` / `Expr(Await)`.** These are statement-level await/yield
  expressions used as side-effecting calls. They are also impure. The plan
  classifies them under the catch-all `bare_expression` branch with detail
  carrying the expression type name. A future WI can split them into their
  own taxonomy if needed.
- **Touching `type-map.ts`, `parse-fn-signature.ts`, `normalize-names.ts`.**
  Forbidden by scope manifest. These cover different concerns (#889
  type-map, etc).
- **Adapter consumer packages.** `packages/compile-python/**`, `packages/cli/**`,
  `packages/shave/**`, `packages/compile/**`, `packages/contracts/**`,
  `bootstrap/**`, `.github/**`, `.claude/**` — all forbidden. WI is
  shave-python-internal.
- **Pyright escalation / deeper static purity.** Out of scope. The new
  `forbidden_construct` impurity kind is detected purely from the wire AST
  shape, no new analysis layer.
- **MASTER_PLAN.md churn.** Decision log additions are in-file
  `@decision` annotations; a post-landing planner pass can graduate them to
  MASTER_PLAN if the operator wants.

### Unknowns and ambiguities — resolved at planning time

1. **Should docstring detection use Option A (emit `Docstring` wire node,
   TS skips) or Option B (skip emission in Python)?**
   Resolved: **Option A**. Rationale: the wire envelope is the canonical
   record; having `Docstring` visible there is useful for downstream tooling
   (`compile-python` could re-emit it, future linting could read it) and
   matches the existing pattern where the Python layer emits structure and
   the TS layer decides rendering. Recorded as DEC-WI888-001.

2. **What does "first statement" mean for docstring detection?** PEP-257
   defines it as "the first statement of a function or class body that is a
   string literal." For functions specifically, this is the first element of
   `fn.body.body` after libcst's IndentedBlock unwrapping. Resolved by
   passing an `is_first` flag from `_function_envelope` into `_stmt_inner`.

3. **What ImpurityKind label fits a bare expression statement best?**
   Choices considered: `"bare_expression"`, `"forbidden_construct"`,
   `"side_effect"`. Resolved: **`"forbidden_construct"`** (matches the issue
   #888 acceptance criteria, is generic enough to absorb other future
   "this construct isn't allowed in pure functions" cases, and reads
   naturally in error messages). Recorded as DEC-WI888-004.

4. **Does purity-check.ts already catch `print(x)` via FORBIDDEN_BUILTINS?**
   Resolved by reading purity-check.ts:
   `collectBodyImpurities` only recurses into `value` of `Return`, `Expr`,
   `Assign` nodes. Today there is no `Expr` wire-stmt node (libcst-parse.py
   emits `Unsupported` instead), so the walker never sees the Call. Even
   after this WI lands, the walker won't see the new `ImpureStatement` wire
   node because that node has no `value` field shaped like the existing
   walker expects. **Decision (DEC-WI888-005):** the `ImpureStatement` wire
   node is consumed by `raise-body.ts:renderStmt` which throws
   `ImpureFunctionError` directly. The throw fires from the rendering pass,
   not from the pre-mapping `checkPurity` pass. This is consistent with
   how `Unsupported` is handled today — the wire node's class (impure vs
   unsupported) determines which error class fires.

5. **Should `raise-function.ts` reorder anything?** Resolved: **no**.
   `checkFunctionPurity` runs pre-mapping and inspects `fnRecord.body`.
   After this WI, that body array can contain `Docstring` and
   `ImpureStatement` nodes; the existing walker visits each stmt via
   `visitStmt` and only branches on type strings it knows. The new nodes
   are not recognized, so they don't generate violations during
   `collectBodyImpurities` — that's fine because the throw fires at render
   time via `renderStmt`. The render pass runs **after** `checkFunctionPurity`
   in the pipeline. End behavior: pure function with `print(x)` →
   `checkFunctionPurity` returns clean (no `forbidden_call` recorded because
   the wire-AST walker doesn't recurse into `ImpureStatement.detail`) →
   `renderBody` throws `ImpureFunctionError(forbidden_construct, "print(...)")`.
   Recorded as DEC-WI888-006.

### Dominant constraints

- Sacred Practice #12: single source of truth — the new wire-node types are
  defined in `libcst-parse.py` (Python side, canonical wire shape), mirrored
  in `raise-body.ts` (`WireStmt` union), and have **no other definitions**.
- Sacred Practice #5: real unit tests, fail loudly. The error taxonomy
  change is testable at three layers: wire (libcst-parser.test.ts), render
  (raise-body.test.ts), and e2e (raise-function.test.ts).
- Memory `feedback_pre_push_hygiene`: rebase + lint + typecheck before push.
- Memory `feedback_branch_must_track_origin_main`:
  `git fetch && git diff --stat origin/main..HEAD` before push.
- Memory `feedback_serenity_claim_label`: `gh issue edit 888 --add-label serenity`
  before any PR push to prevent sister-agent double-pick.
- Memory `feedback_agent_tool_completion_projection_gap`: reviewer must
  explicitly run `cc-policy evaluation set ready_for_guardian` once verdict
  is `ready_for_guardian`.
- Memory `feedback_implementer_cannot_commit`: implementer stages; guardian
  composes the commit. The implementer must not run `git commit` directly.

---

## 2 — State authorities & integration surfaces

| Domain                                                       | Authority (canonical)                                            | This WI relationship                                                                                                  |
|--------------------------------------------------------------|------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Python wire-AST envelope shape                               | `packages/shave-python/scripts/libcst-parse.py`                  | **Extends** — adds `Docstring` and `ImpureStatement` wire nodes in `_stmt_inner` / first-stmt detection in `_function_envelope` |
| TS wire-AST type union (`WireStmt`)                          | `packages/shave-python/src/raise-body.ts`                        | **Extends** — adds two new variants to `WireStmt`                                                                     |
| Statement renderer (TS-subset IR text emission)              | `packages/shave-python/src/raise-body.ts` (`renderStmt`)         | **Extends** — adds two new switch arms                                                                                |
| `ImpurityKind` enum                                          | `packages/shave-python/src/purity-check.ts`                      | **Extends** — adds `"forbidden_construct"` member to the union                                                        |
| `ImpureFunctionError` constructor + shape                    | `packages/shave-python/src/purity-check.ts`                      | **Reused unchanged** — constructor signature stays `(functionName, kind, detail, line?, col?)`                        |
| `checkFunctionPurity` body walker                            | `packages/shave-python/src/purity-check.ts`                      | **Read-only** — the new wire nodes are ignored by `collectBodyImpurities` by design (the throw fires at render time)  |
| Raise pipeline composition order                             | `packages/shave-python/src/raise-function.ts`                    | **Unchanged** — order stays purity-check → normalize → render; render now also throws `ImpureFunctionError` from `bare_expression` wire nodes |
| Subprocess wire format / version field                       | `packages/shave-python/scripts/libcst-parse.py` (`"version": 1`) | **Unchanged** — additive node types, no schema bump needed                                                            |
| Existing `Unsupported` wire-node path for unknown SmallStmts | `packages/shave-python/scripts/libcst-parse.py` (`_stmt_inner`)  | **Narrowed** — `libcst.Expr` no longer falls through to `Unsupported`; other SmallStatement classes still do          |

### Existing-mechanism survey (Sacred Practice #12)

Before adding any new wire-node type, I verified that today's behavior for
`libcst.Expr` SmallStatements is the catch-all `{"type": "Unsupported",
"reason": "SmallStatement Expr"}` in `_stmt_inner()` (`libcst-parse.py:270`).
There is no separate Python-side path for string-literal expression
statements. The TS-side `renderStmt` has no `Expr` arm — it relies entirely
on the wire shape from Python.

`ImpurityKind` is defined exactly once, in `purity-check.ts:118`. No other
file uses `forbidden_call | forbidden_import | ...` as a string-literal
union; all consumers import the type.

`ImpureFunctionError` constructor is invoked from `purity-check.ts` only
today; after this WI it will also be invoked from `raise-body.ts`. This
expands the throw surface but does not create a parallel error class.

There is no existing helper for "is this stmt the first stmt of a body?" in
the Python script — the `_function_envelope` function iterates `fn.body.body`
without tracking position. The change adds an `enumerate(...)`-style index
through and an `is_first=...` parameter to `_stmt_v2 / _stmt_inner`. This
is the minimum change; no helper is being replaced.

---

## 3 — Architecture design

### 3.1 Wire-shape changes (Python side — canonical authority)

`_stmt_inner(inner, is_first=False)` in `libcst-parse.py`:

```python
def _stmt_inner(inner, is_first=False):
    if isinstance(inner, libcst.Return): ...
    if isinstance(inner, libcst.Pass): ...
    if isinstance(inner, libcst.Raise): ...

    # NEW — SmallStatement Expr handling (WI-888)
    if isinstance(inner, libcst.Expr):
        value = inner.value
        # Docstring: first stmt + string-literal expression
        if is_first and isinstance(
            value,
            (libcst.SimpleString, libcst.ConcatenatedString, libcst.FormattedString),
        ):
            text = _docstring_text(value)
            return {"type": "Docstring", "value": text}
        # Bare call: print(x), parser.feed(data), sys.stdout.write(...)
        if isinstance(value, libcst.Call):
            detail = _bare_call_repr(value)
            return {
                "type": "ImpureStatement",
                "construct": "bare_call",
                "detail": detail,
            }
        # Other bare expression-statements: x + y, obj.attr, x and y, ...
        # These are either dead code or side-effecting __getattr__ traps.
        return {
            "type": "ImpureStatement",
            "construct": "bare_expression",
            "detail": type(value).__name__,
        }

    return {"type": "Unsupported", "reason": f"SmallStatement {type(inner).__name__}"}
```

`_function_envelope(fn, module=None)` adds index tracking when iterating
body stmts:

```python
for idx, stmt in enumerate(fn.body.body):
    body.append(_stmt_v2(stmt, is_first=(idx == 0)))
```

`_stmt_v2(node, is_first=False)` plumbs `is_first` to `_stmt_inner`.

Helper `_docstring_text(value)`: extract the string content. For
`SimpleString`, strip the surrounding quotes (the existing `_expr` arm
already does this for `SimpleString`; reuse the same logic). For
`ConcatenatedString`, concatenate parts. For `FormattedString` (f-string
docstring — rare but legal PEP-257), fall back to the libcst `code` property
trimmed. The exact string value is observability only — the TS renderer
discards it.

Helper `_bare_call_repr(call)`: produce a short human-readable string like
`"print(...)"` or `"parser.feed(...)"`. Use `_callee_name(call.func)` if
available; otherwise `"<complex-callee>(...)"`. The `(...)` suffix is fixed;
we don't attempt to render arguments — the detail is for error messages,
not for replay.

### 3.2 Wire-shape changes (TS side — `WireStmt` union)

`raise-body.ts`:

```ts
export type WireStmt =
  | { readonly type: "Return"; readonly value: WireExpr | null }
  | { readonly type: "Pass" }
  | { readonly type: "Raise"; readonly excClass: string; readonly message: WireExpr | null }
  | { readonly type: "Docstring"; readonly value: string }                                   // NEW
  | {                                                                                         // NEW
      readonly type: "ImpureStatement";
      readonly construct: "bare_call" | "bare_expression";
      readonly detail: string;
    }
  | { readonly type: "Unsupported"; readonly reason: string };
```

### 3.3 Renderer changes (`renderStmt` in `raise-body.ts`)

New error class to carry the construct/detail across the boundary without
coupling raise-body.ts to purity-check.ts's `ImpureFunctionError` directly:
**rejected**. Instead, `raise-body.ts` imports `ImpureFunctionError` from
`purity-check.ts` and throws it. `purity-check.ts` already exports the
class; `raise-body.ts` will gain a dependency edge to `purity-check.ts`.

Verify no import cycle: `purity-check.ts` does NOT import from
`raise-body.ts` today (only `libcst-parser.js` types). Safe.

`renderStmt` switch arms:

```ts
case "Docstring":
  // Silently drop. The wire envelope retains the value for downstream
  // tooling; the TS-subset IR has no equivalent and we don't fabricate one.
  return "";

case "ImpureStatement":
  // The renderer doesn't know the function name. Throw with a placeholder
  // and let the caller (raise-function.ts) wrap/re-throw with the real name,
  // OR pass the function name as a render context. See DEC-WI888-007.
  throw new ImpureFunctionError(
    "<unknown>",
    "forbidden_construct",
    `${stmt.construct === "bare_call" ? "calls" : "evaluates"} bare expression-statement: ${stmt.detail}`,
  );
```

**DEC-WI888-007: function-name plumbing for `ImpureFunctionError`.**

`renderStmt` does not currently take a function name. Options:
- (a) Thread a `fnName?: string` parameter through `renderStmt` / `renderBody`.
- (b) Throw with `"<unknown>"` and let `raiseFunctionWithPurityAndNormalization`
  catch + rewrap with the real name.
- (c) Add an optional second arg to `renderBody(stmts, indent, fnName?)`.

**Decision: (c)** — extend `renderBody(stmts, indent = "  ", fnName?: string)`
with an optional fnName. When set, the function passes it to `renderStmt`
which uses it in the thrown `ImpureFunctionError`. When unset (existing
callers), the throw uses `"<unknown>"` as a sentinel. This preserves
backward compatibility for any external callers of `renderBody`/`renderStmt`
and avoids a catch+rewrap layer in `raiseFunctionWithPurityAndNormalization`.

`renderFunctionDeclaration` (in `raise-function.ts`) already has the
signature in hand — it passes `signature.name` as the third arg to
`renderBody`.

### 3.4 `renderBody` adjustment for empty-after-docstring

Today: `renderFunctionDeclaration` checks `body.length === 0` and emits
`"  void 0;"`. After this WI a body like `["Docstring"]` has length 1 but
`renderBody` produces `""` — the function body would be empty, syntactically
fine in TS but not what we want.

**Decision (DEC-WI888-008):** treat a docstring-only body as "effectively
empty" for the void-0 fallback. Change the check from
`body.length === 0` to:

```ts
const visibleStmts = body.filter((s) => s.type !== "Docstring");
const bodyText = visibleStmts.length === 0 ? "  void 0;" : renderBody(body, "  ", signature.name);
```

This keeps the void-0 escape hatch for `def foo(): """only a docstring"""`
which is otherwise a no-op function. (Note: such a function is rare but
legal Python — usually paired with `pass` or a `Return`.)

### 3.5 `ImpurityKind` extension (`purity-check.ts`)

```ts
export type ImpurityKind =
  | "forbidden_import"
  | "forbidden_call"
  | "forbidden_attr"
  | "global_decl"
  | "forbidden_construct";  // NEW — bare expression-statement (WI-888)
```

`normalizeImpurityKind` (existing helper for envelope-supplied kinds) adds
the new case:

```ts
case "forbidden_construct":
  return kind;
```

This is the only `purity-check.ts` edit. The walker, the error class, the
`checkFunctionPurity` / `checkModuleImports` / `checkPurity` public surface
stay byte-identical.

### 3.6 Test seam

Three test layers, mirroring the three code layers:

**Layer 1 — wire (`libcst-parser.test.ts`):** spawn the subprocess against
small fixture Python source files. Assert the wire JSON shape:
- Function with first-stmt docstring → first body element is
  `{type: "Docstring", value: "..."}`
- Function with `print(x)` body → body contains
  `{type: "ImpureStatement", construct: "bare_call", detail: "print(...)"}`
- Function with `obj.attr` as a statement → body contains
  `{type: "ImpureStatement", construct: "bare_expression", detail: "Attribute"}`
- Existing wire tests stay green.

These are subprocess tests; they require Python 3 + libcst. Follow the
gate pattern already used by the suite (skip when unavailable).

**Layer 2 — render (`raise-body.test.ts`):** envelope-injection unit tests
(no subprocess). Build `WireStmt` arrays directly. Assert:
- `renderStmt({type: "Docstring", value: "..."})` returns `""`
- `renderStmt({type: "ImpureStatement", construct: "bare_call", detail: "print(...)"}, "  ", "foo")`
  throws `ImpureFunctionError` with `kind === "forbidden_construct"` and
  `functionName === "foo"`
- Same for `bare_expression`
- Without `fnName`, throws with `functionName === "<unknown>"`
- Docstring-only body via `renderFunctionDeclaration` produces a
  `void 0;` body (DEC-WI888-008)

**Layer 3 — e2e (`raise-function.test.ts`):** envelope-injection through the
full `raiseFunctionWithPurityAndNormalization` pipeline. Assert:
- A function with `"""docstring"""` + `return 42` raises successfully and
  produces the expected `export function …` text with no docstring artifact
- A function with `print(x)` body throws `ImpureFunctionError`
  (not `UnsupportedAstError`), with `kind === "forbidden_construct"` and
  the function name populated
- Purity check still runs first for pre-existing impurity (e.g. forbidden
  import) — the new render-time throw doesn't shadow the pre-mapping
  purity verdict
- Function with `bare_expression` (e.g. `x and y` as a stmt) throws
  `ImpureFunctionError`

**Layer 4 — purity-check.test.ts:** one additional test asserting
`ImpurityKind` covers `"forbidden_construct"`. No new walker behavior; this
is a type-level smoke test that exercises the new union member through the
public API.

No new fixture files needed beyond inline Python snippets used by the
existing subprocess tests.

---

## 4 — Design decisions

### DEC-WI888-001 — Emit `Docstring` wire node (Option A, not skip)

**Decision.** When the Python side detects a docstring (first stmt of fn
body + string-literal expression), it emits
`{"type": "Docstring", "value": "<unquoted text>"}` into the body array.
The TS side ignores it during render.

**Rejected alternative.** Option B — skip emission entirely in
`libcst-parse.py`. Rejected because the wire envelope is the canonical
record; future tooling (compile-python re-emit, doc extraction, lint) may
want access to the docstring. Emitting the node is additive and free.

### DEC-WI888-002 — Bare-call detection via `Expr(Call)`

**Decision.** `isinstance(inner, libcst.Expr) and isinstance(inner.value,
libcst.Call)` → emit
`{"type": "ImpureStatement", "construct": "bare_call", "detail": "<callee>(...)"}`.

`detail` uses `_callee_name(call.func)` (existing helper) to produce a
short string like `"print"` or `"parser.feed"` and appends `(...)`. No
attempt to render arguments — the detail is for error messages, not
replay.

### DEC-WI888-003 — Catch-all bare-expression detection via `Expr(*)`

**Decision.** Any `libcst.Expr` SmallStatement that is neither a docstring
(DEC-WI888-001) nor a bare call (DEC-WI888-002) is emitted as
`{"type": "ImpureStatement", "construct": "bare_expression", "detail": "<expr-type-name>"}`.

This catches `Expr(BooleanOperation)`, `Expr(BinaryOperation)`,
`Expr(Attribute)`, `Expr(Subscript)`, `Expr(Yield)`, `Expr(Await)`, etc.
The semantic claim: if you wrote it as a statement and it's not a
return/raise/pass/assignment, it's either dead code OR has side effects
(via `__getattr__`, generator advance, etc.). Neither is acceptable in a
pure-function shave context. The error taxonomy is correct.

### DEC-WI888-004 — `ImpurityKind` extension: `"forbidden_construct"`

**Decision.** Extend `ImpurityKind` with `"forbidden_construct"`. Used for
both `bare_call` and `bare_expression` wire-node throws.

Rejected: `"bare_expression"` (too specific — wouldn't fit `bare_call`).
Rejected: re-using `"forbidden_call"` for `bare_call` (the existing
`forbidden_call` is for FORBIDDEN_BUILTINS lookups in `collectBodyImpurities`,
a different mechanism; mixing them would conflate two different detection
paths). `forbidden_construct` is the operator-decided label per #888
acceptance criteria.

### DEC-WI888-005 — `ImpureStatement` wire nodes throw at render time

**Decision.** `ImpureStatement` wire nodes are consumed by
`raise-body.ts:renderStmt`, which throws `ImpureFunctionError` directly.
The `checkFunctionPurity` body walker (`collectBodyImpurities`) is **not**
extended to recognize `ImpureStatement` nodes — the throw fires from the
render pass, which runs after the purity-check pass in
`raise-function.ts`.

**Rationale.** Cleaner separation: `checkFunctionPurity` inspects existing
wire-AST shapes (`Call`, `Attribute`, `Global`, ...) and walks expression
trees. The new wire-AST nodes are statement-level classifications that
the Python side has already determined are impure — there is no walking
needed. The TS layer recognizes them and throws. This avoids duplicating
the impurity claim across two passes.

**Trade-off.** A future refactor could move all impurity detection into
`checkFunctionPurity` (running it on the wire-AST it already walks). Today,
keeping the throw at render time means a function with a mixed
`(forbidden_call_via_FORBIDDEN_BUILTINS, bare_call)` body throws on the
first impurity found, which is the existing semantics for
`checkFunctionPurity`. Documented for future widening.

### DEC-WI888-006 — Pipeline order unchanged

**Decision.** `raiseFunctionWithPurityAndNormalization` continues to call
`checkFunctionPurity` → `normalizeSignatureNames` → `normalizeBodyNames` →
`renderFunctionDeclaration`. The new throw happens inside
`renderFunctionDeclaration` (via `renderBody` → `renderStmt`). Per
DEC-WI888-005 this is the correct place; no pipeline reordering.

### DEC-WI888-007 — `fnName` plumbing into `renderBody` / `renderStmt`

**Decision.** Extend `renderBody(stmts, indent, fnName?)` and
`renderStmt(stmt, indent, fnName?)` with an optional third parameter.
`renderFunctionDeclaration` passes `signature.name` through. External
callers pre-WI continue to work; the throw falls back to `"<unknown>"` as
function name when not supplied.

Rejected alternative: catch+rewrap in `raise-function.ts`. Rejected because
the catch would swallow stack context and the error class identity is
already `ImpureFunctionError` — no need to wrap.

### DEC-WI888-008 — Docstring-only body emits `void 0;`

**Decision.** In `renderFunctionDeclaration`, the empty-body check filters
out `Docstring` nodes before deciding whether to emit the `void 0;`
fallback:

```ts
const visibleStmts = body.filter((s) => s.type !== "Docstring");
const bodyText = visibleStmts.length === 0 ? "  void 0;" : renderBody(body, "  ", signature.name);
```

Rationale: a Python function with only a docstring (`def foo(): """doc"""`)
is a legal no-op. Emitting just an empty body would produce
`export function foo(): T {\n\n}` which is valid TS but visually empty.
`void 0;` is the existing convention for "this function is intentionally a
no-op."

---

## 5 — Wave decomposition (implementer slicing guidance)

Single PR. The implementer slices it locally as commits.

| W-ID    | Item                                                                                                  | Wt | Deps | Gate           |
|---------|-------------------------------------------------------------------------------------------------------|----|------|----------------|
| W-888-A | `libcst-parse.py` — add docstring + bare-call + bare-expression detection in `_stmt_inner` + thread `is_first` through `_function_envelope` / `_stmt_v2`; add `_docstring_text` and `_bare_call_repr` helpers | S  | —    | tests          |
| W-888-B | `raise-body.ts` — extend `WireStmt` union with `Docstring` and `ImpureStatement` variants; add two `renderStmt` switch arms; extend `renderBody`/`renderStmt` signatures with optional `fnName` | S  | A    | tests + typecheck |
| W-888-C | `purity-check.ts` — extend `ImpurityKind` with `"forbidden_construct"`; add the case to `normalizeImpurityKind`; add `@decision DEC-WI888-004` annotation | S  | —    | tests + typecheck |
| W-888-D | `raise-function.ts` — pass `signature.name` to `renderBody`; update empty-body check to filter `Docstring` per DEC-WI888-008                          | S  | B,C  | tests          |
| W-888-E | Tests — `libcst-parser.test.ts` (wire), `raise-body.test.ts` (render), `purity-check.test.ts` (kind union smoke), `raise-function.test.ts` (e2e)        | M  | A-D  | tests          |

Critical path: A,C parallel → B (depends on A) → D (depends on B,C) → E.
Max parallel width: 2 (A and C may proceed in parallel).

The implementer is free to land the slices as a single commit if review is
quick; the table is guidance, not enforcement.

---

## 6 — Evaluation Contract (canonical — persisted via `tmp/888-evaluation.json`)

### Required tests (vitest unit + subprocess)

1. **`libcst-parser.test.ts`** — subprocess wire-shape tests:
   - First-stmt docstring (`def foo(x: int) -> int: """doc"""\n  return x`) →
     body is `[{type:"Docstring", value:"doc"}, {type:"Return", ...}]`
   - Triple-quoted docstring with newlines → same shape, value preserves
     content (whitespace handling per `_docstring_text` impl)
   - Bare call (`def foo(x: int) -> None: print(x)`) → body is
     `[{type:"ImpureStatement", construct:"bare_call", detail:"print(...)"}]`
   - Method-call bare statement (`obj.method()`) → `detail:"obj.method(...)"`
   - Bare attribute (`x.y` as stmt) → body contains `{type:"ImpureStatement",
     construct:"bare_expression", detail:"Attribute"}`
   - String-literal NOT in first-stmt position (e.g.
     `def foo(): return 1; "trailing"` — synthesized via two-stmt body) →
     emits `ImpureStatement(bare_expression, detail:"SimpleString")`, NOT
     `Docstring`. Asserts the `is_first` flag works.

2. **`raise-body.test.ts`** — render-layer unit tests (envelope injection):
   - `renderStmt({type:"Docstring", value:"x"})` returns `""`
   - `renderStmt({type:"ImpureStatement", construct:"bare_call", detail:"print(...)"}, "  ", "foo")`
     throws `ImpureFunctionError` with `kind === "forbidden_construct"`,
     `functionName === "foo"`, `detail` contains `"print(...)"`
   - Same for `bare_expression` with `detail:"Attribute"`
   - `renderStmt(..., "  ")` without fnName throws with
     `functionName === "<unknown>"`
   - `renderBody([{type:"Docstring", value:"x"}], "  ", "foo")` returns `""`
   - Existing tests stay green (`Return`, `Pass`, `Raise`, `Unsupported`,
     `BinaryOp`, etc.)

3. **`purity-check.test.ts`** — type-union smoke:
   - Construct `ImpureFunctionError("f", "forbidden_construct", "bare call: print(...)")`
     and assert `kind === "forbidden_construct"` (compile-time + runtime
     smoke that the union accepts the new member)
   - Existing 200+ assertions in this file stay green

4. **`raise-function.test.ts`** — e2e via envelope injection:
   - Function `def foo(x: int) -> int: """doc"""\n  return x` raises
     successfully → output text equals
     `export function foo(x: number): number {\n  return x;\n}` (no
     docstring artifact)
   - Function `def foo(x: int) -> None: print(x)` throws
     `ImpureFunctionError` with `kind === "forbidden_construct"`,
     `functionName === "foo"`, NOT `UnsupportedAstError`
   - Function `def foo(): """only"""` (docstring-only body, after Pass-less
     legal Python edge) raises successfully → output has `void 0;` body
     (DEC-WI888-008)
   - Function with a forbidden import + bare call → `checkFunctionPurity`
     fires FIRST with `forbidden_import` kind (existing semantics preserved;
     bare call is not seen because purity check rejects pre-mapping)
   - Function with `obj.attr` bare stmt → throws `ImpureFunctionError(
     forbidden_construct, "...Attribute...")`

### Required evidence (paste verbatim in PR description)

- `pnpm --filter @yakcc/shave-python test` raw output (all green, including
  the new subprocess tests for libcst-parser).
- One subprocess transcript: pipe a sample Python function with docstring
  into `python3 packages/shave-python/scripts/libcst-parse.py` and show
  the resulting JSON contains the new `Docstring` and/or `ImpureStatement`
  nodes.
- Optional regression evidence: a one-paragraph note in the PR description
  recording that the 7 bs4 SmallStatement-Expr failures are expected to
  drop on the next exploration run (this WI does not include the
  exploration itself — that's the issue's acceptance step, run by the
  operator post-merge).

### Required real-path checks

- `_stmt_inner` in `libcst-parse.py` has explicit branches for
  `Docstring`, `bare_call`, `bare_expression` BEFORE the fall-through to
  `{"type":"Unsupported"}`.
- `WireStmt` union in `raise-body.ts` contains exactly these variants:
  `Return | Pass | Raise | Docstring | ImpureStatement | Unsupported`.
- `renderStmt` in `raise-body.ts` has a switch arm for each `WireStmt`
  variant (TypeScript exhaustiveness check forces this).
- `ImpurityKind` in `purity-check.ts` includes `"forbidden_construct"`.
- `_function_envelope` passes `is_first=True` for index 0 and
  `is_first=False` for all other indices to `_stmt_v2` / `_stmt_inner`.
- `renderFunctionDeclaration` filters `Docstring` nodes before deciding
  the void-0 fallback (DEC-WI888-008).
- No throws of `UnsupportedAstError` for bare-call or docstring inputs in
  any test (verified by negative assertions in `raise-body.test.ts` and
  `raise-function.test.ts`).

### Required authority invariants

- **Zero touched files outside the scope manifest.** Specifically: no edits
  to `packages/shave-python/src/type-map.ts`,
  `packages/shave-python/src/parse-fn-signature.ts`,
  `packages/shave-python/src/normalize-names.ts`,
  `packages/compile-python/**`, `packages/cli/**`, `packages/shave/**`,
  `packages/compile/**`, `packages/contracts/**`, `bootstrap/**`,
  `.github/**`, `.claude/**`.
- **Wire-schema `version` field unchanged.** Additive node types only;
  consumers that don't recognize them get `Unsupported`-like fallback via
  TypeScript exhaustiveness (compile-time) — no runtime schema breakage.
- **`ImpureFunctionError` constructor signature unchanged.** Same
  `(functionName, kind, detail, line?, col?)` shape. Tests touching the
  constructor stay byte-identical.
- **No new state authority introduced.** This WI is a pure shape extension.

### Required integration points

- `libcst-parse.py` emits the new wire nodes; `raise-body.ts` is the sole
  consumer of `WireStmt`; `purity-check.ts` is the sole owner of
  `ImpurityKind`.
- `raise-body.ts` imports `ImpureFunctionError` from
  `./purity-check.js` (verified to not create a cycle: `purity-check.ts`
  does not import from `./raise-body.js`).
- `raise-function.ts` passes `signature.name` to `renderBody` so the
  thrown error carries the function name.

### Forbidden shortcuts

- Do NOT change the existing wire-node types (`Return`, `Pass`, `Raise`,
  `Unsupported`) — additive only.
- Do NOT widen `checkFunctionPurity`'s walker to handle `ImpureStatement`
  wire nodes; per DEC-WI888-005 the throw fires at render time. Adding a
  parallel detection path duplicates the impurity claim.
- Do NOT introduce a new error class. Reuse `ImpureFunctionError` from
  `purity-check.ts`.
- Do NOT thread `is_first` via a global or module-level variable —
  parameter-passing only (preserves testability of `_stmt_v2`).
- Do NOT touch `type-map.ts`, `parse-fn-signature.ts`,
  `normalize-names.ts` (forbidden by scope manifest; separate WI
  territory).
- Do NOT skip the `forbidden_construct` case in `normalizeImpurityKind` —
  the default-case fallback to `"forbidden_call"` would silently mis-label
  envelope-supplied violations.
- Do NOT commit on `main` (memory `feedback_no_main_branch_commits`).
- Do NOT run `git commit` from the implementer role (memory
  `feedback_implementer_cannot_commit`) — guardian:land composes the
  commit.

### Rollback boundary

Single PR. Reverting the merge restores prior state cleanly because:
(a) the libcst-parse.py changes are additive branches before the catch-all
fallback — reverting deletes them and the catch-all resumes;
(b) `WireStmt` union additions and `ImpurityKind` addition are type-only;
reverting deletes them and TypeScript exhaustiveness re-tightens;
(c) `renderBody` / `renderStmt` signature additions are backward-compatible
(optional parameter); reverting deletes them and existing callers continue;
(d) no state authority introduced.

### Ready-for-guardian when

- All required tests pass under `pnpm --filter @yakcc/shave-python test`.
- Repo-root tests green (`pnpm test`) — or at minimum, no new failures
  introduced (some pre-existing benches/bootstrap suites may already be
  red; the implementer documents any prior-art noise in the PR).
- `pnpm lint` and `pnpm typecheck` clean for the shave-python package
  (memory `feedback_pre_push_hygiene`).
- `git -C <worktree> fetch origin && git -C <worktree> diff --stat
  origin/main..HEAD` shows only files allowed by the scope manifest;
  rebase onto `origin/main` is clean (memory
  `feedback_branch_must_track_origin_main`).
- All §6 "Required evidence" outputs pasted into the PR description.
- Reviewer issued `REVIEW_VERDICT=ready_for_guardian` (or equivalent
  trailer) and the projection ran `cc-policy evaluation set
  ready_for_guardian` for the workflow (memory
  `feedback_agent_tool_completion_projection_gap`).
- `gh issue edit 888 --add-label serenity` ran successfully (memory
  `feedback_serenity_claim_label`).

---

## 7 — Scope Manifest (canonical — persisted via `cc-policy workflow scope-sync`)

### Allowed paths (implementer may touch)

- `packages/shave-python/scripts/libcst-parse.py`
- `packages/shave-python/src/libcst-parser.ts` (only if `WireStmt`-related
  types are re-exported or referenced here; otherwise unchanged)
- `packages/shave-python/src/libcst-parser.test.ts`
- `packages/shave-python/src/raise-body.ts`
- `packages/shave-python/src/raise-body.test.ts`
- `packages/shave-python/src/raise-function.ts`
- `packages/shave-python/src/raise-function.test.ts`
- `packages/shave-python/src/purity-check.ts`
- `packages/shave-python/src/purity-check.test.ts`
- `tmp/**` (scratch evidence, evaluation contract JSON)
- `PLAN.md` (this document; planner-owned)

### Required paths (must be modified for the WI to be complete)

- `packages/shave-python/scripts/libcst-parse.py`
- `packages/shave-python/src/raise-body.ts`

### Forbidden paths

- `packages/shave-python/src/type-map.ts`
- `packages/shave-python/src/parse-fn-signature.ts`
- `packages/shave-python/src/normalize-names.ts`
- `packages/compile-python/**`
- `packages/cli/**`
- `packages/shave/**`
- `packages/compile/**`
- `packages/contracts/**`
- `bootstrap/**`
- `.github/**`
- `.claude/**`

### State authorities

- **No new state authority introduced.** The wire schema is extended
  additively; the `version: 1` field in the envelope is preserved.
- **Read-only:** no external state touched.

---

## 8 — Decision Log additions (in-file `@decision` annotations)

The implementer writes these in source as `@decision` blocks:

- `DEC-WI888-001` — Emit `Docstring` wire node (Option A) rather than
  skipping at the Python layer (§4).
- `DEC-WI888-002` — Bare-call detection via `Expr(Call)` produces
  `ImpureStatement(bare_call)` (§4).
- `DEC-WI888-003` — Catch-all bare-expression detection via `Expr(*)`
  produces `ImpureStatement(bare_expression)` (§4).
- `DEC-WI888-004` — Extend `ImpurityKind` with `"forbidden_construct"` (§4).
- `DEC-WI888-005` — `ImpureStatement` wire nodes throw at render time,
  not via the `checkFunctionPurity` walker (§4).
- `DEC-WI888-006` — Pipeline order in
  `raiseFunctionWithPurityAndNormalization` unchanged; render-time throw
  is consistent with the existing `Unsupported` path (§4).
- `DEC-WI888-007` — Plumb `fnName?` through `renderBody` / `renderStmt`
  for the thrown `ImpureFunctionError` (§4).
- `DEC-WI888-008` — Docstring-only body emits `void 0;` via the same
  empty-body fallback (§4).

Each `@decision` block in source must include rationale and a back-link
to this PLAN.md (e.g. `Cross-reference: PLAN.md §4 / #888`).

---

## 9 — Implementer marching orders

1. Worktree is provisioned at
   `/Users/cris/src/yakcc/.worktrees/feature-888-expr-stmts/`. Branch
   `feature/888-expr-stmts` is descended from `origin/main`. **Do not
   commit on `main`** (Sacred Practice #2; memory
   `feedback_no_main_branch_commits`).
2. Verify HEAD is tracking `origin/main`:
   `git -C /Users/cris/src/yakcc/.worktrees/feature-888-expr-stmts fetch origin`
   then `git -C … diff --stat origin/main..HEAD` (memory
   `feedback_branch_must_track_origin_main`).
3. Implement in slice order §5 (A, C parallel → B → D → E). After each
   slice, run `pnpm --filter @yakcc/shave-python test`. After Layer-1
   wire tests pass, validate the Python script via the subprocess test
   (or a direct stdin pipe) before moving to TS work.
4. Stage all changes; do **not** run `git commit` — implementer role
   cannot land per memory `feedback_implementer_cannot_commit`.
   `guardian:land` will compose the commit.
5. Before guardian:land:
   - Rebase onto `origin/main` (memory `feedback_pre_push_hygiene`).
   - Run `pnpm --filter @yakcc/shave-python lint`,
     `pnpm --filter @yakcc/shave-python typecheck`,
     `pnpm --filter @yakcc/shave-python test`. Capture outputs for the PR
     description.
   - `gh issue edit 888 --add-label serenity` (memory
     `feedback_serenity_claim_label`).
6. After reviewer verdict, ensure `cc-policy evaluation set
   ready_for_guardian --workflow-id wi-888-expr-stmts --head-sha <HEAD>`
   ran (memory `feedback_agent_tool_completion_projection_gap`).
7. PR title: `feat(shave-python): #888 — SmallStatement Expr handling for docstrings + bare calls`.
   PR body: paste §6 evidence verbatim; reference the bs4 exploration
   that motivated the WI; note that re-running the exploration post-merge
   is the issue's acceptance step (not part of this PR).
8. Closes #888.

---

## 10 — Post-landing follow-ups (backlog issues, not in this WI)

- **bs4 exploration re-run** — Operator-driven validation that the 7
  SmallStatement-Expr blockers drop from the failure tally. Not a code
  change; runs against the merged HEAD.
- **Class-level docstrings** — PEP-257 also covers class body docstrings.
  Tracked at #890 (class-method extraction); folded in there.
- **Module-level docstrings** — same as class-level but for module body;
  not yet tracked, file a follow-up issue if e2e exploration shows them
  as blockers.
- **`Expr(Yield)` / `Expr(Await)` split** — these currently fall under
  the catch-all `bare_expression` branch with detail like
  `"Yield"` / `"Await"`. If we later want a dedicated taxonomy slot for
  async/generator constructs, split them out then.
- **Reconcile `checkFunctionPurity` with render-time throws** — DEC-WI888-005
  documents the current split (purity walker handles `Call`/`Attribute`
  inside expressions; render-time handles `ImpureStatement` wire nodes).
  A future refactor could unify these by extending the walker. Tracked as
  a future cleanup idea, not blocking.

---

PLAN authored 2026-05-29 against worktree HEAD on branch
`feature/888-expr-stmts`. Operator dispatch identified the SmallStatement-
Expr error bucket as the dominant blocker in bs4 e2e exploration and
specified the docstring/bare-call split + the
`ImpurityKind.forbidden_construct` extension; this plan encodes the
detection, render, and taxonomy work across `libcst-parse.py`,
`raise-body.ts`, `purity-check.ts`, and `raise-function.ts`, with the
Evaluation Contract and Scope Manifest pinned for guardian readiness.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Drafted WI-888 plan covering libcst-parse.py SmallStatement Expr detection (Docstring + ImpureStatement wire nodes), raise-body.ts render handling, ImpurityKind "forbidden_construct" extension, and raise-function.ts docstring-aware empty-body fallback; DEC-WI888-001..008 capture all design decisions; scope manifest pins shave-python adapter only; next dispatch is guardian:provision to seed the implementer slice.
