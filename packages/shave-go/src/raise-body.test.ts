// SPDX-License-Identifier: MIT
//
// raise-body.test.ts — unit tests for raise-body.ts (WI-870 slice 2).
//
// Tests build wire body AST nodes directly (no subprocess).  They verify:
// - Expression rendering for each supported node type.
// - Statement rendering for return, expr, assign, decl.
// - Purity inference rejects goroutines, channel sends/recvs, select, defer.
// - UnsupportedStmt/Expr throws GoUnsupportedConstructError.
// - renderBody integrates purity check + rendering.

import { CannotRaiseToIRError } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  GoChanRecvError,
  GoChanSendError,
  GoDeferError,
  GoGoroutineError,
  GoSelectError,
  GoUnsupportedConstructError,
} from "./errors.js";
import type { GoAstBodyNode, GoAstExpr, GoAstStmt } from "./go-ast-parser.js";
import { checkBodyPurity, renderBody, renderExpr, renderStmt } from "./raise-body.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FILE = "stdin.go";

function ident(name: string, line = 1, col = 1): GoAstExpr {
  return { type: "Ident", line, col, name };
}
function intLit(value: string, line = 1, col = 1): GoAstExpr {
  return { type: "BasicLit", line, col, kind: "INT", value };
}
function floatLit(value: string): GoAstExpr {
  return { type: "BasicLit", line: 1, col: 1, kind: "FLOAT", value };
}
function strLit(value: string): GoAstExpr {
  return { type: "BasicLit", line: 1, col: 1, kind: "STRING", value };
}
function binExpr(op: string, x: GoAstExpr, y: GoAstExpr): GoAstExpr {
  return { type: "BinaryExpr", line: 1, col: 1, op, x, y };
}
function body(stmts: GoAstStmt[]): GoAstBodyNode {
  return { stmts };
}
function returnStmt(results: GoAstExpr[]): GoAstStmt {
  return { type: "ReturnStmt", line: 1, col: 1, results };
}

// ---------------------------------------------------------------------------
// renderExpr — primitives
// ---------------------------------------------------------------------------

describe("renderExpr — Ident", () => {
  it("returns the identifier name", () => {
    expect(renderExpr(ident("x"))).toBe("x");
  });
});

describe("renderExpr — BasicLit", () => {
  it("renders INT literal verbatim", () => {
    expect(renderExpr(intLit("42"))).toBe("42");
    expect(renderExpr(intLit("9007199254740993"))).toBe("9007199254740993");
  });
  it("renders FLOAT literal verbatim", () => {
    expect(renderExpr(floatLit("3.14"))).toBe("3.14");
  });
  it("renders STRING with JSON.stringify quoting", () => {
    expect(renderExpr(strLit('"hello"'))).toBe('"hello"');
  });
  it("renders backtick STRING", () => {
    expect(
      renderExpr({ type: "BasicLit", line: 1, col: 1, kind: "STRING", value: "`world`" }),
    ).toBe('"world"');
  });
  it("throws GoUnsupportedConstructError for unknown kind", () => {
    expect(() =>
      renderExpr({ type: "BasicLit", line: 1, col: 1, kind: "IMAG", value: "3i" }),
    ).toThrow(GoUnsupportedConstructError);
  });
});

describe("renderExpr — BinaryExpr", () => {
  it.each([
    ["+", "x", "y", "(x + y)"],
    ["-", "x", "y", "(x - y)"],
    ["*", "a", "b", "(a * b)"],
    ["/", "a", "b", "(a / b)"],
    ["%", "a", "b", "(a % b)"],
    ["==", "a", "b", "(a == b)"],
    ["!=", "a", "b", "(a != b)"],
    ["<", "a", "b", "(a < b)"],
    [">", "a", "b", "(a > b)"],
    ["<=", "a", "b", "(a <= b)"],
    [">=", "a", "b", "(a >= b)"],
    ["&&", "a", "b", "(a && b)"],
    ["||", "a", "b", "(a || b)"],
  ])("renders BinaryExpr %s", (op, lName, rName, expected) => {
    expect(renderExpr(binExpr(op, ident(lName), ident(rName)))).toBe(expected);
  });

  it("recurses into nested expressions", () => {
    const expr = binExpr("+", ident("a"), binExpr("*", ident("b"), intLit("2")));
    expect(renderExpr(expr)).toBe("(a + (b * 2))");
  });

  it("throws for unsupported operator", () => {
    expect(() => renderExpr(binExpr("<<", ident("a"), intLit("1")))).toThrow(
      GoUnsupportedConstructError,
    );
  });
});

