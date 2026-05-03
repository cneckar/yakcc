/**
 * visitor.test.ts — 5 unit tests for the WI-V1W3-WASM-LOWER-01 scaffold.
 *
 * Tests:
 *   1. parse/walk a 5-line numeric function → correct WasmFunction shape
 *   2. SymbolTable: pushFrame / popFrame stack discipline
 *   3. SymbolTable: parameter slot declaration and lookup
 *   4. SymbolTable: local slot declaration and cross-frame lookup / scope exit
 *   5. LoweringVisitor: unsupported AST node throws LoweringError with 'unknown node kind'
 */

import { describe, expect, it } from "vitest";
import { SymbolTable } from "./symbol-table.js";
import { LoweringError, LoweringVisitor } from "./visitor.js";

// ---------------------------------------------------------------------------
// Test 1: parse/walk a 5-line numeric function
// ---------------------------------------------------------------------------

describe("LoweringVisitor — parse/walk a numeric function", () => {
  it("lowers a 2-param add function to a correct WasmFunction", () => {
    const visitor = new LoweringVisitor();
    const fn = visitor.lower(
      "export function add(a: number, b: number): number { return a + b; }",
    );

    expect(fn.name).toBe("add");
    expect(fn.params).toHaveLength(2);
    expect(fn.params[0]).toEqual({ name: "a", type: "i32" });
    expect(fn.params[1]).toEqual({ name: "b", type: "i32" });
    expect(fn.returnType).toBe("i32");
    expect(fn.extraLocals).toHaveLength(0);
    // body: local.get 0, local.get 1, i32.add
    expect(fn.body).toEqual(new Uint8Array([0x20, 0x00, 0x20, 0x01, 0x6a]));
  });
});

// ---------------------------------------------------------------------------
// Test 2: SymbolTable push/pop frame
// ---------------------------------------------------------------------------

describe("SymbolTable — pushFrame / popFrame", () => {
  it("maintains correct stack discipline and throws on underflow", () => {
    const sym = new SymbolTable();

    // Cannot pop an empty stack
    expect(() => sym.popFrame()).toThrow();

    sym.pushFrame();
    sym.pushFrame();
    sym.popFrame();
    sym.popFrame();

    // Stack is empty again — pop should throw
    expect(() => sym.popFrame()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 3: SymbolTable — parameter slot lookup
// ---------------------------------------------------------------------------

describe("SymbolTable — parameter slot declaration and lookup", () => {
  it("assigns sequential indices to params and resolves them by name", () => {
    const sym = new SymbolTable();
    sym.pushFrame();

    const a = sym.declareParam("a", "i32");
    const b = sym.declareParam("b", "i32");

    expect(a.localIndex).toBe(0);
    expect(a.wasmType).toBe("i32");
    expect(a.isParam).toBe(true);

    expect(b.localIndex).toBe(1);
    expect(b.isParam).toBe(true);

    expect(sym.lookup("a")).toBe(a);
    expect(sym.lookup("b")).toBe(b);
    expect(sym.lookup("c")).toBeUndefined();
    expect(sym.getParamCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 4: SymbolTable — local slot cross-frame lookup and scope exit
// ---------------------------------------------------------------------------

describe("SymbolTable — local slot declaration and scope", () => {
  it("resolves locals in inner frames and hides them after popFrame", () => {
    const sym = new SymbolTable();
    sym.pushFrame();
    const p = sym.declareParam("p", "i32"); // index 0

    sym.pushFrame();
    const acc = sym.declareLocal("acc", "i32"); // index 1

    expect(acc.localIndex).toBe(1);
    expect(acc.isParam).toBe(false);

    // Inner frame can see both 'acc' and outer param 'p'
    expect(sym.lookup("acc")).toBe(acc);
    expect(sym.lookup("p")).toBe(p);

    sym.popFrame();

    // After popping, 'acc' is no longer visible
    expect(sym.lookup("acc")).toBeUndefined();
    // But 'p' (outer frame) is still visible
    expect(sym.lookup("p")).toBe(p);

    sym.popFrame();
  });
});

// ---------------------------------------------------------------------------
// Test 5: unknown node kind throws LoweringError (Sacred Practice #5)
// ---------------------------------------------------------------------------

describe("LoweringVisitor — unknown node kind loud failure", () => {
  it("throws LoweringError containing 'unknown node kind' for unsupported statements", () => {
    const visitor = new LoweringVisitor();

    // A function with a while loop is not yet supported by the scaffold
    expect(() =>
      visitor.lower(`
        export function loop(n: number): number {
          while (n > 0) { n--; }
          return n;
        }
      `),
    ).toThrow(LoweringError);

    expect(() =>
      visitor.lower(`
        export function loop(n: number): number {
          while (n > 0) { n--; }
          return n;
        }
      `),
    ).toThrow(/unknown node kind/);
  });

  it("throws LoweringError for unsupported binary operator", () => {
    const visitor = new LoweringVisitor();

    expect(() =>
      visitor.lower(
        "export function sub(a: number, b: number): number { return a - b; }",
      ),
    ).toThrow(LoweringError);

    expect(() =>
      visitor.lower(
        "export function sub(a: number, b: number): number { return a - b; }",
      ),
    ).toThrow(/unknown node kind/);
  });
});
