// SPDX-License-Identifier: MIT
//
// raise-body.test.ts — unit tests for raise-body.ts (WI-870 slice 2, WI-964).
//
// Tests build wire body AST nodes directly (no subprocess).  They verify:
// - Expression rendering for each supported node type.
// - Statement rendering for return, expr, assign, decl.
// - Purity inference rejects goroutines, channel sends/recvs, select, defer.
// - UnsupportedStmt/Expr throws GoUnsupportedConstructError.
// - renderBody integrates purity check + rendering.
//
// WI-964 additions:
// - BinaryExpr >> and << render correctly (now in ALLOWED_BINARY_OPS).
// - IfStmt: simple, if-init, else, else-if chain.
// - ForStmt: classic C-style for with init/cond/post.
// - RangeStmt: key+value, key-only, value-only.
// - SwitchStmt: with tag, tagless, multi-value case, default clause.
// - DeclStmt multi-name: var a, b = x, y splits into two consts.
// - Purity walk descends into control-flow bodies to detect banned constructs.

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
import type {
  GoAstBodyNode,
  GoAstCaseClause,
  GoAstExpr,
  GoAstForStmt,
  GoAstIfStmt,
  GoAstIncDecStmt,
  GoAstMapEntry,
  GoAstMapLitExpr,
  GoAstRangeStmt,
  GoAstSliceLitExpr,
  GoAstStmt,
  GoAstSwitchStmt,
} from "./go-ast-parser.js";
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
    // WI-964: bitshift operators now supported
    [">>", "x", "1", "(x >> 1)"],
    ["<<", "x", "2", "(x << 2)"],
  ])("renders BinaryExpr %s", (op, lName, rName, expected) => {
    expect(renderExpr(binExpr(op, ident(lName), ident(rName)))).toBe(expected);
  });

  it("recurses into nested expressions", () => {
    const expr = binExpr("+", ident("a"), binExpr("*", ident("b"), intLit("2")));
    expect(renderExpr(expr)).toBe("(a + (b * 2))");
  });

  it("throws for unsupported operator (e.g. Go & bitwise-AND)", () => {
    // & (bitwise-AND) is not in ALLOWED_BINARY_OPS — differs between Go (int)
    // and TS (coerced) in a way that could silently change semantics.
    expect(() => renderExpr(binExpr("&", ident("a"), intLit("1")))).toThrow(
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

// ---------------------------------------------------------------------------
// WI-964: IfStmt rendering
// ---------------------------------------------------------------------------

describe("renderStmt — IfStmt (WI-964)", () => {
  function makeIfStmt(over: Partial<GoAstIfStmt>): GoAstStmt {
    const base: GoAstIfStmt = {
      type: "IfStmt",
      line: 1,
      col: 1,
      init: null,
      cond: binExpr(">", ident("x"), intLit("0")),
      body: { stmts: [returnStmt([ident("x")])] },
      orelse: null,
      ...over,
    };
    return base;
  }

  it("renders simple if with no else", () => {
    const result = renderStmt(makeIfStmt({}));
    expect(result).toBe("  if ((x > 0)) {\n    return x;\n  }");
  });

  it("renders if-else with a plain else block", () => {
    const stmt = makeIfStmt({
      orelse: {
        type: "BlockNode",
        body: { stmts: [returnStmt([intLit("0")])] },
      },
    });
    const result = renderStmt(stmt);
    expect(result).toBe("  if ((x > 0)) {\n    return x;\n  } else {\n    return 0;\n  }");
  });

  it("renders if-else-if chain (recursive orelse=IfStmt)", () => {
    const innerIf: GoAstIfStmt = {
      type: "IfStmt",
      line: 2,
      col: 1,
      init: null,
      cond: binExpr("<", ident("x"), intLit("0")),
      body: { stmts: [returnStmt([intLit("-1")])] },
      orelse: null,
    };
    const stmt = makeIfStmt({ orelse: innerIf });
    const result = renderStmt(stmt);
    expect(result).toBe(
      "  if ((x > 0)) {\n    return x;\n  } else if ((x < 0)) {\n    return -1;\n  }",
    );
  });

  it("renders if with init statement (if x := f(); x > 0)", () => {
    const initStmt: GoAstStmt = {
      type: "AssignStmt",
      line: 1,
      col: 5,
      lhs: [ident("v")],
      rhs: [{ type: "CallExpr", line: 1, col: 9, fun: ident("compute"), args: [] }],
      tok: ":=",
    };
    const stmt = makeIfStmt({ init: initStmt });
    const result = renderStmt(stmt);
    expect(result).toContain("const v = compute();");
    expect(result).toContain("if ((x > 0))");
  });

  it("renders empty if body as void 0;", () => {
    const stmt = makeIfStmt({ body: { stmts: [] } });
    const result = renderStmt(stmt);
    expect(result).toContain("void 0;");
  });
});

// ---------------------------------------------------------------------------
// WI-964: ForStmt rendering
// ---------------------------------------------------------------------------

describe("renderStmt — ForStmt (WI-964)", () => {
  function makeForStmt(over: Partial<GoAstForStmt>): GoAstStmt {
    const base: GoAstForStmt = {
      type: "ForStmt",
      line: 1,
      col: 1,
      init: {
        type: "AssignStmt",
        line: 1,
        col: 5,
        lhs: [ident("i")],
        rhs: [intLit("0")],
        tok: ":=",
      },
      cond: binExpr("<", ident("i"), ident("n")),
      post: {
        type: "ExprStmt",
        line: 1,
        col: 20,
        x: { type: "CallExpr", line: 1, col: 20, fun: ident("inc"), args: [ident("i")] },
      },
      body: { stmts: [returnStmt([ident("i")])] },
      ...over,
    };
    return base;
  }

  it("renders classic for loop with init/cond/post", () => {
    const result = renderStmt(makeForStmt({}));
    expect(result).toBe("  for (let i = 0; (i < n); inc(i)) {\n    return i;\n  }");
  });

  it("renders infinite for loop (no init/cond/post)", () => {
    const result = renderStmt(makeForStmt({ init: null, cond: null, post: null }));
    expect(result).toBe("  for (; ; ) {\n    return i;\n  }");
  });

  it("renders for with cond only (while-style)", () => {
    const result = renderStmt(makeForStmt({ init: null, post: null }));
    expect(result).toBe("  for (; (i < n); ) {\n    return i;\n  }");
  });
});

// ---------------------------------------------------------------------------
// WI-964: RangeStmt rendering
// ---------------------------------------------------------------------------

describe("renderStmt — RangeStmt (WI-964)", () => {
  function makeRangeStmt(over: Partial<GoAstRangeStmt>): GoAstStmt {
    const base: GoAstRangeStmt = {
      type: "RangeStmt",
      line: 1,
      col: 1,
      key: "k",
      value: "v",
      tok: ":=",
      x: ident("items"),
      body: { stmts: [returnStmt([ident("v")])] },
      ...over,
    };
    return base;
  }

  it("renders key+value range as for..of Object.entries()", () => {
    const result = renderStmt(makeRangeStmt({}));
    expect(result).toBe("  for (const [k, v] of Object.entries(items)) {\n    return v;\n  }");
  });

  it("renders key-only range as for..in (ForInStatement, #975 round-trip fidelity)", () => {
    const result = renderStmt(makeRangeStmt({ value: null }));
    // #975: key-only range uses for...in (TS ForInStatement) so compile-go can
    // emit `for k := range x` without adding a spurious blank `_` prefix.
    expect(result).toBe("  for (const k in items) {\n    return v;\n  }");
  });

  it("renders value-only range (blank key) as for..of Object.values()", () => {
    const result = renderStmt(makeRangeStmt({ key: null }));
    expect(result).toBe("  for (const v of Object.values(items)) {\n    return v;\n  }");
  });

  it("renders blank-blank range as for..of Object.values() with _entry", () => {
    const result = renderStmt(makeRangeStmt({ key: null, value: null }));
    expect(result).toBe("  for (const _entry of Object.values(items)) {\n    return v;\n  }");
  });
});

// ---------------------------------------------------------------------------
// WI-964: SwitchStmt rendering
// ---------------------------------------------------------------------------

describe("renderStmt — SwitchStmt (WI-964)", () => {
  function makeCase(exprs: GoAstExpr[], bodyStmts: GoAstStmt[]): GoAstCaseClause {
    return { type: "CaseClause", list: exprs, body: { stmts: bodyStmts } };
  }

  function makeSwitchStmt(over: Partial<GoAstSwitchStmt>): GoAstStmt {
    const base: GoAstSwitchStmt = {
      type: "SwitchStmt",
      line: 1,
      col: 1,
      init: null,
      tag: ident("x"),
      cases: [
        makeCase([intLit("1")], [returnStmt([ident("one")])]),
        makeCase([intLit("2")], [returnStmt([ident("two")])]),
        makeCase([], [returnStmt([ident("other")])]), // default
      ],
      ...over,
    };
    return base;
  }

  it("renders switch with tag and multiple cases + default", () => {
    const result = renderStmt(makeSwitchStmt({}));
    expect(result).toContain("switch (x) {");
    expect(result).toContain("case 1:");
    expect(result).toContain("case 2:");
    expect(result).toContain("default:");
    expect(result).toContain("break;");
  });

  it("renders tagless switch as switch (true)", () => {
    const result = renderStmt(makeSwitchStmt({ tag: null }));
    expect(result).toContain("switch (true) {");
  });

  it("renders multi-value case as sequential case labels", () => {
    const stmt = makeSwitchStmt({
      cases: [makeCase([intLit("1"), intLit("2")], [returnStmt([ident("low")])])],
    });
    const result = renderStmt(stmt);
    expect(result).toContain("case 1:");
    expect(result).toContain("case 2:");
    expect(result).toContain("return low;");
    expect(result).toContain("break;");
  });

  it("renders empty switch body", () => {
    const result = renderStmt(makeSwitchStmt({ cases: [] }));
    expect(result).toBe("  switch (x) {\n  }");
  });
});

// ---------------------------------------------------------------------------
// WI-964: multi-name ValueSpec rendering
// ---------------------------------------------------------------------------

describe("renderStmt — DeclStmt multi-name ValueSpec (WI-964)", () => {
  it("renders var a, b = 1, 2 as two sequential const declarations", () => {
    const stmt: GoAstStmt = {
      type: "DeclStmt",
      line: 1,
      col: 1,
      decl: {
        type: "ValueSpec",
        names: ["a", "b"],
        values: [intLit("1"), intLit("2")],
      },
    };
    const result = renderStmt(stmt);
    expect(result).toBe("  const a = 1;\n  const b = 2;");
  });

  it("throws when names.length !== values.length", () => {
    const stmt: GoAstStmt = {
      type: "DeclStmt",
      line: 1,
      col: 1,
      decl: {
        type: "ValueSpec",
        names: ["a", "b"],
        values: [intLit("1")],
      },
    };
    expect(() => renderStmt(stmt)).toThrow(GoUnsupportedConstructError);
  });
});

// ---------------------------------------------------------------------------
// WI-964: Purity walk descends into control-flow nodes
// ---------------------------------------------------------------------------

describe("checkBodyPurity — purity walk inside control-flow bodies (WI-964)", () => {
  it("rejects GoStmt inside an IfStmt body", () => {
    const b = body([
      {
        type: "IfStmt",
        line: 1,
        col: 1,
        init: null,
        cond: binExpr(">", ident("x"), intLit("0")),
        body: { stmts: [{ type: "GoStmt", line: 2, col: 5 }] },
        orelse: null,
      } satisfies GoAstIfStmt,
    ]);
    expect(() => checkBodyPurity(b)).toThrow(GoGoroutineError);
  });

  it("rejects DeferStmt inside a ForStmt body", () => {
    const forStmt: GoAstForStmt = {
      type: "ForStmt",
      line: 1,
      col: 1,
      init: null,
      cond: null,
      post: null,
      body: { stmts: [{ type: "DeferStmt", line: 2, col: 5 }] },
    };
    expect(() => checkBodyPurity(body([forStmt]))).toThrow(GoDeferError);
  });

  it("rejects ChanRecv inside a RangeStmt body", () => {
    const rangeStmt: GoAstRangeStmt = {
      type: "RangeStmt",
      line: 1,
      col: 1,
      key: "k",
      value: "v",
      tok: ":=",
      x: ident("ch"),
      body: {
        stmts: [returnStmt([{ type: "ChanRecv", line: 2, col: 5 }])],
      },
    };
    expect(() => checkBodyPurity(body([rangeStmt]))).toThrow(GoChanRecvError);
  });

  it("rejects SendStmt inside a SwitchStmt case body", () => {
    const switchStmt: GoAstSwitchStmt = {
      type: "SwitchStmt",
      line: 1,
      col: 1,
      init: null,
      tag: ident("x"),
      cases: [
        {
          type: "CaseClause",
          list: [intLit("1")],
          body: { stmts: [{ type: "SendStmt", line: 2, col: 5 }] },
        },
      ],
    };
    expect(() => checkBodyPurity(body([switchStmt]))).toThrow(GoChanSendError);
  });

  it("accepts a pure IfStmt body (no banned constructs)", () => {
    const b = body([
      {
        type: "IfStmt",
        line: 1,
        col: 1,
        init: null,
        cond: binExpr(">", ident("n"), intLit("0")),
        body: { stmts: [returnStmt([ident("n")])] },
        orelse: {
          type: "BlockNode",
          body: { stmts: [returnStmt([intLit("0")])] },
        },
      } satisfies GoAstIfStmt,
    ]);
    expect(() => checkBodyPurity(b)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WI-964: compound end-to-end — renderBody with control-flow
// ---------------------------------------------------------------------------

describe("renderBody — compound round-trips (WI-964)", () => {
  it("if-else inside a function body renders correctly", () => {
    // Simulates: func Sign(n int) int { if n > 0 { return 1 } else { return -1 } }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "IfStmt",
          line: 1,
          col: 2,
          init: null,
          cond: binExpr(">", ident("n"), intLit("0")),
          body: {
            stmts: [
              {
                type: "ReturnStmt",
                line: 1,
                col: 14,
                results: [intLit("1")],
              },
            ],
          },
          orelse: {
            type: "BlockNode",
            body: {
              stmts: [
                {
                  type: "ReturnStmt",
                  line: 1,
                  col: 28,
                  results: [{ type: "UnaryExpr", line: 1, col: 28, op: "-", x: intLit("1") }],
                },
              ],
            },
          },
        } satisfies GoAstIfStmt,
      ],
    };
    const result = renderBody(b);
    expect(result).toBe("  if ((n > 0)) {\n    return 1;\n  } else {\n    return -1;\n  }");
  });

  it("range loop inside a function body renders correctly", () => {
    // Simulates: func Sum(items []int) int { for _, v := range items { acc += v } return acc }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "AssignStmt",
          line: 1,
          col: 2,
          lhs: [ident("acc")],
          rhs: [intLit("0")],
          tok: ":=",
        },
        {
          type: "RangeStmt",
          line: 2,
          col: 2,
          key: null,
          value: "v",
          tok: ":=",
          x: ident("items"),
          body: {
            stmts: [
              {
                type: "AssignStmt",
                line: 2,
                col: 30,
                lhs: [ident("acc")],
                rhs: [binExpr("+", ident("acc"), ident("v"))],
                tok: "=",
              },
            ],
          },
        } satisfies GoAstRangeStmt,
        {
          type: "ReturnStmt",
          line: 3,
          col: 2,
          results: [ident("acc")],
        },
      ],
    };
    const result = renderBody(b);
    expect(result).toBe(
      "  const acc = 0;\n" +
        "  for (const v of Object.values(items)) {\n" +
        "    acc = (acc + v);\n" +
        "  }\n" +
        "  return acc;",
    );
  });

  it("switch inside a function body emits explicit breaks (no fallthrough)", () => {
    // Simulates: func Classify(x int) string { switch x { case 0: return "zero" default: return "other" } }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "SwitchStmt",
          line: 1,
          col: 2,
          init: null,
          tag: ident("x"),
          cases: [
            {
              type: "CaseClause",
              list: [intLit("0")],
              body: {
                stmts: [
                  {
                    type: "ReturnStmt",
                    line: 1,
                    col: 15,
                    results: [
                      { type: "BasicLit", line: 1, col: 22, kind: "STRING", value: '"zero"' },
                    ],
                  },
                ],
              },
            },
            {
              type: "CaseClause",
              list: [],
              body: {
                stmts: [
                  {
                    type: "ReturnStmt",
                    line: 2,
                    col: 15,
                    results: [
                      { type: "BasicLit", line: 2, col: 22, kind: "STRING", value: '"other"' },
                    ],
                  },
                ],
              },
            },
          ],
        } satisfies GoAstSwitchStmt,
      ],
    };
    const result = renderBody(b);
    expect(result).toContain("switch (x) {");
    expect(result).toContain("case 0:");
    expect(result).toContain('return "zero";');
    expect(result).toContain("break;");
    expect(result).toContain("default:");
    expect(result).toContain('return "other";');
  });

  it("bitshift in return: Go n >> 2 -> TS (n >> 2)", () => {
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "ReturnStmt",
          line: 1,
          col: 2,
          results: [binExpr(">>", ident("n"), intLit("2"))],
        },
      ],
    };
    expect(renderBody(b)).toBe("  return (n >> 2);");
  });

  // ---------------------------------------------------------------------------
  // #975: key-only range round-trip fidelity
  // ---------------------------------------------------------------------------

  it("#975: key-only range (for i := range collection) -> for...in IR", () => {
    // Simulates: func IndexOf(collection []T, element T) int {
    //   for i := range collection { if collection[i] == element { return i } }
    //   return -1
    // }
    // The key-only range must emit `for (const i in collection)` (ForInStatement)
    // so compile-go can reconstruct `for i := range collection` without `_`.
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "RangeStmt",
          line: 1,
          col: 2,
          key: "i",
          value: null,
          tok: ":=",
          x: ident("collection"),
          body: {
            stmts: [
              {
                type: "ReturnStmt",
                line: 2,
                col: 4,
                results: [ident("i")],
              },
            ],
          },
        } satisfies GoAstRangeStmt,
      ],
    };
    const result = renderBody(b);
    // Must use for...in (not Object.keys) for round-trip fidelity
    expect(result).toBe("  for (const i in collection) {\n    return i;\n  }");
    expect(result).not.toContain("Object.keys");
  });

  it("#975: key+value range (for i, v := range xs) -> for...of Object.entries() IR", () => {
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "RangeStmt",
          line: 1,
          col: 2,
          key: "i",
          value: "v",
          tok: ":=",
          x: ident("xs"),
          body: { stmts: [returnStmt([ident("v")])] },
        } satisfies GoAstRangeStmt,
      ],
    };
    const result = renderBody(b);
    expect(result).toBe("  for (const [i, v] of Object.entries(xs)) {\n    return v;\n  }");
  });
});

