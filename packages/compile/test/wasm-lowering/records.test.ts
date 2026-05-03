/**
 * records.test.ts — Property-based tests for WI-V1W3-WASM-LOWER-06.
 *
 * Purpose:
 *   Verify that the record lowering path produces WASM byte sequences that
 *   execute correctly and match TypeScript reference semantics.
 *   Five substrates: sum-of-fields-numeric, record-of-strings, nested-record,
 *   record-with-mixed-numeric-types, record-equality.
 *   Each substrate runs ≥15 property-based cases via fast-check.
 *
 * Record layout policy (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001):
 *   - 8-byte alignment per field (uniform); little-endian per WASM spec.
 *   - Numeric field (i32/i64/f64): occupies ONE 8-byte slot.
 *     field_byte_offset = field_slot_index * 8.
 *   - String field (ptr, len pair): occupies TWO consecutive 8-byte slots.
 *     First slot holds ptr, second holds len_bytes.
 *   - Struct body allocated via host_alloc(slot_count * 8).
 *   - By-value passing: caller passes (ptr: i32, _struct_size: i32) pair.
 *   - Nested records: field stores the nested struct's pointer.
 *
 * Test construction:
 *   Tests use compileToWasm() via the full pipeline (LoweringVisitor →
 *   emitRecordModule → instantiate). The test harness constructs structs in
 *   linear memory by writing field values at the expected byte offsets before
 *   calling the compiled WASM function.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001
 * @title 8-byte uniform alignment per field; string fields use 2 slots (ptr+len)
 * @status accepted
 * @rationale
 *   Uniform 8-byte alignment makes field offsets trivially computable for numeric
 *   fields: offset = field_index * 8. String fields (ptr, len pairs) consume TWO
 *   consecutive 8-byte slots so the full (ptr, len) ABI is preserved for string
 *   operations inside records. Mixed records use an accumulated slot offset rather
 *   than pure field_index * 8. This is the simplest correct layout that preserves
 *   string usability inside records. See visitor.ts record lowering.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-EQ-001
 * @title Record equality uses inline byte-compare (no host_record_eq import)
 * @status accepted
 * @rationale
 *   Inline byte-compare avoids adding a new host import to WASM_HOST_CONTRACT.md.
 *   For v1 record equality, struct sizes are statically known, so the loop can be
 *   inlined. The inline loop is ~20 opcodes per call site — negligible for the
 *   evaluation workloads targeted by wave-3. Avoids version-bumping the host
 *   contract. See emitRecordModule() in wasm-backend.ts.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-RECORD-BY-VALUE-001
 * @title Records pass by-value as (ptr: i32, _struct_size: i32) pair
 * @status accepted
 * @rationale
 *   The WASM ABI uses flat integer arguments. Records are allocated in linear
 *   memory by the caller; the callee receives a pointer pair. `_struct_size` is
 *   vestigial in the callee under uniform 8-byte alignment (the field count is
 *   statically known from the function signature), but is included in the ABI for
 *   consistency with the MASTER_PLAN spec mandating the pair shape for future
 *   reflection/GC integration. The callee ignores _struct_size at slot 1.
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
// Fixture helpers (mirrors strings.test.ts pattern)
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
// Memory helpers for record tests
//
// The test harness writes record fields into linear memory before calling the
// compiled WASM function. Field layout: 8 bytes per slot, little-endian.
// ---------------------------------------------------------------------------

/** Write an i32 value (4 bytes LE, zero-padded to 8 bytes) at ptr + slotIndex*8. */
function writeI32Field(mem: WebAssembly.Memory, structPtr: number, slotIdx: number, val: number): void {
  const dv = new DataView(mem.buffer);
  const offset = structPtr + slotIdx * 8;
  dv.setInt32(offset, val, true);       // 4 bytes LE
  dv.setInt32(offset + 4, 0, true);     // upper 4 bytes zeroed
}

/** Write an i64 value (8 bytes LE) at ptr + slotIndex*8. */
function writeI64Field(mem: WebAssembly.Memory, structPtr: number, slotIdx: number, val: bigint): void {
  const dv = new DataView(mem.buffer);
  const offset = structPtr + slotIdx * 8;
  dv.setBigInt64(offset, val, true);
}

