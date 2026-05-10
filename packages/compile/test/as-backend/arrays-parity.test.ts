// SPDX-License-Identifier: MIT
//
// arrays-parity.test.ts — AS-backend T4: array substrates (P3 bucket)
//
// @decision DEC-AS-ARRAY-LAYOUT-001
// Title: AS-backend array substrates use flat-memory (ptr + len) layout, not
//        managed Array<i32>, because the --runtime stub used by as-backend.ts
//        does not support GC-managed types. Managed i32[] would require
//        --runtime minimal or higher (which enables the AS GC), but stub is the
//        established runtime for Phase 2 per DEC-AS-RECORD-LAYOUT-001.
//        Flat-memory layout (ptr: i32, len: i32) mirrors wave-3 lower-layout
//        and is directly comparable across backends.
// Status: decided (WI-AS-PHASE-2E-ARRAYS, 2026-05-10)
// Rationale:
//   AS managed arrays (i32[], Array<i32>) require the GC runtime for:
//     - Array.length (reads a managed header in GC heap)
//     - Array subscript access a[i] (bounds-checked GC read)
//     - Array.push() (GC heap allocation / resize)
//     - Array.map() (closure allocation — also requires closure support)
//   With --runtime stub, any managed-type operation that triggers the GC
//   either traps at runtime or fails to compile (asc type-error on .push()
//   when the type system detects the GC dependency).
//
//   FINDING (A4 push): asc 0.28.x does compile .push() syntactically, but
//   the resulting WASM traps at runtime when invoked under --runtime stub
//   because the stub does not implement the ArrayBuffer resize path. The
//   variant A4 therefore uses manual flat-memory push emulation instead.
//
//   FINDING (A5 map/closure): asc 0.28.x reports a compile error for
//   arrow-function closures passed to .map() under --runtime stub — closures
//   are a GC feature (function table + context allocation). As specified in
//   the dispatch (WI-AS-PHASE-2E-ARRAYS), this defers to Phase 2F (#230).
//   The A5 variant uses a manual for-loop over flat memory instead,
//   writing doubled values back to a second output buffer.
//
//   The flat-memory protocol matches the records-parity.test.ts convention:
//     - ptr points to the array's first i32 element in WASM linear memory
//     - len is the number of elements (not byte length)
//     - Element at index i is at byte offset (ptr + i * 4) (i32 = 4 bytes)
//     - STRUCT_BASE_PTR = 64 (avoids AS stub runtime header region)
//   This protocol is directly wire-compatible with wave-3 wasm-lowering's
//   array ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
//
// Five substrates (per eval contract T4):
//   A1: len      — read array length from explicit len parameter
//   A2: get      — index access: return element at index i
//   A3: sum      — manual for-loop reduce: sum all elements
//   A4: pushLen  — flat-memory push emulation: write v at index len, return len+1
//   A5: doubleAll — manual for-loop map: write 2*each into an output buffer
//
// Minimum 20 fast-check runs per substrate (eval contract T4).
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-BACKEND-OPTIONS-001 (exportMemory: true for all array substrates)

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
// Fixture helpers — mirror control-flow-parity.test.ts / records-parity.test.ts pattern
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
  const id = makeMerkleRoot(name, `Array substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Flat-memory layout constants
// @decision DEC-AS-ARRAY-LAYOUT-001
// Elements are i32 (4 bytes each). ptr points to element[0].
// Element at index i: load<i32>(ptr + i * 4).
// STRUCT_BASE_PTR = 64: mirrors records-parity convention, safe above AS
// stub runtime header region (typically < 32 bytes).
// Output buffer (A5): placed after a max-size input array (up to 16 elements).
// Max input: 16 × 4 = 64 bytes → output starts at 64 + 64 = 128.
// ---------------------------------------------------------------------------

const ELEM_SIZE = 4; // bytes per i32 element
const ARR_BASE_PTR = 64; // base pointer for input array in WASM memory
const OUT_BASE_PTR = 128; // base pointer for output array (A5 only)
const MAX_ARRAY_LEN = 16; // max elements in fast-check property tests

// ---------------------------------------------------------------------------
// A1: len — return explicit length parameter
//
// AS source: len(ptr: i32, n: i32): i32
//   With --runtime stub, managed Array.length is unavailable.
//   The flat-memory protocol passes the length as an explicit parameter.
//   The function simply returns n, verifying that the parameter is forwarded
//   correctly through the WASM ABI.
//
// TS reference: identity on n.
//
// FINDING: AS managed Array<i32>.length is NOT supported under --runtime stub.
//   The flat-memory variant (explicit len parameter) is the correct protocol
//   matching wave-3 array ABI (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001).
// @decision DEC-AS-ARRAY-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend arrays — A1: len (flat-memory length via explicit parameter)", () => {
  // exportMemory: true — array substrates write elements into WASM memory.
  // @decision DEC-AS-BACKEND-OPTIONS-001
  const LEN_SOURCE = `
export function len(ptr: i32, n: i32): i32 {
  return n;
}
`.trim();

  it("A1: len compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("len", LEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "len WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.len).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("A1: len — fixed cases: empty, small, and large arrays", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("len", LEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.len as (ptr: number, n: number) => number;

    expect(fn(ARR_BASE_PTR, 0)).toBe(0);   // empty array
    expect(fn(ARR_BASE_PTR, 1)).toBe(1);   // singleton
    expect(fn(ARR_BASE_PTR, 5)).toBe(5);   // small array
    expect(fn(ARR_BASE_PTR, 16)).toBe(16); // max test size
  }, 30_000);

  it("A1: len — value parity vs explicit n (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("len", LEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const fn = instance.exports.len as (ptr: number, n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_ARRAY_LEN }),
        async (n) => {
          // TS reference: length is exactly n (the explicit parameter)
          expect(fn(ARR_BASE_PTR, n)).toBe(n);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A2: get — index access: return element at index i
//
// AS source: get(ptr: i32, n: i32, i: i32): i32
//   Reads element at byte offset (ptr + i * 4) using load<i32>.
//   n (length) is accepted for protocol parity but not used in the body
//   (fast-check guarantees 0 <= i < n).
//   Returns the i32 value at that position in WASM linear memory.
//
// TS reference: write element values into WASM memory via DataView,
//               then assert fn(ptr, n, i) === element[i].
//
// Fast-check: arrays of [0, MAX_ARRAY_LEN] elements with valid index.
// @decision DEC-AS-ARRAY-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend arrays — A2: get (flat-memory index access)", () => {
  const GET_SOURCE = `
export function get(ptr: i32, n: i32, i: i32): i32 {
  return load<i32>(ptr + i * 4);
}
`.trim();

  it("A2: get compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("get", GET_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "get WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.get).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("A2: get — fixed cases: singleton access, first, middle, last element", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("get", GET_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.get as (ptr: number, n: number, i: number) => number;
    const dv = new DataView(mem.buffer);

    // Write [10, 20, 30, 40, 50] at ARR_BASE_PTR
    const elems = [10, 20, 30, 40, 50];
    for (let j = 0; j < elems.length; j++) {
      dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, elems[j]!, true);
    }

    expect(fn(ARR_BASE_PTR, elems.length, 0)).toBe(10); // first element
    expect(fn(ARR_BASE_PTR, elems.length, 2)).toBe(30); // middle element
    expect(fn(ARR_BASE_PTR, elems.length, 4)).toBe(50); // last element
  }, 30_000);

  it("A2: get — value parity vs DataView reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("get", GET_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.get as (ptr: number, n: number, i: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Generate an array of 1..MAX_ARRAY_LEN i32 values and a valid index.
        fc.integer({ min: 1, max: MAX_ARRAY_LEN }).chain((n) =>
          fc.tuple(
            fc.array(fc.integer({ min: -100_000, max: 100_000 }), { minLength: n, maxLength: n }),
            fc.integer({ min: 0, max: n - 1 }),
          ).map(([elems, i]) => ({ elems, i, n })),
        ),
        async ({ elems, i, n }) => {
          // Write elements into WASM memory
          const dv = new DataView(mem.buffer);
          for (let j = 0; j < n; j++) {
            dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, elems[j]!, true);
          }

          // TS reference: direct element read
          const tsRef = elems[i]! | 0;
          const result = fn(ARR_BASE_PTR, n, i) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A3: sum — manual for-loop reduce
//
// AS source: sum(ptr: i32, n: i32): i32
//   Iterates over n elements at consecutive 4-byte positions starting at ptr.
//   Accumulates and returns the i32 sum (two's complement, wrapping on overflow).
//
// TS reference: DataView reads of same elements summed with (| 0) truncation.
//
// Fast-check: arrays of up to MAX_ARRAY_LEN elements, values in [-1000, 1000]
//   to stay within i32 range (max: 16 * 1000 = 16_000 << 2^31-1).
//
// This is the compound-interaction substrate: it exercises the full sequence
// source → AS → WASM → instantiate → memory write → call → value verify
// across the array-length loop body, accumulator, and memory read pipeline.
// @decision DEC-AS-ARRAY-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend arrays — A3: sum (flat-memory for-loop reduce)", () => {
  const SUM_SOURCE = `
export function sum(ptr: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    s += load<i32>(ptr + i * 4);
  }
  return s;
}
`.trim();

  it("A3: sum compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sum", SUM_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "sum WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.sum).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("A3: sum — fixed cases: empty, all-zero, positive-only, mixed", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sum", SUM_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.sum as (ptr: number, n: number) => number;
    const dv = new DataView(mem.buffer);

    // Empty array: n=0 → loop not entered → return 0
    expect(fn(ARR_BASE_PTR, 0)).toBe(0);

    // All-zero array: [0, 0, 0] → 0
    for (let j = 0; j < 3; j++) dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, 0, true);
    expect(fn(ARR_BASE_PTR, 3)).toBe(0);

    // [1, 2, 3, 4, 5] → 15
    for (let j = 0; j < 5; j++) dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, j + 1, true);
    expect(fn(ARR_BASE_PTR, 5)).toBe(15);

    // [-1, -2, -3] → -6
    dv.setInt32(ARR_BASE_PTR + 0 * ELEM_SIZE, -1, true);
    dv.setInt32(ARR_BASE_PTR + 1 * ELEM_SIZE, -2, true);
    dv.setInt32(ARR_BASE_PTR + 2 * ELEM_SIZE, -3, true);
    expect(fn(ARR_BASE_PTR, 3)).toBe(-6);

    // [10, -5] → 5
    dv.setInt32(ARR_BASE_PTR + 0 * ELEM_SIZE, 10, true);
    dv.setInt32(ARR_BASE_PTR + 1 * ELEM_SIZE, -5, true);
    expect(fn(ARR_BASE_PTR, 2)).toBe(5);
  }, 30_000);

  it("A3: sum — value parity vs TS for-loop reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("sum", SUM_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.sum as (ptr: number, n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Values in [-1000, 1000]: max sum = 16 * 1000 = 16_000, safely within i32
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: MAX_ARRAY_LEN,
        }),
        async (elems) => {
          const dv = new DataView(mem.buffer);
          for (let j = 0; j < elems.length; j++) {
            dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, elems[j]!, true);
          }

          // TS reference: for-loop sum with i32 truncation
          let tsRef = 0;
          for (const v of elems) tsRef = (tsRef + v) | 0;

          const result = fn(ARR_BASE_PTR, elems.length) | 0;
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A4: pushLen — flat-memory push emulation
//
// FINDING: AS managed Array<i32>.push() is NOT supported under --runtime stub.
//   asc 0.28.x compiles a function that calls .push() on Array<i32>, but
//   the resulting WASM traps at runtime under --runtime stub because the stub
//   does not implement ArrayBuffer reallocation (managed heap). This is a
//   fundamental limitation of the stub runtime (no GC), not a syntax error.
//   Managed Array.push() defers to Phase 2F (#230) alongside closures.
//
// VARIANT: Flat-memory push emulation — pushLen(ptr, n, v): i32
//   Writes v at byte offset (ptr + n * 4), then returns (n + 1).
//   This is semantically equivalent to: a.push(v); return a.length;
//   but operates entirely within flat linear memory.
//   The caller allocates sufficient buffer space (MAX_ARRAY_LEN + 1 elements).
//
// TS reference: elems[n] = v; return n + 1;
// @decision DEC-AS-ARRAY-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend arrays — A4: pushLen (flat-memory push emulation)", () => {
  // FINDING: Managed Array<i32>.push() NOT supported under --runtime stub.
  // See @decision DEC-AS-ARRAY-LAYOUT-001 and file header FINDING (A4 push).
  // This variant emulates push semantics via flat linear memory writes.
  const PUSHLEN_SOURCE = `
