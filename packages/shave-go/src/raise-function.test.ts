// SPDX-License-Identifier: MIT
//
// raise-function.test.ts — unit tests for raise-function.ts (WI-870 slice 2).
//
// Verifies the composition of parse-fn-signature (slice-1 surface) +
// raise-body (slice-2 body raiser) into a full TS-subset IR function
// declaration, mirroring shave-python's raise-function.test.ts.

import { describe, expect, it } from "vitest";
import { GoDeferError, GoGoroutineError } from "./errors.js";
import type { GoAstBodyNode, GoAstParseResult } from "./go-ast-parser.js";
import { extractFunctionSignatures } from "./parse-fn-signature.js";
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

  // ---------------------------------------------------------------------------
  // WI-963: generic type parameters emitted in TS signature
  // ---------------------------------------------------------------------------

  it("WI-963: Identity[T any] -> export function identity<T>(x: T): T", () => {
    // func Identity[T any](x T) T { return x }
    const signature = sig({
      name: "identity",
      typeParams: [{ name: "T", constraint: "any" }],
      params: [{ name: "x", tsType: "T", goType: "T" }],
      returnTypes: ["T"],
    });
    const body: GoAstBodyNode = {
      stmts: [
        {
          type: "ReturnStmt",
          line: 1,
          col: 2,
          results: [{ type: "Ident", line: 1, col: 9, name: "x" }],
        },
      ],
    };
    const out = renderFunctionDeclaration(signature, body);
    expect(out).toBe("export function identity<T>(x: T): T {\n  return x;\n}");
  });

  it("WI-963: Map[T, R any] -> export function map<T, R>(s: T[], f: (a0: T) => R): R[]", () => {
    // func Map[T, R any](s []T, f func(T) R) []R
    const signature = sig({
      name: "map",
      typeParams: [
        { name: "T", constraint: "any" },
        { name: "R", constraint: "any" },
      ],
      params: [
        { name: "s", tsType: "T[]", goType: "[]T" },
        { name: "f", tsType: "(a0: T) => R", goType: "func(T) R" },
      ],
      returnTypes: ["R[]"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    expect(out).toBe("export function map<T, R>(s: T[], f: (a0: T) => R): R[] {\n  void 0;\n}");
  });

  it("WI-963: non-generic function still emits no type params", () => {
    const signature = sig({
      name: "Add",
      typeParams: [],
      params: [
        { name: "a", tsType: "number", goType: "int" },
        { name: "b", tsType: "number", goType: "int" },
      ],
      returnTypes: ["number"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    // Must NOT contain <>
    expect(out).not.toContain("<");
    expect(out).toContain("export function Add(");
  });

  // ---------------------------------------------------------------------------
  // #976: constraint preservation through shave-go IR
  // ---------------------------------------------------------------------------

  it("#976: Clamp[T constraints.Ordered] -> <T extends Ordered> in TS IR", () => {
    const signature = sig({
      name: "Clamp",
      typeParams: [{ name: "T", constraint: "constraints.Ordered" }],
      params: [
        { name: "value", tsType: "T", goType: "T" },
        { name: "mIn", tsType: "T", goType: "T" },
        { name: "mAx", tsType: "T", goType: "T" },
      ],
      returnTypes: ["T"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    // Must emit extends Ordered, not bare <T>
    expect(out).toContain("export function Clamp<T extends Ordered>");
    expect(out).not.toContain("<T>");
  });

  it("#976: comparable constraint -> <T extends Comparable>", () => {
    const signature = sig({
      name: "IndexOf",
      typeParams: [{ name: "T", constraint: "comparable" }],
      params: [
        { name: "collection", tsType: "T[]", goType: "[]T" },
        { name: "element", tsType: "T", goType: "T" },
      ],
      returnTypes: ["number"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    expect(out).toContain("<T extends Comparable>");
  });

  it("#976: any constraint -> bare <T> (no extends clause)", () => {
    const signature = sig({
      name: "Identity",
      typeParams: [{ name: "T", constraint: "any" }],
      params: [{ name: "x", tsType: "T", goType: "T" }],
      returnTypes: ["T"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    // `any` maps to empty string -> no extends clause
    expect(out).toContain("<T>");
    expect(out).not.toContain("extends");
  });

  it("#976: custom interface constraint -> extends CustomInterface verbatim", () => {
    const signature = sig({
      name: "Process",
      typeParams: [{ name: "T", constraint: "MyInterface" }],
      params: [{ name: "x", tsType: "T", goType: "T" }],
      returnTypes: ["T"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    expect(out).toContain("<T extends MyInterface>");
  });

  it("#976: tilde type-set ~[]T -> GoConstraint_ encoded form", () => {
    const signature = sig({
      name: "Reverse",
      typeParams: [
        { name: "T", constraint: "any" },
        { name: "Slice", constraint: "~[]T" },
      ],
      params: [{ name: "collection", tsType: "Slice", goType: "Slice" }],
      returnTypes: ["Slice"],
    });
    const out = renderFunctionDeclaration(signature, emptyBody());
    // T any -> <T>, Slice ~[]T -> <Slice extends GoConstraint_Tilde_SliceOf_T>
    expect(out).toContain("T,");
    expect(out).toContain("extends GoConstraint_Tilde_SliceOf_T");
  });

  it("WI-963: compound end-to-end — func Map[T, R any](s []T, f func(T) R) []R raised from envelope", () => {
    // This test exercises the real production sequence:
    //   envelope (wire shape from go-ast-parse.go)
    //   -> extractFunctionSignatures (parse-fn-signature.ts)
    //   -> renderFunctionDeclaration (raise-function.ts)
    // crossing all component boundaries to verify they compose correctly.
    const envelope: GoAstParseResult = {
      version: 2,
      packageName: "lo",
      functions: [
        {
          name: "Map",
          receiver: null,
          typeParams: [
            { name: "T", constraint: "any" },
            { name: "R", constraint: "any" },
          ],
          params: [
            { name: "s", goType: "[]T" },
            { name: "f", goType: "func(T) R" },
          ],
          results: [{ name: "", goType: "[]R" }],
          bodySource: "// body",
          body: null,
        },
      ],
    };

    const sigs = extractFunctionSignatures(envelope);
    expect(sigs).toHaveLength(1);
    // biome: avoid non-null assertion — narrow via expect+assert pattern
    const mapSig = sigs[0];
    expect(mapSig).toBeDefined();
    if (!mapSig) return; // type narrowing for TS
    expect(mapSig.typeParams.map((tp) => tp.name)).toEqual(["T", "R"]);
    expect(mapSig.params[0]?.tsType).toBe("T[]");
    expect(mapSig.params[1]?.tsType).toBe("(a0: T) => R");
    expect(mapSig.returnTypes).toEqual(["R[]"]);

    // Now render — body is null so use emptyBody
    const out = renderFunctionDeclaration(mapSig, { stmts: [] });
    expect(out).toBe("export function Map<T, R>(s: T[], f: (a0: T) => R): R[] {\n  void 0;\n}");
  });
});
