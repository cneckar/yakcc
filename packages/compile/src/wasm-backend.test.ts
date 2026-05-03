/**
 * wasm-backend.test.ts — unit and integration tests for the WASM compilation backend.
 *
 * Production sequence exercised (compound-interaction test):
 *   makeResolution() → compileToWasm(resolution) → WebAssembly.instantiate(bytes)
 *   → instance.exports.add(2, 3) === 5
 *
 * Tests cover:
 *   1. magic-bytes:     result starts with WASM magic + version 1
 *   2. valid-module:    WebAssembly.Module construction does not throw
 *   3. add-2+3:         instantiate, call add(2, 3), assert === 5
 *   4. add-0+0:         add(0, 0) === 0
 *   5. add-negatives:   add(-1, -1) via i32 wrapping === -2
 *   6. wasmBackend():   factory returns an object with name="wasm" and an emit() function
 *   7. module-size:     emitted module is in the expected range (120–400 bytes)
 *   8–12. type-lowering parity matrix (WI-V1W2-WASM-02): 5 substrates × ≥5 corpus cases
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-001: tests build a synthetic ResolutionResult
 * directly (same pattern as ts-backend.test.ts) rather than going through the full
 * assemble() pipeline. The compound-interaction test crosses wasm-backend + the
 * WebAssembly JS API boundary — sufficient to prove the binary is valid and callable.
 * Status: decided (WI-V1W2-WASM-01)
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-002
 * Title: type-lowering parity test strategy — TS reference functions as ground truth
 * Status: decided (WI-V1W2-WASM-02)
 * Rationale:
 *   The ts-backend emits TypeScript source that requires a Node.js TS evaluator to
 *   run at value-level (not available without extra deps — same constraint as
 *   DEC-V1W2-WASM-DEMO-TSREF-001 in the parity demo). Instead, each substrate's
 *   TypeScript reference function is inlined directly in the test file and compared
 *   against WASM outputs. For complex types (string, record, array) the test harness
 *   handles marshaling: writing structs/arrays to WASM linear memory before the call
 *   and reading string bytes from memory after the call.
 */

import { type BlockMerkleRoot, blockMerkleRoot, specHash } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { compileToWasm, wasmBackend } from "./wasm-backend.js";
import { createHost } from "./wasm-host.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors ts-backend.test.ts pattern
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
    manifest: manifest as Parameters<typeof blockMerkleRoot>[0]["manifest"],
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

// Synthetic add(a, b) substrate source used in fixtures.
const ADD_IMPL_SOURCE = `export function add(a: number, b: number): number { return a + b; }`;

// Build a resolution for the minimal add substrate.
function makeAddResolution(): ResolutionResult {
  const id = makeMerkleRoot("add", "Return the sum of two integers", ADD_IMPL_SOURCE);
  return makeResolution([{ id, source: ADD_IMPL_SOURCE }]);
}

// ---------------------------------------------------------------------------
// Test: magic bytes
// ---------------------------------------------------------------------------

describe("compileToWasm — magic bytes and version", () => {
  it("result starts with WASM magic [0x00, 0x61, 0x73, 0x6d] and version [0x01, 0x00, 0x00, 0x00]", async () => {
    const bytes = await compileToWasm(makeAddResolution());

    // WASM magic: '\0asm'
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61);
    expect(bytes[2]).toBe(0x73);
    expect(bytes[3]).toBe(0x6d);
    // WASM version 1 (little-endian)
    expect(bytes[4]).toBe(0x01);
    expect(bytes[5]).toBe(0x00);
    expect(bytes[6]).toBe(0x00);
    expect(bytes[7]).toBe(0x00);
  });
});

// ---------------------------------------------------------------------------
// Test: valid WebAssembly.Module
// ---------------------------------------------------------------------------

