/**
 * wasm-backend.test.ts — unit and integration tests for the WASM compilation backend.
 *
 * Production sequence exercised (compound-interaction test):
 *   makeResolution() → compileToWasm(resolution) → WebAssembly.instantiate(bytes)
 *   → instance.exports.add(2, 3) === 5
 *
 * Tests cover:
 *   1.  magic-bytes:        result starts with WASM magic + version 1
 *   2.  valid-module:       WebAssembly.Module construction does not throw
 *   3.  add-2+3:            instantiate, call add(2, 3), assert === 5
 *   4.  add-0+0:            add(0, 0) === 0
 *   5.  add-negatives:      add(-1, -1) via i32 wrapping === -2
 *   6.  wasmBackend():      factory returns an object with name="wasm" and an emit() function
 *   7.  module-size:        emitted module is in the expected range (20–1000 bytes)
 *   8.  host-imports:       emitted module imports host.memory, host.host_log, host.host_alloc,
 *                           host.host_free, host.host_panic (Finding 1 — 5 required tests)
 *   9.  exports-shape:      emitted module exports __wasm_export_add (func) + _yakcc_table (table)
 *   10. parity-add:         add(a,b) wasm ≡ ts-backend reference for 5 input cases
 *   11. parity-greet:       greet(name) round-trips utf-8 through host_alloc, matches reference
 *   12. parity-divide:      divide(a,b) matches reference for 4 cases; host_panic on b=0
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-001: tests build a synthetic ResolutionResult
 * directly (same pattern as ts-backend.test.ts) rather than going through the full
 * assemble() pipeline. The compound-interaction test crosses wasm-backend + the
 * WebAssembly JS API boundary — sufficient to prove the binary is valid and callable.
 * Status: decided (WI-V1W2-WASM-01)
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-002: "parity" between wasm-backend and ts-backend
 * is defined as semantic equivalence against inline reference JS functions that match
 * what the ts-backend TS source would compute if executed. ts-backend emits source text,
 * not a runnable function, so parity is asserted by comparing wasm output against a
 * co-located reference implementation (not by running the assembled TS module at test time).
 * Status: decided (WI-V1W2-WASM-03)
 */

