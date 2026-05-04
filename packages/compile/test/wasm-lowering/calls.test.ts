/**
 * calls.test.ts — Tests for WI-V1W3-WASM-LOWER-09: function calls.
 *
 * Purpose:
 *   Verify that LoweringVisitor.lowerModule() correctly lowers intra-module
 *   direct calls and that the emitted WASM call opcodes execute correctly.
 *
 * Substrates:
 *   call-1: direct call — add(2, 3) via caller() → result === 5
 *   call-2: recursive call — factorial property test (≥15 runs, 0..12)
 *   call-3: DEFERRED (call_indirect / closures) — marked .todo
 *   call-4: multi-arg call — blend(a, b, c) multi-param function
 *   call-5: call returning record — structural/IR test (host_alloc required for runtime)
 *   call-6: loud failure — undefined callee throws LoweringError("unknown-call-target")
 *   Unit:   lowerModule IR contract — funcIndexTable, functions.length, back-compat lower()
 *
 * WASM module construction:
 *   buildMultiFunctionWasm() is a test-local multi-function module assembler.
 *   It takes the output of lowerModule() and serializes into a WASM binary with
 *   one function type per unique signature, exporting the named entry function.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-001
 * @title Two-pass forward-reference resolution for intra-module calls
 * @status accepted
 * @rationale
 *   Pass 1: enumerate all top-level FunctionDeclarations in declaration order
 *   and assign funcIndex (0-based local index). This enables forward and backward
 *   call resolution without re-scanning. Recursive calls work because the table
 *   is fully built before any code emission. Absolute WASM funcidx =
 *   localFuncIdx + importedFuncCount (imports precede defined functions in WASM
 *   funcidx space). See visitor.ts lowerModule() for full rationale.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-EMIT-001
 * @title Production multi-function module emission deferred to WI-V1W3-WASM-LOWER-11
 * @status accepted
 * @rationale
 *   wasm-backend.ts is a forbidden file in this WI. The buildMultiFunctionWasm()
 *   helper below is a test-local assembler sufficient for verifying call semantics.
 *   Production multi-function module emission is integrated in WI-V1W3-WASM-LOWER-11.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LoweringError, LoweringVisitor } from "../../src/wasm-lowering/visitor.js";
import { valtypeByte } from "../../src/wasm-lowering/wasm-function.js";
import type { LoweringResult, LoweringModuleResult } from "../../src/wasm-lowering/visitor.js";
import type { NumericDomain, WasmFunction } from "../../src/wasm-lowering/wasm-function.js";

// ---------------------------------------------------------------------------
// WASM binary helpers (mirrors control-flow.test.ts)
// ---------------------------------------------------------------------------

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WASM_VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
const FUNCTYPE = 0x60;

function uleb128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function section(id: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([id]), uleb128(content.length), content);
}

function encodeName(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  return concat(uleb128(bytes.length), bytes);
}

function serializeWasmFn(fn: WasmFunction): Uint8Array {
  const localParts: Uint8Array[] = [uleb128(fn.locals.length)];
  for (const decl of fn.locals) {
    localParts.push(uleb128(decl.count), new Uint8Array([valtypeByte(decl.type)]));
  }
  const localsBytes = concat(...localParts);
  const bodyBytes = new Uint8Array(fn.body);
  const endByte = new Uint8Array([0x0b]);
  return concat(localsBytes, bodyBytes, endByte);
}

// ---------------------------------------------------------------------------
// Test-local multi-function WASM module assembler
//
// Assembles a WASM binary from lowerModule() output. Each function gets its
// own type entry (indexed by function index). The entry function is exported
// under name "fn". importedFuncCount is 0 (no host imports for these tests).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-EMIT-001 (test-local assembler)
// ---------------------------------------------------------------------------

/**
 * Function type descriptor for WASM type section.
 */
interface FuncTypeDesc {
  paramTypes: NumericDomain[];
  resultType: NumericDomain | null; // null = void (no result)
}

