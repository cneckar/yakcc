# PLAN — WI-933/934 shave-python: ADR Q11 + class/method uncurry raise

> Planner output for paired issues [`#933`](https://github.com/cneckar/yakcc/issues/933)
> (ADR Q11 — decomposition lives at substrate) and
> [`#934`](https://github.com/cneckar/yakcc/issues/934) (Python class/method
> raise via uncurry-to-free-function).
> Workflow `wi-933-934-class-raise`, work item `wi-933-934-plan`, goal `g-933-934`.
> Branch `feature/933-934-class-raise` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-933-934-class-raise`.
>
> Supersedes the prior WI-890 plan content at this path. WI-890 (class-body
> method extraction → flat `module.functions[]` with dotted names) landed in
> commit `a91c87b`; this plan addresses the architectural follow-up.
>
> Operator dispatch (2026-05-30): bs4 4.14.3 e2e exploration after WI-890
> (class-method extraction wired) still showed bs4 mostly empty because the
> bulk of bs4 code is **instance methods** that WI-890 rejects with
> `ImpureFunctionError(kind:"instance_method")`. The architectural fix —
> agreed in #933 and operationally implemented in #934 — is **uncurry**:
> instance methods on classes with pure-derivable `__init__` raise to free
> functions `ClassName_methodName(self: ClassNameState, ...)`. The substrate's
> existing `recurse()` / `decomposableChildrenOf()` decomposition pipeline
> then mines atoms from those raised method bodies the same way it already
> mines atoms from TypeScript class methods. The adapter raises; the
> substrate decomposes; no adapter-side decomposition.

---

## 0 — Headline

Two paired deliverables, one branch, one PR. **#933 is doc-only and lands
first inside the same PR** so the principle is written down before #934's
implementation lands beneath it. #934 is the implementation that the new
principle authorizes.

1. **#933 — ADR addendum Q11 + decision-log entry.**
   `docs/archive/developer/adr/polyglot-architecture.md` gains a new `## Q11`
   section verbatim from the issue body. A new entry
   `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` captures the
   single-page decision record: principle, originating concern, lowering
   rules per language, failure mode (`DidNotReachAtomError`), and what the
   rule means for MVP adapter slices.
2. **#934 — Python class/method raise.** New
   `packages/shave-python/src/raise-class.ts` implementing state-type
   derivation from `__init__`, factory function for the constructor,
   free-function uncurry for each method, `self.field` and
   `self.method(...)` rewriting in method bodies, and
   `CannotRaiseToIRError` rejection for unsupported class shapes.
   `libcst-parse.py` envelope extends with a structural `module.classes[]`
   array. `parse-fn-signature.ts` and `purity-check.ts` thread through so
   that instance methods on raisable classes fork to `raise-class`
   **before** the WI-890 short-circuit fires. Two test files cover the unit
   behavior and the substrate integration.

The integration acceptance criterion (#934 #d) is exactly the bridge between
the two issues: feed a raised Python class through the substrate's existing
shave pipeline; verify ≥2 atoms emerge from a method body with ≥3
statements. If only one atom per method emerges, the raise produced
malformed IR — diagnose by inspecting the IR, not by adding adapter-side
decomposition.

---

## 1 — Problem decomposition

### 1.1 What problem are we actually solving?

**Surface problem:** bs4 4.14.3 e2e exploration emits 0 functions from 9 of
15 production files. bs4 is mostly instance methods; WI-890 rejects every
instance method with `ImpureFunctionError`.

**Root problem:** the MVP adapter framing "instance methods are impure → not
shavable" is too coarse. An instance method that only reads `self.field`
and calls other instance methods on the same class is structurally
equivalent to a free function over `(self, ...args)`. The Python adapter
should raise it that way and let the substrate's general-purpose
decomposition do its job inside the body.

**Principle being violated (now made explicit by #933):** decomposition
lives at the substrate, not in adapters. WI-890 was reaching the right
adapter answer ("don't decompose method bodies in the adapter") via the
wrong adapter mechanism ("therefore reject the whole method"). The right
mechanism is "raise the method body verbatim and hand it to the
substrate". The Python adapter has no business deciding whether a method
body is shavable — it should produce well-formed IR and let `recurse()`
decide.

### 1.2 Goals (measurable)

- G1. `docs/archive/developer/adr/polyglot-architecture.md` gains `## Q11`
  section verbatim from #933 issue body, anchored to
  `DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001`.
- G2. A canonical decision record exists at
  `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` — single page,
  cross-references the ADR, names the substrate authority surface
  (`packages/shave/src/universalize/recursion.ts`), names the originating
  concern, names the failure mode (`DidNotReachAtomError`).
- G3. `packages/shave-python/scripts/libcst-parse.py` emits a new
  `module.classes[]` structural array alongside the existing flat
  `module.functions[]`. Module-level fn envelopes are byte-equivalent to
  pre-WI-934 output (regression test).
- G4. `packages/shave-python/src/raise-class.ts` (new) raises a single
  Python class to a TS-subset emit: a `State` interface declaration, a
  `Class_create` factory function, one free function per instance method,
  with `self.field` and `self.method(args)` rewritten into the uncurried
  form.
- G5. Instance methods on classes with a pure-derivable `__init__` flow
  through `raise-class` and are no longer rejected with
  `ImpureFunctionError(kind:"instance_method")`. Methods on classes with
  non-pure-derivable `__init__` (or unsupported shape) are rejected with
  `CannotRaiseToIRError` carrying the construct name and source location.
- G6. `raise-class.integration.test.ts`: take a Python class with at least
  one method whose body has ≥3 statements, raise it, feed the IR to the
  substrate's standard shave pipeline (`@yakcc/shave` consumed as a dev
  dependency from this test), and assert that **≥2 atoms** are emitted from
  that one method's body. This is the bridge that proves the raise
  succeeded.
- G7. bs4 e2e re-exploration after this PR lands shows a measurable lift in
  raised+decomposed atoms across the bs4 corpus. Not a hard numeric gate;
  recorded as evidence in PR description.
- G8. `pnpm --filter @yakcc/shave-python test`, `typecheck`, `lint` all
  green. No regressions in existing test files.

### 1.3 Non-goals (explicit exclusions)

- N1. **Editing `packages/shave/src/**` substrate.** Forbidden by scope
  manifest. The whole point of #933 is "don't touch the substrate from
  here". Note this **departs from #933 issue body item (3)** which asks for
  a header comment on `recursion.ts` — that comment is deferred to a
  follow-up slice (DEC-WI933-005 below). The principle still lands via the
  ADR + decision log.
- N2. **Editing `packages/contracts/**`.** Forbidden by scope manifest.
  `CannotRaiseToIRError` already exists in
  `@yakcc/contracts/polyglot-errors.ts` with the right shape; we consume
  it (DEC-WI934-007).
- N3. **`@property` / `@classmethod` / `@staticmethod` decorators on
  class methods.** Classmethod/staticmethod are already handled by WI-890
  via the flat `module.functions[]` list. Properties are deferred — the
  raise rejects them with `CannotRaiseToIRError`.
- N4. **Multiple inheritance, mixins, metaclasses, abstract base classes,
  generic class parameters, `__slots__` / `__getattr__` / `__getattribute__`
  machinery, `dataclass`, `pydantic`.** All rejected with
  `CannotRaiseToIRError` (DEC-WI934-007).
- N5. **Mutation of `self.field` outside `__init__`.** Rejected — the class
  is non-pure-derivable. Any `Assign(target=Attribute(value=Name("self")))`
  inside a non-`__init__` method body fails the raise.
- N6. **Async methods.** Already out of envelope per WI-782; no change here.
- N7. **Chained method calls (`self.foo().bar()`).** The inner
  `self.foo()` rewrites; the outer `.bar()` is just regular `Attribute`
  access on the result. If the result type doesn't have `.bar()` in the
  TS-subset IR (e.g. it's another method-as-uncurried-free-function which
  cannot be dot-called), this fails downstream — that failure is acceptable
  and surfaces during raise-body or substrate stages. Document as MVP edge.
- N8. **Bootstrap manifest writes (`bootstrap/expected-roots.json`).**
  Forbidden by scope manifest. CI-only writer per
  `DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001`.

### 1.4 Unknowns and ambiguities (resolved here)

- U1. **Where should `DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001` actually
  live?** Issue body says "append to
  `docs/archive/developer/MASTER_PLAN.md` Decision Log". The scope manifest
  does **not** include that file in allowed_paths; it includes
  `docs/decisions/**`. Resolved: land the decision record under
  `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md`. The
  MASTER_PLAN.md Decision Log row append is deferred to a follow-up doc
  slice (DEC-WI933-004 below).
- U2. **Should `CannotRaiseToIRError` be the rejection class, or do we
  reuse `ImpureFunctionError` with a new kind?** Resolved: use
  `CannotRaiseToIRError` from `@yakcc/contracts`. The class already exists
  with the right shape (construct + SourceLocation) — verified at
  `packages/contracts/src/polyglot-errors.ts:34-46`. The operator-dispatch
  suggestion to reuse `ImpureFunctionError` was based on the incorrect
  assumption that the contracts class didn't exist. **`ImpureFunctionError`
  is reserved for genuine purity violations** (I/O, mutable globals,
  mutation of `self.field` outside `__init__`). `CannotRaiseToIRError` is
  for structural / envelope-out-of-range rejections (metaclasses, multiple
  inheritance, properties, etc.).
- U3. **Does `shave-python` already depend on `@yakcc/shave` for the
  integration test?** Verified `packages/shave-python/package.json`:
  `dependencies = @yakcc/contracts` only; `devDependencies = @yakcc/ir`
  + biome + types + typescript + vitest. **`@yakcc/shave` is not on the
  list.** Resolved: the implementer adds
  `"@yakcc/shave": "workspace:*"` to `devDependencies`. Verify scope
  manifest covers `packages/shave-python/package.json` — if not, request a
  one-line scope widening before the implementer starts (see §6.5).
- U4. **Naming for `_PrivateClass`:** preserve leading underscore.
  `_PrivateClass.do_thing` → `_PrivateClass_doThing`. Consistent with
  existing normalize-names rule 2 ("leading underscore preserved").
- U5. **What does the substrate's shave entry point look like from a unit
  test perspective?** The integration test imports the entry point and
  feeds in TS source as a string. The implementer must read
  `packages/shave/src/index.ts` (read-only) before drafting the integration
  test to determine the exact entry symbol. If no public entry accepts a
  source-string input directly, the implementer escalates rather than
  reaching into substrate internals.

### 1.5 Dominant constraints

- C1. **Scope manifest is law.** `packages/shave/src/**`,
  `packages/contracts/**`, `packages/cli/**`, `packages/compile-python/**`,
  `bootstrap/**`, `.github/**`, `.claude/**`, and several specific
  `packages/shave-python/src/*` files are forbidden. The implementer
  must not touch any of them.
- C2. **`packages/shave-python/src/raise-body.ts`, `libcst-parser.ts`,
  `type-map.ts`, `normalize-names.ts` are forbidden by scope manifest.**
  This is the most surprising constraint — these are the files WI-890
  threaded `methodKind` through. We cannot extend them in this WI.
  Resolved: `raise-class.ts` reuses these modules' exports without
  modifying their source. Naming normalization for `ClassName_methodName`
  composes existing `normalizeIdentifier` calls (one for the class name,
  one for the method name) and joins with `_` — no edit to the underlying
  module. If during implementation a real type-map gap is found (e.g.
  `ClassNameState` type-mapping needs new logic), the implementer
  escalates for scope widening rather than working around it.
- C3. **Allowed source files in scope:** `raise-class.ts`,
  `raise-class.test.ts`, `raise-class.integration.test.ts`,
  `raise-function.ts`, `raise-function.test.ts`, `parse-fn-signature.ts`,
  `parse-fn-signature.test.ts`, `purity-check.ts`, `purity-check.test.ts`,
  `libcst-parser.test.ts`, `index.ts`. The implementer can edit
  `parse-fn-signature.ts` (and its tests) to thread classes through, and
  `purity-check.ts` (and its tests) to integrate the class-method routing.
  Plus `index.ts` for barrel exports of `raise-class` symbols.
- C4. **The integration test must consume `@yakcc/shave` as a workspace
  dev dependency.** Substrate source is forbidden for edits, but consuming
  the package's exported entry point in a downstream test is consumption,
  not modification.
- C5. **No source-code edits in #933 deliverable.** ADR + decision log
  only. The dispatched scope already explicitly carves the
  `recursion.ts` header comment out of this WI.

---

## 2 — Architecture design & state-authority map

### 2.1 State-authority map (where state lives)

| Operational fact | Authority | This WI touches? |
|---|---|---|
| Decomposition algorithm | `packages/shave/src/universalize/recursion.ts` (`recurse()` + `decomposableChildrenOf()`) | **read-only consume** via dev dep in integration test |
| TS-subset IR envelope | `@yakcc/ir` | no |
| Polyglot raise-failure error taxonomy | `@yakcc/contracts/polyglot-errors.ts` (`CannotRaiseToIRError`, `AmbiguousPurityError`) | **read-only consume** — use `CannotRaiseToIRError` from existing export |
| Python AST → wire envelope | `packages/shave-python/scripts/libcst-parse.py` | **extend** — add `_class_envelope` walker, emit `module.classes[]` |
| Wire envelope → typed `FunctionSignature` | `packages/shave-python/src/parse-fn-signature.ts` | **extend** — add `extractClassEnvelopes` export; preserve existing `extractOne` short-circuit unchanged |
| Static purity inference | `packages/shave-python/src/purity-check.ts` | **read-only consume**; new `instance_method` kind value reused unchanged |
| Python class → TS uncurried emit | (new) `packages/shave-python/src/raise-class.ts` | **create** |
| snake_case → camelCase naming | `packages/shave-python/src/normalize-names.ts` | **read-only consume** (forbidden for edits) |
| Type mapping (Python → TS subset) | `packages/shave-python/src/type-map.ts` | **read-only consume** (forbidden for edits) |
| Free-function raise pipeline | `packages/shave-python/src/raise-function.ts` | **optional touch-ups only** (orchestration glue if needed) |
| Package public surface | `packages/shave-python/src/index.ts` | **extend** — barrel-export `raise-class` symbols |
| ADR | `docs/archive/developer/adr/polyglot-architecture.md` | **extend** — append `## Q11` section |
| Decision log (canonical individual decision records) | `docs/decisions/` (new directory in this repo) | **create** — first entry in this dir |
| Project decision log (table) | `docs/archive/developer/MASTER_PLAN.md` | **forbidden** in this WI's scope manifest — deferred to follow-up |

### 2.2 ADR Q11 placement

The ADR currently ends at `## Q8 — Identity / Merkle-root semantics` (line 277,
file ends at line 382). There is no `## Q9` or `## Q10`. The Q11 section
appends at the end of the file (after the existing closing matter).

**Style normalization required:** the issue body section header is
"`## Q11. Where does decomposition live?`" but the existing ADR uses
`## Q1 — TS-subset IR expressive envelope` (em-dash style). The implementer
normalizes the new heading to match existing ADR style:
`## Q11 — Where does decomposition live?` Document this normalization at
the top of the ADR commit.

### 2.3 Decision-record format

`docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` follows the same
top-matter shape as the ADR's own DEC entries:

```markdown
# DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001 — Decomposition lives at substrate, adapters only raise

**Status:** Accepted
**Date:** 2026-05-30
**Issue:** https://github.com/cneckar/yakcc/issues/933
**Related:** #934 (Python class/method raise — first consumer of this rule)
**ADR section:** docs/archive/developer/adr/polyglot-architecture.md §Q11

## Decision
<single paragraph>

## Originating concern
<operator quote 2026-05-28>

## Authority surfaces
- packages/shave/src/universalize/recursion.ts (`recurse()`, `decomposableChildrenOf()`)
- packages/shave/src/universalize/recursion.ts:222 (`DidNotReachAtomError` tripwire)

## Lowering rules per adapter
<Python / Go / Rust paragraphs from issue body>

## Failure mode
<DidNotReachAtomError explanation>

## What this means for adapter MVPs
<MVP-defers-method-support paragraph from issue body>

## Cornerstones preserved
- DEC-POLYGLOT-IR-CANONICAL-001 (TS-subset IR is canonical)
- DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001 (real source only)
- Reproducibility by construction
```

### 2.4 libcst-parse.py wire-shape extension

New `module.classes[]` array, additive only — `module.functions[]` continues
to be populated identically to post-WI-890 behavior (so module-level fns
and class methods extracted via WI-890's dotted-name path remain visible).

```json
{
  "classes": [
    {
      "name": "EmailValidator",
      "bases": ["object"],
      "decorators": ["dataclass"],   // present if any class decorators; raise-class rejects all
      "metaclass": null,             // string if class Foo(metaclass=Meta) detected, else null
      "init_assignments": [
        {"target": "max_length", "value": {"type": "Name", "name": "max_length"}}
      ],
      "init_params": [
        {"name": "max_length", "annotation": "int"}
      ],
      "methods": [
        {
          "name": "check_length",
          "params": [{"name": "self", "annotation": null}, ...],
          "return_annotation": "bool",
          "body_source": "...",
          "body": [<Stmt>...],
          "methodKind": "instance"
        }
      ],
      "class_vars": [
        {"name": "AMPERSAND_OR_BRACKET", "value": {"type": "String", "value": "&"}}
      ],
      "raise_blockers": []
    }
  ]
}
```

`raise_blockers[]` is the libcst-side first-pass detection — if libcst sees
a metaclass, non-trivial base, `__slots__`, etc., it adds a blocker string
so the TS side can `CannotRaiseToIRError` without re-doing the structural
check. This keeps the Python-side walker authoritative for structural
detection (one authority per fact, per CLAUDE.md).

Existing `_class_method_envelopes` (WI-890) keeps emitting into
`module.functions[]` with dotted names so the WI-890 flat-list consumers
remain byte-equivalent. The new `module.classes[]` is purely additive.

### 2.5 raise-class.ts module shape

```ts
export interface RaisedClass {
  /** Class name as written in Python. */
  readonly name: string;
  /** Derived state interface declaration as TS source. */
  readonly stateInterfaceTs: string;
  /** Factory function (ClassName_create) as TS source. */
  readonly factoryTs: string;
  /** Each method raised as a free function — TS source. */
  readonly methodsTs: readonly string[];
  /** Warnings from type-mapping and body-rendering, aggregated. */
  readonly warnings: readonly LowerWarning[];
}

export function raiseClass(envelope: EnvelopeClass): RaisedClass;
```

Internal flow inside `raiseClass`:

1. **Validate envelope:** check `bases`, `metaclass`, `decorators`,
   `raise_blockers`. Reject with `CannotRaiseToIRError(construct, location)`
   for any unsupported shape (DEC-WI934-007).
2. **Derive state shape from `__init__`:** for each `init_assignments[i]`,
   if `value` is a `Name` and matches an `init_params[j]`, infer the field
   type from `init_params[j].annotation` via `mapPythonType`. If `value` is
   any non-Name expression, reject the class with
   `CannotRaiseToIRError("non-trivial __init__")`.
3. **Emit `ClassNameState` interface:** all fields `readonly`, types from
   step 2.
4. **Emit `ClassName_create`:** factory function taking the same params as
   `__init__` (minus `self`), returning a frozen object literal.
5. **Emit each method as a free function:** for each
   `methods[i]` with `methodKind:"instance"`:
   - Build a synthetic `FunctionSignature` with name
     `ClassName_methodNameNormalized`, params `[{name:"self", tsType:"ClassNameState"}, ...rest]`,
     return type from `return_annotation`.
   - Pre-walk the method body wire AST and rewrite:
     - `Name("self")` → `Name("self")` (unchanged — `self` is a regular
       param at the IR level)
     - `Attribute(value=Name("self"), attr=X)` (read) →
       `Attribute(value=Name("self"), attr=normalizeIdentifier(X))`
       (camelCased field read)
     - `Assign(target=Attribute(value=Name("self"), ...))` → **reject**:
       throw `ImpureFunctionError("self_mutation_outside_init")` (purity
       violation, not envelope mismatch) — DEC-WI934-006
     - `Call(func=Attribute(value=Name("self"), attr=X), args=[...])` →
       `Call(func=Name("ClassName_normalizedX"), args=[Name("self"), ...args])`
       — DEC-WI934-005
   - Pass the rewritten body to existing `renderBody` to get TS source.
   - For methods with `methodKind:"static" | "class"`, skip — those flow
     through `module.functions[]` and the existing WI-890 path. Document
     this short-circuit in `raise-class.ts` header.
6. **Aggregate warnings** from `mapPythonType` calls and `renderBody`
   returns; return a `RaisedClass`.

The wire-AST rewriting is the load-bearing part. The rewriter must be a
pure traversal over the `WireStmt` / `WireExpr` shapes — no I/O, no state
beyond the class name and the method dispatch context. Recursive descent.

**Note on the `Assign` wire shape:** the existing `_stmt_inner` in
`libcst-parse.py` already rejects `attribute Assign` with an `Unsupported`
wire node (line 689). That means `self.field = value` arrives in
`method.body` as `{"type":"Unsupported","reason":"attribute Assign"}`. The
raise-class body rewriter detects this pattern and converts it to the
purity rejection (DEC-WI934-006). Alternative path: extend libcst-parse to
emit a distinct `SelfAssign` wire shape — but that touches a non-required
authority surface; recommend the detect-on-rewrite path.

### 2.6 parse-fn-signature.ts integration

Current state (WI-890): `extractOne` short-circuits `methodKind === "instance"`
with `ImpureFunctionError`. We **keep that short-circuit** as the default
behavior for instance methods that arrive via the flat `module.functions[]`
list with dotted names.

What changes: a new export `extractClassEnvelopes(envelope) → EnvelopeClass[]`
walks `module.classes[]` and returns the typed shape that `raise-class.ts`
consumes. This is a pure type-narrowing pass — no rejection logic, no
purity logic, just wire → typed shape.

Acceptance: `parse-fn-signature.test.ts` regression — existing test that
asserts instance methods (without raise-class) reject with
`ImpureFunctionError` still passes. NEW test: classes with raisable shape
return a typed `EnvelopeClass[]` from the new export.

### 2.7 purity-check.ts integration

No behavioral change to existing exports. When `raise-class.ts` rewrites a
method body and detects `self.field = value`, it throws
`ImpureFunctionError(kind:"instance_method", detail:"self mutation outside __init__")`
— reusing the existing `instance_method` kind. The error class and kind
value already exist in `purity-check.ts`; no edits required in the file
itself. The file remains in scope's allowed-paths so the implementer has
room to add a regression test or detail tweak if absolutely needed.

Open question for implementer: do we instead introduce a new
`ImpurityKind` value `self_mutation_outside_init` for precision? Recommend
yes if it costs ≤10 lines; recommend no if it cascades type changes
through more than three files. Default: reuse `instance_method`.

### 2.8 raise-function.ts integration

No behavioral change to existing exports. The class raise path is invoked
**before** the flat `module.functions[]` raise path; the orchestration lives
in whatever caller composes the full module raise (today: the integration
test composes it manually; tomorrow: a top-level `raiseModule` would
compose both). The MVP integration test composes it manually:

```ts
const envelope = await parsePythonSource(source);
const classes = extractClassEnvelopes(envelope);
const fnSigs = extractFunctionSignatures(envelope); // existing
const classTsEmits = classes.map(raiseClass);
const fnTsEmits = fnSigs.map(sig => renderFunctionDeclaration(sig, ...));
const allTs = [
  ...classTsEmits.flatMap(c => [c.stateInterfaceTs, c.factoryTs, ...c.methodsTs]),
  ...fnTsEmits,
];
```

A future `raiseModule` orchestrator is out of scope for this WI; if the
implementer finds it natural to introduce one, that's an optional addition
inside scope.

### 2.9 index.ts barrel

New exports:
```ts
export {
  raiseClass,
  extractClassEnvelopes,
  type EnvelopeClass,
  type RaisedClass,
} from "./raise-class.js";
```

Note: `extractClassEnvelopes` lives in `parse-fn-signature.ts` per §2.6 but
re-exports through `raise-class.js` is also acceptable. Whichever the
implementer chooses, the barrel `index.ts` must surface both symbols.

### 2.10 Substrate integration test (the bridge)

```ts
// raise-class.integration.test.ts
import { shaveSource } from "@yakcc/shave"; // exact entry point TBD by impl
import { parsePythonSource } from "./libcst-parser.js";
import { extractClassEnvelopes } from "./parse-fn-signature.js";
import { raiseClass } from "./raise-class.js";

test("class method body decomposes into ≥2 atoms via substrate", async () => {
  const py = `
class EmailValidator:
    def __init__(self, max_length: int):
        self.max_length = max_length

    def validate(self, email: str) -> bool:
        if len(email) > self.max_length:
            return False
        if '@' not in email:
            return False
        return True
  `;
  const envelope = await parsePythonSource(py);
  const [cls] = extractClassEnvelopes(envelope);
  const raised = raiseClass(cls);
  const tsSource = [raised.stateInterfaceTs, raised.factoryTs, ...raised.methodsTs].join("\n\n");

  // Hand to the substrate
  const result = await shaveSource(tsSource);

  // Find atoms emitted from inside EmailValidator_validate
  const validateAtoms = result.atoms.filter(a => a.origin === "EmailValidator_validate");
  expect(validateAtoms.length).toBeGreaterThanOrEqual(2);
});
```

The exact substrate entry point (`shaveSource`, `shaveModule`, etc.) is
unknown until the implementer reads `packages/shave/src/index.ts`. The
plan-level commitment: the test imports the standard public entry the
substrate exposes; it does not reach into internals.

### 2.11 Alternatives considered & rejected

**Alt A — Widen the IR envelope to include `class` syntax.** Rejected by
`DEC-POLYGLOT-IR-CANONICAL-001` (ADR Q1). Atoms must remain in TS-subset
IR. Adding `class` would break the bootstrap corpus Merkle roots.

**Alt B — Raise classes to TS `class` syntax and trust substrate to
decompose method bodies.** Rejected — the TS-subset IR explicitly bans
"class inheritance beyond plain data" (ADR Q1 envelope table). Raising to
TS classes would produce invalid IR. Uncurry to free functions stays
inside the envelope.

**Alt C — Keep WI-890's "instance method → impure" rejection and
gate-list raisable classes via opt-in pragma comments.** Rejected — the
goal is for the bs4 e2e exploration to "just work" against ordinary
Python source, not source decorated with adapter-specific opt-ins.

**Alt D — Reuse `ImpureFunctionError` with a new kind value for all
class-shape rejections (as the operator dispatch suggested).** Rejected —
`CannotRaiseToIRError` already exists in `@yakcc/contracts` with the right
construct/location shape and is the documented taxonomy for
envelope-out-of-range rejections per ADR Q2. Reusing the purity error
would conflate structural rejections (multiple inheritance) with semantic
rejections (mutable state). DEC-WI934-007.

**Alt E — Split #933 and #934 into two separate PRs.** Rejected — the
acceptance criterion of #934 (substrate decomposes the raised IR) is also
the empirical proof of #933's principle. Landing them together gives the
ADR a worked example in the same commit boundary.

### 2.12 Research gate

Domain is well-understood — the operator dispatch is unusually detailed,
the issue bodies are precise, and the codebase has 6 months of `@decision`
history covering the relevant authorities. No external research needed.

---

## 3 — Wave decomposition

One PR, two issues closed. The internal slices are coherent enough to ship
together; splitting them yields fragmentary commits that can't prove the
end-to-end claim.

| W-ID | Title | Weight | Gate | Deps | Issues closed | Integration |
|---|---|---|---|---|---|---|
| W-A | ADR Q11 + decision record | S | none | — | #933 (partial) | `docs/archive/developer/adr/polyglot-architecture.md`, `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` (new) |
| W-B | libcst-parse.py `classes[]` emission | M | none | — | #934 (partial) | `packages/shave-python/scripts/libcst-parse.py` (extend) |
| W-C | `extractClassEnvelopes` + types | S | none | W-B | #934 (partial) | `packages/shave-python/src/parse-fn-signature.ts` (extend), `parse-fn-signature.test.ts` (extend) |
| W-D | `raise-class.ts` core + state derivation + factory | M | none | W-C | #934 (partial) | `packages/shave-python/src/raise-class.ts` (new), `raise-class.test.ts` (new) |
| W-E | Method body rewriting (self.field, self.method(...)) | M | none | W-D | #934 (partial) | `raise-class.ts` (extend), `raise-class.test.ts` (extend) |
| W-F | Failure-mode coverage (CannotRaiseToIRError taxonomy) | S | none | W-D | #934 (partial) | `raise-class.ts` (extend), `raise-class.test.ts` (extend) |
| W-G | Integration test (substrate decomposes raised IR) | M | review | W-E, W-F | #934 (closes), #933 (closes) | `raise-class.integration.test.ts` (new), `package.json` (devDep `@yakcc/shave`) |
| W-H | Barrel exports + final lint/typecheck | S | none | W-G | — | `packages/shave-python/src/index.ts` |

**Critical path:** W-B → W-C → W-D → W-E → W-G. Max width: W-A is doc-only
and can land anywhere on the timeline (recommend first commit so the
principle is visible in the PR history before the implementation). W-F can
parallelize with W-E.

**Single PR recommendation:** the slices are mutually load-bearing for
acceptance. A PR that only ships W-A through W-D is non-functional
(emit-only, can't prove anything). A PR that ships W-A through W-H is the
minimum viable proof.

---

## 4 — Decision Log

Pre-assigned decisions for this WI. The implementer adds `@decision`
annotations at the point of implementation per issue #446 Gap 9.

| DEC-ID | Title | Rationale |
|---|---|---|
| **DEC-WI933-001** | ADR Q11 verbatim placement | Append `## Q11 — Where does decomposition live?` after Q8 in `polyglot-architecture.md`. Use existing em-dash header style (normalize from issue body's period style). Anchor explicitly to `DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001`. |
| **DEC-WI933-002** | Decision-record format & location | `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` is the canonical record. New directory `docs/decisions/` introduced by this WI (allowed in scope). Use the seven-section format from §2.3 above. |
| **DEC-WI933-003** | Use existing `CannotRaiseToIRError`, not new class | `@yakcc/contracts/polyglot-errors.ts:34-46` already exports `CannotRaiseToIRError(construct, location, message?)`. Reuse — no contracts edit. Supersedes the operator-dispatch suggestion to introduce a new kind on `ImpureFunctionError`. |
| **DEC-WI933-004** | MASTER_PLAN.md decision-log row deferred | `docs/archive/developer/MASTER_PLAN.md` is not in scope manifest's allowed_paths. The row append is filed as a follow-up doc slice (post-merge cleanup), not in this WI. |
| **DEC-WI933-005** | `recursion.ts` header comment deferred | Issue #933 item (3) asks for a cross-link comment in `packages/shave/src/universalize/recursion.ts`. That file is in scope manifest's forbidden_paths. Defer to a follow-up substrate-side slice; the principle still lands canonically via the ADR + decision record. |
| **DEC-WI934-001** | libcst envelope additive — `module.classes[]` alongside flat `module.functions[]` | Keeps WI-890 callers byte-equivalent. WI-890's dotted-name flat-list entries continue to exist and are still consumed by `parse-fn-signature.ts:extractOne`. The new structural `classes[]` is for `raise-class.ts` only. |
| **DEC-WI934-002** | State-type derivation from simple `__init__` `self.foo = foo` patterns only | Walk `__init__.body` for `Assign(target=Attribute(value=Name("self"), attr=X), value=Name(Y))` where Y matches an `init_param`. Infer X's TS type from Y's annotation via `mapPythonType`. Anything else (`self.x = call()`, `self.x = a + b`, conditional self-assignment) → reject with `CannotRaiseToIRError("non-trivial __init__")`. |
| **DEC-WI934-003** | Method uncurry naming: `ClassName_methodName` | ClassName preserved verbatim from Python (including leading underscore — DEC-WI934-008). methodName goes through existing `normalizeIdentifier`. State interface: `ClassNameState`. Factory: `ClassName_create`. |
| **DEC-WI934-004** | Constructor lowers to `ClassName_create(...) → ClassNameState` returning frozen object literal | No mutation; pure factory. State interface is sibling-declared with all fields `readonly`. `Object.freeze(...)` is NOT emitted (raises an envelope question and the substrate handles immutability via the `readonly` discipline). |
| **DEC-WI934-005** | Method-to-method calls rewrite via wire-AST traversal | Inside method body, `Call(func=Attribute(value=Name("self"), attr=X), args=[...args])` rewrites to `Call(func=Name("ClassName_normalizedX"), args=[Name("self"), ...args])`. Recursive descent — handles nested calls and arbitrary expression positions. Chained `self.foo().bar()` rewrites the inner Call; the outer `.bar()` is regular Attribute access on the result (DEC-WI934-009). |
| **DEC-WI934-006** | `self.field` read OK; `self.field = value` write rejects with `ImpureFunctionError("instance_method", "self mutation outside __init__")` | Reads rewrite to `self.<normalized>`; writes outside `__init__` violate the purity assumption that uncurry-to-free-function depends on. Reuse existing `instance_method` kind (do NOT add a new ImpurityKind value unless trivially scoped). |
| **DEC-WI934-007** | Failure-mode error class: `CannotRaiseToIRError` from `@yakcc/contracts`, NOT `ImpureFunctionError` | Per DEC-WI933-003: the class already exists and is the documented envelope-out-of-range taxonomy. Rejected constructs: non-trivial bases, metaclasses, `@property` decorators, `__slots__`, `__getattr__`, `__getattribute__`, multiple inheritance, generic params, abstract base classes, dataclass/pydantic decorators. `@classmethod` and `@staticmethod` are not rejected here — they live in the flat `module.functions[]` per WI-890. |
| **DEC-WI934-008** | Leading-underscore class names preserved | `_PrivateClass.do_thing` → `_PrivateClass_doThing`. Consistent with existing `normalize-names.ts` Rule 2 (leading underscore preserved). State interface: `_PrivateClassState`. |
| **DEC-WI934-009** | Chained `self.foo().bar()` is MVP-allowed if `bar` is a TS-subset method on the result type (e.g. `Array.map`); otherwise downstream `raise-body` will fail | Don't pre-reject in raise-class — let the substrate or raise-body catch it. Document as known MVP edge in `raise-class.ts` header. |
| **DEC-WI934-010** | Integration test consumes `@yakcc/shave` as workspace dev dep | Add to `packages/shave-python/package.json` `devDependencies`: `"@yakcc/shave": "workspace:*"`. Read-only consumption — substrate source is not edited. |
| **DEC-WI934-011** | Backward compatibility: WI-890 short-circuit path retained | Methods in `module.functions[]` flat list (dotted names from WI-890) continue to flow through `extractOne` and continue to reject instance methods with `ImpureFunctionError`. Classes in the new `module.classes[]` flow through `raise-class`. A class that successfully raises via `raise-class` shadows its `module.functions[]` dotted-name entries (the implementer chooses whether to filter out shadowed entries upstream or downstream — recommend downstream in `extractFunctionSignatures` so the existing function-only consumers continue to see the dotted entries if they want them). |
| **DEC-WI934-012** | Test fixture canonical example: `EmailValidator` from #934 issue body | The raise-class.test.ts uses `EmailValidator` as the canonical worked example so the test source mirrors the issue body's example. Cross-reference in the test file comment. |

Each row above maps 1:1 to an `@decision` annotation the implementer must
emit at the point of implementation.

---

## 5 — Evaluation contract (for Guardian readiness)

### 5.1 Required tests

| Test | Location | Asserts |
|---|---|---|
| Class envelope shape | `libcst-parser.test.ts` (extend) | A class fixture produces `module.classes[]` with `name`, `bases`, `methods`, `init_assignments`, etc. |
| Module backward-compat | `libcst-parser.test.ts` (extend) | A module-only fixture (no classes) produces `module.classes: []` and identical `module.functions[]` to pre-WI-934. |
| `extractClassEnvelopes` typing | `parse-fn-signature.test.ts` (extend) | Walks envelope; returns typed `EnvelopeClass[]`. |
| WI-890 instance-method short-circuit regression | `parse-fn-signature.test.ts` (existing) | Continues to throw `ImpureFunctionError` for instance methods in `module.functions[]` flat list. |
| State-type derivation — simple | `raise-class.test.ts` | `__init__(self, x: int): self.x = x` derives `interface ClassState { readonly x: number }` and `Class_create(x: number): ClassState { return { x }; }`. |
| State-type derivation — multi-field | `raise-class.test.ts` | Multiple `self.field = param` assignments derive a multi-field interface. |
| State-type derivation — rejects computed | `raise-class.test.ts` | `self.x = some_call()` → `CannotRaiseToIRError("non-trivial __init__")`. |
| Method body rewrite — self.field read | `raise-class.test.ts` | `self.max_length` reference → `self.maxLength` in raised TS. |
| Method body rewrite — self.method call | `raise-class.test.ts` | `self.check_length(email)` → `EmailValidator_checkLength(self, email)`. |
| Method body rewrite — self.field write rejects | `raise-class.test.ts` | `self.count = 1` outside `__init__` → `ImpureFunctionError("instance_method", "self mutation outside __init__")`. |
| Failure mode — non-trivial base | `raise-class.test.ts` | `class Foo(Bar):` (Bar != object) → `CannotRaiseToIRError("non_trivial_base")`. |
| Failure mode — metaclass | `raise-class.test.ts` | `class Foo(metaclass=Meta):` → `CannotRaiseToIRError("metaclass")`. |
| Failure mode — property decorator | `raise-class.test.ts` | `@property def foo` → `CannotRaiseToIRError("property_decorator")`. |
| Naming — leading underscore preserved | `raise-class.test.ts` | `_Private.do_thing` → `_Private_doThing`. |
| Canonical worked example — EmailValidator | `raise-class.test.ts` | The full EmailValidator class from #934 issue body raises to source matching the documented TS output. |
| **Substrate integration** | `raise-class.integration.test.ts` | EmailValidator raised → fed through `@yakcc/shave` standard entry → **≥2 atoms** emitted from `EmailValidator_validate` (which has ≥3 statements). |

Minimum 8 test cases in raise-class.test.ts per #934 acceptance bullet 3.
Listed above: 11 distinct unit cases + 1 integration case — comfortably
clears the bar.

### 5.2 Required evidence (paste to PR description)

- Raw output of `pnpm --filter @yakcc/shave-python test` (all green).
- Raw output of `pnpm --filter @yakcc/shave-python typecheck`.
- Raw output of `pnpm --filter @yakcc/shave-python lint`.
- The integration test's atom-count assertion logged (so the proof is
  visible without rerunning).
- bs4 e2e re-exploration delta — count of methods now extracting vs.
  pre-WI-934 baseline. Even one new file with non-zero functions is a win;
  the goal is directional evidence, not a hard number.

### 5.3 Required real-path checks

- bs4 4.14.3 e2e exploration after this PR lands shows at least one
  previously-empty production file now yielding functions via the
  raise-class fork. The implementer captures the file path and the count
  delta in the PR description.
- The substrate-integration test's atom count is observed live (not
  faked / mocked) — the test imports and invokes the real
  `@yakcc/shave` entry point.

### 5.4 Required authority invariants

- **Decomposition lives at substrate.** No code in `raise-class.ts` (or
  anywhere in `@yakcc/shave-python`) calls `decomposableChildrenOf`,
  `recurse`, or any substrate-private internals. Grep proof in PR
  description: `rg 'decomposableChildrenOf|recurse\\b' packages/shave-python/src/`
  returns zero hits.
- **Existing free-function path unchanged.** `raise-function.ts` and
  `raise-body.ts` are read-only consumed; their exported behavior is
  identical to post-WI-890. Verified by existing tests still passing.
- **TS-subset IR conformance.** Raised TS source from `raise-class` passes
  the `@yakcc/ir` strict-subset validator (the integration test exercises
  this indirectly by feeding the source to `@yakcc/shave`).

### 5.5 Required integration points

- `@yakcc/shave` consumed as workspace dev dep — exact entry point named
  in `raise-class.integration.test.ts`.
- `@yakcc/contracts/polyglot-errors.ts` — `CannotRaiseToIRError` imported
  by `raise-class.ts`.
- `packages/shave-python/src/index.ts` — `raise-class` symbols
  barrel-exported.

### 5.6 Forbidden shortcuts

- **Do NOT modify `packages/shave/src/**`.** The integration test must
  consume the existing public entry; if no suitable entry exists, the
  implementer escalates rather than reaching for substrate internals.
- **Do NOT add adapter-side decomposition logic.** No methods on
  `raise-class.ts` named `findAtoms`, `decomposeMethodBody`, or any
  equivalent. The only walker in `raise-class.ts` is the body rewriter
  (self.field / self.method substitution) — that's not decomposition,
  that's emit-time transformation of the source-to-IR boundary.
- **Do NOT modify `packages/contracts/**`.** `CannotRaiseToIRError` is
  consumed as-is from existing exports.
- **Do NOT modify `packages/shave-python/src/raise-body.ts`,
  `libcst-parser.ts`, `type-map.ts`, `normalize-names.ts`.** Forbidden by
  scope manifest. Compose, don't extend.
- **Do NOT modify `bootstrap/expected-roots.json`.** CI-only writer.
- **Do NOT add `recursion.ts` header comment.** Deferred to follow-up per
  DEC-WI933-005.
- **Do NOT silently elide rejected classes.** Every rejected class must
  throw `CannotRaiseToIRError` with a meaningful `construct` string and a
  `SourceLocation` (file/line/col).

### 5.7 Ready-for-guardian definition

The reviewer may issue `REVIEW_VERDICT: ready_for_guardian` when:

1. All required tests (§5.1) exist and pass on current HEAD.
2. All required evidence (§5.2) is recorded in the PR description.
3. `pnpm --filter @yakcc/shave-python test typecheck lint` all green —
   raw output captured.
4. The grep invariant (§5.4 bullet 1) returns zero hits.
5. The substrate integration test's atom count ≥2 is observed in the test
   output (not asserted only — the count is logged).
6. ADR Q11 section is verbatim from issue body (with em-dash header
   normalization) and the decision record file exists at the canonical
   path.
7. No edits exist outside scope manifest's allowed_paths.
8. All `@decision` annotations corresponding to DEC-WI933-001..005 and
   DEC-WI934-001..012 are present at their respective implementation
   points.
9. No regressions: WI-890 short-circuit test, all WI-782 slice tests,
   all WI-888..#913 tests, all WI-890 + WI-921 + WI-923 tests still pass.

### 5.8 Rollback boundary

Single PR. If the substrate-integration assertion fails (atom count <2 or
substrate throws), the PR is held — no partial merge. Either the raise
produces malformed IR (fix in `raise-class.ts`) or the substrate has a gap
on this exact IR shape (file a separate substrate WI; do **not** patch
`raise-class.ts` to compensate per DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001).

---

## 6 — Scope manifest

### 6.1 Allowed paths (writes)

- `packages/shave-python/scripts/libcst-parse.py` — extend with class envelope walker
- `packages/shave-python/src/raise-class.ts` — new module
- `packages/shave-python/src/raise-class.test.ts` — new unit tests
- `packages/shave-python/src/raise-class.integration.test.ts` — new substrate-integration test
- `packages/shave-python/src/raise-function.ts` — minor orchestration touch-ups (optional, only if needed)
- `packages/shave-python/src/raise-function.test.ts` — regression-fixture additions (optional)
- `packages/shave-python/src/parse-fn-signature.ts` — add `extractClassEnvelopes` + `EnvelopeClass` type; preserve `extractOne` short-circuit unchanged
- `packages/shave-python/src/parse-fn-signature.test.ts` — new cases for class envelope extraction; existing WI-890 cases untouched
- `packages/shave-python/src/purity-check.ts` — read-only consumed but kept in allowed list so the implementer can add a small detail tweak if needed
- `packages/shave-python/src/purity-check.test.ts` — coverage if the above changes
- `packages/shave-python/src/libcst-parser.test.ts` — extend with class envelope shape assertions via real libcst subprocess
- `packages/shave-python/src/index.ts` — add barrel exports for `raise-class` symbols
- `packages/shave-python/package.json` — add `@yakcc/shave: workspace:*` to devDependencies (DEC-WI934-010)
- `docs/archive/developer/adr/polyglot-architecture.md` — append `## Q11` section
- `docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md` — new file
- `docs/decisions/**` — implementer may add cross-link index or README if natural
- `tmp/**` — any working notes, fixtures, evidence captures
- `PLAN.md` — this file (planner-owned)

### 6.2 Required paths (must be modified)

- `packages/shave-python/scripts/libcst-parse.py` — class envelope walker is load-bearing
- `packages/shave-python/src/raise-class.ts` — the WI doesn't exist without this file
- `docs/archive/developer/adr/polyglot-architecture.md` — Q11 section is the #933 deliverable

### 6.3 Forbidden paths (must not touch)

- `packages/shave-python/src/raise-body.ts` — compose, don't extend
- `packages/shave-python/src/libcst-parser.ts` — compose, don't extend
- `packages/shave-python/src/type-map.ts` — compose, don't extend
- `packages/shave-python/src/normalize-names.ts` — compose, don't extend
- `packages/compile-python/**` — out of scope
- `packages/cli/**` — out of scope
- `packages/shave/src/**` — substrate is canonical
- `packages/compile/**` — out of scope
- `packages/contracts/**` — `CannotRaiseToIRError` already exports
- `packages/ir/**` — IR is canonical
- `bootstrap/**` — CI-only writer
- `.github/**` — CI surface out of scope
- `.claude/**` — runtime out of scope

### 6.4 Expected state authorities touched

- Python wire envelope (libcst-parse.py output shape) — additive extension
- Per-package public TypeScript surface (`packages/shave-python/src/index.ts`)
- Per-package `package.json` `devDependencies` (`@yakcc/shave` added)
- ADR + decision-log doc tree (additive: new section, new file, new directory)

### 6.5 Scope manifest sync (orchestrator action before dispatching implementer)

The dispatched scope summary does **not** explicitly enumerate
`packages/shave-python/package.json`, and the runtime fnmatch glob
behavior noted in operator memory `feedback_scope_manifest_fnmatch_globs.md`
requires both `**` and `*` shapes to defeat the zero-segment quirk. Before
the implementer dispatches, the orchestrator runs:

```bash
cc-policy workflow scope-sync wi-933-934-class-raise \
  --work-item-id wi-933-934-impl \
  --scope-file tmp/wi-933-934-scope.json
```

Where `tmp/wi-933-934-scope.json` mirrors §6.1–§6.3 with both
`packages/shave-python/src/*.ts` and `packages/shave-python/src/**/*.ts`
glob shapes and explicitly lists:

- `packages/shave-python/package.json`
- `packages/shave-python/scripts/libcst-parse.py`
- `packages/shave-python/src/raise-class.ts`
- `packages/shave-python/src/raise-class.test.ts`
- `packages/shave-python/src/raise-class.integration.test.ts`
- `packages/shave-python/src/parse-fn-signature.ts`
- `packages/shave-python/src/parse-fn-signature.test.ts`
- `packages/shave-python/src/purity-check.ts`
- `packages/shave-python/src/purity-check.test.ts`
- `packages/shave-python/src/raise-function.ts`
- `packages/shave-python/src/raise-function.test.ts`
- `packages/shave-python/src/libcst-parser.test.ts`
- `packages/shave-python/src/index.ts`
- `docs/archive/developer/adr/polyglot-architecture.md`
- `docs/decisions/**`
- `docs/decisions/*.md`
- `tmp/**`
- `PLAN.md`

Forbidden: as enumerated in §6.3.

---

## 7 — Open questions for operator (none blocking)

None block the implementer. The planner-resolved open questions in §1.4
cover everything that needs an answer before the implementer starts. If
the implementer hits a real new ambiguity (e.g. the substrate's public
entry point doesn't expose what the integration test needs), they escalate
via SendMessage rather than guessing.

---

## 8 — Continuation rules (post-landing)

After this WI lands (Guardian merges to main):

- **DEC-WI933-004 follow-up:** file a tiny doc slice to append the
  `DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001` row to
  `docs/archive/developer/MASTER_PLAN.md` Decision Log table. Issue-only
  for now.
- **DEC-WI933-005 follow-up:** file a tiny substrate-side slice to add
  the `recursion.ts` header comment per #933 item (3).
- **Post-WI-934 follow-up:** re-run bs4 e2e exploration and snapshot the
  count delta. If results show a meaningful lift but specific known
  Python idioms are still blocked, file the next slice (e.g.
  `@property` support, multiple inheritance, mutable instance state with
  explicit opt-in).
- **Polyglot expansion:** once #934 proves the uncurry pattern works for
  Python, the Go and Rust adapters (when filed) can follow the exact
  same pattern documented in the new ADR §Q11.

---

## 9 — Quality gate (self-check before emitting trailer)

- All dependencies and authorities are logically mapped (§2.1)
- Every guardian-bound work item has an Evaluation Contract (§5)
- Every guardian-bound work item has a Scope Manifest (§6)
- No work item relies on narrative completion — every claim has a
  measurable check (§5.1–§5.4 are all observable)
- Alternatives gate cleared (§2.11)
- Decisions logged (§4)
- Forbidden shortcuts named (§5.6)
- Ready-for-guardian definition is executable (§5.7)
- Rollback boundary defined (§5.8)

Plan is ready for the implementer.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-933/934 plan complete — ADR Q11 + decision record at docs/decisions/, plus raise-class.ts uncurry implementation with state-type derivation, method body rewriting, and substrate-integration test asserting ≥2 atoms per method body. Next: guardian:provision (worktree already exists at .worktrees/feature-933-934-class-raise; implementer can be dispatched directly with the §6 scope manifest synced to runtime per §6.5).
