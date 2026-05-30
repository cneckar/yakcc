# PLAN — WI-889 shave-python type-map: Any, Callable, ModuleType, quoted forward refs, dict[Any,V]

> Planner output for [`#889`](https://github.com/cneckar/yakcc/issues/889)
> (bug, serenity, shave — "shave-python type-map: add Any, Callable, ModuleType,
> and quoted forward references (real-Python type gap)").
>
> Workflow `wi-889-type-map`, work item `wi-889-plan`, goal `g-889`.
> Branch `feature/889-type-map` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-889-type-map`.
>
> Discovered during 2026-05-29 bs4 4.14.3 e2e exploration: 7 of 15 raise
> failures are `unsupported_type` from `packages/shave-python/src/type-map.ts`.
> The downstream `compileToPython` path is currently never exercised against
> real code because everything fails at raise — fixing this unlocks bug
> discovery in the compile path.

---

## 0 — Headline

Expand `packages/shave-python/src/type-map.ts` to handle five Python annotation
patterns that are pervasive in real codebases:

1. `typing.Any` / `Any` → `unknown` (with `LowerWarning`)
2. Quoted forward references `"Foo"` / `'Foo'` — strip quotes before lookup
3. `Callable[...]` in three forms (bare, `[..., R]`, `[[A1,...], R]`)
4. `types.ModuleType` / `ModuleType` → `unknown` (with `LowerWarning`)
5. `dict[Any, V]` → `Record<string, V>` (with `LowerWarning`)

`mapPythonType` is changed from `string` → `{ tsType: string, warnings: readonly LowerWarning[] }`.
`parse-fn-signature.ts` is updated to consume the new shape and surface warnings
on `FunctionSignature` / `RaisedParam`. No other shave-python source files are
touched — downstream consumers continue to read `FunctionSignature` unchanged
and the new `warnings` field is purely additive.

Single PR closes #889.

---

## 1 — Problem decomposition

### What

The shave-python raise pipeline mechanically rejects seven distinct real-world
annotations from bs4 4.14.3:

| Annotation                  | Current behavior              | Why it matters                                    |
| --------------------------- | ----------------------------- | ------------------------------------------------- |
| `Any`                       | `UnsupportedTypeError`        | Pervasive escape hatch in typed Python            |
| `"_IncomingMarkup"`         | `UnsupportedTypeError`        | PEP 563 / 3.10+ makes ALL annotations string-quoted |
| `'Foo'` (single-quoted)     | `UnsupportedTypeError`        | Same as above, alternate quote style              |
| `Callable[[A1,...], R]`     | `UnsupportedTypeError`        | First-class function types are routine            |
| `Callable` (bare)           | `UnsupportedTypeError`        | Used in decorators and aliases                    |
| `ModuleType`                | `UnsupportedTypeError`        | Decorator/registry patterns                       |
| `dict[Any, V]`              | "dict key must be 'str'" throw | Loose-key dicts                                   |

These rejections happen at raise time, before purity-check and body-translate,
which means the downstream compile path is currently a paper tiger: no real
codebase ever reaches it. The slice-2 type table was designed defensively
(reject what we cannot lossless-encode), but the right call now is **map +
warn** for safe wideners and **keep throwing** for genuine impossibilities
(e.g. `dict[int, V]`).

### Why

Two pressures converge:

1. **#889 acceptance criteria** explicitly say "All 4 patterns map successfully
   (with LowerWarnings where appropriate)" — so warnings are part of the
   contract, not an aspirational nice-to-have. The slice-2 type-map header
   comment already anticipates this: "warn-on-loss is deferred to slice 3+
   once the warning channel exists." Issue #889 is the moment to build the
   channel.
2. **bs4 e2e unblocking.** Until at least these five widenings exist, every
   compile-path bug stays hidden behind raise-stage failures.

### Constraints

- `LowerWarning` does not exist anywhere in the codebase yet (confirmed via
  `grep` across `packages/`). This WI introduces it.
- `mapPythonType` is currently called from `parse-fn-signature.ts` at lines 95
  and 114. The workflow contract's v1 scope listed `parse-fn-signature.ts` as
  forbidden. Plumbing warnings to `FunctionSignature` requires editing that
  file — so the scope MUST widen. See §6.
- Downstream consumers (`raise-function.ts`, `purity-check.ts`) read
  `FunctionSignature` but do not currently surface warnings. They must continue
  to typecheck against the additive `warnings` field; surfacing warnings to
  end users is OUT OF SCOPE here.
- `UnsupportedTypeError` extends `CannotRaiseToIRError` from `@yakcc/contracts`
  and ships as part of the public API. Its constructor signature, message
  prefix, and parent class must not change.

### Non-goals

- #888 (docstring + bare-expr handling) — separate WI.
- #890 (class-method extraction) — separate WI.
- Expanding the type table beyond #889's five categories (e.g. `set[T]`,
  `frozenset[T]`, `Type[T]`) — out of scope.
- Surfacing warnings to CLI/stderr/logger — out of scope. Warnings ride on
  the return value only; presentation is future work.
- Promoting `LowerWarning` into `@yakcc/contracts` — defer until a second
  package needs it.
- Touching `raise-function.ts`, `raise-body.ts`, `purity-check.ts`,
  `libcst-parser.ts`, `normalize-names.ts`.

### Open question (resolved by planner)

> Q: Do we add `warnings` per-param (on `RaisedParam`) or per-function (on
> `FunctionSignature`), or both?
>
> A: **Both, additive.** `RaisedParam.warnings` captures warnings from its
> own annotation. `FunctionSignature.returnWarnings` captures warnings from
> the return-type mapping. Downstream consumers can union or display them as
> needed. This is the smallest extension that preserves locality.

---

## 2 — Architecture & state-authority map

### State authorities touched

| Domain                          | Authority                                                  | Effect              |
| ------------------------------- | ---------------------------------------------------------- | ------------------- |
| Python→TS type table            | `packages/shave-python/src/type-map.ts`                    | Expanded            |
| `FunctionSignature` shape       | `packages/shave-python/src/parse-fn-signature.ts`          | Additive field      |
| Shave-python public API surface | `packages/shave-python/src/index.ts`                       | Re-export `LowerWarning` |
| `UnsupportedTypeError` taxonomy | unchanged — same module, same constructor                  | (none)              |
| Error taxonomy (`@yakcc/contracts`) | unchanged — `CannotRaiseToIRError` unchanged           | (none)              |

### `LowerWarning` shape (new)

Defined in `type-map.ts` (or a colocated `types.ts` if the implementer
prefers), exported from `index.ts`:

```ts
export interface LowerWarning {
  /** Stable code identifying the warning category. */
  readonly code:
    | "any-widened"           // typing.Any → unknown
    | "callable-widened"      // bare Callable or Callable[..., R]
    | "module-type-widened"   // types.ModuleType → unknown
    | "dict-any-key-widened"; // dict[Any, V] → Record<string, V>
  /** Human-readable message for diagnostics. */
  readonly message: string;
  /** The original Python annotation fragment that triggered the warning. */
  readonly pythonFragment: string;
}
```

The `code` union is intentionally a closed set covering exactly this WI's five
patterns (note that `any-widened` covers both raw `Any` and `dict[str, Any]`
value-position, which is the same root cause). Future widenings extend the
union, not the shape.

### `mapPythonType` return shape (changed)

```ts
export interface MapPythonTypeResult {
  readonly tsType: string;
  readonly warnings: readonly LowerWarning[];
}

export function mapPythonType(annotation: string): MapPythonTypeResult;
```

The recursive internal helpers concatenate their inner `warnings` arrays.
The empty array is the common case (primitives, supported containers).

### `RaisedParam` and `FunctionSignature` shape (changed, additive)

```ts
export interface RaisedParam {
  readonly name: string;
  readonly tsType: string;
  readonly pythonAnnotation: string;
  readonly warnings: readonly LowerWarning[]; // NEW
}

export interface FunctionSignature {
  readonly name: string;
  readonly params: readonly RaisedParam[];
  readonly returnType: string;
  readonly pythonReturnAnnotation: string | null;
  readonly bodyPythonSource: string;
  readonly returnWarnings: readonly LowerWarning[]; // NEW
}
```

### Decision: why return-shape (option b) over warnings-out-param (option a) or silent (option c)

| Option                          | Pros                                  | Cons                                                        |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| (a) `warnings: LowerWarning[]` out-param | least change to return shape    | mutation API is awkward in TS; caller must own the buffer    |
| (b) `{ tsType, warnings }` return shape  | immutable, idiomatic TS, composable | every call site updates (2 in `parse-fn-signature.ts`)     |
| (c) silent (drop warnings entirely)      | smallest diff                        | violates #889 acceptance criteria; loses LowerWarning intent |

Picked (b). The two call-site updates are localized and easier to review than
a passed-buffer pattern; immutability makes tests trivial; recursion composes
naturally by concatenating warnings on the way up.

### Alternatives considered for the type-map widenings

- **`Any` → `any` instead of `unknown`:** rejected. TS `any` disables type
  checking transitively; `unknown` is the safe top type and forces a narrow
  at use. This matches Python `Any`'s "type system give-up" intent without
  poisoning downstream TS code.
- **`Callable` → `Function`:** rejected. `Function` is widely considered a
  TS anti-type. `(...args: unknown[]) => unknown` is the documented
  replacement.
- **`dict[Any, V]` → `Map<unknown, V>`:** rejected. The slice-2 mapping for
  `dict[str, V]` is `Record<string, V>`, and most Python code paths assume
  string-stringifiable keys. Widening to `Record<string, V>` + warning keeps
  the shape stable; `Map<unknown, V>` would be a divergent shape with no
  call-site that knows what to do with it.
- **Don't strip quotes — require unquoted only:** rejected. PEP 563 / 3.10+
  makes quoted annotations the norm; without quote-stripping the type-map
  is useless on any modern annotated codebase.

---

## 3 — Decision log (this WI)

| DEC-ID            | Decision                                                         | Rationale                                                  |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| DEC-WI889-001     | `Any` / `typing.Any` → `unknown` + `LowerWarning("any-widened")` | TS `unknown` is the safe analog; warning preserves the loss-of-type intent. |
| DEC-WI889-002     | Strip matching outer single- or double-quotes before lookup       | PEP 563 / 3.10+ quotes everything; recursive call after strip handles inner support check naturally. |
| DEC-WI889-003     | `Callable` three-form support                                    | Bare and `[...]` forms map to widened `(...args: unknown[]) => unknown` + warning; explicit `[[A1,...], R]` form maps lossless with no warning. |
| DEC-WI889-004     | `ModuleType` / `types.ModuleType` → `unknown` + warning           | Modules are opaque; purity-check will catch impurity downstream; preemptive reject is too strict. |
| DEC-WI889-005     | `dict[Any, V]` → `Record<string, V>` + warning; `dict[int, V]` still throws | Loose-key dicts are common; non-Any non-str keys remain genuinely unsupported. |
| DEC-WI889-006     | `mapPythonType` returns `{ tsType, warnings }` (option b)        | Immutable, composable, smallest blast radius for two call sites in `parse-fn-signature.ts`. |
| DEC-WI889-007     | `LowerWarning` lives in `shave-python`, not `@yakcc/contracts`    | Only one package uses it today; cross-package promotion can come when a second consumer appears. |
| DEC-WI889-008     | Warnings are structured data only; no console/stderr side-effect | Test ergonomics; future consumers (CLI, IDE, doc gen) decide presentation. |
| DEC-WI889-009     | `RaisedParam.warnings` + `FunctionSignature.returnWarnings` (per-param + per-return) | Locality — each warning ties to the annotation that produced it; consumers can union when needed. |
| DEC-WI889-010     | Scope widened to include `parse-fn-signature.ts` (+ test + `index.ts`) | DEC-006 requires editing the two call sites; legacy v1 scope was insufficient. See §6. |

---

## 4 — Wave decomposition

All five widenings + the return-shape change land as one tightly-coupled
slice. Splitting would create unstable intermediate states (e.g. type-map
returning the new shape while `parse-fn-signature.ts` still consumes the old
shape) that don't compile.

| W-ID  | Title                                                            | Weight | Gate    | Deps    | Integration                                              |
| ----- | ---------------------------------------------------------------- | ------ | ------- | ------- | -------------------------------------------------------- |
| W-1   | Add `LowerWarning` type + change `mapPythonType` return shape    | S      | none    | —       | `type-map.ts` (export + internal recursion contract)     |
| W-2   | Implement quoted-forward-reference stripping                     | S      | none    | W-1     | `type-map.ts` (top of function, before lookup)           |
| W-3   | Implement `Any` / `typing.Any` widening                          | S      | none    | W-1     | `type-map.ts` (primitive switch)                         |
| W-4   | Implement `ModuleType` / `types.ModuleType` widening             | S      | none    | W-1     | `type-map.ts` (primitive switch)                         |
| W-5   | Implement `dict[Any, V]` relaxation                              | S      | none    | W-1     | `type-map.ts` (dict subscript branch)                    |
| W-6   | Implement `Callable` three-form support                          | M      | none    | W-1     | `type-map.ts` (subscript branch — new container case)    |
| W-7   | Thread warnings through `parse-fn-signature.ts`                  | S      | none    | W-1..W-6 | `parse-fn-signature.ts` (both call sites) + interface updates |
| W-8   | Re-export `LowerWarning` from `index.ts`                         | XS     | none    | W-1     | `index.ts` (one export line)                             |
| W-9   | Unit tests — new patterns + return-shape migration               | M      | review  | W-1..W-8 | `type-map.test.ts` + `parse-fn-signature.test.ts`        |
| W-10  | Regression test for the 7 bs4 cases from #889                    | S      | review  | W-9     | `type-map.test.ts` (dedicated describe block)            |
| W-11  | Run full package test + typecheck; capture evidence              | S      | review  | W-1..W-10 | tmp/889-evidence-*.txt                                  |

**Critical path:** W-1 → (W-2..W-6 parallel) → W-7 → W-8 → W-9 → W-10 → W-11.

**Max parallel width:** 5 (W-2..W-6 are independent within `type-map.ts` once
the return shape is settled in W-1).

**Single implementer:** because all the work is in one file (plus a small
extension to one neighbor and one re-export), a single implementer pass is
the right shape, with the test/regression W-9/W-10 written interleaved with
the implementation so failures surface early.

---

## 5 — Evaluation Contract

The full machine-readable contract is in
[`tmp/889-evaluation.json`](tmp/889-evaluation.json). Summary:

### Required tests

- **`type-map.test.ts`** gains five new describe blocks (`Any`, `quoted forward
  references`, `Callable`, `ModuleType`, `dict[Any, V]`) plus a `real bs4
  regressions` table-driven block exercising the 7 verbatim annotations from
  #889. Existing primitive/container assertions are updated to destructure
  `{ tsType, warnings }`.
- **`parse-fn-signature.test.ts`** gains coverage for warnings threading:
  param-level warnings collect on `RaisedParam.warnings`; return-type warnings
  collect on `FunctionSignature.returnWarnings`.

### Required evidence

- `pnpm --filter @yakcc/shave-python test` — full passing output captured to
  `tmp/889-evidence-shave-python-tests.txt`.
- `pnpm --filter @yakcc/shave-python typecheck` (or workspace-wide) — clean
  output to `tmp/889-evidence-typecheck.txt`.

### Required real-path checks

For each of the 7 bs4 annotations from #889, a dedicated unit test asserts
that `mapPythonType` no longer throws for the original slice-2 reason:

| #   | Annotation                  | Expected post-fix                                      |
| --- | --------------------------- | ------------------------------------------------------ |
| 1   | `Callable[[Any], Any]`      | `(arg0: unknown) => unknown` + 2 LowerWarnings (`any-widened`) |
| 2   | `Callable`                  | `(...args: unknown[]) => unknown` + 1 LowerWarning (`callable-widened`) |
| 3   | `"_IncomingMarkup"`         | quote-strip then throw on inner `_IncomingMarkup` (which remains genuinely unsupported — the bug was the quote handling, not the inner symbol). Test asserts the error message references `_IncomingMarkup`, not the quoted form. |
| 4   | `"_IncomingMarkup"` (again, from `lxml_trace`) | same as above (covered by one test case) |
| 5   | `dict[Any, str]`            | `Record<string, string>` + 1 LowerWarning (`dict-any-key-widened`) |
| 6   | `ModuleType`                | `unknown` + 1 LowerWarning (`module-type-widened`)     |
| 7   | `Any` (from `__getattr__`)  | `unknown` + 1 LowerWarning (`any-widened`)             |

### Forbidden shortcuts

- No silent fallback to `unknown` for genuinely-unsupported types. `dict[int, V]`,
  unknown primitives (`Decimal`), and unknown containers (`MyContainer[T]`)
  must still throw `UnsupportedTypeError`.
- No edits to `raise-body.ts`, `raise-function.ts`, `purity-check.ts`,
  `libcst-parser.ts`, `normalize-names.ts`.
- No `console.warn` / stderr side-effect for warnings; structured data only.
- No change to `UnsupportedTypeError`'s constructor, message prefix, or parent.
- No `LowerWarning` promotion into `@yakcc/contracts`.
- No regression of any currently-passing `type-map.test.ts` assertion.

### Ready-for-guardian definition

- All required tests pass (`pnpm --filter @yakcc/shave-python test`).
- `pnpm -w typecheck` is clean.
- All 7 bs4 annotations have explicit dedicated test cases that pass.
- Reviewer has confirmed: (i) no forbidden-path edits; (ii) `LowerWarning`
  shape is stable enough to extend; (iii) `parse-fn-signature.ts` threading
  correctly carries warnings into `RaisedParam` / `FunctionSignature`; (iv)
  `UnsupportedTypeError` semantics preserved for genuinely-unsupported types.

---

## 6 — Scope Manifest

The current runtime scope (v1) was set at workflow bootstrap and only allows
`type-map.ts` + `type-map.test.ts`. DEC-WI889-006 (chosen return-shape change)
and DEC-WI889-010 (warnings threading) require editing
`parse-fn-signature.ts` (+ its test + `index.ts`). The widened scope is in
[`tmp/889-scope-v2.json`](tmp/889-scope-v2.json). Implementer/guardian MUST
sync it before any source edit:

```bash
cc-policy workflow scope-sync wi-889-type-map \
  --work-item-id wi-889-plan \
  --scope-file tmp/889-scope-v2.json
```

### Allowed paths (v2)

- `packages/shave-python/src/type-map.ts`           — primary subject
- `packages/shave-python/src/type-map.test.ts`      — primary tests
- `packages/shave-python/src/parse-fn-signature.ts` — warnings threading
- `packages/shave-python/src/parse-fn-signature.test.ts` — threading tests
- `packages/shave-python/src/index.ts`              — re-export `LowerWarning`
- `tmp/**`                                          — evidence artifacts
- `PLAN.md`                                         — this file

### Required paths

- `packages/shave-python/src/type-map.ts`
- `packages/shave-python/src/type-map.test.ts`

### Forbidden paths

- `packages/shave-python/scripts/**`
- `packages/shave-python/src/raise-body.ts`
- `packages/shave-python/src/raise-function.ts`
- `packages/shave-python/src/purity-check.ts`
- `packages/shave-python/src/libcst-parser.ts`
- `packages/shave-python/src/normalize-names.ts` (note: v1 had a typo —
  `normalize.ts` — corrected here; file is `normalize-names.ts`)
- `packages/compile-python/**`
- `packages/cli/**`
- `packages/shave/**`
- `packages/compile/**`
- `packages/contracts/**`   (do NOT promote `LowerWarning` here yet)
- `bootstrap/**`
- `.github/**`
- `.claude/**`

### State authorities touched

- (none — no runtime/control-plane authority is affected)

---

## 7 — Implementer marching orders

1. **Sync scope first.** Run the `cc-policy workflow scope-sync` command in
   §6. Without this, the hook layer will deny edits to `parse-fn-signature.ts`.
2. **Wave 1 — return-shape skeleton.** In `type-map.ts`:
   - Add the `LowerWarning` interface and `MapPythonTypeResult` interface.
   - Change `mapPythonType` to return `MapPythonTypeResult` instead of
     `string`. For every existing branch, return `{ tsType: <existing>, warnings: [] }`.
   - Update internal recursion (list, dict, tuple, Optional, Union, PEP 604
     `|`) to concatenate child warnings into the parent's `warnings`.
   - All existing tests will now fail to typecheck — that is expected;
     migrate them in W-9.
3. **Wave 2 — quoted-forward-reference stripping.** At the very top of
   `mapPythonType` (after `trim`, before any other logic):
   ```ts
   if ((s.startsWith('"') && s.endsWith('"')) ||
       (s.startsWith("'") && s.endsWith("'"))) {
     s = s.slice(1, -1).trim();
     return mapPythonType(s); // recursive — inner support check is natural
   }
   ```
   Edge case: empty string after strip (`""` / `''`) should throw the same
   "Empty type annotation" error as the original empty input.
4. **Waves 3 & 4 — `Any` and `ModuleType` widenings.** Add to the primitive
   switch (or a parallel switch dedicated to widened types):
   ```ts
   case "Any":
   case "typing.Any":
     return { tsType: "unknown", warnings: [{ code: "any-widened", message: "Python 'Any' widened to TS 'unknown'", pythonFragment: s }] };
   case "ModuleType":
   case "types.ModuleType":
     return { tsType: "unknown", warnings: [{ code: "module-type-widened", message: "Python 'ModuleType' widened to TS 'unknown'", pythonFragment: s }] };
   ```
5. **Wave 5 — `dict[Any, V]` relaxation.** In the existing `dict` subscript
   branch, when `keyType === "Any"`, do not throw — produce `Record<string, V>`
   and emit a `dict-any-key-widened` warning concatenated with the
   recursively-mapped value's warnings.
6. **Wave 6 — `Callable` three-form support.** Add a new container case in
   the subscript switch:
   - Bare `Callable` (no subscript) — handle BEFORE `parseSubscript` (since it
     has no brackets). Add to a "widened primitive" check or a dedicated
     pre-subscript branch.
   - `Callable[..., R]` (Ellipsis `...` for params) — detect via `inner.startsWith("...,")` or by splitting the top-level comma and checking first arg equals `"..."`. Map to `(...args: unknown[]) => <mapped R>` + warning.
   - `Callable[[A1, A2], R]` — `inner` starts with `[`; parse the bracketed
     arg list, top-level-split inner by `,`, map each, and emit
     `(arg0: A1, arg1: A2) => R`. No warning when the form is fully explicit.
   - Use `splitTopLevel` for argument parsing (it already handles nested
     brackets).
   - Edge cases: `Callable[[], R]` → `() => R`; nested
     `Callable[[Callable[[int], int]], int]` recurses correctly because
     `mapPythonType` already handles nested generics.
7. **Wave 7 — thread warnings into `parse-fn-signature.ts`.** Update both
   call sites (lines 95 and 114) to destructure `{ tsType, warnings }` and
   attach `warnings` to `RaisedParam.warnings` and
   `FunctionSignature.returnWarnings`. Update the interface declarations at
   the top of the file. Update the catch-and-rethrow blocks to attach the
   function/param context to the same `UnsupportedTypeError` (no shape
   change to the error class).
8. **Wave 8 — re-export.** Add `export type { LowerWarning, MapPythonTypeResult } from "./type-map.js"` to `index.ts`.
9. **Wave 9 — tests.** Migrate every existing `type-map.test.ts` assertion
   to destructure `.tsType`. Add the five new describe blocks. Add the
   parse-fn-signature warnings-threading tests.
10. **Wave 10 — regression block.** Add a `describe("mapPythonType — real bs4
    regressions from #889", ...)` block that iterates over the 7 verbatim
    annotations from the issue table and asserts the expected post-fix
    behavior (see §5 Required real-path checks table).
11. **Wave 11 — evidence.** Capture passing test output and typecheck output
    to `tmp/889-evidence-shave-python-tests.txt` and
    `tmp/889-evidence-typecheck.txt`. Reviewer will inspect these.

### Implementer self-checks before READY_FOR_REVIEWER

- [ ] `git diff --stat` shows ONLY the v2 scope's allowed files modified.
- [ ] `pnpm --filter @yakcc/shave-python test` is 100% green.
- [ ] `pnpm -w typecheck` is clean (no new errors anywhere in the workspace —
      consumers of `FunctionSignature` must not break on the additive field).
- [ ] Existing assertions in `type-map.test.ts` have been migrated to
      `.tsType` (none deleted, none weakened).
- [ ] `dict[int, V]`, unknown primitive (`Decimal`), and unknown container
      (`MyContainer[T]`) test cases still throw `UnsupportedTypeError`.
- [ ] No `console.*` or `process.stderr.write` calls introduced anywhere.
- [ ] All 7 #889 bs4 annotations have dedicated regression tests that pass.

---

## 8 — Out of scope (deferred)

| Deferred item                                                | Rationale                                          |
| ------------------------------------------------------------ | -------------------------------------------------- |
| Docstring / bare-expr handling (#888)                        | Separate WI; orthogonal raise-stage concern.       |
| Class-method extraction (#890)                               | Separate WI; libcst-parser surface.                |
| `set[T]`, `frozenset[T]`, `Type[T]`, `Literal[...]`, `TypeVar` | Not in #889's list; defer until a real-code blocker appears. |
| Surfacing `LowerWarning` to CLI/stderr/IDE                   | Presentation layer; structured data is enough for now. |
| Promoting `LowerWarning` into `@yakcc/contracts`             | Only one package consumes it; promote on second consumer. |
| Replacing throw-on-unsupported with a result type            | Bigger refactor; current `UnsupportedTypeError` is fine. |

---

## 9 — Risk register

| Risk                                                                                         | Mitigation                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Scope drift — implementer touches `raise-function.ts` to surface warnings                    | v2 scope manifest forbids it; `cc-policy workflow scope-sync` is gating.                  |
| Return-shape change ripples into other packages                                              | `mapPythonType` is only consumed by `parse-fn-signature.ts` (verified by grep); `index.ts` only re-exports the symbol — no behavior change to other packages. |
| Quote-stripping mis-fires on legitimate annotations with embedded quotes                     | Only strip when BOTH start and end quote match; recursive call handles inner support naturally. Tested with `"int'` (mixed-quote) assertion. |
| `Callable` parser drifts on edge cases (e.g. `Callable[[], R]`, deeply-nested)               | Use existing `splitTopLevel` + `parseSubscript`; add explicit test cases for 0-arg, 1-arg, nested-callable.|
| Warnings interface churn — adding `LowerWarning.code` values later breaks consumers           | `code` is a string-literal union; adding a member is non-breaking. Document this in `LowerWarning` JSDoc. |
| Downstream consumers silently ignore warnings                                                | Acceptable for this slice — surfacing is explicitly out of scope. Future WI will wire CLI/IDE display. |

---

## 10 — Verification

When implementer claims READY_FOR_REVIEWER, reviewer must:

1. Confirm `git diff --stat` files match the v2 scope manifest exactly.
2. Run `pnpm --filter @yakcc/shave-python test` and verify green.
3. Run `pnpm -w typecheck` and verify clean.
4. Open `tmp/889-evidence-shave-python-tests.txt` and confirm:
   - At least 5 new describe blocks for the new patterns.
   - A dedicated `real bs4 regressions` block with all 7 cases.
   - parse-fn-signature warnings-threading test passes.
5. Inspect `type-map.ts` and confirm: `UnsupportedTypeError` constructor
   unchanged; no `console.*` calls; quote-stripping is bidirectional
   (matching open+close); `Callable` handles all three forms; `dict[int, V]`
   still throws.
6. Inspect `parse-fn-signature.ts` and confirm: both call sites destructure
   the new shape; `RaisedParam.warnings` and `FunctionSignature.returnWarnings`
   are correctly populated; catch-and-rethrow blocks unchanged in semantics.
7. Emit `REVIEW_VERDICT=ready_for_guardian` with `head_sha` matching the
   current branch HEAD.

---

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-889 plan complete — 5 type-map widenings + LowerWarning channel + return-shape change to mapPythonType with warnings threaded into parse-fn-signature.ts/FunctionSignature; scope widened to v2; evaluation contract + 10 DECs recorded; next stage is guardian:provision (worktree already provisioned, implementer can pick up directly).
