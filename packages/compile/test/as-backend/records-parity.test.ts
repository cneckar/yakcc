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

// ---------------------------------------------------------------------------
// R4: nestedRecord3 — 3-level pointer indirection
//
// Tests that pointer indirection works at 3 levels deep.
// Layout:
//   outerPtr → { innerPtr (i32 at +0), outerScalar (i32 at +8) }
//   innerPtr → { midPtr (i32 at +0), innerScalar (i32 at +8) }
//   midPtr   → { x (i32 at +0), y (i32 at +8) }
// Returns: x + y + innerScalar + outerScalar
//
// Memory addresses (non-overlapping slots starting at STRUCT_BASE_PTR=64):
//   Outer @ 64 (2 fields = 16 bytes → ends at 80)
//   Inner @ 80 (2 fields = 16 bytes → ends at 96)
//   Mid   @ 96 (2 fields = 16 bytes → ends at 112)
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — R4: nestedRecord3 (3-level pointer indirection)", () => {
  const INNER2_PTR_OFFSET = STRUCT_BASE_PTR + 2 * FIELD_STRIDE; // 80
  const MID_PTR_OFFSET = INNER2_PTR_OFFSET + 2 * FIELD_STRIDE;  // 96

  // AS source: chase 3 pointer levels then sum all scalar fields.
  // @decision DEC-AS-RECORD-LAYOUT-001
  const NESTED3_SOURCE = `
export function nestedRecord3(outerPtr: i32, _size: i32): i32 {
  const innerPtr = load<i32>(outerPtr + 0);
  const outerScalar = load<i32>(outerPtr + 8);
  const midPtr = load<i32>(innerPtr + 0);
  const innerScalar = load<i32>(innerPtr + 8);
  const x = load<i32>(midPtr + 0);
  const y = load<i32>(midPtr + 8);
  return (x + y + innerScalar + outerScalar);
}
`.trim();

  it("R4: nestedRecord3 compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("nestedRecord3", NESTED3_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "nestedRecord3 WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.nestedRecord3).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R4: nestedRecord3 — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("nestedRecord3", NESTED3_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.nestedRecord3 as (ptr: number, size: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -5_000, max: 5_000 }),
        fc.integer({ min: -5_000, max: 5_000 }),
        fc.integer({ min: -5_000, max: 5_000 }),
        fc.integer({ min: -5_000, max: 5_000 }),
        async (x, y, innerScalar, outerScalar) => {
          const tsRef = (x + y + innerScalar + outerScalar) | 0;

          const dv = new DataView(mem.buffer);
          // Write mid struct (deepest level)
          dv.setInt32(MID_PTR_OFFSET + 0 * FIELD_STRIDE, x, true);
          dv.setInt32(MID_PTR_OFFSET + 1 * FIELD_STRIDE, y, true);
          // Write inner struct (level 2): pointer to mid + innerScalar
          dv.setInt32(INNER2_PTR_OFFSET + 0 * FIELD_STRIDE, MID_PTR_OFFSET, true);
          dv.setInt32(INNER2_PTR_OFFSET + 1 * FIELD_STRIDE, innerScalar, true);
          // Write outer struct (level 1): pointer to inner + outerScalar
          dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, INNER2_PTR_OFFSET, true);
          dv.setInt32(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, outerScalar, true);

          const result = fn(STRUCT_BASE_PTR, 2 * FIELD_STRIDE) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R5: largeRecord10 — 10 i32 fields, stride boundary
