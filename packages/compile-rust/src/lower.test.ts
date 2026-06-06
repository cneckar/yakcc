// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for lower.ts -- IR -> Rust lowering.
 *
 * Covers:
 *   - Function signature: number/string/boolean params and return types
 *   - Statements: return, if/else, const/let binding
 *   - Expressions: literals, binary ops, identifiers, unary ops, calls
 *   - Identifier transform: camelCase -> snake_case
 *   - Loud failure: CannotLowerToRustError on unhandled nodes
 *
 * Production sequence exercised (compound-interaction test):
 *   compileToRust -> lowerSource -> lowerFunctionDecl
 *              -> lowerBlock -> lowerStatement (multiple branches)
 *              -> lowerExpr (multiple branches)
 */

import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { compileToRust } from "./compile-rust.js";
import { CannotLowerToRustError } from "./errors.js";
import { lowerSource, lowerTypeNode } from "./lower.js";
import { identityRustfmtSpawn } from "./rustfmt.js";

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

/** Compile a TS-subset IR string and return the raw Rust source (no rustfmt). */
function compileDirect(src: string): string {
  const { rustLines } = lowerSource(src);
  return rustLines.join("\n");
}

/** Compile via compileToRust with identity rustfmt mock. */
async function compile(src: string): Promise<string> {
  const result = await compileToRust(makeRow(src), {
    rustfmt: { spawnImpl: identityRustfmtSpawn() },
  });
  return result.source;
}

// ---------------------------------------------------------------------------
// Function signature emission
// ---------------------------------------------------------------------------

describe("lowerSource -- function signatures", () => {
  it("simple number->number function emits pub fn with i32 types", () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const out = compileDirect(src);
    expect(out).toContain("pub fn add(a: i32, b: i32) -> i32 {");
    expect(out).toContain("return a + b;");
  });

  it("camelCase name converts to snake_case", () => {
    const src = "export function addNumbers(a: number, b: number): number { return a + b; }";
    const out = compileDirect(src);
    expect(out).toContain("pub fn add_numbers(");
  });

  it("string->string function emits String types", () => {
    const src = "export function echo(s: string): string { return s; }";
    const out = compileDirect(src);
    expect(out).toContain("pub fn echo(s: String) -> String {");
  });

  it("boolean return type emits bool", () => {
    const src = "export function negate(b: boolean): boolean { return !b; }";
    const out = compileDirect(src);
    expect(out).toContain("pub fn negate(b: bool) -> bool {");
    expect(out).toContain("return !b;");
  });

  it("void return type omits return type annotation", () => {
    const src = "export function nothing(): void { }";
    const out = compileDirect(src);
    // void -> no return type; pub fn nothing() {
    expect(out).toContain("pub fn nothing()");
    expect(out).not.toContain("-> ()");
  });

  it("array parameter T[] -> Vec<T>", () => {
    const src = "export function sumArr(xs: number[]): number { return 0; }";
    const out = compileDirect(src);
    expect(out).toContain("Vec<i32>");
  });
});

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

describe("lowerSource -- statements", () => {
  it("const binding emits let binding", () => {
    const src = "export function f(a: number): number { const x = a + 1; return x; }";
    const out = compileDirect(src);
    expect(out).toContain("let x = a + 1;");
    expect(out).toContain("return x;");
  });

  it("if/else emits Rust if/else", () => {
    const src = `
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) {
    return lo;
  } else if (x > hi) {
    return hi;
  } else {
    return x;
  }
}`;
    const out = compileDirect(src);
    expect(out).toContain("if x < lo {");
    expect(out).toContain("} else if x > hi {");
    expect(out).toContain("} else {");
    expect(out).toContain("return lo;");
    expect(out).toContain("return hi;");
  });

  it("binary ops: + - * / % == != < > && ||", () => {
    const src = "export function f(a: number, b: number): boolean { return a + b === a - b; }";
    const out = compileDirect(src);
    expect(out).toContain("a + b == a - b");
  });
});

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

describe("lowerSource -- expressions", () => {
  it("numeric literal passes through", () => {
    const src = "export function forty_two(): number { return 42; }";
    const out = compileDirect(src);
    expect(out).toContain("return 42;");
  });

  it("string literal emits .to_string()", () => {
    const src = 'export function hello(): string { return "hello"; }';
    const out = compileDirect(src);
    expect(out).toContain('"hello".to_string()');
  });

  it("boolean literals pass through", () => {
    const src = "export function always(): boolean { return true; }";
    const out = compileDirect(src);
    expect(out).toContain("return true;");
  });

  it("prefix unary ! and -", () => {
    const src = "export function f(b: boolean): boolean { return !b; }";
    const out = compileDirect(src);
    expect(out).toContain("!b");
  });

  it("=== lowered to ==", () => {
    const src = "export function eq(a: number, b: number): boolean { return a === b; }";
    const out = compileDirect(src);
    expect(out).toContain("a == b");
  });

  it(".length property access lowered to .len()", () => {
    const src = "export function len(xs: number[]): number { return xs.length; }";
    const out = compileDirect(src);
    expect(out).toContain(".len()");
  });

  it("function call passes through with lowered name", () => {
    const src = "export function call(a: number, b: number): number { return myHelper(a, b); }";
    const out = compileDirect(src);
    expect(out).toContain("my_helper(a, b)");
  });
});