export function pushLen(ptr: i32, n: i32, v: i32): i32 {
  store<i32>(ptr + n * 4, v);
  return n + 1;
}
`.trim();

  it("A4: pushLen compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("pushLen", PUSHLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "pushLen WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.pushLen).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("A4: pushLen — fixed cases: push to empty, push to non-empty", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("pushLen", PUSHLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.pushLen as (ptr: number, n: number, v: number) => number;
    const dv = new DataView(mem.buffer);

    // Push to empty array: n=0, push 42 → returns 1, element[0] = 42
    const newLen0 = fn(ARR_BASE_PTR, 0, 42);
    expect(newLen0).toBe(1);
    expect(dv.getInt32(ARR_BASE_PTR + 0 * ELEM_SIZE, true)).toBe(42);

    // Push to length-1 array: n=1, push 99 → returns 2, element[1] = 99
    const newLen1 = fn(ARR_BASE_PTR, 1, 99);
    expect(newLen1).toBe(2);
    expect(dv.getInt32(ARR_BASE_PTR + 1 * ELEM_SIZE, true)).toBe(99);

    // Push negative value: n=2, push -7 → returns 3, element[2] = -7
    const newLen2 = fn(ARR_BASE_PTR, 2, -7);
    expect(newLen2).toBe(3);
    expect(dv.getInt32(ARR_BASE_PTR + 2 * ELEM_SIZE, true)).toBe(-7);
  }, 30_000);

  it("A4: pushLen — value parity vs TS push reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("pushLen", PUSHLEN_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.pushLen as (ptr: number, n: number, v: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // n in [0, MAX_ARRAY_LEN - 1]: ensures written slot stays within buffer
        fc.integer({ min: 0, max: MAX_ARRAY_LEN - 1 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (n, v) => {
          const result = fn(ARR_BASE_PTR, n, v);

          // TS reference: push returns new length (n + 1)
          const tsRefLen = n + 1;
          expect(result).toBe(tsRefLen);

          // Verify element was written at the correct offset
          const dv = new DataView(mem.buffer);
          const written = dv.getInt32(ARR_BASE_PTR + n * ELEM_SIZE, true);
          expect(written).toBe(v | 0);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A5: doubleAll — manual for-loop map (flat-memory)
//
// FINDING: AS closures (.map(x => x * 2)) NOT supported under --runtime stub.
//   asc 0.28.x rejects arrow-function closures in managed Array.map() with a
//   compile-time type error because closure context allocation is a GC feature.
//   This matches the dispatch's note that closures defer to Phase 2F (#230).
//
// VARIANT: Manual for-loop map — doubleAll(src: i32, dst: i32, n: i32): void
//   Reads n elements from src buffer, doubles each, writes to dst buffer.
//   Returns n (element count) for parity verification.
//   This is semantically equivalent to: return src.map(x => x * 2);
//   but operates entirely within flat linear memory.
//
//   Memory layout:
//     src (input):  ARR_BASE_PTR (64)
//     dst (output): OUT_BASE_PTR (128) = ARR_BASE_PTR + MAX_ARRAY_LEN * ELEM_SIZE
//   Both buffers are non-overlapping for MAX_ARRAY_LEN = 16 elements.
//
// TS reference: elems.map(x => x * 2) via DataView reads of dst buffer.
// @decision DEC-AS-ARRAY-LAYOUT-001
// ---------------------------------------------------------------------------

describe("AS backend arrays — A5: doubleAll (flat-memory manual-loop map)", () => {
  // FINDING: Managed Array.map() with closure NOT supported under --runtime stub.
  // See @decision DEC-AS-ARRAY-LAYOUT-001 and file header FINDING (A5 map/closure).
  // This variant emulates .map(x => x*2) via a manual for-loop over flat memory.
  const DOUBLEALL_SOURCE = `
