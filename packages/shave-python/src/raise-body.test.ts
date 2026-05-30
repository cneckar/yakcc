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

// ---------------------------------------------------------------------------
// WI-903: If statement → TS if/else if/else
// ---------------------------------------------------------------------------

describe("WI-903: renderStmt — If statement", () => {
  const trueCond: WireExpr = { type: "Name", name: "x" };
  const retOne: WireStmt = { type: "Return", value: { type: "Integer", value: "1" } };
  const retTwo: WireStmt = { type: "Return", value: { type: "Integer", value: "2" } };
  const retThree: WireStmt = { type: "Return", value: { type: "Integer", value: "3" } };

  it("renders if-only (no else)", () => {
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [retOne],
      orelse: [],
    };
    expect(renderStmt(stmt)).toBe("  if (x) {\n    return 1;\n  }");
  });

  it("renders if/else", () => {
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [retOne],
      orelse: [retTwo],
    };
    expect(renderStmt(stmt)).toBe("  if (x) {\n    return 1;\n  } else {\n    return 2;\n  }");
  });

  it("renders if/elif/else (chained via nested If in orelse)", () => {
    const elifCond: WireExpr = { type: "Name", name: "y" };
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [retOne],
      orelse: [
        {
          type: "If",
          test: elifCond,
          body: [retTwo],
          orelse: [retThree],
        },
      ],
    };
    expect(renderStmt(stmt)).toBe(
      "  if (x) {\n    return 1;\n  } else if (y) {\n    return 2;\n  } else {\n    return 3;\n  }",
    );
  });

  it("renders nested if inside body", () => {
    // if (x) { if (y) { return 1; } }
    const inner: WireStmt = {
      type: "If",
      test: { type: "Name", name: "y" },
      body: [retOne],
      orelse: [],
    };
    const outer: WireStmt = {
      type: "If",
      test: trueCond,
      body: [inner],
      orelse: [],
    };
    expect(renderStmt(outer)).toBe("  if (x) {\n    if (y) {\n      return 1;\n    }\n  }");
  });

  it("renders empty body with void 0 fallback", () => {
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [],
      orelse: [],
    };
    expect(renderStmt(stmt)).toBe("  if (x) {\n    void 0;\n  }");
  });

  it("honors custom indent at the outer level", () => {
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [retOne],
      orelse: [],
    };
    expect(renderStmt(stmt, "")).toBe("if (x) {\n  return 1;\n}");
  });

  it("skips Docstring nodes inside if-body (renders empty string, filtered out)", () => {
    const stmt: WireStmt = {
      type: "If",
      test: trueCond,
      body: [{ type: "Docstring", value: "ignored" }, retOne],
      orelse: [],
    };
    // Docstring renders "" and is filtered, only the Return remains
    expect(renderStmt(stmt)).toBe("  if (x) {\n    return 1;\n  }");
  });

  it("renderBody includes If statement correctly in multi-statement body", () => {
    const stmts: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: ">",
          left: { type: "Name", name: "n" },
          right: { type: "Integer", value: "0" },
        },
        body: [{ type: "Return", value: { type: "Name", name: "n" } }],
        orelse: [],
      },
      { type: "Return", value: { type: "Integer", value: "0" } },
    ];
    const out = renderBody(stmts);
    expect(out).toBe("  if ((n > 0)) {\n    return n;\n  }\n  return 0;");
  });
});

// ---------------------------------------------------------------------------
// WI-904: GeneratorExp, DictComp, SetComp expression renderers
// ---------------------------------------------------------------------------

describe("WI-904: renderExpr — GeneratorExp", () => {
  it("renders map-kind (f(x) for x in xs) → (xs).map((x) => f(x))", () => {
    const expr: WireExpr = {
      type: "GeneratorExp",
      kind: "map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      elt: { type: "Call", func: "f", args: [{ type: "Name", name: "x" }] },
    };
    expect(renderExpr(expr)).toBe("(xs).map((x) => f(x))");
  });

  it("renders filter_map-kind (f(x) for x in xs if p(x)) → filter then map", () => {
    const expr: WireExpr = {
      type: "GeneratorExp",
      kind: "filter_map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      cond: { type: "Call", func: "p", args: [{ type: "Name", name: "x" }] },
      elt: { type: "Call", func: "f", args: [{ type: "Name", name: "x" }] },
    };
    expect(renderExpr(expr)).toBe("(xs).filter((x) => p(x)).map((x) => f(x))");
  });

  it("renders identity map-kind (x for x in xs) → (xs).map((x) => x)", () => {
    const expr: WireExpr = {
      type: "GeneratorExp",
      kind: "map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      elt: { type: "Name", name: "x" },
    };
    expect(renderExpr(expr)).toBe("(xs).map((x) => x)");
  });
});