// ---------------------------------------------------------------------------
// #982: IncDecStmt (i++, i--)
// ---------------------------------------------------------------------------

describe("renderStmt — IncDecStmt (#982)", () => {
  it("renders i++ as i++", () => {
    const stmt: GoAstIncDecStmt = {
      type: "IncDecStmt",
      line: 1,
      col: 1,
      target: "i",
      op: "++",
    };
    expect(renderStmt(stmt)).toBe("  i++;");
  });

  it("renders i-- as i--", () => {
    const stmt: GoAstIncDecStmt = {
      type: "IncDecStmt",
      line: 1,
      col: 1,
      target: "i",
      op: "--",
    };
    expect(renderStmt(stmt)).toBe("  i--;");
  });

  it("renders j++ (arbitrary variable name)", () => {
    const stmt: GoAstIncDecStmt = {
      type: "IncDecStmt",
      line: 2,
      col: 4,
      target: "j",
      op: "++",
    };
    expect(renderStmt(stmt)).toBe("  j++;");
  });

  it("renders IncDecStmt with custom indent", () => {
    const stmt: GoAstIncDecStmt = {
      type: "IncDecStmt",
      line: 1,
      col: 1,
      target: "n",
      op: "--",
    };
    expect(renderStmt(stmt, "    ")).toBe("    n--;");
  });

  it("IncDecStmt is pure (passes checkBodyPurity)", () => {
    const b = body([
      { type: "IncDecStmt", line: 1, col: 1, target: "i", op: "++" } satisfies GoAstIncDecStmt,
    ]);
    expect(() => checkBodyPurity(b)).not.toThrow();
  });
});

