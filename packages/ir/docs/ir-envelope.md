# TS-subset IR Expressive Envelope

**Status:** load-bearing spec
**Decision:** `DEC-POLYGLOT-IR-ENVELOPE-001` — hold the line (ADR Q1)
**Parent design:** `docs/archive/developer/adr/polyglot-architecture.md` (Q1)
**Work item:** [#780 WI-POLYGLOT-IR-ENVELOPE](https://github.com/cneckar/yakcc/issues/780)

## Why this document exists

`@yakcc/ir` defines the strict-subset TypeScript grammar that every shaved atom
must be expressible in. As the project moves toward polyglot raise adapters
(Python in `@yakcc/shave-py`, Go and Rust later), every adapter needs an
unambiguous reference for which native constructs are raiseable into IR and
which must throw `CannotRaiseToIRError`.

This file is that reference. It is the machine-readable companion to ADR §Q1
and the source of truth invoked by:

- `@yakcc/contracts.CannotRaiseToIRError` (thrown by adapters)
- `@yakcc/contracts.AmbiguousPurityError` (thrown by adapters)
- per-language raise adapters' acceptance test suites
- future IR-widening RFCs (which must explicitly amend this table)

## Hold-the-line stance

The IR envelope is **NOT** widened to absorb constructs that exist only in a
source language. Widening would inflate the IR with shapes the TS runtime
cannot use and would invalidate the 6238-atom bootstrap corpus.

When a per-language raise adapter encounters an out-of-envelope construct, it
throws `CannotRaiseToIRError` carrying:

- the offending construct name (e.g. `"async function"`, `"yield"`)
- the source location (file/line/col)

When purity-inference cannot decide (dynamic dispatch, opaque imports), the
adapter throws `AmbiguousPurityError` instead — distinct so future tooling
can offer a specific remediation (annotate the call site).

## Per-construct raise-status table

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

## Per-language raise-failure taxonomy

### Python (`@yakcc/shave-py`, WI-POLYGLOT-SHAVE-PY-MVP #782)

Throws `CannotRaiseToIRError` for:
- `async def`, generators (`yield`)
- context managers (`with`)
- class inheritance beyond plain data
- numpy/scipy/pandas calls
- mutable default arguments

Throws `AmbiguousPurityError` for:
- dynamic dispatch (`getattr`, `setattr` with computed names)
- opaque imports that cannot be statically resolved

### Go (`@yakcc/shave-go`, future)

Throws `CannotRaiseToIRError` for:
- goroutines, channels
- interfaces (unless trivially inlined)
- pointer arithmetic
- struct embedding

### Rust (`@yakcc/shave-rs`, future)

Throws `CannotRaiseToIRError` for:
- lifetimes, ownership transfers (non-Copy types by value)
- trait objects
- unsafe blocks
- async executor calls
- `impl Trait` in return position

Pure functional Rust subsets (numeric algorithms, string processing) map
cleanly into the IR envelope.

## Amending this document

This file is the machine-checkable spec referenced by adapter test suites.
Any IR envelope widening must:

1. Be motivated by a written RFC that explicitly enumerates which existing
   atoms would need re-shaving.
2. Update this table and the ADR §Q1 decision in the same change set.
3. Bump the IR envelope version (see `@yakcc/ir/src/envelope-version.ts`,
   future).

Out-of-band edits (table changes without a DEC entry) are treated as drift
and rejected by reviewer.
