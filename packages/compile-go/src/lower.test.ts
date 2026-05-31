// SPDX-License-Identifier: MIT
/**
 * Unit tests for lower.ts -- IR -> Go lowering.
 *
 * Covers:
 *   - Function signature: number/string/boolean params and return types
 *   - Generic function: <T, R> -> [T, R any]
 *   - Statements: return, if/else, const/let := , for-of (range), while
 *   - Expressions: literals, binary ops, identifiers, property access (len)
 *   - Loud failure: CannotLowerToGoError on unhandled nodes
 *
 * Production sequence exercised:
 *   compileToGo -> lowerSource -> lowerFunctionDecl
 *              -> lowerBlock -> lowerStatement (multiple branches)
 *              -> lowerExpr (multiple branches)
 */

import { CannotLowerToGoError } from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";
import { compileToGo } from "./compile-go.js";
import { lowerSource, lowerTypeNode } from "./lower.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(implSource: string): BlockTripletRow {
  return {
    blockMerkleRoot: "dead" as BlockMerkleRoot,
    specHash: "dead" as SpecHash,
    specCanonicalBytes: new Uint8Array(),
    implSource,
    proofManifestJson: "{}",
    level: "L0",
    createdAt: 0,
    canonicalAstHash: "dead" as CanonicalAstHash,
    artifacts: new Map(),
  };
}

/** Compile a TS-subset IR string and return the Go source. */
function compile(src: string, pkg = "yakcc"): string {
  return compileToGo(makeRow(src), { packageName: pkg }).source;
}

// ---------------------------------------------------------------------------
// Function signature emission
// ---------------------------------------------------------------------------

describe("lowerSource — function signatures", () => {
  it("simple number->number function emits exported Go func", () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const out = compile(src);
    expect(out).toContain("func Add(a int, b int) int {");
    expect(out).toContain("return a + b");
    expect(out).toContain("package yakcc");
  });

  it("string->string function emits string types", () => {
    const src = "export function echo(s: string): string { return s; }";
    const out = compile(src);
    expect(out).toContain("func Echo(s string) string {");
  });

  it("boolean return type", () => {
    const src = "export function negate(b: boolean): boolean { return !b; }";
    const out = compile(src);
    expect(out).toContain("func Negate(b bool) bool {");
    expect(out).toContain("return !b");
  });

  it("void return type emits no return type annotation", () => {
    const src = "export function nothing(): void { }";
    const out = compile(src);
    // void -> no return type suffix (empty string)
    expect(out).toContain("func Nothing() {");
  });

  it("array type T[] -> []T", () => {
    const src = "export function wrap(x: number): number[] { return [x]; }";
    const out = compile(src);
    expect(out).toContain("func Wrap(x int) []int {");
  });

  it("Record<string, number> -> map[string]int", () => {
    // Only test the signature (return type mapping);
    // body uses a variable to avoid ObjectLiteralExpression which is not in MVP scope
    const src = `export function getMap(m: Record<string, number>): Record<string, number> {
  return m;
}`;
    const out = compile(src);
    expect(out).toContain("func GetMap(m map[string]int) map[string]int {");
  });
});

// ---------------------------------------------------------------------------
// Generic function emission
// ---------------------------------------------------------------------------

describe("lowerSource — generic functions", () => {
  it("single type param <T> -> [T any]", () => {
    const src = "export function identity<T>(x: T): T { return x; }";
    const out = compile(src);
    expect(out).toContain("func Identity[T any](x T) T {");
  });

  it("two type params <T, R> -> [T, R any]", () => {
    const src = "export function transform<T, R>(x: T, fn: R): R { return fn; }";
    const out = compile(src);
    expect(out).toContain("func Transform[T, R any](x T, fn R) R {");
  });
});

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

describe("lowerSource — statements", () => {
  it("const declaration lowered to :=", () => {
    const src = "export function square(x: number): number { const y = x * x; return y; }";
    const out = compile(src);
    expect(out).toContain("y := x * x");
    expect(out).toContain("return y");
  });

  it("if/else lowered to Go if/else", () => {
    const src = `export function max2(a: number, b: number): number {
  if (a > b) { return a; } else { return b; }
}`;
    const out = compile(src);
    expect(out).toContain("if a > b {");
    expect(out).toContain("} else {");
    expect(out).toContain("return a");
    expect(out).toContain("return b");
  });

  it("for-of lowered to range", () => {
    const src = `export function sumArr(xs: number[]): number {
  let total = 0;
  for (const x of xs) { total = total + x; }
  return total;
}`;
    const out = compile(src);
    expect(out).toContain("for _, x := range xs {");
    expect(out).toContain("total = total + x");
  });

  it("while lowered to for-cond", () => {
    const src = `export function countdown(n: number): number {
  while (n > 0) { n = n - 1; }
  return n;
}`;
    const out = compile(src);
    expect(out).toContain("for n > 0 {");
    expect(out).toContain("n = n - 1");
  });
});

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

