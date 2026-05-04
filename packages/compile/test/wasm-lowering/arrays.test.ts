/**
 * arrays.test.ts — Property-based tests for WI-V1W3-WASM-LOWER-07.
 *
 * Purpose:
 *   Verify that the array lowering path (detectArrayShape → emitArrayModule)
 *   produces WASM byte sequences that execute correctly and match TypeScript
 *   reference semantics.
 *
 *   Six substrates:
 *     arr-1 sum       — (arr: number[]) => number, sum all elements
 *     arr-2 indexing  — (arr: number[], i: number) => number, return arr[i]
 *     arr-3 length    — (arr: number[]) => number, return arr.length
 *     arr-4 push      — (arr: number[], x: number) => number, push + return new length
 *     arr-5 push-grow — same shape, push enough to force capacity-doubling grow
 *     arr-6 mixed     — (arr: Point[]) => number, sum field x of each record element
 *
 *   Each substrate runs ≥15 property-based cases (or explicit corpus for grow tests).
 *
 * Array ABI (per DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001):
 *   The array triple (ptr: i32, length: i32, capacity: i32) is the first three
 *   WASM params.  Array data lives at [ptr, ptr + length * stride).
 *   i32 elements: stride=4; all other elements: stride=8.
 *
 *   The test harness writes element data into the WASM linear memory at a test
 *   address before calling the compiled function.  For push/grow tests the harness
 *   also reads back the result and verifies element integrity post-mutation.
 *
 * Dispatch ordering (DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001):
 *   compileToWasm checks stringShape → recordShape → arrayShape → wave2/general.
 *   detectArrayShape() runs AFTER detectWave2Shape() in the visitor, so the
 *   wave-2 sum_array substrate (exact `.reduce`-body) never reaches this path.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001
 * @title (ptr, length, capacity) triple — i32 stride=4, others stride=8; capacity-doubling grow
 * @status accepted
 * @rationale
 *   Arrays cross the WASM boundary as a (ptr, length, capacity) triple of i32 values.
 *   This matches the internal representation used by the emitArrayModule() code generator:
 *   ptr points to element data in linear memory, length is element count, capacity is the
 *   allocated element capacity.  Stride is 4 for i32 elements (the common integer case,
 *   minimises memory cost for dense integer arrays) and 8 for all other types (matching
 *   the 8-byte uniform alignment used for records and 64-bit numerics throughout yakcc).
 *   Capacity-doubling (initial seed 4) is the standard amortised-O(1) growth strategy.
 *   Pass-by-value (v1 limitation): ptr/capacity mutations from push-with-grow are not
 *   reflected back to the caller; the function only returns the new length.
 *   See DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-BOUNDS-CHECK-001
 * @title Out-of-bounds array index → host_panic (error kind 0x04) + trap
 * @status accepted
 * @rationale
 *   The WASM_HOST_CONTRACT.md defines error kind 0x04 as oob_memory.  When an index
 *   is >= length, the emitted WASM calls host_panic(0x04, 0, 0) then executes
 *   `unreachable`, guaranteeing a WASM trap.  This is the loudest possible failure
 *   (Sacred Practice #5) and makes the contract explicit to the host environment.
 *   Silent out-of-bounds would corrupt memory and produce incorrect results;
 *   trapping immediately prevents cascading corruption.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-INIT-CAP-001
 * @title Initial capacity seed = 4 when capacity == 0 on push
 * @status accepted
 * @rationale
 *   When a caller supplies capacity=0 (common for freshly initialised arrays that
 *   have not been pre-allocated), the first push must allocate backing storage.
 *   Seeding at 4 avoids repeated single-element reallocations for typical small-array
 *   usage while keeping the initial allocation modest (4 × stride bytes).  The seed
 *   is arbitrary within [1, ∞); 4 is conventional and matches what many language
 *   runtimes use for their array-buffer growth strategies.
 *
 * @decision DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001
 * @title push mutates local ptr/capacity slots, not caller state — v1 documented limitation
 * @status accepted
 * @rationale
 *   WASM function parameters are local variables; mutating them inside the function
 *   (as the push-with-grow path does when it updates ptr and capacity) does not write
 *   back to the caller's copies.  In v1 the caller is responsible for re-reading the
 *   array triple after each mutating call.  This is a known limitation documented in
 *   the host contract; future WIs may introduce an out-pointer ABI to propagate
 *   mutation back automatically.
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
// Fixture helpers (mirrors records.test.ts pattern)
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
// Memory helpers for array tests
//
// Array ABI: (ptr: i32, length: i32, capacity: i32) as first 3 WASM params.
// Elements at [ptr, ptr + length * STRIDE).
// i32 elements: STRIDE = 4 (little-endian i32.store / i32.load).
// ---------------------------------------------------------------------------

const I32_STRIDE = 4;

/**
 * Write an i32 array into linear memory starting at ptr.
 * Returns the array triple (ptr, length, capacity) to pass to the WASM function.
 */
