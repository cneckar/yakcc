// SPDX-License-Identifier: MIT
//
// multi-export.test.ts — AS-backend T1: multi-function module support
//
// @decision DEC-AS-MULTI-EXPORT-001
// Title: AS-backend emits multi-export modules; each `export function` becomes
//        callable via its natural name in the WASM export table.
// Status: decided (WI-AS-PHASE-2A-MULTI-EXPORT-AND-RECORDS, 2026-05-10)
// Rationale:
//   The 86 of 87 pending atoms in wave-3's pending-atoms.json fail with
//   LoweringError (missing-export) because the wave-3 visitor requires exactly
//   ONE exported function declaration per ResolvedBlock.source. asc has no such
//   constraint: it compiles every `export function` in the source and emits
//   them all into the WASM export table. This test proves that
//   assemblyScriptBackend().emit() produces a WASM module with N callable
//   exports when the source contains N `export function` declarations.
//
//   The consumer (closer-parity-as.test.ts) treats WASM-with-≥1-export as
//   "covered" (structural coverage for atoms with no value oracle; per-export
//   value parity when an oracle is present). This unblocks the 86 missing-export
//   atoms without any change to prepareAsSource() — asc handles multi-export
//   natively.
//
// Production sequence exercised (compound-interaction test):
//   source (N export functions) → assemblyScriptBackend().emit() → Uint8Array
//   → WebAssembly.instantiate(bytes, {}) → instance.exports[fnName](...args)
//   → value parity vs inline TS reference for each exported function
//
// Test coverage per eval contract T1:
//   - 3-export module: primary add + two helpers (sub, mul)
//   - Each export callable and value-equivalent to inline TS reference
//   - Minimum 15 fast-check runs per export (contract: ≥15)
//   - Minimum 3 assertions (contract: ≥3)

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
// Fixture helpers — mirror numeric-parity.test.ts pattern
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
  const id = makeMerkleRoot(name, `Multi-export substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Multi-export test — 3-export module
//
// Source has 3 exported functions: add (primary), sub, mul.
// asc compiles all three into the WASM export table.
// Each is called and verified for value parity vs inline TS reference.
// ---------------------------------------------------------------------------

describe("AS backend multi-export — T1: 3-function module (add, sub, mul)", () => {
  // Three i32 functions in a single source block — all exported.
  // asc natively emits all three into the WASM export table.
  // @decision DEC-AS-MULTI-EXPORT-001
  const MULTI_EXPORT_SOURCE = `
export function add(a: i32, b: i32): i32 {
  return (a + b);
}

export function sub(a: i32, b: i32): i32 {
  return (a - b);
}

export function mul(a: i32, b: i32): i32 {
  return (a * b);
}
`.trim();

  // Pre-compute WASM bytes once and share across sub-tests (emit is slow).
  let wasmBytes: Uint8Array<ArrayBuffer>;
  let exports_: WebAssembly.Exports;

  it("multi-export: emit() produces WASM with 3 named exports", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("multi-export-3fn", MULTI_EXPORT_SOURCE);
    wasmBytes = await backend.emit(resolution);

    // Foundation invariant: valid WASM
    expect(WebAssembly.validate(wasmBytes), "multi-export WASM must be valid").toBe(true);

    // Instantiate with empty import object — AS numeric modules need no imports
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    exports_ = instance.exports;

    // All three functions must be present in the export table
    expect(typeof exports_.add, "add must be exported function").toBe("function");
    expect(typeof exports_.sub, "sub must be exported function").toBe("function");
    expect(typeof exports_.mul, "mul must be exported function").toBe("function");
  }, 30_000);

  it("multi-export: add(a, b) — value parity vs TS reference (15 fast-check cases)", async () => {
    if (wasmBytes === undefined) {
      // Emit if not already done (test isolation)
      const backend = assemblyScriptBackend();
      const resolution = makeSourceResolution("multi-export-3fn", MULTI_EXPORT_SOURCE);
      wasmBytes = await backend.emit(resolution);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      exports_ = instance.exports;
    }

    const addFn = exports_.add as (a: number, b: number) => number;
    expect(typeof addFn).toBe("function");

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (a, b) => {
          const tsRef = (a + b) | 0;
          expect(addFn(a, b) | 0).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  }, 30_000);

  it("multi-export: sub(a, b) — value parity vs TS reference (15 fast-check cases)", async () => {
    if (wasmBytes === undefined) {
      const backend = assemblyScriptBackend();
      const resolution = makeSourceResolution("multi-export-3fn", MULTI_EXPORT_SOURCE);
      wasmBytes = await backend.emit(resolution);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      exports_ = instance.exports;
    }

    const subFn = exports_.sub as (a: number, b: number) => number;
    expect(typeof subFn).toBe("function");

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        async (a, b) => {
          const tsRef = (a - b) | 0;
          expect(subFn(a, b) | 0).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  }, 30_000);

  it("multi-export: mul(a, b) — value parity vs TS reference (15 fast-check cases)", async () => {
    if (wasmBytes === undefined) {
      const backend = assemblyScriptBackend();
      const resolution = makeSourceResolution("multi-export-3fn", MULTI_EXPORT_SOURCE);
      wasmBytes = await backend.emit(resolution);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      exports_ = instance.exports;
    }

    const mulFn = exports_.mul as (a: number, b: number) => number;
    expect(typeof mulFn).toBe("function");

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        async (a, b) => {
          const tsRef = Math.imul(a, b);
          expect(mulFn(a, b) | 0).toBe(tsRef);
        },
      ),
      { numRuns: 15 },
    );
  }, 30_000);

  // Compound-interaction test: full production sequence end-to-end.
  // Crosses assemblyScriptBackend ↔ Node WebAssembly API boundary.
  it("multi-export compound-interaction: source → backend → WASM → instantiate → 3 calls", async () => {
    const backend = assemblyScriptBackend();
    const resolution = makeSourceResolution("multi-export-compound", MULTI_EXPORT_SOURCE);

    // Step 1: emit
    const bytes = await backend.emit(resolution);

    // Step 2: validate
    expect(WebAssembly.validate(bytes)).toBe(true);

    // Step 3: instantiate
    const { instance } = await WebAssembly.instantiate(bytes, {});

    // Step 4: call each export with known inputs
    const add = instance.exports.add as (a: number, b: number) => number;
    const sub = instance.exports.sub as (a: number, b: number) => number;
    const mul = instance.exports.mul as (a: number, b: number) => number;

    expect(add(3, 4)).toBe(7);
    expect(sub(10, 3)).toBe(7);
    expect(mul(3, 4)).toBe(12);

    // Overflow wraps at i32 boundary
    expect(add(2147483647, 1) | 0).toBe(-2147483648);
  }, 30_000);
});
