# DEC-POLYGLOT-IR-CANONICAL-001 — Polyglot architecture: TS-subset IR as universal atom format

**Status:** Accepted (design-only; implementation deferred to sub-issue cascade)
**Date:** 2026-05-26
**Issue:** https://github.com/cneckar/yakcc/issues/775
**Initiative:** WI-POLYGLOT-ARCHITECTURE-DESIGN

---

## Context

External feedback (2026-05-19): *"Yakcc is TypeScript-only with no clear polyglot path. The shaving
logic is tightly coupled to TypeScript's AST via the compiler API, so Python, Go, or Rust codebases
can't participate. This is a fundamental ceiling."*

Accurate critique. v0.5 and v0.6 explicitly ship TS-only; the architecture for polyglot must be locked
now so 0.5/0.6 work doesn't paint us into a corner.

**Hard constraint from operator (2026-05-19):**
> "We never want to host atoms in anything other than the TS subset IR. Other language shave adapters
> should raise / lower the atoms discovered in the other language to this IR so that atoms are language
> agnostic."

This document formalizes that constraint and answers the eight open design questions it raises.

---

## Load-bearing decision

**DEC-POLYGLOT-IR-CANONICAL-001:** The registry stores exactly ONE atom format — the TS-subset IR
defined by `@yakcc/ir`'s strict-subset rules. Polyglot does NOT mean "atoms tagged with their source
language." Polyglot means per-language adapters that **raise** native code → TS-subset IR atoms, and
**lower** IR atoms → native code in the target language. Atoms are language-agnostic by storage; the
language barrier lives in the adapters, not in the registry.

This is strictly stronger than the obvious "tag-each-atom-by-language" design. A Python shave of
`parse_int_list` produces an atom that a TypeScript developer can discover and reuse 6 months later.
Shave-once, reuse-everywhere, across languages. That is the multiplier polyglot earns.

---

## Q1 — TS-subset IR expressive envelope

**Decision: hold the line (option c).** The IR envelope is held at the existing strict-subset TS rules.
If a native-language construct cannot be raised to the current IR without semantic loss, it does not
become an atom. The raise adapter rejects with a typed `CannotRaiseToIRError` carrying the blocking
construct name and location.

**Why (c) over (a) or (b):**
- Narrowing (a) would retroactively restrict the 6238-atom bootstrap corpus. Any atom using a
  construct that Python/Go/Rust cannot express would have to be re-shaved, invalidating
  `BlockMerkleRoot`s and federation references.
- Widening (b) would add IR constructs that only exist because a source language needs them — Python
  generators, Rust lifetime annotations, Go channels — inflating the IR with constructs the TS
  runtime cannot use. Every TS consumer would then need to handle the "generator-shaped atom"
  grammar indefinitely.
- Holding the line (c) keeps IR complexity bounded. The failure semantics are clear and local:
  the adapter says "I cannot raise this construct" and the developer either simplifies their
  function or leaves it unshaved. The registry never receives a compromise atom.

**Envelope summary (current strict-subset, held):**

| Language construct | IR status |
|---|---|
| Pure functions, no closures over mutable state | ✓ raiseable |
| Primitive types: number, string, boolean, null, undefined | ✓ raiseable |
| ADT-style data: plain objects, arrays, tuples | ✓ raiseable |
| Optional chaining, nullish coalescing | ✓ raiseable |
| `Array.map`, `Array.filter`, `Array.reduce` | ✓ raiseable |
| Synchronous control flow: if/else, for, while, switch | ✓ raiseable |
| Throws (typed Error subclasses only) | ✓ raiseable |
| `eval`, `Function()`, `new Function()` | ✗ banned by IR |
| `async`/`await`, generators, iterators | ✗ outside envelope |
| DOM APIs, Node built-ins beyond pure math/string/array | ✗ outside envelope |
| Decorators, class inheritance beyond plain data | ✗ outside envelope |
| Native FFI, C-extension calls | ✗ outside envelope |
| Concurrency primitives (goroutines, Rust threads) | ✗ outside envelope |

**Per-language raise-failure taxonomy:**

Python: `async def`, generators (`yield`), context managers (`with`), class inheritance,
numpy/scipy/pandas calls, mutable default arguments → all `CannotRaiseToIRError`.

Go: goroutines, channels, interfaces (unless trivially inlined), pointer arithmetic, struct
embedding → `CannotRaiseToIRError`.

