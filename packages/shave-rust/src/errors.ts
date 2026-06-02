// SPDX-License-Identifier: Apache-2.0
//
// errors.ts -- Rust raise adapter error taxonomy (WI-868 slice 1).
//
// This module defines the >=5 documented unsupported-construct error classes
// for the Rust raise adapter.  Every class wraps `CannotRaiseToIRError` (or
// `AmbiguousPurityError`) from `@yakcc/contracts` — it does NOT define a
// parallel error hierarchy.
//
// Slice 1: stub taxonomy (class stubs with clear names + rationale).
// Slice 2 will add body-raise integration and emit these errors from the body
// traversal.
//
// @decision DEC-POLYGLOT-RUST-ERROR-TAXONOMY-001 (WI-868 slice 1)
// @title Rust raise adapter errors wrap @yakcc/contracts, never shadow them
// @status accepted (WI-868 slice 1)
// @rationale
//   Mirrors DEC-POLYGLOT-GO-ERROR-TAXONOMY-001 exactly.  The IR envelope is
//   held at strict-subset TS per DEC-POLYGLOT-IR-ENVELOPE-001.  For banned
//   constructs (unsafe, async/await, raw pointers, lifetimes-in-body, closures
//   with captures) the correct signal is CannotRaiseToIRError from
//   @yakcc/contracts — the same class used by shave-go and shave-python.
//   Introducing a parallel error hierarchy would fragment the cross-adapter
//   error surface and break instanceof checks in CLI tooling.  Each class
//   here is a thin named constructor that sets `construct` + `location` on
//   the base class so callers can do `instanceof CannotRaiseToIRError` for
//   any adapter error.

import { AmbiguousPurityError, CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";

// Re-export so callers can import from one place.
export { AmbiguousPurityError, CannotRaiseToIRError, type SourceLocation };

// ---------------------------------------------------------------------------
// Banned-construct errors (5+ distinct classes — all extend CannotRaiseToIRError)
// ---------------------------------------------------------------------------

/**
 * Thrown when a Rust function body contains an `unsafe` block or call.
 *
 * `unsafe` operations (raw pointer dereference, FFI calls, etc.) cannot be
 * expressed in the TS-subset IR envelope.  The function must be refactored to
 * remove unsafe operations before it can be raised.
 */
export class RustUnsafeError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "unsafe",
      location,
      `Cannot raise to IR: 'unsafe' block at ${location.file}:${location.line}:${location.col}. Remove unsafe operations to make the function raiseable.`,
    );
    this.name = "RustUnsafeError";
  }
}

/**
 * Thrown when a Rust function is declared `async` or contains `.await`.
 *
 * Async/await is Rust-specific concurrency syntax with no TS-subset IR
 * equivalent in the raise direction.  The function must be refactored to be
 * synchronous before it can be raised.
 *
 * Note: TS has async/await too, but the IR currently targets only synchronous
 * pure-function atoms (DEC-POLYGLOT-IR-ENVELOPE-001).
 */
export class RustAsyncError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "async/await",
      location,
      `Cannot raise to IR: async function or '.await' expression at ${location.file}:${location.line}:${location.col}. Raise supports synchronous pure functions only.`,
    );
    this.name = "RustAsyncError";
  }
}

/**
 * Thrown when a Rust function body contains a raw pointer operation (`*const T`
 * or `*mut T` dereference).
 *
 * Raw pointer operations are `unsafe` by nature and have no TS equivalent.
 * Refactor to use safe Rust references or slices.
 */
export class RustRawPointerError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "raw pointer",
      location,
      `Cannot raise to IR: raw pointer operation at ${location.file}:${location.line}:${location.col}. Use safe Rust references or slices instead.`,
    );
    this.name = "RustRawPointerError";
  }
}

/**
 * Thrown when a Rust function body contains a trait object (`dyn Trait`) or
 * dynamic dispatch that prevents static purity analysis.
 *
 * Dynamic dispatch through trait objects may call impure code at runtime.
 * The function must be refactored to use static dispatch (generics/impl Trait)
 * or the purity must be explicitly annotated.
 */
export class RustDynTraitError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "dyn trait",
      location,
      `Cannot raise to IR: dynamic dispatch ('dyn Trait') at ${location.file}:${location.line}:${location.col}. Use generics ('impl Trait') for static dispatch.`,
    );
    this.name = "RustDynTraitError";
  }
}

/**
 * Thrown when a Rust function body contains a closure with environment captures
 * (i.e. a closure that is not a pure function of its explicit arguments).
 *
 * Captured closures introduce hidden state dependencies that break the pure-
 * function contract of the TS-subset IR.  Closures that capture only immutable
 * references to constants may be expressible; full capture analysis is deferred
 * to slice 3.
 */
export class RustClosureCaptureError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "closure with captures",
      location,
      `Cannot raise to IR: closure with environment captures at ${location.file}:${location.line}:${location.col}. Use explicit function parameters instead of captured variables.`,
    );
    this.name = "RustClosureCaptureError";
  }
}

/**
 * Thrown when a Rust function body contains a statement or expression that is
 * not in the slice-1/slice-2 supported subset (e.g. match with complex arms,
 * struct literals, macro invocations, loop with break values).
 *
 * This is NOT the same as a banned purity-boundary construct — the construct
 * may be pure in principle but is outside the current raise surface.  Later
 * slices will progressively expand the supported set.
 */
export class RustUnsupportedConstructError extends CannotRaiseToIRError {
  constructor(construct: string, location: SourceLocation) {
    super(
      construct,
      location,
      `Cannot raise to IR: unsupported Rust construct '${construct}' at ${location.file}:${location.line}:${location.col}. This construct is outside the current raise surface; it may be supported in a future slice.`,
    );
    this.name = "RustUnsupportedConstructError";
  }
}

// ---------------------------------------------------------------------------
// Purity-ambiguity error (wraps AmbiguousPurityError from @yakcc/contracts)
// ---------------------------------------------------------------------------

/**
 * Thrown when purity inference cannot determine whether a Rust function is pure.
 *
 * This occurs when the body contains calls to external functions or trait
 * methods whose purity cannot be determined statically.  The developer should
 * either annotate the function explicitly or restructure to make purity obvious.
 *
 * Distinct from RustUnsupportedConstructError: an ambiguous-purity function is
 * not necessarily banned — it just cannot be classified without more information.
 */
export class RustAmbiguousPurityError extends AmbiguousPurityError {
  constructor(reason: string, location: SourceLocation) {
    super(reason, location);
    this.name = "RustAmbiguousPurityError";
  }
}