export function doubleAll(src: i32, dst: i32, n: i32): i32 {
  for (let i: i32 = 0; i < n; i++) {
    const v = load<i32>(src + i * 4);
    store<i32>(dst + i * 4, v * 2);
  }
  return n;
}
`.trim();

  it("A5: doubleAll compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll", DOUBLEALL_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "doubleAll WASM must be valid").toBe(true);

    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.doubleAll).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("A5: doubleAll — fixed cases: empty, all-same, mixed values", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll", DOUBLEALL_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.doubleAll as (src: number, dst: number, n: number) => number;
    const dv = new DataView(mem.buffer);

    // Empty array: n=0 → returns 0, dst untouched
    expect(fn(ARR_BASE_PTR, OUT_BASE_PTR, 0)).toBe(0);

    // [1, 2, 3] → [2, 4, 6]
    dv.setInt32(ARR_BASE_PTR + 0 * ELEM_SIZE, 1, true);
    dv.setInt32(ARR_BASE_PTR + 1 * ELEM_SIZE, 2, true);
    dv.setInt32(ARR_BASE_PTR + 2 * ELEM_SIZE, 3, true);
    const retLen = fn(ARR_BASE_PTR, OUT_BASE_PTR, 3);
    expect(retLen).toBe(3);
    expect(dv.getInt32(OUT_BASE_PTR + 0 * ELEM_SIZE, true)).toBe(2);
    expect(dv.getInt32(OUT_BASE_PTR + 1 * ELEM_SIZE, true)).toBe(4);
    expect(dv.getInt32(OUT_BASE_PTR + 2 * ELEM_SIZE, true)).toBe(6);

    // [-5, 0, 10] → [-10, 0, 20]
    dv.setInt32(ARR_BASE_PTR + 0 * ELEM_SIZE, -5, true);
    dv.setInt32(ARR_BASE_PTR + 1 * ELEM_SIZE, 0, true);
    dv.setInt32(ARR_BASE_PTR + 2 * ELEM_SIZE, 10, true);
    fn(ARR_BASE_PTR, OUT_BASE_PTR, 3);
    expect(dv.getInt32(OUT_BASE_PTR + 0 * ELEM_SIZE, true)).toBe(-10);
    expect(dv.getInt32(OUT_BASE_PTR + 1 * ELEM_SIZE, true)).toBe(0);
    expect(dv.getInt32(OUT_BASE_PTR + 2 * ELEM_SIZE, true)).toBe(20);
  }, 30_000);

  it("A5: doubleAll — value parity vs TS map reference (20 fast-check cases)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll", DOUBLEALL_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports.doubleAll as (src: number, dst: number, n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        // Values in [-50_000, 50_000]: doubled stays well within i32 range
        // (max doubled: 100_000 << 2^31-1 = 2_147_483_647)
        fc.array(fc.integer({ min: -50_000, max: 50_000 }), {
          minLength: 0,
          maxLength: MAX_ARRAY_LEN,
        }),
        async (elems) => {
          const dv = new DataView(mem.buffer);
          // Write input elements
          for (let j = 0; j < elems.length; j++) {
            dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, elems[j]!, true);
          }

          const retLen = fn(ARR_BASE_PTR, OUT_BASE_PTR, elems.length);
          expect(retLen).toBe(elems.length);

          // TS reference: map(x => x * 2) — verify each output element
          for (let j = 0; j < elems.length; j++) {
            const tsRef = (elems[j]! * 2) | 0;
            const actual = dv.getInt32(OUT_BASE_PTR + j * ELEM_SIZE, true) | 0;
            expect(actual).toBe(tsRef);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end across multiple internal
// component boundaries:
//   source → AS backend → WASM bytes → validate → instantiate → memory write
//   → call (A3 sum) → value check → call (A2 get) → value check.
//
// Uses A3 (sum) as the primary substrate: it exercises the for-loop body,
// accumulator state transitions, and memory read pipeline — all the core
// array-traversal state transitions in production.
// Also verifies A2 (get) parity using the same in-memory array.
//
// This test crosses the ResolutionResult → assemblyScriptBackend() →
// WebAssembly.instantiate() → DataView write → WASM call → JS value compare
// boundary chain — the full production path for array-aware atoms.
//
// @decision DEC-AS-ARRAY-LAYOUT-001
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// ---------------------------------------------------------------------------

describe("AS backend arrays — compound-interaction (end-to-end production sequence)", () => {
  it("A3+A2/compound: sum+get via full source→backend→wasm→instantiate→call sequence", async () => {
    const SUM_SOURCE = `
