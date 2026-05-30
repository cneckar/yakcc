// SPDX-License-Identifier: MIT
//
// raise-function.test.ts — unit tests for raise-function.ts (WI-870 slice 2).
//
// Verifies the composition of parse-fn-signature (slice-1 surface) +
// raise-body (slice-2 body raiser) into a full TS-subset IR function
// declaration, mirroring shave-python's raise-function.test.ts.

import { describe, expect, it } from "vitest";
import { GoDeferError, GoGoroutineError } from "./errors.js";
import type { GoAstBodyNode } from "./go-ast-parser.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import { renderFunctionDeclaration } from "./raise-function.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sig(over: Partial<FunctionSignature> = {}): FunctionSignature {
  return {
    name: "Fn",
    typeParams: [],
    params: [],
    returnTypes: ["void"],
    goReturnTypes: [],
    bodySource: null,
    receiver: null,
    ...over,
  };
}

function emptyBody(): GoAstBodyNode {
  return { stmts: [] };
}

function returnBody(
  expr: GoAstBodyNode["stmts"][number]["type"] extends string ? GoAstBodyNode : never = {
    stmts: [
      {
        type: "ReturnStmt",
        line: 1,
        col: 1,
        results: [{ type: "Ident", line: 1, col: 8, name: "x" }],
      },
    ],
  },
): GoAstBodyNode {
  return expr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderFunctionDeclaration", () => {
  it("renders a void zero-param function with empty body as void 0;", () => {
    const out = renderFunctionDeclaration(
      sig({ name: "Noop", returnTypes: ["void"] }),
      emptyBody(),
    );
    expect(out).toBe("export function Noop(): void {\n  void 0;\n}");
  });

  it("renders a function with params and single return type", () => {
    const s = sig({
      name: "Add",
      params: [
        { name: "a", tsType: "number", goType: "int" },
        { name: "b", tsType: "number", goType: "int" },
      ],
      returnTypes: ["number"],
    });
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
    const out = renderFunctionDeclaration(s, b);
    expect(out).toBe("export function Add(a: number, b: number): number {\n  return (a + b);\n}");
  });

  it("renders multiple return types as a tuple annotation", () => {
    const s = sig({
      name: "Divide",
      params: [
        { name: "n", tsType: "number", goType: "int" },
        { name: "d", tsType: "number", goType: "int" },
      ],
      returnTypes: ["number", "Error"],
    });
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
              op: "/",
              x: { type: "Ident", line: 1, col: 9, name: "n" },
              y: { type: "Ident", line: 1, col: 11, name: "d" },
            },
            { type: "Ident", line: 1, col: 14, name: "nil" },
          ],
        },
      ],
    };
    const out = renderFunctionDeclaration(s, b);
    expect(out).toBe(
      "export function Divide(n: number, d: number): [number, Error] {\n  return [(n / d), nil];\n}",
    );
  });

  it("renders zero return types as void", () => {
    const s = sig({
      name: "LogMsg",
      params: [{ name: "msg", tsType: "string", goType: "string" }],
      returnTypes: [],
    });
    const b: GoAstBodyNode = {
      stmts: [
        {
          type: "ExprStmt",
          line: 1,
          col: 2,
          x: {
            type: "CallExpr",
            line: 1,
            col: 2,
            fun: { type: "Ident", line: 1, col: 2, name: "console.log" },
            args: [{ type: "Ident", line: 1, col: 14, name: "msg" }],
          },
        },
      ],
    };
    const out = renderFunctionDeclaration(s, b);
    expect(out).toContain(": void {");
  });

  it("propagates GoDeferError from raise-body through raise-function", () => {
    const s = sig({ name: "LeakyFn" });
    const b: GoAstBodyNode = {
      stmts: [{ type: "DeferStmt", line: 2, col: 3 }],
    };
    expect(() => renderFunctionDeclaration(s, b)).toThrow(GoDeferError);
  });

  it("propagates GoGoroutineError from raise-body through raise-function", () => {
    const s = sig({ name: "Concurrent" });
    const b: GoAstBodyNode = {
      stmts: [{ type: "GoStmt", line: 3, col: 2 }],
    };
    expect(() => renderFunctionDeclaration(s, b)).toThrow(GoGoroutineError);
  });

  // ---------
  // Round-trip: the canonical acceptance test required by the evaluation contract.
  // Go function with a body (return + binop + literal) raised through
  // raise-function.ts into TS-subset IR text.
  // ---------
  it("round-trip: pure Go Add function with return binop+literal -> TS-subset IR", () => {
    // Represents: func Add(x int, y int) int { return x + y }
    const signature = sig({
      name: "Add",
      params: [
        { name: "x", tsType: "number", goType: "int" },
        { name: "y", tsType: "number", goType: "int" },
      ],
      returnTypes: ["number"],
      goReturnTypes: ["int"],
    });
    const body: GoAstBodyNode = {
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
              x: { type: "Ident", line: 1, col: 9, name: "x" },
              y: { type: "Ident", line: 1, col: 13, name: "y" },
            },
          ],
        },
      ],
    };
    const out = renderFunctionDeclaration(signature, body);
    expect(out).toBe("export function Add(x: number, y: number): number {\n  return (x + y);\n}");
    // Verify it is a valid TS export function declaration shape
    expect(out).toMatch(/^export function Add/);
    expect(out).toMatch(/return \(x \+ y\);/);
  });

  it("round-trip: literal-only return (return 42) -> TS-subset IR", () => {
    const signature = sig({
      name: "Const",
      returnTypes: ["number"],
    });
    const body: GoAstBodyNode = {
      stmts: [
        {
          type: "ReturnStmt",
          line: 1,
          col: 2,
          results: [{ type: "BasicLit", line: 1, col: 9, kind: "INT", value: "42" }],
        },
      ],
    };
    const out = renderFunctionDeclaration(signature, body);
    expect(out).toBe("export function Const(): number {\n  return 42;\n}");
  });
});
