/**
 * Typed errors emitted by per-language raise adapters when a source construct
 * cannot be expressed in the TS-subset IR envelope.
 *
 * @decision DEC-POLYGLOT-IR-ENVELOPE-001 (held-the-line — option c)
 * @title IR envelope is held at strict-subset TS; out-of-envelope constructs throw
 * @status decided (ADR Q1: polyglot-architecture.md §Q1)
 * @rationale
 *   Per the polyglot architecture ADR, the IR envelope is NOT widened to absorb
 *   Python generators, Rust lifetimes, Go channels, etc. When a per-language
 *   raise adapter encounters such a construct, it throws CannotRaiseToIRError
 *   so the developer either simplifies their function or leaves it unshaved.
 *   AmbiguousPurityError is thrown when static purity analysis cannot decide
 *   (dynamic dispatch, opaque imports); same hold-the-line stance.
 * @scope @yakcc/contracts barrel re-exports both classes for use by future
 *   adapters: @yakcc/shave-py (#782), @yakcc/shave-go, @yakcc/shave-rs.
 */

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly col: number;
}

/**
 * Thrown when a per-language raise adapter encounters a source construct that
 * cannot be expressed in the TS-subset IR envelope.
 *
 * Example callers (future):
 *   - @yakcc/shave-py encountering `async def` or `yield`
 *   - @yakcc/shave-go encountering goroutines or channels
 *   - @yakcc/shave-rs encountering lifetimes or `unsafe`
 */
export class CannotRaiseToIRError extends Error {
  constructor(
    public readonly construct: string,
    public readonly location: SourceLocation,
    message?: string,
  ) {
    super(
      message ??
        `Cannot raise to IR: ${construct} at ${location.file}:${location.line}:${location.col}`,
    );
    this.name = "CannotRaiseToIRError";
  }
}

/**
 * Thrown when a per-language raise adapter's purity-inference pass cannot
 * decide whether a function is pure (e.g. dynamic dispatch, opaque imports).
 *
 * Distinct from CannotRaiseToIRError: a construct that is conditionally pure
 * is not banned by the envelope — the adapter just lacks the information to
 * make the call. Surfacing this separately lets future adapters offer a
 * specific remediation ("annotate this dispatch as pure / impure").
 */
export class AmbiguousPurityError extends Error {
  constructor(
    public readonly reason: string,
    public readonly location: SourceLocation,
  ) {
    super(`Ambiguous purity at ${location.file}:${location.line}:${location.col}: ${reason}`);
    this.name = "AmbiguousPurityError";
  }
}