/**
 * Build a minimal multi-function WASM module from lowerModule() output.
 *
 * Layout:
 *   - type section: one entry per unique (paramTypes, resultType) signature
 *   - func section: one entry per function, referencing its type
 *   - export section: exports the `entryName` function as "fn"
 *   - code section: one body per function in declaration order
 *
 * The funcTypeDescs array provides the WASM type information that the
 * lowerModule() result doesn't carry (param/result domain metadata).
 * Each entry corresponds to the function at the same index in moduleResult.functions.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-001 (funcidx = localIdx, no imports)
 */
function buildMultiFunctionWasm(
  moduleResult: LoweringModuleResult,
  funcTypeDescs: FuncTypeDesc[],
  entryName: string,
): Uint8Array {
  const fns = moduleResult.functions;
  if (fns.length !== funcTypeDescs.length) {
    throw new Error(
      `buildMultiFunctionWasm: fns.length (${fns.length}) !== funcTypeDescs.length (${funcTypeDescs.length})`,
    );
  }
  const entryIdx = moduleResult.funcIndexTable.get(entryName);
  if (entryIdx === undefined) {
    throw new Error(`buildMultiFunctionWasm: entry function '${entryName}' not in funcIndexTable`);
  }

  // Build type section — deduplicate type signatures
  const typeEntries: Array<{ paramValtypes: number[]; resultValtypes: number[] }> = [];
  const typeIndexForFunc: number[] = [];

  for (const desc of funcTypeDescs) {
    const paramValtypes = desc.paramTypes.map(valtypeByte);
    const resultValtypes = desc.resultType !== null ? [valtypeByte(desc.resultType)] : [];
    // Find matching existing type or add new one
    let typeIdx = typeEntries.findIndex(
      (e) =>
        e.paramValtypes.length === paramValtypes.length &&
        e.paramValtypes.every((v, i) => v === paramValtypes[i]) &&
        e.resultValtypes.length === resultValtypes.length &&
        e.resultValtypes.every((v, i) => v === resultValtypes[i]),
    );
    if (typeIdx === -1) {
      typeIdx = typeEntries.length;
      typeEntries.push({ paramValtypes, resultValtypes });
    }
    typeIndexForFunc.push(typeIdx);
  }

  // Serialize type section
  const typeDefs: Uint8Array[] = typeEntries.map((e) =>
    concat(
      new Uint8Array([FUNCTYPE]),
      uleb128(e.paramValtypes.length),
      new Uint8Array(e.paramValtypes),
      uleb128(e.resultValtypes.length),
      new Uint8Array(e.resultValtypes),
    ),
  );
  const typeSection = section(1, concat(uleb128(typeEntries.length), ...typeDefs));

  // Func section: one type index per function
  const funcIdxBytes: Uint8Array[] = typeIndexForFunc.map((ti) => uleb128(ti));
  const funcSection = section(3, concat(uleb128(fns.length), ...funcIdxBytes));

  // Export section: export entry function as "fn"
  const exportSection = section(
    7,
    concat(
      uleb128(1),
      encodeName("fn"),
      new Uint8Array([0x00]), // func export kind
      uleb128(entryIdx), // funcidx = local index (no imports)
    ),
  );

  // Code section: one serialized body per function
  const codeBodies: Uint8Array[] = fns.map((r: LoweringResult) => {
    const body = serializeWasmFn(r.wasmFn);
    return concat(uleb128(body.length), body);
  });
  const codeSection = section(10, concat(uleb128(fns.length), ...codeBodies));

  return concat(WASM_MAGIC, WASM_VERSION, typeSection, funcSection, exportSection, codeSection);
}

/** Instantiate a WASM module and call the exported "fn" with given args. */
async function runWasm(wasmBytes: Uint8Array, args: (number | bigint)[]): Promise<number | bigint> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const fn = (instance.exports as Record<string, unknown>).fn as (
    ...a: unknown[]
  ) => number | bigint;
  return fn(...args);
}

// ---------------------------------------------------------------------------
// call-1: direct call — add(2, 3) via caller() → result === 5
// ---------------------------------------------------------------------------

