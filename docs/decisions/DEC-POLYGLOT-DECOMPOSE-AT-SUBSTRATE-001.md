# DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001 — Decomposition lives at substrate, adapters only raise

<!-- @decision DEC-WI933-002 — Decision-record format & location -->
<!-- @title docs/decisions/DEC-POLYGLOT-DECOMPOSE-AT-SUBSTRATE-001.md is the canonical record -->
<!-- @status accepted -->
<!-- @rationale docs/decisions/ introduced by this WI; seven-section format mirrors ADR style. -->
<!--   Scope manifest allows docs/decisions/**. MASTER_PLAN.md decision-log row deferred -->
<!--   per DEC-WI933-004 (that file is not in this WI's allowed_paths). -->

**Status:** Accepted
**Date:** 2026-05-30
**Issue:** https://github.com/cneckar/yakcc/issues/933
**Related:** #934 (Python class/method raise — first consumer of this rule)
**ADR section:** docs/archive/developer/adr/polyglot-architecture.md §Q11

---

## Decision

Per-language raise adapters (`@yakcc/shave-python`, future Go/Rust adapters) must
raise constructs to well-formed TS-subset IR and hand the result to the substrate's
standard decomposition pipeline. Adapters must **never** implement their own
decomposition logic (no adapter-side `findAtoms`, `decomposeMethodBody`, or
equivalent). When an adapter raises a body verbatim, the substrate's
`recurse()` / `decomposableChildrenOf()` in
`packages/shave/src/universalize/recursion.ts` is the sole authority for
finding atomic sub-fragments inside that body.

---

## Originating concern

> "bs4 4.14.3 e2e exploration after WI-890 (class-method extraction wired)
> still showed bs4 mostly empty because the bulk of bs4 code is **instance
> methods** that WI-890 rejects with `ImpureFunctionError(kind:'instance_method')`.
> The right mechanism is **uncurry**: instance methods on classes with
> pure-derivable `__init__` raise to free functions
> `ClassName_methodName(self: ClassNameState, ...)`. The substrate's existing
> `recurse()` / `decomposableChildrenOf()` pipeline then mines atoms from those
> raised method bodies the same way it already mines atoms from TypeScript class
> methods. The adapter raises; the substrate decomposes; no adapter-side
> decomposition."  — Operator dispatch 2026-05-28

---

## Authority surfaces

- `packages/shave/src/universalize/recursion.ts` — `recurse()` and `decomposableChildrenOf()` implement the substrate decomposition algorithm.
- `packages/shave/src/universalize/recursion.ts` — `DidNotReachAtomError` tripwire at the boundary where a non-atomic node has no decomposable children. This error is the load-bearing reviewer gate: when it fires from a raised adapter body, the adapter produced malformed IR.
- `@yakcc/contracts/src/polyglot-errors.ts` — `CannotRaiseToIRError` for constructs the adapter cannot raise (structural / envelope-out-of-range rejections).

---

## Lowering rules per adapter

**Python adapter (`@yakcc/shave-python`):**
- Module-level `def` → free function (WI-782 path; existing).
- Class `@staticmethod` / `@classmethod` → free function via WI-890 flat `module.functions[]` list.
- Class instance method → uncurry to free function `ClassName_methodName(self: ClassNameState, ...)` via WI-934 `raise-class.ts`. Body raised verbatim; substrate decomposes.
- Classes with non-pure-derivable `__init__`, metaclasses, multiple inheritance, `__slots__`, `@property`, `@dataclass`, `pydantic` → `CannotRaiseToIRError`.

**Go adapter (future):** struct `func (r T) Method(...)` methods with value receivers → `TypeName_method(recv: TypeNameState, ...)`. Pointer receivers (`*T`) with mutation outside a constructor path → `CannotRaiseToIRError`.

**Rust adapter (future):** `impl T { fn method(&self, ...) }` → `TypeName_method(self: TypeNameState, ...)`. `&mut self` methods → `CannotRaiseToIRError` unless mutation is constructor-only.

---

## Failure mode

`DidNotReachAtomError` (from `recursion.ts`) fires when a raised body cannot be
decomposed to atomic leaves. When this error originates from a body produced by a
per-language adapter, the root cause is in the adapter's raise layer — the emitted
IR is either malformed, contains constructs the substrate has no policy for, or
relies on features outside the TS-subset envelope (ADR Q1).

**Correct response:** fix the adapter's raise logic. Do not add adapter-side
decomposition to work around a substrate failure. Do not widen the TS-subset IR
envelope to absorb source-language-specific constructs.

---

## What this means for adapter MVPs

An adapter MVP may reject constructs it cannot raise cleanly (via
`CannotRaiseToIRError`) rather than being required to raise every construct on day
one. The non-negotiable boundary is: **when the adapter raises a construct, the
resulting IR must be substrate-decomposable.** Selective raising with loud rejection
is the correct MVP stance.

The `raise-class.integration.test.ts` in `@yakcc/shave-python` (WI-934) is the
first empirical proof of this principle: a Python class method raised via
`raiseClass()` feeds into `@yakcc/shave`'s standard `decompose()` pipeline and
yields ≥2 atoms per method body with ≥3 statements.

---

## Cornerstones preserved

- **DEC-POLYGLOT-IR-CANONICAL-001** — TS-subset IR is canonical; no adapter widens the envelope (ADR Q1).
- **DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001** — only real source is raised; no synthetic fixtures in the atom registry.
- **Reproducibility by construction** — `BlockMerkleRoot` is the universal identity; same IR → same root regardless of source language.
