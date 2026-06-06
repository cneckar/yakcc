// SPDX-License-Identifier: Apache-2.0
//
// purity-check.ts -- static purity inference for Rust functions (WI-868 slice 3).
//
// Inspects the v2 wire envelope (already produced by rust-ast-parser.ts) and
// rejects functions that use &mut params, I/O macros, or other impure constructs.
// This is a static reject-list: no new Rust subprocess is spawned.
//
// @decision DEC-POLYGLOT-RUST-PURITY-001 (WI-868 slice 3)
// @title Static reject-list purity inference for Rust — signature + body walk
// @status accepted (WI-868 slice 3)
// @rationale
//   Mirrors DEC-POLYGLOT-SHAVE-PY-PURITY-001 exactly.  The MVP purity scope covers:
//   (1) &mut T params — structural signature check, cheap and exhaustive.
//   (2) Known I/O call targets in the body — println!/print!/eprintln!/eprint!,
//       and known std I/O path prefixes (std::fs, std::io, std::net,
//       std::process::exit).  These are the most common impurity signals in the
//       pure-function corpus.
//   Deferred: interior mutability (Cell/RefCell), static mut reads, trait objects
//   hiding impure impls — these require deeper analysis beyond the static
//   reject-list and are documented as deferred per plan.
//   checkPurity operates entirely on the existing FunctionSignature + body AST —
//   no new subprocess invocation.

import type { SourceLocation } from "@yakcc/contracts";
import {
  RustAmbiguousPurityError,
  RustIoSideEffectError,
  RustMutableBorrowError,
} from "./errors.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import type { RustAstExpr } from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Known I/O call targets (reject-list)
// ---------------------------------------------------------------------------

/**
 * Macro names (without the `!`) and free-function path segments that constitute
 * known I/O side effects in Rust.
 *
 * The Rust syn helper emits macro invocations as `UnsupportedExpr` nodes with
 * a reason string such as "Expr::Macro (println!)".  We also check CallExpr /
 * MethodCallExpr callee names for known std I/O functions.
 *
 * Convention: macro names end with `!` here; free-function segments do not.
 */
export const KNOWN_IO_MACROS = new Set([
  "println!",
  "print!",
  "eprintln!",
  "eprint!",
  "write!",
  "writeln!",
  "dbg!",
  "todo!",
  "unimplemented!",
  "panic!",
]);

/**
 * Path prefixes whose presence as a call target (Ident name or full path) in
 * the body signals I/O or process-exit side effects.
 */
export const KNOWN_IO_PATHS = new Set([
  "std::fs",
  "std::io",
  "std::net",
  "std::process",
  "std::os",
  "fs",
  "io",
  "exit",
  "abort",
]);

// ---------------------------------------------------------------------------
// Mutable-borrow pattern detection
// ---------------------------------------------------------------------------

/**
 * Return true when a raw Rust type string contains a mutable borrow.
 * Handles both `&mut T` and `& mut T` (with optional whitespace).
 *
 * Examples:
 *   "&mut i32"       → true
 *   "& mut String"   → true
 *   "&i32"           → false
 *   "i32"            → false
 */
export function hasMutableBorrow(rustType: string): boolean {
  return /&\s*mut\b/.test(rustType);
}

// ---------------------------------------------------------------------------
// Body-walk: collect I/O call targets
// ---------------------------------------------------------------------------

interface IoViolation {
  readonly callTarget: string;
  readonly line: number;
  readonly col: number;
}

/**
 * Walk a v2 wire expression node tree and collect known I/O call targets.
 *
 * Matches:
 *  - CallExpr with an Ident callee name that is a known I/O path segment.
 *  - MethodCallExpr with a method name that is a known I/O path segment.
 *  - UnsupportedExpr with a reason string that embeds a known I/O macro name
 *    (the syn helper emits macro invocations as UnsupportedExpr with reason
 *    strings like "Expr::Macro (println!)").
 *
 * Unknown/unsupported shapes are skipped conservatively.
 */
