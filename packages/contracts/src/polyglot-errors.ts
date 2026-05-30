/**
 * Typed errors emitted by per-language raise adapters when a source construct
 * cannot be expressed in the TS-subset IR envelope, and by the IR→Python lower
 * adapter when an IR node has no Python equivalent.
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
 * @scope @yakcc/contracts barrel re-exports all classes for use by future
 *   adapters: @yakcc/shave-py (#782), @yakcc/shave-go, @yakcc/shave-rs,
 *   and @yakcc/compile-python (WI-943).
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

/**
 * Thrown by the IR→Python lower adapter (@yakcc/compile-python) when a
 * TS-subset IR node has no Python equivalent and cannot be silently emitted.
 *
 * Replaces the former silent fallbacks (statement `# WARN: unhandled ...`
 * comment, expression raw getText() leak, and FunctionExpression getText()
 * body) introduced in WI-943. Loud failures surface coverage gaps immediately
 * instead of letting TS syntax leak into Python output.
 *
 * @decision DEC-COMPILE-PYTHON-LOUD-001
 * @title IR→Python lowering throws on unhandled nodes; no silent fallbacks
 * @status decided (WI-943)
 * @rationale
 *   Silent getText() fallbacks allowed valid-looking Python output that
 *   contained raw TS syntax (e.g. arrow functions, unhandled statements).
 *   Replacing them with a loud error forces the adapter to either handle
 *   the node kind or surface a clear actionable message naming the missing
 *   coverage. Any future gap is immediately visible in CI rather than
 *   producing subtly broken Python. This follows the Ethos principle:
 *   "loud failure over silent fallback".
 */
export class CannotLowerToPythonError extends Error {
  constructor(
    public readonly nodeKind: string,
    public readonly location: { line: number; column: number },
    public readonly snippet: string,
    public readonly fnName: string | undefined,
  ) {
    super(
      `Cannot lower TS-subset IR to Python: ${nodeKind} at ${fnName ?? "<top-level>"}:${location.line}:${location.column} — ${snippet}`,
    );
    this.name = "CannotLowerToPythonError";
  }
}