describe("renderBody — compound round-trips for #982 IncDecStmt", () => {
  it("for-loop with IncDecStmt post (i++) renders correctly", () => {
    // Simulates: for i := 0; i < n; i++ { ... }
    // The post statement is an IncDecStmt, which must render without trailing ;
    // inside the for(...) header.
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "ForStmt",
          line: 1,
          col: 2,
          init: {
            type: "AssignStmt",
            line: 1,
            col: 6,
            lhs: [ident("i")],
            rhs: [intLit("0")],
            tok: ":=",
          },
          cond: binExpr("<", ident("i"), ident("n")),
          post: {
            type: "IncDecStmt",
            line: 1,
            col: 20,
            target: "i",
            op: "++",
          } satisfies GoAstIncDecStmt,
          body: {
            stmts: [returnStmt([ident("i")])],
          },
        } satisfies GoAstForStmt,
      ],
    };
    const result = renderBody(b);
    expect(result).toBe("  for (let i = 0; (i < n); i++) {\n    return i;\n  }");
  });

  it("standalone i-- statement (not in for-post) renders with semicolon", () => {
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "IncDecStmt",
          line: 1,
          col: 1,
          target: "i",
          op: "--",
        } satisfies GoAstIncDecStmt,
        returnStmt([ident("i")]),
      ],
    };
    const result = renderBody(b);
    expect(result).toBe("  i--;\n  return i;");
  });
});

