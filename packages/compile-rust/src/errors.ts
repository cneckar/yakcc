// SPDX-License-Identifier: Apache-2.0
//
// errors.ts -- error taxonomy for @yakcc/compile-rust (Slice 2).
//
// @decision DEC-POLYGLOT-RUST-COMPILE-ERR-001
// @title CannotLowerToRustError base promoted to @yakcc/contracts in Slice 2
// @status accepted (WI-869-s2)
// @rationale
//   Slice 1 defined CannotLowerToRustError locally pending taxonomy validation.
//   Slice 2 promotes the base to @yakcc/contracts/polyglot-errors.ts (mirroring
//   CannotLowerToPythonError / CannotLowerToGoError) and re-exports it from here
//   so existing importers of @yakcc/compile-rust remain unchanged. Subclasses
//   continue to live here as they are compile-rust-specific blocker details.
//   Sacred Practice #12: single authority -- no dual definition.
//
// @taxonomy
//   CannotLowerToRustError (base, @yakcc/contracts) -- any IR construct the Rust emitter cannot handle.
//   RustUnsupportedTypeError          -- TS type has no Rust MVP equivalent.
//   RustUnsupportedExprError          -- IR expression construct not in MVP surface.
//   RustUnsupportedStmtError          -- IR statement construct not in MVP surface.
//   RustAsyncError                    -- async/Promise/await found in IR; no Rust MVP equivalent.
//   RustGenericError                  -- complex generics beyond the MVP surface.

export { CannotLowerToRustError } from "@yakcc/contracts";
import { CannotLowerToRustError } from "@yakcc/contracts";

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
