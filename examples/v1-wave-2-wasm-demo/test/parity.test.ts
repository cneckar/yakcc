/**
 * WI-V1W2-WASM-04 v1-wave-2 WASM demo — parity harness
 *
 * @decision DEC-V1W2-WASM-DEMO-001
 * title: v1-wave-2-wasm-demo parity harness — synthetic ResolutionResult approach
 * status: decided (WI-V1W2-WASM-04)
 * rationale:
 *   The WASM backend (WI-V1W2-WASM-01 through WI-V1W2-WASM-03) currently emits a
 *   fixed substrate module regardless of the ResolutionResult input; real IR-to-WASM
 *   type-lowering is deferred to WI-V1W2-WASM-02 (not yet started). The demo
 *   therefore:
 *     (a) Uses synthetic ResolutionResult fixtures (same pattern as wasm-backend.test.ts
 *         and wasm-host.test.ts) — no shave+registry round-trip needed.
 *     (b) Runs the NUMERIC substrate (add) through both backends and asserts
 *         value-level parity using ≥10 explicit corpus cases.
 *     (c) Marks STRING and MIXED substrates as pending (it.todo) because the WASM
 *         backend's arbitrary type-lowering for those shapes requires WI-V1W2-WASM-02.
 *         Sacred Practice #12 / loud failure over silent fallback: it.todo() surfaces
 *         the pending work without silently passing an empty suite.
 *
 *   TS backend execution: tsBackend().emit(resolution) is called and its output
 *   verified (non-empty TypeScript containing the expected function signature).
 *   For value-level comparison the imported add() function is used as the TS-backend
 *   reference (DEC-V1W2-WASM-DEMO-TSREF-001 in src/add.ts).
 *
 *   WASM backend execution: wasmBackend().emit(resolution) → Uint8Array, then
 *   instantiateAndRun() for each corpus case.
 *
 * Production sequence:
 *   makeAddResolution()
 *   → tsBackend().emit(resolution)          [ts-backend: source text verified]
 *   → wasmBackend().emit(resolution)        [wasm-backend: Uint8Array]
 *   → instantiateAndRun(bytes, fn, [a, b])  [wasm-host: value-level result]
 *   → assert result === add(a, b) | 0       [parity assertion]
 *
 * Corpus design (numeric substrate):
 *   12 cases covering i32 arithmetic properties:
 *     zero-identity, commutativity-samples, signed-negatives, boundary values,
 *     large-positives, mixed-sign cancellation.
 *   The i32 truncation (`| 0`) is applied to the TypeScript reference to match
 *   WASM's i32.add semantics (two's-complement, no overflow detection).
 */

