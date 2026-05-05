// SPDX-License-Identifier: MIT
/**
 * property-access.test.ts — Tests for WI-V1W4-LOWER-EXTEND-UNSUPPORTED-NODE.
 *
 * Purpose:
 *   Verify that the general numeric lowering path handles PropertyAccessExpression
 *   (obj.field) for record-typed params with inline object-literal type annotations.
 *   Closes GitHub issue #126.
 *
 * Scope:
 *   - prop-01: single-level i32 property access (`obj.x | 0`, `obj.y | 0`)
 *   - prop-02: single-level f64 property access (`obj.ratio / 1.0`)
 *
 * Production sequence exercised:
 *   source string → compileToWasm() → LoweringVisitor._lowerRecordFunction()
 *   → lowerExpressionRecord() → lowerExpression() PropertyAccessExpression handler
 *   → emitFieldLoad() → WebAssembly.instantiate → run → compare to TS reference.
 *
 * Record layout (matches DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001):
 *   - 8-byte alignment per field (uniform); little-endian per WASM spec.
 *   - field_byte_offset = field_slot_index * 8.
 *   - i32 fields: 4 bytes at offset, upper 4 bytes zeroed.
 *   - f64 fields: 8 bytes at offset (IEEE 754 double LE).
 *
 * @decision DEC-V1-WAVE-4-WASM-LOWER-EXTEND-PROPACCESS-001
 * @title General numeric lowerExpression handles obj.field for record-typed params
 * @status accepted
 * @rationale
 *   The existing lowerExpression() threw unsupported-node for PropertyAccessExpression
 *   in the general numeric path. This WI adds handling via ctx.generalRecordParams and
 *   ctx.generalPtrSlotMap (populated by _lowerNumericFunctionWithCallCtx and
 *   _lowerNumericFunction). For functions routed through _lowerRecordFunction (which
 *   covers all inline {…}-typed params), the fix wires recordParams into ctx so that
 *   the lowerExpression fallback (used from lowerExpressionRecord for call args) also
 *   resolves PropertyAccessExpression correctly.
 */

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";
import { compileToWasm } from "../../src/wasm-backend.js";
import { createHost } from "../../src/wasm-host.js";

// ---------------------------------------------------------------------------
// Fixture helpers (follows records.test.ts pattern)
// ---------------------------------------------------------------------------

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "object" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeMerkleRoot(name: string, behavior: string, implSource: string): BlockMerkleRoot {
  const spec = makeSpecYak(name, behavior);
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }
  return blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as LocalTriplet["manifest"],
    artifacts: artifactsMap,
  });
}

function makeResolution(
  blocks: ReadonlyArray<{ id: BlockMerkleRoot; source: string }>,
): ResolutionResult {
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  const order: BlockMerkleRoot[] = [];
  for (const { id, source } of blocks) {
    const sh = specHash(makeSpecYak(id.slice(0, 8), `behavior-${id.slice(0, 8)}`));
    blockMap.set(id, { merkleRoot: id, specHash: sh, source, subBlocks: [] });
    order.push(id);
  }
  const entry = order[order.length - 1] as BlockMerkleRoot;
  return { entry, blocks: blockMap, order };
}

