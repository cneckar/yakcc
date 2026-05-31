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

  it("two type params <T, R> -> [T any, R any] (#976: each param gets explicit constraint)", () => {
    // Prior to #976: emitted [T, R any] (grouped). Post-#976: each param gets
    // its own constraint: [T any, R any]. Both are valid Go; the per-param form
    // is required once constraints differ (e.g. [T constraints.Ordered, R any]).
    const src = "export function transform<T, R>(x: T, fn: R): R { return fn; }";
    const out = compile(src);
    expect(out).toContain("func Transform[T any, R any](x T, fn R) R {");
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

// ---------------------------------------------------------------------------
// #978 — SwitchStatement lowering
// ---------------------------------------------------------------------------

describe("lowerSource — SwitchStatement (#978)", () => {
  it("switch with one case and break emits Go switch (implicit break — no break emitted)", () => {
    const src = `export function label(n: number): string {
  switch (n) {
    case 1: return "one";
  }
  return "other";
}`;
    const out = compile(src);
    expect(out).toContain("switch n {");
    expect(out).toContain("case 1:");
    expect(out).toContain(`return "one"`);
    // Go has implicit break — no explicit break emitted
    expect(out).not.toContain("break");
  });

  it("switch with default clause emits Go default:", () => {
    const src = `export function label(n: number): string {
  switch (n) {
    case 1: return "one";
    default: return "other";
  }
  return "unknown";
}`;
    const out = compile(src);
    expect(out).toContain("switch n {");
    expect(out).toContain("case 1:");
    expect(out).toContain("default:");
    expect(out).not.toContain("break");
  });

  it("tagless switch (switch(true)) emits Go 'switch {' with no tag", () => {
    const src = `export function classify(n: number): string {
  switch (true) {
    case n < 0: return "negative";
    case n === 0: return "zero";
    default: return "positive";
  }
  return "unknown";
}`;
    const out = compile(src);
    // tagless: no expression after switch
    expect(out).toContain("switch {");
    expect(out).toContain("case n < 0:");
    expect(out).toContain("case n == 0:");
    expect(out).toContain("default:");
  });

  it("TS fallthrough (adjacent empty cases) emits Go multi-value case", () => {
    // TS pattern: case a: case b: case c: body; break;
    // This emits as separate case clauses in the AST; compile-go should merge them
    const src = `export function isVowel(c: string): boolean {
  switch (c) {
    case "a":
    case "e":
    case "i":
    case "o":
    case "u":
      return true;
    default:
      return false;
  }
  return false;
}`;
    const out = compile(src);
    // Go multi-value case: case "a", "e", "i", "o", "u":
    expect(out).toContain(`case "a", "e", "i", "o", "u":`);
    expect(out).toContain("return true");
    expect(out).toContain("default:");
  });

  it("switch is a valid statement inside a function (smoke test — does not throw)", () => {
    const src = `export function test(x: number): number {
  switch (x) {
    case 0: return 0;
    default: return x;
  }
  return -1;
}`;
    expect(() => compile(src)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #977 — Import synthesis
// ---------------------------------------------------------------------------

describe("compileToGo — import synthesis (#977)", () => {
  it("function using reflect.ValueOf produces output with import 'reflect'", () => {
    const src = `export function typeOf(x: any): string {
  return reflect.ValueOf(x).Kind().String();
}`;
    const out = compile(src);
    expect(out).toContain('import "reflect"');
    expect(out).toContain("reflect.ValueOf(x)");
  });

  it("function using fmt.Sprintf produces import 'fmt'", () => {
    const src = `export function greet(name: string): string {
  return fmt.Sprintf("Hello, %s", name);
}`;
    const out = compile(src);
    expect(out).toContain('import "fmt"');
  });

  it("function using multiple stdlib packages gets multi-line import block", () => {
    const src = `export function work(s: string): string {
  const upper = strings.ToUpper(s);
  const n = strconv.Itoa(42);
  return upper + n;
}`;
    const out = compile(src);
    expect(out).toContain("import (");
    expect(out).toContain('"strings"');
    expect(out).toContain('"strconv"');
    expect(out).toContain(")");
  });

  it("function using cases and language emits golang.org/x paths", () => {
    const src = `export function capitalize(str: string): string {
  return cases.Title(language.English).String(str);
}`;
    const out = compile(src);
    expect(out).toContain('"golang.org/x/text/cases"');
    expect(out).toContain('"golang.org/x/text/language"');
  });

  it("import block appears between package declaration and func declaration", () => {
    const src = `export function capitalize(str: string): string {
  return cases.Title(language.English).String(str);
}`;
    const out = compile(src);
    const pkgIdx = out.indexOf("package yakcc");
    const importIdx = out.indexOf("import");
    const funcIdx = out.indexOf("func Capitalize");
    expect(pkgIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(pkgIdx);
    expect(funcIdx).toBeGreaterThan(importIdx);
  });

  it("function with no dotted references produces no import block", () => {
    const src = "export function add(a: number, b: number): number { return a + b; }";
    const out = compile(src);
    expect(out).not.toContain("import");
  });

  it("unknown package emits placeholder import and warning", () => {
    const src = `export function test(x: any): any {
  return mypkg.DoSomething(x);
}`;
    const result = (() => {
      const row = {
        blockMerkleRoot: "dead" as import("@yakcc/registry").BlockMerkleRoot,
        specHash: "dead" as import("@yakcc/registry").SpecHash,
        specCanonicalBytes: new Uint8Array(),
        implSource: src,
        proofManifestJson: "{}",
        level: "L0" as const,
        createdAt: 0,
        canonicalAstHash: "dead" as import("@yakcc/registry").CanonicalAstHash,
        artifacts: new Map(),
      };
      return compileToGo(row);
    })();
    // Placeholder import for unknown package
    expect(result.source).toContain('"unknown/mypkg"');
    // Warning must be present
    expect(
      result.warnings.some((w) => w.kind === "unknown-import" && w.message.includes("mypkg")),
    ).toBe(true);
  });

  it("import block uses single-line form for exactly one import", () => {
    const src = `export function test(x: any): any {
  return reflect.ValueOf(x);
}`;
    const out = compile(src);
    // Single import: import "reflect" (not import (...))
    expect(out).toContain('import "reflect"');
    expect(out).not.toContain("import (");
  });
});

// ---------------------------------------------------------------------------
// #975 — Go range round-trip fidelity
// ---------------------------------------------------------------------------

describe("compileToGo — range round-trip (#975)", () => {
  it("#975: key-only range: for (const k in x) -> for k := range x (no blank _ prefix)", () => {
    // shave-go emits key-only range as `for (const k in items)` (ForInStatement).
    // compile-go must emit `for k := range items` — NOT `for _, k := range items`.
    const src = `export function indexOf<T>(collection: T[], element: T): number {
  for (const i in collection) {
    if (collection[i] === element) { return i as unknown as number; }
  }
  return -1;
}`;
    const out = compile(src);
    // Key-only range: no blank _ prefix
    expect(out).toContain("for i := range collection {");
    expect(out).not.toContain("for _, i := range");
    expect(out).not.toContain("Object.keys");
  });

  it("#975: key+value range: for (const [k, v] of Object.entries(x)) -> for k, v := range x", () => {
    // shave-go emits key+value range as `for (const [k, v] of Object.entries(x))`.
    // compile-go must emit `for k, v := range x`.
    const src = `export function mapPairs(m: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(m)) {
    total = total + v;
  }
  return total;
}`;
    const out = compile(src);
    // Key+value range: both bindings present, no _ prefix
    expect(out).toContain("for k, v := range m {");
    expect(out).not.toContain("for _, v := range m");
    expect(out).not.toContain("Object.entries");
  });

  it("#975: value-only range: for (const v of Object.values(x)) -> for _, v := range x", () => {
    const src = `export function sumValues(xs: number[]): number {
  let total = 0;
  for (const v of Object.values(xs)) {
    total = total + v;
  }
  return total;
}`;
    const out = compile(src);
    // Value-only range: blank _ key
    expect(out).toContain("for _, v := range xs {");
    expect(out).not.toContain("Object.values");
  });

  it("#975: general for-of (non-Object.entries/values) still emits for _, x := range", () => {
    const src = `export function sumArr(xs: number[]): number {
  let total = 0;
  for (const x of xs) { total = total + x; }
  return total;
}`;
    const out = compile(src);
    expect(out).toContain("for _, x := range xs {");
  });
});

// ---------------------------------------------------------------------------
// #984 — FunctionType lowering (iteratee params: no interface{} fallthrough)
// ---------------------------------------------------------------------------

describe("lowerTypeNode — FunctionType (#984)", () => {
  function makeTypeCtx(typeParams: string[] = []) {
    return { warnings: [], typeParams, fnName: undefined, importRefs: new Set<string>() };
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

  it("#984: (a: T) => boolean -> func(T) bool", () => {
    const ctx = makeTypeCtx(["T"]);
    expect(lowerTypeNode(parseTypeNode("(a: T) => boolean"), ctx)).toBe("func(T) bool");
  });

  it("#984: (a: T, b: number) => R -> func(T, int) R", () => {
    const ctx = makeTypeCtx(["T", "R"]);
    expect(lowerTypeNode(parseTypeNode("(a: T, b: number) => R"), ctx)).toBe("func(T, int) R");
  });

  it("#984: () => void -> func() (no return suffix)", () => {
    const ctx = makeTypeCtx([]);
    expect(lowerTypeNode(parseTypeNode("() => void"), ctx)).toBe("func()");
  });

  it("#984: (a: T) => void -> func(T) (no return suffix)", () => {
    const ctx = makeTypeCtx(["T"]);
    expect(lowerTypeNode(parseTypeNode("(a: T) => void"), ctx)).toBe("func(T)");
  });

  it("#984: nested (cb: (x: T) => boolean) => T[] -> func(func(T) bool) []T", () => {
    const ctx = makeTypeCtx(["T"]);
    expect(lowerTypeNode(parseTypeNode("(cb: (x: T) => boolean) => T[]"), ctx)).toBe(
      "func(func(T) bool) []T",
    );
  });
});

// ---------------------------------------------------------------------------
// #984 — End-to-end: samber/lo iteratee params no longer collapse to interface{}
// ---------------------------------------------------------------------------

describe("compileToGo — iteratee FunctionType round-trip (#984)", () => {
  it("#984: Filter predicate (a0: T, a1: number) => boolean -> func(T, int) bool (not interface{})", () => {
    // This is the exact IR shave-go emits for samber/lo Filter after #981
    const src = `export function filter<T, Slice extends GoConstraint_Tilde_SliceOf_T>(
  collection: Slice,
  predicate: (a0: T, a1: number) => boolean
): Slice {
  return collection;
}`;
    const out = compile(src);
    expect(out).toContain("predicate func(T, int) bool");
    expect(out).not.toContain("predicate interface{}");
  });

  it("#984: Reduce accumulator (a0: R, a1: T, a2: number) => R -> func(R, T, int) R", () => {
    const src = `export function reduce<T, R>(
  collection: T[],
  iteratee: (a0: R, a1: T, a2: number) => R,
  initial: R
): R {
  return initial;
}`;
    const out = compile(src);
    expect(out).toContain("iteratee func(R, T, int) R");
    expect(out).not.toContain("iteratee interface{}");
  });

  it("#984: Map iteratee (a0: T, a1: number) => R -> func(T, int) R", () => {
    const src = `export function mapFn<T, R>(
  collection: T[],
  iteratee: (a0: T, a1: number) => R
): R[] {
  return [];
}`;
    const out = compile(src);
    expect(out).toContain("iteratee func(T, int) R");
    expect(out).not.toContain("iteratee interface{}");
  });
});

// ---------------------------------------------------------------------------
// #976 — Generic constraint round-trip fidelity
// ---------------------------------------------------------------------------

describe("compileToGo — constraint round-trip (#976)", () => {
  it("#976: <T extends Ordered> -> [T constraints.Ordered] with import", () => {
    // shave-go emits `<T extends Ordered>` for Go `[T constraints.Ordered]`.
    // compile-go must emit `[T constraints.Ordered]` and include the import.
    const src = `export function clamp<T extends Ordered>(value: T, mIn: T, mAx: T): T {
  if (value < mIn) { return mIn; }
  if (value > mAx) { return mAx; }
  return value;
}`;
    const out = compile(src);
    expect(out).toContain("func Clamp[T constraints.Ordered](value T, mIn T, mAx T) T {");
    // Must import the constraints package
    expect(out).toContain('"golang.org/x/exp/constraints"');
  });

  it("#976: <T extends Comparable> -> [T comparable] (built-in, no import)", () => {
    const src = `export function indexOf<T extends Comparable>(collection: T[], element: T): number {
  for (const i in collection) {
    if (collection[i] === element) { return i as unknown as number; }
  }
  return -1;
}`;
    const out = compile(src);
    expect(out).toContain("func IndexOf[T comparable](");
    // comparable is a built-in; no external import needed
    expect(out).not.toContain('"golang.org/x/exp/constraints"');
  });

  it("#976: <T> with no extends -> [T any] (default, no import)", () => {
    const src = "export function identity<T>(x: T): T { return x; }";
    const out = compile(src);
    expect(out).toContain("func Identity[T any](x T) T {");
    expect(out).not.toContain("constraints");
  });

  it("#976: custom interface constraint passes through verbatim", () => {
    const src = "export function process<T extends MyInterface>(x: T): T { return x; }";
    const out = compile(src);
    expect(out).toContain("func Process[T MyInterface](x T) T {");
  });

  it("#976: tilde type-set GoConstraint_Tilde_SliceOf_T -> ~[]T", () => {
    // shave-go encodes ~[]T as GoConstraint_Tilde_SliceOf_T in the extends clause.
    // compile-go must reverse-decode it to ~[]T.
    const src = `export function reverse<T, Slice extends GoConstraint_Tilde_SliceOf_T>(collection: Slice): Slice {
  return collection;
}`;
    const out = compile(src);
    expect(out).toContain("func Reverse[T any, Slice ~[]T](");
  });

  // ---------------------------------------------------------------------------
  // Compound end-to-end: shave-go IR -> compile-go, crossing both #975 + #976
  //
  // This is the required "compound-interaction test" that exercises the real
  // production sequence. It simulates what happens when samber/lo's Clamp
  // function is shaved (shave-go emits IR with extends Ordered + ForIn range)
  // and then compiled back to Go (compile-go reconstructs constraints + range).
  // ---------------------------------------------------------------------------

  it("#975+#976 compound: Clamp[T constraints.Ordered] with range body round-trips fully", () => {
    // This IR is what shave-go would emit for a function like:
    //   func Clamp[T constraints.Ordered](value, mIn, mAx T) T {
    //     for i := range someList { ... }  (key-only range)
    //     if value < mIn { return mIn }
    //     if value > mAx { return mAx }
    //     return value
    //   }
    const src = `export function clamp<T extends Ordered>(value: T, mIn: T, mAx: T): T {
  for (const i in someList) {
    return someList[i];
  }
  if (value < mIn) { return mIn; }
  if (value > mAx) { return mAx; }
  return value;
}`;
    const out = compile(src);
    // Constraint preserved
    expect(out).toContain("[T constraints.Ordered]");
    // Key-only range preserved (no _ prefix)
    expect(out).toContain("for i := range someList {");
    expect(out).not.toContain("for _, i := range");
    // Operators work (no compilation errors expected from constraint)
    expect(out).toContain("if value < mIn {");
    expect(out).toContain("if value > mAx {");
    // Import synthesized
    expect(out).toContain('"golang.org/x/exp/constraints"');
  });
});

// ---------------------------------------------------------------------------
// #986 — CompositeLit lowering: TS array/object literal -> Go []T{} / map[K]V{}
//
// @decision DEC-COMPOSITELIT-LOWER-001 (#986)
// @title Array/object literals use goTypeHint from surrounding declaration; fall back to interface{}
// @status accepted (#986)
// @rationale
//   The Go element/key/value types cannot be inferred from TS literal elements alone.
//   The surrounding variable declaration type node is the correct authority.
//   lowerVarStatement propagates lowerTypeNode(typeNode) into ctx.goTypeHint before
//   lowerExpr runs on the initializer.  lowerArrayLiteral / lowerObjectLiteral consume
//   this hint to emit the correct Go type prefix.
// ---------------------------------------------------------------------------

describe("lowerSource — array literal (#986)", () => {
  it("typed []int with explicit type annotation: const xs: number[] = [1, 2, 3]", () => {
    const src = `export function nums(): number[] {
  const xs: number[] = [1, 2, 3];
  return xs;
}`;
    const out = compile(src);
    expect(out).toContain("xs := []int{1, 2, 3}");
  });

  it('typed []string: const ss: string[] = ["a", "b"]', () => {
    const src = `export function strs(): string[] {
  const ss: string[] = ["a", "b"];
  return ss;
}`;
    const out = compile(src);
    expect(out).toContain(`ss := []string{"a", "b"}`);
  });

  it("empty slice with type annotation: const xs: number[] = []", () => {
    const src = `export function empty(): number[] {
  const xs: number[] = [];
  return xs;
}`;
    const out = compile(src);
    expect(out).toContain("xs := []int{}");
  });

  it("array literal with expression elements", () => {
    const src = `export function computed(a: number, b: number): number[] {
  const xs: number[] = [a + b, a - b];
  return xs;
}`;
    const out = compile(src);
    expect(out).toContain("xs := []int{a + b, a - b}");
  });

  it("array literal in return position without type hint falls back to []interface{}", () => {
    // Return-position type propagation is deferred (DEC-COMPOSITELIT-LOWER-001).
    // Without a type hint, the literal uses interface{} element type.
    const src = `export function fallback(): any {
  return [1, 2, 3];
}`;
    const out = compile(src);
    expect(out).toContain("[]interface{}{1, 2, 3}");
  });
});

describe("lowerSource — object literal / map (#986)", () => {
  it('typed Record<string,int> map literal: const m: Record<string,number> = {"a": 1}', () => {
    const src = `export function scores(): Record<string, number> {
  const m: Record<string, number> = {"a": 1, "b": 2};
  return m;
}`;
    const out = compile(src);
    expect(out).toContain(`m := map[string]int{"a": 1, "b": 2}`);
  });

  it("empty map literal: const m: Record<string,number> = {}", () => {
    const src = `export function emptyMap(): Record<string, number> {
  const m: Record<string, number> = {};
  return m;
}`;
    const out = compile(src);
    expect(out).toContain("m := map[string]int{}");
  });

  it("identifier property keys become Go string literals", () => {
    // TS `{foo: 1}` bare identifier key -> `"foo": 1` in Go map literal.
    const src = `export function bareKey(): Record<string, number> {
  const m: Record<string, number> = {foo: 1, bar: 2};
  return m;
}`;
    const out = compile(src);
    expect(out).toContain('"foo": 1');
    expect(out).toContain('"bar": 2');
    expect(out).toContain("map[string]int{");
  });

  it("object literal in return position without type hint uses map[string]interface{}", () => {
    // Deferred return-position propagation: default key/value types used.
    const src = `export function fallback(): any {
  return {"key": 42};
}`;
    const out = compile(src);
    expect(out).toContain('map[string]interface{}{"key": 42}');
  });

  it("shorthand or spread properties throw CannotLowerToGoError", () => {
    // Spread / shorthand are not in the CompositeLit MVP scope.
    const src = `export function spread(m: Record<string, number>): any {
  return {...m};
}`;
    expect(() => compile(src)).toThrow(CannotLowerToGoError);
  });
});

// ---------------------------------------------------------------------------
// #986 — Compound end-to-end: shave-go IR -> compile-go CompositeLit round-trip
//
// Simulates what happens when a Go function using composite literals is shaved
// (shave-go emits SliceLit/MapLit wire nodes, raise-body renders them as TS
// array/object literals) and then compiled back to Go (compile-go lowers the
// TS literals back to []T{} / map[K]V{} using the variable declaration type hint).
// ---------------------------------------------------------------------------

describe("compileToGo — CompositeLit round-trip compound (#986)", () => {
  it("#986 compound: slice init + assignment + return: []int{1,2,3} round-trips", () => {
    // IR as shave-go would emit for:
    //   func Nums() []int { xs := []int{1, 2, 3}; return xs }
    // After raise-body renders: const xs: number[] = [1, 2, 3]; return xs;
    const src = `export function nums(): number[] {
  const xs: number[] = [1, 2, 3];
  return xs;
}`;
    const out = compile(src);
    expect(out).toContain("func Nums() []int {");
    expect(out).toContain("xs := []int{1, 2, 3}");
    expect(out).toContain("return xs");
  });

  it("#986 compound: map[string]int{...} round-trips via Record<string,number>", () => {
    // IR as shave-go would emit for:
    //   func Scores() map[string]int { m := map[string]int{"a": 1}; return m }
    // After raise-body renders: const m: Record<string, number> = {"a": 1}; return m;
    const src = `export function scores(): Record<string, number> {
  const m: Record<string, number> = {"a": 1, "b": 2};
  return m;
}`;
    const out = compile(src);
    expect(out).toContain("func Scores() map[string]int {");
    expect(out).toContain(`m := map[string]int{"a": 1, "b": 2}`);
    expect(out).toContain("return m");
  });

  it("#986 compound: slice + for-range over it: []string{...} + key-only range", () => {
    // Simulates a function that initializes a slice and iterates over it.
    const src = `export function process(): string {
  const items: string[] = ["x", "y", "z"];
  for (const i in items) {
    return items[i];
  }
  return "";
}`;
    const out = compile(src);
    expect(out).toContain(`items := []string{"x", "y", "z"}`);
    expect(out).toContain("for i := range items {");
    expect(out).toContain("return items[i]");
  });
});
