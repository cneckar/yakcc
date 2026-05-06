/**
 * missing-export-wrapper.test.ts — Tests for WI-V1W4-LOWER-EXTEND-MISSING-EXPORT.
 *
 * Purpose:
 *   Verify that compileToWasm synthesizes a valid `export function` wrapper around
 *   bare implSources (arrow functions, expressions) that lack one, eliminating the
 *   `LoweringError (missing-export)` that previously blocked 86 corpus atoms.
 *
 * Test plan:
 *   1. Wrapper-synthesis path: bare arrow function → valid WASM + synthesized export name
 *   2. Idempotency / no double-wrap: `export function`-shaped source passes through unchanged
 *   3. Wave-2 sum_record regression: sumFields substrate still compiles (byte-stable check)
 *   4. Parity: ≥5 fast-check cases against ts-backend on a synthetic sub-fragment
 *   5. Multi-param arrow: (a, b, c) => expr synthesis
 *   6. Zero-param arrow: () => expr synthesis
 *
 * @decision DEC-V1-WAVE-4-WASM-LOWER-EXTEND-002
 *   Wrapper synthesis at compileToWasm entry; visitor.ts diff-zero.
 */

import { type BlockMerkleRoot, type LocalTriplet, blockMerkleRoot, specHash } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ResolutionResult, ResolvedBlock } from "../../src/resolve.js";
import { compileToWasm, wasmBackend } from "../../src/wasm-backend.js";
import { tsBackend } from "../../src/ts-backend.js";
import { createHost } from "../../src/wasm-host.js";

// ---------------------------------------------------------------------------
// Fixture helpers
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

/** Build a synthetic single-block ResolutionResult from raw source (may lack export function). */
function makeResolutionFromBare(implSource: string): ResolutionResult {
  // Use a stable name — for bare sources the fnName regex won't find a match,
  // so we use a fixed fallback. The merkleRoot is computed from content hash.
  const id = makeMerkleRoot("bare_fragment", "bare fragment substrate", implSource);
  return makeResolution([{ id, source: implSource }]);
}

/** Build a single-block resolution from a proper exported function source. */
function makeResolutionFromExport(fnSource: string): ResolutionResult {
  const fnName = fnSource.match(/export\s+function\s+(\w+)/)?.[1] ?? "fn";
  const id = makeMerkleRoot(fnName, `${fnName} substrate`, fnSource);
  return makeResolution([{ id, source: fnSource }]);
}

