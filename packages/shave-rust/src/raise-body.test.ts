// SPDX-License-Identifier: Apache-2.0
//
// raise-body.test.ts -- unit tests for raise-body.ts (WI-868-2C).
//
// Tests build wire body AST nodes directly (no subprocess).  They verify:
// - Expression rendering for each supported node type.
// - Statement rendering for LetStmt, ExprStmt (tail + non-tail), ReturnStmt.
// - IfExpr tail rendering (implicit return injected into branches).
// - UnsupportedStmt/Expr throws RustUnsupportedConstructError.
// - renderBody integrates all statement rendering.
// - Compound round-trip: multiple node types in one body.
//
// Mirrors packages/shave-go/src/raise-body.test.ts structure exactly.

import { CannotRaiseToIRError } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { RustUnsupportedConstructError } from "./errors.js";
import { renderBody, renderExpr, renderStmt } from "./raise-body.js";
import type {
  RustAstBodyNode,
  RustAstExpr,
  RustAstIfExpr,
  RustAstStmt,
} from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FILE = "stdin.rs";

function ident(name: string, line = 1, col = 1): RustAstExpr {
  return { type: "Ident", line, col, name };
}
function intLit(value: string, line = 1, col = 1): RustAstExpr {
  return { type: "Lit", line, col, kind: "INT", value };
}
function floatLit(value: string): RustAstExpr {
  return { type: "Lit", line: 1, col: 1, kind: "FLOAT", value };
}
function strLit(value: string): RustAstExpr {
  return { type: "Lit", line: 1, col: 1, kind: "STR", value };
}
function boolLit(value: "true" | "false"): RustAstExpr {
  return { type: "Lit", line: 1, col: 1, kind: "BOOL", value };
}
function binExpr(op: string, x: RustAstExpr, y: RustAstExpr): RustAstExpr {
  return { type: "BinaryExpr", line: 1, col: 1, op, x, y };
}
function body(stmts: RustAstStmt[]): RustAstBodyNode {
  return { stmts };
}
function tailExprStmt(x: RustAstExpr, line = 1, col = 1): RustAstStmt {
  return { type: "ExprStmt", line, col, x, isTail: true };
}
function exprStmt(x: RustAstExpr, line = 1, col = 1): RustAstStmt {
  return { type: "ExprStmt", line, col, x, isTail: false };
}
function returnStmt(value: RustAstExpr | null, line = 1, col = 1): RustAstStmt {
  return { type: "ReturnStmt", line, col, value };
}
function letStmt(name: string, value: RustAstExpr, line = 1, col = 1): RustAstStmt {
  return { type: "LetStmt", line, col, name, value };
}

// ---------------------------------------------------------------------------
// renderExpr — Ident (with snake_case -> camelCase normalization)
// ---------------------------------------------------------------------------

