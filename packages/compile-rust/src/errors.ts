// SPDX-License-Identifier: Apache-2.0
//
// errors.ts -- local error taxonomy for @yakcc/compile-rust (Slice 1).
//
// @decision DEC-POLYGLOT-RUST-COMPILE-001
// @title CannotLowerToRustError is defined locally in Slice 1; promoted to
//   @yakcc/contracts in Slice 2 once the full taxonomy is validated.
// @status decided (Slice 1)
// @rationale
//   Mirrors DEC-POLYGLOT-GO-ERROR-TAXONOMY-001 / DEC-POLYGLOT-COMPILE-PY-001.
//   The local definition avoids a contracts PR dependency for Slice 1 while the
//   taxonomy stabilises.  Slice 2 will import from @yakcc/contracts and remove
//   this file (Sacred Practice #12 -- no dual authorities).
//
// @taxonomy
//   CannotLowerToRustError (base)     -- any IR construct the Rust emitter cannot handle.
//   RustUnsupportedTypeError          -- TS type has no Rust MVP equivalent.
//   RustUnsupportedExprError          -- IR expression construct not in MVP surface.
//   RustUnsupportedStmtError          -- IR statement construct not in MVP surface.
//   RustAsyncError                    -- async/Promise/await found in IR; no Rust MVP equivalent.
//   RustGenericError                  -- complex generics beyond the MVP surface.

/**
 * Base error: an IR construct cannot be lowered to Rust using the Slice-1 MVP
 * emitter surface.
 *
 * Subclasses map to specific blocker categories (>=5 classes, satisfying the
 * Slice-1 Evaluation Contract).
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

/**
 * BLOCKER-RUST-003: A TypeScript type has no Rust MVP equivalent.
 *
 * Example triggering construct:
 *   export function widen(x: bigint): bigint { return x; }
 *   -> bigint has no direct Rust primitive equivalent in the MVP table.
 */
export class RustUnsupportedTypeError extends CannotLowerToRustError {
  constructor(
    public readonly tsType: string,
    location: { line: number; column: number },
    snippet: string,
    fnName?: string | undefined,
  ) {
    super(`UnsupportedType(${tsType})`, location, snippet, fnName);
    this.name = "RustUnsupportedTypeError";
  }
}

/**
 * BLOCKER-RUST-004: An IR expression construct is not in the Rust MVP surface.
 *
 * Example triggering construct:
 *   export function f(xs: number[]): number[] { return [...xs, 1]; }
 *   -> SpreadElement is not in the Slice-1 emit surface.
 */
export class RustUnsupportedExprError extends CannotLowerToRustError {
  constructor(
    constructKind: string,
    location: { line: number; column: number },
    snippet: string,
    fnName?: string | undefined,
  ) {
    super(constructKind, location, snippet, fnName);
    this.name = "RustUnsupportedExprError";
  }
}

/**
 * BLOCKER-RUST-005: An IR statement construct is not in the Rust MVP surface.
 *
 * Example triggering construct:
 *   export function f(xs: number[]): void { for (const x of xs) { } }
 *   -> for-of is not in the Slice-1 emit surface (Rust for..in is Slice 2+).
 */
export class RustUnsupportedStmtError extends CannotLowerToRustError {
  constructor(
    constructKind: string,
    location: { line: number; column: number },
    snippet: string,
    fnName?: string | undefined,
  ) {
    super(constructKind, location, snippet, fnName);
    this.name = "RustUnsupportedStmtError";
  }
}

/**
 * BLOCKER-RUST-001: async/Promise/await in the IR; no Rust MVP equivalent.
 *
 * Example triggering construct:
 *   export async function fetchNum(): Promise<number> { return 42; }
 *   -> async functions require Rust futures/tokio, out of scope for MVP.
 */
export class RustAsyncError extends CannotLowerToRustError {
  constructor(
    location: { line: number; column: number },
    snippet: string,
    fnName?: string | undefined,
  ) {
    super("AsyncConstruct", location, snippet, fnName);
    this.name = "RustAsyncError";
  }
}

/**
 * BLOCKER-RUST-002: Complex generics beyond the MVP surface.
 *
 * Example triggering construct:
 *   export function id<T extends Comparable>(x: T): T { return x; }
 *   -> constrained type parameters have no direct Rust MVP equivalent.
 */
export class RustGenericError extends CannotLowerToRustError {
  constructor(
    public readonly constraint: string,
    location: { line: number; column: number },
    snippet: string,
    fnName?: string | undefined,
  ) {
    super(`UnsupportedGeneric(${constraint})`, location, snippet, fnName);
    this.name = "RustGenericError";
  }
}
