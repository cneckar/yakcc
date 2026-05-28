// SPDX-License-Identifier: MIT
//
// Tests for raise-function.ts — full TS function declaration rendering
// (WI-782 slice 2b).

import { describe, expect, it } from "vitest";
import type { FunctionSignature } from "./parse-fn-signature.js";
import type { WireStmt } from "./raise-body.js";
import { renderFunctionDeclaration } from "./raise-function.js";

function sig(over: Partial<FunctionSignature> = {}): FunctionSignature {
  return {
    name: "fn",
    params: [],
    returnType: "void",
    pythonReturnAnnotation: "None",
    bodyPythonSource: "",
    ...over,
  };
}

describe("renderFunctionDeclaration", () => {
  it("renders zero-param function", () => {
    const out = renderFunctionDeclaration(sig({ name: "noop", returnType: "void" }), [
      { type: "Pass" },
    ]);
    expect(out).toBe("export function noop(): void {\n  void 0;\n}");
  });

  it("renders typed add function with return binop", () => {
    const s = sig({
      name: "add",
      params: [
        { name: "x", tsType: "number", pythonAnnotation: "int" },
        { name: "y", tsType: "number", pythonAnnotation: "int" },
      ],
      returnType: "number",
      pythonReturnAnnotation: "int",
    });
    const body: WireStmt[] = [
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
    expect(renderFunctionDeclaration(s, body)).toBe(
      "export function add(x: number, y: number): number {\n  return (x + y);\n}",
    );
  });

  it("renders empty body as void 0;", () => {
    const out = renderFunctionDeclaration(sig({ name: "stub", returnType: "void" }), []);
    expect(out).toContain("void 0;");
  });

  it("renders complex param + return types verbatim from signature", () => {
    const s = sig({
      name: "lookup",
      params: [{ name: "key", tsType: "string", pythonAnnotation: "str" }],
      returnType: "number | null",
    });
    const out = renderFunctionDeclaration(s, [{ type: "Return", value: { type: "None" } }]);
    expect(out).toBe("export function lookup(key: string): number | null {\n  return null;\n}");
  });
});