function collectBodyIoViolations(expr: RustAstExpr): IoViolation[] {
  const violations: IoViolation[] = [];

  function visitExpr(e: RustAstExpr): void {
    switch (e.type) {
      case "CallExpr": {
        // Direct call: check the function expression for a known I/O name.
        const fn = e.fun;
        if (fn.type === "Ident") {
          const name = fn.name;
          if (KNOWN_IO_PATHS.has(name)) {
            violations.push({ callTarget: name, line: e.line, col: e.col });
          }
        }
        // Recurse into callee and args regardless.
        visitExpr(e.fun);
        for (const arg of e.args) visitExpr(arg);
        break;
      }

      case "MethodCallExpr": {
        // Check the method name.
        if (KNOWN_IO_PATHS.has(e.method)) {
          violations.push({ callTarget: e.method, line: e.line, col: e.col });
        }
        visitExpr(e.receiver);
        for (const arg of e.args) visitExpr(arg);
        break;
      }

      case "UnsupportedExpr": {
        // The syn helper emits macro invocations as UnsupportedExpr with
        // reason strings like: "Expr::Macro (println!)" or "macro: println!".
        // Extract the macro name from the reason string.
        const reason = e.reason;
        for (const macro of KNOWN_IO_MACROS) {
          if (reason.includes(macro)) {
            violations.push({ callTarget: macro, line: e.line, col: e.col });
            break;
          }
        }
        // Also check for plain macro names without the parenthetical wrapping,
        // e.g. reason = "println!" directly.
        if (KNOWN_IO_MACROS.has(reason)) {
          violations.push({ callTarget: reason, line: e.line, col: e.col });
        }
        break;
      }

      case "BinaryExpr":
        visitExpr(e.x);
        visitExpr(e.y);
        break;

      case "UnaryExpr":
        visitExpr(e.x);
        break;

      case "FieldExpr":
        visitExpr(e.x);
        break;

      case "IndexExpr":
        visitExpr(e.x);
        visitExpr(e.index);
        break;

      case "IfExpr":
        visitExpr(e.cond);
        for (const s of e.thenBranch.stmts) {
          if (s.type === "ExprStmt" || s.type === "ReturnStmt") {
            if (s.type === "ExprStmt") visitExpr(s.x);
            else if (s.value !== null) visitExpr(s.value);
          } else if (s.type === "LetStmt" && s.value !== null) {
            visitExpr(s.value);
          }
        }
        if (e.orelse !== null) {
          if (e.orelse.type === "IfExpr") {
            visitExpr(e.orelse);
          } else {
            for (const s of e.orelse.body.stmts) {
              if (s.type === "ExprStmt") visitExpr(s.x);
              else if (s.type === "ReturnStmt" && s.value !== null) visitExpr(s.value);
              else if (s.type === "LetStmt" && s.value !== null) visitExpr(s.value);
            }
          }
        }
        break;

      case "ReturnExpr":
        if (e.value !== null) visitExpr(e.value);
        break;

      // Leaf nodes — no children to recurse into.
      case "Ident":
      case "Lit":
        break;

      default:
        // Exhaustive: any new expr types are conservatively skipped.
        break;
    }
  }

  visitExpr(expr);
  return violations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a raised `FunctionSignature` for purity violations.
 *
 * Phase 1 — signature check (cheap, runs before any body walk):
 *   Any param with `&mut T` or `& mut T` in its rustType → throws
 *   `RustMutableBorrowError` immediately.
 *
 * Phase 2 — body walk (only when body is non-null):
 *   Walks the structured v2 body AST and checks for known I/O call targets.
 *   First I/O violation → throws `RustIoSideEffectError`.
 *   Unknown external calls whose purity cannot be determined statically →
 *   throws `RustAmbiguousPurityError` (deferred signals; see below).
 *
 * Passing this check means "not detected as impure" — not proved pure.
 * Interior mutability (Cell/RefCell), static mut reads, and trait objects
 * hiding impure impls are deferred per DEC-POLYGLOT-RUST-PURITY-001.
 *
 * @param signature  Raised function signature (from extractFunctionSignatures).
 * @param file       Source file label for SourceLocation (default "stdin.rs").
 *
 * @throws `RustMutableBorrowError`   — any &mut T param.
 * @throws `RustIoSideEffectError`    — known I/O macro/call in body.
 * @throws `RustAmbiguousPurityError` — ambiguous purity (deferred signal).
 */
export function checkPurity(signature: FunctionSignature, file = "stdin.rs"): void {
  // Phase 1: signature-level mutable-borrow check.
  for (const param of signature.params) {
    if (hasMutableBorrow(param.rustType)) {
      const location: SourceLocation = { file, line: 0, col: 0 };
      throw new RustMutableBorrowError(param.name, param.rustType, location);
    }
  }

  // Phase 2: body walk for I/O side effects.
  if (signature.body === null) {
    // No block body (extern/trait method) — conservatively pure.
    return;
  }

  for (const stmt of signature.body.stmts) {
    let violations: IoViolation[] = [];

    if (stmt.type === "ExprStmt") {
      violations = collectBodyIoViolations(stmt.x);
    } else if (stmt.type === "ReturnStmt" && stmt.value !== null) {
      violations = collectBodyIoViolations(stmt.value);
    } else if (stmt.type === "LetStmt" && stmt.value !== null) {
      violations = collectBodyIoViolations(stmt.value);
    } else if (stmt.type === "UnsupportedStmt") {
      // Check if the unsupported stmt reason embeds a known I/O macro.
      const reason = stmt.reason;
      for (const macro of KNOWN_IO_MACROS) {
        if (reason.includes(macro)) {
          const location: SourceLocation = { file, line: stmt.line, col: stmt.col };
          throw new RustIoSideEffectError(macro, location);
        }
      }
    }

    const first = violations[0];
    if (first !== undefined) {
      const location: SourceLocation = { file, line: first.line, col: first.col };
      throw new RustIoSideEffectError(first.callTarget, location);
    }
  }
}

/**
 * Check a list of raised `FunctionSignature`s for purity violations.
 * Throws on the first impure function found.
 *
 * Convenience wrapper around `checkPurity` for callers that have already
 * extracted all signatures (e.g. raise-function.ts pipeline).
 */
export function checkAllPurity(signatures: readonly FunctionSignature[], file = "stdin.rs"): void {
  for (const sig of signatures) {
    checkPurity(sig, file);
  }
}
