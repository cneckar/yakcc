// SPDX-License-Identifier: Apache-2.0
//
// errors.ts -- Rust raise adapter error taxonomy (WI-868 slice 1–3).
//
// This module defines the >=5 documented unsupported-construct error classes
// for the Rust raise adapter.  Every class wraps `CannotRaiseToIRError` (or
// `AmbiguousPurityError`) from `@yakcc/contracts` — it does NOT define a
// parallel error hierarchy.
//
// Slice 1: stub taxonomy (class stubs with clear names + rationale).
// Slice 2: body-raise integration — errors emitted from raise-body.ts traversal.
// Slice 3: purity gate — RustMutableBorrowError / RustIoSideEffectError wired
//          into checkPurity (purity-check.ts) + @taxonomy summary block.
//
// @decision DEC-POLYGLOT-RUST-ERROR-TAXONOMY-001 (WI-868 slice 1–3)
// @title Rust raise adapter errors wrap @yakcc/contracts, never shadow them
// @status accepted (WI-868 slice 1–3)
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
//
// ---------------------------------------------------------------------------
// @taxonomy  Rust raise adapter — unsupported-construct error classes
// ---------------------------------------------------------------------------
//
//  Class                      | Trigger construct              | Rust source example
//  ---------------------------|--------------------------------|------------------------------------
//  RustUnsafeError            | unsafe block or call           | unsafe { *ptr }
//  RustAsyncError             | async fn / .await              | async fn f() -> i32 { fut.await }
//  RustRawPointerError        | *const T / *mut T deref        | let v = unsafe { *raw_ptr };
//  RustDynTraitError          | dyn Trait usage                | fn f(x: &dyn Trait) -> i32 { ... }
//  RustClosureCaptureError    | closure capturing env variable | let n = 1; let c = |x| x + n;
//  RustMutableBorrowError     | &mut T parameter               | fn bump(x: &mut i32) { *x += 1; }
//  RustIoSideEffectError      | println!/print!/std::io etc.  | fn greet(s: &str) { println!("{}", s); }
//  RustUnsupportedConstructError | construct outside raise surface | fn f() -> i32 { loop { break 1; } }
//  RustAmbiguousPurityError   | purity cannot be inferred      | fn f() -> i32 { external_call() }
//
// All classes extend CannotRaiseToIRError (or AmbiguousPurityError) from
// @yakcc/contracts so callers can use `instanceof CannotRaiseToIRError` uniformly.
// ---------------------------------------------------------------------------

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
 *
 * Rust source that triggers this error:
 * ```rust
 * fn deref_raw(ptr: *const i32) -> i32 {
 *     unsafe { *ptr }   // <-- unsafe block rejected
 * }
 * ```
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
 *
 * Rust source that triggers this error:
 * ```rust
 * async fn fetch_value(id: u32) -> String {
 *     lookup(id).await   // <-- .await expression rejected
 * }
 * ```
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
 *
 * Rust source that triggers this error:
 * ```rust
 * fn read_raw(ptr: *const i32) -> i32 {
 *     unsafe { *ptr }   // <-- *const T dereference rejected
 * }
 * ```
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
 *
 * Rust source that triggers this error:
 * ```rust
 * fn compute(op: &dyn Fn(i32) -> i32, x: i32) -> i32 {
 *     op(x)   // <-- dyn Trait dynamic dispatch rejected
 * }
 * ```
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
 *
 * Rust source that triggers this error:
 * ```rust
 * fn make_adder(n: i32) -> impl Fn(i32) -> i32 {
 *     |x| x + n   // <-- closure captures `n` from outer scope — rejected
 * }
 * ```
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
 *
 * Rust source that triggers this error:
 * ```rust
 * fn first_positive(xs: &[i32]) -> i32 {
 *     loop { break xs[0]; }   // <-- loop-with-break-value outside current surface
 * }
 * ```
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
// Purity-boundary errors (extend CannotRaiseToIRError; mutability + I/O)
// ---------------------------------------------------------------------------

/**
 * Thrown when a Rust function has a `&mut T` parameter.
 *
 * `&mut T` parameters signal in-place mutation of the caller's data.
 * Mutable borrows cannot be modelled as pure TS-subset IR functions:
 * the TS IR targets pure-function atoms with no observable side effects.
 * Refactor to return a new value instead of mutating the argument.
 *
 * Example:
 *   // Rejected — mutates caller's binding:
 *   fn increment(x: &mut i32) { *x += 1; }
 *
 *   // Accepted — returns new value:
 *   fn incremented(x: i32) -> i32 { x + 1 }
 *
 * @decision DEC-POLYGLOT-RUST-PURITY-001 (WI-868 slice 3)
 * @title RustMutableBorrowError rejects &mut T params before IR raise
 * @status accepted (WI-868 slice 3)
 * @rationale
 *   &mut T is the primary impurity signal for Rust function signatures:
 *   any fn that takes a mutable reference is observable side-effecting from
 *   the caller's perspective.  Rejecting at signature inspection (before body
 *   raise) gives a clear, early error with the param name.  The class extends
 *   CannotRaiseToIRError so callers can use instanceof CannotRaiseToIRError
 *   uniformly across all adapter errors.  Interior mutability (Cell/RefCell)
 *   and static mut are deferred — they require body analysis and are rare in
 *   the pure-function corpus.
 */
export class RustMutableBorrowError extends CannotRaiseToIRError {
  constructor(
    /** Name of the parameter that carries the mutable borrow. */
    readonly paramName: string,
    /** Raw Rust type string, e.g. "&mut i32". */
    readonly rustType: string,
    location: SourceLocation,
  ) {
    super(
      `&mut param '${paramName}'`,
      location,
      `Cannot raise to IR: parameter '${paramName}' has type '${rustType}' (mutable borrow) at ${location.file}:${location.line}:${location.col}. Use an immutable reference or return a new value instead of mutating.`,
    );
    this.name = "RustMutableBorrowError";
  }
}

/**
 * Thrown when a Rust function body contains a known I/O macro invocation
 * (println!, print!, eprintln!, eprint!) or a call to a known I/O function
 * (std::fs, std::io, std::net, std::process::exit).
 *
 * These constructs perform observable side effects (stdout/stderr/filesystem/
 * network) that have no TS-subset IR equivalent.  Refactor the function to
 * return a value rather than printing/writing directly.
 *
 * Example:
 *   // Rejected — I/O side effect:
 *   fn greet(name: &str) { println!("Hello, {}!", name); }
 *
 *   // Accepted — returns the string:
 *   fn greet(name: &str) -> String { format!("Hello, {}!", name) }
 */
export class RustIoSideEffectError extends CannotRaiseToIRError {
  constructor(
    /** The offending call target name, e.g. "println!" or "std::fs::write". */
    readonly callTarget: string,
    location: SourceLocation,
  ) {
    super(
      `I/O side effect '${callTarget}'`,
      location,
      `Cannot raise to IR: I/O side effect '${callTarget}' at ${location.file}:${location.line}:${location.col}. Pure functions must not perform I/O; return a value instead.`,
    );
    this.name = "RustIoSideEffectError";
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