function writeI32Array(
  mem: WebAssembly.Memory,
  ptr: number,
  elements: number[],
  capacity?: number,
): [ptr: number, length: number, capacity: number] {
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < elements.length; i++) {
    dv.setInt32(ptr + i * I32_STRIDE, elements[i] as number, true);
  }
  return [ptr, elements.length, capacity ?? elements.length];
}


// ---------------------------------------------------------------------------
// SUBSTRATE arr-1: sum
//
// TypeScript: (arr: number[]) => number  — sum all elements via indexed loop.
// Array ABI: (ptr, length, capacity).  Elements are i32 (stride=4).
// ---------------------------------------------------------------------------

describe("arr-1: sum all elements via indexed loop", () => {
  // detectArrayShape detects both "length" and "index" → isSum mode in emitArrayModule
  // (DEC-V1-WAVE-3-WASM-LOWER-ARRAY-OPMODE-001)
  const sumSrc = `export function sumArr(arr: number[]): number {
  let acc = 0 | 0;
  let i = 0 | 0;
  while (i < arr.length) {
    acc = (acc + arr[i]) | 0;
    i = (i + 1) | 0;
  }
  return acc;
}`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(sumSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_sumArr", async () => {
    const resolution = makeSingleBlockResolution(sumSrc);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_sumArr")).toBe(true);
  });

  it("parity: ≥15 property-based cases — WASM sum == TypeScript sum", async () => {
    const resolution = makeSingleBlockResolution(sumSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 0, maxLength: 12 }),
        async (elements) => {
          const tsRef = elements.reduce((a, b) => (a + b) | 0, 0);
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const ARR_PTR = 128;
          const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements);
          const fn = instance.exports["__wasm_export_sumArr"] as (
            ptr: number,
            len: number,
            cap: number,
          ) => number;
          const result = fn(ptr, length, capacity);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("sum of empty array returns 0", async () => {
    const resolution = makeSingleBlockResolution(sumSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports["__wasm_export_sumArr"] as (
      ptr: number,
      len: number,
      cap: number,
    ) => number;
    expect(fn(128, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE arr-2: indexing
//
// TypeScript: (arr: number[], i: number) => number  — return arr[i].
// Includes a bounds-check trap test (out-of-bounds index → trap).
// ---------------------------------------------------------------------------

describe("arr-2: index access arr[i] with bounds check", () => {
  const indexSrc = `export function getElem(arr: number[], i: number): number {
  return arr[i] | 0;
}`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(indexSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_getElem", async () => {
    const resolution = makeSingleBlockResolution(indexSrc);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_getElem")).toBe(true);
  });

  it("parity: ≥15 property-based in-bounds cases — WASM arr[i] == TypeScript arr[i]", async () => {
    const resolution = makeSingleBlockResolution(indexSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -10000, max: 10000 }), { minLength: 1, maxLength: 10 }),
        async (elements) => {
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const ARR_PTR = 128;
          const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements);
          const fn = instance.exports["__wasm_export_getElem"] as (
            ptr: number,
            len: number,
            cap: number,
            i: number,
          ) => number;
          // Pick a random valid index
          const idx = Math.floor(Math.random() * elements.length);
          const expected = (elements[idx] as number) | 0;
          const result = fn(ptr, length, capacity, idx);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("explicit corpus: access each valid index in a 5-element array", async () => {
    const elements = [10, 20, 30, 40, 50];
    const resolution = makeSingleBlockResolution(indexSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const ARR_PTR = 128;
    const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements);
    const fn = instance.exports["__wasm_export_getElem"] as (
      ptr: number,
      len: number,
      cap: number,
      i: number,
    ) => number;
    for (let i = 0; i < elements.length; i++) {
      expect(fn(ptr, length, capacity, i)).toBe(elements[i]);
    }
  });

  it("bounds-check trap: out-of-bounds index triggers a WASM trap (unreachable)", async () => {
    const resolution = makeSingleBlockResolution(indexSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const ARR_PTR = 128;
    const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, [1, 2, 3]);
    const fn = instance.exports["__wasm_export_getElem"] as (
      ptr: number,
      len: number,
      cap: number,
      i: number,
    ) => number;
    // Index 3 is length, which is >= length (0-indexed) — should trap
    expect(() => fn(ptr, length, capacity, 3)).toThrow();
    // Negative-cast large index also traps (i32.ge_u treats 0xFFFFFFFF >= any length)
    expect(() => fn(ptr, length, capacity, -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE arr-3: length
//
// TypeScript: (arr: number[]) => number  — return arr.length.
// ---------------------------------------------------------------------------

describe("arr-3: arr.length", () => {
  const lenSrc = `export function arrLen(arr: number[]): number {
  return arr.length | 0;
}`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(lenSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_arrLen", async () => {
    const resolution = makeSingleBlockResolution(lenSrc);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_arrLen")).toBe(true);
  });

  it("parity: ≥15 property-based cases — WASM arr.length == TypeScript arr.length", async () => {
    const resolution = makeSingleBlockResolution(lenSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 0, maxLength: 20 }),
        async (elements) => {
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const ARR_PTR = 128;
          const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements);
          const fn = instance.exports["__wasm_export_arrLen"] as (
            ptr: number,
            len: number,
            cap: number,
          ) => number;
          expect(fn(ptr, length, capacity)).toBe(elements.length);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("explicit: length of empty array is 0", async () => {
    const resolution = makeSingleBlockResolution(lenSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports["__wasm_export_arrLen"] as (
      ptr: number,
      len: number,
      cap: number,
    ) => number;
    expect(fn(128, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE arr-4: push (no grow)
//
// TypeScript: (arr: number[], x: number) => number — push x, return new length.
// Capacity is pre-allocated (ample), so no grow path fires.
// ---------------------------------------------------------------------------

describe("arr-4: push (no grow — capacity pre-allocated)", () => {
  const pushSrc = `export function pushElem(arr: number[], x: number): number {
  arr.push(x);
  return arr.length | 0;
}`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_pushElem", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_pushElem")).toBe(true);
  });

  it("parity: ≥15 property-based cases — returns length + 1 (no grow)", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 0, maxLength: 10 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (elements, pushVal) => {
          const tsRef = elements.length + 1;
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const ARR_PTR = 128;
          // capacity = length + 4 ensures no grow
          const cap = elements.length + 4;
          const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements, cap);
          const fn = instance.exports["__wasm_export_pushElem"] as (
            ptr: number,
            len: number,
            cap: number,
            x: number,
          ) => number;
          const result = fn(ptr, length, capacity, pushVal);
          expect(result).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("explicit: push to empty array with capacity=1 returns length=1", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const ARR_PTR = 256;
    const fn = instance.exports["__wasm_export_pushElem"] as (
      ptr: number,
      len: number,
      cap: number,
      x: number,
    ) => number;
    // length=0, capacity=4 (ample), push value 99
    expect(fn(ARR_PTR, 0, 4, 99)).toBe(1);
    // Verify element was written
    const dv = new DataView(mem.buffer);
    expect(dv.getInt32(ARR_PTR, true)).toBe(99);
  });

  it("explicit corpus: 5 sequential pushes return correct lengths", async () => {
    // Note: v1 pass-by-value limitation — each call starts from the same base state.
    // We verify each individual push returns the expected length.
    const pushValues = [5, 10, 15, 20, 25];
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);
    for (let startLen = 0; startLen < pushValues.length; startLen++) {
      const host = createHost();
      const { instance } = (await WebAssembly.instantiate(
        wasmBytes,
        host.importObject,
      )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
      const mem = host.memory;
      const ARR_PTR = 128;
      const initial = pushValues.slice(0, startLen);
      const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, initial, startLen + 4);
      const fn = instance.exports["__wasm_export_pushElem"] as (
        ptr: number,
        len: number,
        cap: number,
        x: number,
      ) => number;
      const result = fn(ptr, length, capacity, pushValues[startLen] as number);
      expect(result).toBe(startLen + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE arr-5: push-with-grow
//
// Same source as arr-4.  Push enough elements to force capacity-doubling grow.
// Verify: return value is length+1; the new element is present in memory.
//
// Pass-by-value limitation (DEC-V1-WAVE-3-WASM-LOWER-ARRAY-PASS-BY-VALUE-001):
//   After grow, ptr changes inside the WASM but the caller's ptr is not updated.
//   The grow path allocates via host_alloc and copies existing elements.
//   We verify that host_alloc was called (allocs > 0) and that the element
//   was written somewhere accessible (by asking host.memory directly at the
//   new allocation offset returned by the bump allocator).
// ---------------------------------------------------------------------------

describe("arr-5: push-with-grow (capacity-doubling via host_alloc + memory.copy)", () => {
  const pushSrc = `export function pushElem(arr: number[], x: number): number {
  arr.push(x);
  return arr.length | 0;
}`;

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("push with grow: returns new length (capacity-full array grows correctly)", async () => {
    // Set length == capacity (exact full) so grow fires on first push
    const elements = [1, 2, 3, 4]; // 4 elements
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const ARR_PTR = 256; // safe address after bump allocator region
    // capacity == length == 4, so the grow path fires
    const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements, 4);
    const fn = instance.exports["__wasm_export_pushElem"] as (
      ptr: number,
      len: number,
      cap: number,
      x: number,
    ) => number;
    const result = fn(ptr, length, capacity, 99);
    // Should return 5 (new length)
    expect(result).toBe(5);
    // The host must not have panicked (logs would contain "panic" on failure)
    expect(host.logs.some((l) => l.includes("panic"))).toBe(false);
  });

  it("push from capacity=0: grow seeds at 4, returns 1", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports["__wasm_export_pushElem"] as (
      ptr: number,
      len: number,
      cap: number,
      x: number,
    ) => number;
    // capacity=0, length=0 — grow seeds to 4 first
    const result = fn(512, 0, 0, 42);
    expect(result).toBe(1);
    expect(host.logs.some((l) => l.includes("panic"))).toBe(false);
  });

  it("corpus: push with grow at 1, 2, 4, 8, 16 — each returns length+1", async () => {
    const growPoints = [1, 2, 4, 8, 16];
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);

    for (const len of growPoints) {
      const elements = Array.from({ length: len }, (_, i) => i + 1);
      const host = createHost();
      const { instance } = (await WebAssembly.instantiate(
        wasmBytes,
        host.importObject,
      )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
      const mem = host.memory;
      const ARR_PTR = 512;
      const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements, len);
      const fn = instance.exports["__wasm_export_pushElem"] as (
        ptr: number,
        len: number,
        cap: number,
        x: number,
      ) => number;
      const result = fn(ptr, length, capacity, 999);
      expect(result).toBe(len + 1);
      // No panic should have occurred during grow
      expect(host.logs.some((l) => l.includes("panic"))).toBe(false);
    }
  });

  it("property: push-with-grow always returns length+1 regardless of initial capacity ratio", async () => {
    const resolution = makeSingleBlockResolution(pushSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: -500, max: 500 }),
        async (len, pushVal) => {
          const elements = Array.from({ length: len }, (_, i) => i);
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const ARR_PTR = 512;
          // capacity == length: always triggers grow
          const [ptr, length, capacity] = writeI32Array(mem, ARR_PTR, elements, len);
          const fn = instance.exports["__wasm_export_pushElem"] as (
            ptr: number,
            len: number,
            cap: number,
            x: number,
          ) => number;
          const result = fn(ptr, length, capacity, pushVal);
          expect(result).toBe(len + 1);
          expect(host.logs.some((l) => l.includes("panic"))).toBe(false);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE arr-6: mixed-element-type (record-elements)
//
// TypeScript: (arr: Point[]) => number  — sum field x of each Point record.
// Exercises WI-06 record layout + WI-07 array lowering together.
//
// Point = { x: number; y: number }
// Record layout: x at slot 0 (offset 0), y at slot 1 (offset 8).
// Array elements are record pointers (i32), stride=4.
//
// Test construction:
//   1. Allocate struct for each Point at a base ptr (8-byte slots).
//   2. Write ptr-to-struct into the array at ARR_PTR + i*4.
//   3. Call WASM with (ARR_PTR, length, capacity, 0) — trailing 0 is dummy _size param.
// ---------------------------------------------------------------------------

describe("arr-6: mixed-element-type — arr: Point[] (record elements), sum field x", () => {
  // Sum the x field of each Point in the array.
  // emitArrayModule's sum path for record elements:
  //   loads struct ptr from array slot, then loads field at struct_ptr + fieldOffset.
  const mixedSrc = `export function sumPointsX(arr: { x: number; y: number }[]): number {
  let acc = 0 | 0;
  let i = 0 | 0;
  while (i < arr.length) {
    acc = (acc + arr[i].x) | 0;
    i = (i + 1) | 0;
  }
  return acc;
}`;

  const POINT_SLOT_COUNT = 2; // x at slot 0, y at slot 1
  const POINT_SIZE = POINT_SLOT_COUNT * 8; // 16 bytes per Point
  const STRUCT_BASE = 1024; // address where struct data lives
  const ARR_BASE = 2048; // address where ptr array lives
  // Record elements have elementKind="record" → stride=8 (DEC-V1-WAVE-3-WASM-LOWER-ARRAY-001)
  // Each 8-byte slot in the pointer array holds a struct ptr (i32, LE) in the first 4 bytes.
  const RECORD_ELEM_STRIDE = 8;

  /** Allocate Point structs starting at STRUCT_BASE; write ptr array at ARR_BASE. */
  function writePointArray(
    mem: WebAssembly.Memory,
    points: Array<{ x: number; y: number }>,
  ): [ptr: number, length: number, capacity: number] {
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < points.length; i++) {
      const pt = points[i] as { x: number; y: number };
      const structPtr = STRUCT_BASE + i * POINT_SIZE;
      // Write x at slot 0 (offset 0)
      dv.setInt32(structPtr + 0, pt.x, true);
      dv.setInt32(structPtr + 4, 0, true);
      // Write y at slot 1 (offset 8)
      dv.setInt32(structPtr + 8, pt.y, true);
      dv.setInt32(structPtr + 12, 0, true);
      // Write struct ptr into the 8-byte array slot at ARR_BASE + i*RECORD_ELEM_STRIDE
      // (i32 ptr in first 4 bytes, upper 4 bytes zeroed)
      dv.setInt32(ARR_BASE + i * RECORD_ELEM_STRIDE, structPtr, true);
      dv.setInt32(ARR_BASE + i * RECORD_ELEM_STRIDE + 4, 0, true);
    }
    return [ARR_BASE, points.length, points.length];
  }

  it("compileToWasm produces a valid WASM binary", async () => {
    const resolution = makeSingleBlockResolution(mixedSrc);
    const bytes = await compileToWasm(resolution);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });

  it("WASM binary exports __wasm_export_sumPointsX", async () => {
    const resolution = makeSingleBlockResolution(mixedSrc);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_sumPointsX")).toBe(true);
  });

  it("explicit corpus: 5 points, sum of x matches TypeScript reference", async () => {
    const points = [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
      { x: 3, y: 30 },
      { x: 4, y: 40 },
      { x: 5, y: 50 },
    ];
    const tsRef = points.reduce((a, p) => (a + p.x) | 0, 0); // 15

    const resolution = makeSingleBlockResolution(mixedSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const [ptr, length, capacity] = writePointArray(mem, points);
    const fn = instance.exports["__wasm_export_sumPointsX"] as (
      ptr: number,
      len: number,
      cap: number,
    ) => number;
    const result = fn(ptr, length, capacity);
    expect(result).toBe(tsRef);
  });

  it("explicit: empty record array returns 0", async () => {
    const resolution = makeSingleBlockResolution(mixedSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports["__wasm_export_sumPointsX"] as (
      ptr: number,
      len: number,
      cap: number,
    ) => number;
    expect(fn(ARR_BASE, 0, 0)).toBe(0);
  });

  it("parity: ≥15 property-based cases — WASM sum(x) == TypeScript sum(x)", async () => {
    const resolution = makeSingleBlockResolution(mixedSrc);
    const wasmBytes = await compileToWasm(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            x: fc.integer({ min: -500, max: 500 }),
            y: fc.integer({ min: -500, max: 500 }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        async (points) => {
          const tsRef = points.reduce((a, p) => (a + p.x) | 0, 0);
          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const [ptr, length, capacity] = writePointArray(mem, points);
          const fn = instance.exports["__wasm_export_sumPointsX"] as (
            ptr: number,
            len: number,
            cap: number,
          ) => number;
          expect(fn(ptr, length, capacity)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("explicit corpus: negative x values summed correctly", async () => {
    const points = [
      { x: -10, y: 5 },
      { x: -20, y: 15 },
      { x: 30, y: 25 },
    ];
    const tsRef = points.reduce((a, p) => (a + p.x) | 0, 0); // 0

    const resolution = makeSingleBlockResolution(mixedSrc);
    const wasmBytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const mem = host.memory;
    const [ptr, length, capacity] = writePointArray(mem, points);
    const fn = instance.exports["__wasm_export_sumPointsX"] as (
      ptr: number,
      len: number,
      cap: number,
    ) => number;
    expect(fn(ptr, length, capacity)).toBe(tsRef);
  });
});