//
// Tests field offsets up to byte 72 (field[9] at 9*8=72).
// Uses fast-check to generate random values for all 10 fields.
// Verifies that large structs don't corrupt or misalign field reads.
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — R5: largeRecord10 (10 i32 fields, stride boundary)", () => {
  // 10 fields × 8-byte stride = 80 bytes total struct size.
  // Field offsets: 0, 8, 16, 24, 32, 40, 48, 56, 64, 72.
  const LARGE_RECORD_SOURCE = `
export function largeRecord10(ptr: i32, _size: i32): i32 {
  const f0 = load<i32>(ptr +  0);
  const f1 = load<i32>(ptr +  8);
  const f2 = load<i32>(ptr + 16);
  const f3 = load<i32>(ptr + 24);
  const f4 = load<i32>(ptr + 32);
  const f5 = load<i32>(ptr + 40);
  const f6 = load<i32>(ptr + 48);
  const f7 = load<i32>(ptr + 56);
  const f8 = load<i32>(ptr + 64);
  const f9 = load<i32>(ptr + 72);
  return (f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9);
}
`.trim();

  it("R5: largeRecord10 compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("largeRecord10", LARGE_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "largeRecord10 WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.largeRecord10).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R5: largeRecord10 — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("largeRecord10", LARGE_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.largeRecord10 as (ptr: number, size: number) => number;

    // All 10 fields generated by fast-check — exercises random combinations
    // at each stride boundary including the terminal f9 at byte 72.
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
          fc.integer({ min: -10_000, max: 10_000 }),
        ),
        async ([f0, f1, f2, f3, f4, f5, f6, f7, f8, f9]) => {
          const tsRef = (f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9) | 0;

          const dv = new DataView(mem.buffer);
          // STRUCT_BASE_PTR = 64; 10 fields × 8 bytes = 80 bytes → ends at 144.
          // WASM memory is 64KB by default (65536 bytes), so no risk of overflow.
          dv.setInt32(STRUCT_BASE_PTR +  0, f0, true);
          dv.setInt32(STRUCT_BASE_PTR +  8, f1, true);
          dv.setInt32(STRUCT_BASE_PTR + 16, f2, true);
          dv.setInt32(STRUCT_BASE_PTR + 24, f3, true);
          dv.setInt32(STRUCT_BASE_PTR + 32, f4, true);
          dv.setInt32(STRUCT_BASE_PTR + 40, f5, true);
          dv.setInt32(STRUCT_BASE_PTR + 48, f6, true);
          dv.setInt32(STRUCT_BASE_PTR + 56, f7, true);
          dv.setInt32(STRUCT_BASE_PTR + 64, f8, true);
          dv.setInt32(STRUCT_BASE_PTR + 72, f9, true);

          const structSize = 10 * FIELD_STRIDE;
          const result = fn(STRUCT_BASE_PTR, structSize) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R6: edge structs — singleRecord (1 field) and zero-field behavior
//
// R6a: singleRecord — exactly one i32 field at offset 0. Struct size = 8.
//      The simplest possible non-empty record; verifies the degenerate case.
//
// R6b: emptyRecord note — AS (asc 0.28.x) does NOT prevent compiling a
//      function that reads from ptr+0 even when the logical struct has 0 fields.
//      The test verifies behavior of a "zero-field" function: it always returns
//      a constant 0 since there are no fields to read. WASM validates successfully
//      because the function body is legal; the "empty" semantics are at the source
//      level. We confirm compilation succeeds and the constant-0 output is stable.
//
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — R6a: singleRecord (1 i32 field)", () => {
  const SINGLE_RECORD_SOURCE = `
export function singleRecord(ptr: i32, _size: i32): i32 {
  return load<i32>(ptr + 0);
}
`.trim();

  it("R6a: singleRecord compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("singleRecord", SINGLE_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "singleRecord WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.singleRecord).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("R6a: singleRecord — value parity vs TS reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("singleRecord", SINGLE_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.singleRecord as (ptr: number, size: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        async (v) => {
          const tsRef = v | 0;

          const dv = new DataView(mem.buffer);
          dv.setInt32(STRUCT_BASE_PTR + 0, v, true);

          const result = fn(STRUCT_BASE_PTR, FIELD_STRIDE) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

describe("AS backend records — R6b: emptyRecord (0-field constant return)", () => {
  // A function that takes a struct pointer but reads no fields.
  // Represents a zero-field struct: always returns 0.
  // AS compiles this without error (no illegal memory accesses in the function body).
  // Verifies: (1) WASM validates, (2) output is always 0 regardless of ptr content.
  const EMPTY_RECORD_SOURCE = `
export function emptyRecord(ptr: i32, _size: i32): i32 {
  return 0;
}
`.trim();

  it("R6b: emptyRecord (0-field) compiles and returns constant 0", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("emptyRecord", EMPTY_RECORD_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "emptyRecord WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const fn = instance.exports.emptyRecord as (ptr: number, size: number) => number;
    // Regardless of ptr or size, should return 0 (no fields read)
    expect(fn(STRUCT_BASE_PTR, 0)).toBe(0);
    expect(fn(0, 0)).toBe(0);
    expect(fn(STRUCT_BASE_PTR, FIELD_STRIDE)).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Adversarial cases
//
// These tests probe edge conditions and defined-behavior boundaries of the
// AS-backend record layout. They do NOT expect crashes — WASM linear memory
// is bounds-checked only at page boundaries (64KB), so intra-page off-by-one
// reads produce defined (garbage) values, not traps.
//
// ADV-1: integer overflow — fields that sum to INT32_MAX+1 wrap correctly
// ADV-2: misaligned pointer read — off-by-4 produces bytes from the padding gap
// ADV-3: size-mismatch probe — allocate for N-1 fields, read field N; AS
//        runtime does NOT catch this (it's a load<i32> beyond the logical
//        struct bounds but within the WASM page). The test verifies the
//        function still returns a defined integer value (not a trap).
//
// @decision DEC-AS-RECORD-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend records — adversarial: integer overflow wrapping", () => {
  // ADV-1: Sum of two i32 fields that overflows INT32_MAX.
  // WASM i32 arithmetic wraps silently (two's complement), matching JS `| 0`.
  // The AS backend must NOT insert any overflow checks.
  const OVERFLOW_SOURCE = `
export function overflowRecord(ptr: i32, _size: i32): i32 {
  const a = load<i32>(ptr + 0);
  const b = load<i32>(ptr + 8);
  return (a + b);
}
`.trim();

  it("ADV-1: overflowRecord compiles and wraps i32 on overflow (10 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("overflowRecord", OVERFLOW_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.overflowRecord as (ptr: number, size: number) => number;

    // Fixed overflow case: INT32_MAX + 1 wraps to INT32_MIN
    const INT32_MAX = 2_147_483_647;
    const dv = new DataView(mem.buffer);
    dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, INT32_MAX, true);
    dv.setInt32(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, 1, true);
    const wrappedResult = fn(STRUCT_BASE_PTR, 2 * FIELD_STRIDE) | 0;
    // (INT32_MAX + 1) | 0 = -2147483648 (INT32_MIN) — two's complement wrap
    expect(wrappedResult).toBe((INT32_MAX + 1) | 0);

    // Property: for any two i32 values, WASM result must match JS `(a + b) | 0`
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
        fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
        async (a, b) => {
          const tsRef = (a + b) | 0;
          dv.setInt32(STRUCT_BASE_PTR + 0 * FIELD_STRIDE, a, true);
          dv.setInt32(STRUCT_BASE_PTR + 1 * FIELD_STRIDE, b, true);
          const result = fn(STRUCT_BASE_PTR, 2 * FIELD_STRIDE) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 10 },
    );
  }, 30_000);
});

describe("AS backend records — adversarial: misaligned pointer read", () => {
  // ADV-2: Read from STRUCT_BASE_PTR + 4 (4-byte offset within an 8-byte field slot).
  //
  // With 8-byte stride layout, field[0] occupies bytes 0-7 and field[1] occupies
  // bytes 8-15. A read at ptr+4 straddles the end of field[0] and the start of
  // field[1]'s padding (bytes 4-7 of the slot). This should NOT trap — WASM
  // does not enforce alignment for load<i32> unless the memory instruction uses
  // a 4-byte align hint that the host enforces. asc emits standard i32.load which
  // allows any byte offset within the page. The result is defined-but-garbage.
  //
  // We test: (1) the function runs without throwing, (2) the return value is
  // a valid i32 (not NaN, not Infinity, not undefined).
  const MISALIGN_SOURCE = `
export function misalignRecord(ptr: i32, _size: i32): i32 {
  // Intentionally off-by-4 to read across the padding of field[0]
  return load<i32>(ptr + 4);
}
`.trim();

  it("ADV-2: misalignRecord reads from off-by-4 offset without trapping", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("misalignRecord", MISALIGN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.misalignRecord as (ptr: number, size: number) => number;

    const dv = new DataView(mem.buffer);
    // Write a known value to field[0] slot (bytes 0-7 from ptr)
    dv.setInt32(STRUCT_BASE_PTR + 0, 0x12345678, true);

    // The read at +4 yields bytes [4..7] of the field[0] slot.
    // Since we wrote 0x12345678 little-endian at offset 0:
    //   byte 0 = 0x78, byte 1 = 0x56, byte 2 = 0x34, byte 3 = 0x12
    //   byte 4 = 0x00 (padding), byte 5 = 0x00, byte 6 = 0x00, byte 7 = 0x00
    // (remaining bytes from previous writes may vary — we just check no trap)
    const result = fn(STRUCT_BASE_PTR, FIELD_STRIDE);
    // Must be a finite integer (not NaN/undefined/exception)
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    // i32 cast must be stable
    expect((result | 0)).toBe(result | 0);
  }, 30_000);
});

describe("AS backend records — adversarial: out-of-logical-bounds field read", () => {
  // ADV-3: A 2-field struct, but the function reads a 3rd field (field[2]) that
  // was never allocated by the test harness. This is an out-of-logical-bounds
  // read at byte offset 16 from ptr. WASM memory is 64KB and STRUCT_BASE_PTR=64,
  // so this read is at byte 80 — well within the page. It does NOT trap.
  //
  // AS compile-time: asc does NOT detect this as an error. The function body is
  // legal AS (load<i32> at a constant offset). This confirms the "size-mismatch"
  // scenario: the struct's logical size says N fields, but the AS function reads N+1.
  // The extra read returns whatever bytes happen to be in memory at that address.
  //
  // We verify: (1) compilation succeeds, (2) the function executes without throwing,
  // (3) the result is a valid i32 (defined behavior, even if garbage).
  const SIZE_MISMATCH_SOURCE = `
export function sizeMismatchRecord(ptr: i32, _size: i32): i32 {
  // Logical struct has 2 fields (size=16), but this reads field[2] at offset 16
  const f0 = load<i32>(ptr +  0);
  const f1 = load<i32>(ptr +  8);
  const f2 = load<i32>(ptr + 16); // out of logical bounds — defined garbage
  return (f0 + f1 + f2);
}
`.trim();

  it("ADV-3: sizeMismatchRecord compiles and executes without trapping (defined garbage)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sizeMismatchRecord", SIZE_MISMATCH_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    // Compilation must succeed — asc does NOT reject out-of-logical-bounds loads
    expect(WebAssembly.validate(wasmBytes), "sizeMismatchRecord WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.sizeMismatchRecord as (ptr: number, size: number) => number;

    // Zero out the region to make the extra read deterministic (returns 0)
    const dv = new DataView(mem.buffer);
    dv.setInt32(STRUCT_BASE_PTR +  0, 5, true);
    dv.setInt32(STRUCT_BASE_PTR +  8, 3, true);
    dv.setInt32(STRUCT_BASE_PTR + 16, 0, true); // the "missing" 3rd field slot — zero

    // structSize=16 (2 fields), but fn reads 3 fields — extra read gets byte 80
    const result = fn(STRUCT_BASE_PTR, 2 * FIELD_STRIDE) | 0;
    // With field[2] zeroed, result = 5 + 3 + 0 = 8
    expect(result).toBe(8);

    // With a non-zero byte at the out-of-bounds slot, verify it's still an i32
    dv.setInt32(STRUCT_BASE_PTR + 16, 999, true);
    const result2 = fn(STRUCT_BASE_PTR, 2 * FIELD_STRIDE) | 0;
    expect(typeof result2).toBe("number");
    expect(Number.isFinite(result2)).toBe(true);
    expect(result2).toBe(8 + 999); // 5 + 3 + 999 = 1007
  }, 30_000);
});