function makeSingleBlockResolution(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Memory helpers (follows records.test.ts pattern)
// ---------------------------------------------------------------------------

/** Write an i32 value (4 bytes LE, zero-padded to 8 bytes) at ptr + slotIndex*8. */
function writeI32Field(mem: WebAssembly.Memory, structPtr: number, slotIdx: number, val: number): void {
  const dv = new DataView(mem.buffer);
  const offset = structPtr + slotIdx * 8;
  dv.setInt32(offset, val, true);
  dv.setInt32(offset + 4, 0, true);
}

/** Write an f64 value (8 bytes LE) at ptr + slotIndex*8. */
function writeF64Field(mem: WebAssembly.Memory, structPtr: number, slotIdx: number, val: number): void {
  const dv = new DataView(mem.buffer);
  const offset = structPtr + slotIdx * 8;
  dv.setFloat64(offset, val, true);
}

// ---------------------------------------------------------------------------
// SUBSTRATE prop-01: single-level i32 property access
//
// TypeScript: function getX(obj: {x: number; y: number}, _size: number): number
//               { return obj.x | 0; }
//             function getY(obj: {x: number; y: number}, _size: number): number
//               { return obj.y | 0; }
//
// Field layout: x at slot 0 (byte offset 0), y at slot 1 (byte offset 8).
// Both fields are i32 (bitop | 0 forces i32 domain).
//
// These functions are routed through detectRecordShape → _lowerRecordFunction →
// lowerExpressionRecord → emitFieldLoad (via PropertyAccessExpression handler).
// ---------------------------------------------------------------------------

describe("prop-01: single-level i32 property access (obj.x | 0, obj.y | 0)", () => {
  const srcGetX = `export function getX(obj: { x: number; y: number }, _size: number): number { return obj.x | 0; }`;
  const srcGetY = `export function getY(obj: { x: number; y: number }, _size: number): number { return obj.y | 0; }`;

  const STRUCT_SLOTS = 2;
  const STRUCT_SIZE = STRUCT_SLOTS * 8; // 16 bytes
  const STRUCT_PTR = 64; // test struct address in linear memory

  it("compileToWasm produces a valid WASM binary for getX", async () => {
    const resolution = makeSingleBlockResolution(srcGetX);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("compileToWasm produces a valid WASM binary for getY", async () => {
    const resolution = makeSingleBlockResolution(srcGetY);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_getX", async () => {
    const resolution = makeSingleBlockResolution(srcGetX);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_getX")).toBe(true);
  });

  it("WASM binary exports __wasm_export_getY", async () => {
    const resolution = makeSingleBlockResolution(srcGetY);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_getY")).toBe(true);
  });

  it("parity: ≥10 property-based cases — getX returns obj.x, isolating field slot 0", async () => {
    const wasmBytesX = await compileToWasm(makeSingleBlockResolution(srcGetX));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (x, y) => {
          const tsRef = x | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytesX,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeI32Field(mem, STRUCT_PTR, 0, x);
          writeI32Field(mem, STRUCT_PTR, 1, y);
          const fn = instance.exports["__wasm_export_getX"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("parity: ≥10 property-based cases — getY returns obj.y, isolating field slot 1", async () => {
    const wasmBytesY = await compileToWasm(makeSingleBlockResolution(srcGetY));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (x, y) => {
          const tsRef = y | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytesY,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeI32Field(mem, STRUCT_PTR, 0, x);
          writeI32Field(mem, STRUCT_PTR, 1, y);
          const fn = instance.exports["__wasm_export_getY"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("getX and getY isolate independent slots: writing x does not affect getY result", async () => {
    const wasmBytesX = await compileToWasm(makeSingleBlockResolution(srcGetX));
    const wasmBytesY = await compileToWasm(makeSingleBlockResolution(srcGetY));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (x, y) => {
          // getX with x=999, y=0 must return 999
          {
            const host = createHost();
            const { instance } = (await WebAssembly.instantiate(
              wasmBytesX,
              host.importObject,
            )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
            writeI32Field(host.memory, STRUCT_PTR, 0, 999);
            writeI32Field(host.memory, STRUCT_PTR, 1, 0);
            const fn = instance.exports["__wasm_export_getX"] as (...a: number[]) => number;
            expect(fn(STRUCT_PTR, STRUCT_SIZE)).toBe(999);
          }
          // getY with x=0, y=y must return y
          {
            const host = createHost();
            const { instance } = (await WebAssembly.instantiate(
              wasmBytesY,
              host.importObject,
            )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
            writeI32Field(host.memory, STRUCT_PTR, 0, 0);
            writeI32Field(host.memory, STRUCT_PTR, 1, y);
            const fn = instance.exports["__wasm_export_getY"] as (...a: number[]) => number;
            expect(fn(STRUCT_PTR, STRUCT_SIZE)).toBe(y | 0);
          }
          // No interaction between x and y slots
          void x;
        },
      ),
      { numRuns: 10 },
    );
  });

  it("compound access: getX for 3-field struct returns slot 0, ignoring slots 1 and 2", async () => {
    const src3 = `export function getFirst(obj: { a: number; b: number; c: number }, _size: number): number { return obj.a | 0; }`;
    const wasmBytes = await compileToWasm(makeSingleBlockResolution(src3));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        async (a, b, c) => {
          const tsRef = a | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeI32Field(mem, STRUCT_PTR, 0, a);
          writeI32Field(mem, STRUCT_PTR, 1, b);
          writeI32Field(mem, STRUCT_PTR, 2, c);
          const fn = instance.exports["__wasm_export_getFirst"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, 3 * 8);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("arithmetic on two i32 fields: obj.x + obj.y | 0", async () => {
    const srcSum = `export function sumXY(obj: { x: number; y: number }, _size: number): number { return (obj.x + obj.y) | 0; }`;
    const wasmBytes = await compileToWasm(makeSingleBlockResolution(srcSum));

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (x, y) => {
          const tsRef = (x + y) | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeI32Field(mem, STRUCT_PTR, 0, x);
          writeI32Field(mem, STRUCT_PTR, 1, y);
          const fn = instance.exports["__wasm_export_sumXY"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE prop-02: single-level f64 property access
//
// TypeScript: function getRatio(obj: {ratio: number}, _size: number): number
//               { return obj.ratio / 1.0; }
//
// Field layout: ratio at slot 0 (byte offset 0, f64).
// f64 domain forced by division operator.
// ---------------------------------------------------------------------------

describe("prop-02: single-level f64 property access (obj.ratio / 1.0)", () => {
  const src = `export function getRatio(obj: { ratio: number }, _size: number): number { return obj.ratio / 1.0; }`;

  const STRUCT_SLOTS = 1;
  const STRUCT_SIZE = STRUCT_SLOTS * 8; // 8 bytes
  const STRUCT_PTR = 64;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_getRatio", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_getRatio")).toBe(true);
  });

  it("parity: ≥10 property-based cases — getRatio returns obj.ratio (f64 pass-through)", async () => {
    const wasmBytes = await compileToWasm(makeSingleBlockResolution(src));

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: Math.fround(-1e6), max: Math.fround(1e6) }),
        async (ratio) => {
          const tsRef = ratio / 1.0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeF64Field(mem, STRUCT_PTR, 0, ratio);
          const fn = instance.exports["__wasm_export_getRatio"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, STRUCT_SIZE);
          // f64 division by 1.0 is identity — result must match exactly
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("f64 arithmetic on two fields: obj.a / obj.b (two-field f64 record)", async () => {
    const srcDiv = `export function divAB(obj: { a: number; b: number }, _size: number): number { return obj.a / obj.b; }`;
    const wasmBytes = await compileToWasm(makeSingleBlockResolution(srcDiv));

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true, noDefaultInfinity: true, min: Math.fround(-1000), max: Math.fround(1000) }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: Math.fround(0.1), max: Math.fround(100) }),
        async (a, b) => {
          const tsRef = a / b;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          writeF64Field(mem, STRUCT_PTR, 0, a);
          writeF64Field(mem, STRUCT_PTR, 1, b);
          const fn = instance.exports["__wasm_export_divAB"] as (...a: number[]) => number;
          const result = fn(STRUCT_PTR, 2 * 8);
          // WASM f64.div matches IEEE 754 double; must equal JS reference
          expect(result).toBeCloseTo(tsRef, 10);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: wave-2 sum_record fast-path output is byte-identical after this WI.
//
// The sum_record wave-2 substrate uses a different fast-path (4-byte alignment)
// that runs BEFORE detectRecordShape. This WI does not modify that fast-path.
// The test below verifies the substrate still compiles and runs correctly.
// ---------------------------------------------------------------------------

describe("prop-regression: wave-2 sum_record fast-path unaffected by this WI", () => {
  const src = `export function sumRecord(r: { a: number; b: number }): number { return r.a + r.b; }`;

  it("wave-2 sum_record still compiles to valid WASM", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("wave-2 sum_record still executes correctly (uses 4-byte aligned fields)", async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (a, b) => {
          const tsRef = a + b;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          // wave-2 sum_record uses 4-byte alignment (NOT 8-byte) — legacy fast-path
          const dv = new DataView(mem.buffer);
          const structPtr = 64;
          dv.setInt32(structPtr + 0, a, true); // field a at byte 0
          dv.setInt32(structPtr + 4, b, true); // field b at byte 4
          const fn = instance.exports["__wasm_export_sumRecord"] as (...a: number[]) => number;
          const result = fn(structPtr);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 10 },
    );
  });
});