// ---------------------------------------------------------------------------
// #986: SliceLit and MapLit expression rendering
// ---------------------------------------------------------------------------

describe("renderExpr — SliceLit (#986)", () => {
  it("renders empty slice literal as []", () => {
    const expr: GoAstSliceLitExpr = {
      type: "SliceLit",
      line: 1,
      col: 1,
      elementType: "int",
      elements: [],
    };
    expect(renderExpr(expr)).toBe("[]");
  });

  it("renders single-element []int{42}", () => {
    const expr: GoAstSliceLitExpr = {
      type: "SliceLit",
      line: 1,
      col: 1,
      elementType: "int",
      elements: [intLit("42")],
    };
    expect(renderExpr(expr)).toBe("[42]");
  });

  it('renders multi-element []string{"a","b"} as array literal', () => {
    const expr: GoAstSliceLitExpr = {
      type: "SliceLit",
      line: 1,
      col: 1,
      elementType: "string",
      elements: [strLit('"a"'), strLit('"b"'), strLit('"c"')],
    };
    expect(renderExpr(expr)).toBe('["a", "b", "c"]');
  });

  it("renders nested expressions inside slice", () => {
    const expr: GoAstSliceLitExpr = {
      type: "SliceLit",
      line: 1,
      col: 1,
      elementType: "int",
      elements: [binExpr("+", ident("a"), intLit("1")), binExpr("*", ident("b"), intLit("2"))],
    };
    expect(renderExpr(expr)).toBe("[(a + 1), (b * 2)]");
  });

  it("SliceLit purity: passes checkBodyPurity for pure elements", () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "SliceLit",
            line: 1,
            col: 3,
            elementType: "int",
            elements: [intLit("1"), intLit("2")],
          } satisfies GoAstSliceLitExpr,
        ]),
      ],
    };
    expect(() => checkBodyPurity(b)).not.toThrow();
  });

  it("SliceLit purity: rejects ChanRecv inside elements", () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "SliceLit",
            line: 1,
            col: 1,
            elementType: "int",
            elements: [{ type: "ChanRecv", line: 1, col: 5 }],
          } satisfies GoAstSliceLitExpr,
        ]),
      ],
    };
    expect(() => checkBodyPurity(b)).toThrow(GoChanRecvError);
  });
});

