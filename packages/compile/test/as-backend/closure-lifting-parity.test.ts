// SPDX-License-Identifier: MIT
//
// closure-lifting-parity.test.ts — AS-backend T11: source-level lambda-lifting
//
// @decision DEC-AS-CLOSURE-STRATEGY-002
// Title: Slice 1 source-level lambda-lifting in prepareAsSource() hoists
//        `const/let f = (params): RetType => expr` forms (without an explicit
//        function-type annotation on the binding) to top-level named functions,
//        threading captured variables as additional leading parameters. Slice 1
//        covers S1 (no-capture lambda), S2 (single primitive capture), and S3
//        (flat-memory doubleAll via lifted lambda — A4 flat-memory protocol).
// Status: decided (WI-211-AS-CLOSURES-SLICE-1, Issue #211, 2026-05-13)
// Rationale:
//   DEC-AS-CLOSURE-STRATEGY-001 documented that ALL closure forms (C1-C4)
//   compile-fail under --runtime stub because closure-context allocation requires
//   GC. The source-level lambda-lifting transform in liftClosures() / prepareAsSource()
//   rewrites untyped arrow bindings to top-level functions before handing source to
//   asc, bypassing the closure-context requirement entirely.
//
//   This test file verifies:
//     S1: no-capture lambda (`const f = (x: number): number => x * 2`)
//     S2: single-primitive-capture lambda (`const f = (x: number): number => x + n`)
//     S3: flat-memory doubleAll via lifted lambda (A4 flat-memory protocol,
//         mirrors arrays-parity.test.ts A5 flat-memory shape)
//
//   Each substrate:
//     - Compiles to valid WASM via assemblyScriptBackend() (structural check)
//     - Produces value-equivalent results vs TS reference function (parity check)
//     - 20 fast-check runs for property-based coverage
//
//   liftClosures() unit tests: verify the transform produces expected source text
//   for each substrate WITHOUT invoking asc (pure text transformation checks).
//
// Production sequence exercised:
//   source string → liftClosures() → prepareAsSource() → assemblyScriptBackend().emit()
//   → WebAssembly.validate() → WebAssembly.instantiate() → export call → compare vs TS ref
//
// The compound-interaction test crosses all these boundaries in sequence.
//
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001 (inherited from numeric-parity.test.ts)
// @decision DEC-AS-BACKEND-OPTIONS-001 (exportMemory: true for S3 flat-memory substrate)
// @decision DEC-AS-ARRAY-LAYOUT-001 (S3 uses A4 flat-memory protocol)

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BlockMerkleRoot,
  type LocalTriplet,
  type SpecYak,
  blockMerkleRoot,
  specHash,
} from "@yakcc/contracts";
import { assemblyScriptBackend, liftClosures, prepareAsSource } from "../../src/as-backend.js";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers — mirror arrays-parity.test.ts / closures-parity.test.ts pattern
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
  const id = makeMerkleRoot(name, `Closure-lifting substrate: ${name}`, source);
  return makeResolution([{ id, source }]);
}

// ---------------------------------------------------------------------------
// Flat-memory layout constants (S3)
// @decision DEC-AS-ARRAY-LAYOUT-001
// Mirrors arrays-parity.test.ts ELEM_SIZE, ARR_BASE_PTR, OUT_BASE_PTR.
// S3 uses the same A4 flat-memory protocol: elements at ptr + i*4 (i32 stride).
// ---------------------------------------------------------------------------

const ELEM_SIZE = 4; // bytes per i32 element (4-byte stride)
const ARR_BASE_PTR = 64; // base pointer for input array in WASM linear memory
const OUT_BASE_PTR = 128; // base pointer for output array (S3 only)

