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

/**
 * Thrown by the IR→Go lower adapter (@yakcc/compile-go) when a
 * TS-subset IR node has no Go equivalent and cannot be silently emitted.
 *
 * Mirrors CannotLowerToPythonError (WI-943) for the Go direction (WI-973).
 * Loud failure over silent fallback: any unhandled IR construct produces
 * an unmistakable error naming the node kind, location, and snippet so the
 * next implementer knows exactly what coverage is missing.
 *
 * @decision DEC-WI973-004
 * @title CannotLowerToGoError added to contracts as sibling of CannotLowerToPythonError
 * @status accepted (WI-973)
 * @rationale
 *   Single authority for polyglot error vocabulary is packages/contracts/polyglot-errors.ts
 *   (DEC-WI973-004). Same constructor signature as CannotLowerToPythonError so
 *   consumers can handle both errors uniformly. Re-exported via contracts barrel
 *   for use by any downstream consumer of compile-go.
 */
export class CannotLowerToGoError extends Error {
  constructor(
    public readonly nodeKind: string,
    public readonly location: { line: number; column: number },
    public readonly snippet: string,
    public readonly fnName: string | undefined,
  ) {
    super(
      `Cannot lower TS-subset IR to Go: ${nodeKind} at ${fnName ?? "<top-level>"}:${location.line}:${location.column} — ${snippet}`,
    );
    this.name = "CannotLowerToGoError";
  }
}

/**
 * Base error: a TS-subset IR construct cannot be lowered to Rust using the
 * compile-rust MVP emitter surface.
 *
 * Subclasses map to specific blocker categories (≥5 classes).
 *
 * @decision DEC-POLYGLOT-RUST-COMPILE-ERR-001
 * @title CannotLowerToRustError promoted from compile-rust/errors.ts to contracts (Slice 2)
 * @status accepted (WI-869-s2)
 * @rationale
 *   Mirrors the promotion pattern for CannotLowerToPythonError (WI-943) and
 *   CannotLowerToGoError (WI-973). The local definition in compile-rust/errors.ts
 *   was explicitly annotated as a Slice-1 placeholder pending taxonomy validation.
 *   Promoting to @yakcc/contracts makes the base class available for any future
 *   lower adapter or cross-package error handling. compile-rust/errors.ts now
 *   imports from here and extends this class, eliminating the dual-authority.
 *   Sacred Practice #12: single source of truth per state domain.
 *
 * Blocker taxonomy (Slice 1 seed):
 *
 *   BLOCKER-RUST-001 (async/Promise/await)
 *     Rust async and futures are out of scope for the MVP lower surface.
 *     Example: `export async function fetchNum(): Promise<number> { return 42; }`
 *
 *   BLOCKER-RUST-002 (complex generics)
 *     Generic type parameters with non-trivial constraints are beyond MVP.
 *     Example: `export function id<T extends Comparable>(x: T): T { return x; }`
 *
 *   BLOCKER-RUST-003 (unsupported TS type)
 *     TS types without a Rust MVP equivalent (bigint, symbol, etc.).
 *     Example: `export function bigNum(x: bigint): bigint { return x; }`
 *
 *   BLOCKER-RUST-004 (unsupported expression)
 *     IR expression constructs not in the Rust MVP emit surface.
 *     Example: tagged template literals, spread expressions.
 *
 *   BLOCKER-RUST-005 (unsupported statement)
 *     IR statement constructs the Rust emitter cannot produce.
 *     Example: for-of loops over iterables with complex patterns.
 */
export class CannotLowerToRustError extends Error {
  constructor(
    public readonly constructKind: string,
    public readonly location: { line: number; column: number },
    public readonly snippet: string,
    public readonly fnName?: string | undefined,
  ) {
    const loc = `${location.line}:${location.column}`;
    const fn_ = fnName ? ` in '${fnName}'` : "";
    super(`Cannot lower ${constructKind}${fn_} at ${loc}: ${snippet}`);
    this.name = "CannotLowerToRustError";
  }
}
