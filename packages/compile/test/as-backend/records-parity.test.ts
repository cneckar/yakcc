// SPDX-License-Identifier: MIT
//
// records-parity.test.ts — AS-backend T2: record substrates (P3 bucket)
//
// @decision DEC-AS-RECORD-LAYOUT-001
// Title: AS-backend records use flat-struct linear-memory layout matching
//        wave-3 (8-byte field alignment, little-endian, host-allocated struct ptrs).
// Status: decided (WI-AS-PHASE-2A-MULTI-EXPORT-AND-RECORDS, 2026-05-10)
// Rationale:
//   Records lower to (ptr: i32, _struct_size: i32) on the stack. Field access
//   lowers to load<T>(ptr + field_index * 8) where T is i32/i64/f64.
//   8-byte uniform alignment keeps field offsets predictable and matches wave-3's
//   DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001 so the differential oracle stays
//   directly comparable. Compatible with --runtime stub (no AS GC dependency).
//
//   AS source emission shape: the function signature takes (ptr: i32, size: i32)
//   and uses AS built-in load<T>(ptr + offset) to read field values.
//   The test harness writes struct bytes into the exported WASM memory via
//   DataView, then calls the function, then compares against the inline TS ref.
//
//   Memory export: assemblyScriptBackend({ exportMemory: true }) is used for
//   record substrates. The default (exportMemory: false) is Phase 1 behaviour.
//   @decision DEC-AS-BACKEND-OPTIONS-001
//
// Three substrates (per eval contract T2):
//   R1: sumRecord3 — sum of 3 i32 fields at offsets 0, 8, 16
//   R2: mixedRecord — i32 field + f64 field + i32 field (offsets 0, 8, 16)
//   R3: nestedRecord — 2-level nesting via 2 sequential struct ptrs
//       (outer struct has ptr-to-inner at offset 0 + scalar at offset 8)
//
// Minimum 20 fast-check runs per substrate (eval contract T2).

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { assemblyScriptBackend } from "../../src/as-backend.js";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "a", type: "number" }],
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

