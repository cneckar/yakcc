/**
 * visitor.test.ts — Unit tests for the LoweringVisitor scaffold (WI-V1W3-WASM-LOWER-01).
 *
 * Five tests required by the acceptance gate:
 *   1. parse-and-walk: ts-morph parses a trivial source and visitor produces a WasmFunction
 *   2. frame push/pop: SymbolTable depth is correct across nested block scopes
 *   3. parameter slot lookup: visitor registers params with correct slot indices
 *   4. local slot lookup: visitor registers locals with correct slot indices
 *   5. unknown node kind fails loudly: LoweringError names the SyntaxKind
 *
 * Production sequence exercised:
 *   source string → LoweringVisitor.lower() → LoweringResult { fnName, wasmFn, wave2Shape }
 *   The visitor is the dispatch entry point for compileToWasm() in wasm-backend.ts.
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001
 * @title Tests verify the ts-morph-based visitor scaffold and its SymbolTable
 * @status accepted
 * @rationale
 *   Tests exercise LoweringVisitor directly (not via compileToWasm) to isolate the
 *   visitor scaffold from the binary emitter. The wave-2 parity matrix in
 *   wasm-backend.test.ts provides end-to-end coverage through the full stack.
 *   These tests cover the five acceptance criteria for WI-V1W3-WASM-LOWER-01.
 */

import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../src/wasm-lowering/symbol-table.js";
import { LoweringError, LoweringVisitor } from "../../src/wasm-lowering/visitor.js";

// ---------------------------------------------------------------------------
// Test 1: parse-and-walk a trivial source
// ---------------------------------------------------------------------------

describe("LoweringVisitor — parse and walk", () => {
  it("parses a trivial function and returns a LoweringResult with non-empty body", () => {
    const visitor = new LoweringVisitor();
    // A zero-param function returning 1 does not match any wave-2 shape
    // (wave-2 "add" requires two-param `return a + b`), so general numeric
    // lowering handles it: returnType "number", no indicators → f64 default.
    const result = visitor.lower("export function f(): number { return 1; }");

    expect(result.fnName).toBe("f");
    expect(result.wasmFn).toBeDefined();
    expect(result.wasmFn.body.length).toBeGreaterThan(0);
    // WI-02 routes this through general lowering (wave2Shape is null)
    expect(result.wave2Shape).toBeNull();
    // General lowering infers f64 (no bitop/float indicators → ambiguous → f64)
    expect(result.numericDomain).toBe("f64");
  });

  it("returns fnName matching the exported function name", () => {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(
      "export function add(a: number, b: number): number { return a + b; }",
    );
    expect(result.fnName).toBe("add");
    expect(result.wave2Shape).toBe("add");
  });

  it("body bytes are all valid byte values (0–255)", () => {
    const visitor = new LoweringVisitor();
    const result = visitor.lower(
      "export function add(a: number, b: number): number { return a + b; }",
    );
    for (const byte of result.wasmFn.body) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: frame push/pop across nested block scope
// ---------------------------------------------------------------------------

describe("SymbolTable — frame push/pop", () => {
  it("depth is 0 before any pushFrame()", () => {
    const table = new SymbolTable();
    expect(table.depth).toBe(0);
  });

  it("depth increases on pushFrame and decreases on popFrame", () => {
    const table = new SymbolTable();

    table.pushFrame({ isFunctionBoundary: true });
    expect(table.depth).toBe(1);

    table.pushFrame({ isFunctionBoundary: false });
    expect(table.depth).toBe(2);

    table.pushFrame({ isFunctionBoundary: false });
    expect(table.depth).toBe(3);

    table.popFrame();
    expect(table.depth).toBe(2);

    table.popFrame();
    expect(table.depth).toBe(1);

    table.popFrame();
    expect(table.depth).toBe(0);
  });

  it("popFrame on empty stack throws an error", () => {
    const table = new SymbolTable();
    expect(() => table.popFrame()).toThrow("frame stack is empty");
  });

  it("slot counter resets to 0 at a new function boundary", () => {
    const table = new SymbolTable();

    // First function: defines 2 params (slots 0, 1)
    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("a", "i32");
    table.defineParam("b", "i32");
    expect(table.nextSlotIndex).toBe(2);
    table.popFrame();

    // Second function: slot counter resets
    table.pushFrame({ isFunctionBoundary: true });
    expect(table.nextSlotIndex).toBe(0);
    table.popFrame();
  });

  it("inner block scope shares slot counter with enclosing function", () => {
    const table = new SymbolTable();

    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("x", "i32"); // slot 0

    // Push an inner block scope — slot counter continues from 1
    table.pushFrame({ isFunctionBoundary: false });
    const local = table.defineLocal("tmp", "i32"); // slot 1
    expect(local.index).toBe(1);
    expect(table.nextSlotIndex).toBe(2);
    table.popFrame();

    // After popping inner scope, next index is still 2 (shared counter)
    expect(table.nextSlotIndex).toBe(2);
    table.popFrame();
  });
});

// ---------------------------------------------------------------------------
// Test 3: parameter slot lookup
// ---------------------------------------------------------------------------

describe("SymbolTable — parameter slot lookup", () => {
  it("defineParam assigns slot index 0 to the first parameter", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });

    const slot = table.defineParam("a", "i32");
    expect(slot.kind).toBe("param");
    expect(slot.index).toBe(0);
    expect(slot.domain).toBe("i32");

    table.popFrame();
  });

  it("multiple params get sequential slot indices 0, 1, 2", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });

    const a = table.defineParam("a", "i32");
    const b = table.defineParam("b", "i32");
    const c = table.defineParam("c", "i64");

    expect(a.index).toBe(0);
    expect(b.index).toBe(1);
    expect(c.index).toBe(2);
    expect(c.domain).toBe("i64");

    table.popFrame();
  });

  it("lookup('a') finds the param slot after defineParam('a')", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("a", "i32");
    table.defineParam("b", "i32");

    const slot = table.lookup("a");
    expect(slot).toBeDefined();
    expect(slot?.kind).toBe("param");
    expect(slot?.index).toBe(0);

    table.popFrame();
  });

  it("lookup returns undefined for a name that was never defined", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("a", "i32");

    expect(table.lookup("notDefined")).toBeUndefined();

    table.popFrame();
  });

  it("lookup finds param from outer frame when inside an inner block scope", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("a", "i32");

    table.pushFrame({ isFunctionBoundary: false });
    // 'a' defined in outer frame, should be findable from inner
    const slot = table.lookup("a");
    expect(slot?.kind).toBe("param");
    expect(slot?.index).toBe(0);

    table.popFrame();
    table.popFrame();
  });
});

