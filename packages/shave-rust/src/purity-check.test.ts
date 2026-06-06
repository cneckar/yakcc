// SPDX-License-Identifier: Apache-2.0
//
// purity-check.test.ts -- static purity inference tests for Rust (WI-868 slice 3).
//
// All tests build FunctionSignature objects directly (no subprocess) following
// the pattern established by parse-fn-signature.test.ts.  The purity check is
// purely static (no Rust subprocess) so direct injection is the correct boundary.
//
// @decision DEC-POLYGLOT-RUST-PURITY-001 (WI-868 slice 3)
// @title purity-check tests use signature injection, not real subprocess
// @status accepted (WI-868 slice 3)
// @rationale
//   Consistent with the pattern from raise-body.test.ts: synthetic v2 wire nodes
//   are built in-process.  The purity check operates entirely on the typed
//   FunctionSignature shape; no subprocess or cargo invocation is needed.

import { CannotRaiseToIRError } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { RustIoSideEffectError, RustMutableBorrowError } from "./errors.js";
import type { FunctionSignature, RaisedParam } from "./parse-fn-signature.js";
import { KNOWN_IO_MACROS, KNOWN_IO_PATHS, checkPurity, hasMutableBorrow } from "./purity-check.js";
import type { RustAstBodyNode } from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function param(name: string, tsType: string, rustType: string): RaisedParam {
  return { name, tsType, rustType };
}

function sig(overrides: Partial<FunctionSignature> = {}): FunctionSignature {
  return {
    name: "add",
    rustName: "add",
    isPub: true,
    params: [param("a", "number", "i32"), param("b", "number", "i32")],
    returnType: "number",
    rustReturnType: "i32",
    bodySource: "a + b",
    body: null,
    ...overrides,
  };
}

/**
 * Build a minimal v2 body with one ExprStmt wrapping an UnsupportedExpr.
 * Used to simulate macro invocations that the syn helper cannot lower.
 */
function unsupportedExprBody(reason: string): RustAstBodyNode {
  return {
    stmts: [
      {
        type: "ExprStmt",
        isTail: false,
        line: 2,
        col: 3,
        x: {
          type: "UnsupportedExpr",
          reason,
          line: 2,
          col: 3,
        },
      },
    ],
  };
}

/**
 * Build a body with one UnsupportedStmt (for macro invocations emitted as stmts).
 */
function unsupportedStmtBody(reason: string): RustAstBodyNode {
  return {
    stmts: [
      {
        type: "UnsupportedStmt",
        reason,
        line: 3,
        col: 5,
      },
    ],
  };
}

/**
 * Build a body with a simple tail ExprStmt returning a + b (pure).
 */
