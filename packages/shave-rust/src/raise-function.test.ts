// SPDX-License-Identifier: Apache-2.0
//
// raise-function.test.ts -- unit tests for the IR render layer (WI-868 slice 1).

import { describe, expect, it } from "vitest";
import { RustIoSideEffectError, RustMutableBorrowError } from "./errors.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import { renderFunctionDeclaration, renderSignatureType } from "./raise-function.js";
import type { RustAstBodyNode } from "./rust-ast-parser.js";

function sig(overrides: Partial<FunctionSignature> = {}): FunctionSignature {
  return {
    name: "add",
    rustName: "add",
    isPub: true,
    params: [
      { name: "a", tsType: "number", rustType: "i32" },
      { name: "b", tsType: "number", rustType: "i32" },
    ],
    returnType: "number",
    rustReturnType: "i32",
    bodySource: "a + b",
    // Slice 2: default to null body (void-body placeholder path) for existing
    // signature-only tests that don't care about the body raise output.
    body: null,
    ...overrides,
  };
}

describe("renderFunctionDeclaration", () => {
  it("renders an export function declaration with correct signature", () => {
    const out = renderFunctionDeclaration(sig());
    expect(out).toContain("export function add");
    expect(out).toContain("a: number, b: number");
    expect(out).toContain(": number {");
  });

  it("uses void-body placeholder for null-body functions (extern/trait methods)", () => {
    // body: null -> no block body -> emit `void 0;` placeholder
    const out = renderFunctionDeclaration(sig({ body: null }));
    expect(out).toContain("void 0;");
  });

  it("renders void return for a function with no return", () => {
    const out = renderFunctionDeclaration(
      sig({ name: "noop", params: [], returnType: "void", rustReturnType: "" }),
    );
    expect(out).toContain(": void {");
  });

  it("renders snake_case-derived camelCase name", () => {
    const out = renderFunctionDeclaration(sig({ name: "getUserId", rustName: "get_user_id" }));
    expect(out).toContain("export function getUserId");
  });

  it("renders function with no params", () => {
    const out = renderFunctionDeclaration(
      sig({ name: "pi", params: [], returnType: "number", rustReturnType: "f64" }),
    );
    expect(out).toMatch(/export function pi\(\): number \{/);
  });

  it("renders function with string param and return", () => {
    const out = renderFunctionDeclaration(
      sig({
        name: "greet",
        params: [{ name: "name", tsType: "string", rustType: "String" }],
        returnType: "string",
        rustReturnType: "String",
      }),
    );
    expect(out).toContain("name: string");
    expect(out).toContain(": string {");
  });

  it("wraps cleanly in braces", () => {
    const out = renderFunctionDeclaration(sig());
    expect(out).toMatch(/^\s*export function .+\{[\s\S]+\}\s*$/);
  });
});

describe("renderSignatureType", () => {
  it("renders arrow type for the signature", () => {
    const out = renderSignatureType(sig());
    expect(out).toBe("(a: number, b: number) => number");
  });

  it("renders void arrow type", () => {
    const out = renderSignatureType(sig({ params: [], returnType: "void", rustReturnType: "" }));
    expect(out).toBe("() => void");
  });
});

// ---------------------------------------------------------------------------
// Purity gate in renderFunctionDeclaration (slice 3)
//
// checkPurity fires BEFORE renderBody so impure functions never produce IR.
// ---------------------------------------------------------------------------

describe("renderFunctionDeclaration — purity gate", () => {
  it("throws RustMutableBorrowError for &mut T param before any body render", () => {
    const s = sig({
      params: [{ name: "x", tsType: "number", rustType: "&mut i32" }],
    });
    expect(() => renderFunctionDeclaration(s)).toThrow(RustMutableBorrowError);
  });

  it("throws RustIoSideEffectError for println! in body", () => {
    const printlnBody: RustAstBodyNode = {
      stmts: [
        {
          type: "UnsupportedStmt",
          reason: "Expr::Macro (println!)",
          line: 2,
          col: 3,
        },
      ],
    };
    const s = sig({
      params: [],
      returnType: "void",
      rustReturnType: "",
      body: printlnBody,
    });
    expect(() => renderFunctionDeclaration(s)).toThrow(RustIoSideEffectError);
  });

  it("passes a pure fn add(a: i32, b: i32)->i32 through the purity gate", () => {
    const pureBody: RustAstBodyNode = {
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
    const s = sig({ body: pureBody });
    const out = renderFunctionDeclaration(s);
    // Pure fn passes the gate and produces correct IR.
    expect(out).toBe("export function add(a: number, b: number): number {\n  return (a + b);\n}");
  });
});