Rust: lifetimes, ownership transfers (non-Copy types by value), trait objects, unsafe blocks,
async executor calls, `impl Trait` in return position → `CannotRaiseToIRError`. Pure functional
Rust subsets (numeric algorithms, string processing) map cleanly.

---

## Q2 — Raise contract per language

### Python shave adapter (`@yakcc/shave-py`, WI-POLYGLOT-SHAVE-PY-MVP)

**Native AST tool:** `libcst` (pure Python, WASM-compilable) for parsing; type information from
`pyright`'s static analysis API (consulted at shave-time as a foreign tool).

**Mapping table (extract):**

| Python construct | TS-subset IR equivalent |
|---|---|
| `def foo(x: int) -> int:` | `function foo(x: number): number {` |
| `list[int]` | `number[]` |
| `dict[str, T]` | `Record<string, T>` |
| `tuple[A, B]` | `[A, B]` |
| `Optional[T]` | `T \| null` |
| `Union[A, B]` | `A \| B` |
| `x if c else y` | `c ? x : y` |
| `[f(x) for x in xs]` | `xs.map(f)` |
| `[x for x in xs if p(x)]` | `xs.filter(p)` |
| `None` | `null` |
| `True` / `False` | `true` / `false` |
| `len(xs)` | `xs.length` |
| `raise TypeError("…")` | `throw new TypeError("…")` |

**Naming convention normalization:** `snake_case` → `camelCase`. The registry is camelCase-canonical;
the adapter normalizes at raise time; the lower adapter reverses at lower time.

**Type precision:** Python's `int` is arbitrary-precision; TS `number` is double. **Decision:** raise
`int` → `number` with a warn-on-loss annotation when the function's inputs exceed the safe integer
range (`Number.MAX_SAFE_INTEGER`). Raise `float` → `number` (lossless). Raise Python `bytes` →
`Uint8Array`. Do NOT raise to `bigint` by default — the bootstrap corpus is `number`-typed and
cross-type atoms would produce non-interoperable raise/lower pairs.

**Purity inference:** static analysis pass checks for: no module-level mutable state reads, no I/O
calls, no `random`, no `datetime`, no `os`/`sys`/`subprocess`. If any of these are present,
`CannotRaiseToIRError`. If the check is inconclusive (dynamic dispatch), the adapter rejects with
`AmbiguousPurityError`.

### Go shave adapter (`@yakcc/shave-go`, future — not in MVP)

**Native AST tool:** `go/ast` via a small Go subprocess that emits a JSON AST, parsed by the TS
adapter.

Key mapping: Go's `error` return convention maps to IR `throws`-style postcondition + `T | null`
return. Go's `struct` maps to plain IR object type. Multiple return values map to `[T1, T2]` tuple.

### Rust shave adapter (`@yakcc/shave-rs`, future — not in MVP)

**Native AST tool:** `syn` via a small Rust subprocess emitting a JSON-AST.

Key mapping: `Result<T, E>` → `{ ok: true; value: T } | { ok: false; error: E }`. `Option<T>` →
`T | null`. Pure numeric/string algorithms in `fn` form with no lifetime parameters: raiseable.

---

## Q3 — Lower contract per language

Lower is the inverse of raise. Given a TS-subset IR atom, emit idiomatic native code.

### Python lower adapter (`@yakcc/compile-py`, WI-POLYGLOT-COMPILE-PY-MVP)

- Naming de-normalization: `camelCase` → `snake_case`
- Type re-expression: `number` → `int | float` (inferred from usage; default `float` unless the
  spec declares integer semantics). `number[]` → `list[float]`. `Record<string, T>` → `dict[str, T]`.
- Stdlib re-mapping: `Array.map(f)` → `[f(x) for x in xs]`. `Array.filter(p)` → `[x for x in xs if p(x)]`.
  `Object.keys(o)` → `o.keys()`.
- Test re-emission: fast-check properties → `hypothesis` strategies. See Q4 for the source-of-truth
  on test re-emission.

**Identity round-trip property:** `lower(raise(native_code))` produces code with the same observable
behavior as `native_code` on all inputs in the IR envelope. NOT byte-for-byte identical (idiomatic
differences), but semantically equivalent under property-test coverage.

---

## Q4 — Test/proof contract across languages

**Decision: option (c) — language-neutral property form.**

The `proof/manifest.json` gains a new artifact kind: `property_spec`. A `property_spec` artifact
describes the property in a language-neutral form:

