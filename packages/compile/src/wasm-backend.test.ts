/**
 * wasm-backend.test.ts — unit and integration tests for the WASM compilation backend.
 *
 * Production sequence exercised (compound-interaction test):
 *   makeResolution() → compileToWasm(resolution) → WebAssembly.instantiate(bytes)
 *   → instance.exports.add(2, 3) === 5
 *
 * Tests cover:
 *   1. magic-bytes:   result starts with WASM magic + version 1
 *   2. valid-module:  WebAssembly.Module construction does not throw
 *   3. add-2+3:       instantiate, call add(2, 3), assert === 5
 *   4. add-0+0:       add(0, 0) === 0
 *   5. add-negatives: add(-1, -1) via i32 wrapping === -2
 *   6. wasmBackend(): factory returns an object with name="wasm" and an emit() function
 *   7. module-size:   emitted module is in the expected range (20–100 bytes)
 *
 * @decision DEC-V1-WAVE-2-WASM-TEST-001: tests build a synthetic ResolutionResult
 * directly (same pattern as ts-backend.test.ts) rather than going through the full
 * assemble() pipeline. The compound-interaction test crosses wasm-backend + the
 * WebAssembly JS API boundary — sufficient to prove the binary is valid and callable.
 * Status: decided (WI-V1W2-WASM-01)
 */

import { type BlockMerkleRoot, blockMerkleRoot, specHash } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { compileToWasm, wasmBackend } from "./wasm-backend.js";

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
  it("instantiated module exports an 'add' function", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes);
    expect(typeof instance.exports["add"]).toBe("function");
  });

  it("add(2, 3) returns 5", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["add"] as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("add(0, 0) returns 0", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["add"] as (a: number, b: number) => number;
    expect(add(0, 0)).toBe(0);
  });

  it("add(-1, -1) returns -2 (i32 wrapping semantics)", async () => {
    // WASM i32.add treats the bit pattern as signed two's-complement;
    // -1 + -1 = -2 exactly within 32-bit range.
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["add"] as (a: number, b: number) => number;
    expect(add(-1, -1)).toBe(-2);
  });

  it("add(100, 200) returns 300", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["add"] as (a: number, b: number) => number;
    expect(add(100, 200)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Test: module size sanity check
// ---------------------------------------------------------------------------

describe("compileToWasm — module size", () => {
  it("emitted .wasm binary is between 20 and 100 bytes (minimal substrate sanity check)", async () => {
    const bytes = await compileToWasm(makeAddResolution());
    // The minimal add module encodes to ~38 bytes.
    // Lower bound: 8 (magic+version) + 4 sections × ~3 bytes each = ~20
    // Upper bound: 100 provides generous room while catching accidental bloat.
    expect(bytes.length).toBeGreaterThanOrEqual(20);
    expect(bytes.length).toBeLessThanOrEqual(100);
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
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["add"] as (a: number, b: number) => number;
    expect(add(7, 8)).toBe(15);
  });
});
