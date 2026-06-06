// SPDX-License-Identifier: Apache-2.0
//
// raise-function.test.ts -- unit tests for the IR render layer (WI-868 slice 1).

import { describe, expect, it } from "vitest";
import type { FunctionSignature } from "./parse-fn-signature.js";
import { renderFunctionDeclaration, renderSignatureType } from "./raise-function.js";

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
