// SPDX-License-Identifier: MIT
//
// Tests for raise-body.ts — WireExpr / WireStmt renderers (WI-782 slices 2b + 4).
// Tests build wire envelopes directly; no subprocess.

import { describe, expect, it } from "vitest";
import { ImpureFunctionError } from "./purity-check.js";
import {
  UnsupportedAstError,
  type WireExpr,
  type WireStmt,
  renderBody,
  renderExpr,
  renderStmt,
} from "./raise-body.js";

describe("renderExpr — primitives", () => {
  it("renders Name", () => {
    expect(renderExpr({ type: "Name", name: "x" })).toBe("x");
  });
  it("renders Integer (preserves precision via string)", () => {
    expect(renderExpr({ type: "Integer", value: "9007199254740993" })).toBe("9007199254740993");
  });
  it("renders Float", () => {
    expect(renderExpr({ type: "Float", value: "3.14" })).toBe("3.14");
  });
  it("renders String with JSON.stringify (handles quotes/escapes)", () => {
    expect(renderExpr({ type: "String", value: 'hello "world"' })).toBe('"hello \\"world\\""');
  });
  it("renders Bool", () => {
    expect(renderExpr({ type: "Bool", value: true })).toBe("true");
    expect(renderExpr({ type: "Bool", value: false })).toBe("false");
  });
  it("renders None → null", () => {
    expect(renderExpr({ type: "None" })).toBe("null");
  });
});

describe("renderExpr — BinaryOp", () => {
  const n = (name: string): WireExpr => ({ type: "Name", name });
  const i = (v: string): WireExpr => ({ type: "Integer", value: v });

  it.each([
    ["+", n("x"), n("y"), "(x + y)"],
    ["-", n("x"), i("1"), "(x - 1)"],
    ["*", i("2"), i("3"), "(2 * 3)"],
    ["/", n("a"), n("b"), "(a / b)"],
    ["%", n("a"), i("2"), "(a % 2)"],
    ["==", n("a"), n("b"), "(a == b)"],
    ["!=", n("a"), n("b"), "(a != b)"],
    ["<", n("a"), n("b"), "(a < b)"],
    [">", n("a"), n("b"), "(a > b)"],
    ["<=", n("a"), n("b"), "(a <= b)"],
    [">=", n("a"), n("b"), "(a >= b)"],
  ])("renders BinaryOp %s", (op, left, right, expected) => {
    expect(renderExpr({ type: "BinaryOp", op, left, right })).toBe(expected);
  });

  it("recurses into nested BinaryOp expressions", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "+",
      left: n("a"),
      right: { type: "BinaryOp", op: "*", left: n("b"), right: i("2") },
    };
    expect(renderExpr(expr)).toBe("(a + (b * 2))");
  });

  it("rejects unknown BinaryOp", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "**",
      left: n("a"),
      right: n("b"),
    };
    expect(() => renderExpr(expr)).toThrow(UnsupportedAstError);
  });
});

describe("renderExpr — Unsupported", () => {
  it("surfaces UnsupportedAstError with reason", () => {
    try {
      renderExpr({ type: "Unsupported", reason: "Call" });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedAstError);
      expect((err as UnsupportedAstError).reason).toBe("Call");
    }
  });
});

describe("renderStmt", () => {
  it("renders Return with value", () => {
    const stmt: WireStmt = {
      type: "Return",
      value: {
        type: "BinaryOp",
        op: "+",
        left: { type: "Name", name: "x" },
        right: { type: "Name", name: "y" },
      },
    };
    expect(renderStmt(stmt)).toBe("  return (x + y);");
  });
  it("renders bare Return", () => {
    expect(renderStmt({ type: "Return", value: null })).toBe("  return;");
  });
  it("renders Pass as void 0;", () => {
    expect(renderStmt({ type: "Pass" })).toBe("  void 0;");
  });
  it("honors custom indent", () => {
    expect(renderStmt({ type: "Return", value: null }, "    ")).toBe("    return;");
  });
  it("rejects Unsupported stmt", () => {
    expect(() => renderStmt({ type: "Unsupported", reason: "While" })).toThrow(UnsupportedAstError);
  });
});

describe("renderBody", () => {
  it("joins multiple statements with newline", () => {
    const stmts: WireStmt[] = [
      { type: "Pass" },
      { type: "Return", value: { type: "Integer", value: "42" } },
    ];
    expect(renderBody(stmts)).toBe("  void 0;\n  return 42;");
  });
});

// ---------------------------------------------------------------------------
// Slice 4: new expression types
// ---------------------------------------------------------------------------