function makeSourceResolution(name: string, source: string): ResolutionResult {
  const id = makeMerkleRoot(name, `Record substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Memory layout constants
// @decision DEC-AS-RECORD-LAYOUT-001
// Fields are 8-byte aligned regardless of actual type width.
// This matches wave-3's DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001.
// ---------------------------------------------------------------------------

const FIELD_STRIDE = 8; // bytes per field slot (uniform alignment)
const STRUCT_BASE_PTR = 64; // safe base pointer (avoids AS stub runtime header bytes)

// ---------------------------------------------------------------------------
// R1: sumRecord3 — sum of 3 i32 fields
//
// AS source: reads three i32 values from consecutive 8-byte slots starting at ptr.
// TypeScript reference: a + b + c (integer addition).
// ---------------------------------------------------------------------------

describe("AS backend records — R1: sumRecord3 (3 i32 fields, 8-byte stride)", () => {
  // AS source for sumRecord3.
  // ptr: pointer to first field; _size: struct size (ignored, for API parity with wave-3).
  // Field layout: field[0]=load<i32>(ptr+0), field[1]=load<i32>(ptr+8), field[2]=load<i32>(ptr+16).
  // @decision DEC-AS-RECORD-LAYOUT-001
  const SUMRECORD3_SOURCE = `
export function sumRecord3(ptr: i32, _size: i32): i32 {
  const a = load<i32>(ptr + 0);
  const b = load<i32>(ptr + 8);
  const c = load<i32>(ptr + 16);
  return (a + b + c);
}
`.trim();

  it("R1: sumRecord3 compiles to valid WASM with exported memory", async () => {
    // exportMemory: true so the test can write struct bytes before calling.
    // @decision DEC-AS-BACKEND-OPTIONS-001
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sumRecord3", SUMRECORD3_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "sumRecord3 WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.sumRecord3).toBe("function");
    // Memory must be exported when exportMemory: true
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R1: sumRecord3 — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sumRecord3", SUMRECORD3_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.sumRecord3 as (ptr: number, size: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (a, b, c) => {
          const tsRef = (a + b + c) | 0;

          // Write struct into WASM memory via DataView
          const dv = new DataView(mem.buffer);
          dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, a, true); // little-endian
          dv.setInt32(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, b, true);
          dv.setInt32(STRUCT_BASE_PTR + 2 * FIELD_STRIDE, c, true);

          const structSize = 3 * FIELD_STRIDE;
          const result = fn(STRUCT_BASE_PTR, structSize);
          expect(result | 0).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R2: mixedRecord — i32 field, f64 field, i32 field
//
// Exercises mixed-type record layout. The f64 field occupies a full 8-byte slot
// (naturally aligned since stride = 8). Result: i32_a + f64_b_floor + i32_c
// (truncated to i32 via bitop to match WASM i32 output).
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — R2: mixedRecord (i32, f64, i32 fields)", () => {
  // Field layout: field[0]=i32 at ptr+0, field[1]=f64 at ptr+8, field[2]=i32 at ptr+16.
  // Returns (a + Math.trunc(b_f64) + c) as i32.
  const MIXED_RECORD_SOURCE = `
export function mixedRecord(ptr: i32, _size: i32): i32 {
  const a = load<i32>(ptr + 0);
  const b = load<f64>(ptr + 8);
  const c = load<i32>(ptr + 16);
  return (a + <i32>b + c);
}
`.trim();

  it("R2: mixedRecord compiles and exports memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("mixedRecord", MIXED_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes)).toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.mixedRecord).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R2: mixedRecord — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("mixedRecord", MIXED_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.mixedRecord as (ptr: number, size: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.float({ noNaN: true, noDefaultInfinity: true, min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        async (a, bF64, c) => {
          // TS reference: truncate f64 to i32 (matching AS <i32> cast)
          const tsRef = (a + Math.trunc(bF64) + c) | 0;

          const dv = new DataView(mem.buffer);
          dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, a, true);
          dv.setFloat64(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, bF64, true);
          dv.setInt32(STRUCT_BASE_PTR + 2 * FIELD_STRIDE, c, true);

          const structSize = 3 * FIELD_STRIDE;
          const result = fn(STRUCT_BASE_PTR, structSize) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R3: nestedRecord — 2-level nesting
//
// Outer struct: innerPtr (i32) at offset 0, scalar (i32) at offset 8.
// Inner struct: field_x (i32) at offset 0, field_y (i32) at offset 8.
// Returns inner.x + inner.y + outer.scalar.
//
// The outer struct holds a POINTER to the inner struct (also in WASM memory).
// This is the simplest possible 2-level nesting that exercises pointer
// indirection in flat-struct linear-memory layout.
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — R3: nestedRecord (2-level pointer indirection)", () => {
  // inner struct base pointer: placed after outer struct to avoid overlap
  const INNER_PTR_OFFSET = STRUCT_BASE_PTR + 2 * FIELD_STRIDE; // 64 + 16 = 80

  const NESTED_RECORD_SOURCE = `
export function nestedRecord(outerPtr: i32, _size: i32): i32 {
  // Read inner struct pointer from outer struct's first field
  const innerPtr = load<i32>(outerPtr + 0);
  // Read scalar from outer struct's second field
  const scalar = load<i32>(outerPtr + 8);
  // Read two fields from inner struct
  const x = load<i32>(innerPtr + 0);
  const y = load<i32>(innerPtr + 8);
  return (x + y + scalar);
}
`.trim();

  it("R3: nestedRecord compiles and exports memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("nestedRecord", NESTED_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes)).toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.nestedRecord).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R3: nestedRecord — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("nestedRecord", NESTED_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.nestedRecord as (ptr: number, size: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.integer({ min: -10_000, max: 10_000 }),
        async (x, y, scalar) => {
          const tsRef = (x + y + scalar) | 0;

          const dv = new DataView(mem.buffer);
          // Write inner struct at INNER_PTR_OFFSET
          dv.setInt32(INNER_PTR_OFFSET + 0, x, true);
          dv.setInt32(INNER_PTR_OFFSET + FIELD_STRIDE, y, true);
          // Write outer struct at STRUCT_BASE_PTR:
          //   field[0] = pointer to inner struct (i32 = address in WASM memory)
          //   field[1] = scalar
          dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, INNER_PTR_OFFSET, true);
          dv.setInt32(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, scalar, true);

          const outerStructSize = 2 * FIELD_STRIDE;
          const result = fn(STRUCT_BASE_PTR, outerStructSize) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});