```json
{
  "kind": "property_spec",
  "path": "proof/properties.json",
  "generator": "fast-check-v3"
}
```

`proof/properties.json` schema (new, owned by `@yakcc/contracts`):

```json
{
  "schemaVersion": 1,
  "properties": [
    {
      "name": "roundTrip",
      "inputGenerators": [
        { "type": "array", "element": { "type": "integer", "min": -1000, "max": 1000 } }
      ],
      "assertion": {
        "kind": "eq",
        "lhs": { "call": "fn", "args": [{ "ref": "input[0]" }] },
        "rhs": { "ref": "input[0]" }
      }
    }
  ]
}
```

From this spec, on-demand emitters produce:
- `proof/tests.fast-check.ts` (existing TypeScript path, unchanged format)
- `proof/tests.hypothesis.py` (Python path, WI-POLYGLOT-PROOF-IR)
- `proof/tests.quickcheck.hs` (Haskell, future)
- `proof/tests.quickcheck_go.go` (Go, future)

**Why (c) over (a) or (b):**
- (a) "Re-emit in Python's hypothesis and trust equivalence" has no verification; two codebases can
  drift silently.
- (b) "TS tests are canonical, require Python consumers to run TS" creates a TS runtime dependency
  in every Python project — the polyglot story collapses.
- (c) The IR carries the property logical form; derived artifacts are reproducible from it. The spec
  is the single source of truth (Sacred Practice #12). Changing a property requires editing
  `proof/properties.json`; the derived test files are regenerated deterministically.

**Migration path for existing atoms:** existing atoms have `property_tests` manifests but no
`property_spec`. WI-POLYGLOT-PROOF-IR will introduce a backfill path that generates `properties.json`
from the existing `tests.fast-check.ts` via static analysis where feasible, and marks atoms as
`proof_spec: "manual-required"` where static analysis cannot reconstruct the logical form.

---

## Q5 — Discovery across languages

Intent embeddings are language-agnostic by construction (BGE-small embeds semantic intent strings,
not code). The discovery pipeline works cross-language without modification.

**One new filter:** `language: "py" | "ts" | "go" | "rs"` on `QueryIntentCard` (D2 ADR,
`docs/archive/developer/adr/discovery-query-language.md`). This is about the **output target**
(what language to lower to), NOT the atom's source language (atoms have no source-language label
in the registry). An atom is "lowerrable to Python" if the lower adapter can emit it without
`CannotLowerToTargetError`. The filter runs post-retrieval as an adapter-capability check, not
as a registry-side filter.

**Structural similarity (D3 ADR):** works cross-language by construction since both impls are in IR
space. The canonical AST hash (`DEC-AST-CANON-001`) is language-source-agnostic.

---

## Q6 — Bootstrap corpus per language

Bootstrap atoms (`packages/seeds/blocks/`) stay as TS source. They are already in IR form by
construction. Lower on demand when a Python/Go/Rust consumer requests an atom.

No new source atoms are added to the bootstrap corpus in this WI. Growing the cross-language corpus
(shaving Python stdlib, Go stdlib, etc.) is a multi-year initiative separate from this design pass.

---

## Q7 — CLI / installer surface

```sh
yakcc shave <dir> --language=py        # invoke Python adapter
yakcc compile <entry.py>               # lower atoms to Python at link time
yakcc init                             # auto-detects pyproject.toml / go.mod / Cargo.toml
```

**Adapter packaging:** per-language adapters are optional packages:
- `@yakcc/shave-python` — Python raise adapter
- `@yakcc/compile-python` — Python lower adapter
- `@yakcc/shave-go` — Go raise adapter (future)
- `@yakcc/shave-rust` — Rust raise adapter (future)

This keeps TS-only users free of Python/Go/Rust toolchain deps. Each adapter declares a
`peerDependency` on the native tool (`libcst`, `go`, `rustc` via subprocess).

**Auto-detect in `yakcc init`:** if `pyproject.toml` or `setup.py` is detected, emit a hint to
install `@yakcc/shave-python`. If `go.mod` is detected, emit a hint for `@yakcc/shave-go`. Does
NOT auto-install — user confirms (WI-POLYGLOT-INIT-AUTODETECT).

---

## Q8 — Identity / Merkle-root semantics

**Decision: same `BlockMerkleRoot` for byte-identical IR canonical bytes, regardless of source
language.** A function shaved from Python and one written natively in TS that produce the same IR
canonical bytes get the SAME `BlockMerkleRoot`. This is intentional and the deep payoff.