describe("renderExpr — Ident", () => {
  it("returns a plain identifier as-is", () => {
    expect(renderExpr(ident("x"))).toBe("x");
  });

  it("normalizes snake_case to camelCase", () => {
    expect(renderExpr(ident("min_val"))).toBe("minVal");
    expect(renderExpr(ident("get_user_id"))).toBe("getUserId");
  });

  it("preserves PascalCase identifiers", () => {
    expect(renderExpr(ident("MyStruct"))).toBe("MyStruct");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — Lit
// ---------------------------------------------------------------------------

describe("renderExpr — Lit INT", () => {
  it("renders INT literal verbatim", () => {
    expect(renderExpr(intLit("42"))).toBe("42");
    expect(renderExpr(intLit("0"))).toBe("0");
  });
});

describe("renderExpr — Lit FLOAT", () => {
  it("renders FLOAT literal verbatim", () => {
    expect(renderExpr(floatLit("3.14"))).toBe("3.14");
    expect(renderExpr(floatLit("0.0"))).toBe("0.0");
  });
});

describe("renderExpr — Lit STR", () => {
  it("re-encodes string via JSON.stringify", () => {
    // syn emits unescaped string content in value
    expect(renderExpr(strLit("hello"))).toBe('"hello"');
  });

  it("handles string with special chars", () => {
    expect(renderExpr(strLit("a\nb"))).toBe('"a\\nb"');
  });
});

describe("renderExpr — Lit BOOL", () => {
  it('renders "true"', () => {
    expect(renderExpr(boolLit("true"))).toBe("true");
  });
  it('renders "false"', () => {
    expect(renderExpr(boolLit("false"))).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — BinaryExpr
// ---------------------------------------------------------------------------

describe("renderExpr — BinaryExpr", () => {
  it.each([
    ["+", "(a + b)"],
    ["-", "(a - b)"],
    ["*", "(a * b)"],
    ["/", "(a / b)"],
    ["%", "(a % b)"],
    ["==", "(a == b)"],
    ["!=", "(a != b)"],
    ["<", "(a < b)"],
    [">", "(a > b)"],
    ["<=", "(a <= b)"],
    [">=", "(a >= b)"],
    ["&&", "(a && b)"],
    ["||", "(a || b)"],
  ])("renders BinaryExpr %s", (op, expected) => {
    expect(renderExpr(binExpr(op, ident("a"), ident("b")))).toBe(expected);
  });

  it("always parenthesizes to avoid precedence surprises", () => {
    const expr = binExpr("+", ident("a"), binExpr("*", ident("b"), intLit("2")));
    expect(renderExpr(expr)).toBe("(a + (b * 2))");
  });

  it("throws RustUnsupportedConstructError for bitwise & (semantics differ Rust vs TS)", () => {
    expect(() => renderExpr(binExpr("&", ident("a"), intLit("1")))).toThrow(
      RustUnsupportedConstructError,
    );
    expect(() => renderExpr(binExpr("&", ident("a"), intLit("1")))).toThrow(CannotRaiseToIRError);
  });

  it("throws for bitwise | (excluded: semantics differ)", () => {
    expect(() => renderExpr(binExpr("|", ident("a"), intLit("1")))).toThrow(
      RustUnsupportedConstructError,
    );
  });
});

// ---------------------------------------------------------------------------
// renderExpr — UnaryExpr
// ---------------------------------------------------------------------------

describe("renderExpr — UnaryExpr", () => {
  it("renders negation -x", () => {
    const expr: RustAstExpr = { type: "UnaryExpr", line: 1, col: 1, op: "-", x: ident("x") };
    expect(renderExpr(expr)).toBe("-x");
  });

  it("renders logical not !x", () => {
    const expr: RustAstExpr = { type: "UnaryExpr", line: 1, col: 1, op: "!", x: ident("ok") };
    expect(renderExpr(expr)).toBe("!ok");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — CallExpr
// ---------------------------------------------------------------------------

describe("renderExpr — CallExpr", () => {
  it("renders a bare function call with no args", () => {
    const expr: RustAstExpr = {
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: ident("foo"),
      args: [],
    };
    expect(renderExpr(expr)).toBe("foo()");
  });

  it("renders a call with args", () => {
    const expr: RustAstExpr = {
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: ident("add"),
      args: [ident("x"), intLit("1")],
    };
    expect(renderExpr(expr)).toBe("add(x, 1)");
  });

  it("normalizes snake_case function name via Ident", () => {
    const expr: RustAstExpr = {
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: ident("compute_sum"),
      args: [ident("a"), ident("b")],
    };
    expect(renderExpr(expr)).toBe("computeSum(a, b)");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — MethodCallExpr
// ---------------------------------------------------------------------------

describe("renderExpr — MethodCallExpr", () => {
  it("renders receiver.method(args)", () => {
    const expr: RustAstExpr = {
      type: "MethodCallExpr",
      line: 1,
      col: 1,
      receiver: ident("s"),
      method: "len",
      args: [],
    };
    expect(renderExpr(expr)).toBe("s.len()");
  });

  it("renders with args", () => {
    const expr: RustAstExpr = {
      type: "MethodCallExpr",
      line: 1,
      col: 1,
      receiver: ident("vec"),
      method: "push",
      args: [intLit("1")],
    };
    expect(renderExpr(expr)).toBe("vec.push(1)");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — FieldExpr
// ---------------------------------------------------------------------------

describe("renderExpr — FieldExpr", () => {
  it("renders x.field", () => {
    const expr: RustAstExpr = {
      type: "FieldExpr",
      line: 1,
      col: 1,
      x: ident("point"),
      field: "x",
    };
    expect(renderExpr(expr)).toBe("point.x");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — IndexExpr
// ---------------------------------------------------------------------------

describe("renderExpr — IndexExpr", () => {
  it("renders x[index]", () => {
    const expr: RustAstExpr = {
      type: "IndexExpr",
      line: 1,
      col: 1,
      x: ident("arr"),
      index: intLit("0"),
    };
    expect(renderExpr(expr)).toBe("arr[0]");
  });

  it("normalizes snake_case identifier in index", () => {
    const expr: RustAstExpr = {
      type: "IndexExpr",
      line: 1,
      col: 1,
      x: ident("my_arr"),
      index: ident("idx"),
    };
    expect(renderExpr(expr)).toBe("myArr[idx]");
  });
});

// ---------------------------------------------------------------------------
// renderExpr — UnsupportedExpr
// ---------------------------------------------------------------------------

describe("renderExpr — UnsupportedExpr", () => {
  it("throws RustUnsupportedConstructError, instanceof CannotRaiseToIRError", () => {
    const expr: RustAstExpr = {
      type: "UnsupportedExpr",
      line: 5,
      col: 2,
      reason: "Expr::Match",
    };
    expect(() => renderExpr(expr, FILE)).toThrow(RustUnsupportedConstructError);
    try {
      renderExpr(expr, FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toBe("Expr::Match");
      expect((err as CannotRaiseToIRError).location).toMatchObject({ file: FILE, line: 5, col: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// renderStmt — LetStmt
// ---------------------------------------------------------------------------

describe("renderStmt — LetStmt", () => {
  it("renders let binding as const declaration", () => {
    expect(renderStmt(letStmt("x", intLit("42")))).toBe("  const x = 42;");
  });

  it("normalizes snake_case name to camelCase", () => {
    expect(renderStmt(letStmt("min_val", intLit("0")))).toBe("  const minVal = 0;");
  });

  it("honors custom indent", () => {
    expect(renderStmt(letStmt("n", intLit("1")), "    ")).toBe("    const n = 1;");
  });

  it("throws for uninitialized let (null value)", () => {
    const stmt: RustAstStmt = { type: "LetStmt", line: 1, col: 1, name: "x", value: null };
    expect(() => renderStmt(stmt)).toThrow(RustUnsupportedConstructError);
    expect(() => renderStmt(stmt)).toThrow(CannotRaiseToIRError);
  });
});

// ---------------------------------------------------------------------------
// renderStmt — ExprStmt (tail vs non-tail)
// ---------------------------------------------------------------------------

describe("renderStmt — ExprStmt non-tail", () => {
  it("renders as expression statement (no return)", () => {
    const stmt = exprStmt({
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: ident("log"),
      args: [ident("msg")],
    });
    expect(renderStmt(stmt)).toBe("  log(msg);");
  });
});

describe("renderStmt — ExprStmt tail (implicit return)", () => {
  it("renders simple tail expr as return statement", () => {
    expect(renderStmt(tailExprStmt(binExpr("+", ident("a"), ident("b"))))).toBe(
      "  return (a + b);",
    );
  });

  it("renders tail Ident as return ident", () => {
    expect(renderStmt(tailExprStmt(ident("x")))).toBe("  return x;");
  });

  it("renders tail literal as return literal", () => {
    expect(renderStmt(tailExprStmt(intLit("0")))).toBe("  return 0;");
  });
});

// ---------------------------------------------------------------------------
// renderStmt — ReturnStmt (explicit return)
// ---------------------------------------------------------------------------

describe("renderStmt — ReturnStmt", () => {
  it("renders bare return (null value)", () => {
    expect(renderStmt(returnStmt(null))).toBe("  return;");
  });

  it("renders return with expression", () => {
    expect(renderStmt(returnStmt(binExpr("+", ident("x"), ident("y"))))).toBe("  return (x + y);");
  });

  it("honors custom indent", () => {
    expect(renderStmt(returnStmt(intLit("0")), "    ")).toBe("    return 0;");
  });
});

// ---------------------------------------------------------------------------
// renderStmt — UnsupportedStmt
// ---------------------------------------------------------------------------

describe("renderStmt — UnsupportedStmt", () => {
  it("throws RustUnsupportedConstructError, instanceof CannotRaiseToIRError", () => {
    const stmt: RustAstStmt = {
      type: "UnsupportedStmt",
      line: 3,
      col: 1,
      reason: "Stmt::Item",
    };
    expect(() => renderStmt(stmt, "  ", FILE)).toThrow(RustUnsupportedConstructError);
    try {
      renderStmt(stmt, "  ", FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toBe("Stmt::Item");
      expect((err as CannotRaiseToIRError).location).toMatchObject({ file: FILE, line: 3, col: 1 });
    }
  });
});

// ---------------------------------------------------------------------------
// renderStmt — ExprStmt with IfExpr tail (implicit return in branches)
// ---------------------------------------------------------------------------

describe("renderStmt — ExprStmt tail IfExpr (Rust if/else as expression)", () => {
  function makeIfExpr(over: Partial<RustAstIfExpr> = {}): RustAstIfExpr {
    const base: RustAstIfExpr = {
      type: "IfExpr",
      line: 1,
      col: 1,
      cond: binExpr(">", ident("x"), intLit("0")),
      thenBranch: { stmts: [tailExprStmt(ident("x"))] },
      orelse: {
        type: "BlockNode",
        body: { stmts: [tailExprStmt(intLit("0"))] },
      },
      ...over,
    };
    return base;
  }

  it("injects return into then-branch tail and else-branch tail", () => {
    const stmt = tailExprStmt(makeIfExpr());
    const result = renderStmt(stmt);
    expect(result).toContain("if ((x > 0)) {");
    expect(result).toContain("return x;");
    expect(result).toContain("} else {");
    expect(result).toContain("return 0;");
  });

  it("renders if without else (no return injected in else)", () => {
    const stmt = tailExprStmt(makeIfExpr({ orelse: null }));
    const result = renderStmt(stmt);
    expect(result).toContain("if ((x > 0)) {");
    expect(result).toContain("return x;");
    expect(result).not.toContain("else");
  });

  it("renders if-else-if chain with returns in all leaf branches", () => {
    const innerIf: RustAstIfExpr = {
      type: "IfExpr",
      line: 2,
      col: 1,
      cond: binExpr("<", ident("x"), intLit("0")),
      thenBranch: {
        stmts: [tailExprStmt({ type: "UnaryExpr", line: 1, col: 1, op: "-", x: ident("x") })],
      },
      orelse: {
        type: "BlockNode",
        body: { stmts: [tailExprStmt(intLit("0"))] },
      },
    };
    const stmt = tailExprStmt(makeIfExpr({ orelse: innerIf }));
    const result = renderStmt(stmt);
    expect(result).toContain("} else if ((x < 0)) {");
    expect(result).toContain("return -x;");
    expect(result).toContain("return 0;");
  });
});

// ---------------------------------------------------------------------------
// renderBody
// ---------------------------------------------------------------------------

describe("renderBody", () => {
  it("renders empty body as void 0;", () => {
    expect(renderBody({ stmts: [] })).toBe("  void 0;");
  });

  it("joins multiple statements with newline", () => {
    const b = body([letStmt("x", intLit("1")), returnStmt(ident("x"))]);
    expect(renderBody(b)).toBe("  const x = 1;\n  return x;");
  });

  it("renders tail ExprStmt as return", () => {
    const b = body([tailExprStmt(binExpr("+", ident("a"), ident("b")))]);
    expect(renderBody(b)).toBe("  return (a + b);");
  });

  it("renders a ReturnStmt directly", () => {
    const b = body([returnStmt(ident("result"))]);
    expect(renderBody(b)).toBe("  return result;");
  });
});

// ---------------------------------------------------------------------------
// Compound round-trip tests (production sequence)
//
// These exercise the real production sequence end-to-end across multiple
// internal components, crossing LetStmt + ExprStmt + ReturnStmt + BinaryExpr
// + IfExpr boundaries in one body.  This is the compound-interaction test
// required by the dispatch instructions.
// ---------------------------------------------------------------------------

describe("renderBody — compound round-trips (production sequence)", () => {
  it("add body: tail BinaryExpr ExprStmt -> return (a + b)", () => {
    // Simulates: fn add(a: i32, b: i32) -> i32 { a + b }
    // Wire: ExprStmt(isTail=true, x=BinaryExpr(+, Ident(a), Ident(b)))
    const b: RustAstBodyNode = {
      stmts: [
        {
          type: "ExprStmt",
          line: 1,
          col: 1,
          x: {
            type: "BinaryExpr",
            line: 1,
            col: 1,
            op: "+",
            x: { type: "Ident", line: 1, col: 1, name: "a" },
            y: { type: "Ident", line: 1, col: 5, name: "b" },
          },
          isTail: true,
        },
      ],
    };
    expect(renderBody(b)).toBe("  return (a + b);");
  });

  it("let + return: fn square(x) { let result = x*x; result }", () => {
    // Simulates: fn square(x: i32) -> i32 { let result = x * x; result }
    const b: RustAstBodyNode = {
      stmts: [
        letStmt("result", binExpr("*", ident("x"), ident("x"))),
        tailExprStmt(ident("result")),
      ],
    };
    expect(renderBody(b)).toBe("  const result = (x * x);\n  return result;");
  });

  it("if-else tail expression: fn clamp(v, lo, hi) -> if v < lo { lo } else if v > hi { hi } else { v }", () => {
    // Simulates the clamp-i32 fixture body:
    //   if value < min_val { min_val } else if value > max_val { max_val } else { value }
    // This is the compound-interaction test crossing IfExpr + tail rendering + snake_case normalization.
    const ifExpr: RustAstIfExpr = {
      type: "IfExpr",
      line: 1,
      col: 1,
      cond: binExpr("<", ident("value"), ident("min_val")),
      thenBranch: { stmts: [tailExprStmt(ident("min_val"))] },
      orelse: {
        type: "IfExpr",
        line: 1,
        col: 35,
        cond: binExpr(">", ident("value"), ident("max_val")),
        thenBranch: { stmts: [tailExprStmt(ident("max_val"))] },
        orelse: {
          type: "BlockNode",
          body: { stmts: [tailExprStmt(ident("value"))] },
        },
      },
    };
    const b: RustAstBodyNode = { stmts: [tailExprStmt(ifExpr)] };
    const result = renderBody(b);
    // snake_case identifiers must be camelCase in output
    expect(result).toContain("minVal");
    expect(result).toContain("maxVal");
    // Structure must be correct
    expect(result).toContain("if ((value < minVal)) {");
    expect(result).toContain("return minVal;");
    expect(result).toContain("} else if ((value > maxVal)) {");
    expect(result).toContain("return maxVal;");
    expect(result).toContain("} else {");
    expect(result).toContain("return value;");
  });

  it("explicit return: fn abs(n: i32) -> i32 { if n < 0 { return -n; } n }", () => {
    // Two-stmt body: explicit ReturnStmt inside if, then tail ExprStmt
    const ifExpr: RustAstIfExpr = {
      type: "IfExpr",
      line: 1,
      col: 1,
      cond: binExpr("<", ident("n"), intLit("0")),
      thenBranch: {
        stmts: [returnStmt({ type: "UnaryExpr", line: 1, col: 1, op: "-", x: ident("n") })],
      },
      orelse: null,
    };
    const b: RustAstBodyNode = {
      stmts: [exprStmt(ifExpr), tailExprStmt(ident("n"))],
    };
    const result = renderBody(b);
    expect(result).toContain("if ((n < 0)) {");
    expect(result).toContain("return -n;");
    expect(result).toContain("return n;");
  });

  it("multi-stmt body: let + binary op + explicit return", () => {
    // fn is_even(n: i32) -> bool { let rem = n % 2; return rem == 0; }
    const b: RustAstBodyNode = {
      stmts: [
        letStmt("rem", binExpr("%", ident("n"), intLit("2"))),
        returnStmt(binExpr("==", ident("rem"), intLit("0"))),
      ],
    };
    const result = renderBody(b);
    expect(result).toBe("  const rem = (n % 2);\n  return (rem == 0);");
  });

  it("method call in tail expr: s.len() as return value", () => {
    // fn str_len(s: &str) -> usize { s.len() }
    const b: RustAstBodyNode = {
      stmts: [
        tailExprStmt({
          type: "MethodCallExpr",
          line: 1,
          col: 1,
          receiver: ident("s"),
          method: "len",
          args: [],
        }),
      ],
    };
    expect(renderBody(b)).toBe("  return s.len();");
  });

  it("index expression in return: arr[0]", () => {
    // fn first(arr: Vec<i32>) -> i32 { arr[0] }
    const b: RustAstBodyNode = {
      stmts: [
        tailExprStmt({
          type: "IndexExpr",
          line: 1,
          col: 1,
          x: ident("arr"),
          index: intLit("0"),
        }),
      ],
    };
    expect(renderBody(b)).toBe("  return arr[0];");
  });

  it("bool literal tail: fn always_true() -> bool { true }", () => {
    const b: RustAstBodyNode = {
      stmts: [tailExprStmt(boolLit("true"))],
    };
    expect(renderBody(b)).toBe("  return true;");
  });
});

// ---------------------------------------------------------------------------
// Taxonomy wiring tests (DEC-POLYGLOT-RUST-TAXONOMY-WIRED-001)
//
// Verify that UnsupportedExpr/UnsupportedStmt reason strings are routed to
// the named taxonomy classes rather than the generic RustUnsupportedConstructError.
// Each test uses the exact reason string emitted by rust-ast-parse/src/main.rs.
// ---------------------------------------------------------------------------

import {
  RustAsyncError,
  RustClosureCaptureError,
  RustRawPointerError,
  RustUnsafeError,
} from "./errors.js";

describe("taxonomy wiring — UnsupportedExpr reason → named error class", () => {
  function unsupportedExpr(reason: string): RustAstExpr {
    return { type: "UnsupportedExpr", reason, line: 5, col: 3 };
  }

  it("Expr::Unsafe → RustUnsafeError (instanceof CannotRaiseToIRError)", () => {
    const expr = unsupportedExpr("Expr::Unsafe (unsafe block)");
    expect(() => renderExpr(expr, FILE)).toThrow(RustUnsafeError);
    try {
      renderExpr(expr, FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
    }
  });

  it("Expr::Await → RustAsyncError", () => {
    expect(() => renderExpr(unsupportedExpr("Expr::Await (async/await)"), FILE)).toThrow(
      RustAsyncError,
    );
  });

  it("Expr::Async → RustAsyncError", () => {
    expect(() => renderExpr(unsupportedExpr("Expr::Async (async block)"), FILE)).toThrow(
      RustAsyncError,
    );
  });

  it("Expr::Closure → RustClosureCaptureError", () => {
    expect(() => renderExpr(unsupportedExpr("Expr::Closure (closure)"), FILE)).toThrow(
      RustClosureCaptureError,
    );
  });

  it("Expr::RawAddr → RustRawPointerError", () => {
    expect(() => renderExpr(unsupportedExpr("Expr::RawAddr"), FILE)).toThrow(RustRawPointerError);
  });

  it("Expr::Unary (Deref ...) → RustRawPointerError", () => {
    expect(() =>
      renderExpr(unsupportedExpr("Expr::Unary (Deref or unsupported op)"), FILE),
    ).toThrow(RustRawPointerError);
  });

  it("Expr::Match → RustUnsupportedConstructError (fallback)", () => {
    // Expr::Match is not in the named taxonomy — falls through to generic error.
    expect(() => renderExpr(unsupportedExpr("Expr::Match"), FILE)).toThrow(
      RustUnsupportedConstructError,
    );
  });

  it("Expr::Loop → RustUnsupportedConstructError (fallback)", () => {
    expect(() => renderExpr(unsupportedExpr("Expr::Loop"), FILE)).toThrow(
      RustUnsupportedConstructError,
    );
  });
});

describe("taxonomy wiring — UnsupportedStmt reason → named error class", () => {
  function unsupportedStmt(reason: string): RustAstStmt {
    return { type: "UnsupportedStmt", reason, line: 7, col: 1 };
  }

  it("Stmt::Item (unknown) → RustUnsupportedConstructError (fallback)", () => {
    expect(() => renderStmt(unsupportedStmt("Stmt::Item"), "  ", FILE)).toThrow(
      RustUnsupportedConstructError,
    );
  });

  it("Expr::Unsafe in stmt → RustUnsafeError", () => {
    // A stmt whose reason starts with Expr::Unsafe (possible when an unsafe block
    // appears as a statement-level expression).
    expect(() => renderStmt(unsupportedStmt("Expr::Unsafe (unsafe block)"), "  ", FILE)).toThrow(
      RustUnsafeError,
    );
  });
});