// ---------------------------------------------------------------------------
// S1: double-via-lambda — no-capture arrow function
//
// Source shape: `const f = (x: number): number => x * 2;`
// Expected lift: top-level `function __closure_0(x: number): number { return x * 2; }`
// Call site: `f(n)` → `__closure_0(n)`
//
// TS reference: double(n) = n * 2 (i32)
// Fast-check domain: [-100_000, 100_000] (x*2 stays within i32 range)
// ---------------------------------------------------------------------------

const S1_DOUBLE_VIA_LAMBDA_SOURCE = `
export function double(n: number): number {
  const f = (x: number): number => x * 2;
  return f(n);
}
`.trim();

describe("AS backend closure-lifting — S1: double-via-lambda (no capture)", () => {
  it("S1: liftClosures() hoists arrow to __closure_0 and rewrites call site", () => {
    const lifted = liftClosures(S1_DOUBLE_VIA_LAMBDA_SOURCE);
    // Must contain a top-level __closure_0 function declaration
    expect(lifted).toContain("function __closure_0(");
    // Must NOT contain the original const f = ... binding
    expect(lifted).not.toMatch(/const f\s*=/);
    // Call site must be rewritten
    expect(lifted).toContain("__closure_0(n)");
    // Original binding name `f(` must not appear as a call site
    expect(lifted).not.toMatch(/\bf\(/);
  });

  it("S1: lifted source compiles to valid WASM via assemblyScriptBackend", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("double-s1", S1_DOUBLE_VIA_LAMBDA_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "S1 WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.double).toBe("function");
  }, 30_000);

  it("S1: parity vs TS reference — fixed inputs", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("double-s1-fixed", S1_DOUBLE_VIA_LAMBDA_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const doubleFn = instance.exports.double as (n: number) => number;

    const tsRef = (n: number) => (n * 2) | 0;

    expect(doubleFn(0)).toBe(tsRef(0));
    expect(doubleFn(1)).toBe(tsRef(1));
    expect(doubleFn(5)).toBe(tsRef(5));
    expect(doubleFn(-3)).toBe(tsRef(-3));
    expect(doubleFn(1000)).toBe(tsRef(1000));
  }, 30_000);

  it("S1: parity vs TS reference — 20 fast-check runs", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("double-s1-fc", S1_DOUBLE_VIA_LAMBDA_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const doubleFn = instance.exports.double as (n: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100_000, max: 100_000 }),
        async (n) => {
          const tsRef = (n * 2) | 0;
          expect(doubleFn(n) | 0).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S2: add-n-via-capture — single primitive capture
//
// Source shape: `const f = (x: number): number => x + n;`
// The arrow captures `n` from the enclosing function's parameter list.
// Expected lift: `function __closure_0(n: number, x: number): number { return x + n; }`
// Call site: `f(arg)` → `__closure_0(n, arg)`
//
// TS reference: addN(n, arg) = n + arg (i32)
// Fast-check domain: n ∈ [-1000, 1000], arg ∈ [-1000, 1000]
//   (sum stays within i32 range)
// ---------------------------------------------------------------------------

const S2_ADD_N_VIA_CAPTURE_SOURCE = `
export function addN(n: number, arg: number): number {
  const f = (x: number): number => x + n;
  return f(arg);
}
`.trim();

describe("AS backend closure-lifting — S2: add-n-via-capture (single primitive capture)", () => {
  it("S2: liftClosures() captures `n` from enclosing scope and threads it", () => {
    const lifted = liftClosures(S2_ADD_N_VIA_CAPTURE_SOURCE);
    // Must contain __closure_0 with `n` as a leading parameter
    expect(lifted).toContain("function __closure_0(");
    // The lifted function must include `n` as a parameter (capture)
    expect(lifted).toMatch(/function __closure_0\([^)]*\bn\b[^)]*\)/);
    // Must NOT contain the original const f = ... binding
    expect(lifted).not.toMatch(/const f\s*=/);
    // Call site must include n as a leading argument
    expect(lifted).toContain("__closure_0(n,");
  });

  it("S2: lifted source compiles to valid WASM via assemblyScriptBackend", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("addN-s2", S2_ADD_N_VIA_CAPTURE_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "S2 WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.addN).toBe("function");
  }, 30_000);

  it("S2: parity vs TS reference — fixed inputs", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("addN-s2-fixed", S2_ADD_N_VIA_CAPTURE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const addNFn = instance.exports.addN as (n: number, arg: number) => number;

    const tsRef = (n: number, arg: number) => (n + arg) | 0;

    expect(addNFn(0, 0)).toBe(tsRef(0, 0));
    expect(addNFn(5, 3)).toBe(tsRef(5, 3));
    expect(addNFn(-1, 10)).toBe(tsRef(-1, 10));
    expect(addNFn(100, -50)).toBe(tsRef(100, -50));
    expect(addNFn(0, 1000)).toBe(tsRef(0, 1000));
  }, 30_000);

  it("S2: parity vs TS reference — 20 fast-check runs", async () => {
    const backend = assemblyScriptBackend({ exportMemory: false });
    const resolution = makeSourceResolution("addN-s2-fc", S2_ADD_N_VIA_CAPTURE_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const addNFn = instance.exports.addN as (n: number, arg: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        async (n, arg) => {
          const tsRef = (n + arg) | 0;
          expect(addNFn(n, arg) | 0).toBe(tsRef);
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S3: double-all-flat-mem — flat-memory loop with lifted lambda
//
// Source shape: a for-loop over flat memory calling a lifted lambda to double
// each element, writing results to an output buffer.
//
// This mirrors arrays-parity.test.ts A5 (doubleAll flat-memory) but with the
// inner doubling logic expressed as a lifted arrow function.
//
// The lifted arrow `const double2 = (v: number): number => v * 2;` has no captures
// (self-contained). After lifting it becomes:
//   function __closure_0(v: number): number { return v * 2; }
//
// Source: exportMemory: true (flat-memory protocol)
// Layout: ARR_BASE_PTR=64 for input, OUT_BASE_PTR=128 for output.
//         Element i: load<i32>(ptr + i * 4)
// TS reference: for each element at i, write input[i] * 2 to output[i]
//
// @decision DEC-AS-ARRAY-LAYOUT-001 (flat-memory A4 protocol, i32 stride)
// @decision DEC-AS-CLOSURE-STRATEGY-002 (lambda-lifting for the inner doubler)
// ---------------------------------------------------------------------------

// @decision DEC-AS-CLOSURE-STRATEGY-002
// S3 fixture uses explicit `i32` types (not `number`) throughout — including ptr,
// len, outPtr, loop variable i, and the lifted lambda parameters.
// Rationale: `prepareAsSource` infers the domain from function signatures via
// `inferDomainFromSource`. A `number`-typed flat-memory function (ptr, len, outPtr)
// has no integer-specific pattern; asc infers `f64` and rewrites `number` → `f64`.
// Then `load<i32>(ptr + i * 4)` fails because AS200: f64 is not implicitly
// convertible to usize. Using explicit `i32` bypasses domain inference entirely:
// the source is already typed for asc, no `number` rewrite occurs, and the
// `load<i32>` / `store<i32>` calls receive correctly-typed `i32` pointer arguments.
// This mirrors arrays-parity.test.ts A1-A5 which all use `i32` explicitly.
const S3_DOUBLE_ALL_FLAT_MEM_SOURCE = `
export function doubleAll(ptr: i32, len: i32, outPtr: i32): void {
  const double2 = (v: i32): i32 => v * 2;
  for (let i: i32 = 0; i < len; i++) {
    const val: i32 = load<i32>(ptr + i * 4);
    store<i32>(outPtr + i * 4, double2(val));
  }
}
`.trim();

describe("AS backend closure-lifting — S3: double-all-flat-mem (flat-memory A4 protocol)", () => {
  it("S3: liftClosures() hoists double2 arrow to __closure_0", () => {
    const lifted = liftClosures(S3_DOUBLE_ALL_FLAT_MEM_SOURCE);
    expect(lifted).toContain("function __closure_0(");
    expect(lifted).not.toMatch(/const double2\s*=/);
    // Call site must be rewritten
    expect(lifted).toContain("__closure_0(val)");
  });

  it("S3: lifted source compiles to valid WASM with exported memory", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll-s3", S3_DOUBLE_ALL_FLAT_MEM_SOURCE);
    const wasmBytes = await backend.emit(resolution);

    expect(WebAssembly.validate(wasmBytes), "S3 WASM must be valid").toBe(true);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    expect(typeof instance.exports.doubleAll).toBe("function");
    expect(instance.exports.memory).toBeDefined();
  }, 30_000);

  it("S3: parity vs TS reference — fixed inputs [1, 2, 3, 4, 5]", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll-s3-fixed", S3_DOUBLE_ALL_FLAT_MEM_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const doubleAll = instance.exports.doubleAll as (
      ptr: number,
      len: number,
      outPtr: number,
    ) => void;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const view = new DataView(memory.buffer);

    const inputValues = [1, 2, 3, 4, 5];
    const len = inputValues.length;

    // Write input values into WASM memory at ARR_BASE_PTR
    for (let i = 0; i < len; i++) {
      view.setInt32(ARR_BASE_PTR + i * ELEM_SIZE, inputValues[i] ?? 0, true);
    }

    doubleAll(ARR_BASE_PTR, len, OUT_BASE_PTR);

    // Read output and verify
    for (let i = 0; i < len; i++) {
      const got = view.getInt32(OUT_BASE_PTR + i * ELEM_SIZE, true);
      const expected = ((inputValues[i] ?? 0) * 2) | 0;
      expect(got).toBe(expected);
    }
  }, 30_000);

  it("S3: parity vs TS reference — 20 fast-check runs (arrays of up to 8 elements)", async () => {
    const backend = assemblyScriptBackend({ exportMemory: true });
    const resolution = makeSourceResolution("doubleAll-s3-fc", S3_DOUBLE_ALL_FLAT_MEM_SOURCE);
    const wasmBytes = await backend.emit(resolution);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});

    const doubleAll = instance.exports.doubleAll as (
      ptr: number,
      len: number,
      outPtr: number,
    ) => void;
    const memory = instance.exports.memory as WebAssembly.Memory;

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 8 }),
        async (inputValues) => {
          const view = new DataView(memory.buffer);
          const len = inputValues.length;

          // Write input values into WASM memory
          for (let i = 0; i < len; i++) {
            view.setInt32(ARR_BASE_PTR + i * ELEM_SIZE, inputValues[i] ?? 0, true);
          }

          doubleAll(ARR_BASE_PTR, len, OUT_BASE_PTR);

          // Verify each output element
          for (let i = 0; i < len; i++) {
            const got = view.getInt32(OUT_BASE_PTR + i * ELEM_SIZE, true);
            const expected = ((inputValues[i] ?? 0) * 2) | 0;
            expect(got).toBe(expected);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// liftClosures() unit tests: pure text transformation verification
//
// These tests verify the transform output shape WITHOUT invoking asc.
// They cover: no-lift (source unchanged), multi-lift (counter increments),
// and the C2-probe-safety invariant (typed binding is NOT lifted).
// ---------------------------------------------------------------------------

describe("liftClosures() unit tests — pure text transformation", () => {
  it("preserves source unchanged when no arrow bindings are present", () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}
`.trim();
    const lifted = liftClosures(source);
    expect(lifted).toBe(source);
  });

  it("counter increments: two arrow bindings in the same function get __closure_0 and __closure_1", () => {
    const source = `
export function compute(n: number): number {
  const double = (x: number): number => x * 2;
  const addOne = (x: number): number => x + 1;
  return addOne(double(n));
}
`.trim();
    const lifted = liftClosures(source);
    expect(lifted).toContain("function __closure_0(");
    expect(lifted).toContain("function __closure_1(");
    expect(lifted).not.toMatch(/const double\s*=/);
    expect(lifted).not.toMatch(/const addOne\s*=/);
  });

  it("C2-probe safety: typed binding const f: (x: i32) => i32 = ... is NOT lifted", () => {
    // This is the EXACT C2 probe form from closures-parity.test.ts.
    // The lift must NOT touch this form so the C2 COMPILE FAIL probe remains stable.
    const source = `
const f: (x: i32) => i32 = (x: i32): i32 => x * 2;
export function callIt(): i32 {
  return f(7);
}
`.trim();
    const lifted = liftClosures(source);
    // Must NOT hoist — typed binding stays intact
    expect(lifted).not.toContain("__closure_0");
    expect(lifted).toContain("const f:");
    expect(lifted).toContain("f(7)");
  });

  it("prepareAsSource applies liftClosures then number→i32 rewrite in the correct order", () => {
    // prepareAsSource runs liftClosures first, then number→AS-type rewrite.
    // The lifted function body should have `number` rewritten to `i32`.
    const source = `
export function double(n: number): number {
  const f = (x: number): number => x * 2;
  return f(n);
}
`.trim();
    const prepared = prepareAsSource(source, "i32");
    // After lift + rewrite: `number` → `i32` everywhere, including the lifted function
    expect(prepared).not.toContain(": number");
    expect(prepared).toContain(": i32");
    // The lifted function must use i32 (not number)
    expect(prepared).toContain("function __closure_0(");
    // The hoisted function must have i32 types
    expect(prepared).toMatch(/function __closure_0\([^)]*: i32[^)]*\): i32/);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test
//
// Exercises the full production sequence end-to-end across all component
// boundaries:
//
//   source → liftClosures() → prepareAsSource() → assemblyScriptBackend()
//   → WASM bytes → WebAssembly.validate() → WebAssembly.instantiate()
//   → export call → compare vs TS reference
//
// This test is the required compound-interaction test (dispatch spec §).
// It chains S1 and S2 through the complete pipeline and verifies:
//   1. The lift produced the expected hoisted declaration shape
//   2. The WASM validates and has the correct WASM magic header
//   3. The exported function produces correct results across multiple inputs
//   4. The backend.name is "as" (identity check)
//   5. S2 capture threading produces correct results for varied (n, arg) pairs
//
// @decision DEC-AS-CLOSURE-STRATEGY-002
// @decision DEC-AS-PARITY-TEST-NODE-WASM-001
// @decision DEC-AS-PARITY-TEST-RESOLUTION-BUILDER-001
// ---------------------------------------------------------------------------

describe("AS backend closure-lifting — compound-interaction (full pipeline)", () => {
  it(
    "S1+S2 compound: full source→liftClosures→prepareAsSource→backend→wasm→instantiate→call chain; WASM magic; backend identity",
    async () => {
      // === S1 compound path ===
      const s1Backend = assemblyScriptBackend({ exportMemory: false });
      const s1Resolution = makeSourceResolution("compound-s1", S1_DOUBLE_VIA_LAMBDA_SOURCE);
      const s1WasmBytes = await s1Backend.emit(s1Resolution);

      // Step 1: validate WASM
      expect(WebAssembly.validate(s1WasmBytes), "S1 compound WASM must be valid").toBe(true);

      // Step 2: WASM magic header (0x00 0x61 0x73 0x6d)
      // Mirrors closures-parity.test.ts compound block pattern.
      expect(s1WasmBytes[0]).toBe(0x00);
      expect(s1WasmBytes[1]).toBe(0x61);
      expect(s1WasmBytes[2]).toBe(0x73);
      expect(s1WasmBytes[3]).toBe(0x6d);

      // Step 3: instantiate and verify value parity
      const { instance: s1Inst } = await WebAssembly.instantiate(s1WasmBytes, {});
      const s1Double = s1Inst.exports.double as (n: number) => number;

      // S1 fixed parity: double(n) = n * 2
      expect(s1Double(0) | 0).toBe(0);
      expect(s1Double(7) | 0).toBe(14);
      expect(s1Double(-5) | 0).toBe(-10);
      expect(s1Double(100) | 0).toBe(200);
      expect(s1Double(1000) | 0).toBe(2000);

      // Step 4: backend identity
      expect(s1Backend.name).toBe("as");

      // === S2 compound path ===
      const s2Backend = assemblyScriptBackend({ exportMemory: false });
      const s2Resolution = makeSourceResolution("compound-s2", S2_ADD_N_VIA_CAPTURE_SOURCE);
      const s2WasmBytes = await s2Backend.emit(s2Resolution);

      expect(WebAssembly.validate(s2WasmBytes), "S2 compound WASM must be valid").toBe(true);
      const { instance: s2Inst } = await WebAssembly.instantiate(s2WasmBytes, {});
      const s2AddN = s2Inst.exports.addN as (n: number, arg: number) => number;

      // S2 fixed parity: addN(n, arg) = n + arg
      expect(s2AddN(0, 0) | 0).toBe(0);
      expect(s2AddN(5, 3) | 0).toBe(8);
      expect(s2AddN(-1, 10) | 0).toBe(9);
      expect(s2AddN(100, -50) | 0).toBe(50);
      expect(s2AddN(0, 1000) | 0).toBe(1000);
      expect(s2AddN(-100, -100) | 0).toBe(-200);

      // Step 5: verify liftClosures() transform shape for both substrates
      // (unit assertion on the transform that feeds into the backend)
      const s1Lifted = liftClosures(S1_DOUBLE_VIA_LAMBDA_SOURCE);
      expect(s1Lifted).toContain("function __closure_0(");
      expect(s1Lifted).not.toMatch(/const f\s*=/);

      const s2Lifted = liftClosures(S2_ADD_N_VIA_CAPTURE_SOURCE);
      expect(s2Lifted).toContain("function __closure_0(");
      expect(s2Lifted).not.toMatch(/const f\s*=/);
      // S2: n must appear as a parameter in the lifted function (capture threading)
      expect(s2Lifted).toMatch(/function __closure_0\([^)]*\bn\b[^)]*\)/);

      // === S3 compound path ===
      const s3Backend = assemblyScriptBackend({ exportMemory: true });
      const s3Resolution = makeSourceResolution("compound-s3", S3_DOUBLE_ALL_FLAT_MEM_SOURCE);
      const s3WasmBytes = await s3Backend.emit(s3Resolution);

      expect(WebAssembly.validate(s3WasmBytes), "S3 compound WASM must be valid").toBe(true);
      const { instance: s3Inst } = await WebAssembly.instantiate(s3WasmBytes, {});
      const s3DoubleAll = s3Inst.exports.doubleAll as (
        ptr: number,
        len: number,
        outPtr: number,
      ) => void;
      const s3Memory = s3Inst.exports.memory as WebAssembly.Memory;
      const s3View = new DataView(s3Memory.buffer);

      // S3 compound: write [10, 20, 30] at ARR_BASE_PTR, read doubled at OUT_BASE_PTR
      const s3Input = [10, 20, 30];
      for (let i = 0; i < s3Input.length; i++) {
        s3View.setInt32(ARR_BASE_PTR + i * ELEM_SIZE, s3Input[i] ?? 0, true);
      }
      s3DoubleAll(ARR_BASE_PTR, s3Input.length, OUT_BASE_PTR);
      for (let i = 0; i < s3Input.length; i++) {
        const got = s3View.getInt32(OUT_BASE_PTR + i * ELEM_SIZE, true);
        expect(got).toBe(((s3Input[i] ?? 0) * 2) | 0);
      }
    },
    120_000,
  );
});