describe("renderExpr — UnaryExpr", () => {
  it("renders negation", () => {
    expect(renderExpr({ type: "UnaryExpr", line: 1, col: 1, op: "-", x: ident("x") })).toBe("-x");
  });
  it("renders logical not", () => {
    expect(renderExpr({ type: "UnaryExpr", line: 1, col: 1, op: "!", x: ident("ok") })).toBe("!ok");
  });
  it("renders Go bitwise-NOT ^ as TS ~", () => {
    expect(renderExpr({ type: "UnaryExpr", line: 1, col: 1, op: "^", x: ident("n") })).toBe("~n");
  });
  it("throws for unsupported unary op", () => {
    expect(() =>
      renderExpr({ type: "UnaryExpr", line: 1, col: 1, op: "&", x: ident("x") }),
    ).toThrow(GoUnsupportedConstructError);
  });
});

describe("renderExpr — CallExpr", () => {
  it("renders a bare function call", () => {
    const expr: GoAstExpr = {
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: ident("foo"),
      args: [ident("x"), intLit("1")],
    };
    expect(renderExpr(expr)).toBe("foo(x, 1)");
  });
  it("renders a method call via SelectorExpr", () => {
    const expr: GoAstExpr = {
      type: "CallExpr",
      line: 1,
      col: 1,
      fun: { type: "SelectorExpr", line: 1, col: 1, x: ident("s"), sel: "Len" },
      args: [],
    };
    expect(renderExpr(expr)).toBe("s.Len()");
  });
});

describe("renderExpr — SelectorExpr", () => {
  it("renders x.sel", () => {
    const expr: GoAstExpr = { type: "SelectorExpr", line: 1, col: 1, x: ident("pkg"), sel: "Fn" };
    expect(renderExpr(expr)).toBe("pkg.Fn");
  });
});

describe("renderExpr — IndexExpr", () => {
  it("renders x[index]", () => {
    const expr: GoAstExpr = {
      type: "IndexExpr",
      line: 1,
      col: 1,
      x: ident("arr"),
      index: intLit("0"),
    };
    expect(renderExpr(expr)).toBe("arr[0]");
  });
});