describe("WI-904: renderExpr — DictComp", () => {
  it("renders {k: v for item in pairs} without condition", () => {
    const expr: WireExpr = {
      type: "DictComp",
      iter: { type: "Name", name: "pairs" },
      param: "item",
      keyElt: { type: "Name", name: "item" },
      valElt: { type: "Integer", value: "1" },
      cond: null,
    };
    expect(renderExpr(expr)).toBe("Object.fromEntries((pairs).map((item) => [item, 1]))");
  });

  it("renders {k: v for item in pairs if cond} with condition filter", () => {
    const expr: WireExpr = {
      type: "DictComp",
      iter: { type: "Name", name: "d" },
      param: "k",
      keyElt: { type: "Name", name: "k" },
      valElt: { type: "Call", func: "f", args: [{ type: "Name", name: "k" }] },
      cond: {
        type: "BinaryOp",
        op: "!=",
        left: { type: "Name", name: "k" },
        right: { type: "String", value: "x" },
      },
    };
    expect(renderExpr(expr)).toBe(
      'Object.fromEntries((d).filter((k) => (k != "x")).map((k) => [k, f(k)]))',
    );
  });
});

describe("WI-904: renderExpr — SetComp", () => {
  it("renders {f(x) for x in xs} map-kind → new Set((xs).map(...))", () => {
    const expr: WireExpr = {
      type: "SetComp",
      kind: "map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      elt: { type: "Call", func: "f", args: [{ type: "Name", name: "x" }] },
    };
    expect(renderExpr(expr)).toBe("new Set((xs).map((x) => f(x)))");
  });

  it("renders {f(x) for x in xs if cond} filter_map-kind", () => {
    const expr: WireExpr = {
      type: "SetComp",
      kind: "filter_map",
      iter: { type: "Name", name: "xs" },
      param: "x",
      cond: {
        type: "BinaryOp",
        op: ">",
        left: { type: "Name", name: "x" },
        right: { type: "Integer", value: "0" },
      },
      elt: { type: "Name", name: "x" },
    };
    expect(renderExpr(expr)).toBe("new Set((xs).filter((x) => (x > 0)).map((x) => x))");
  });
});

// ---------------------------------------------------------------------------
// WI-907: Assign statement → TS const
// ---------------------------------------------------------------------------

describe("WI-907: renderStmt — Assign", () => {
  it("renders simple name assign as const declaration", () => {
    const stmt: WireStmt = {
      type: "Assign",
      target: "rewritten",
      value: {
        type: "Call",
        func: "name.replace",
        args: [
          { type: "String", value: "Name" },
          { type: "String", value: "OtherName" },
        ],
      },
    };
    expect(renderStmt(stmt)).toBe('  const rewritten = name.replace("Name", "OtherName");');
  });

  it("renders assign with integer value", () => {
    const stmt: WireStmt = {
      type: "Assign",
      target: "x",
      value: { type: "Integer", value: "42" },
    };
    expect(renderStmt(stmt)).toBe("  const x = 42;");
  });

  it("renders assign with binary op value", () => {
    const stmt: WireStmt = {
      type: "Assign",
      target: "total",
      value: {
        type: "BinaryOp",
        op: "+",
        left: { type: "Name", name: "a" },
        right: { type: "Name", name: "b" },
      },
    };
    expect(renderStmt(stmt)).toBe("  const total = (a + b);");
  });

  it("honors custom indent", () => {
    const stmt: WireStmt = {
      type: "Assign",
      target: "val",
      value: { type: "Bool", value: true },
    };
    expect(renderStmt(stmt, "    ")).toBe("    const val = true;");
  });

  it("renderBody includes Assign correctly before a Return", () => {
    const stmts: WireStmt[] = [
      {
        type: "Assign",
        target: "rewritten",
        value: {
          type: "Call",
          func: "name.replace",
          args: [
            { type: "String", value: "Name" },
            { type: "String", value: "OtherName" },
          ],
        },
      },
      { type: "Return", value: { type: "Name", name: "rewritten" } },
    ];
    expect(renderBody(stmts)).toBe(
      '  const rewritten = name.replace("Name", "OtherName");\n  return rewritten;',
    );
  });
});