export function sum(ptr: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    s += load<i32>(ptr + i * 4);
  }
  return s;
}
`.trim();

    const GET_SOURCE = `
export function get(ptr: i32, n: i32, i: i32): i32 {
  return load<i32>(ptr + i * 4);
}
`.trim();

    // Step 1: compile A3 (sum) through AS backend
    const sumResolution = makeSourceResolution("compound-sum", SUM_SOURCE);
    const sumBackend = assemblyScriptBackend({ exportMemory: true });
    const sumWasmBytes = await sumBackend.emit(sumResolution);

    // Step 2: validate WASM module integrity
    expect(WebAssembly.validate(sumWasmBytes), "sum WASM bytes must be valid").toBe(true);

    // Step 3: WASM magic header (0x00 0x61 0x73 0x6d)
    expect(sumWasmBytes[0]).toBe(0x00);
    expect(sumWasmBytes[1]).toBe(0x61);
    expect(sumWasmBytes[2]).toBe(0x73);
    expect(sumWasmBytes[3]).toBe(0x6d);

    // Step 4: instantiate and write array data
    const { instance: sumInst } = await WebAssembly.instantiate(sumWasmBytes, {});
    const sumFn = sumInst.exports.sum as (ptr: number, n: number) => number;
    const sumMem = sumInst.exports.memory as WebAssembly.Memory;
    const dv = new DataView(sumMem.buffer);

    // Write known array [3, 7, 2, 8, 5] at ARR_BASE_PTR
    const testArray = [3, 7, 2, 8, 5];
    for (let j = 0; j < testArray.length; j++) {
      dv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, testArray[j]!, true);
    }

    // Step 5: verify sum state transitions (empty, partial, full)
    expect(sumFn(ARR_BASE_PTR, 0)).toBe(0);         // n=0: loop not entered
    expect(sumFn(ARR_BASE_PTR, 1)).toBe(3);          // n=1: s=3
    expect(sumFn(ARR_BASE_PTR, 2)).toBe(10);         // n=2: s=3+7=10
    expect(sumFn(ARR_BASE_PTR, 3)).toBe(12);         // n=3: s=3+7+2=12
    expect(sumFn(ARR_BASE_PTR, 5)).toBe(25);         // n=5: s=3+7+2+8+5=25

    // Step 6: compile A2 (get) independently, verify index access on same data
    const getResolution = makeSourceResolution("compound-get", GET_SOURCE);
    const getBackend = assemblyScriptBackend({ exportMemory: true });
    const getWasmBytes = await getBackend.emit(getResolution);
    const { instance: getInst } = await WebAssembly.instantiate(getWasmBytes, {});
    const getFn = getInst.exports.get as (ptr: number, n: number, i: number) => number;
    const getMem = getInst.exports.memory as WebAssembly.Memory;
    const getDv = new DataView(getMem.buffer);

    // Write same array into get's WASM instance memory
    for (let j = 0; j < testArray.length; j++) {
      getDv.setInt32(ARR_BASE_PTR + j * ELEM_SIZE, testArray[j]!, true);
    }

    expect(getFn(ARR_BASE_PTR, testArray.length, 0)).toBe(3);  // element 0
    expect(getFn(ARR_BASE_PTR, testArray.length, 2)).toBe(2);  // element 2
    expect(getFn(ARR_BASE_PTR, testArray.length, 4)).toBe(5);  // element 4

    // Step 7: backend identity
    expect(sumBackend.name).toBe("as");
    expect(getBackend.name).toBe("as");
  }, 30_000);
});
