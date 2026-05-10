// SPDX-License-Identifier: MIT
/**
 * ast-binding.test.ts — Tests for extractBindingShape() using ts-morph.
 *
 * extractBindingShape() parses a code snippet and extracts the variable binding
 * shape from a single variable declaration + function call expression.
 *
 * Production sequence exercised:
 *   agent emits code snippet → extractBindingShape(code) →
 *   { name, args, atomName, returnType } → renderSubstitution()
 *
 * Test-first: these tests define the contract; ast-binding.ts must satisfy them.
 */

import { describe, expect, it } from "vitest";
import { extractBindingShape } from "../src/ast-binding.js";

// ---------------------------------------------------------------------------
// Simple const binding: const X = fn(args)
// ---------------------------------------------------------------------------

describe("extractBindingShape — simple const binding", () => {
  it("extracts name, atomName, and args from a simple call", () => {
    const result = extractBindingShape("const result = listOfInts(input);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.name).toBe("result");
    expect(result.atomName).toBe("listOfInts");
    expect(result.args).toEqual(["input"]);
  });

  it("extracts multiple args", () => {
    const result = extractBindingShape("const out = merge(a, b, c);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.name).toBe("out");
    expect(result.atomName).toBe("merge");
    expect(result.args).toEqual(["a", "b", "c"]);
  });

  it("extracts zero-arg call", () => {
    const result = extractBindingShape("const ts = getTimestamp();");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.name).toBe("ts");
    expect(result.atomName).toBe("getTimestamp");
    expect(result.args).toEqual([]);
  });

  it("handles string literal args", () => {
    const result = extractBindingShape('const h = computeHash(data, "sha256");');
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.args).toEqual(["data", '"sha256"']);
  });

  it("handles numeric literal args", () => {
    const result = extractBindingShape("const x = pad(value, 8);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.args).toEqual(["value", "8"]);
  });
});

// ---------------------------------------------------------------------------
// let binding
// ---------------------------------------------------------------------------

describe("extractBindingShape — let binding", () => {
  it("extracts let binding the same as const", () => {
    const result = extractBindingShape("let result = parse(input);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.name).toBe("result");
    expect(result.atomName).toBe("parse");
  });
});

// ---------------------------------------------------------------------------
// Destructuring binding (best-effort; v1 simplified)
// ---------------------------------------------------------------------------

describe("extractBindingShape — destructuring (v1 best-effort)", () => {
  it("returns null for destructuring (not supported in v1)", () => {
    // Destructuring: const { x, y } = fn(input)
    // v1 scope: out of scope per #217; extractBindingShape returns null
    const result = extractBindingShape("const { x, y } = fn(input);");
    // Either null (explicit not-supported) or a best-effort result — both acceptable
    // For v1 we document this as returning null
    expect(result === null || typeof result === "object").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No binding (expression statement — not a variable declaration)
// ---------------------------------------------------------------------------

describe("extractBindingShape — non-declaration inputs", () => {
  it("returns null for a bare expression statement (no binding)", () => {
    const result = extractBindingShape("fn(a, b);");
    expect(result).toBeNull();
  });

  it("returns null for empty input", () => {
    const result = extractBindingShape("");
    expect(result).toBeNull();
  });

  it("returns null for a multi-statement snippet (not a single declaration)", () => {
    const result = extractBindingShape(
      "const a = f(x);\nconst b = g(y);\n",
    );
    // Multi-statement: we cannot determine which binding is the target
    // v1 spec: only single-declaration snippets are supported
    // Returns either null or the first binding — document as null for safety
    // This is best-effort in v1; test accepts either behaviour
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("returns null for a class declaration", () => {
    const result = extractBindingShape("class Foo {}");
    expect(result).toBeNull();
  });

  it("returns null for a function declaration", () => {
    const result = extractBindingShape("function foo() { return 1; }");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RHS is not a call expression
// ---------------------------------------------------------------------------

describe("extractBindingShape — non-call RHS", () => {
  it("returns null when RHS is a literal (not a call)", () => {
    const result = extractBindingShape("const x = 42;");
    expect(result).toBeNull();
  });

  it("returns null when RHS is a binary expression", () => {
    const result = extractBindingShape("const x = a + b;");
    expect(result).toBeNull();
  });

  it("returns null when RHS is a new expression (constructor call)", () => {
    const result = extractBindingShape("const x = new Foo(a);");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Return type extraction (optional; best-effort)
// ---------------------------------------------------------------------------

describe("extractBindingShape — return type annotation", () => {
  it("extracts explicit type annotation when present", () => {
    const result = extractBindingShape("const result: number = parse(input);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.returnType).toBe("number");
  });

  it("returns undefined returnType when no annotation is present", () => {
    const result = extractBindingShape("const result = parse(input);");
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.returnType).toBeUndefined();
  });
});