// ---------------------------------------------------------------------------
// WI-908: BoolOp expression → TS && / ||
// ---------------------------------------------------------------------------

describe("WI-908: renderExpr — BoolOp", () => {
  it("renders 'and' as &&", () => {
    const expr: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    expect(renderExpr(expr)).toBe("(a && b)");
  });

  it("renders 'or' as ||", () => {
    const expr: WireExpr = {
      type: "BoolOp",
      op: "or",
      left: { type: "Name", name: "x" },
      right: { type: "None" },
    };
    expect(renderExpr(expr)).toBe("(x || null)");
  });

  it("renders chained and (nested BoolOp) — `a and b and c`", () => {
    // libcst represents `a and b and c` as BoolOp(BoolOp(a, and, b), and, c)
    const inner: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    const outer: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: inner,
      right: { type: "Name", name: "c" },
    };
    expect(renderExpr(outer)).toBe("((a && b) && c)");
  });

  it("renders mixed and/or nesting", () => {
    // `(a or b) and c`
    const orPart: WireExpr = {
      type: "BoolOp",
      op: "or",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    const expr: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: orPart,
      right: { type: "Name", name: "c" },
    };
    expect(renderExpr(expr)).toBe("((a || b) && c)");
  });

  it("renders BoolOp with comparison operands — isinstance(s, bytes) and override is not None", () => {
    // isinstance(s, bytes) — rendered as a Call
    // override is not None — rendered as BinaryOp(!=)
    const expr: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: {
        type: "Call",
        func: "isinstance",
        args: [
          { type: "Name", name: "s" },
          { type: "Name", name: "bytes" },
        ],
      },
      right: {
        type: "BinaryOp",
        op: "!=",
        left: { type: "Name", name: "override" },
        right: { type: "None" },
      },
    };
    expect(renderExpr(expr)).toBe("(isinstance(s, bytes) && (override != null))");
  });
});

// ---------------------------------------------------------------------------
// WI-909: Comprehension tuple target → destructured arrow param
// ---------------------------------------------------------------------------

describe("WI-909: renderExpr — GeneratorExp tuple target", () => {
  it("renders (f(k,v) for k,v in items) as items.map(([k, v]) => f(k, v))", () => {
    const expr: WireExpr = {
      type: "GeneratorExp",
      kind: "map",
      iter: { type: "Name", name: "items" },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      elt: {
        type: "Call",
        func: "f",
        args: [
          { type: "Name", name: "k" },
          { type: "Name", name: "v" },
        ],
      },
    };
    expect(renderExpr(expr)).toBe("(items).map(([k, v]) => f(k, v))");
  });

  it("renders filter_map tuple target", () => {
    const expr: WireExpr = {
      type: "GeneratorExp",
      kind: "filter_map",
      iter: { type: "Name", name: "pairs" },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      cond: { type: "Name", name: "v" },
      elt: { type: "Call", func: "g", args: [{ type: "Name", name: "k" }] },
    };
    expect(renderExpr(expr)).toBe("(pairs).filter(([k, v]) => v).map(([k, v]) => g(k))");
  });
});

describe("WI-909: renderExpr — DictComp tuple target", () => {
  it("renders {v: k for k, v in items} → Object.fromEntries(items.map(([k, v]) => [v, k]))", () => {
    const expr: WireExpr = {
      type: "DictComp",
      iter: { type: "Name", name: "items" },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      keyElt: { type: "Name", name: "v" },
      valElt: { type: "Name", name: "k" },
      cond: null,
    };
    expect(renderExpr(expr)).toBe("Object.fromEntries((items).map(([k, v]) => [v, k]))");
  });

  it("renders DictComp tuple target with condition", () => {
    const expr: WireExpr = {
      type: "DictComp",
      iter: { type: "Call", func: "d.items", args: [] },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      keyElt: { type: "Name", name: "k" },
      valElt: { type: "Name", name: "v" },
      cond: { type: "Name", name: "v" },
    };
    expect(renderExpr(expr)).toBe(
      "Object.fromEntries((d.items()).filter(([k, v]) => v).map(([k, v]) => [k, v]))",
    );
  });
});

