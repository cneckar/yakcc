# PLAN — WI-973 compile-go MVP: IR → Go lowering

> Planner output for [`#973`](https://github.com/cneckar/yakcc/issues/973)
> (Companion to closed `#871` which shipped only `canLowerTo` slice 1).
> Workflow `wi-973-compile-go-mvp`, work item `wi-973-plan`, goal `g-973`.
> Branch `feature/973-compile-go-mvp` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-973-compile-go-mvp`.
>
> Supersedes the prior WI-954 plan content at this path. WI-954 landed
> upstream of this branch (commit `350bf86`); this plan addresses the next
> polyglot WI: the missing IR → Go emitter that mirrors `@yakcc/compile-python`.

---

## 0 — Headline

`packages/compile-go/` currently contains only `canLowerTo()` — the static
lowerability gate shipped in slice 1 of closed issue #871. The **actual IR → Go
emitter does not exist**. Meanwhile `packages/shave-go/` (the inverse direction,
Go → TS-subset IR) has progressed substantially: per #973's discovered context,
35 of 436 `samber/lo` functions now raise cleanly through shave-go but cannot
round-trip back to Go because compile-go's emitter is empty.

This WI builds the IR → Go lowerer, mirroring `packages/compile-python/`'s
proven structure (`lower.ts`, `names.ts`, `compile-python.ts`, `types.ts`,
`index.ts`, plus `lower.props.test.ts`). The substrate already has
the template: WI-943 (`#945`) replaced silent `getText()` fallbacks in
compile-python with `CannotLowerToPythonError`, establishing the loud-failure
pattern this WI replicates with a sibling `CannotLowerToGoError`.

**What is load-bearing new code:**
1. `CannotLowerToGoError` in `@yakcc/contracts/polyglot-errors.ts` (mirror of
   `CannotLowerToPythonError`).
2. `packages/compile-go/src/lower.ts` — the ts-morph AST walk that emits Go
   source, with the type emitter (inverse of shave-go's `mapGoType`) and the
   statement lowerer (if/for/range/switch/return).
3. `packages/compile-go/src/names.ts` — TS ↔ Go identifier transforms.
4. `packages/compile-go/src/compile-go.ts` — public API `compileToGo()`.
5. `packages/compile-go/src/types.ts` — `GoCompileResult`, `LowerWarning`.
6. `packages/compile-go/src/index.ts` — barrel re-exports.
7. `packages/compile-go/src/lower.props.test.ts` — invariant: every IR atom
   either lowers OR throws `CannotLowerToGoError`. No silent garbage emission.

**What is composition / inherited:** the `BlockTripletRow` shape, the ts-morph
parse pipeline, the `LowerWarning` schema, the canLowerTo gate, the shave-go
type mapping table (consulted in reverse to design the type emitter).

The variance fallback discipline established by WI-943 is the second
deliverable: any IR construct outside the documented Go MVP envelope must
throw `CannotLowerToGoError` rather than leak raw TS syntax into the Go output.
Property test enforces this. No silent passthrough.

---

## 1 — Problem decomposition

### 1.1 What problem are we actually solving?

**Surface problem:** Go cannot enter the same B2-style benchmark surface as
TS and Python because the round-trip half is missing. shave-go raises Go to
IR; compile-go must lower IR back to Go. Without the second half, the polyglot
loop is not closed for Go.

**Root problem:** the polyglot architecture (Q3 ADR) requires per-language
adapter pairs. compile-python (#783) and compile-rust will follow the same
template. compile-go's slice 1 (#871) only shipped the lowerability gate —
the actual emitter was deferred but never built. This WI closes the gap so
Go reaches feature parity with Python in the polyglot envelope.

**Principle being made explicit:** the polyglot loop is symmetric. If
shave-X raises, compile-X must lower. Asymmetric language support is a hidden
authority gap — code that raises but cannot lower has no proof of semantic
round-trip and silently degrades the commons.

### 1.2 Goals (measurable)

- **G1.** `packages/compile-go/src/compile-go.ts` exports `compileToGo(atom:
  BlockTripletRow, opts?: CompileGoOptions): GoCompileResult` and is the
  documented public API entry point.
- **G2.** `compile-go.ts` mirrors `compile-python.ts`'s pipeline shape: parse
  IR → walk AST → emit Go source string → return `GoCompileResult` with
  `source: string`, `warnings: readonly LowerWarning[]`.
- **G3.** Type emitter handles the documented MVP type table (see §2.3) for
  primitives, slices (`[]T`), maps (`map[K]V`), pointers (`*T` for nullable),
  function types (`func(A, B) R`), generic type parameters (`[T any]`).
  Outside this set, throw `CannotLowerToGoError`.
- **G4.** Statement lowerer handles: function declaration, variable
  declaration (`const`/`let` → `var` or `:=`), `if`/`else`, `for` (C-style
  and `for...of`/`for...in` → `range`), `switch`, `return`, `throw` (→ `panic`).
  Anything else throws `CannotLowerToGoError`.
- **G5.** `CannotLowerToGoError` is added to `@yakcc/contracts/polyglot-errors.ts`
  with the same constructor signature pattern as `CannotLowerToPythonError`
  (`nodeKind`, `location`, `snippet`, `fnName?`). Re-exported from
  `@yakcc/contracts/index.ts`. Unit tests in `polyglot-errors.test.ts`.
- **G6.** Property test `lower.props.test.ts` asserts the invariant for at
  least one corpus of IR fixtures: every atom either produces non-empty Go
  source OR throws `CannotLowerToGoError`. No third outcome (silent garbage,
  raw TS leaking through `getText()`, empty string emission).
- **G7.** At least one integration test takes a real shave-go output (an IR
  atom raised from a samber/lo function) and round-trips it through
  `compileToGo`, asserting the output is syntactically valid Go. Optional:
  validate via `gofmt` subprocess if available in CI environment.
- **G8.** `pnpm --filter @yakcc/compile-go test` is green. `pnpm --filter
  @yakcc/contracts test` is green (covers the new error class). Full
  workspace `pnpm -r build` and `pnpm -r test` are green.

### 1.3 Non-goals (explicit exclusions)

- **NG1.** **gofmt subprocess** for canonical formatting. MVP emits
  reasonably-formatted Go manually (indentation, brace placement). gofmt
  may be wired in a follow-up WI once the emitter shape stabilizes.
- **NG2.** **Idiomatic Go transforms** (`if err != nil` patterns, error
  wrapping with `fmt.Errorf("%w")`, channel idioms, context propagation).
  MVP emits literal lowerings; idiomatic-transform passes are a separate WI.
- **NG3.** **Method receivers** (`func (r *Receiver) Method()`). The
  shave-go side encodes class-methods as `ClassName_methodName` free
  functions per #939. compile-go emits them as free functions on the Go side
  with the same name shape. Restoring method-receiver syntax is out of scope.
- **NG4.** **async/await/Promise → goroutines+channels.** Already blocked
  at canLowerTo (BLOCKER-GO-004); the emitter doesn't need to handle async.
- **NG5.** **Union types as tagged interfaces.** Already blocked at
  canLowerTo (BLOCKER-GO-003).
- **NG6.** **bigint → math/big.** Already blocked at canLowerTo (BLOCKER-GO-001).
- **NG7.** **Cgo, build tags, package directives beyond `package main`.**
  MVP emits a single file with a `package <name>` header derived from the
  atom's spec or a default.
- **NG8.** **Semantic round-trip equivalence.** MVP asserts syntactic
  validity (Go parses) and structural fidelity (same number of statements,
  same control-flow shape). Asserting that the Go executes with identical
  semantics to the TS source is a separate, larger verification effort.

### 1.4 Unknowns and ambiguities (resolved before implementer dispatch)

- **U1 (resolved).** Should TS `number` map to Go `int` or `float64`? **The
  current compile-python pattern lowers `number` to `int` for integer-like
  usage** but Go is stricter about numeric types than Python. Decision:
  default `number` → `int` for arithmetic-context, `float64` when the IR
  carries a fractional literal or division operator. Cast explicitly with
  `int(x)` / `float64(x)` at boundaries. Documented in DEC-WI973-002.
- **U2 (resolved).** Does the scope manifest as defined in
  `workflow_contract` allow editing `packages/contracts/**`? **No** —
  `packages/contracts/**` is in `forbidden_paths`. This is a real scope
  boundary. The implementer must extend the scope (via `cc-policy workflow
  scope-sync`) to include `packages/contracts/src/polyglot-errors.ts`,
  `packages/contracts/src/polyglot-errors.test.ts`, and
  `packages/contracts/src/index.ts` before edits begin. Guardian:provision
  re-issues the lease with the widened scope. Documented in §6.
- **U3 (resolved).** Does compile-go need its own `LowerWarning` type or
  reuse from contracts? **Define locally in `packages/compile-go/src/types.ts`**
  mirroring compile-python's shape exactly. The two adapters' warning sets
  diverge in `kind` strings (e.g. python emits `proof-properties-parse-error`,
  go has no equivalent today). Sharing would couple the two adapters
  needlessly. DEC-WI973-008.
- **U4 (resolved).** Should `compileToGo` emit a test file analogue (like
  compile-python's `testSource`)? **MVP: no.** compile-python emits a
  hypothesis test from `proof/properties.json` because the property-spec
  IR has a hypothesis emitter (`emitHypothesisTests` in contracts). There
  is no Go property-test emitter yet (no analogue of hypothesis for Go).
  `GoCompileResult` has only `source` and `warnings`. Adding a Go
  property-test emitter is a follow-up WI. DEC-WI973-009.

### 1.5 Dominant constraints

- **C1.** ts-morph AST API parity with compile-python. The lowerer walks
  the same Node kinds; the emit functions differ.
- **C2.** Lossless name round-trip with shave-go. Identifier transforms
  (DEC-WI973-005) must be inverse to whatever shave-go does on its side.
  Concretely: shave-go's `name-normalize.ts` exists; compile-go's `names.ts`
  must inverse it for round-trip parity.
- **C3.** Loud failure. Every unhandled IR construct must throw
  `CannotLowerToGoError` with a useful message. No silent `getText()`
  fallback, no empty emission, no `/* WARN */` comments in output. This is
  the lesson from WI-943 (#945).
- **C4.** Single PR for the MVP. No incremental landings; the whole emitter
  ships or none does. Sub-slices in §3 are internal staging within the WI.

---

## 2 — Architecture design & state-authority map

### 2.1 State-authority map

| State domain                  | Canonical authority                                              | Notes                                                                                                  |
|-------------------------------|------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| TS-subset IR shape            | `packages/ir/` + `packages/contracts/strict-subset.ts`            | Read-only; the lowerer consumes IR ASTs via ts-morph.                                                  |
| `BlockTripletRow` shape       | `packages/registry/`                                              | Read-only; lowerer input type.                                                                         |
| Polyglot error vocabulary     | `packages/contracts/src/polyglot-errors.ts`                      | **Mutated by this WI** — adds `CannotLowerToGoError`. Re-exported via barrel.                          |
| Go type ↔ TS type mapping     | `packages/shave-go/src/type-map.ts` (Go → TS direction)           | Read-only reference; compile-go's type emitter is the **inverse mapping**, owned by `compile-go/lower.ts`. |
| Go identifier normalization   | `packages/shave-go/src/name-normalize.ts` (Go → TS direction)     | Read-only reference; compile-go's `names.ts` is the **inverse mapping**.                              |
| compile-go public API         | `packages/compile-go/src/compile-go.ts` (this WI)                 | **Created** by this WI. Mirrors `compile-python.ts`.                                                    |
| canLowerTo gate               | `packages/compile-go/src/can-lower-to.ts` (already exists)        | **Read-only by this WI.** Pre-screens atoms; this WI assumes only `canLowerTo === true` atoms reach the emitter, but the emitter must still throw cleanly on out-of-envelope IR (defense in depth). |

### 2.2 Removal targets

None — this is purely additive. The empty `compile-go/src/` directory (only
`can-lower-to.{ts,test.ts}` + `index.ts`) is filled in, not replaced.

The stale WI-954 PLAN.md content is replaced by this plan as part of the WI's
plan output (this commit).

### 2.3 Type emitter table (TS → Go, MVP)

Inverse of `packages/shave-go/src/type-map.ts`. Lossy directions are
documented with explicit `LowerWarning`s; round-trip-incompatible directions
throw `CannotLowerToGoError`.

| TS type                          | Go type                | Notes / fidelity                                                                                                    |
|----------------------------------|------------------------|---------------------------------------------------------------------------------------------------------------------|
| `number` (integer context)       | `int`                  | Default. Matches Go convention.                                                                                     |
| `number` (fractional context)    | `float64`              | Detected by presence of fractional literal / division on this binding.                                              |
| `string`                         | `string`               | Direct.                                                                                                             |
| `boolean`                        | `bool`                 | Direct.                                                                                                             |
| `null` / `undefined` (in union)  | (handled by nullable)  | See below.                                                                                                          |
| `T \| null` / `T \| undefined`   | `*T` (pointer)         | Idiomatic Go nullable. **Note:** canLowerTo currently blocks `UnionType` (BLOCKER-GO-003). compile-go must throw `CannotLowerToGoError` if a union reaches it. Native nullable handling lands in a follow-up; the MVP defers it. |
| `T[]` / `Array<T>`               | `[]T`                  | Direct.                                                                                                             |
| `Record<string, V>`              | `map[string]V`         | Direct.                                                                                                             |
| `Map<K, V>`                      | `map[K]V`              | Direct.                                                                                                             |
| `Uint8Array`                     | `[]byte`               | Direct.                                                                                                             |
| `unknown` / `any`                | `any`                  | Go 1.18+ `any` alias for `interface{}`. Emit `any`.                                                                 |
| `(a: A, b: B) => R`              | `func(A, B) R`         | Direct.                                                                                                             |
| Generic `<T>` / `<T, R>`         | `[T any]` / `[T, R any]` | Direct in Go 1.18+. Non-`any` constraints throw `CannotLowerToGoError` for MVP (matches shave-go's WI-963 generic passthrough). |
| `Error`                          | `error`                | Go's built-in error interface.                                                                                      |
| `bigint`                         | (throws)               | Already blocked at canLowerTo; emitter throws for defense in depth.                                                 |
| `Promise<T>`                     | (throws)               | Already blocked at canLowerTo.                                                                                      |
| Class types (`class Foo`)        | (throws)               | Not in MVP envelope; classes are uncurried to free functions on the shave side.                                     |
| Anything else                    | (throws)               | `CannotLowerToGoError` with `nodeKind` = the TS type node's `getKindName()`.                                        |

### 2.4 Statement lowering table

| TS construct                              | Go emission                                                | Notes                                                                                          |
|-------------------------------------------|------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `function foo(...): R { ... }`            | `func foo(...) R { ... }`                                  | Top-level only (no nested functions in MVP).                                                   |
| `const x: T = expr;` (top-level)          | `var x T = expr`                                           | Package-level scope.                                                                           |
| `const x = expr;` (inside fn)             | `x := expr`                                                | Short declaration. Type inferred.                                                              |
| `let x: T = expr;` (inside fn)            | `var x T = expr`                                           | Mutable.                                                                                       |
| `if (cond) { ... } else { ... }`          | `if cond { ... } else { ... }`                             | No parens around cond.                                                                         |
| `for (let i = 0; i < n; i++) { ... }`     | `for i := 0; i < n; i++ { ... }`                           | C-style.                                                                                       |
| `for (const x of items) { ... }`          | `for _, x := range items { ... }`                          | range over slice/map values.                                                                   |
| `for (const [k, v] of Object.entries(m))` | `for k, v := range m { ... }`                              | range over map kv.                                                                             |
| `for (const k in obj) { ... }`            | (throws)                                                   | TS `for...in` over keys has no clean Go analogue without surrounding object shape; throw.      |
| `switch (x) { case A: ...; break; }`      | `switch x { case A: ...; }`                                | Go cases don't fall through; drop `break`. Explicit `fallthrough` only if TS uses fallthrough. |
| `return expr;` / `return;`                | `return expr` / `return`                                   | Direct.                                                                                        |
| `throw new Error(msg);`                   | `panic(msg)`                                               | MVP. Idiomatic Go uses `return errors.New(msg)` from an `(R, error)`-typed fn; deferred.       |
| `expr;` (expression statement)            | `expr`                                                     | Direct.                                                                                        |
| `x = expr;` (assignment)                  | `x = expr`                                                 | Direct.                                                                                        |
| `x += expr;` etc.                         | `x += expr`                                                | Compound ops match.                                                                            |
| Anything else                             | (throws)                                                   | `CannotLowerToGoError`.                                                                        |

### 2.5 Expression lowering table

| TS construct                           | Go emission                  | Notes                                                                  |
|----------------------------------------|------------------------------|------------------------------------------------------------------------|
| Numeric literal `42`                   | `42`                         | Direct.                                                                |
| String literal `"foo"`                 | `"foo"`                      | Double quotes.                                                         |
| Template literal `` `foo${x}bar` ``   | `fmt.Sprintf("foo%vbar", x)` | MVP. Requires `import "fmt"`.                                          |
| Boolean literal                        | `true` / `false`             | Direct.                                                                |
| `null`                                 | `nil`                        | Only valid in pointer contexts; otherwise throw.                       |
| `undefined`                            | (throws)                     | No Go equivalent; canLowerTo should screen, but emit defense throws.   |
| Identifier                             | (identifier, normalized)     | Via `names.ts` transform.                                              |
| Binary op `a + b`, `a * b`, etc.       | `a + b`, `a * b`, etc.       | Direct for arithmetic/comparison/logical. `===` → `==`, `!==` → `!=`.  |
| Unary op `!x`, `-x`                    | `!x`, `-x`                   | Direct.                                                                |
| Call `f(a, b)`                         | `f(a, b)`                    | Direct.                                                                |
| Member access `obj.x`                  | `obj.x`                      | Direct.                                                                |
| Element access `arr[i]`                | `arr[i]`                     | Direct.                                                                |
| Array literal `[a, b, c]`              | `[]T{a, b, c}`               | T inferred from contextual type.                                       |
| Object literal `{ a: 1, b: 2 }`        | `map[string]int{"a": 1, "b": 2}` or `struct{...}{...}` | MVP: emit as `map[string]V` when homogeneous; throw otherwise. |
| Arrow function expression              | `func(...) R { ... }`        | Already blocked at canLowerTo (BLOCKER-GO-005); emitter throws as defense. |
| Anything else                          | (throws)                     | `CannotLowerToGoError`.                                                |

### 2.6 Identifier normalization (`names.ts`)

| TS shape                       | Go shape                       | Rationale                                                              |
|--------------------------------|--------------------------------|------------------------------------------------------------------------|
| `myFunction` (camelCase)       | `myFunction` (unexported)      | Identifier preserved. Export decision is **out of MVP scope** — all emitted functions are exported by default via PascalCase capitalization. |
| `MyFunction` (PascalCase)      | `MyFunction` (exported)        | Direct.                                                                |
| `EntitySubstitution_substituteXml` | `EntitySubstitution_substituteXml` (exported via leading uppercase) | shave-go's class-method uncurry encoding round-trips losslessly. |
| `_privateName` (leading underscore) | `privateName` (unexported)  | Go has no `_`-prefix convention for private; first-letter case controls visibility. The leading underscore is stripped and the first character is lowercased to keep it unexported. |
| `ALL_CAPS_CONST`               | `ALL_CAPS_CONST`               | Go allows underscores in identifiers; preserved verbatim.              |

**Export policy for MVP:** emit functions and types with their original
casing. If the first character is lowercase, the Go symbol is package-private;
if uppercase, exported. The lowerer does not force uppercase. This matches
the TS-side convention where `export function foo` is exported by JS module
semantics but lowercase in Go means package-private. This is a documented
fidelity gap in DEC-WI973-005 and may be revisited.

### 2.7 Alternatives gate

**Considered and rejected.**

- **A1.** **Use a separate `go-ast` library to generate Go syntax**
  (e.g. parse-only `go-ast` via WASM, or a TS port of Go's `go/ast`).
  *Rejected:* compile-python emits raw strings successfully without an AST
  library; adding one is unjustified weight for MVP. The output is one
  function per atom; manual string emission is tractable.
- **A2.** **Subprocess to `gofmt` for canonical formatting on every emit.**
  *Rejected for MVP:* gofmt requires `go` toolchain installed on the
  developer machine and CI. compile-python doesn't subprocess to `black` or
  `ruff`; emit-time formatting is the package's job. Follow-up WI can wire
  `gofmt` validation in CI without making it a runtime emission dependency.
- **A3.** **Emit Go that uses `(R, error)` tuple returns by default,
  translating `throw` → `return ..., err`.** *Rejected for MVP:* this is an
  idiomatic transform that changes the function signature shape (every fn
  becomes 2-return). It would diverge from compile-python's literal lowering
  and tangle the MVP scope. `throw` → `panic` is the literal lowering; the
  idiomatic transform is a separate WI.
- **A4.** **Define `compileToGo` to return `Promise<GoCompileResult>` for
  future gofmt integration.** *Rejected:* premature async. compile-python is
  synchronous; symmetry matters. Sync API; if gofmt is wired later, that's
  a separate sync subprocess call.

### 2.8 Research gate

**Research performed.**

- Read `packages/compile-python/src/{compile-python,lower,names,types,index}.ts`
  and `lower.props.test.ts` — confirmed the template structure and contract
  the WI must mirror.
- Read `packages/contracts/src/polyglot-errors.ts` — confirmed
  `CannotLowerToPythonError` shape that `CannotLowerToGoError` mirrors.
- Read `packages/compile-go/src/can-lower-to.ts` — confirmed the blocker
  taxonomy (BLOCKER-GO-001 through 005) that the emitter must respect.
- Read `packages/shave-go/src/type-map.ts` — confirmed the inverse type
  table that the emitter implements.
- Read `packages/compile-go/package.json` — confirmed dependencies
  (`ts-morph`, `@yakcc/contracts`, `@yakcc/registry`) already present; no
  new deps needed.

No external research required. The pattern is well-established; this WI is
a faithful sibling of compile-python.

---

## 3 — Wave decomposition

Single PR for the MVP. Sub-slices below are internal staging within the
implementer's worktree; they do not produce intermediate PRs or landings.

| Slice | Weight | Gate    | Deps   | Description                                                                                          |
|-------|--------|---------|--------|------------------------------------------------------------------------------------------------------|
| **A** | S      | none    | —      | Add `CannotLowerToGoError` to `@yakcc/contracts/polyglot-errors.ts` + tests + barrel re-export.       |
| **B** | S      | none    | —      | Create `packages/compile-go/src/types.ts` with `LowerWarning` + `GoCompileResult` (mirror compile-python). |
| **C** | S      | none    | —      | Create `packages/compile-go/src/names.ts` with identifier transforms per §2.6 + unit tests.           |
| **D** | M      | none    | A,B    | Create `packages/compile-go/src/lower.ts` — type emitter per §2.3 (TS → Go types).                    |
| **E** | M      | none    | A,B,D  | Extend `lower.ts` — statement lowerer per §2.4.                                                       |
| **F** | M      | none    | A,B,D,E | Extend `lower.ts` — expression lowerer per §2.5.                                                      |
| **G** | S      | none    | C,D,E,F | Create `packages/compile-go/src/compile-go.ts` — public API `compileToGo(atom, opts?)`.              |
| **H** | S      | none    | G      | Update `packages/compile-go/src/index.ts` — barrel re-exports for `compileToGo`, `CompileGoOptions`, `GoCompileResult`, `LowerWarning`. |
| **I** | M      | review  | G,H    | Tests: unit per construct (`lower.test.ts`, `names.test.ts`, `compile-go.test.ts`), property test (`lower.props.test.ts`), integration test taking a shave-go raised IR atom and round-tripping it (`integration.test.ts`). |
| **J** | S      | review  | I      | Workspace-wide `pnpm -r build` + `pnpm -r test` green. Lint clean. typecheck clean.                  |

**Critical path:** A → B → D → E → F → G → I → J. Slices C, H are parallelizable
inside the worktree (no cross-slice landing). Max width effectively 1 (single
implementer, single PR).

**Why no separate work items per slice:** the MVP is small (~500-800 LOC
across the new files, comparable to compile-python which is ~1500 LOC total).
Splitting into multiple PRs would create N partial polyglot adapters that
each fail the property invariant until the last lands. Single PR keeps the
invariant green at every landing.

---

## 4 — Decision Log

| ID                  | Title                                                                                                          | Rationale (short)                                                                                                                                                                                                                                                                          | Status  |
|---------------------|----------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------|
| DEC-WI973-001       | Module structure mirrors compile-python exactly                                                                | The compile-python layout (`lower.ts`, `names.ts`, `compile-python.ts`, `types.ts`, `index.ts`, `lower.props.test.ts`) is the proven template. Symmetry across language adapters reduces cognitive load for future polyglot adapter authors and makes the property-test pattern reusable. | accepted |
| DEC-WI973-002       | `number` defaults to `int`; `float64` when fractional context detected                                         | Go is strict about numeric types. `int` matches the Go convention for default integer arithmetic. `float64` only when the IR explicitly uses fractional literals or division — matches the principle of least-surprise emission. Idiomatic refinement deferred.                          | accepted |
| DEC-WI973-003       | Statement set: `const`/`let`/`if`/`for`/`for-of`/`for-in-Object.entries`/`switch`/`return`/`throw`/expr/assign | Matches the canLowerTo MVP envelope. `for-in` over plain objects throws (no clean Go shape). `throw` → `panic` literal lowering; idiomatic `(R, error)` deferred.                                                                                                                          | accepted |
| DEC-WI973-004       | `CannotLowerToGoError` added to `@yakcc/contracts/polyglot-errors.ts`                                          | Sibling of `CannotLowerToPythonError` (WI-943). Same constructor signature (`nodeKind`, `location`, `snippet`, `fnName?`). Re-exported via barrel for consumer use. Loud failure over silent fallback (Ethos).                                                                              | accepted |
| DEC-WI973-005       | Identifier transforms preserve original casing; Go visibility follows first-character case                     | Lossless round-trip with shave-go's `name-normalize.ts`. `_privateName` strips the underscore and lowercases first char (Go convention for unexported). `ClassName_methodName` preserved verbatim. ALL_CAPS preserved. Documented fidelity gap noted for follow-up.                          | accepted |
| DEC-WI973-006       | Property test `lower.props.test.ts` enforces dichotomy: lower OR throw                                          | Mirror of compile-python's property-test pattern (WI-943, #945). No third outcome (no silent garbage, no raw TS leakage, no empty emission). Catches future emitter regressions immediately.                                                                                                | accepted |
| DEC-WI973-007       | MVP excludes gofmt subprocess, idiomatic transforms, method receivers, semantic round-trip verification        | Scope discipline. Each excluded item is a tractable follow-up WI on its own. Mixing them into MVP would tangle the property invariant.                                                                                                                                                       | accepted |
| DEC-WI973-008       | `LowerWarning` defined locally in `compile-go/src/types.ts`, not shared with compile-python                    | The two adapters' warning vocabularies diverge (no Go analogue of `proof-properties-parse-error`). Sharing would couple them needlessly. Shape mirrors compile-python's `LowerWarning` exactly for predictability.                                                                          | accepted |
| DEC-WI973-009       | MVP `GoCompileResult` has `source` + `warnings` only — no `testSource`                                          | compile-python emits `testSource` because contracts provides `emitHypothesisTests`. There is no Go analogue (no Go property-test emitter, no hypothesis equivalent). Adding one is a separate WI. Keeps MVP scope tight.                                                                     | accepted |
| DEC-WI973-010       | Scope widening to include `packages/contracts/src/polyglot-errors.{ts,test.ts}` and `packages/contracts/src/index.ts` | The current scope manifest forbids `packages/contracts/**` but the WI requires adding `CannotLowerToGoError` there (mirror of WI-943's pattern). Documented scope widening with explicit `scope-sync` action before implementer dispatch.                                                  | accepted |

---

## 5 — Evaluation contract (for Guardian readiness)

### 5.1 Required tests

- **T1.** `packages/compile-go/src/names.test.ts` — unit coverage for every
  identifier-transform branch in `names.ts`: camelCase preserved, PascalCase
  preserved, `ClassName_methodName` preserved, leading-underscore stripped+lowercased,
  ALL_CAPS preserved.
- **T2.** `packages/compile-go/src/lower.test.ts` — unit coverage for every
  TS construct in the lowering table (§2.3 type emitter rows, §2.4 statement
  rows, §2.5 expression rows). At minimum one happy-path test per row.
  At minimum one throw test per documented-to-throw construct.
- **T3.** `packages/compile-go/src/compile-go.test.ts` — public API smoke
  tests: well-formed atom in → `GoCompileResult` out, malformed atom in →
  `CannotLowerToGoError` thrown.
- **T4.** `packages/compile-go/src/lower.props.test.ts` — property invariant:
  for a corpus of IR fixtures (drawn from compile-python's existing fixture
  set + at least 5 shave-go raised IR atoms), every atom either produces
  non-empty `source` (with no `/* WARN */`, no raw TS leakage detected by
  grepping for `function ` / `=>` / `const ` / `let ` patterns Go doesn't
  use) OR throws `CannotLowerToGoError`. No third outcome.
- **T5.** `packages/compile-go/src/integration.test.ts` — end-to-end: take
  at least one samber/lo function that raises cleanly through shave-go,
  run it through `compileToGo`, assert the output parses as Go (syntactically
  valid). gofmt validation is **optional** — if available in CI, also pipe
  output through `gofmt -e` and assert exit 0; otherwise skip the gofmt step
  with a logged warning.
- **T6.** `packages/contracts/src/polyglot-errors.test.ts` — add coverage for
  `CannotLowerToGoError` mirroring the existing `CannotLowerToPythonError`
  test block: constructor field exposure, `name` property, `instanceof` works,
  thrown-and-caught lifecycle.

### 5.2 Required evidence

- **E1.** `pnpm --filter @yakcc/compile-go test` exits 0 with all tests
  green. Test count summary captured in PR description (e.g. "47 passed, 0
  failed").
- **E2.** `pnpm --filter @yakcc/contracts test` exits 0 (covers the new
  error class).
- **E3.** `pnpm -r build` exits 0 across the workspace (compile-go,
  contracts, and all downstream consumers — none today, but defensive).
- **E4.** `pnpm -r test` exits 0 across the workspace.
- **E5.** `pnpm --filter @yakcc/compile-go lint` exits 0 (biome clean on
  `src/`).
- **E6.** `pnpm --filter @yakcc/compile-go typecheck` exits 0 (tsc strict
  clean).
- **E7.** At least one snippet of the emitted Go source from an end-to-end
  test is captured in the PR description for human inspection.

### 5.3 Required real-path checks

- **R1.** Pick a real samber/lo function that raises through shave-go today
  (per #973 discovered context, 35 such functions exist; concrete candidates
  documented in shave-go's e2e fixtures). Run shave-go on the Go source to
  produce a TS-subset IR `BlockTripletRow`. Run `compileToGo` on that
  `BlockTripletRow`. Assert the output Go is syntactically valid (parses).
- **R2.** If `gofmt` is available on the CI runner, pipe the emitted Go
  through `gofmt -e` and assert exit 0. If unavailable, log a skip notice;
  do not fail the gate. (gofmt as a hard gate is deferred per DEC-WI973-007.)
- **R3.** Pick at least one IR atom that contains a construct from each of
  the 5 BLOCKER-GO classes (bigint, generic non-`any` constraint, union,
  Promise/async, function-typed value), and verify `compileToGo` throws
  `CannotLowerToGoError` for each. canLowerTo screens most of these
  upstream, but the emitter must also throw as defense in depth.

### 5.4 Required authority invariants

- **I1.** `packages/compile-go/src/lower.ts` is the single authority for
  IR → Go emission. No parallel emission path may exist after this WI lands.
- **I2.** `CannotLowerToGoError` is declared in
  `packages/contracts/src/polyglot-errors.ts` and re-exported from
  `packages/contracts/src/index.ts`. No other module declares a competing
  error class with the same purpose.
- **I3.** The blocker taxonomy in `packages/compile-go/src/can-lower-to.ts`
  (BLOCKER-GO-001 through 005) must remain consistent with the emitter's
  throw set. If the emitter is extended to handle a previously-blocked
  construct, `can-lower-to.ts` must be updated in the same change (single
  source of truth for what Go can lower).
- **I4.** The `GoCompileResult` shape (`source`, `warnings`) is the contract
  with downstream consumers. Mutating this shape requires a separate ADR
  and consumer migration plan.

### 5.5 Required integration points

- **N1.** `@yakcc/contracts` barrel (`packages/contracts/src/index.ts`) is
  updated to re-export `CannotLowerToGoError`.
- **N2.** `@yakcc/compile-go` barrel (`packages/compile-go/src/index.ts`) is
  updated to export `compileToGo`, `CompileGoOptions`, `GoCompileResult`,
  `LowerWarning`. The existing `canLowerTo` + `CanLowerResult` +
  `TargetLanguage` re-exports remain unchanged.
- **N3.** No changes required in `@yakcc/shave-go` — this WI is the
  consumer of shave-go's IR output, not a co-modifier.
- **N4.** No changes required in `@yakcc/compile-python` — sibling, not
  dependent.

### 5.6 Forbidden shortcuts

- **F1.** No silent `getText()` fallback. Every unhandled IR construct must
  throw `CannotLowerToGoError` with a useful `nodeKind` + `location` +
  `snippet`. (Direct lesson from WI-943.)
- **F2.** No `/* TODO */` or `/* WARN */` comments in emitted Go source.
  Either lower correctly or throw.
- **F3.** No untranslated TS syntax in Go output. Property test enforces
  this by grepping for TS-specific patterns (`=>`, `const `, `let `,
  `function `, `interface `, `type `) in `result.source`.
- **F4.** No silent type widening. If the IR has a non-`any` generic
  constraint, throw rather than emit `any`. (Matches shave-go's WI-963
  fidelity-warning pattern in the inverse direction.)
- **F5.** No new dependencies added to `packages/compile-go/package.json`
  beyond what compile-python uses. (`ts-morph`, `@yakcc/contracts`,
  `@yakcc/registry` already present.)
- **F6.** No edits outside the scope manifest (§6). The implementer must
  not silently modify shave-go, contracts schemas, registry, or any other
  package.

### 5.7 Ready-for-guardian definition

The reviewer declares `READY_FOR_GUARDIAN` when **all of the following** hold
on the current HEAD:

1. All tests in §5.1 exist and are green (`pnpm -r test` exit 0).
2. `pnpm -r build` exits 0.
3. `pnpm --filter @yakcc/compile-go lint` exits 0.
4. `pnpm --filter @yakcc/compile-go typecheck` exits 0.
5. Real-path checks §5.3 R1, R3 pass. R2 is best-effort (skip allowed).
6. Authority invariants §5.4 are visibly satisfied (single lower.ts emitter,
   single CannotLowerToGoError declaration, blocker-taxonomy consistency
   check passes by inspection).
7. Integration points §5.5 are wired (barrel exports present).
8. No forbidden shortcuts §5.6 detected (grep checks clean on `src/`).
9. `cc-policy evaluation get <workflow_id>` returns `status: ready_for_guardian`
   and `head_sha` matches the landing head.
10. `cc-policy test-state get --project-root <repo_root>` reports a passing
    state for the current HEAD.

### 5.8 Rollback boundary

Single PR. If the WI must be rolled back, `git revert <merge_commit>` cleanly
restores the prior state. The added file set is contained:

- `packages/compile-go/src/lower.ts` (new)
- `packages/compile-go/src/lower.test.ts` (new)
- `packages/compile-go/src/lower.props.test.ts` (new)
- `packages/compile-go/src/names.ts` (new)
- `packages/compile-go/src/names.test.ts` (new)
- `packages/compile-go/src/compile-go.ts` (new)
- `packages/compile-go/src/compile-go.test.ts` (new)
- `packages/compile-go/src/types.ts` (new)
- `packages/compile-go/src/integration.test.ts` (new)
- `packages/compile-go/src/index.ts` (modified — adds 4 exports)
- `packages/contracts/src/polyglot-errors.ts` (modified — adds 1 class)
- `packages/contracts/src/polyglot-errors.test.ts` (modified — adds 1 describe block)
- `packages/contracts/src/index.ts` (modified — adds 1 re-export)

No state migrations, no schema changes, no public API surface broken.

---

## 6 — Scope manifest

### 6.1 Allowed paths (the implementer may modify)

```
packages/compile-go/src/lower.ts
packages/compile-go/src/lower.test.ts
packages/compile-go/src/lower.props.test.ts
packages/compile-go/src/names.ts
packages/compile-go/src/names.test.ts
packages/compile-go/src/compile-go.ts
packages/compile-go/src/compile-go.test.ts
packages/compile-go/src/types.ts
packages/compile-go/src/integration.test.ts
packages/compile-go/src/index.ts
packages/compile-go/package.json
packages/compile-go/tsconfig.json
packages/contracts/src/polyglot-errors.ts
packages/contracts/src/polyglot-errors.test.ts
packages/contracts/src/index.ts
tmp/**
PLAN.md
```

### 6.2 Required paths (must be modified)

```
packages/compile-go/src/lower.ts          (CREATE)
packages/compile-go/src/names.ts          (CREATE)
packages/compile-go/src/compile-go.ts     (CREATE)
packages/compile-go/src/types.ts          (CREATE)
packages/compile-go/src/index.ts          (MODIFY — add exports)
packages/compile-go/src/lower.props.test.ts (CREATE)
packages/compile-go/src/lower.test.ts     (CREATE)
packages/compile-go/src/names.test.ts     (CREATE)
packages/compile-go/src/compile-go.test.ts (CREATE)
packages/compile-go/src/integration.test.ts (CREATE)
packages/contracts/src/polyglot-errors.ts (MODIFY — add CannotLowerToGoError)
packages/contracts/src/polyglot-errors.test.ts (MODIFY — add tests)
packages/contracts/src/index.ts           (MODIFY — re-export)
```

### 6.3 Forbidden paths (must not be touched)

```
packages/shave-go/**
packages/shave-python/**
packages/compile-python/**
packages/shave/**
packages/compile/**
packages/ir/**
packages/cli/**
packages/registry/**
bootstrap/**
.github/**
.claude/**
runtime/**
hooks/**
```

(Inherits the workflow_contract forbidden set; explicitly extends with
`packages/registry/**`, `runtime/**`, `hooks/**` since none of those need to
move for this WI.)

### 6.4 Expected state authorities touched

- **Polyglot error vocabulary** (`packages/contracts/src/polyglot-errors.ts`)
  — adding one new class.
- **compile-go public API surface** (`packages/compile-go/src/index.ts` +
  the new module files).

No runtime state, no SQLite tables, no hook config, no settings.json. This
is a pure library WI.

### 6.5 Scope-sync action (required before implementer dispatch)

The workflow_contract as currently bound has `packages/contracts/**` in
`forbidden_paths`. The orchestrator (or guardian:provision) MUST run scope
widening before the implementer is dispatched:

```bash
# Write tmp/973-scope.json (planner emits this — see Phase 3b output) then:
cc-policy workflow scope-sync wi-973-compile-go-mvp \
  --work-item-id wi-973-impl \
  --scope-file tmp/973-scope.json
```

The scope file enumerates §6.1 (allowed), §6.2 (required), §6.3 (forbidden),
§6.4 (authorities). The implementer's pre-write hooks then enforce the
widened scope mechanically.

---

## 7 — Open questions for operator (none blocking)

All design questions were resolved during planning (see §1.4 U1-U4). The
following items are **noted for future follow-up WIs, not blockers for this
MVP**:

- **Q1 (follow-up).** Wire `gofmt` subprocess validation in CI. Requires
  Go toolchain in CI image. Tracked as a separate WI; not in scope for #973.
- **Q2 (follow-up).** Idiomatic Go transforms: `if err != nil` patterns,
  channel idioms, context propagation. Tracked as a separate WI.
- **Q3 (follow-up).** Method receivers. Requires coordination with shave-go
  (DEC-941-style class-method encoding) and a decision on whether to reverse
  the encoding on the Go emit side.
- **Q4 (follow-up).** Go property-test emitter (analogue of hypothesis
  emission). Would enable `GoCompileResult.testSource` field.
- **Q5 (follow-up).** Semantic round-trip verification (TS → IR → Go,
  execute both, assert behavior identity). Requires Go execution
  infrastructure in tests.

If the operator wants any of Q1-Q5 elevated to a sub-slice of this MVP, that
changes the scope and the trailer; otherwise these stay in the issue backlog.

---

## 8 — Continuation rules (post-landing)

When this WI lands:

1. **Auto-continue:** the polyglot adapter set advances toward parity. Next
   candidate WI is **compile-rust MVP** (no issue filed yet; would mirror
   compile-go/compile-python). The operator may file or the planner may
   propose it as the next work item.
2. **Auto-continue:** track adoption of `compileToGo` in downstream consumers
   (none today, but the shave-go e2e fixtures and any commons round-trip
   tooling become candidates).
3. **Follow-up backlog:** file separate issues for Q1-Q5 (gofmt, idiomatic
   transforms, method receivers, property-test emitter, semantic
   round-trip).
4. **No new continuation rules are added to MASTER_PLAN.md** — the polyglot
   continuation rules already cover this (per-language adapter parity is a
   first-class invariant).

---

## 9 — Quality gate (self-check before emitting trailer)

- [x] All dependencies and authorities are logically mapped (§2.1)
- [x] Every guardian-bound work item has an Evaluation Contract (§5)
- [x] Every guardian-bound work item has a Scope Manifest (§6)
- [x] No work item relies on narrative completion — every claim has a
      measurable check (§5.1–§5.4)
- [x] Alternatives gate cleared (§2.7)
- [x] Decisions logged (§4) — DEC-WI973-001 through DEC-WI973-010
- [x] Forbidden shortcuts named (§5.6)
- [x] Ready-for-guardian definition is executable (§5.7)
- [x] Rollback boundary defined (§5.8)
- [x] Scope-sync action enumerated before implementer dispatch (§6.5)
- [x] Open questions filed as follow-ups, not blockers (§7)

Plan is ready for the implementer.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-973 plan complete — compile-go MVP IR → Go emitter (`lower.ts`, `names.ts`, `compile-go.ts`, `types.ts`, `lower.props.test.ts`) mirroring `packages/compile-python/`, plus `CannotLowerToGoError` in `@yakcc/contracts/polyglot-errors.ts` (mirror of WI-943's pattern), single PR. Next: guardian:provision must scope-sync to include `packages/contracts/src/polyglot-errors.{ts,test.ts}` and `packages/contracts/src/index.ts` (currently in forbidden_paths) before dispatching the implementer; scope file at `tmp/973-scope.json`, evaluation contract at `tmp/973-evaluation.json`.