describe("renderExpr — MapLit (#986)", () => {
  it("renders empty map literal as {}", () => {
    const expr: GoAstMapLitExpr = {
      type: "MapLit",
      line: 1,
      col: 1,
      keyType: "string",
      valueType: "int",
      entries: [],
    };
    expect(renderExpr(expr)).toBe("{}");
  });

  it("renders string-key map literal", () => {
    const entries: GoAstMapEntry[] = [
      { key: strLit('"foo"'), value: intLit("1") },
      { key: strLit('"bar"'), value: intLit("2") },
    ];
    const expr: GoAstMapLitExpr = {
      type: "MapLit",
      line: 1,
      col: 1,
      keyType: "string",
      valueType: "int",
      entries,
    };
    expect(renderExpr(expr)).toBe('{"foo": 1, "bar": 2}');
  });

  it("renders numeric key map literal using computed property syntax", () => {
    const entries: GoAstMapEntry[] = [{ key: intLit("0"), value: strLit('"zero"') }];
    const expr: GoAstMapLitExpr = {
      type: "MapLit",
      line: 1,
      col: 1,
      keyType: "int",
      valueType: "string",
      entries,
    };
    // Non-string keys use computed property [key]: value
    expect(renderExpr(expr)).toBe('{[0]: "zero"}');
  });

  it("MapLit purity: passes checkBodyPurity for pure entries", () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "MapLit",
            line: 1,
            col: 1,
            keyType: "string",
            valueType: "int",
            entries: [{ key: strLit('"k"'), value: intLit("1") }],
          } satisfies GoAstMapLitExpr,
        ]),
      ],
    };
    expect(() => checkBodyPurity(b)).not.toThrow();
  });

  it("MapLit purity: rejects ChanRecv in entry value", () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "MapLit",
            line: 1,
            col: 1,
            keyType: "string",
            valueType: "int",
            entries: [{ key: strLit('"k"'), value: { type: "ChanRecv", line: 1, col: 10 } }],
          } satisfies GoAstMapLitExpr,
        ]),
      ],
    };
    expect(() => checkBodyPurity(b)).toThrow(GoChanRecvError);
  });
});