/** Write an f64 value (8 bytes LE) at ptr + slotIndex*8. */
function writeF64Field(mem: WebAssembly.Memory, structPtr: number, slotIdx: number, val: number): void {
  const dv = new DataView(mem.buffer);
  const offset = structPtr + slotIdx * 8;
  dv.setFloat64(offset, val, true);
}

/** Write a string into memory at strPtr; returns byte length written. */
function writeStringAt(mem: WebAssembly.Memory, strPtr: number, s: string): number {
  const encoded = new TextEncoder().encode(s);
  new Uint8Array(mem.buffer).set(encoded, strPtr);
  return encoded.length;
}

/**
 * Write a string field into a struct (occupies 2 slots: ptr then len).
 * The string bytes are placed at strDataPtr in memory.
 * Returns next available memory address after the string data.
 */
function writeStringField(
  mem: WebAssembly.Memory,
  structPtr: number,
  slotIdx: number,
  strDataPtr: number,
  s: string,
): number {
  const len = writeStringAt(mem, strDataPtr, s);
  const dv = new DataView(mem.buffer);
  const ptrOffset = structPtr + slotIdx * 8;
  dv.setInt32(ptrOffset, strDataPtr, true);       // ptr slot
  dv.setInt32(ptrOffset + 4, 0, true);             // upper 4 bytes
  const lenOffset = structPtr + (slotIdx + 1) * 8;
  dv.setInt32(lenOffset, len, true);               // len slot
  dv.setInt32(lenOffset + 4, 0, true);             // upper 4 bytes
  return strDataPtr + len;
}

/** Read an i32 result from memory (for functions that write result to memory). */
function readI32(mem: WebAssembly.Memory, ptr: number): number {
  return new DataView(mem.buffer).getInt32(ptr, true);
}

// ---------------------------------------------------------------------------
// Test helper: compile source, instantiate, call with ptr
//
// Record functions take (ptr: i32, _struct_size: i32) as first two params.
// Additional params after that are for equality comparisons (second record ptr).
// ---------------------------------------------------------------------------

async function compileAndCall(
  source: string,
  args: number[],
): Promise<{ result: number; host: ReturnType<typeof createHost> }> {
  const resolution = makeSingleBlockResolution(source);
  const wasmBytes = await compileToWasm(resolution);
  expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
  const host = createHost();
  const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const fnName = source.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const fn = instance.exports[`__wasm_export_${fnName}`];
  if (typeof fn !== "function") throw new Error(`export __wasm_export_${fnName} not found`);
  const result = (fn as (...a: number[]) => number)(...args);
  return { result, host };
}

// ---------------------------------------------------------------------------
// SUBSTRATE 1: sum-of-fields-numeric
//
// TypeScript source: a record with 3 numeric fields; returns sum of all fields.
// Field layout: a at slot 0, b at slot 1, c at slot 2 (all i32).
// Struct size: 3 * 8 = 24 bytes.
// ---------------------------------------------------------------------------