describe("lowerSource — expressions", () => {
  it("numeric literals pass through", () => {
    const src = "export function forty(): number { return 42; }";
    const out = compile(src);
    expect(out).toContain("return 42");
  });

  it("string literals pass through (double-quoted)", () => {
    const src = `export function hello(): string { return "world"; }`;
    const out = compile(src);
    expect(out).toContain(`return "world"`);
  });

  it("true/false -> true/false", () => {
    const src = "export function yes(): boolean { return true; }";
    const out = compile(src);
    expect(out).toContain("return true");
  });

  it("binary operators: +, -, *, /, %", () => {
    const src = "export function arith(a: number, b: number): number { return a + b - 1; }";
    const out = compile(src);
    expect(out).toContain("return a + b - 1");
  });

  it("comparison operators === -> ==", () => {
    const src = "export function eq(a: number, b: number): boolean { return a === b; }";
    const out = compile(src);
    expect(out).toContain("return a == b");
  });

  it("prefix ! -> !", () => {
    const src = "export function not(b: boolean): boolean { return !b; }";
    const out = compile(src);
    expect(out).toContain("return !b");
  });

  it(".length -> len()", () => {
    const src = "export function size(xs: number[]): number { return xs.length; }";
    const out = compile(src);
    expect(out).toContain("return len(xs)");
  });
});

// ---------------------------------------------------------------------------
// Loud failure: CannotLowerToGoError
// ---------------------------------------------------------------------------

describe("lowerSource — CannotLowerToGoError on unhandled constructs", () => {
  it("template literal throws CannotLowerToGoError", () => {
    const src = "export function greet(name: string): string { return `Hello, ${name}!`; }";
    expect(() => compile(src)).toThrowError(CannotLowerToGoError);
  });

  it("thrown error names nodeKind and has location", () => {
    const src = "export function greet(name: string): string { return `Hello, ${name}!`; }";
    try {
      compile(src);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotLowerToGoError);
      if (err instanceof CannotLowerToGoError) {
        expect(err.nodeKind.length).toBeGreaterThan(0);
        expect(err.location.line).toBeGreaterThanOrEqual(1);
        expect(err.message).toContain("Cannot lower TS-subset IR to Go");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// lowerTypeNode unit tests
// ---------------------------------------------------------------------------

describe("lowerTypeNode", () => {
  function makeTypeCtx() {
    return { warnings: [], typeParams: [], fnName: undefined };
  }

  function parseTypeNode(tsType: string) {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { strict: true, target: 99, module: 99, skipLibCheck: true },
    });
    const sf = project.createSourceFile("t.ts", `type _T = ${tsType};`);
    const ta = sf.getStatements()[0];
    if (!ta) throw new Error("no statement");
    const typeAlias = ta.asKindOrThrow(SyntaxKind.TypeAliasDeclaration);
    const tn = typeAlias.getTypeNode();
    if (!tn) throw new Error("no type node");
    return tn;
  }

  it("number -> int", () => {
    expect(lowerTypeNode(parseTypeNode("number"), makeTypeCtx())).toBe("int");
  });
  it("string -> string", () => {
    expect(lowerTypeNode(parseTypeNode("string"), makeTypeCtx())).toBe("string");
  });
  it("boolean -> bool", () => {
    expect(lowerTypeNode(parseTypeNode("boolean"), makeTypeCtx())).toBe("bool");
  });
  it("number[] -> []int", () => {
    expect(lowerTypeNode(parseTypeNode("number[]"), makeTypeCtx())).toBe("[]int");
  });
  it("Record<string, number> -> map[string]int", () => {
    expect(lowerTypeNode(parseTypeNode("Record<string, number>"), makeTypeCtx())).toBe(
      "map[string]int",
    );
  });
  it("void -> empty string", () => {
    expect(lowerTypeNode(parseTypeNode("void"), makeTypeCtx())).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Package name option
// ---------------------------------------------------------------------------

describe("compileToGo — package name option", () => {
  it("default package is yakcc", () => {
    const src = "export function id(x: number): number { return x; }";
    const out = compile(src);
    expect(out.startsWith("package yakcc\n")).toBe(true);
  });

  it("custom package name respected", () => {
    const src = "export function id(x: number): number { return x; }";
    const out = compile(src, "mypackage");
    expect(out.startsWith("package mypackage\n")).toBe(true);
  });
});