describe("WI-909: renderExpr — ListComp tuple target", () => {
  it("renders [f(k,v) for k,v in items] map-kind", () => {
    const expr: WireExpr = {
      type: "ListComp",
      kind: "map",
      iter: { type: "Name", name: "items" },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      elt: {
        type: "Call",
        func: "f",
        args: [
          { type: "Name", name: "k" },
          { type: "Name", name: "v" },
        ],
      },
    };
    expect(renderExpr(expr)).toBe("(items).map(([k, v]) => f(k, v))");
  });

  it("renders [k for k,v in items if v] filter_map-kind", () => {
    const expr: WireExpr = {
      type: "ListComp",
      kind: "filter_map",
      iter: { type: "Name", name: "items" },
      param: "k, v",
      target_kind: "tuple",
      target_names: ["k", "v"],
      cond: { type: "Name", name: "v" },
      elt: { type: "Name", name: "k" },
    };
    expect(renderExpr(expr)).toBe("(items).filter(([k, v]) => v).map(([k, v]) => k)");
  });
});

// ---------------------------------------------------------------------------
// WI-907+908+909: compound production sequence — bs4-style end-to-end
// Tests the real production sequence: Assign + BoolOp + GeneratorExp(tuple)
// combined in a single renderBody call, crossing all new statement + expr boundaries.
// ---------------------------------------------------------------------------

describe("WI-907+908+909: compound interaction — bs4 production sequence", () => {
  it("renders __getattr__-style body: Assign then conditional Return", () => {
    // Python equivalent:
    //   rewritten = name.replace("Name", "OtherName")
    //   return rewritten
    const stmts: WireStmt[] = [
      {
        type: "Assign",
        target: "rewritten",
        value: {
          type: "Call",
          func: "name.replace",
          args: [
            { type: "String", value: "Name" },
            { type: "String", value: "OtherName" },
          ],
        },
      },
      { type: "Return", value: { type: "Name", name: "rewritten" } },
    ];
    const out = renderBody(stmts);
    expect(out).toBe('  const rewritten = name.replace("Name", "OtherName");\n  return rewritten;');
  });

  it("renders _chardet_dammit-style body: BoolOp in If test", () => {
    // Python equivalent:
    //   if isinstance(s, bytes) and override is not None:
    //     return s.decode(override[0])
    //   return s.decode("utf-8")
    const stmts: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BoolOp",
          op: "and",
          left: {
            type: "Call",
            func: "isinstance",
            args: [
              { type: "Name", name: "s" },
              { type: "Name", name: "bytes" },
            ],
          },
          right: {
            type: "BinaryOp",
            op: "!=",
            left: { type: "Name", name: "override" },
            right: { type: "None" },
          },
        },
        body: [
          {
            type: "Return",
            value: {
              type: "Call",
              func: "s.decode",
              args: [{ type: "Name", name: "override" }],
            },
          },
        ],
        orelse: [],
      },
      {
        type: "Return",
        value: {
          type: "Call",
          func: "s.decode",
          args: [{ type: "String", value: "utf-8" }],
        },
      },
    ];
    const out = renderBody(stmts);
    expect(out).toContain("(isinstance(s, bytes) && (override != null))");
    expect(out).toContain("return s.decode(override)");
    expect(out).toContain('return s.decode("utf-8")');
  });

  it("renders _invert-style body: GeneratorExp with tuple target inside dict() call", () => {
    // Python equivalent:
    //   return dict((v, k) for k, v in list(d.items()))
    // The wire representation: Return(Call("dict", [GeneratorExp(tuple target)]))
    const stmts: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "Call",
          func: "dict",
          args: [
            {
              type: "GeneratorExp",
              kind: "map",
              iter: {
                type: "Call",
                func: "list",
                args: [{ type: "Call", func: "d.items", args: [] }],
              },
              param: "k, v",
              target_kind: "tuple",
              target_names: ["k", "v"],
              elt: {
                type: "Call",
                func: "f",
                args: [
                  { type: "Name", name: "v" },
                  { type: "Name", name: "k" },
                ],
              },
            },
          ],
        },
      },
    ];
    const out = renderBody(stmts);
    expect(out).toContain("([k, v])");
    expect(out).toContain("list(d.items())");
    expect(out).toContain(".map(([k, v]) => f(v, k))");
  });
});