describe("renderExpr — UnaryOp (slice 4)", () => {
  it("renders unary minus", () => {
    expect(renderExpr({ type: "UnaryOp", op: "-", operand: { type: "Name", name: "x" } })).toBe(
      "-x",
    );
  });
  it("renders unary not", () => {
    expect(renderExpr({ type: "UnaryOp", op: "!", operand: { type: "Bool", value: true } })).toBe(
      "!true",
    );
  });
  it("rejects unknown unary op", () => {
    expect(() =>
      renderExpr({ type: "UnaryOp", op: "**", operand: { type: "Name", name: "x" } }),
    ).toThrow(UnsupportedAstError);
  });
});

describe("renderExpr — IfExp ternary (slice 4)", () => {
  it("renders x if c else y → (c ? x : y)", () => {
    const expr: WireExpr = {
      type: "IfExp",
      test: {
        type: "BinaryOp",
        op: ">",
        left: { type: "Name", name: "x" },
        right: { type: "Integer", value: "0" },
      },
      body: { type: "Name", name: "x" },
      orelse: { type: "Integer", value: "0" },
    };
    expect(renderExpr(expr)).toBe("((x > 0) ? x : 0)");
  });

  it("renders nested ternary", () => {
    const inner: WireExpr = {
      type: "IfExp",
      test: { type: "Name", name: "a" },
      body: { type: "Integer", value: "1" },
      orelse: { type: "Integer", value: "2" },
    };
    const outer: WireExpr = {
      type: "IfExp",
      test: { type: "Name", name: "b" },
      body: inner,
      orelse: { type: "Integer", value: "3" },
    };
    expect(renderExpr(outer)).toBe("(b ? (a ? 1 : 2) : 3)");
  });
});

describe("renderExpr — LenCall (slice 4)", () => {
  it("renders len(xs) → (xs).length", () => {
    expect(renderExpr({ type: "LenCall", arg: { type: "Name", name: "xs" } })).toBe("(xs).length");
  });

  it("renders len on complex expr with parens", () => {
    const expr: WireExpr = {
      type: "LenCall",
      arg: {
        type: "BinaryOp",
        op: "+",
        left: { type: "Name", name: "a" },
        right: { type: "Name", name: "b" },
      },
    };
    expect(renderExpr(expr)).toBe("((a + b)).length");
  });
});

describe("renderExpr — Call (slice 4)", () => {
  it("renders zero-arg call", () => {
    expect(renderExpr({ type: "Call", func: "doSomething", args: [] })).toBe("doSomething()");
  });
  it("renders single-arg call", () => {
    expect(
      renderExpr({ type: "Call", func: "Math.abs", args: [{ type: "Name", name: "x" }] }),
    ).toBe("Math.abs(x)");
  });
  it("renders multi-arg call", () => {
    expect(
      renderExpr({
        type: "Call",
        func: "Math.max",
        args: [
          { type: "Name", name: "x" },
          { type: "Name", name: "y" },
        ],
      }),
    ).toBe("Math.max(x, y)");
  });
});

describe("renderExpr — ListComp (slice 4)", () => {
  it("renders map pattern [f(x) for x in xs] → (xs).map((x) => f(x))", () => {
    const expr: WireExpr = {
      type: "ListComp",
      kind: "map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      elt: {
        type: "BinaryOp",
        op: "+",
        left: { type: "Name", name: "x" },
        right: { type: "Integer", value: "1" },
      },
    };
    expect(renderExpr(expr)).toBe("(xs).map((x) => (x + 1))");
  });

  it("renders filter pattern [x for x in xs if p(x)] → (xs).filter((x) => p(x))", () => {
    const expr: WireExpr = {
      type: "ListComp",
      kind: "filter",
      iter: { type: "Name", name: "items" },
      param: "item",
      cond: {
        type: "BinaryOp",
        op: ">",
        left: { type: "Name", name: "item" },
        right: { type: "Integer", value: "0" },
      },
    };
    expect(renderExpr(expr)).toBe("(items).filter((item) => (item > 0))");
  });

  it("renders map with call elt", () => {
    const expr: WireExpr = {
      type: "ListComp",
      kind: "map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      elt: { type: "Call", func: "square", args: [{ type: "Name", name: "x" }] },
    };
    expect(renderExpr(expr)).toBe("(xs).map((x) => square(x))");
  });
});

// ---------------------------------------------------------------------------
// Slice 4: new statement types
// ---------------------------------------------------------------------------