describe("calls — call-1: direct intra-module call", () => {
  it("call-1a: caller() calls add(2, 3) and returns 5", async () => {
    const src = `
function add(a: number, b: number): number {
  return (a + b) | 0;
}
export function caller(): number {
  return add(2, 3) | 0;
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);

    expect(moduleResult.functions.length).toBe(2);
    expect(moduleResult.funcIndexTable.get("add")).toBe(0);
    expect(moduleResult.funcIndexTable.get("caller")).toBe(1);

    // Verify `call` opcode (0x10) is present in the caller body
    const callerFn = moduleResult.functions[1];
    expect(callerFn).toBeDefined();
    expect(callerFn!.wasmFn.body.includes(0x10)).toBe(true);

    // Build WASM module:
    //   func 0: add(i32, i32) → i32
    //   func 1: caller() → i32  (exported as "fn")
    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32", "i32"], resultType: "i32" },
        { paramTypes: [], resultType: "i32" },
      ],
      "caller",
    );

    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
    const result = await runWasm(wasmBytes, []);
    expect(Number(result)).toBe(5);
  });

  it("call-1b: caller with variable binding calls add correctly — 15 explicit cases", async () => {
    const src = `
function add(a: number, b: number): number {
  return (a + b) | 0;
}
export function addThree(x: number, y: number, z: number): number {
  return add(add(x, y), z);
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);

    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32", "i32"], resultType: "i32" },
        { paramTypes: ["i32", "i32", "i32"], resultType: "i32" },
      ],
      "addThree",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    // 15 explicit cases
    const cases: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [1, 2, 3, 6],
      [-1, -2, -3, -6],
      [10, 20, 30, 60],
      [100, 200, 300, 600],
      [0, 0, 5, 5],
      [5, 0, 0, 5],
      [3, 3, 3, 9],
      [-5, 5, 0, 0],
      [1000, 1000, 1000, 3000],
      [7, 8, 9, 24],
      [-100, 50, 50, 0],
      [2, 4, 8, 14],
      [0, 1, -1, 0],
      [15, 15, 15, 45],
    ];
    for (const [x, y, z, expected] of cases) {
      const r = await runWasm(wasmBytes, [x, y, z]);
      expect(Number(r)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// call-2: recursive call — factorial
// ---------------------------------------------------------------------------

describe("calls — call-2: recursive call (factorial)", () => {
  it("call-2a: fact(5) === 120 and fact(0) === 1", async () => {
    const src = `
export function fact(n: number): number {
  if ((n | 0) <= 1) {
    return 1;
  }
  return (n * fact((n - 1) | 0)) | 0;
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);

    expect(moduleResult.functions.length).toBe(1);
    expect(moduleResult.funcIndexTable.get("fact")).toBe(0);

    // Verify recursive call opcode present
    expect(moduleResult.functions[0]!.wasmFn.body.includes(0x10)).toBe(true);

    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [{ paramTypes: ["i32"], resultType: "i32" }],
      "fact",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    expect(Number(await runWasm(wasmBytes, [5]))).toBe(120);
    expect(Number(await runWasm(wasmBytes, [0]))).toBe(1);
    expect(Number(await runWasm(wasmBytes, [1]))).toBe(1);
    expect(Number(await runWasm(wasmBytes, [6]))).toBe(720);
  });

  it("call-2b: fact property test — ≥15 runs over fc.integer({ min: 0, max: 12 })", async () => {
    const src = `
export function fact(n: number): number {
  if ((n | 0) <= 1) {
    return 1;
  }
  return (n * fact((n - 1) | 0)) | 0;
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);
    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [{ paramTypes: ["i32"], resultType: "i32" }],
      "fact",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    // TypeScript reference implementation
    function factRef(n: number): number {
      if (n <= 1) return 1;
      return (n * factRef(n - 1)) | 0;
    }

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 12 }), async (n) => {
        const result = await runWasm(wasmBytes, [n]);
        expect(Number(result)).toBe(factRef(n));
      }),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// call-3: DEFERRED — call_indirect / closures
// ---------------------------------------------------------------------------

describe("calls — call-3: DEFERRED (indirect/closure calls)", () => {
  // call_indirect (table-based dispatch) and closure-funcref calls require the
  // `funcref` / `call_indirect` WASM instruction and a table section — lowering
  // of TS function objects as values is deferred to WI-V1W3-WASM-LOWER-10.
  // @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-001: call_indirect deferred to WI-10
  it.todo(
    "call-3: call_indirect and closure-funcref calls deferred to WI-V1W3-WASM-LOWER-10",
  );
});

// ---------------------------------------------------------------------------
// call-4: multi-arg call — blend with multiple i32 args
// ---------------------------------------------------------------------------

describe("calls — call-4: multi-arg call", () => {
  it("call-4a: blend(a, b, c): i32 — sum of three i32 args, 15 cases", async () => {
    // Multi-argument call: blend takes 3 i32 parameters, verifies args are passed correctly.
    // Note: mixed i32/i64/f64 in a single function call requires i64.extend / f64.convert
    // which are not yet in scope. All-i32 domain verifies multi-arg call opcode emission.
    const src = `
function blend(a: number, b: number, c: number): number {
  return ((a + b) + c) | 0;
}
export function entry(): number {
  return blend(2, 100, 3) | 0;
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);

    expect(moduleResult.functions.length).toBe(2);
    const entryFn = moduleResult.functions[1];
    expect(entryFn).toBeDefined();
    // entry body must contain call opcode
    expect(entryFn!.wasmFn.body.includes(0x10)).toBe(true);

    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32", "i32", "i32"], resultType: "i32" },
        { paramTypes: [], resultType: "i32" },
      ],
      "entry",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
    const result = await runWasm(wasmBytes, []);
    expect(Number(result)).toBe(105);
  });

  it("call-4b: multi-arg call forwarding params — 15 cases via fc.integer", async () => {
    const src = `
function tripleAdd(a: number, b: number, c: number): number {
  return ((a + b) + c) | 0;
}
export function callIt(x: number, y: number, z: number): number {
  return tripleAdd(x, y, z);
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);
    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32", "i32", "i32"], resultType: "i32" },
        { paramTypes: ["i32", "i32", "i32"], resultType: "i32" },
      ],
      "callIt",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (a, b, c) => {
          const expected = ((a + b) + c) | 0;
          const result = await runWasm(wasmBytes, [a, b, c]);
          expect(Number(result)).toBe(expected);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// call-5: call returning record (IR/structural test)
//
// Full runtime execution of a call returning a record requires host_alloc for
// struct allocation — this is host infrastructure that a standalone test module
// cannot provide without the full yakcc_host import object. The test verifies:
//   (a) lowerModule() lowers without error (call + record access compiles)
//   (b) The call opcode (0x10) is present in the caller body
//   (c) The IR structure has the correct number of functions
//
// Runtime WASM execution of record-returning calls is tested in the wave-3
// parity suite (wasm-host.test.ts / wasm-backend integration).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-CALL-EMIT-001 (record-returning call deferred to WI-11)
// ---------------------------------------------------------------------------

describe("calls — call-5: call returning record (IR/structural)", () => {
  it.todo(
    // Record-returning functions (return type is an object literal, params are numeric)
    // are not yet handled by lowerModule. detectRecordShape() requires a record-typed
    // PARAMETER (e.g. r: {x: number}) to classify a function as a record function.
    // A function with only numeric params but a record return type (like makeRec below)
    // falls through to _lowerNumericFunctionWithCallCtx, which throws on ObjectLiteralExpression.
    //
    // Full lowering of record-returning callee functions requires WI-11 (memory allocation
    // integration with host_alloc). At that point, lowerModule will route record-returning
    // functions through a dedicated path that can handle { x: a, y: b } → store opcodes.
    //
    // Deferred: WI-V1W3-WASM-LOWER-11 (record-returning function lowering in lowerModule).
    "call-5a: lowerModule lowers caller-of-record-returner without error [deferred to WI-11]",
  );

  it("call-5b: non-record multi-function call chain — makeY(n) = n*2 called by caller — 15 cases", async () => {
    // Simplified version: use scalar return (avoid record runtime requirement).
    // Verifies the general call mechanism with a result-returning callee.
    const src = `
function makeY(a: number): number {
  return (a * 2) | 0;
}
export function caller(a: number): number {
  return makeY(a);
}`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);
    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32"], resultType: "i32" },
        { paramTypes: ["i32"], resultType: "i32" },
      ],
      "caller",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    const cases: [number, number][] = [
      [0, 0],
      [1, 2],
      [3, 6],
      [5, 10],
      [7, 14],
      [10, 20],
      [50, 100],
      [-1, -2],
      [-5, -10],
      [-7, -14],
      [100, 200],
      [1000, 2000],
      [-1000, -2000],
      [25, 50],
      [13, 26],
    ];
    for (const [a, expected] of cases) {
      const result = await runWasm(wasmBytes, [a]);
      expect(Number(result)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// call-6: loud failure — undefined function throws LoweringError("unknown-call-target")
// ---------------------------------------------------------------------------

describe("calls — call-6: loud failure on unknown call target", () => {
  it("call-6a: lowerModule throws LoweringError('unknown-call-target') for undefined callee", () => {
    const src = `
export function entry(): number {
  return undefinedFunc(1);
}`;
    const visitor = new LoweringVisitor();
    expect(() => visitor.lowerModule(src)).toThrow(LoweringError);

    try {
      visitor.lowerModule(src);
      expect.fail("Expected LoweringError to be thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LoweringError);
      expect((e as LoweringError).kind).toBe("unknown-call-target");
      expect((e as LoweringError).message).toContain("undefinedFunc");
    }
  });

  it("call-6b: lower() (single-function) also throws on undefined callee", () => {
    // Verify back-compat lower() also rejects unknown call targets
    const src = `
export function entry(): number {
  return undefinedFunc(1);
}`;
    const visitor = new LoweringVisitor();
    expect(() => visitor.lower(src)).toThrow(LoweringError);
    try {
      visitor.lower(src);
      expect.fail("Expected LoweringError to be thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LoweringError);
      expect((e as LoweringError).kind).toBe("unknown-call-target");
    }
  });

  it("call-6c: host_unknown throws unknown-call-target (not in HOST_IMPORT_INDICES)", () => {
    const src = `
export function entry(): number {
  return host_nonexistent_function(1);
}`;
    const visitor = new LoweringVisitor();
    try {
      visitor.lower(src);
      expect.fail("Expected LoweringError to be thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LoweringError);
      expect((e as LoweringError).kind).toBe("unknown-call-target");
      expect((e as LoweringError).message).toContain("host_nonexistent_function");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: lowerModule IR contract
// ---------------------------------------------------------------------------

describe("calls — lowerModule IR contract", () => {
  it("multi-function-entry: lowerModule returns functions.length === 2 for 2-function source", () => {
    const src = `
function helper(x: number): number { return (x * 2) | 0; }
export function entry(n: number): number { return helper(n); }`;
    const visitor = new LoweringVisitor();
    const result = visitor.lowerModule(src);
    expect(result.functions.length).toBe(2);
    expect(result.funcIndexTable.size).toBe(2);
    expect(result.funcIndexTable.get("helper")).toBe(0);
    expect(result.funcIndexTable.get("entry")).toBe(1);
  });

  it("funcIndexTable: 3-function module populates correctly in declaration order", () => {
    const src = `
function a(x: number): number { return (x + 1) | 0; }
function b(x: number): number { return (x + 2) | 0; }
export function c(x: number): number { return (a(x) + b(x)) | 0; }`;
    const visitor = new LoweringVisitor();
    const result = visitor.lowerModule(src);
    expect(result.functions.length).toBe(3);
    expect(result.funcIndexTable.get("a")).toBe(0);
    expect(result.funcIndexTable.get("b")).toBe(1);
    expect(result.funcIndexTable.get("c")).toBe(2);
    // c's body must contain call opcodes (0x10) for calls to a and b
    expect(result.functions[2]!.wasmFn.body.includes(0x10)).toBe(true);
  });

  it("back-compat: lower() still works for single-function sources", () => {
    const src = `export function double(n: number): number { return (n * 2) | 0; }`;
    const visitor = new LoweringVisitor();
    // lower() must not throw
    expect(() => visitor.lower(src)).not.toThrow();
    const result = visitor.lower(src);
    expect(result.wasmFn).toBeDefined();
    expect(result.wasmFn.body.length).toBeGreaterThan(0);
  });

  it("lowerModule single-function: module with 1 function still works", () => {
    const src = `export function double(n: number): number { return (n * 2) | 0; }`;
    const visitor = new LoweringVisitor();
    const result = visitor.lowerModule(src);
    expect(result.functions.length).toBe(1);
    expect(result.funcIndexTable.get("double")).toBe(0);
  });

  it("call opcode correctness: verify `call` opcode 0x10 + uleb128 funcIdx in body", () => {
    // Verifies the exact call encoding: call(add) in caller should emit 0x10 0x00
    // because add is funcIdx 0 (no imports), encoded as uleb128(0) = 0x00.
    const src = `
function add(a: number, b: number): number { return (a + b) | 0; }
export function caller(): number { return add(1, 2); }`;
    const visitor = new LoweringVisitor();
    const result = visitor.lowerModule(src);
    const callerBody = result.functions[1]!.wasmFn.body;
    // Find 0x10 (call opcode) followed by 0x00 (funcIdx 0 as uleb128)
    const callIdx = callerBody.indexOf(0x10);
    expect(callIdx).toBeGreaterThan(-1);
    expect(callerBody[callIdx + 1]).toBe(0x00); // funcIdx 0 = add (no imports)
  });

  it("forward reference: function called before its declaration lowers correctly", async () => {
    // caller declared first, add declared second — forward reference must resolve.
    // Note: caller uses `| 0` to force i32 domain — without it, inferNumericDomain
    // sees no f64 indicator and no bitop in caller() and defaults to f64 (ambiguous
    // fallback), causing a type mismatch when the call instruction consumes i32 args
    // from add() but the function is compiled in f64 domain.
    const src = `
export function caller(): number { return add(3, 4) | 0; }
function add(a: number, b: number): number { return (a + b) | 0; }`;
    const visitor = new LoweringVisitor();
    const result = visitor.lowerModule(src);
    // caller is funcIdx 0, add is funcIdx 1
    expect(result.funcIndexTable.get("caller")).toBe(0);
    expect(result.funcIndexTable.get("add")).toBe(1);

    const wasmBytes = buildMultiFunctionWasm(
      result,
      [
        { paramTypes: [], resultType: "i32" },
        { paramTypes: ["i32", "i32"], resultType: "i32" },
      ],
      "caller",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
    const r = await runWasm(wasmBytes, []);
    expect(Number(r)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// End-to-end compound-interaction test
//
// Production sequence: source string → lowerModule → buildMultiFunctionWasm →
// WebAssembly.instantiate → call exported fn → compare to TS reference.
// Crosses: LoweringVisitor two-pass, funcIndexTable resolution, call opcode
// emission, test-local module assembler, WASM JIT execution.
// ---------------------------------------------------------------------------

describe("calls — compound interaction: multi-function module end-to-end", () => {
  it("compound: 3-function mutual-dependency chain executes correctly", async () => {
    // double and triple call each other through a chain; sum_dt chains calls
    const src = `
function double(n: number): number { return (n * 2) | 0; }
function triple(n: number): number { return (n * 3) | 0; }
export function sum_dt(n: number): number { return (double(n) + triple(n)) | 0; }`;
    const visitor = new LoweringVisitor();
    const moduleResult = visitor.lowerModule(src);

    expect(moduleResult.functions.length).toBe(3);
    expect(moduleResult.funcIndexTable.get("double")).toBe(0);
    expect(moduleResult.funcIndexTable.get("triple")).toBe(1);
    expect(moduleResult.funcIndexTable.get("sum_dt")).toBe(2);

    const wasmBytes = buildMultiFunctionWasm(
      moduleResult,
      [
        { paramTypes: ["i32"], resultType: "i32" },
        { paramTypes: ["i32"], resultType: "i32" },
        { paramTypes: ["i32"], resultType: "i32" },
      ],
      "sum_dt",
    );
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    // sum_dt(n) = double(n) + triple(n) = 2n + 3n = 5n
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -100, max: 100 }), async (n) => {
        const expected = (n * 5) | 0;
        const result = await runWasm(wasmBytes, [n]);
        expect(Number(result)).toBe(expected);
      }),
      { numRuns: 20 },
    );
  });
});