// ---------------------------------------------------------------------------
// WI-911: Subscript expression → TS obj[key]
// ---------------------------------------------------------------------------

describe("WI-911: renderExpr — Subscript", () => {
  it("renders name[integer] → name[0]", () => {
    const expr: WireExpr = {
      type: "Subscript",
      value: { type: "Name", name: "arr" },
      slice: { type: "Integer", value: "0" },
    };
    expect(renderExpr(expr)).toBe("arr[0]");
  });

  it('renders name[string_key] → name["key"]', () => {
    const expr: WireExpr = {
      type: "Subscript",
      value: { type: "Name", name: "obj" },
      slice: { type: "String", value: "key" },
    };
    expect(renderExpr(expr)).toBe('obj["key"]');
  });

  it("renders name[name_key] → obj[k]", () => {
    const expr: WireExpr = {
      type: "Subscript",
      value: { type: "Name", name: "obj" },
      slice: { type: "Name", name: "k" },
    };
    expect(renderExpr(expr)).toBe("obj[k]");
  });

  it("renders nested subscript obj[a][b]", () => {
    const inner: WireExpr = {
      type: "Subscript",
      value: { type: "Name", name: "obj" },
      slice: { type: "Name", name: "a" },
    };
    const outer: WireExpr = {
      type: "Subscript",
      value: inner,
      slice: { type: "Name", name: "b" },
    };
    expect(renderExpr(outer)).toBe("obj[a][b]");
  });

  it("renders subscript of a Call result — f(x)[0]", () => {
    const expr: WireExpr = {
      type: "Subscript",
      value: { type: "Call", func: "f", args: [{ type: "Name", name: "x" }] },
      slice: { type: "Integer", value: "0" },
    };
    expect(renderExpr(expr)).toBe("f(x)[0]");
  });
});

// ---------------------------------------------------------------------------
// WI-912: Comparison Is / IsNot → TS === / !==
// ---------------------------------------------------------------------------

describe("WI-912: renderExpr — BinaryOp is / is_not", () => {
  it("renders x is None → (x === null)", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "is",
      left: { type: "Name", name: "x" },
      right: { type: "None" },
    };
    expect(renderExpr(expr)).toBe("(x === null)");
  });

  it("renders x is not None → (x !== null)", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "is_not",
      left: { type: "Name", name: "x" },
      right: { type: "None" },
    };
    expect(renderExpr(expr)).toBe("(x !== null)");
  });

  it("renders override is not None (bs4 _chardet_dammit pattern)", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "is_not",
      left: { type: "Name", name: "override" },
      right: { type: "None" },
    };
    expect(renderExpr(expr)).toBe("(override !== null)");
  });

  it("renders x is y (non-None right) as strict equality", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "is",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    expect(renderExpr(expr)).toBe("(a === b)");
  });

  it("renders x is not y (non-None right) as strict inequality", () => {
    const expr: WireExpr = {
      type: "BinaryOp",
      op: "is_not",
      left: { type: "Name", name: "a" },
      right: { type: "Name", name: "b" },
    };
    expect(renderExpr(expr)).toBe("(a !== b)");
  });

  it("is / is_not do not throw UnsupportedAstError (in ALLOWED_BINARY_OPS)", () => {
    expect(() =>
      renderExpr({
        type: "BinaryOp",
        op: "is",
        left: { type: "Name", name: "x" },
        right: { type: "None" },
      }),
    ).not.toThrow();
    expect(() =>
      renderExpr({
        type: "BinaryOp",
        op: "is_not",
        left: { type: "Name", name: "x" },
        right: { type: "None" },
      }),
    ).not.toThrow();
  });

  it("renders BoolOp with is_not None — bs4 compound guard", () => {
    // isinstance(s, bytes) and override is not None
    const expr: WireExpr = {
      type: "BoolOp",
      op: "and",
      left: {
        type: "Call",
        func: "isinstance",
        args: [
          { type: "Name", name: "s" },
          { type: "Name", name: "bytes" },
        ],
      },
      right: {
        type: "BinaryOp",
        op: "is_not",
        left: { type: "Name", name: "override" },
        right: { type: "None" },
      },
    };
    expect(renderExpr(expr)).toBe("(isinstance(s, bytes) && (override !== null))");
  });
});