import { WasmTrap, createHost, instantiateAndRun, tsBackend, wasmBackend } from "@yakcc/compile";
import { instantiateAndRunBigInt } from "./bigint-instantiate.js";
import type { ResolutionResult, ResolvedBlock } from "@yakcc/compile";
import {
  type BlockMerkleRoot,
  type LocalTriplet,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// TypeScript-backend reference function (DEC-V1W2-WASM-DEMO-TSREF-001)
// ---------------------------------------------------------------------------
// Imported directly from the substrate source — semantically identical to
// executing the tsBackend().emit() output for a single-block add substrate.
import { add } from "../src/add.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors wasm-backend.test.ts / wasm-host.test.ts pattern
// ---------------------------------------------------------------------------

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

// The add substrate source — must match src/add.ts (reference function above).
const ADD_IMPL_SOURCE = "export function add(a: number, b: number): number { return a + b; }";

function makeAddResolution(): ResolutionResult {
  const id = makeMerkleRoot(
    "add",
    "Return the integer sum of two i32-range operands",
    ADD_IMPL_SOURCE,
  );
  return makeResolution([{ id, source: ADD_IMPL_SOURCE }]);
}

// ---------------------------------------------------------------------------
// Numeric substrate property-test corpus
//
// 12 cases spanning i32 arithmetic properties:
//   - zero identity: add(x, 0) = x
//   - commutativity samples: add(a, b) = add(b, a)
//   - signed negatives
//   - i32 boundary values (min/max)
//   - large positives
//   - mixed-sign cancellation
// ---------------------------------------------------------------------------

const NUMERIC_CORPUS: ReadonlyArray<[number, number]> = [
  [0, 0], // zero + zero
  [1, 0], // identity element
  [0, 1], // identity, reversed
  [2, 3], // small positive
  [-1, -1], // both negative
  [-5, 3], // mixed sign
  [100, 200], // medium positive
  [100, -100], // cancellation
  [2147483647, 0], // i32 max (no overflow)
  [-2147483648, 0], // i32 min (no overflow)
  [42, 58], // sums to round number
  [-42, 42], // cancellation, explicit
];

// ---------------------------------------------------------------------------
// SUBSTRATE 1: Numeric (i32 integer addition)
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-04 parity — numeric substrate: add(a, b)", () => {
  it("ts-backend emits non-empty TypeScript containing the 'add' function signature", async () => {
    const resolution = makeAddResolution();
    const tsSource = await tsBackend().emit(resolution);

    // The output must be non-empty TypeScript with the entry function.
    expect(tsSource.length, "ts-backend output must be non-empty").toBeGreaterThan(0);
    expect(tsSource, "ts-backend output must contain 'function add'").toContain("function add");
    expect(tsSource, "ts-backend output must contain 'return a + b'").toContain("return a + b");
  });

  it("wasm-backend emits a valid .wasm binary that starts with WASM magic bytes", async () => {
    const resolution = makeAddResolution();
    const wasmBytes = await wasmBackend().emit(resolution);

    expect(wasmBytes, "wasm-backend must return Uint8Array").toBeInstanceOf(Uint8Array);
    expect(wasmBytes[0]).toBe(0x00);
    expect(wasmBytes[1]).toBe(0x61);
    expect(wasmBytes[2]).toBe(0x73);
    expect(wasmBytes[3]).toBe(0x6d);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
  });

  it("wasm-backend emits a module that exports __wasm_export_add", async () => {
    const resolution = makeAddResolution();
    const wasmBytes = await wasmBackend().emit(resolution);
    const { result } = await instantiateAndRun(wasmBytes, "__wasm_export_add", [1, 1]);
    expect(result).toBe(2);
  });

  it(`parity: all ${NUMERIC_CORPUS.length} corpus cases produce value-equivalent results`, async () => {
    const resolution = makeAddResolution();
    const wasmBytes = await wasmBackend().emit(resolution);

    // For each corpus case: compare WASM i32 add result against TS reference.
    // i32 truncation (`| 0`) normalises the TS result to WASM's two's-complement
    // wrapping semantics (per wasm-host.test.ts DEC-V1-WAVE-2-WASM-TEST-002 Test 8).
    for (const [a, b] of NUMERIC_CORPUS) {
      const tsResult = add(a, b) | 0;
      const { result: wasmResult } = await instantiateAndRun(wasmBytes, "__wasm_export_add", [
        a,
        b,
      ]);
      expect(wasmResult, `add(${a}, ${b}): WASM result must equal TS reference | 0`).toBe(tsResult);
    }
  });

  it("parity: panic path — __wasm_export_panic_demo throws WasmTrap (non-add path coverage)", async () => {
    const resolution = makeAddResolution();
    const wasmBytes = await wasmBackend().emit(resolution);
    await expect(
      instantiateAndRun(wasmBytes, "__wasm_export_panic_demo", []),
    ).rejects.toBeInstanceOf(WasmTrap);
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 2: String-handling (linear-memory string view + host_alloc/free)
//
// Activated by WI-V1W3-WASM-LOWER-05 — string type-lowering now lands.
//
// The WASM backend now lowers TypeScript string substrates via detectStringShape()
// + emitStringModule(). The calling convention is (ptr: i32, len_bytes: i32) for
// string arguments (UTF-8 in linear memory). The parity test uses the str-length
// shape: `export function strLen(s: string): number { return s.length; }`.
//
// TS backend reference: JavaScript string.length (UTF-16 code-unit count).
// WASM backend: ptr+len pair passed to __wasm_export_strLen, which calls
//   host_string_length and returns the i32 result.
//
// Corpus: 10 cases covering ASCII, multi-byte UTF-8, empty, and surrogate pairs.
//
// Production sequence (matching strings.test.ts str-1 pattern):
//   makeStringResolution(strLenSource)
//   → wasmBackend().emit(resolution)               [Uint8Array]
//   → WebAssembly.instantiate(bytes, importObject)  [with createHost()]
//   → write string to memory via host_alloc + Uint8Array.set
//   → call __wasm_export_strLen(ptr, byteLen) → i32
//   → assert result === s.length
// ---------------------------------------------------------------------------

// The str-length substrate source — the WASM backend lowering target.
const STR_LEN_IMPL_SOURCE = "export function strLen(s: string): number { return s.length; }";

function makeStringResolution(): ResolutionResult {
  const id = makeMerkleRoot("strLen", "strLen substrate", STR_LEN_IMPL_SOURCE);
  return makeResolution([{ id, source: STR_LEN_IMPL_SOURCE }]);
}

// Corpus: 10 cases spanning ASCII, multi-byte characters, empty, and emoji.
//   JS string.length returns UTF-16 code-unit count; emoji with surrogate pairs count as 2.
const STRING_CORPUS: ReadonlyArray<string> = [
  "", // empty string — length 0
  "a", // single ASCII char — length 1
  "hello", // short ASCII — length 5
  "hello world", // ASCII with space — length 11
  "café", // 4 JS chars (é = 1 code unit) — length 4
  "日本語", // 3 CJK chars (each = 1 JS code unit) — length 3
  "abc123", // alphanumeric — length 6
  "  leading", // leading spaces — length 9
  "trailing  ", // trailing spaces — length 10
  "😀", // emoji = 2 UTF-16 code units (surrogate pair) — length 2
];

describe("WI-V1W2-WASM-04 parity — string substrate: str-length (WI-V1W3-WASM-LOWER-05)", () => {
  it("wasm-backend emits a valid .wasm binary for the str-length substrate", async () => {
    const resolution = makeStringResolution();
    const wasmBytes = await wasmBackend().emit(resolution);

    expect(wasmBytes, "wasm-backend must return Uint8Array").toBeInstanceOf(Uint8Array);
    expect(wasmBytes[0]).toBe(0x00);
    expect(wasmBytes[1]).toBe(0x61);
    expect(wasmBytes[2]).toBe(0x73);
    expect(wasmBytes[3]).toBe(0x6d);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
  });

  it("ts-backend emits non-empty TypeScript containing the 'strLen' function signature", async () => {
    const resolution = makeStringResolution();
    const tsSource = await tsBackend().emit(resolution);

    expect(tsSource.length, "ts-backend output must be non-empty").toBeGreaterThan(0);
    expect(tsSource, "ts-backend output must contain 'function strLen'").toContain(
      "function strLen",
    );
  });

  it(`parity: all ${STRING_CORPUS.length} corpus cases produce value-equivalent results`, async () => {
    const resolution = makeStringResolution();
    const wasmBytes = await wasmBackend().emit(resolution);

    // Instantiate with full host (including string imports)
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      wasmBytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const yakccHost = host.importObject.yakcc_host as Record<string, unknown>;
    const allocate = yakccHost.host_alloc as (size: number) => number;

    const fn = (instance.exports as Record<string, unknown>).__wasm_export_strLen as (
      ptr: number,
      len: number,
    ) => number;

    const enc = new TextEncoder();
    for (const s of STRING_CORPUS) {
      // TS reference: JavaScript string.length (UTF-16 code-unit count)
      const tsResult = s.length;

      // WASM: write UTF-8 bytes into linear memory, call with (ptr, byteLen)
      const encoded = enc.encode(s);
      const byteLen = encoded.length;
      const ptr = allocate(byteLen > 0 ? byteLen : 1);
      const view = new Uint8Array(host.memory.buffer);
      view.set(encoded, ptr);
      const wasmResult = fn(ptr, byteLen);

      expect(
        wasmResult,
        `strLen("${s}"): WASM result (${wasmResult}) must equal TS reference (${tsResult})`,
      ).toBe(tsResult);
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 3: Mixed (record-of-numbers, flat-struct linear-memory layout)
//
// Activated by WI-V1W3-WASM-LOWER-06 — record type-lowering now lands.
//
// The WASM backend lowers TypeScript record substrates via detectRecordShape()
// + emitRecordModule(). The calling convention is (ptr: i32, _size: i32) for
// record arguments (fields in linear memory at 8-byte aligned slots).
//
// Substrate: sumRecord3 — a record with 3 numeric fields; returns field sum.
//   export function sumRecord3(r: { a: number; b: number; c: number }, _size: number): number {
//     return (r.a + r.b + r.c) | 0;
//   }
//
// Three fields are used to avoid the wave-2 sum_record fast-path, which only
// matches `return r.field + r.field` (exactly 2 field accesses, no `| 0`).
// With 3 fields + `| 0`, the general record lowering path is exercised.
//
// Field layout (DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001):
//   slot 0 (byte offset 0):  field r.a (i32)
//   slot 1 (byte offset 8):  field r.b (i32)
//   slot 2 (byte offset 16): field r.c (i32)
//   struct size: 3 * 8 = 24 bytes
//
// TS backend reference: (r.a + r.b + r.c) | 0 evaluated directly in JS.
// WASM: caller allocates struct in linear memory, writes fields at offsets,
//   calls __wasm_export_sumRecord3(ptr, structSize) → i32.
//
// Corpus: 10 explicit cases + ≥10 fast-check property cases.
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-PARITY-MIXED-001
// @title Activate mixed substrate parity once WI-06 record lowering lands
// @status accepted
// @rationale
//   The prior it.todo block was blocked on WI-V1W2-WASM-02 (record lowering).
//   WI-V1W3-WASM-LOWER-06 implements the record lowering path via emitRecordModule()
//   and detectRecordShape(). This test exercises the full pipeline end-to-end:
//   makeSingleBlockResolution → wasmBackend().emit → WebAssembly.instantiate
//   → write struct to memory → call __wasm_export_sumRecord3 → assert parity.
//   Three fields + `| 0` ensures the general record path fires, not the wave-2
//   sum_record fast-path (which matches only `return r.field + r.field` without `| 0`).
// ---------------------------------------------------------------------------

const SUM_RECORD3_SOURCE =
  "export function sumRecord3(r: { a: number; b: number; c: number }, _size: number): number { return (r.a + r.b + r.c) | 0; }";

const MIXED_CORPUS: ReadonlyArray<[number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [5, 7, 3],
  [-3, 3, 1],
  [100, 200, 50],
  [-100, -200, 300],
  [1000, -1000, 500],
  [42, 58, -100],
];

describe("WI-V1W2-WASM-04 parity — mixed substrate: record-of-numbers (WI-V1W3-WASM-LOWER-06)", () => {
  it("wasm-backend emits a valid .wasm binary for the sumRecord3 substrate", async () => {
    const resolution = makeSingleBlockResolution(SUM_RECORD3_SOURCE);
    const wasmBytes = await wasmBackend().emit(resolution);

    expect(wasmBytes, "wasm-backend must return Uint8Array").toBeInstanceOf(Uint8Array);
    expect(wasmBytes[0]).toBe(0x00);
    expect(wasmBytes[1]).toBe(0x61);
    expect(wasmBytes[2]).toBe(0x73);
    expect(wasmBytes[3]).toBe(0x6d);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();
  });

  it(`parity: ${MIXED_CORPUS.length} explicit corpus cases produce value-equivalent results`, async () => {
    const resolution = makeSingleBlockResolution(SUM_RECORD3_SOURCE);
    const wasmBytes = await wasmBackend().emit(resolution);

    const STRUCT_SLOTS = 3;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;
    const STRUCT_PTR = 64; // safe non-conflicting test address

    for (const [a, b, c] of MIXED_CORPUS) {
      const tsRef = (a + b + c) | 0;

      const host = createHost();
      const { instance } = (await WebAssembly.instantiate(
        wasmBytes,
        host.importObject,
      )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
      const mem = host.memory;
      const dv = new DataView(mem.buffer);
      // Write r.a at slot 0 (offset 0), r.b at slot 1 (offset 8), r.c at slot 2 (offset 16)
      dv.setInt32(STRUCT_PTR + 0, a, true);
      dv.setInt32(STRUCT_PTR + 4, 0, true);
      dv.setInt32(STRUCT_PTR + 8, b, true);
      dv.setInt32(STRUCT_PTR + 12, 0, true);
      dv.setInt32(STRUCT_PTR + 16, c, true);
      dv.setInt32(STRUCT_PTR + 20, 0, true);

      const fn = (instance.exports as Record<string, unknown>)
        .__wasm_export_sumRecord3 as (ptr: number, size: number) => number;
      const wasmResult = fn(STRUCT_PTR, STRUCT_SIZE);

      expect(
        wasmResult,
        `sumRecord3({a:${a}, b:${b}, c:${c}}): WASM result (${wasmResult}) must equal TS reference (${tsRef})`,
      ).toBe(tsRef);
    }
  });

  it("parity: ≥10 fast-check property cases produce value-equivalent results", async () => {
    const resolution = makeSingleBlockResolution(SUM_RECORD3_SOURCE);
    const wasmBytes = await wasmBackend().emit(resolution);

    const STRUCT_SLOTS = 3;
    const STRUCT_SIZE = STRUCT_SLOTS * 8;
    const STRUCT_PTR = 64;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100000, max: 100000 }),
        fc.integer({ min: -100000, max: 100000 }),
        fc.integer({ min: -100000, max: 100000 }),
        async (a, b, c) => {
          const tsRef = (a + b + c) | 0;

          const host = createHost();
          const { instance } = (await WebAssembly.instantiate(
            wasmBytes,
            host.importObject,
          )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          const mem = host.memory;
          const dv = new DataView(mem.buffer);
          dv.setInt32(STRUCT_PTR + 0, a, true);
          dv.setInt32(STRUCT_PTR + 4, 0, true);
          dv.setInt32(STRUCT_PTR + 8, b, true);
          dv.setInt32(STRUCT_PTR + 12, 0, true);
          dv.setInt32(STRUCT_PTR + 16, c, true);
          dv.setInt32(STRUCT_PTR + 20, 0, true);

          const fn = (instance.exports as Record<string, unknown>)
            .__wasm_export_sumRecord3 as (ptr: number, size: number) => number;
          const wasmResult = fn(STRUCT_PTR, STRUCT_SIZE);
          expect(wasmResult, `sumRecord3({a:${a}, b:${b}, c:${c}})`).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ---------------------------------------------------------------------------
// WI-V1W3-WASM-LOWER-02 demo extension
//
// Three property-based parity cases: one per numeric domain (i32, i64, f64).
// Each case runs ≥15 fast-check inputs through the wave-3 general lowering path
// and asserts value parity against the TypeScript reference execution.
//
// Implementation:
//   The tests construct a ResolutionResult with a function whose source triggers
//   general lowering (NOT the wave-2 "add" fast-path). compileToWasm() routes
//   non-add-shaped functions through the general lowering path, which uses
//   inferNumericDomain() + LoweringVisitor to build the WasmFunction IR, then
//   emitTypeLoweredModule() to assemble the binary.
//
//   i32 domain: function uses bitwise `| 0` to force i32 inference (rule 4).
//   i64 domain: function uses literal 3000000000 > 2^31-1 to force i64 (rule 5).
//   f64 domain: function uses `/` to force f64 inference (rule 1).
//
// @decision DEC-V1-WAVE-3-WASM-LOWER-NUMERIC-001 (see visitor.ts file header)
// ---------------------------------------------------------------------------

import fc from "fast-check";

// Helper: build a minimal ResolutionResult for a single-block substrate source.
function makeSingleBlockResolution(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

describe("WI-V1W3-WASM-LOWER-02 demo extension — numeric domain parity", () => {
  // -------------------------------------------------------------------------
  // Case 1: i32 domain — bitwise compound expression
  // Force i32 inference via `| 0` bitop (inferNumericDomain rule 4).
  // Parity: WASM i32 result must equal TypeScript (a | 0) & b for ≥15 inputs.
  // -------------------------------------------------------------------------
  it("i32 property: (a | 0) & b — ≥15 fast-check inputs, parity vs ts-backend", async () => {
    const src = "export function andBit(a: number, b: number): number { return (a | 0) & b; }";
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await wasmBackend().emit(resolution);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        async (a, b) => {
          const tsRef = (a | 0) & b;
          const { result: wasmResult } = await instantiateAndRun(
            wasmBytes,
            "__wasm_export_andBit",
            [a, b],
          );
          expect(wasmResult).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  // -------------------------------------------------------------------------
  // Case 2: i64 domain — wide-range addition near i64 max
  // Force i64 inference via literal 3000000000 > 2^31-1 (inferNumericDomain rule 5).
  // Parity: WASM i64 result as BigInt must equal TypeScript BigInt addition.
  //
  // Note: instantiateAndRun returns number; for i64 we use BigInt conversion.
  // -------------------------------------------------------------------------
  it("i64 property: a + 3000000000 + b — ≥15 fast-check BigInt inputs, parity vs ts-backend", async () => {
    const src =
      "export function wideAdd(a: number, b: number): number { return a + 3000000000 + b; }";
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await wasmBackend().emit(resolution);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        fc.bigInt({ min: -1000000n, max: 1000000n }),
        async (a, b) => {
          const tsRef = a + 3000000000n + b;
          // i64 WASM functions return BigInt at the JS boundary
          const { result: wasmResult } = await instantiateAndRun(
            wasmBytes,
            "__wasm_export_wideAdd",
            [a, b] as unknown as number[],
          );
          expect(BigInt(wasmResult)).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  });

  // -------------------------------------------------------------------------
  // Case 3: f64 domain — true division
  // Force f64 inference via `/` operator (inferNumericDomain rule 1).
  // Parity: WASM f64 result must be bit-identical to TypeScript division.
  //
  // f64 tolerance: results are expected bit-identical (IEEE 754 double on both
  // sides). Epsilon check here is a defensive safeguard only.
  // -------------------------------------------------------------------------
  it("f64 property: a / b — ≥15 fast-check float inputs, parity vs ts-backend", async () => {
    const src = "export function divF(a: number, b: number): number { return a / b; }";
    const resolution = makeSingleBlockResolution(src);
    const wasmBytes = await wasmBackend().emit(resolution);
    expect(() => new WebAssembly.Module(wasmBytes)).not.toThrow();

    await fc.assert(
      fc.asyncProperty(
        fc.float({
          noNaN: true,
          noDefaultInfinity: true,
          min: Math.fround(-1e6),
          max: Math.fround(1e6),
        }),
        fc.float({
          noNaN: true,
          noDefaultInfinity: true,
          min: Math.fround(0.001),
          max: Math.fround(1e6),
        }),
        async (a, b) => {
          const tsRef = a / b;
          const { result: wasmResult } = await instantiateAndRun(wasmBytes, "__wasm_export_divF", [
            a,
            b,
          ]);
          // f64 results are bit-identical between WASM and JS (both IEEE 754 double)
          const relDiff = Math.abs(Number(wasmResult) - tsRef) / Math.max(Math.abs(tsRef), 1e-300);
          expect(relDiff).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// WI-FOLLOWUP-LOWER-02-WIDEADD — i64 boundary coverage (Issue #48)
//
// These tests address Issue #48: the existing i64 property test in the block
// above uses a narrow range (-1M..1M) that never exceeds Number.MAX_SAFE_INTEGER
// (2^53 - 1 = 9007199254740991). The precision loss introduced by the
// `number` cast in `instantiateAndRun` was therefore never observable.
//
// This block exercises the i64 precision boundary using `instantiateAndRunBigInt`,
// the test-local helper that returns JS `bigint` (no cast to number), confirming:
//   1. WASM i64 results are preserved past 2^53 - 1 with full 64-bit precision.
//   2. The lowering path correctly assembles the i64 binary for wideAdd.
//   3. A hypothetical 32-bit truncation bug in the visitor would be caught.
//
// wideAdd source: `function wideAdd(a: number, b: number): number { return a + 3000000000 + b; }`
//   — the baked-in constant 3_000_000_000 > 2^31-1 forces i64 inference (rule 5).
//   — WASM export: __wasm_export_wideAdd(a: i64, b: i64) → i64
//
// @decision DEC-WI-FOLLOWUP-WIDEADD-001
// (See bigint-instantiate.ts for full rationale.)
// ---------------------------------------------------------------------------

/**
 * @sacred-practice-4 truncation-injection-walkthrough
 *
 * If the visitor's i64 + lowering had a hypothetical `& 0xFFFFFFFFn` truncation bug,
 * `wideAdd(2n**53n, 1n)` would emit `(0x10000000000000n + 0xb2d05e00n + 0x1n) & 0xFFFFFFFFn`
 * = `0xb2d05e01n` = `3000000001n`, NOT `9007202254740993n`. The deterministic boundary
 * test would fail with: expected 9007202254740993n, got 3000000001n. This proves the
 * test catches the synthetic 32-bit truncation regression class.
 */
describe("wideAdd — i64 boundary past Number.MAX_SAFE_INTEGER (Issue #48)", () => {
  // The wideAdd source: constant 3_000_000_000 > 2^31-1 forces i64 domain inference.
  const WIDE_ADD_SRC =
    "export function wideAdd(a: number, b: number): number { return a + 3000000000 + b; }";

  // -------------------------------------------------------------------------
  // Substrate 1 — deterministic boundary cases
  //
  // 2^53 = 9007199254740992 (Number.MAX_SAFE_INTEGER + 1 = 9007199254740991 + 1)
  // wideAdd(2^53, 1)   = 9007199254740992 + 3_000_000_000 + 1   = 9007202254740993
  // wideAdd(-2^53, -1) = -9007199254740992 + 3_000_000_000 - 1  = -9007196254740993
  // wideAdd(2^62, 1)   = 4611686018427387904 + 3_000_000_000 + 1 = 4611686021427387905
  //
  // All three results exceed Number.MAX_SAFE_INTEGER in magnitude and therefore
  // cannot be represented faithfully as JS `number`. Only the bigint path captures
  // them correctly.
  // -------------------------------------------------------------------------

  it("wideAdd(2n**53n, 1n) → 9007202254740993n (= 2^53 + 3_000_000_000 + 1, beyond Number.MAX_SAFE_INTEGER)", async () => {
    const resolution = makeSingleBlockResolution(WIDE_ADD_SRC);
    const wasmBytes = await wasmBackend().emit(resolution);

    const { result } = await instantiateAndRunBigInt(
      wasmBytes,
      "__wasm_export_wideAdd",
      [2n ** 53n, 1n],
    );
    // 2^53 + 3_000_000_000 + 1 = 9007199254740992 + 3000000000 + 1 = 9007202254740993
    expect(result).toEqual(9007202254740993n);
  });

  it("wideAdd(-(2n**53n), -1n) → -9007196254740993n (negative i64 boundary; -2^53 + 3_000_000_000 - 1)", async () => {
    const resolution = makeSingleBlockResolution(WIDE_ADD_SRC);
    const wasmBytes = await wasmBackend().emit(resolution);

    const { result } = await instantiateAndRunBigInt(
      wasmBytes,
      "__wasm_export_wideAdd",
      [-(2n ** 53n), -1n],
    );
    // -2^53 + 3_000_000_000 + (-1) = -9007199254740992 + 2999999999 = -9007196254740993
    expect(result).toEqual(-9007196254740993n);
  });

  it("wideAdd(2n**62n, 1n) → 4611686021427387905n (i64 near-max boundary; 2^62 + 3_000_000_000 + 1)", async () => {
    const resolution = makeSingleBlockResolution(WIDE_ADD_SRC);
    const wasmBytes = await wasmBackend().emit(resolution);

    const { result } = await instantiateAndRunBigInt(
      wasmBytes,
      "__wasm_export_wideAdd",
      [2n ** 62n, 1n],
    );
    // 2^62 + 3_000_000_000 + 1 = 4611686018427387904 + 3000000001 = 4611686021427387905
    expect(result).toEqual(4611686021427387905n);
  });

  // -------------------------------------------------------------------------
  // Substrate 2 — fast-check property
  //
  // Ranges chosen to avoid i64 signed overflow:
  //   i64 signed max = 2^63 - 1 = 9223372036854775807
  //   We need: a + 3_000_000_000 + b <= 2^63 - 1
  //   Safe upper bound for a + b: 2^63 - 1 - 3_000_000_000 ≈ 9223372033854775807
  //
  //   a ∈ [2^52, 2^61]  — all values exceed Number.MAX_SAFE_INTEGER (2^53-1)
  //   b ∈ [0,   2^61]   — non-negative; a + b + 3B stays well below 2^63
  //
  // JS reference: a + 3000000000n + b (pure bigint arithmetic, no precision loss)
  // WASM result:  instantiateAndRunBigInt → bigint (no number cast)
  // -------------------------------------------------------------------------
  it("wideAdd over fc.bigInt — sums always match JS reference at any i64 magnitude", async () => {
    const resolution = makeSingleBlockResolution(WIDE_ADD_SRC);
    const wasmBytes = await wasmBackend().emit(resolution);

    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 2n ** 52n, max: 2n ** 61n }),
        fc.bigInt({ min: 0n, max: 2n ** 61n }),
        async (a, b) => {
          const wasmResult = (
            await instantiateAndRunBigInt(wasmBytes, "__wasm_export_wideAdd", [a, b])
          ).result;
          expect(wasmResult).toEqual(a + 3000000000n + b);
        },
      ),
      { numRuns: 30 },
    );
  });
});
