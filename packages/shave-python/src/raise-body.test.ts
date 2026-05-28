// SPDX-License-Identifier: MIT
//
// Tests for raise-body.ts — WireExpr / WireStmt renderers (WI-782 slice 2b).
// Tests build wire envelopes directly; no subprocess.

import { describe, expect, it } from "vitest";
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