describe("renderExpr — ChanRecv (BANNED)", () => {
  it("throws GoChanRecvError, instanceof CannotRaiseToIRError", () => {
    const expr: GoAstExpr = { type: "ChanRecv", line: 3, col: 7 };
    expect(() => renderExpr(expr, FILE)).toThrow(GoChanRecvError);
    try {
      renderExpr(expr, FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toContain("chan recv");
      expect((err as CannotRaiseToIRError).location).toMatchObject({ file: FILE, line: 3, col: 7 });
    }
  });
});

describe("renderExpr — UnsupportedExpr", () => {
  it("throws GoUnsupportedConstructError", () => {
    const expr: GoAstExpr = {
      type: "UnsupportedExpr",
      line: 5,
      col: 2,
      reason: "*ast.CompositeLit",
    };
    expect(() => renderExpr(expr, FILE)).toThrow(GoUnsupportedConstructError);
    try {
      renderExpr(expr, FILE);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toBe("*ast.CompositeLit");
    }
  });
});

// ---------------------------------------------------------------------------
// renderStmt
// ---------------------------------------------------------------------------

describe("renderStmt — ReturnStmt", () => {
  it("renders bare return", () => {
    expect(renderStmt(returnStmt([]))).toBe("  return;");
  });
  it("renders return with single expression", () => {
    expect(renderStmt(returnStmt([ident("x")]))).toBe("  return x;");
  });
  it("renders return with binop expression", () => {
    const stmt = returnStmt([binExpr("+", ident("x"), ident("y"))]);
    expect(renderStmt(stmt)).toBe("  return (x + y);");
  });
  it("renders multi-value return as tuple array", () => {
    const stmt = returnStmt([intLit("1"), intLit("2")]);
    expect(renderStmt(stmt)).toBe("  return [1, 2];");
  });
  it("honors custom indent", () => {
    expect(renderStmt(returnStmt([intLit("0")]), "    ")).toBe("    return 0;");
  });
});

describe("renderStmt — ExprStmt", () => {
  it("renders a call expression statement", () => {
    const stmt: GoAstStmt = {
      type: "ExprStmt",
      line: 1,
      col: 1,
      x: { type: "CallExpr", line: 1, col: 1, fun: ident("log"), args: [ident("msg")] },
    };
    expect(renderStmt(stmt)).toBe("  log(msg);");
  });
});

describe("renderStmt — AssignStmt", () => {
  it("renders := as const declaration", () => {
    const stmt: GoAstStmt = {
      type: "AssignStmt",
      line: 2,
      col: 3,
      lhs: [ident("x")],
      rhs: [intLit("42")],
      tok: ":=",
    };
    expect(renderStmt(stmt)).toBe("  const x = 42;");
  });
  it("renders = as assignment", () => {
    const stmt: GoAstStmt = {
      type: "AssignStmt",
      line: 2,
      col: 3,
      lhs: [ident("x")],
      rhs: [intLit("0")],
      tok: "=",
    };
    expect(renderStmt(stmt)).toBe("  x = 0;");
  });
  it("throws for multi-lhs assign", () => {
    const stmt: GoAstStmt = {
      type: "AssignStmt",
      line: 2,
      col: 3,
      lhs: [ident("a"), ident("b")],
      rhs: [intLit("1"), intLit("2")],
      tok: ":=",
    };
    expect(() => renderStmt(stmt)).toThrow(GoUnsupportedConstructError);
  });
});

describe("renderStmt — DeclStmt", () => {
  it("renders var decl as const", () => {
    const stmt: GoAstStmt = {
      type: "DeclStmt",
      line: 1,
      col: 1,
      decl: { type: "ValueSpec", names: ["n"], values: [intLit("10")] },
    };
    expect(renderStmt(stmt)).toBe("  const n = 10;");
  });
  it("throws for UnsupportedDecl", () => {
    const stmt: GoAstStmt = {
      type: "DeclStmt",
      line: 1,
      col: 1,
      decl: { type: "UnsupportedDecl", reason: "*ast.FuncDecl" },
    };
    expect(() => renderStmt(stmt)).toThrow(GoUnsupportedConstructError);
  });
});

// ---------------------------------------------------------------------------
// Purity inference — one assertion per banned construct class
// ---------------------------------------------------------------------------

describe("checkBodyPurity — banned constructs (purity rejection)", () => {
  it("rejects GoStmt (goroutine) — instanceof GoGoroutineError", () => {
    const b = body([{ type: "GoStmt", line: 5, col: 3 }]);
    expect(() => checkBodyPurity(b)).toThrow(GoGoroutineError);
    try {
      checkBodyPurity(b);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toContain("goroutine");
      expect((err as CannotRaiseToIRError).location).toMatchObject({ line: 5, col: 3 });
    }
  });

  it("rejects SendStmt (channel send) — instanceof GoChanSendError", () => {
    const b = body([{ type: "SendStmt", line: 7, col: 2 }]);
    expect(() => checkBodyPurity(b)).toThrow(GoChanSendError);
    try {
      checkBodyPurity(b);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toContain("chan send");
    }
  });

  it("rejects ChanRecv in expression (channel recv) — instanceof GoChanRecvError", () => {
    const b = body([returnStmt([{ type: "ChanRecv", line: 2, col: 10 }])]);
    expect(() => checkBodyPurity(b)).toThrow(GoChanRecvError);
    try {
      checkBodyPurity(b);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toContain("chan recv");
    }
  });

  it("rejects SelectStmt — instanceof GoSelectError", () => {
    const b = body([{ type: "SelectStmt", line: 9, col: 1 }]);
    expect(() => checkBodyPurity(b)).toThrow(GoSelectError);
    try {
      checkBodyPurity(b);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toBe("select");
    }
  });

  it("rejects DeferStmt — instanceof GoDeferError", () => {
    const b = body([{ type: "DeferStmt", line: 4, col: 2 }]);
    expect(() => checkBodyPurity(b)).toThrow(GoDeferError);
    try {
      checkBodyPurity(b);
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect((err as CannotRaiseToIRError).construct).toBe("defer");
    }
  });

  it("passes a pure body with return + binop", () => {
    const b = body([returnStmt([binExpr("+", ident("a"), ident("b"))])]);
    expect(() => checkBodyPurity(b)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderBody — integration
// ---------------------------------------------------------------------------

describe("renderBody", () => {
  it("renders empty body as void 0;", () => {
    expect(renderBody({ stmts: [] })).toBe("  void 0;");
  });

  it("joins multiple statements with newline", () => {
    const b = body([
      { type: "AssignStmt", line: 1, col: 1, lhs: [ident("x")], rhs: [intLit("1")], tok: ":=" },
      returnStmt([ident("x")]),
    ]);
    expect(renderBody(b)).toBe("  const x = 1;\n  return x;");
  });

  it("aborts with GoGoroutineError before rendering if goroutine found", () => {
    const b = body([returnStmt([intLit("0")]), { type: "GoStmt", line: 2, col: 1 }]);
    expect(() => renderBody(b)).toThrow(GoGoroutineError);
  });

  it("round-trip: pure Go add body -> TS IR text", () => {
    // Simulates: func Add(a, b int) int { return a + b }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "ReturnStmt",
          line: 1,
          col: 2,
          results: [
            {
              type: "BinaryExpr",
              line: 1,
              col: 9,
              op: "+",
              x: { type: "Ident", line: 1, col: 9, name: "a" },
              y: { type: "Ident", line: 1, col: 13, name: "b" },
            },
          ],
        },
      ],
    };
    expect(renderBody(b)).toBe("  return (a + b);");
  });
});
