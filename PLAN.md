# PLAN — WI-890 shave-python: extract methods from class bodies

> Planner output for [`#890`](https://github.com/cneckar/yakcc/issues/890)
> (`shave-python: extract methods from class bodies (currently only module-level def visited)`).
> Workflow `wi-890-classmethods`, work item `wi-890-plan`, goal `g-890`.
> Branch `feature/890-class-methods` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-890-class-methods`.
>
> Operator dispatch (2026-05-29 / continued 2026-05-30): bs4 4.14.3 e2e
> exploration showed **9 of 15 production files yielded 0 functions** because
> all code lives in class methods, not module-level `def`. This WI teaches the
> libcst-parse wire emitter to walk `libcst.ClassDef` bodies and emit method
> entries into `module.functions[]` with a new `methodKind` discriminator, then
> threads that field through `parse-fn-signature.ts` and `purity-check.ts` so
> the existing `raise-function.ts` pipeline naturally raises pure
> static/classmethods and rejects instance methods with a clean
> `ImpureFunctionError`.

---

## 0 — Headline

Teach `libcst-parse.py` to extract methods from class bodies and tag them with
their decorator class. Specifically:

1. **`_function_envelope` invocation** — `main()` in `libcst-parse.py`
   currently iterates `module.body` filtering `libcst.FunctionDef`. Extend the
   walk so `libcst.ClassDef` bodies are also visited; each `FunctionDef` inside
   a class body is emitted into `module.functions[]` with:
   - `name = "<ClassName>.<methodName>"` (dot-qualified — keep parseable; the
     dot survives only in the envelope, never in TS identifiers — see
     DEC-WI890-007)
   - `methodKind: "static" | "class" | "instance"` (new field; absent for
     module-level functions — equivalent to `null`)
2. **`FunctionSignature.methodKind`** — `parse-fn-signature.ts` threads the
   `methodKind` field from the envelope onto the typed `FunctionSignature`.
   Existing module-level callers see `methodKind === undefined`.
3. **`ImpurityKind` gains `"instance_method"`** — `purity-check.ts` adds a new
   union member and a `checkFunctionPurity` branch that throws
   `ImpureFunctionError(kind: "instance_method")` whenever `fnRecord.methodKind
   === "instance"`. Static- and class-methods are not auto-rejected; they flow
   through the existing purity walker.
4. **`raise-function.ts`** — forwards `methodKind` through the pipeline; the
   raised TS identifier rewrites `ClassName.methodName` → `ClassName_methodName`
   (DEC-WI890-007) so the emitted TS is a valid identifier.

This is a wire-additive change. Module-level functions emit identically to
pre-WI HEAD (`methodKind` absent). The `raise-body.ts` renderer is
**not touched** (forbidden by scope manifest); rejection of instance methods
fires in `purity-check.ts` *before* `renderBody` is invoked.

Expected post-merge bs4 exploration impact: per #890 "Discovered" section, 9
of 15 files yielded 0 functions. After this WI those files will yield the sum
of their `@staticmethod` + `@classmethod` declarations as raised candidates,
plus their instance methods as explicit `ImpureFunctionError(instance_method)`
records in `extractFunctionSignaturesAll().failed`. The exact +N fnCount
target ("6 → 15" per the operator dispatch headline; ">100" per the operator
narrative) is observational, not a wire-shape constraint — the contract is
behavioral (kind labels) not numeric.

---

## 1 — Problem decomposition (challenge the requirement first)

### Restated in my own words

Today `_function_envelope` only sees `module.body[]` `FunctionDef` entries.
Almost all production Python lives inside `class` declarations
(`exceptions.py`, `formatter.py`, `css.py`, `_html5lib.py`, etc.), so the
shaver currently sees nothing in those files. The fix is to walk one level of
`ClassDef` and emit each contained `FunctionDef` into the flat
`module.functions[]` array, classified by decorator into one of three buckets:

- **`@staticmethod`** — semantically identical to a module-level function;
  raise normally.
- **`@classmethod`** — first parameter is `cls`; otherwise treat as pure unless
  the body says otherwise. Keep `cls` as a real parameter in the raised TS
  signature (it becomes another `unknown`/typed parameter — no special
  handling).
- **Regular `def foo(self, ...)`** — first parameter is `self`. Without full
  call-graph analysis we cannot prove these are pure, so we default-reject.
  This is the correct trade-off per #890: rejecting with a clear error label
  (`instance_method`) is strictly better than silently skipping (the current
  behavior), because operators can read the error and know exactly what was
  rejected and why.

The headline win is observability: instead of a class file showing "0
functions", it now shows N candidates with explicit pass/fail kind labels.
This unblocks downstream diagnostics regardless of how many methods actually
shave through.

### Goals (measurable)

1. **G1** — A `@staticmethod` method in a class body is emitted into
   `module.functions[]` with `name: "ClassName.methodName"` and
   `methodKind: "static"`. The raise pipeline raises it identically to a
   module-level function (purity check decides pass/fail based on body
   content). Verified by a new `libcst-parser.test.ts` subprocess case and an
   `raise-function.test.ts` e2e case.
2. **G2** — A `@classmethod` method emits with `methodKind: "class"` and
   `cls` as the first param. Purity check runs normally — `cls`-only attribute
   reads are not auto-rejected (no new `cls.*` rule); body content drives
   purity. Verified by subprocess test + e2e test that raises a
   `@classmethod` body containing only `cls.CONSTANT` reads.
3. **G3** — A regular `def foo(self, ...)` method emits with
   `methodKind: "instance"`. `checkFunctionPurity` throws
   `ImpureFunctionError(kind: "instance_method")` BEFORE the body walk
   inspects any specific construct, with the function name set to
   `"ClassName.methodName"`. Verified by `purity-check.test.ts` unit test and
   `raise-function.test.ts` e2e test.
4. **G4** — Module-level functions emit identically to pre-WI HEAD.
   `methodKind` is absent from their envelope record (NOT present as `null`,
   to preserve byte-equivalent JSON for existing fixture/tests).
   `FunctionSignature.methodKind` is `undefined` for them. Verified by every
   existing `libcst-parser.test.ts` / `parse-fn-signature.test.ts` /
   `raise-function.test.ts` case staying green without modification.
5. **G5** — `extractFunctionSignaturesAll` (the #899 fail-soft variant) places
   instance-method rejections into `.failed[]` with an `ImpureFunctionError`
   carrying `kind: "instance_method"`. The successful raises in `.ok[]`
   include both module-level functions and pure static/classmethods. Verified
   by a `parse-fn-signature.test.ts` case using a small class fixture.

### Non-goals (explicit exclusions)

- **Class scaffolding in compile-python.** The inverse transform — composing
  raised `ClassName_methodName` back into TS `class { ... }` declarations —
  is a separate WI (filed as follow-up; see §10). For this WI, class context
  is lost downstream: `Foo.bar` becomes a top-level TS function
  `Foo_bar(...)` and the compile-python output sees it as such. Documented
  in the emitted name itself (the `ClassName_` prefix is the breadcrumb).
- **Nested classes.** Recursing into a `ClassDef` inside another `ClassDef`
  is out of scope per #890. The walker handles only direct
  `module.body[ClassDef].body[FunctionDef]` — one level deep.
- **Nested functions.** A `def` inside a `def` (closure) is similarly out of
  scope per #890 and the existing libcst-parse.py.
- **Inheritance modeling.** No special handling of `super()`, MRO, method
  override detection. A method that calls `super()` will likely raise
  `Unsupported` from the existing `Call`-with-complex-callee path
  (`super().__init__` is `Call(Attribute(Call(Name('super'))))`) which is
  the existing semantics; this WI does not extend that path.
- **Whitelisting pure instance methods.** Even an instance method whose body
  is `return self.x + 1` is rejected as `instance_method`. A future WI could
  add a narrow whitelist (read-only `self.attr` access + no mutation + no
  calls to other instance methods) but call-graph analysis is required and
  out of scope here.
- **Class-level docstrings.** A class body's first statement may be a
  docstring (PEP-257). The walker MUST skip non-`FunctionDef` statements in
  the class body — including the docstring SimpleStatementLine. No new wire
  node for class docstrings (deferred follow-up; not blocking).
- **Module-level `__getattr__` (PEP 562).** Already extracted today as a
  module-level function. Untouched.
- **Class-level dunders (`__init__`, `__repr__`, `__getattr__`, `__str__`).**
  These are all regular `def foo(self, ...)` methods. They get
  `methodKind: "instance"` and are rejected as `instance_method`, same as any
  other instance method. No special-casing in this WI.
- **`@property`, `@staticmethod`-via-functools-wrapper, `@cached_property`,
  bare-name `@my_custom_decorator`.** The detection check fires only on
  unqualified `@staticmethod` / `@classmethod` decorator names. Any other
  decorator (functools.cache, abc.abstractmethod, etc.) is treated as
  passthrough — it does not change the `self`/`cls` contract and does not
  change the `methodKind`. A method decorated `@cached_property` with a
  `self` first param is still `methodKind: "instance"` and is rejected.
  Trade-off: this rejects some methods that are semantically pure (a
  `@functools.cache`'d staticmethod). For the MVP that's acceptable — the
  raise pipeline already rejects on the broader rule, so the new rejection
  is the same shape. A future widening can examine decorator semantics.
- **Touching `raise-body.ts`, `type-map.ts`, `normalize-names.ts`,
  `libcst-parser.ts`** (the latter only allowed if a re-export is needed —
  see allowed scope manifest; we do not modify implementation in
  `libcst-parser.ts`). Forbidden by scope manifest. The render-time error
  taxonomy is unchanged; rejection fires at the purity-check layer.
- **Adapter consumer packages.** `packages/compile-python/**`,
  `packages/cli/**`, `packages/shave/**`, `packages/compile/**`,
  `packages/contracts/**`, `packages/ir/**`, `bootstrap/**`, `.github/**`,
  `.claude/**` — all forbidden. WI is shave-python-internal.
- **MASTER_PLAN.md churn.** Decision log additions are in-file `@decision`
  blocks; a post-landing planner pass can graduate them to MASTER_PLAN if
  the operator wants.

### Unknowns and ambiguities — resolved at planning time

1. **Wire shape: flatten vs nest?** Resolved as **flatten** (DEC-WI890-001).
   See §4.

2. **Decorator detection nuance.** `libcst.FunctionDef.decorators` is a
   sequence of `Decorator` nodes; each has `.decorator` which is a
   `BaseExpression`. For unqualified `@staticmethod` / `@classmethod` the
   `decorator` is a `libcst.Name`. For `@functools.cache` it's a
   `libcst.Attribute`. For `@functools.lru_cache(maxsize=128)` it's a
   `libcst.Call`. We match only `libcst.Name` with `.value in
   {"staticmethod", "classmethod"}`. Anything else is ignored (does not
   change `methodKind`). Recorded as DEC-WI890-002.

3. **First-param keep/drop for `@classmethod`?** Keep `cls`. Treating
   classmethods as pure module-level functions with an extra `cls` parameter
   is the minimum-change path. The TS shave consumer sees `cls: unknown`
   (the annotation will typically be absent, which today triggers
   `MissingTypeAnnotationError` from `extractOne` — see DEC-WI890-004 for
   how we handle that). Recorded as DEC-WI890-003.

4. **What if `cls` lacks an annotation?** Python convention is to leave
   `cls`/`self` unannotated. Today `extractOne` throws
   `MissingTypeAnnotationError(fnName, "cls")`. That throw happens in
   `parse-fn-signature.ts` and surfaces as a `.failed[]` entry from
   `extractFunctionSignaturesAll` — exactly the existing behavior for any
   under-annotated function. We do NOT special-case `cls`/`self` to skip
   the annotation requirement. Trade-off: this rejects most real classmethods
   without an explicit `cls: type[ClassName]` annotation — acceptable for
   MVP, can be relaxed later by auto-synthesizing `cls: unknown` /
   `self: unknown` for first-position `cls`/`self` if the operator wants
   broader coverage. Recorded as DEC-WI890-004. (For instance methods this
   is moot: they're rejected before annotation processing.)

5. **Ordering of the rejection vs annotation check for instance methods.**
   `extractOne` runs first (it produces the signature) — it would fail with
   `MissingTypeAnnotationError("self")` before `checkFunctionPurity` ever
   sees the function. We want the `instance_method` rejection to be the
   visible failure (better error class for diagnostics), not
   `MissingTypeAnnotationError`. **Resolution (DEC-WI890-005):** in
   `parse-fn-signature.ts:extractOne`, if `fn.methodKind === "instance"`,
   short-circuit and throw `ImpureFunctionError(name, "instance_method",
   "instance method ...")` *before* annotation checks. This couples
   `parse-fn-signature.ts` to `ImpureFunctionError` (already exported from
   `purity-check.ts`), preserving the single error-class for purity
   rejections. Verify no import cycle: `purity-check.ts` does not import
   from `parse-fn-signature.ts`. Safe.

6. **TS identifier from `ClassName.methodName`.** Dot is not a legal TS
   identifier character. Resolved (DEC-WI890-007): emit the envelope name
   as `ClassName.methodName` (dot preserved — round-trippable, parseable),
   but `renderFunctionDeclaration` rewrites it to `ClassName_methodName`
   when constructing the `export function …` text. The replacement happens
   in `raise-function.ts` (scope-allowed), not in `raise-body.ts`
   (scope-forbidden) and not in `parse-fn-signature.ts` (we keep the dotted
   form on `FunctionSignature.name` for diagnostics). The rewrite is a
   single `name.replace(".", "_")` — collision detection deferred (see
   DEC-WI890-008).

7. **Name-collision risk.** If module-level function `Foo_bar` exists AND
   class `Foo` has method `bar`, both raise to TS identifier `Foo_bar`.
   YAGNI for MVP: emit both; downstream TS compilation flags the duplicate.
   A future hardening can rename one or add a suffix counter. Recorded as
   DEC-WI890-008.

8. **Should `purity-check.ts` reject `instance_method` independently in
   `checkFunctionPurity`?** Two valid placements:
   - (a) `parse-fn-signature.ts:extractOne` rejects pre-signature (per
     DEC-WI890-005 above).
   - (b) `purity-check.ts:checkFunctionPurity` rejects when
     `fnRecord.methodKind === "instance"`.

   **Decision: BOTH** (DEC-WI890-006). The `extractOne` path covers the
   normal pipeline (envelope → extract → purity → render). The
   `checkFunctionPurity` path covers test injection and any caller that
   constructs an `fnRecord` directly. Both throw the same
   `ImpureFunctionError(kind: "instance_method")`. The extra check in
   `checkFunctionPurity` is `O(1)` (a single field read) and runs before
   any other purity walk; it makes the rejection a true authority over
   instance-method rejection.

### Dominant constraints

- Sacred Practice #12: single source of truth — `methodKind` is defined in
  `libcst-parse.py` (Python wire), mirrored in `parse-fn-signature.ts`
  (TS-side typed surface), and consumed by `purity-check.ts`. No other
  definitions.
- Sacred Practice #5: real unit tests, fail loudly. Three test layers:
  subprocess wire (libcst-parser.test.ts), extraction
  (parse-fn-signature.test.ts), purity (purity-check.test.ts), e2e
  (raise-function.test.ts).
- Scope manifest forbids `raise-body.ts` edits — the instance-method
  rejection must therefore fire *before* `renderBody` is invoked (i.e. in
  `extractOne` and `checkFunctionPurity`, both scope-allowed).
- Memory `feedback_pre_push_hygiene`: rebase + lint + typecheck before push.
- Memory `feedback_branch_must_track_origin_main`: `git fetch && git diff
  --stat origin/main..HEAD` before push.
- Memory `feedback_serenity_claim_label`: `gh issue edit 890 --add-label
  serenity` before any PR push (already labeled `serenity` per `gh issue
  view 890` at planning time — verify before push).
- Memory `feedback_agent_tool_completion_projection_gap`: reviewer must
  explicitly run `cc-policy evaluation set ready_for_guardian` once verdict
  is `ready_for_guardian`.
- Memory `feedback_implementer_cannot_commit`: implementer stages; guardian
  composes the commit. The implementer must not run `git commit` directly.

---

## 2 — State authorities & integration surfaces

| Domain                                                          | Authority (canonical)                                            | This WI relationship                                                                                                  |
|-----------------------------------------------------------------|------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Python wire-AST envelope shape (functions[] entries)            | `packages/shave-python/scripts/libcst-parse.py`                  | **Extends** — emits class-method entries with new `methodKind` field; adds class-body walker in `main()`              |
| `EnvelopeFunction` interface                                    | `packages/shave-python/src/parse-fn-signature.ts`                | **Extends** — adds optional `methodKind?: "static" | "class" | "instance"`                                            |
| `FunctionSignature` typed surface                               | `packages/shave-python/src/parse-fn-signature.ts`                | **Extends** — adds optional `methodKind?: MethodKind`                                                                 |
| `ImpurityKind` union                                            | `packages/shave-python/src/purity-check.ts`                      | **Extends** — adds `"instance_method"` member                                                                         |
| Instance-method rejection authority                             | `packages/shave-python/src/purity-check.ts` (`checkFunctionPurity`) + `parse-fn-signature.ts` (`extractOne`) | **New** — both paths throw `ImpureFunctionError(kind: "instance_method")`. Dual placement is intentional (DEC-WI890-006) |
| `ImpureFunctionError` constructor + shape                       | `packages/shave-python/src/purity-check.ts`                      | **Reused unchanged** — constructor signature stays `(functionName, kind, detail, line?, col?)`                        |
| `renderFunctionDeclaration` (identifier emission)               | `packages/shave-python/src/raise-function.ts`                    | **Extends** — rewrites dot in `signature.name` to underscore when emitting the `export function …` text (DEC-WI890-007) |
| `raise-body.ts` (`WireStmt`, `renderStmt`, `renderBody`)        | `packages/shave-python/src/raise-body.ts`                        | **Untouched** (forbidden by scope manifest). The rejection fires before `renderBody` is called.                       |
| `libcst-parser.ts` (subprocess driver + `LibcstParseResult`)    | `packages/shave-python/src/libcst-parser.ts`                     | **Effectively untouched** — only allowed to re-export new types if helpful (see §3.4); no impl change to `parsePythonSource` |
| Subprocess wire format / version field                          | `packages/shave-python/scripts/libcst-parse.py` (`"version": 1`) | **Unchanged** — additive field, no schema bump                                                                        |
| `index.ts` (public surface of `@yakcc/shave-python`)            | `packages/shave-python/src/index.ts`                             | **Extends** — re-export `MethodKind` type if defined; otherwise unchanged. Optional.                                  |
| Per-function extraction fail-soft (`.failed[]`)                 | `packages/shave-python/src/parse-fn-signature.ts` (`extractFunctionSignaturesAll`) | **Reused** — instance-method rejections appear in `.failed[]` with `ImpureFunctionError`, exactly per #899 semantics |

### Existing-mechanism survey (Sacred Practice #12)

- **Today** `main()` in `libcst-parse.py` (line 880) iterates only
  `libcst.FunctionDef` from `module.body`. There is no helper for walking
  class bodies. This WI adds the walk inline in `main()` (no new helper —
  the iteration is two-deep and trivial).
- **`_function_envelope`** (line 825) takes a single `fn` and a `module`
  reference; it does not currently take or emit any class context. The
  minimum change: add an optional `methodKind=None` parameter and an
  optional `class_name=None` parameter. When `class_name` is set, the
  emitted `name` field is `f"{class_name}.{fn.name.value}"` instead of
  `fn.name.value`. When `methodKind` is non-None, it's added to the
  returned dict as `"methodKind": methodKind`.
- **`ImpurityKind`** is defined exactly once, in `purity-check.ts:129`.
  Confirmed no other file uses `"forbidden_call" | ...` as a string-literal
  union; all consumers import the type. Adding `"instance_method"` is a
  one-line edit + a one-arm addition to `normalizeImpurityKind`.
- **Decorator inspection** is not currently present anywhere in
  `libcst-parse.py`. New helper `_method_kind(fn)` returns `"static"`,
  `"class"`, `"instance"`, or `None` (`None` for non-methods — caller
  decides whether to use it). The helper is the entire surface area of
  decorator analysis for this WI.
- **`extractOne`** in `parse-fn-signature.ts:181` runs param annotation
  checks first. Per DEC-WI890-005 we add a short-circuit at the very top:
  if `fn.methodKind === "instance"`, throw `ImpureFunctionError`
  immediately. The throw bypasses annotation checks; this is intentional
  (we know the function won't be raised regardless).
- **No existing helper "is this a method?"** in any TS file — the
  envelope's `methodKind` is the single discriminator.

---

## 3 — Architecture design

### 3.1 Wire-shape changes (Python side — canonical authority)

`_method_kind(fn)` — new helper in `libcst-parse.py`:

```python
def _method_kind(fn):  # type: ignore[no-untyped-def]
    """Classify a libcst.FunctionDef found inside a ClassDef body.

    Returns "static" | "class" | "instance".

    Detection: only unqualified Name decorators ("staticmethod",
    "classmethod") flip the kind. Attribute / Call decorators
    (@functools.cache, @lru_cache(...), ...) are passthrough.
    Cross-reference: PLAN.md §4 DEC-WI890-002 / #890
    """
    import libcst  # type: ignore[import-untyped]
    for dec in fn.decorators:
        d = dec.decorator
        if isinstance(d, libcst.Name):
            if d.value == "staticmethod":
                return "static"
            if d.value == "classmethod":
                return "class"
    return "instance"
```

`_function_envelope(fn, module=None, class_name=None, method_kind=None)`:

```python
def _function_envelope(fn, module=None, class_name=None, method_kind=None):
    params = [...]  # existing
    return_annot = ...  # existing
    body_source = ...  # existing
    body = [...]  # existing

    name = (
        f"{class_name}.{fn.name.value}"
        if class_name is not None
        else fn.name.value
    )
    envelope = {
        "name": name,
        "params": params,
        "return_annotation": return_annot,
        "body_source": body_source,
        "body": body,
    }
    if method_kind is not None:
        envelope["methodKind"] = method_kind
    return envelope
```

Module-level walk in `main()` becomes:

```python
functions = []
for stmt in module.body:
    if isinstance(stmt, libcst.FunctionDef):
        functions.append(_function_envelope(stmt, module))
        continue
    if isinstance(stmt, libcst.ClassDef):
        class_name = stmt.name.value
        # Walk only the direct body of the class; do not recurse into
        # nested ClassDef (out of scope per #890).
        for inner in stmt.body.body:
            if isinstance(inner, libcst.FunctionDef):
                kind = _method_kind(inner)
                functions.append(
                    _function_envelope(
                        inner, module, class_name=class_name, method_kind=kind
                    )
                )
            # All non-FunctionDef statements in the class body are skipped:
            # docstrings, type-alias assignments, nested ClassDef, pass, etc.
            # No wire emission for class-level state.
        continue
    # All other top-level statement types unchanged.
```

The class body iteration uses `stmt.body.body` because libcst wraps the
class body in an `IndentedBlock` whose `.body` is the list of
`SimpleStatementLine` / compound statements. `FunctionDef` is a compound
statement (it lives directly in `IndentedBlock.body`, not wrapped in
`SimpleStatementLine`).

### 3.2 Wire shape (envelope additions, observed by TS)

For class-method entries:

```json
{
  "name": "Formatter.attribute_to_html",
  "params": [...],
  "return_annotation": "str | None",
  "body_source": "...",
  "body": [...],
  "methodKind": "static"
}
```

For module-level functions, the envelope is **byte-identical** to pre-WI
(no `methodKind` field). This preserves the existing fixtures and tests
without modification.

### 3.3 TS-side: `parse-fn-signature.ts` extensions

```ts
export type MethodKind = "static" | "class" | "instance";

interface EnvelopeFunction {
  name: string;
  params: EnvelopeParam[];
  return_annotation: string | null;
  body_source: string;
  methodKind?: MethodKind;  // NEW — undefined for module-level fns
}

export interface FunctionSignature {
  readonly name: string;
  readonly params: readonly RaisedParam[];
  readonly returnType: string;
  readonly pythonReturnAnnotation: string | null;
  readonly bodyPythonSource: string;
  readonly returnWarnings?: readonly LowerWarning[];
  readonly methodKind?: MethodKind;  // NEW — undefined for module-level fns
}
```

`extractOne` extensions:

```ts
function extractOne(fn: EnvelopeFunction): FunctionSignature {
  // DEC-WI890-005: short-circuit instance methods BEFORE annotation checks.
  // We know the function will be rejected by purity; throwing now produces
  // the correct error class (ImpureFunctionError, not MissingTypeAnnotationError).
  if (fn.methodKind === "instance") {
    throw new ImpureFunctionError(
      fn.name,
      "instance_method",
      `instance method '${fn.name}' (def with 'self' first param) is not raiseable; only @staticmethod and @classmethod methods are extracted`,
    );
  }

  // existing param + return-type extraction unchanged...

  return {
    name: fn.name,
    params,
    returnType,
    pythonReturnAnnotation: fn.return_annotation,
    bodyPythonSource: fn.body_source,
    returnWarnings,
    methodKind: fn.methodKind,  // pass through (undefined for module-level)
  };
}
```

Imports gain `import { ImpureFunctionError } from "./purity-check.js";`.
Cycle check: `purity-check.ts` does NOT import from `parse-fn-signature.ts`
today (it imports `LibcstParseResult` / `PythonAstNode` from
`libcst-parser.ts`). Safe.

### 3.4 TS-side: `purity-check.ts` extensions

```ts
export type ImpurityKind =
  | "forbidden_import"
  | "forbidden_call"
  | "forbidden_attr"
  | "global_decl"
  | "forbidden_construct"
  | "instance_method";  // NEW (WI-890)

function normalizeImpurityKind(kind: string): ImpurityKind {
  switch (kind) {
    case "forbidden_import":
    case "forbidden_call":
    case "forbidden_attr":
    case "global_decl":
    case "forbidden_construct":
    case "instance_method":  // NEW
      return kind;
    default:
      return "forbidden_call";
  }
}
```

`checkFunctionPurity` gains a top-of-function short-circuit:

```ts
export function checkFunctionPurity(
  fnRecord: PythonAstNode,
  moduleNode: PythonAstNode,
  fnName: string,
): void {
  // DEC-WI890-006: instance methods are unconditionally impure.
  // Fires before any other check so the rejection is authoritative.
  if ((fnRecord as { methodKind?: string }).methodKind === "instance") {
    throw new ImpureFunctionError(
      fnName,
      "instance_method",
      `instance method '${fnName}' (def with 'self' first param) cannot be proved pure without call-graph analysis`,
    );
  }
  // existing import + envelope + body walks unchanged...
}
```

### 3.5 TS-side: `raise-function.ts` identifier rewrite (DEC-WI890-007)

`renderFunctionDeclaration` changes its identifier emission:

```ts
export function renderFunctionDeclaration(
  signature: FunctionSignature,
  body: readonly WireStmt[],
): string {
  const paramList = signature.params.map((p) => `${p.name}: ${p.tsType}`).join(", ");
  const visibleStmts = body.filter((s) => s.type !== "Docstring");
  const bodyText =
    visibleStmts.length === 0 ? "  void 0;" : renderBody(visibleStmts, "  ", signature.name);
  // DEC-WI890-007: rewrite dot-qualified method names to TS-legal identifiers.
  // signature.name keeps the dot for diagnostics (e.g. "Foo.bar"); the emitted
  // TS identifier swaps the dot for an underscore ("Foo_bar"). This is a single
  // call site so we do the replace inline rather than introducing a helper.
  const tsIdent = signature.name.replace(/\./g, "_");
  return `export function ${tsIdent}(${paramList}): ${signature.returnType} {\n${bodyText}\n}`;
}
```

Trade-off: the thrown `ImpureFunctionError` from `renderBody` ->
`renderStmt` will receive the DOTTED `signature.name` ("Foo.bar"), not
the underscored form. This is intentional — the error message is for the
human operator, and "Foo.bar" is more recognizable than "Foo_bar".

### 3.6 Pipeline flow for the three slices

| Slice | Input wire | extractOne | checkModuleImports | checkFunctionPurity | renderFunctionDeclaration | Outcome |
|-------|-----------|-----------|---------------------|---------------------|---------------------------|---------|
| A — `@staticmethod` | `{name: "Foo.bar", methodKind: "static", ...}` | passes (no short-circuit; `methodKind !== "instance"`) | passes (if no forbidden imports) | passes (if body is clean; `methodKind !== "instance"`) | emits `export function Foo_bar(...)` | raised |
| B — `@classmethod` | `{name: "Foo.bar", methodKind: "class", params: [{name:"cls", annotation: "type[Foo]"}, ...]}` | passes if `cls` has annotation (DEC-WI890-004); else fails with `MissingTypeAnnotationError` | passes | passes (body walk only) | emits `export function Foo_bar(cls: <ts-type-for-cls>, ...)` | raised (or fails on annotation) |
| C — instance `def foo(self, ...)` | `{name: "Foo.bar", methodKind: "instance", ...}` | **throws ImpureFunctionError("Foo.bar", "instance_method", ...)** (DEC-WI890-005) | n/a — extraction already failed | n/a | n/a | rejected as `instance_method` |

For slice C, the rejection path is: `extractFunctionSignaturesAll` catches
the throw and records it in `.failed[]` with the
`ImpureFunctionError`. Callers that walk `.failed[]` see the new error
kind label.

### 3.7 Test seam

Four test layers, mirroring the four code layers:

**Layer 1 — wire (`libcst-parser.test.ts`):** spawn the subprocess
against small fixture Python sources. Assert wire JSON shape:
- Class with `@staticmethod def foo(x: int) -> int: return x` →
  `module.functions[0]` is `{name: "Foo.foo", methodKind: "static", ...}`.
- Class with `@classmethod def foo(cls, x: int) -> int: return x` →
  `module.functions[0]` is `{name: "Foo.foo", methodKind: "class", params:
  [{name: "cls", ...}, {name: "x", ...}], ...}`.
- Class with `def foo(self, x: int) -> int: return x` →
  `module.functions[0]` is `{name: "Foo.foo", methodKind: "instance",
  params: [{name: "self", ...}, {name: "x", ...}], ...}`.
- Module-level `def foo()` alongside a class → both functions appear in
  `module.functions[]`; module-level entry has NO `methodKind` field
  (assert with `expect(fn.methodKind).toBeUndefined()`).
- Class body with non-FunctionDef statements (docstring, type alias,
  `pass`) → those statements produce no entries in `module.functions[]`.
- Nested class (class inside class) → only outer class methods are
  extracted; inner class methods are NOT extracted (per non-goal).
- Mixed decorators: `@functools.cache @staticmethod def foo(...)` →
  `methodKind: "static"` (the Name decorator still wins over the
  Attribute/Call wrapper). Test asserts the Name-decorator detection is
  insensitive to ordering of other passthrough decorators.

Gate pattern: skip when Python 3 / libcst unavailable (existing pattern).

**Layer 2 — extraction (`parse-fn-signature.test.ts`):**
- An envelope with three functions — module-level, static-method,
  instance-method — produces an `ExtractionResult` whose:
  - `.ok` contains the module-level fn (no `methodKind`) and the
    static-method fn (`methodKind: "static"`).
  - `.failed` contains exactly one entry for the instance-method with
    `error instanceof ImpureFunctionError`, `error.kind ===
    "instance_method"`, `error.functionName === "Foo.bar"`.
- An envelope with a classmethod that has an annotated `cls` param →
  `.ok` includes it with `methodKind: "class"`.
- An envelope with a classmethod that does NOT have an annotated `cls`
  param → `.failed` includes it with
  `error instanceof MissingTypeAnnotationError` (existing semantics —
  DEC-WI890-004).
- `extractFunctionSignatures` (the throwing variant) on the instance-method
  envelope returns an empty array (because `.ok` is empty in the all-instance
  case); for mixed, returns only the `.ok` subset.

**Layer 3 — purity (`purity-check.test.ts`):**
- `checkFunctionPurity({methodKind: "instance", body: []}, ..., "Foo.bar")`
  throws `ImpureFunctionError` with `kind === "instance_method"`,
  `functionName === "Foo.bar"`. Verifies the redundant DEC-WI890-006 check
  fires even when `extractOne` is bypassed.
- `checkFunctionPurity({methodKind: "static", body: []}, ..., "Foo.bar")`
  passes (no throw) — static methods are not auto-rejected.
- `checkFunctionPurity({methodKind: "class", body: []}, ..., "Foo.bar")`
  passes — classmethods are not auto-rejected.
- `checkFunctionPurity({body: []}, ..., "foo")` (no `methodKind`) passes —
  module-level functions are not auto-rejected.
- `normalizeImpurityKind("instance_method")` returns `"instance_method"`
  (round-trip test for envelope-supplied violations).
- `ImpurityKind` type-union smoke test: construct
  `new ImpureFunctionError("f", "instance_method", "...")` and assert
  `.kind === "instance_method"` at runtime.

**Layer 4 — e2e (`raise-function.test.ts`):** envelope injection
through the full pipeline:
- `@staticmethod` envelope → `raiseFunctionWithPurityAndNormalization`
  returns `export function Foo_bar(x: number): number {\n  return x;\n}`.
  (The dot in `signature.name` is rewritten to `_` in the emitted text;
  DEC-WI890-007.)
- `@classmethod` envelope with annotated `cls` → returns
  `export function Foo_bar(cls: <type>, x: number): number {...}`.
- `@classmethod` envelope without annotated `cls` →
  `extractFunctionSignatures` returns empty `.ok`; the test exercises
  `extractFunctionSignaturesAll` and asserts the `.failed[]` entry is
  `MissingTypeAnnotationError`.
- Instance-method envelope → `extractFunctionSignaturesAll` puts the
  function in `.failed[]` with `ImpureFunctionError` whose `.kind ===
  "instance_method"` and `.functionName === "Foo.bar"`.
- Instance-method envelope passed DIRECTLY to
  `raiseFunctionWithPurityAndNormalization` (bypassing extraction — i.e.
  the caller built a `FunctionSignature` manually with `methodKind:
  "instance"`) → `checkFunctionPurity` short-circuit throws
  `ImpureFunctionError(kind: "instance_method")`. Verifies the
  DEC-WI890-006 second-layer rejection.
- Mixed module: 1 module-level fn + 1 staticmethod + 1 instance method →
  `extractFunctionSignaturesAll` returns `.ok.length === 2` (module +
  static) and `.failed.length === 1` (instance, with
  `kind: "instance_method"`).

No new fixture files needed beyond inline Python snippets used by the
subprocess tests.

---

## 4 — Design decisions

### DEC-WI890-001 — Flat `module.functions[]` with dot-qualified names

**Decision.** Class methods are emitted into the existing flat
`module.functions[]` array. The `name` field is dot-qualified:
`"ClassName.methodName"`. A sibling `methodKind` field discriminates
`"static" | "class" | "instance"`. Module-level functions retain plain
`name` and OMIT the `methodKind` field.

**Rejected alternative.** A nested `module.classes[]` array each carrying
its own `methods[]`. Cleaner data model but requires:
- new TS types (`Class`, `Method`)
- new extractor variant (`extractClassMethods`)
- new envelope walker in every TS consumer
- a way to flatten back when downstream code wants a unified list (which
  is the common case for the shave pipeline)

The flat representation matches the existing pipeline shape, requires no
new walker, and uses the `methodKind` field as the only new discriminator.
The name encodes class context (round-trippable: `name.split(".", 1)`
recovers `[ClassName, methodName]` when `methodKind !== undefined`).

### DEC-WI890-002 — Decorator detection: unqualified Name only

**Decision.** `_method_kind(fn)` returns `"static"` / `"class"` / `"instance"`
based on whether any decorator's `.decorator` is a `libcst.Name` with
`.value` in `{"staticmethod", "classmethod"}`. Attribute decorators
(`@functools.cache`), Call decorators (`@lru_cache(maxsize=128)`), or any
other expression class are passthrough — they don't change `methodKind`.

**Rationale.** Only the canonical `@staticmethod` / `@classmethod`
declarations change the `self`/`cls` calling convention. Other decorators
wrap behavior but don't change parameter semantics. A method decorated
with both `@functools.cache` and `@staticmethod` still has `methodKind:
"static"` because the Name decorator is detected regardless of order or
co-presence.

**Trade-off.** A method imported via
`from staticmethod_helper import staticmethod` and then decorated
`@staticmethod` would also be detected as static — but this is a contrived
edge case (the import would shadow the builtin, which Python lets you do
but no production code does). Accepted.

### DEC-WI890-003 — `@classmethod` keeps `cls` as an ordinary parameter

**Decision.** A classmethod's `cls` is emitted in `params[]` as an
ordinary parameter; the TS signature includes it (e.g.
`function Foo_bar(cls: type<Foo>, x: number): T`). No special-casing in
the libcst-parse.py walker or the TS extractor.

**Rejected alternative.** Drop `cls` from params and synthesize a
`@classmethod`-aware emission. Rejected because:
- it requires synthesizing a missing parameter name when the body
  references `cls.X` (the body wire-AST already has `cls` references that
  must resolve);
- it diverges from the existing parameter handling for no semantic gain
  (the shave-time emitter would still need to know to drop `cls`).

Keeping `cls` parses uniformly: the body's `cls.CONSTANT` reference
resolves to the `cls` parameter, just like a module-level function with
a parameter named `cls`.

### DEC-WI890-004 — `cls` / `self` annotation requirement preserved

**Decision.** Methods whose `cls` / `self` parameter lacks an annotation
fail through the existing `MissingTypeAnnotationError` path in
`extractOne`. No special-case to auto-synthesize `cls: unknown` /
`self: unknown`.

**Rationale.** Auto-synthesizing the annotation would diverge from the
existing parameter-handling rules (every other unannotated param raises
the error). For classmethods, the operator can opt in by annotating
`cls: type[Foo]` (PEP 526 syntax already supported by libcst). For
instance methods, the rejection precedes annotation checks anyway
(DEC-WI890-005), so the annotation question is moot.

**Trade-off.** Most real-world `@classmethod` declarations don't annotate
`cls`, so this means most classmethods land in `.failed[]` with a
`MissingTypeAnnotationError`. The operator can resolve case-by-case by
adding annotations, or a future widening can synthesize the type. For
this WI we keep the parameter-handling rules uniform.

### DEC-WI890-005 — Instance-method rejection at `extractOne`

**Decision.** `extractOne` short-circuits at the very top: if
`fn.methodKind === "instance"`, throw `ImpureFunctionError(fn.name,
"instance_method", "...")` immediately. The throw bypasses annotation
checks.

**Rationale.** Without this short-circuit, an instance method without
annotated `self` would fail with `MissingTypeAnnotationError("self")`,
which is a misleading error class for an operator-visible diagnostic.
The user would see "self lacks annotation" and might add an annotation,
only to then hit the purity rejection on the next run. Short-circuiting
produces the correct error class immediately.

**Trade-off.** Couples `parse-fn-signature.ts` to
`ImpureFunctionError`. Verified: `purity-check.ts` does not import from
`parse-fn-signature.ts`, so the import is unidirectional and cycle-free.

### DEC-WI890-006 — Redundant rejection at `checkFunctionPurity`

**Decision.** `checkFunctionPurity` ALSO short-circuits when
`fnRecord.methodKind === "instance"`, throwing the same
`ImpureFunctionError`. This runs in addition to the `extractOne` check.

**Rationale.** The two checks cover different call paths:
- The `extractOne` check covers the canonical pipeline (envelope →
  extract → purity → render).
- The `checkFunctionPurity` check covers callers that construct an
  `fnRecord` directly (envelope-injection tests, future tools that
  bypass extraction).

The check is `O(1)` (single field read) and produces the same error.
Having both means the `instance_method` rejection is an authority over
all paths into the raise pipeline, not just the canonical one.

### DEC-WI890-007 — Dot-qualified envelope names → underscore TS identifiers

**Decision.** The envelope `name` field is `"ClassName.methodName"`
(dot preserved). The TS identifier emitted by `renderFunctionDeclaration`
rewrites the dot to underscore: `"ClassName_methodName"`. The rewrite is a
single `signature.name.replace(/\./g, "_")` inline in
`renderFunctionDeclaration`.

`signature.name` (the typed surface) keeps the dot for diagnostics and
error messages. `ImpureFunctionError.functionName` therefore carries the
dotted form ("Foo.bar"), which is more recognizable to the human reader.
The underscore form appears only in the emitted TS text.

**Rejected alternative.** Rewrite at parse time (in
`parse-fn-signature.ts:extractOne`). Rejected because we want the
diagnostic surface (`FunctionSignature.name`) to retain class context
visibly.

**Rejected alternative 2.** Rewrite at envelope time (in libcst-parse.py).
Rejected because the envelope is a Python-wire artifact; keeping the dot
makes it self-describing.

### DEC-WI890-008 — No collision check for `Foo_bar`

**Decision.** If a module-level function `Foo_bar` and a class method
`Foo.bar` both exist, both will raise to TS identifier `Foo_bar`. No
collision detection in this WI.

**Rationale.** Downstream TS compilation will flag the duplicate. The
incidence of this collision in real bs4 / similar codebases is
near-zero. A future hardening can add a per-module name set + suffix
counter when needed. YAGNI for MVP.

### DEC-WI890-009 — Slice ordering: single PR for A + B + C

**Decision.** All three slices land in a single PR. Internally the
implementer slices it as commits (see §5) but there is no separate PR
per slice.

**Rationale.** The three slices share:
- the same `_method_kind` helper and `_function_envelope` extension;
- the same `methodKind` field in `EnvelopeFunction` and `FunctionSignature`;
- the same `ImpurityKind` extension (instance_method);
- the same identifier rewrite (DEC-WI890-007).

Splitting them into separate PRs duplicates plumbing work and creates
intermediate states (e.g. "envelope emits `methodKind: 'static'` but
nothing downstream reads it") that are harder to test and review than
the unified delivery.

### DEC-WI890-010 — Class-body non-FunctionDef stmts: silent skip

**Decision.** Class body statements that are not `libcst.FunctionDef`
(docstrings, type aliases, `pass`, nested ClassDef, attribute
assignments, ...) produce NO entries in `module.functions[]`. There is no
diagnostic, no warning, no emission. The walker continues past them.

**Rationale.** This WI is scoped to method extraction. Class-level state
(constants, type aliases) is not raisable into the TS-subset pipeline as
functions. Tooling that wants to know about class-level state can be
added later as a separate envelope extension.

---

## 5 — Wave decomposition (implementer slicing guidance)

Single PR. The implementer slices it as commits.

| W-ID    | Item                                                                                                                          | Wt | Deps | Gate              |
|---------|-------------------------------------------------------------------------------------------------------------------------------|----|------|-------------------|
| W-890-A | `libcst-parse.py` — add `_method_kind(fn)` helper; extend `_function_envelope` with optional `class_name` / `method_kind`; extend `main()`'s module-body walk to recurse one level into `ClassDef.body.body` and emit each `FunctionDef` with the appropriate `methodKind` | M  | —    | wire tests        |
| W-890-B | `parse-fn-signature.ts` — add `MethodKind` type; extend `EnvelopeFunction` and `FunctionSignature` with optional `methodKind`; add the DEC-WI890-005 short-circuit at top of `extractOne`; thread `methodKind` through onto `FunctionSignature` | S  | A    | tests + typecheck |
| W-890-C | `purity-check.ts` — add `"instance_method"` to `ImpurityKind` union; add the case to `normalizeImpurityKind`; add the DEC-WI890-006 short-circuit at top of `checkFunctionPurity`; add `@decision` annotations | S  | —    | tests + typecheck |
| W-890-D | `raise-function.ts` — rewrite `signature.name` dot to underscore when emitting the TS identifier (DEC-WI890-007); add `@decision` annotation                | S  | B    | tests             |
| W-890-E | `index.ts` — re-export `MethodKind` if needed for public API consumers (optional; check downstream)                                                          | XS | B    | tests             |
| W-890-F | Tests — `libcst-parser.test.ts` (wire — subprocess), `parse-fn-signature.test.ts` (extraction), `purity-check.test.ts` (purity short-circuit + ImpurityKind smoke), `raise-function.test.ts` (e2e) | M  | A-E  | tests             |

Critical path: A → B → D, F (where F also depends on A, C, D). C runs in
parallel to A/B/D (touches only purity-check). E is trivial / optional.

Max parallel width: 2 (A+C, then B+C until C completes, then D+F).

The implementer is free to land the slices as a single commit if review
is quick.

---

## 6 — Evaluation Contract (canonical — persisted via `tmp/890-evaluation.json`)

### Required tests (vitest unit + subprocess)

1. **`libcst-parser.test.ts`** — subprocess wire-shape tests (gated on
   Python 3 + libcst availability per existing suite pattern):
   - `class Foo:\n    @staticmethod\n    def bar(x: int) -> int:\n        return x\n`
     → `module.functions[0]` equals
     `{name: "Foo.bar", methodKind: "static", params: [{name:"x", annotation:"int"}], return_annotation: "int", body_source: "...", body: [{type:"Return", value: {type:"Name", name:"x"}}]}`.
   - `class Foo:\n    @classmethod\n    def bar(cls, x: int) -> int:\n        return x\n`
     → `module.functions[0].methodKind === "class"`; first param is `cls`;
     second param is `x`.
   - `class Foo:\n    def bar(self, x: int) -> int:\n        return x\n`
     → `module.functions[0].methodKind === "instance"`; first param is `self`.
   - Mixed module: `def top_level(x: int) -> int: return x` + `class Foo: @staticmethod\n    def m(x: int) -> int: return x` → two entries; module-level has NO `methodKind` field (`expect(fn).not.toHaveProperty("methodKind")`); class entry has `methodKind: "static"`.
   - Class body with docstring + type alias + method → only the method
     appears in `module.functions[]`. (Verify with `class Foo:\n    """docstring"""\n    X: int = 0\n    @staticmethod\n    def m(x: int) -> int: return x`.)
   - Nested class — outer-class methods extracted; inner-class methods
     NOT extracted: `class Outer:\n    class Inner:\n        @staticmethod\n        def deep(x: int) -> int: return x\n    @staticmethod\n    def shallow(x: int) -> int: return x` → exactly one entry, name `"Outer.shallow"`.
   - Decorator ordering: `class Foo:\n    @functools.cache\n    @staticmethod\n    def bar(x: int) -> int: return x` → `methodKind: "static"`
     (assuming `import functools` at module top — the test source can elide
     the import; libcst tolerates undefined names at parse time).
   - Regression: existing fixtures and tests (all `libcst-parser.test.ts`
     cases pre-WI) stay green without modification.

2. **`parse-fn-signature.test.ts`** — extraction tests (no subprocess;
   envelope injection):
   - Envelope with `functions: [moduleLevel, staticMethod, instanceMethod]`:
     - `extractFunctionSignaturesAll` returns `.ok.length === 2`
       (module-level + static) and `.failed.length === 1`.
     - `.ok[0].methodKind` is `undefined`; `.ok[1].methodKind === "static"`.
     - `.failed[0].error instanceof ImpureFunctionError` and
       `.failed[0].error.kind === "instance_method"` and
       `.failed[0].error.functionName === "Foo.bar"`.
   - Envelope with a classmethod whose `cls` HAS an annotation
     (`{name:"cls", annotation:"type[Foo]"}`) → appears in `.ok` with
     `methodKind: "class"`.
   - Envelope with a classmethod whose `cls` lacks annotation → appears in
     `.failed` with `error instanceof MissingTypeAnnotationError` and
     `error.paramName === "cls"`.
   - `extractFunctionSignatures` (the throwing variant) on the same mixed
     envelope returns array of length 2 (module + static), in order.
   - Regression: every existing `parse-fn-signature.test.ts` case stays
     green without modification.

3. **`purity-check.test.ts`** — purity short-circuit + ImpurityKind smoke:
   - `checkFunctionPurity({methodKind: "instance", body: []}, {imports: []}, "Foo.bar")`
     throws `ImpureFunctionError` with `kind === "instance_method"`,
     `functionName === "Foo.bar"`.
   - `checkFunctionPurity({methodKind: "static", body: []}, {imports: []}, "Foo.bar")`
     does NOT throw.
   - `checkFunctionPurity({methodKind: "class", body: []}, {imports: []}, "Foo.bar")`
     does NOT throw.
   - `checkFunctionPurity({body: []}, {imports: []}, "foo")` (no
     methodKind) does NOT throw.
   - `normalizeImpurityKind("instance_method")` returns
     `"instance_method"`.
   - Construct `new ImpureFunctionError("Foo.bar", "instance_method",
     "detail")` and assert `.kind === "instance_method"` (type-union +
     runtime smoke).
   - Regression: every existing `purity-check.test.ts` case stays green
     without modification.

4. **`raise-function.test.ts`** — e2e via envelope injection:
   - Static-method envelope through
     `raiseFunctionWithPurityAndNormalization` → returns
     `"export function Foo_bar(x: number): number {\n  return x;\n}"`.
     Specifically: dotted `Foo.bar` becomes underscored `Foo_bar` in the
     emitted text.
   - Classmethod envelope with annotated `cls` →
     `"export function Foo_bar(cls: <ts-type-for-type-of-Foo>, x: number): number {...}"`.
     (The exact ts-type for `type[Foo]` depends on `type-map.ts`
     behavior; the test asserts the function shape, the `cls` parameter
     is present, and the identifier is underscored.)
   - Instance-method envelope through
     `raiseFunctionWithPurityAndNormalization` directly (bypassing
     extractOne, by constructing a `FunctionSignature` with
     `methodKind: "instance"` manually) → throws `ImpureFunctionError`
     with `kind: "instance_method"`, `functionName: "Foo.bar"`. This
     verifies the DEC-WI890-006 second-layer rejection.
   - Mixed envelope (module + static + instance) through
     `extractFunctionSignaturesAll` → `.ok.length === 2` and
     `.failed.length === 1` with the expected error class/kind.
   - `ImpureFunctionError.functionName` carries the DOTTED form
     ("Foo.bar"), not the underscored form. Verify by asserting the
     thrown error's `functionName` field.

### Required evidence (paste verbatim in PR description)

- `pnpm --filter @yakcc/shave-python test` raw output, all green.
- One subprocess transcript: pipe a sample Python class with one method
  of each kind through `python3 packages/shave-python/scripts/libcst-parse.py`
  and show the resulting JSON contains three `module.functions[]`
  entries with `methodKind: "static" | "class" | "instance"`.
- Optional (recommended): a short note in the PR description recording
  that re-running the bs4 4.14.3 e2e exploration after merge is the
  operator's acceptance step. The numeric "6 → 15" / ">100" deltas in
  the operator dispatch are observational; the PR contract is behavioral
  (kind labels and pipeline shape).

### Required real-path checks

- `_method_kind(fn)` exists in `libcst-parse.py` and returns one of
  `"static" | "class" | "instance"` (no other values).
- `main()` in `libcst-parse.py` iterates `module.body` and recurses one
  level into `libcst.ClassDef.body.body` to extract `libcst.FunctionDef`
  entries. The recursion does NOT descend into nested `ClassDef`.
- Class-body iteration uses `stmt.body.body` (the IndentedBlock body
  list), not `stmt.body` directly.
- `_function_envelope` accepts `class_name=None` and `method_kind=None`
  parameters; when set, the emitted dict has `name = f"{class_name}.{fn.name.value}"` and includes `"methodKind": method_kind`.
- For module-level functions, the emitted envelope dict does NOT contain
  a `"methodKind"` key (key is absent, NOT `null`).
- `EnvelopeFunction` and `FunctionSignature` in `parse-fn-signature.ts`
  have optional `methodKind?: MethodKind`.
- `extractOne` in `parse-fn-signature.ts` throws
  `ImpureFunctionError(name, "instance_method", ...)` when
  `fn.methodKind === "instance"`. The throw happens BEFORE any param /
  return annotation check.
- `ImpurityKind` in `purity-check.ts` includes `"instance_method"`.
- `normalizeImpurityKind` has a case for `"instance_method"` returning
  `"instance_method"`.
- `checkFunctionPurity` throws `ImpureFunctionError(name,
  "instance_method", ...)` when `fnRecord.methodKind === "instance"`. The
  throw happens BEFORE any other check (imports, envelope impurities,
  body walk).
- `renderFunctionDeclaration` in `raise-function.ts` replaces all `.` in
  `signature.name` with `_` when emitting the TS identifier. The
  `signature.name` field itself is not mutated.
- No throws of `MissingTypeAnnotationError` for instance methods (the
  `extractOne` short-circuit beats it). Verified by negative assertion
  in `parse-fn-signature.test.ts`.
- `raise-body.ts` is unmodified. Verified by `git -C <worktree> diff
  origin/main..HEAD -- packages/shave-python/src/raise-body.ts` showing
  no changes.

### Required authority invariants

- **Zero touched files outside the scope manifest.** Specifically: no
  edits to `packages/shave-python/src/raise-body.ts`,
  `packages/shave-python/src/libcst-parser.ts` (implementation; tests OK),
  `packages/shave-python/src/type-map.ts`,
  `packages/shave-python/src/normalize-names.ts`,
  `packages/compile-python/**`, `packages/cli/**`, `packages/shave/**`,
  `packages/compile/**`, `packages/contracts/**`, `packages/ir/**`,
  `bootstrap/**`, `.github/**`, `.claude/**`.
- **Wire-schema `version` field unchanged** (still `1`). Additive field
  only.
- **`ImpureFunctionError` constructor signature unchanged.** Same
  `(functionName, kind, detail, line?, col?)` shape.
- **Module-level function envelopes are byte-identical to pre-WI HEAD.**
  No `methodKind` field appears on a module-level entry. Tests verify
  with `expect(fn).not.toHaveProperty("methodKind")`.
- **No new state authority introduced.** This WI is a pure shape extension.
- **`ImpureFunctionError` is the sole purity error class.** No new error
  class for instance-method rejection.

### Required integration points

- `libcst-parse.py` emits the new `methodKind` field; `parse-fn-signature.ts`
  is the sole TS consumer of the envelope `methodKind`;
  `purity-check.ts` is the sole owner of the `ImpurityKind` union.
- `parse-fn-signature.ts` imports `ImpureFunctionError` from
  `./purity-check.js`. Verified to not create a cycle:
  `purity-check.ts` does not import from `./parse-fn-signature.js`.
- `raise-function.ts` reads `signature.name` and emits the underscored
  identifier; the dotted form survives only on the typed
  `FunctionSignature` and on thrown `ImpureFunctionError.functionName`.
- `extractFunctionSignaturesAll` records the instance-method rejection in
  `.failed[]` per the existing #899 fail-soft contract.

### Forbidden shortcuts

- Do NOT touch `raise-body.ts` (scope manifest forbids it; the
  instance-method rejection MUST fire pre-render, in `extractOne` and
  `checkFunctionPurity`).
- Do NOT auto-synthesize `cls: unknown` or `self: unknown` for unannotated
  first parameters (DEC-WI890-004 — preserve the uniform annotation
  rule).
- Do NOT add a new error class for instance-method rejection; reuse
  `ImpureFunctionError`.
- Do NOT recurse into nested `ClassDef`. Walker is exactly one level
  deep.
- Do NOT extract class-level state (assignments, type aliases) into
  `module.functions[]`. Only `FunctionDef` children of `ClassDef.body.body`
  are extracted.
- Do NOT special-case `@property`, `@cached_property`,
  `@abstractmethod`, or any decorator other than the bare-name
  `@staticmethod` / `@classmethod`. They are passthrough (DEC-WI890-002).
- Do NOT add a collision-detection / suffix-rename mechanism for
  `Foo_bar` clashes (DEC-WI890-008).
- Do NOT emit `methodKind: null` for module-level functions. The key
  must be ABSENT (preserving envelope byte-equivalence).
- Do NOT change the `_stmt_v2` / `_stmt_inner` / `_function_envelope`
  `is_first` semantics (WI-888 contract preserved; class-body docstrings
  do NOT pass `is_first=True` because they're skipped, not extracted).
- Do NOT commit on `main` (memory `feedback_no_main_branch_commits`).
- Do NOT run `git commit` from the implementer role (memory
  `feedback_implementer_cannot_commit`) — guardian:land composes the
  commit.

### Rollback boundary

Single PR. Reverting the merge restores prior state cleanly because:
(a) the libcst-parse.py changes are additive — the class-body walker is
new code path; deleting it restores the pre-WI walk;
(b) `EnvelopeFunction.methodKind` and `FunctionSignature.methodKind` are
optional; deleting them is type-only;
(c) `ImpurityKind` addition is type-only; deleting it re-tightens the union;
(d) the `extractOne` and `checkFunctionPurity` short-circuits are
guarded on `methodKind === "instance"` — without that field set
(post-revert), both branches are dead code;
(e) the dot-to-underscore rewrite in `renderFunctionDeclaration` is a
single `replace(/\./g, "_")`; deleting it is harmless for module-level
names (no dot) and restores pre-WI byte equality;
(f) no state authority introduced;
(g) no migration of existing data required.

### Ready-for-guardian when

- All required tests pass under `pnpm --filter @yakcc/shave-python test`.
- `pnpm lint` and `pnpm typecheck` clean for the shave-python package
  (memory `feedback_pre_push_hygiene`).
- Repo-root tests green (`pnpm test`) — or at minimum, no NEW failures
  introduced (some pre-existing benches/bootstrap suites may already be
  red; the implementer documents prior-art noise in the PR).
- `git -C <worktree> fetch origin && git -C <worktree> diff --stat
  origin/main..HEAD` shows only files allowed by the scope manifest;
  rebase onto `origin/main` is clean (memory
  `feedback_branch_must_track_origin_main`).
- All §6 "Required evidence" outputs pasted into the PR description.
- Reviewer issued `REVIEW_VERDICT=ready_for_guardian` (or equivalent
  trailer) and the projection ran `cc-policy evaluation set
  ready_for_guardian` for the workflow (memory
  `feedback_agent_tool_completion_projection_gap`).
- `gh issue edit 890 --add-label serenity` ran successfully (memory
  `feedback_serenity_claim_label`) — verify it is still present at
  push time (it was present at planning time).
- `raise-body.ts` shows zero touched lines in the diff (scope-manifest
  invariant).

---

## 7 — Scope Manifest (canonical — persisted via `cc-policy workflow scope-sync`)

### Allowed paths (implementer may touch)

- `packages/shave-python/scripts/libcst-parse.py`
- `packages/shave-python/src/parse-fn-signature.ts`
- `packages/shave-python/src/parse-fn-signature.test.ts`
- `packages/shave-python/src/raise-function.ts`
- `packages/shave-python/src/raise-function.test.ts`
- `packages/shave-python/src/purity-check.ts`
- `packages/shave-python/src/purity-check.test.ts`
- `packages/shave-python/src/libcst-parser.test.ts`
- `packages/shave-python/src/index.ts`
- `tmp/**` (scratch evidence, evaluation contract JSON, scope manifest JSON)
- `PLAN.md` (this document; planner-owned)

### Required paths (must be modified for the WI to be complete)

- `packages/shave-python/scripts/libcst-parse.py`
- `packages/shave-python/src/parse-fn-signature.ts`

(Operationally the WI also requires edits to `purity-check.ts`,
`raise-function.ts`, and the four test files; the runtime "required"
list pins only the two files the runtime contract treats as
load-bearing minima.)

### Forbidden paths

- `packages/shave-python/src/raise-body.ts`
- `packages/shave-python/src/libcst-parser.ts` (implementation; the
  scope-manifest separately allows the `.test.ts` file)
- `packages/shave-python/src/type-map.ts`
- `packages/shave-python/src/normalize-names.ts`
- `packages/compile-python/**`
- `packages/cli/**`
- `packages/shave/**`
- `packages/compile/**`
- `packages/contracts/**`
- `packages/ir/**`
- `bootstrap/**`
- `.github/**`
- `.claude/**`

### State authorities

- **No new state authority introduced.** The wire schema is extended
  additively; the `version: 1` field in the envelope is preserved.
- **Read-only:** no external state touched. No new SQLite tables, no
  new flat files (the tmp/ artifacts are evidence-only).

---

## 8 — Decision Log additions (in-file `@decision` annotations)

The implementer writes these in source as `@decision` blocks:

- `DEC-WI890-001` — Flat `module.functions[]` with dot-qualified names;
  `methodKind` discriminator (§4) — annotate in `libcst-parse.py` at
  `_function_envelope` and in `parse-fn-signature.ts` at the
  `EnvelopeFunction` interface.
- `DEC-WI890-002` — Decorator detection: unqualified Name only (§4) —
  annotate at `_method_kind` in `libcst-parse.py`.
- `DEC-WI890-003` — `@classmethod` keeps `cls` as ordinary parameter (§4)
  — annotate in `libcst-parse.py` near the class-body walker.
- `DEC-WI890-004` — `cls`/`self` annotation requirement preserved (§4) —
  annotate in `parse-fn-signature.ts:extractOne`.
- `DEC-WI890-005` — Instance-method rejection at `extractOne` (§4) —
  annotate in `parse-fn-signature.ts:extractOne` at the short-circuit.
- `DEC-WI890-006` — Redundant rejection at `checkFunctionPurity` (§4) —
  annotate in `purity-check.ts:checkFunctionPurity` at the short-circuit.
- `DEC-WI890-007` — Dot-qualified envelope names → underscore TS
  identifiers (§4) — annotate in `raise-function.ts:renderFunctionDeclaration`.
- `DEC-WI890-008` — No collision check for `Foo_bar` (§4) — brief
  annotation in `raise-function.ts` near the rewrite.
- `DEC-WI890-009` — Slice ordering: single PR for A + B + C (§4) —
  documented in PLAN.md only.
- `DEC-WI890-010` — Class-body non-FunctionDef stmts: silent skip (§4) —
  annotate in `libcst-parse.py` at the class-body walker.

Each `@decision` block in source must include rationale and a back-link
to this PLAN.md (e.g. `Cross-reference: PLAN.md §4 / #890`).

---

## 9 — Implementer marching orders

1. Worktree is provisioned at
   `/Users/cris/src/yakcc/.worktrees/feature-890-class-methods/`. Branch
   `feature/890-class-methods` is descended from `origin/main`. **Do not
   commit on `main`** (Sacred Practice #2; memory
   `feedback_no_main_branch_commits`).
2. Verify HEAD is tracking `origin/main`:
   `git -C /Users/cris/src/yakcc/.worktrees/feature-890-class-methods fetch origin`
   then `git -C … diff --stat origin/main..HEAD` (memory
   `feedback_branch_must_track_origin_main`). The branch should currently
   carry zero diff from origin/main; rebase to pick up any recent merges.
3. Persist the scope manifest to runtime *before* starting edits so
   hook enforcement matches the plan. Write the JSON to
   `tmp/890-scope.json` (allowed/required/forbidden arrays per §7) and
   run:
   `cc-policy workflow scope-sync wi-890-classmethods --work-item-id wi-890-plan --scope-file tmp/890-scope.json`
4. Persist the Evaluation Contract to runtime so reviewer/guardian see
   the same acceptance target. Write to `tmp/890-evaluation.json` (use
   `cc-policy evaluation set --help` for the schema) and post it.
5. Implement in slice order §5 (A → B+C parallel → D → E → F). After
   each slice, run `pnpm --filter @yakcc/shave-python test`. After
   Layer-1 wire tests pass, validate the Python script via the
   subprocess test (or a direct stdin pipe) before moving to TS work.
6. Stage all changes; do **not** run `git commit` — implementer role
   cannot land per memory `feedback_implementer_cannot_commit`.
   `guardian:land` will compose the commit.
7. Before guardian:land:
   - Rebase onto `origin/main` (memory `feedback_pre_push_hygiene`).
   - Run `pnpm --filter @yakcc/shave-python lint`,
     `pnpm --filter @yakcc/shave-python typecheck`,
     `pnpm --filter @yakcc/shave-python test`. Capture outputs for the
     PR description.
   - Verify `gh issue view 890 --json labels` still includes `serenity`
     (memory `feedback_serenity_claim_label`); if missing, re-add via
     `gh issue edit 890 --add-label serenity`.
   - Confirm `git diff --stat origin/main..HEAD --
     packages/shave-python/src/raise-body.ts` shows zero output (scope
     manifest invariant).
8. After reviewer verdict, ensure `cc-policy evaluation set
   ready_for_guardian --workflow-id wi-890-classmethods --head-sha <HEAD>`
   ran (memory `feedback_agent_tool_completion_projection_gap`).
9. PR title: `feat(shave-python): #890 — extract class methods (static/class/instance) from class bodies`.
   PR body: paste §6 evidence verbatim; reference the bs4 exploration
   that motivated the WI; note that re-running the exploration post-merge
   is the issue's acceptance step (not part of this PR).
10. Closes #890.

---

## 10 — Post-landing follow-ups (backlog issues, not in this WI)

- **Class scaffolding in compile-python** — compose raised
  `ClassName_methodName` functions back into TS `class { ... }`
  declarations. Required if downstream consumers want true class
  semantics in the compiled output. File as a new GH issue referencing
  #890 + this PLAN's DEC-WI890-007.
- **Nested class extraction** — recurse into `ClassDef.body[ClassDef]`
  for arbitrarily deep nesting. Out of scope per #890; file a follow-up
  if e2e exploration shows nested classes as common.
- **Inheritance + `super()` modeling** — out of scope; file follow-up
  if needed.
- **Whitelist pure instance methods** — a narrow rule that admits
  instance methods which (a) annotate `self: Self`, (b) only access
  `self.attr` for reading (no `self.attr = ...`), and (c) only call
  other pure methods on `self`. Requires call-graph analysis. File as
  separate WI.
- **Auto-synthesize `cls: unknown` / `self: unknown`** for unannotated
  first parameters when `methodKind` is `class` or `instance`. Trade-off
  documented in DEC-WI890-004. File as separate WI if coverage of
  real-world classmethods needs widening.
- **Class-level docstring extraction** — emit class docstrings into a
  new `module.classes[]` array (separate envelope shape). Folds in
  PEP-257 coverage at the class level (WI-888 covered function-level
  only).
- **bs4 exploration re-run** — operator-driven validation that the
  6 → 15+ fnCount improvement materializes. Not a code change; runs
  against merged HEAD.

---

PLAN authored 2026-05-30 against worktree HEAD on branch
`feature/890-class-methods`. Operator dispatch identified class-method
extraction as the dominant bs4 e2e blocker (9 of 15 production files
yielding 0 functions) and specified the three-decorator split
(`@staticmethod` / `@classmethod` / regular) with `instance_method` as
the new `ImpurityKind` rejection label; this plan encodes the
class-body walker in `libcst-parse.py`, the `methodKind` discriminator
through `parse-fn-signature.ts`, the dual rejection short-circuits in
`extractOne` + `checkFunctionPurity`, the dot-to-underscore identifier
rewrite in `raise-function.ts`, and the four-layer test contract,
with the Evaluation Contract and Scope Manifest pinned for guardian
readiness. The `raise-body.ts` renderer is intentionally untouched
(scope-manifest invariant); rejection fires pre-render so the existing
render path remains a pure consumer of already-validated signatures.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: Drafted WI-890 plan covering class-method extraction across libcst-parse.py (ClassDef walker + _method_kind decorator detection emitting methodKind: static/class/instance), parse-fn-signature.ts (EnvelopeFunction + FunctionSignature methodKind + extractOne instance-method short-circuit throwing ImpureFunctionError), purity-check.ts (ImpurityKind "instance_method" + checkFunctionPurity dual-layer short-circuit), and raise-function.ts (dot-to-underscore TS identifier rewrite for Foo.bar → Foo_bar); DEC-WI890-001..010 capture all design decisions; scope manifest forbids raise-body.ts (rejection fires pre-render); next dispatch is guardian:provision to seed the implementer slice.