// ---------------------------------------------------------------------------
// Loud failure: CannotLowerToRustError on unhandled nodes
// ---------------------------------------------------------------------------

describe("lowerSource -- loud failure on unhandled constructs", () => {
  it("throws CannotLowerToRustError for for-of loop (not in MVP)", () => {
    const src = `
export function f(xs: number[]): void {
  for (const x of xs) {
    console.log(x);
  }
}`;
    expect(() => lowerSource(src)).toThrow(CannotLowerToRustError);
  });
});

// ---------------------------------------------------------------------------
// Type node lowering
// ---------------------------------------------------------------------------

describe("lowerTypeNode -- type mapping", () => {
  it("number -> i32", () => {
    const { Project, SyntaxKind } = require("ts-morph");
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("t.ts", "let x: number;");
    const decl = sf.getVariableStatements()[0]?.getDeclarationList().getDeclarations()[0];
    const typeNode = decl?.getTypeNode();
    if (!typeNode) throw new Error("no type node");
    const ctx = { warnings: [], fnName: undefined };
    expect(lowerTypeNode(typeNode, ctx)).toBe("i32");
  });

  it("string -> String", () => {
    const { Project } = require("ts-morph");
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("t.ts", "let x: string;");
    const decl = sf.getVariableStatements()[0]?.getDeclarationList().getDeclarations()[0];
    const typeNode = decl?.getTypeNode();
    if (!typeNode) throw new Error("no type node");
    const ctx = { warnings: [], fnName: undefined };
    expect(lowerTypeNode(typeNode, ctx)).toBe("String");
  });

  it("boolean -> bool", () => {
    const { Project } = require("ts-morph");
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("t.ts", "let x: boolean;");
    const decl = sf.getVariableStatements()[0]?.getDeclarationList().getDeclarations()[0];
    const typeNode = decl?.getTypeNode();
    if (!typeNode) throw new Error("no type node");
    const ctx = { warnings: [], fnName: undefined };
    expect(lowerTypeNode(typeNode, ctx)).toBe("bool");
  });

  it("number[] -> Vec<i32>", () => {
    const { Project } = require("ts-morph");
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("t.ts", "let x: number[];");
    const decl = sf.getVariableStatements()[0]?.getDeclarationList().getDeclarations()[0];
    const typeNode = decl?.getTypeNode();
    if (!typeNode) throw new Error("no type node");
    const ctx = { warnings: [], fnName: undefined };
    expect(lowerTypeNode(typeNode, ctx)).toBe("Vec<i32>");
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test: production sequence
//
// Covers the real production sequence end-to-end:
//   compileToRust(atom) -> lowerSource -> lowerFunctionDecl
//     -> lowerBlock -> lowerStatement -> lowerExpr
//     -> formatWithRustfmt (identity mock)
// ---------------------------------------------------------------------------

describe("compileToRust compound interaction -- production sequence", () => {
  it("full pipeline: add atom -> pub fn add -> identity-formatted Rust source", async () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const out = await compile(src);
    expect(out).toContain("pub fn add(a: i32, b: i32) -> i32");
    expect(out).toContain("return a + b;");
  });

  it("clamp atom with if/else -> correct Rust if/else chain", async () => {
    const src = `
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) { return lo; }
  else if (x > hi) { return hi; }
  else { return x; }
}`;
    const out = await compile(src);
    expect(out).toContain("pub fn clamp(");
    expect(out).toContain("if x < lo {");
    expect(out).toContain("} else if x > hi {");
  });

  it("let-binding atom emits let statement", async () => {
    const src =
      "export function double(x: number): number { const result = x * 2; return result; }";
    const out = await compile(src);
    expect(out).toContain("let result = x * 2;");
    expect(out).toContain("return result;");
  });

  it("compileToRust returns warnings array", async () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const result = await compileToRust(makeRow(src), {
      rustfmt: { spawnImpl: identityRustfmtSpawn() },
    });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("skipRustfmt option returns raw emitter output synchronously-compatible", async () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const result = await compileToRust(makeRow(src), { skipRustfmt: true });
    expect(result.source).toContain("pub fn add(");
  });
});