**Implication:** federation peers deduplicate cross-language contributions automatically. Two teams —
one Python, one TypeScript — independently shave the same algorithm; the second shave is
content-addressed to the first atom and contributes no new registry row. The registry grows by
genuinely novel algorithms, not by language multiplicity.

**No `sourceLanguage` column in `blocks` table:** adding a `sourceLanguage` column would break the
cross-language deduplication invariant (same IR → same atom) and violate `DEC-IDENTITY-005`. Adapters
may record source-language provenance in a separate `atom_provenance` metadata table (not in identity
derivation path) for tooling use. The `BlockMerkleRoot` never encodes source language.

---

## Deliverables

### ADR (this document) — Q1-Q8 answered ✓

### Sub-issue cascade (filed separately, not started)

| WI ID | Scope | Q reference |
|---|---|---|
| WI-POLYGLOT-IR-ENVELOPE | Formalize the IR envelope as a machine-checkable spec; add per-construct raise-status table to `@yakcc/ir` docs; add `CannotRaiseToIRError` type to `@yakcc/contracts` | Q1 |
| WI-POLYGLOT-PROOF-IR | Add `proof/properties.json` schema to `@yakcc/contracts`; add `property_spec` artifact kind to `proof/manifest.json`; write TS emitter (generates `tests.fast-check.ts` from spec) and Python emitter (generates `tests.hypothesis.py`) | Q4 |
| WI-POLYGLOT-SHAVE-PY-MVP | Python raise adapter `@yakcc/shave-python`: pure functions only, no classes, no decorators. `libcst` AST parser, pyright purity checker, snake_case→camelCase normalizer, mapping table from Q2. | Q2 |
| WI-POLYGLOT-COMPILE-PY-MVP | Python lower adapter `@yakcc/compile-python`: emit idiomatic Python from IR atoms. camelCase→snake_case, type re-expression per Q3, stdlib re-mapping, hypothesis test emission via WI-POLYGLOT-PROOF-IR emitter. | Q3 |
| WI-POLYGLOT-DISCOVERY-XLANG | Add `language` output-target filter to `QueryIntentCard` (D2 ADR amendment); add post-retrieval adapter-capability check in discovery pipeline. | Q5 |
| WI-POLYGLOT-INIT-AUTODETECT | `yakcc init` detects `pyproject.toml`, `go.mod`, `Cargo.toml`; emits adapter-install hints; does NOT auto-install. | Q7 |

### Strawman scope estimates (rough sister-weeks per WI)

| WI | Estimate | Confidence |
|---|---|---|
| WI-POLYGLOT-IR-ENVELOPE | 1–2 weeks | High — docs + one new type |
| WI-POLYGLOT-PROOF-IR | 3–5 weeks | Medium — new schema + two emitters |
| WI-POLYGLOT-SHAVE-PY-MVP | 8–12 weeks | Low — first language; libcst integration unknown |
| WI-POLYGLOT-COMPILE-PY-MVP | 6–10 weeks | Low — depends on proof-IR emitters |
| WI-POLYGLOT-DISCOVERY-XLANG | 2–3 weeks | High — small amendment to existing pipeline |
| WI-POLYGLOT-INIT-AUTODETECT | 1–2 weeks | High — CLI hint, no install logic |
| **Per-language total (Py MVP)** | **~21–34 weeks** | Medium | 
| **Subsequent language drop** | **~11–19 weeks** | Medium (tool-reuse savings per DEC-V2-FRONTEND-TOOL-REUSE-001) |

First-language cost is dominated by WI-POLYGLOT-SHAVE-PY-MVP (libcst integration,
purity inference, type mapping — all novel). Subsequent languages reuse the adapter interface,
lower adapter skeleton, and proof-IR emitter framework; only the AST tool and mapping table change.

---