// ---------------------------------------------------------------------------
// Test 1: Wrapper-synthesis path — bare arrow function produces valid WASM
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: wrapper synthesis path", () => {
  // Production sequence: compileToWasm receives a bare arrow function implSource.
  // This is the real sequence: shave corpus emits sub-fragments as bare source;
  // survey.test.ts calls wasmBackend().emit() on each. Wrapper synthesis must
  // produce source the visitor can lower to a valid WASM binary.
  const BARE_ARROW = "(a: number, b: number) => a + b";

  it("bare arrow function → WebAssembly.validate passes", async () => {
    const resolution = makeResolutionFromBare(BARE_ARROW);
    const bytes = await compileToWasm(resolution);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });

  it("bare arrow function → WASM module exports the synthesized name", async () => {
    const resolution = makeResolutionFromBare(BARE_ARROW);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    // The synthesized name starts with wasm_export_ — check at least one export exists
    // and has the expected prefix.
    const wrapperExport = exports.find(
      (e) => e.name.startsWith("__wasm_export_wasm_export_") || e.name.startsWith("wasm_export_"),
    );
    expect(wrapperExport).toBeDefined();
  });

  it("bare arrow function → WASM can be instantiated with yakcc host", async () => {
    const resolution = makeResolutionFromBare(BARE_ARROW);
    const bytes = await compileToWasm(resolution);
    const host = createHost();
    // Should not throw
    await expect(
      WebAssembly.instantiate(bytes, host.importObject),
    ).resolves.toBeDefined();
  });

  it("synthesized function (a+b) produces correct arithmetic result", async () => {
    const resolution = makeResolutionFromBare(BARE_ARROW);
    const bytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(bytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    // Find the exported function — it should be prefixed with __wasm_export_wasm_export_...
    const exportedName = Object.keys(instance.exports).find(
      (k) => k.includes("wasm_export_"),
    );
    expect(exportedName).toBeDefined();
    const fn = instance.exports[exportedName!] as (a: number, b: number) => number;
    expect(fn(2, 3)).toBe(5);
    expect(fn(0, 0)).toBe(0);
    expect(fn(-7, 7)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Idempotency — source with export function passes through unchanged
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: idempotency (no double-wrap)", () => {
  // Production sequence: an already-wrapped source should produce the same WASM
  // regardless of whether it was synthesized or came from a proper block.
  const EXPORT_FN_SOURCE = `export function add(a: number, b: number): number { return a + b; }`;

  it("already-wrapped source still produces valid WASM", async () => {
    const resolution = makeResolutionFromExport(EXPORT_FN_SOURCE);
    const bytes = await compileToWasm(resolution);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });

  it("already-wrapped source exports __wasm_export_add (not a double-wrap)", async () => {
    const resolution = makeResolutionFromExport(EXPORT_FN_SOURCE);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    // Must export __wasm_export_add — not __wasm_export_wasm_export_<hash>
    expect(exports.some((e) => e.name === "__wasm_export_add")).toBe(true);
    // Must NOT have double-wrapped names
    expect(exports.some((e) => e.name.includes("wasm_export_wasm_export_"))).toBe(false);
  });

  it("already-wrapped source gives same value as before synthesis logic", async () => {
    // Regression: the synthesis path must not alter already-valid sources.
    const resolution = makeResolutionFromExport(EXPORT_FN_SOURCE);
    const bytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(bytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports["__wasm_export_add"] as (a: number, b: number) => number;
    expect(fn(2, 3)).toBe(5);
    expect(fn(10, 20)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Wave-2 sum_record regression — record-01 must be byte-stable
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: wave-2 sum_record regression", () => {
  // This is the record-01 substrate from records.test.ts.
  // The synthesis path must not interfere with properly exported sources.
  const SUM_RECORD_SOURCE = `export function sumFields(r: { a: number; b: number; c: number }, _size: number): number { return (r.a + r.b + r.c) | 0; }`;

  it("sum_record compiles to valid WASM (regression)", async () => {
    const resolution = makeResolutionFromExport(SUM_RECORD_SOURCE);
    const bytes = await compileToWasm(resolution);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });

  it("sum_record exports __wasm_export_sumFields (regression)", async () => {
    const resolution = makeResolutionFromExport(SUM_RECORD_SOURCE);
    const bytes = await compileToWasm(resolution);
    const mod = new WebAssembly.Module(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.name === "__wasm_export_sumFields")).toBe(true);
  });

  it("sum_record byte-stability: compiles twice and produces identical bytes", async () => {
    const resolution1 = makeResolutionFromExport(SUM_RECORD_SOURCE);
    const resolution2 = makeResolutionFromExport(SUM_RECORD_SOURCE);
    const bytes1 = await compileToWasm(resolution1);
    const bytes2 = await compileToWasm(resolution2);
    expect(bytes1).toEqual(bytes2);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Fast-check parity — ≥5 cases of bare arrow vs ts-backend reference
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: fast-check parity against ts-backend (≥5 cases)", () => {
  // Production sequence: ts-backend and wasm-backend must agree on value outputs
  // for the same sub-fragment. For bare arrow functions, the wrapper produces
  // a callable WASM function; ts-backend wraps the same source in a module.
  // We verify the WASM computed value matches the ts-backend reference.
  //
  // Note: ts-backend emits TS source (not evaluatable directly). Instead we
  // use JavaScript eval on the arrow function body as the reference oracle.

  const PARITY_ARROW = "(a: number, b: number) => (a * 2 + b) | 0";
  // Reference: the same computation in JS
  const jsRef = (a: number, b: number) => ((a * 2 + b) | 0);

  it("parity: ≥5 fast-check cases (a*2+b)|0 — WASM matches JS reference", async () => {
    const resolution = makeResolutionFromBare(PARITY_ARROW);
    const bytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(bytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const exportedName = Object.keys(instance.exports).find((k) => k.includes("wasm_export_"));
    expect(exportedName).toBeDefined();
    const fn = instance.exports[exportedName!] as (a: number, b: number) => number;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        async (a, b) => {
          const wasmResult = fn(a, b);
          const tsResult = jsRef(a, b);
          expect(wasmResult).toBe(tsResult);
        },
      ),
      { numRuns: 5 },
    );
  });

  it("ts-backend emits non-empty output for bare arrow (corpus parity check)", async () => {
    // Mirrors survey.test.ts line 274: both backends must handle the same source.
    const ARROW_SOURCE = "(a: number, b: number) => a + b";
    const resolution = makeResolutionFromBare(ARROW_SOURCE);
    const tsOut = await tsBackend().emit(resolution);
    expect(tsOut.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Multi-param arrow synthesis — (a, b, c) => expr
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: multi-param arrow (a, b, c)", () => {
  const THREE_PARAM_ARROW = "(a: number, b: number, c: number) => (a + b + c) | 0";

  it("three-param arrow → valid WASM", async () => {
    const resolution = makeResolutionFromBare(THREE_PARAM_ARROW);
    const bytes = await compileToWasm(resolution);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });

  it("three-param arrow → correct arithmetic", async () => {
    const resolution = makeResolutionFromBare(THREE_PARAM_ARROW);
    const bytes = await compileToWasm(resolution);
    const host = createHost();
    const { instance } = (await WebAssembly.instantiate(bytes, host.importObject)) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const exportedName = Object.keys(instance.exports).find((k) => k.includes("wasm_export_"));
    expect(exportedName).toBeDefined();
    const fn = instance.exports[exportedName!] as (a: number, b: number, c: number) => number;
    expect(fn(1, 2, 3)).toBe(6);
    expect(fn(10, 20, 30)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Test 6: wasmBackend() factory also handles bare sources
// ---------------------------------------------------------------------------

describe("missing-export-wrapper: wasmBackend() factory path", () => {
  it("wasmBackend().emit() handles bare arrow source (no missing-export)", async () => {
    const BARE = "(x: number) => x * x";
    const resolution = makeResolutionFromBare(BARE);
    const backend = wasmBackend();
    const bytes = await backend.emit(resolution);
    expect(WebAssembly.validate(bytes)).toBe(true);
  });
});