function pureBinaryBody(): RustAstBodyNode {
  return {
    stmts: [
      {
        type: "ExprStmt",
        isTail: true,
        line: 2,
        col: 3,
        x: {
          type: "BinaryExpr",
          op: "+",
          line: 2,
          col: 3,
          x: { type: "Ident", name: "a", line: 2, col: 3 },
          y: { type: "Ident", name: "b", line: 2, col: 7 },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// hasMutableBorrow unit tests
// ---------------------------------------------------------------------------

describe("hasMutableBorrow", () => {
  it("returns true for &mut T", () => {
    expect(hasMutableBorrow("&mut i32")).toBe(true);
  });

  it("returns true for & mut T (space)", () => {
    expect(hasMutableBorrow("& mut String")).toBe(true);
  });

  it("returns true for &mut Vec<i32>", () => {
    expect(hasMutableBorrow("&mut Vec<i32>")).toBe(true);
  });

  it("returns false for immutable reference &T", () => {
    expect(hasMutableBorrow("&i32")).toBe(false);
  });

  it("returns false for plain value type", () => {
    expect(hasMutableBorrow("i32")).toBe(false);
  });

  it("returns false for String (no ref)", () => {
    expect(hasMutableBorrow("String")).toBe(false);
  });

  it("returns false for &str (immutable slice)", () => {
    expect(hasMutableBorrow("&str")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reject-list constants sanity checks
// ---------------------------------------------------------------------------

describe("KNOWN_IO_MACROS", () => {
  it("includes println!", () => expect(KNOWN_IO_MACROS.has("println!")).toBe(true));
  it("includes eprintln!", () => expect(KNOWN_IO_MACROS.has("eprintln!")).toBe(true));
  it("includes print!", () => expect(KNOWN_IO_MACROS.has("print!")).toBe(true));
  it("includes dbg!", () => expect(KNOWN_IO_MACROS.has("dbg!")).toBe(true));
  it("includes panic!", () => expect(KNOWN_IO_MACROS.has("panic!")).toBe(true));
});

describe("KNOWN_IO_PATHS", () => {
  it("includes std::fs", () => expect(KNOWN_IO_PATHS.has("std::fs")).toBe(true));
  it("includes std::io", () => expect(KNOWN_IO_PATHS.has("std::io")).toBe(true));
  it("includes exit", () => expect(KNOWN_IO_PATHS.has("exit")).toBe(true));
});

// ---------------------------------------------------------------------------
// Phase 1: &mut T param rejection
// ---------------------------------------------------------------------------

describe("checkPurity — &mut T param rejection", () => {
  it("throws RustMutableBorrowError for a &mut i32 param", () => {
    const s = sig({
      params: [param("x", "number", "&mut i32")],
    });
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });

  it("throws RustMutableBorrowError for & mut String (with space)", () => {
    const s = sig({
      params: [param("s", "string", "& mut String")],
    });
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });

  it("RustMutableBorrowError extends CannotRaiseToIRError", () => {
    const s = sig({
      params: [param("x", "number", "&mut i32")],
    });
    try {
      checkPurity(s);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RustMutableBorrowError);
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
    }
  });

  it("error carries the correct paramName and rustType", () => {
    const s = sig({
      params: [param("counter", "number", "&mut i32")],
    });
    try {
      checkPurity(s);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RustMutableBorrowError);
      const e = err as RustMutableBorrowError;
      expect(e.paramName).toBe("counter");
      expect(e.rustType).toBe("&mut i32");
    }
  });

  it("throws on first &mut param when multiple params exist", () => {
    const s = sig({
      params: [
        param("a", "number", "i32"),
        param("b", "number", "&mut i32"),
        param("c", "number", "i32"),
      ],
    });
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });

  it("rejects fn increment(x: &mut i32) — canonical mutability example", () => {
    // fn increment(x: &mut i32) { *x += 1; }
    const s = sig({
      name: "increment",
      rustName: "increment",
      params: [param("x", "number", "&mut i32")],
      returnType: "void",
      rustReturnType: "",
    });
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: I/O side effect rejection (UnsupportedExpr macro nodes)
// ---------------------------------------------------------------------------

describe("checkPurity — I/O macro rejection", () => {
  it("throws RustIoSideEffectError for println! in UnsupportedExpr body", () => {
    const s = sig({
      body: unsupportedExprBody("Expr::Macro (println!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });

  it("throws RustIoSideEffectError for eprintln! in UnsupportedExpr body", () => {
    const s = sig({
      body: unsupportedExprBody("Expr::Macro (eprintln!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });

  it("throws RustIoSideEffectError for println! in UnsupportedStmt body", () => {
    const s = sig({
      body: unsupportedStmtBody("Expr::Macro (println!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });

  it("throws RustIoSideEffectError for print! in UnsupportedStmt body", () => {
    const s = sig({
      body: unsupportedStmtBody("Expr::Macro (print!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });

  it("RustIoSideEffectError extends CannotRaiseToIRError", () => {
    const s = sig({ body: unsupportedExprBody("Expr::Macro (println!)") });
    try {
      checkPurity(s);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RustIoSideEffectError);
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
    }
  });

  it("error carries the callTarget name", () => {
    const s = sig({ body: unsupportedExprBody("Expr::Macro (println!)") });
    try {
      checkPurity(s);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RustIoSideEffectError);
      const e = err as RustIoSideEffectError;
      expect(e.callTarget).toBe("println!");
    }
  });

  it("rejects fn greet(name: &str) { println!(...) } — canonical I/O example", () => {
    // fn greet(name: &str) { println!("Hello, {}!", name); }
    const s = sig({
      name: "greet",
      rustName: "greet",
      params: [param("name", "string", "&str")],
      returnType: "void",
      rustReturnType: "",
      body: unsupportedStmtBody("Expr::Macro (println!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 fires before Phase 2 (ordering guarantee)
// ---------------------------------------------------------------------------

describe("checkPurity — phase ordering: &mut detected before body I/O", () => {
  it("throws RustMutableBorrowError even when body also has println!", () => {
    const s = sig({
      params: [param("x", "number", "&mut i32")],
      body: unsupportedStmtBody("Expr::Macro (println!)"),
    });
    // &mut check fires first (Phase 1), so we get RustMutableBorrowError, not RustIoSideEffectError.
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });
});

// ---------------------------------------------------------------------------
// Pure functions: pass through without throwing
// ---------------------------------------------------------------------------

describe("checkPurity — pure functions pass", () => {
  it("accepts fn add(a: i32, b: i32) -> i32 with pure binary body", () => {
    const s = sig({ body: pureBinaryBody() });
    expect(() => checkPurity(s)).not.toThrow();
  });

  it("accepts fn add(a: i32, b: i32) -> i32 with null body (extern)", () => {
    const s = sig({ body: null });
    expect(() => checkPurity(s)).not.toThrow();
  });

  it("accepts a function with immutable &str param", () => {
    const s = sig({
      params: [param("name", "string", "&str")],
      returnType: "string",
    });
    expect(() => checkPurity(s)).not.toThrow();
  });

  it("accepts a function with &i32 (immutable reference)", () => {
    const s = sig({
      params: [param("x", "number", "&i32")],
    });
    expect(() => checkPurity(s)).not.toThrow();
  });

  it("accepts a function with no params and a literal return", () => {
    const s = sig({
      name: "pi",
      rustName: "pi",
      params: [],
      returnType: "number",
      rustReturnType: "f64",
      body: {
        stmts: [
          {
            type: "ExprStmt",
            isTail: true,
            line: 2,
            col: 3,
            x: { type: "Lit", kind: "FLOAT", value: "3.14159", line: 2, col: 3 },
          },
        ],
      },
    });
    expect(() => checkPurity(s)).not.toThrow();
  });

  it("accepts fn is_even(n: i32) -> bool (value params, pure body)", () => {
    const s = sig({
      name: "isEven",
      rustName: "is_even",
      params: [param("n", "number", "i32")],
      returnType: "boolean",
      rustReturnType: "bool",
      body: pureBinaryBody(),
    });
    expect(() => checkPurity(s)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: full pipeline + purity gate
//
// Production sequence: extractFunctionSignatures -> checkPurity -> renderFunctionDeclaration
// Tests here cross the checkPurity boundary with a real FunctionSignature shape,
// mirroring the sequence in raise-function.ts.
// ---------------------------------------------------------------------------

describe("compound: checkPurity integrates with FunctionSignature pipeline", () => {
  it("passes a pure add(i32, i32)->i32 through the purity gate", () => {
    const s = sig({ body: pureBinaryBody() });
    // This is the "pure fn add" proof required by the dispatch instructions.
    expect(() => checkPurity(s)).not.toThrow();
    // After passing, the signature is ready for renderFunctionDeclaration.
    expect(s.name).toBe("add");
    expect(s.params).toHaveLength(2);
  });

  it("blocks fn increment(x: &mut i32) — purity gate fires before render", () => {
    const s = sig({
      name: "increment",
      rustName: "increment",
      params: [param("x", "number", "&mut i32")],
      returnType: "void",
      rustReturnType: "",
    });
    // checkPurity must throw before renderFunctionDeclaration is called.
    expect(() => checkPurity(s)).toThrow(RustMutableBorrowError);
  });

  it("blocks fn log_val(x: i32) { println!(...) } — I/O gate fires", () => {
    const s = sig({
      name: "logVal",
      rustName: "log_val",
      params: [param("x", "number", "i32")],
      returnType: "void",
      rustReturnType: "",
      body: unsupportedStmtBody("Expr::Macro (println!)"),
    });
    expect(() => checkPurity(s)).toThrow(RustIoSideEffectError);
  });
});