describe("renderStmt — Raise (slice 4)", () => {
  it("renders raise ValueError('msg') → throw new ValueError('msg');", () => {
    const stmt: WireStmt = {
      type: "Raise",
      excClass: "ValueError",
      message: { type: "String", value: "negative" },
    };
    expect(renderStmt(stmt)).toBe('  throw new ValueError("negative");');
  });

  it("renders raise TypeError without message", () => {
    const stmt: WireStmt = {
      type: "Raise",
      excClass: "TypeError",
      message: null,
    };
    expect(renderStmt(stmt)).toBe("  throw new TypeError();");
  });

  it("renders raise with name expr as message", () => {
    const stmt: WireStmt = {
      type: "Raise",
      excClass: "Error",
      message: { type: "Name", name: "msg" },
    };
    expect(renderStmt(stmt)).toBe("  throw new Error(msg);");
  });

  it("honors custom indent", () => {
    const stmt: WireStmt = {
      type: "Raise",
      excClass: "RangeError",
      message: { type: "String", value: "out of range" },
    };
    expect(renderStmt(stmt, "    ")).toBe('    throw new RangeError("out of range");');
  });
});

describe("UnsupportedAstError extends CannotRaiseToIRError (slice 4)", () => {
  it("is instanceof CannotRaiseToIRError", async () => {
    const { CannotRaiseToIRError } = await import("@yakcc/contracts");
    const err = new UnsupportedAstError("async def");
    expect(err).toBeInstanceOf(UnsupportedAstError);
    expect(err).toBeInstanceOf(CannotRaiseToIRError);
    expect(err.reason).toBe("async def");
    expect(err.construct).toBe("async def");
  });
});

// ---------------------------------------------------------------------------
// WI-888: Docstring wire stmt — silently skipped by renderStmt
// ---------------------------------------------------------------------------

describe("WI-888: renderStmt — Docstring node returns empty string", () => {
  it("returns empty string for a single-line docstring", () => {
    const stmt: WireStmt = { type: "Docstring", value: "This is a docstring." };
    expect(renderStmt(stmt)).toBe("");
  });

  it("returns empty string for a multi-line docstring value", () => {
    const stmt: WireStmt = { type: "Docstring", value: "Line 1.\nLine 2." };
    expect(renderStmt(stmt)).toBe("");
  });

  it("renderBody silently drops a Docstring node from joined output", () => {
    const stmts: WireStmt[] = [
      { type: "Docstring", value: "Compute the sum." },
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: "+",
          left: { type: "Name", name: "x" },
          right: { type: "Name", name: "y" },
        },
      },
    ];
    // Docstring produces "" which joins with newline + Return result
    expect(renderBody(stmts)).toBe("\n  return (x + y);");
  });
});

// ---------------------------------------------------------------------------
// WI-888: ImpureStatement wire stmt — throws ImpureFunctionError
// ---------------------------------------------------------------------------

describe("WI-888: renderStmt — ImpureStatement throws ImpureFunctionError", () => {
  it("throws ImpureFunctionError for bare_call construct", () => {
    const stmt: WireStmt = {
      type: "ImpureStatement",
      construct: "bare_call",
      detail: "print(...)",
    };
    try {
      renderStmt(stmt);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_construct");
      expect((err as ImpureFunctionError).detail).toContain("print(...)");
      expect((err as ImpureFunctionError).functionName).toBe("<unknown>");
    }
  });

  it("throws ImpureFunctionError for bare_expression construct", () => {
    const stmt: WireStmt = {
      type: "ImpureStatement",
      construct: "bare_expression",
      detail: "BinaryOperation",
    };
    try {
      renderStmt(stmt);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_construct");
      expect((err as ImpureFunctionError).detail).toContain("BinaryOperation");
    }
  });

  it("threads fnName through to ImpureFunctionError when provided", () => {
    const stmt: WireStmt = {
      type: "ImpureStatement",
      construct: "bare_call",
      detail: "log_event(...)",
    };
    try {
      renderStmt(stmt, "  ", "my_function");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).functionName).toBe("my_function");
    }
  });

  it("renderBody throws on ImpureStatement before the body completes", () => {
    const stmts: WireStmt[] = [
      { type: "Pass" },
      { type: "ImpureStatement", construct: "bare_call", detail: "side_effect(...)" },
      { type: "Return", value: null },
    ];
    expect(() => renderBody(stmts, "  ", "my_fn")).toThrow(ImpureFunctionError);
  });
});

// ---------------------------------------------------------------------------
// WI-875: floor-divide // operator
// ---------------------------------------------------------------------------

describe("WI-875: floor-divide // renders as Math.floor(a / b)", () => {
  it("renders the // binary op as Math.floor(left / right)", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "//",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    expect(renderExpr(expr)).toBe("Math.floor(a / b)");
  });

  it("accepts // in ALLOWED_BINARY_OPS (does not throw UnsupportedAstError)", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "//",
      left: { type: "Name", name: "x" },
      right: { type: "Name", name: "y" },
    };
    expect(() => renderExpr(expr)).not.toThrow();
  });
});