// ---------------------------------------------------------------------------
// #986: CompositeLit compound round-trips through renderBody
// ---------------------------------------------------------------------------

describe("renderBody — CompositeLit compound round-trips (#986)", () => {
  it("slice literal in return: []int{1,2,3} -> [1, 2, 3]", () => {
    // Simulates: func Nums() []int { return []int{1, 2, 3} }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "ReturnStmt",
          line: 1,
          col: 2,
          results: [
            {
              type: "SliceLit",
              line: 1,
              col: 9,
              elementType: "int",
              elements: [intLit("1"), intLit("2"), intLit("3")],
            } satisfies GoAstSliceLitExpr,
          ],
        },
      ],
    };
    expect(renderBody(b)).toBe("  return [1, 2, 3];");
  });

  it('map literal in assignment: map[string]int{"a":1} -> {"a":1}', () => {
    // Simulates: func Scores() map[string]int { m := map[string]int{"a": 1}; return m }
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "AssignStmt",
          line: 1,
          col: 2,
          lhs: [ident("m")],
          rhs: [
            {
              type: "MapLit",
              line: 1,
              col: 7,
              keyType: "string",
              valueType: "int",
              entries: [{ key: strLit('"a"'), value: intLit("1") }],
            } satisfies GoAstMapLitExpr,
          ],
          tok: ":=",
        },
        returnStmt([ident("m")]),
      ],
    };
    expect(renderBody(b)).toBe('  const m = {"a": 1};\n  return m;');
  });

  it("slice literal with identifier elements: []string{s, t}", () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "SliceLit",
            line: 1,
            col: 9,
            elementType: "string",
            elements: [ident("s"), ident("t")],
          } satisfies GoAstSliceLitExpr,
        ]),
      ],
    };
    expect(renderBody(b)).toBe("  return [s, t];");
  });

  it('map literal with binary-expr value: map[string]int{"x": a+b}', () => {
    const b: GoAstBodyNode = {
      stmts: [
        returnStmt([
          {
            type: "MapLit",
            line: 1,
            col: 9,
            keyType: "string",
            valueType: "int",
            entries: [{ key: strLit('"x"'), value: binExpr("+", ident("a"), ident("b")) }],
          } satisfies GoAstMapLitExpr,
        ]),
      ],
    };
    expect(renderBody(b)).toBe('  return {"x": (a + b)};');
  });
});