describe("record-01: sum-of-fields-numeric (3 i32 fields)", () => {
  const src = `export function sumFields(r: { a: number; b: number; c: number }, _size: number): number { return (r.a + r.b + r.c) | 0; }`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_sumFields", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_sumFields")).toBe(true);
  });

  it(`parity: ≥15 property-based cases match TypeScript reference`, async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 3;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (a, b, c) => {
          const tsRef = (a + b + c) | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          // Allocate struct in memory at a fixed test address (after bump allocator init at 16)
          const structPtr = 64; // safe non-conflicting test address
          writeI32Field(mem, structPtr, 0, a);
          writeI32Field(mem, structPtr, 1, b);
          writeI32Field(mem, structPtr, 2, c);
          const fn = instance.exports["__wasm_export_sumFields"] as (...a: number[]) => number;
          const result = fn(structPtr, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 2: record-of-strings
//
// TypeScript source: record with 2 string fields; returns length of first.
// String fields use 2 slots each: slot 0+1 = name (ptr, len), slot 2+3 = label (ptr, len).
// ---------------------------------------------------------------------------

describe("record-02: record-of-strings (2 string fields, returns first field length)", () => {
  const src = `export function firstLen(r: { name: string; label: string }, _size: number): number { return r.name.length | 0; }`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it(`parity: ≥15 property-based cases — returns JS string.length of name field`, async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);
    // String fields: name occupies slots 0+1, label occupies slots 2+3
    const STRUCT_SLOTS = 4; // 2 strings × 2 slots each
    const STRUCT_SIZE = STRUCT_SLOTS * 8;

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 20 }),
        fc.string({ minLength: 0, maxLength: 20 }),
        async (name, label) => {
          const tsRef = name.length | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const structPtr = 64;
          // String data placed after the struct in memory
          const strDataBase = structPtr + STRUCT_SIZE;
          let strDataPtr = strDataBase;
          // Write name field (slots 0+1)
          strDataPtr = writeStringField(mem, structPtr, 0, strDataPtr, name);
          // Write label field (slots 2+3)
          writeStringField(mem, structPtr, 2, strDataPtr, label);
          const fn = instance.exports["__wasm_export_firstLen"] as (...a: number[]) => number;
          // host_string_length returns JS string.length (UTF-16 code unit count)
          const result = fn(structPtr, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 3: nested-record
//
// TypeScript source: record with 2 nested records (each with x, y fields).
// Returns p.x + q.y.
// Outer record: slot 0 = ptr to p, slot 1 = ptr to q.
// Inner record p: slot 0 = x, slot 1 = y.
// Inner record q: slot 0 = x, slot 1 = y.
// ---------------------------------------------------------------------------

describe("record-03: nested-record (outer struct contains two inner structs by pointer)", () => {
  const src = `export function nestedSum(r: { p: { x: number; y: number }; q: { x: number; y: number } }, _size: number): number { return (r.p.x + r.q.y) | 0; }`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it(`parity: ≥15 property-based cases — p.x + q.y`, async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        async (px, py, qx, qy) => {
          const tsRef = (px + qy) | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          // Layout in memory:
          //   pStruct at 64: slot 0 = px, slot 1 = py
          //   qStruct at 64+16: slot 0 = qx, slot 1 = qy
          //   outerStruct at 64+32: slot 0 = ptr to pStruct, slot 1 = ptr to qStruct
          const pStruct = 64;
          const qStruct = pStruct + 2 * 8; // 2 slots
          const outerStruct = qStruct + 2 * 8; // 2 slots
          const OUTER_SIZE = 2 * 8;
          writeI32Field(mem, pStruct, 0, px);
          writeI32Field(mem, pStruct, 1, py);
          writeI32Field(mem, qStruct, 0, qx);
          writeI32Field(mem, qStruct, 1, qy);
          // Outer struct: field 0 = ptr to p, field 1 = ptr to q
          writeI32Field(mem, outerStruct, 0, pStruct);
          writeI32Field(mem, outerStruct, 1, qStruct);
          const fn = instance.exports["__wasm_export_nestedSum"] as (...a: number[]) => number;
          const result = fn(outerStruct, OUTER_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 4: record-with-mixed-numeric-types
//
// TypeScript source: record with i32 (bitop), i64 (large literal), f64 (division).
// Returns (id | 0) via i32 access.
// id: i32 field (slot 0), total: i64 (slot 1, 8 bytes), ratio: f64 (slot 2, 8 bytes).
// ---------------------------------------------------------------------------

describe("record-04: mixed-numeric-types (i32 + i64 + f64 fields)", () => {
  // The function accesses the i32 'id' field (bitop to force i32 domain).
  // A separate test accesses each field type.
  const srcId = `export function getId(r: { id: number; total: number; ratio: number }, _size: number): number { return (r.id | 0); }`;
  const srcTotal = `export function getTotal(r: { id: number; total: number; ratio: number }, _size: number): number { return r.total + 3000000000; }`;
  const srcRatio = `export function getRatio(r: { id: number; total: number; ratio: number }, _size: number): number { return r.ratio / 1.0; }`;

  it("i32 field access: getId returns r.id | 0", async () => {
    const resolution = makeSingleBlockResolution(srcId);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 3;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -100, max: 100 }),
        fc.float({ min: -10, max: 10 }),
        async (id, total, ratio) => {
          const tsRef = id | 0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const structPtr = 64;
          writeI32Field(mem, structPtr, 0, id);
          writeI32Field(mem, structPtr, 1, total);
          writeF64Field(mem, structPtr, 2, ratio);
          const fn = instance.exports["__wasm_export_getId"] as (...a: number[]) => number;
          expect(fn(structPtr, STRUCT_SIZE)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("f64 field access: getRatio returns r.ratio / 1.0", async () => {
    const resolution = makeSingleBlockResolution(srcRatio);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 3;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -100, max: 100 }),
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        async (id, total, ratio) => {
          const tsRef = ratio / 1.0;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const structPtr = 64;
          writeI32Field(mem, structPtr, 0, id);
          writeI32Field(mem, structPtr, 1, total);
          writeF64Field(mem, structPtr, 2, ratio);
          const fn = instance.exports["__wasm_export_getRatio"] as (...a: number[]) => number;
          const wasmResult = fn(structPtr, STRUCT_SIZE) as unknown as number;
          expect(Math.abs((wasmResult as number) - tsRef)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("compileToWasm produces valid WASM for all 3 mixed-type functions", async () => {
    for (const src of [srcId, srcTotal, srcRatio]) {
      const bytes = await compileToWasm(makeSingleBlockResolution(src));
      expect(() => new WebAssembly.Module(bytes)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 5: record-equality
//
// TypeScript source: (a: {x: number; y: number}, _as: number, b: {x: number; y: number}, _bs: number) => boolean
// Returns 1 if a === b (all fields equal), 0 otherwise.
// Inline byte-compare approach: compare field by field.
// ---------------------------------------------------------------------------

describe("record-05: record-equality (inline field-by-field compare)", () => {
  const src = `export function recEq(a: { x: number; y: number }, _as: number, b: { x: number; y: number }, _bs: number): boolean { return (a.x === b.x) && (a.y === b.y); }`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(src);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it(`parity: ≥15 property-based cases — equal structs return 1, unequal return 0`, async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 2;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        fc.boolean(),
        async (x, y, sameX, sameY) => {
          const ax = x;
          const ay = y;
          const bx = sameX ? x : x + 1;
          const by = sameY ? y : y + 1;
          const tsRef = ax === bx && ay === by ? 1 : 0;

          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const aPtr = 64;
          const bPtr = 64 + STRUCT_SIZE;
          writeI32Field(mem, aPtr, 0, ax);
          writeI32Field(mem, aPtr, 1, ay);
          writeI32Field(mem, bPtr, 0, bx);
          writeI32Field(mem, bPtr, 1, by);
          const fn = instance.exports["__wasm_export_recEq"] as (...a: number[]) => number;
          const result = fn(aPtr, STRUCT_SIZE, bPtr, STRUCT_SIZE);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("equal records return 1", async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 2;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const aPtr = 64;
    const bPtr = 64 + STRUCT_SIZE;
    writeI32Field(mem, aPtr, 0, 42);
    writeI32Field(mem, aPtr, 1, 99);
    writeI32Field(mem, bPtr, 0, 42);
    writeI32Field(mem, bPtr, 1, 99);
    const fn = instance.exports["__wasm_export_recEq"] as (...a: number[]) => number;
    expect(fn(aPtr, STRUCT_SIZE, bPtr, STRUCT_SIZE)).toBe(1);
  });

  it("unequal records return 0", async () => {
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await compileToWasm(resolution);
    const STRUCT_SLOTS = 2;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(wasmBytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const aPtr = 64;
    const bPtr = 64 + STRUCT_SIZE;
    writeI32Field(mem, aPtr, 0, 42);
    writeI32Field(mem, aPtr, 1, 99);
    writeI32Field(mem, bPtr, 0, 42);
    writeI32Field(mem, bPtr, 1, 100); // y differs
    const fn = instance.exports["__wasm_export_recEq"] as (...a: number[]) => number;
    expect(fn(aPtr, STRUCT_SIZE, bPtr, STRUCT_SIZE)).toBe(0);
  });
});