// ---------------------------------------------------------------------------
// Test 4: local slot lookup
// ---------------------------------------------------------------------------

describe("SymbolTable — local slot lookup", () => {
  it("defineLocal assigns slot after params", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });

    table.defineParam("ptr", "i32"); // slot 0
    table.defineParam("len", "i32"); // slot 1
    const local = table.defineLocal("acc", "i32"); // slot 2

    expect(local.kind).toBe("local");
    expect(local.index).toBe(2);
    expect(local.domain).toBe("i32");

    table.popFrame();
  });

  it("lookup finds local by name", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });
    table.defineParam("a", "i32");
    table.defineLocal("result", "i32");

    const slot = table.lookup("result");
    expect(slot?.kind).toBe("local");
    expect(slot?.index).toBe(1);

    table.popFrame();
  });

  it("inner scope local shadows outer scope local with same name", () => {
    const table = new SymbolTable();
    table.pushFrame({ isFunctionBoundary: true });
    table.defineLocal("x", "i32"); // slot 0

    table.pushFrame({ isFunctionBoundary: false });
    table.defineLocal("x", "i64"); // slot 1 (inner x shadows outer x)

    const inner = table.lookup("x");
    expect(inner?.kind).toBe("local");
    expect(inner?.index).toBe(1);
    expect(inner?.domain).toBe("i64");

    table.popFrame();

    // After popping, outer x is visible again
    const outer = table.lookup("x");
    expect(outer?.domain).toBe("i32");
    expect(outer?.index).toBe(0);

    table.popFrame();
  });

  it("defineLocal throws when no frame is pushed", () => {
    const table = new SymbolTable();
    expect(() => table.defineLocal("x", "i32")).toThrow("no frame pushed");
  });
});

// ---------------------------------------------------------------------------
// Test 5: unknown node kind fails loudly
// ---------------------------------------------------------------------------

describe("LoweringVisitor — unknown node kind fails loudly (Sacred Practice #5)", () => {
  it("throws LoweringError with kind 'unsupported-node' for a function containing a while-loop (control flow deferred to WI-08)", () => {
    // WI-03 added if/else support. Loop constructs (while, for) are deferred to
    // WI-V1W3-WASM-LOWER-08. A function with a WhileStatement must fail loudly.
    const visitor = new LoweringVisitor();

    expect(() =>
      visitor.lower(
        "export function sumTo(n: number): number { let acc: number = 0 | 0; let i: number = 0 | 0; while ((i | 0) < n) { acc = (acc + i) | 0; i = (i + 1) | 0; } return acc; }",
      ),
    ).toThrow(LoweringError);
  });

  it("the thrown LoweringError has kind 'unsupported-node'", () => {
    const visitor = new LoweringVisitor();
    let caught: unknown;

    try {
      // A boolean-return function with a for-loop — not a wave-2 shape, and
      // control flow (ForStatement) is deferred to WI-03.
      visitor.lower(
        "export function hasPositive(x: number): boolean { for (let i = 0; i < x; i++) { if (i > 0) return true; } return false; }",
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LoweringError);
    expect((caught as LoweringError).kind).toBe("unsupported-node");
  });

  it("the error message names the offending SyntaxKind", () => {
    const visitor = new LoweringVisitor();
    let caught: unknown;

    try {
      // bigint return type — not a wave-2 shape; general lowering not yet implemented
      visitor.lower("export function toBI(x: number): bigint { return BigInt(x); }");
    } catch (e) {
      caught = e;
    }

    // The error must name a SyntaxKind — not just say "unknown"
    expect(caught).toBeInstanceOf(LoweringError);
    const msg = (caught as LoweringError).message;
    // Message must include "SyntaxKind" and a specific kind name
    expect(msg).toContain("SyntaxKind");
    expect(msg).toMatch(/SyntaxKind '\w+'/);
    // Must not silently swallow the kind as undefined
    expect(msg).not.toContain("SyntaxKind 'undefined'");
  });

  it("throws LoweringError with kind 'missing-export' when source has no exported function", () => {
    const visitor = new LoweringVisitor();

    expect(() => visitor.lower("function notExported(x: number): number { return x; }")).toThrow(
      LoweringError,
    );

    let caught: unknown;
    try {
      visitor.lower("function notExported(x: number): number { return x; }");
    } catch (e) {
      caught = e;
    }

    expect((caught as LoweringError).kind).toBe("missing-export");
  });
});