import { type BlockMerkleRoot, blockMerkleRoot, specHash } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { compileToWasm, wasmBackend } from "./wasm-backend.js";
import { WasmPanic, createWasmHost, importsFor } from "./wasm-host.js";

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
  it("instantiated module exports an '__wasm_export_add' function", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    expect(typeof instance.exports["__wasm_export_add"]).toBe("function");
  });

  it("add(2, 3) returns 5", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("add(0, 0) returns 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(0, 0)).toBe(0);
  });

  it("add(-1, -1) returns -2 (i32 wrapping semantics)", async () => {
    // WASM i32.add treats the bit pattern as signed two's-complement;
    // -1 + -1 = -2 exactly within 32-bit range.
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(-1, -1)).toBe(-2);
  });

  it("add(100, 200) returns 300", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(100, 200)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Test: module size sanity check
// ---------------------------------------------------------------------------

describe("compileToWasm — module size", () => {
  it("emitted .wasm binary is between 20 and 1000 bytes (sanity bound)", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    // After WI-V1W2-WASM-03 the module includes 5 host imports + table + per-function
    // export wrappers, so the minimum size grew from ~38 bytes to several hundred.
    // The upper bound is generous to catch accidental bloat (e.g., embedding source bytes).
    expect(bytes.length).toBeGreaterThanOrEqual(20);
    expect(bytes.length).toBeLessThanOrEqual(1000);
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

  it("backend.emit() produces an instantiable module (add(7, 8) === 15)", async () => {
    const backend = wasmBackend();
    const bytes = await backend.emit(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(createWasmHost()));
    const add = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(add(7, 8)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Tests: host import shape — Finding 1 from reviewer, test group 1
// ---------------------------------------------------------------------------

describe("compileToWasm with host imports", () => {
  it("emitted module imports host.memory, host.host_log, host.host_alloc, host.host_free, host.host_panic", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const mod = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(mod);

    // Build a map of (module, name) → kind for easy assertion.
    const importMap = new Map<string, string>();
    for (const { module, name, kind } of imports) {
      importMap.set(`${module}.${name}`, kind);
    }

    // All 5 required imports must be present with correct module namespace.
    expect(importMap.get("host.memory")).toBe("memory");
    expect(importMap.get("host.host_log")).toBe("function");
    expect(importMap.get("host.host_alloc")).toBe("function");
    expect(importMap.get("host.host_free")).toBe("function");
    expect(importMap.get("host.host_panic")).toBe("function");

    // Exactly 5 imports — no unexpected extras.
    expect(imports).toHaveLength(5);
  });

  it("emitted module exports __wasm_export_add per function and a _yakcc_table table-export of size 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);

    // Build a map of name → kind.
    const exportMap = new Map<string, string>();
    for (const { name, kind } of exports) {
      exportMap.set(name, kind);
    }

    // __wasm_export_add must be present as a function export.
    expect(exportMap.get("__wasm_export_add")).toBe("function");

    // _yakcc_table must be present as a table export.
    expect(exportMap.get("_yakcc_table")).toBe("table");

    // Instantiate and verify the table size is 0 (placeholder for WI-V1W2-WASM-04+).
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const table = instance.exports["_yakcc_table"] as WebAssembly.Table;
    expect(table).toBeInstanceOf(WebAssembly.Table);
    expect(table.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reference implementations (ts-backend semantic equivalents)
//
// The ts-backend emits TS source text, not an executable function. "Parity" is
// defined as semantic equivalence: for a given input, the wasm-backend result
// must match what the equivalent TS function would return when executed.
// These inline JS reference functions ARE what those TS implementations compute.
// ---------------------------------------------------------------------------

/**
 * Reference add: i32 wrapping arithmetic matching wasm i32.add semantics.
 * The TypeScript source is `export function add(a, b) { return a + b; }` — for
 * values within i32 range the result is identical; wrap cases verified explicitly.
 */
function refAdd(a: number, b: number): number {
  // i32.add wraps at 2^32; reproduce this with signed 32-bit arithmetic.
  return (((a | 0) + (b | 0)) | 0);
}

/**
 * Reference greet: matches the WASM greet substrate behavior.
 * ts-backend source would produce: `return "Hello, " + name + "!"`.
 */
function refGreet(name: string): string {
  return `Hello, ${name}!`;
}

/**
 * Reference divide: i32.div_s semantics (truncate toward zero).
 * Throws a plain Error for b === 0 (ts-backend equivalent of host_panic).
 */
function refDivide(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return Math.trunc(a / b) | 0;
}

// ---------------------------------------------------------------------------
// Tests: substrate parity — Finding 1 from reviewer, test group 2
// ---------------------------------------------------------------------------

describe("substrate parity", () => {
  it("add(a,b) wired through host imports computes byte-equivalent results to ts-backend for 5 input cases", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const wasmAdd = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;

    const cases: Array<[number, number]> = [
      [2, 3],               // basic: 5
      [0, 0],               // zero identity: 0
      [-1, -1],             // negative: -2
      [100, 200],           // larger values: 300
      [2147483647, 1],      // INT32_MAX + 1 → INT32_MIN (i32 wrapping)
    ];

    for (const [a, b] of cases) {
      const wasmResult = wasmAdd(a, b);
      const refResult = refAdd(a, b);
      expect(wasmResult).toBe(refResult);
    }
  });

  it("greet(name) round-trips a utf-8 string through host_alloc and produces byte-equivalent output to ts-backend for 5 input cases", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    // greet(in_ptr: i32, in_len: i32) → i64 (packed: hi=out_ptr, lo=out_len)
    const wasmGreet = instance.exports["__wasm_export_greet"] as (
      ptr: number,
      len: number,
    ) => bigint;

    const encoder = new TextEncoder();

    const cases = ["world", "", "héllo", "🚀", "long-input-".repeat(8)];

    for (const name of cases) {
      // Write the input string into host memory and call greet.
      const inputBytes = encoder.encode(name);
      const { ptr: inPtr, len: inLen } = host.writeUtf8(inputBytes);

      const packed = wasmGreet(inPtr, inLen);
      // The WASM module returns a packed i64: upper 32 bits = out_ptr, lower 32 bits = out_len.
      const outPtr = Number(packed >> 32n) & 0xffffffff;
      const outLen = Number(packed & 0xffffffffn);

      const wasmResult = host.readUtf8(outPtr, outLen);
      const refResult = refGreet(name);

      expect(wasmResult).toBe(refResult);
    }
  });

  it("divide(a,b) returns parity-equivalent quotients to ts-backend for 4 non-zero divisor cases and triggers host_panic for the divisor=0 case (5th case), matching ts-backend's error path", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const host = createWasmHost();
    const { instance } = await WebAssembly.instantiate(bytes, importsFor(host));
    const wasmDivide = instance.exports["__wasm_export_divide"] as (
      a: number,
      b: number,
    ) => number;

    // 4 non-zero divisor cases — wasm and reference must agree.
    const nonZeroCases: Array<[number, number, number]> = [
      [10, 2, 5],    // exact division
      [7, 2, 3],     // truncate toward zero (positive)
      [-7, 2, -3],   // truncate toward zero (negative)
      [100, 10, 10], // clean large division
    ];

    for (const [a, b, expected] of nonZeroCases) {
      const wasmResult = wasmDivide(a, b);
      const refResult = refDivide(a, b);
      expect(wasmResult).toBe(refResult);
      expect(wasmResult).toBe(expected);
    }

    // 5th case: b === 0 → wasm throws WasmPanic; ts-backend reference throws Error.
    expect(() => wasmDivide(10, 0)).toThrow(WasmPanic);
    expect(() => refDivide(10, 0)).toThrow(Error);
  });
});
