// SPDX-License-Identifier: MIT
//
// errors.ts -- Go raise adapter error taxonomy (WI-870 slice 2).
//
// This module defines the >=5 documented unsupported-construct error classes
// for the Go body raiser.  Every class wraps `CannotRaiseToIRError` (or
// `AmbiguousPurityError`) from `@yakcc/contracts` — it does NOT define a
// parallel error hierarchy.
//
// @decision DEC-POLYGLOT-GO-ERROR-TAXONOMY-001 (WI-870 slice 2)
// @title Go raise adapter errors wrap @yakcc/contracts, never shadow them
// @status accepted (WI-870 slice 2)
// @rationale
//   The IR envelope is held at strict-subset TS per DEC-POLYGLOT-IR-ENVELOPE-001.
//   For banned constructs (goroutines, channels, select, defer) the correct
//   signal is CannotRaiseToIRError from @yakcc/contracts — the same class used
//   by shave-python and intended for shave-rs.  Introducing a parallel error
//   hierarchy would fragment the cross-adapter error surface and break
//   isinstance checks in CLI tooling.  Each class here is a thin named
//   constructor that sets `construct` + `location` on the base class so callers
//   can do `instanceof CannotRaiseToIRError` for any adapter error.
//   AmbiguousPurityError is used for constructs that are not banned per se but
//   whose purity cannot be statically determined.

import { AmbiguousPurityError, CannotRaiseToIRError, type SourceLocation } from "@yakcc/contracts";

// Re-export so callers can import from one place.
export { AmbiguousPurityError, CannotRaiseToIRError, type SourceLocation };

// ---------------------------------------------------------------------------
// Banned-construct errors (5 distinct classes — all extend CannotRaiseToIRError)
// ---------------------------------------------------------------------------

/**
 * Thrown when a Go function body contains a goroutine launch (`go <expr>`).
 *
 * Goroutines are Go-specific concurrency primitives with no TS-subset IR
 * equivalent (DEC-POLYGLOT-IR-ENVELOPE-001).  The function must be simplified
 * to remove the `go` statement before it can be raised.
 */
export class GoGoroutineError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "go (goroutine)",
      location,
      `Cannot raise to IR: goroutine launch ('go' statement) at ${location.file}:${location.line}:${location.col}. Remove concurrent execution to make the function raiseable.`,
    );
    this.name = "GoGoroutineError";
  }
}

/**
 * Thrown when a Go function body contains a channel send (`ch <- val`).
 *
 * Channel communication is Go-specific and cannot be expressed in the
 * TS-subset IR.  The function must be refactored to remove channel I/O.
 */
export class GoChanSendError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "chan send (<-)",
      location,
      `Cannot raise to IR: channel send ('<-' send) at ${location.file}:${location.line}:${location.col}. Remove channel communication to make the function raiseable.`,
    );
    this.name = "GoChanSendError";
  }
}

/**
 * Thrown when a Go function body contains a channel receive (`<-ch`).
 *
 * Channel receives are Go-specific blocking operations with no TS-subset IR
 * equivalent.  Refactor to remove channel receives.
 */
export class GoChanRecvError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "chan recv (<-)",
      location,
      `Cannot raise to IR: channel receive ('<-' receive) at ${location.file}:${location.line}:${location.col}. Remove channel communication to make the function raiseable.`,
    );
    this.name = "GoChanRecvError";
  }
}

/**
 * Thrown when a Go function body contains a `select` statement.
 *
 * `select` coordinates channel operations and has no TS-subset IR equivalent.
 * Functions using select must be restructured or excluded from shaving.
 */
export class GoSelectError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "select",
      location,
      `Cannot raise to IR: 'select' statement at ${location.file}:${location.line}:${location.col}. Remove channel-dependent selection logic to make the function raiseable.`,
    );
    this.name = "GoSelectError";
  }
}

/**
 * Thrown when a Go function body contains a `defer` statement.
 *
 * `defer` schedules execution at function return and introduces side-effecting
 * execution order that cannot be modelled in the TS-subset IR.
 */
export class GoDeferError extends CannotRaiseToIRError {
  constructor(location: SourceLocation) {
    super(
      "defer",
      location,
      `Cannot raise to IR: 'defer' statement at ${location.file}:${location.line}:${location.col}. Remove deferred calls to make the function raiseable.`,
    );
    this.name = "GoDeferError";
  }
}

/**
 * Thrown when a Go function body contains a statement or expression that is
 * not in the slice-2 supported subset (e.g. if, for, range, switch, composite
 * literals, type assertions).
 *
 * This is NOT the same as a banned purity-boundary construct — the construct
 * may be pure in principle but is outside the MVP raise surface.  Slice 3+
 * will progressively expand the supported set.
 */
export class GoUnsupportedConstructError extends CannotRaiseToIRError {
  constructor(construct: string, location: SourceLocation) {
    super(
      construct,
      location,
      `Cannot raise to IR: unsupported Go construct '${construct}' at ${location.file}:${location.line}:${location.col}. This construct is outside the slice-2 raise surface; it may be supported in a future slice.`,
    );
    this.name = "GoUnsupportedConstructError";
  }
}

// ---------------------------------------------------------------------------
// Purity-ambiguity error (wraps AmbiguousPurityError from @yakcc/contracts)
// ---------------------------------------------------------------------------

/**
 * Thrown when purity inference cannot determine whether a Go function is pure.
 *
 * This occurs when the body contains constructs whose purity depends on
 * runtime information not available statically (e.g., opaque interface calls,
 * unknown external packages).  The developer should either annotate the
 * function explicitly or restructure to make purity obvious.
 *
 * Distinct from GoUnsupportedConstructError: an ambiguous-purity function is
 * not necessarily banned — it just cannot be classified without more
 * information.
 */
export class GoAmbiguousPurityError extends AmbiguousPurityError {
  constructor(reason: string, location: SourceLocation) {
    super(reason, location);
    this.name = "GoAmbiguousPurityError";
  }
}