// ---------------------------------------------------------------------------
// WI-913: Tuple value → TS array literal
// ---------------------------------------------------------------------------

describe("WI-913: renderExpr — Tuple", () => {
  it("renders empty tuple () → []", () => {
    const expr: WireExpr = { type: "Tuple", elements: [] };
    expect(renderExpr(expr)).toBe("[]");
  });

  it("renders single-element tuple (a,) → [a]", () => {
    const expr: WireExpr = {
      type: "Tuple",
      elements: [{ type: "Name", name: "a" }],
    };
    expect(renderExpr(expr)).toBe("[a]");
  });

  it("renders two-element tuple (a, b) → [a, b]", () => {
    const expr: WireExpr = {
      type: "Tuple",
      elements: [
        { type: "Name", name: "a" },
        { type: "Name", name: "b" },
      ],
    };
    expect(renderExpr(expr)).toBe("[a, b]");
  });

  it("renders tuple with integer elements (0, 1, 2) → [0, 1, 2]", () => {
    const expr: WireExpr = {
      type: "Tuple",
      elements: [
        { type: "Integer", value: "0" },
        { type: "Integer", value: "1" },
        { type: "Integer", value: "2" },
      ],
    };
    expect(renderExpr(expr)).toBe("[0, 1, 2]");
  });

  it("renders nested tuple ((a, b), c) → [[a, b], c]", () => {
    const inner: WireExpr = {
      type: "Tuple",
      elements: [
        { type: "Name", name: "a" },
        { type: "Name", name: "b" },
      ],
    };
    const outer: WireExpr = {
      type: "Tuple",
      elements: [inner, { type: "Name", name: "c" }],
    };
    expect(renderExpr(outer)).toBe("[[a, b], c]");
  });
});

// ---------------------------------------------------------------------------
// WI-911+912+913: compound production sequence — bs4 raise functions
// Exercises the real production sequence crossing all three new boundaries:
// Subscript for obj[key] access, is/is_not for identity checks, Tuple for
// multi-value returns. This is the compound-interaction test required by
// the implementer contract.
// ---------------------------------------------------------------------------

describe("WI-911+912+913: compound interaction — bs4 production sequence", () => {
  it("renders _chardet_dammit-style body with is_not None guard + subscript arg", () => {
    // Python:
    //   if override is not None:
    //     return s.decode(override[0])
    //   return s.decode("utf-8")
    const stmts: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: "is_not",
          left: { type: "Name", name: "override" },
          right: { type: "None" },
        },
        body: [
          {
            type: "Return",
            value: {
              type: "Call",
              func: "s.decode",
              args: [
                {
                  type: "Subscript",
                  value: { type: "Name", name: "override" },
                  slice: { type: "Integer", value: "0" },
                },
              ],
            },
          },
        ],
        orelse: [],
      },
      {
        type: "Return",
        value: {
          type: "Call",
          func: "s.decode",
          args: [{ type: "String", value: "utf-8" }],
        },
      },
    ];
    const out = renderBody(stmts);
    expect(out).toContain("(override !== null)");
    expect(out).toContain("s.decode(override[0])");
    expect(out).toContain('s.decode("utf-8")');
  });

  it("renders _invert-style body: Return(Tuple) — tuple swap", () => {
    // Python: return (v, k)
    const stmts: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "Tuple",
          elements: [
            { type: "Name", name: "v" },
            { type: "Name", name: "k" },
          ],
        },
      },
    ];
    const out = renderBody(stmts);
    expect(out).toBe("  return [v, k];");
  });

  it('renders subscript keys packed into a Tuple — (obj["name"], obj["val"])', () => {
    const expr: WireExpr = {
      type: "Tuple",
      elements: [
        {
          type: "Subscript",
          value: { type: "Name", name: "obj" },
          slice: { type: "String", value: "name" },
        },
        {
          type: "Subscript",
          value: { type: "Name", name: "obj" },
          slice: { type: "String", value: "val" },
        },
      ],
    };
    expect(renderExpr(expr)).toBe('[obj["name"], obj["val"]]');
  });
});