describe("compileToWasm — valid module", () => {
  it("WebAssembly.Module can be constructed from the result without throwing", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: function-export — compound-interaction test (instantiate and call)
// ---------------------------------------------------------------------------

describe("compileToWasm — function export (compound-interaction)", () => {
  // WI-V1W2-WASM-03: module now requires yakcc_host import object (memory + 4 host fns).
  // Export is "__wasm_export_add" (renamed per host contract §4).
  it("instantiated module exports a '__wasm_export_add' function", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    expect(typeof instance.exports["__wasm_export_add"]).toBe("function");
  });

  it("add(2, 3) returns 5", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("add(0, 0) returns 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(0, 0)).toBe(0);
  });

  it("add(-1, -1) returns -2 (i32 wrapping semantics)", async () => {
    // WASM i32.add treats the bit pattern as signed two's-complement;
    // -1 + -1 = -2 exactly within 32-bit range.
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(-1, -1)).toBe(-2);
  });

  it("add(100, 200) returns 300", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(100, 200)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Test: module size sanity check
// ---------------------------------------------------------------------------

describe("compileToWasm — module size", () => {
  it("emitted .wasm binary is between 120 and 400 bytes (WI-V1W2-WASM-02 type-lowering sanity check)", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    // WI-V1W2-WASM-02 replaced the 3-function substrate module with a per-substrate
    // single-function module. The yakcc_host import section (~110 bytes) is retained,
    // so the minimum is ~120 bytes. Upper bound 400 catches accidental duplication.
    expect(bytes.length).toBeGreaterThanOrEqual(120);
    expect(bytes.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Test: wasmBackend() factory
// ---------------------------------------------------------------------------

describe("wasmBackend()", () => {
  it("returns an object with name 'wasm'", () => {
    const backend = wasmBackend();
    expect(backend.name).toBe("wasm");
  });

  it("backend.emit() returns a Uint8Array starting with WASM magic", async () => {
    const backend = wasmBackend();
    const bytes = await backend.emit(makeAddResolution());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61);
    expect(bytes[2]).toBe(0x73);
    expect(bytes[3]).toBe(0x6d);
  });

  it("backend.emit() produces an instantiable module (__wasm_export_add(7, 8) === 15)", async () => {
    const backend = wasmBackend();
    const bytes = await backend.emit(makeAddResolution());
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(7, 8)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Type-lowering parity matrix (WI-V1W2-WASM-02)
//
// For each of the 5 substrate type patterns, we:
//   1. Build a ResolutionResult from the substrate source
//   2. compileToWasm → instantiate → call with marshaled inputs
//   3. Compare WASM output against the inlined TypeScript reference function
//
// Memory layout for structured types: base ptr = 64 (above bump-alloc start=16,
// plenty of headroom before 64 KiB page boundary).
// ---------------------------------------------------------------------------

// Shared: create a ResolutionResult from arbitrary source text.
function makeSourceResolution(source: string): ResolutionResult {
  const fnName = source.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `Substrate for ${fnName}`, source);
  return makeResolution([{ id, source }]);
}

// Shared: instantiate a substrate and return instance + host memory.
async function instantiateSource(source: string) {
  const bytes = await compileToWasm(makeSourceResolution(source));
  const host = createHost();
  const { instance } = (await WebAssembly.instantiate(
    bytes,
    host.importObject,
  )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  return { instance, memory: host.memory };
}

// Memory helpers
function writeI32LE(memory: WebAssembly.Memory, offset: number, value: number): void {
  new DataView(memory.buffer).setInt32(offset, value, true);
}
function writeUtf8(memory: WebAssembly.Memory, offset: number, s: string): number {
  const bytes = new TextEncoder().encode(s);
  new Uint8Array(memory.buffer).set(bytes, offset);
  return bytes.length;
}
function readUtf8(memory: WebAssembly.Memory, offset: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, offset, len));
}

// ---------------------------------------------------------------------------
// SUBSTRATE 1: number → number  (add, exercises i32 selection)
// Already tested above; parity matrix adds more corpus cases here.
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-02 parity — substrate 1: number → number", () => {
  const SRC = `export function add(a: number, b: number): number { return a + b; }`;
  const tsRef = (a: number, b: number): number => (a + b) | 0;

  const corpus: ReadonlyArray<[number, number]> = [
    [0, 0],
    [1, 2],
    [42, 58],
    [-1, 1],
    [2147483647, 0],
  ];

  it("type-lowering emits __wasm_export_add with i32×i32→i32 signature", async () => {
    const { instance } = await instantiateSource(SRC);
    expect(typeof instance.exports["__wasm_export_add"]).toBe("function");
  });

  it(`parity: ${corpus.length} corpus cases match TypeScript reference`, async () => {
    const { instance } = await instantiateSource(SRC);
    const fn = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    for (const [a, b] of corpus) {
      expect(fn(a, b), `add(${a}, ${b})`).toBe(tsRef(a, b));
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 2: string → number  (stringLen, exercises string-view lowering)
//
// Calling convention: WASM function receives (ptr: i32, len: i32).
// The test writes UTF-8 bytes to WASM memory at ptr=64 and passes (64, byteLen).
// WASM returns byteLen unchanged (exercises string-view lowering; the value
// returned is the byte count, which equals .length for ASCII-only strings).
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-02 parity — substrate 2: string → number", () => {
  const SRC = `export function stringLen(s: string): number { return s.length; }`;
  const tsRef = (s: string): number => s.length;
  const PTR = 64;

  const corpus: ReadonlyArray<string> = ["", "a", "hello", "test", "01234"];

  it("type-lowering emits __wasm_export_stringLen with ptr+len→i32 signature", async () => {
    const { instance, memory } = await instantiateSource(SRC);
    expect(typeof instance.exports["__wasm_export_stringLen"]).toBe("function");
    // Smoke: "hi" (2 bytes) → 2
    const byteLen = writeUtf8(memory, PTR, "hi");
    const fn = instance.exports["__wasm_export_stringLen"] as (p: number, l: number) => number;
    expect(fn(PTR, byteLen)).toBe(2);
  });

  it(`parity: ${corpus.length} corpus cases match TypeScript reference`, async () => {
    const { instance, memory } = await instantiateSource(SRC);
    const fn = instance.exports["__wasm_export_stringLen"] as (p: number, l: number) => number;
    for (const s of corpus) {
      const byteLen = writeUtf8(memory, PTR, s);
      expect(fn(PTR, byteLen), `stringLen("${s}")`).toBe(tsRef(s));
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 3: number → string  (formatI32, exercises host-mediated string return)
//
// Calling convention: WASM function receives (n: i32, out_ptr: i32).
// It writes ASCII decimal bytes to out_ptr and returns the byte count.
// Handles n in [0, 99] (single and double digit).
// The test compares the decoded string against String(n).
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-02 parity — substrate 3: number → string", () => {
  const SRC = `export function formatI32(n: number): string { return String(n); }`;
  const tsRef = (n: number): string => String(n);
  const OUT_PTR = 64;

  const corpus: ReadonlyArray<number> = [0, 1, 9, 42, 99];

  it("type-lowering emits __wasm_export_formatI32 with n+out_ptr→len signature", async () => {
    const { instance, memory } = await instantiateSource(SRC);
    expect(typeof instance.exports["__wasm_export_formatI32"]).toBe("function");
    const fn = instance.exports["__wasm_export_formatI32"] as (n: number, out: number) => number;
    const len = fn(5, OUT_PTR);
    expect(len).toBe(1);
    expect(readUtf8(memory, OUT_PTR, len)).toBe("5");
  });

  it(`parity: ${corpus.length} corpus cases produce byte-equivalent decimal strings`, async () => {
    const { instance, memory } = await instantiateSource(SRC);
    const fn = instance.exports["__wasm_export_formatI32"] as (n: number, out: number) => number;
    for (const n of corpus) {
      const len = fn(n, OUT_PTR);
      const wasmStr = readUtf8(memory, OUT_PTR, len);
      expect(wasmStr, `formatI32(${n})`).toBe(tsRef(n));
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 4: record<{a:number,b:number}> → number  (sumRecord, exercises struct lowering)
//
// Calling convention: WASM function receives (ptr: i32).
// The caller writes field[0] (a) as i32LE at ptr+0 and field[1] (b) at ptr+4.
// DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 struct field-alignment policy: 4-byte-aligned
// i32 values in declaration order.
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-02 parity — substrate 4: record → number", () => {
  const SRC = `export function sumRecord(r: {a: number; b: number}): number { return r.a + r.b; }`;
  const tsRef = (a: number, b: number): number => (a + b) | 0;
  const PTR = 64;

  const corpus: ReadonlyArray<[number, number]> = [
    [1, 2],
    [3, 7],
    [0, 0],
    [-1, 1],
    [100, 200],
  ];

  it("type-lowering emits __wasm_export_sumRecord with ptr→i32 signature", async () => {
    const { instance, memory } = await instantiateSource(SRC);
    expect(typeof instance.exports["__wasm_export_sumRecord"]).toBe("function");
    writeI32LE(memory, PTR, 4);
    writeI32LE(memory, PTR + 4, 6);
    const fn = instance.exports["__wasm_export_sumRecord"] as (p: number) => number;
    expect(fn(PTR)).toBe(10);
  });

  it(`parity: ${corpus.length} corpus cases match TypeScript reference`, async () => {
    const { instance, memory } = await instantiateSource(SRC);
    const fn = instance.exports["__wasm_export_sumRecord"] as (p: number) => number;
    for (const [a, b] of corpus) {
      writeI32LE(memory, PTR, a);
      writeI32LE(memory, PTR + 4, b);
      expect(fn(PTR), `sumRecord({a:${a},b:${b}})`).toBe(tsRef(a, b));
    }
  });
});

// ---------------------------------------------------------------------------
// SUBSTRATE 5: array<number> → number  (sumArray, exercises array length+pointer)
//
// Calling convention: WASM function receives (ptr: i32, len: i32) where len is
// element count. Each element is an i32LE at ptr + i*4.
// DEC-V1-WAVE-2-WASM-TYPE-LOWERING-001 array element-stride policy: 4 bytes.
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-02 parity — substrate 5: array<number> → number", () => {
  const SRC = `export function sumArray(arr: number[]): number { return arr.reduce((s, x) => s + x, 0); }`;
  const tsRef = (arr: number[]): number => arr.reduce((s, x) => s + x, 0) | 0;
  const PTR = 64;

  const corpus: ReadonlyArray<number[]> = [
    [1, 2, 3, 4, 5],
    [0, 0, 0],
    [10, -5, 3, -2, 4],
    [-1, 1],
    [100, 200, 300, 400, 500],
  ];

  it("type-lowering emits __wasm_export_sumArray with ptr+len→i32 signature", async () => {
    const { instance, memory } = await instantiateSource(SRC);
    expect(typeof instance.exports["__wasm_export_sumArray"]).toBe("function");
    [1, 2, 3].forEach((v, i) => writeI32LE(memory, PTR + i * 4, v));
    const fn = instance.exports["__wasm_export_sumArray"] as (p: number, l: number) => number;
    expect(fn(PTR, 3)).toBe(6);
  });

  it(`parity: ${corpus.length} corpus cases match TypeScript reference`, async () => {
    const { instance, memory } = await instantiateSource(SRC);
    const fn = instance.exports["__wasm_export_sumArray"] as (p: number, l: number) => number;
    for (const arr of corpus) {
      arr.forEach((v, i) => writeI32LE(memory, PTR + i * 4, v));
      expect(fn(PTR, arr.length), `sumArray([${arr}])`).toBe(tsRef(arr));
    }
  });
});