## Risk register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| `libcst` Python subprocess adds a non-trivial latency / dependency management burden | Medium | High | Isolate in `@yakcc/shave-python` so TS-only users are unaffected; subprocess with timeout per DEC-V2-FRONTEND-TOOL-REUSE-001 |
| Python `int` → `number` precision loss silently corrupts numeric atoms | High | Medium | Warn-on-loss annotation at raise time; property tests catch range violations |
| Equivalent-mutant explosion (Q2 mapping table gap) causes rejected correct raises | Medium | Medium | `CannotRaiseToIRError` with explicit construct name surfaces the gap; human-reviewable fallback |
| `proof/properties.json` language-neutral form cannot express all fast-check generators | High | Medium | Mark atoms `proof_spec: "manual-required"` where static analysis fails; do not block raise on proof-spec gaps |
| Cross-language deduplication (same IR → same atom) surprises users who expect separate per-language atoms | Low | Medium | Document explicitly in `USING_YAKCC.md`; cross-language identity is the intended property, not a bug |
| NFS / network-mount advisory lock unreliability (#777 concurrency WI) applies to adapters too | Medium | Low | Adapter write paths acquire the same write lock as the TS path; no adapter-specific lock needed |
| Naming normalization (`snake_case` → `camelCase`) produces collisions in edge cases | Low | Low | Add collision-detection test in WI-POLYGLOT-SHAVE-PY-MVP; use qualified name on collision |
| Go `error` return convention maps ambiguously to IR throws-vs-return | Medium | Medium | WI-POLYGLOT-SHAVE-GO-MVP decision: map as `T | null` + postcondition annotation; throw only on non-nil error; document the convention |
| Property test re-emission (`hypothesis`) produces different shrinking behavior than `fast-check` | Low | High | Shrinking is best-effort; the logical property (assertion shape + input domain) is preserved. Both shrink toward counter-examples; exact shrunk values may differ. Accept. |

---

## Cornerstones preserved

- **TS-subset IR is canonical** (this ADR's load-bearing decision). No atom in the registry speaks
  any language other than the TS-subset IR.
- **Never measure based on synthetic content, only things shaved** (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
  Applies to polyglot raise: only native functions that actually exist in real codebases get raised.
- **Reproducibility by construction.** `BlockMerkleRoot` is the universal identity.
  Same IR → same identity, regardless of which language's adapter produced it.
- **Air-gap (B6).** Adapter raise/lower is pure local computation. The Python subprocess runs
  locally; no remote AST service is called.
- **No ownership** (DEC-NO-OWNERSHIP-011). No `sourceLanguage`, no `author`, no adapter-origin
  field in the `blocks` table.

---

## Decision log entries opened by this design pass

| DEC-ID | Decision |
|---|---|
| DEC-POLYGLOT-IR-CANONICAL-001 | TS-subset IR is the universal atom format; per-language adapters raise/lower around it. Atoms are language-agnostic by registry storage. (This ADR.) |
| DEC-POLYGLOT-IR-ENVELOPE-001 | Hold-the-line on IR envelope (option c). Unsupported constructs → `CannotRaiseToIRError`. No IR widening for polyglot. (WI-POLYGLOT-IR-ENVELOPE to formalize.) |
| DEC-POLYGLOT-PROOF-IR-001 | Language-neutral property form (option c). `proof/properties.json` is the source of truth. `tests.fast-check.ts` and `tests.hypothesis.py` are derived artifacts emitted on demand. (WI-POLYGLOT-PROOF-IR to implement.) |
| DEC-POLYGLOT-IDENTITY-001 | No `sourceLanguage` column in `blocks` table. Same IR canonical bytes → same `BlockMerkleRoot` regardless of source language. Source-language provenance may be stored in a separate `atom_provenance` metadata table outside the identity path. |
| DEC-POLYGLOT-ADAPTER-PACKAGING-001 | Per-language adapters are separate optional npm packages (`@yakcc/shave-python`, etc.). TS-only users carry zero polyglot toolchain deps. Each adapter subprocess-invokes its native tool; no native runtime is required in the `@yakcc/core` bundle. |

---

## References

- Operator constraint: 2026-05-19 directive in #775 filing thread
- External critique source: AI-platform analyzer feedback, 2026-05-19
- Existing strict-subset rules: `@yakcc/ir/src/strict-subset-cli.ts` + tests
- Existing IR canonical bytes path: `@yakcc/contracts/src/canonical-ast.ts`
- Proof manifest authority: `@yakcc/contracts/src/proof-manifest.{props,ts}`
- Multi-language shave (long-term vision): MASTER_PLAN.md §"Long-term: multi-language shave"
- Tool-reuse decision: DEC-V2-FRONTEND-TOOL-REUSE-001 (MASTER_PLAN.md)
- D1 ADR: `docs/archive/developer/adr/discovery-multi-dim-embeddings.md`
- D2 ADR: `docs/archive/developer/adr/discovery-query-language.md`
