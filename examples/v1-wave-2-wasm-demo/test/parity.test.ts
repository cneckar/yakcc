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

import { describe, expect, it } from "vitest";
import { type BlockMerkleRoot, blockMerkleRoot, specHash } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { tsBackend, wasmBackend, instantiateAndRun, WasmTrap } from "@yakcc/compile";
import type { ResolutionResult, ResolvedBlock } from "@yakcc/compile";

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

// The add substrate source — must match src/add.ts (reference function above).
const ADD_IMPL_SOURCE = `export function add(a: number, b: number): number { return a + b; }`;

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
// Pending WI-V1W2-WASM-02 — general type-lowering for string substrates.
//
// The WASM backend currently exports __wasm_export_string_len(ptr, len) → len
// (a fixed-substrate function, not derived from the ResolutionResult's implSource).
// A real string-handling parity test requires WI-V1W2-WASM-02 to lower a
// TypeScript `(s: string) => number` substrate to the WASM string-interchange
// calling convention (ptr+len in linear memory via host_alloc). Until that
// type-lowering lands, the two backends operate on different calling conventions
// and value-level parity cannot be asserted without manual bridging code that
// would mask — not expose — the gap.
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-04 parity — string substrate: pending WI-V1W2-WASM-02", () => {
  it.todo(
    "parity: string-handling substrate — ≥10 corpus cases (blocked: WI-V1W2-WASM-02 type-lowering for string not yet implemented)",
  );
});

// ---------------------------------------------------------------------------
// SUBSTRATE 3: Mixed (record-of-numbers, struct lowering + host bindings)
//
// Pending WI-V1W2-WASM-02 — record/struct type-lowering.
//
// A mixed substrate exercises flat-struct lowering in linear memory with field
// offsets. The WASM backend has no general IR-to-struct-layout pass until
// WI-V1W2-WASM-02 lands; marking as pending per Sacred Practice #12.
// ---------------------------------------------------------------------------

describe("WI-V1W2-WASM-04 parity — mixed substrate: pending WI-V1W2-WASM-02", () => {
  it.todo(
    "parity: mixed-substrate (record-of-numbers) — ≥10 corpus cases (blocked: WI-V1W2-WASM-02 record/struct lowering not yet implemented)",
  );
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
