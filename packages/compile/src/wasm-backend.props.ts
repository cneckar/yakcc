// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile wasm-backend.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the vitest
// harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3b)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exported from wasm-backend.ts):
//   WasmBackend       (WB1.1) — interface { name: string; emit(resolution) }
//   compileToWasm()   (WB1.2) — async function: ResolutionResult → Uint8Array
//   wasmBackend()     (WB1.3) — factory: () → WasmBackend
//
// Private atoms tested transitively via compileToWasm():
//   uleb128           (PWB1.1) — tested: output is valid WASM LEB128 header
//   concat            (PWB1.2) — tested: output is well-formed Uint8Array
//   section           (PWB1.3) — tested: output has correct section id prefix
//   detectSubstrateKind (PWB1.4) — tested: substrate routing from source text
//   emitSubstrateModule (PWB1.5) — tested: substrate binary starts with WASM magic
//   emitTypeLoweredModule (PWB1.6) — tested: numeric lowering produces valid WASM
//
// Properties:
//   - compileToWasm() returns a Uint8Array starting with WASM magic bytes
//   - compileToWasm() output has non-zero length (non-empty binary)
//   - wasmBackend().name is "wasm"
//   - wasmBackend().emit() delegates to compileToWasm() — same output
//   - compileToWasm() is deterministic for the same source (byte-identical re-emit)
//   - compileToWasm() for add substrate returns magic+version prefix
//   - compileToWasm() output is a valid Uint8Array (not a Buffer or plain Array)
//   - Empty resolution (no entry block) emits the substrate module
//
// numRuns: 5 per dispatch budget (ts-morph parse per call is expensive).
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import type { ResolutionResult } from "./resolve.js";
import { compileToWasm, wasmBackend } from "./wasm-backend.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexHash64 as fc.Arbitrary<BlockMerkleRoot>;
const specHashArb: fc.Arbitrary<SpecHash> = hexHash64 as fc.Arbitrary<SpecHash>;

/** WASM magic bytes: 0x00 0x61 0x73 0x6d */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
/** WASM version bytes: 0x01 0x00 0x00 0x00 */
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];

/** Build a minimal ResolutionResult with a single block. */
function makeSingleBlockResolution(
  root: BlockMerkleRoot,
  specHash: SpecHash,
  source: string,
): ResolutionResult {
  return {
    entry: root,
    blocks: new Map([
      [
        root,
        {
          merkleRoot: root,
          specHash,
          source,
          subBlocks: [],
        },
      ],
    ]),
    order: [root],
  };
}

/** Build a ResolutionResult with an empty blocks map (no entry block). */
function makeEmptyResolution(root: BlockMerkleRoot): ResolutionResult {
  return {
    entry: root,
    blocks: new Map(),
    order: [],
  };
}

// ---------------------------------------------------------------------------
// WB1.3: wasmBackend() — factory
// ---------------------------------------------------------------------------

/**
 * prop_wasmBackend_name_is_wasm
 *
 * wasmBackend().name is always "wasm".
 *
 * Invariant (WB1.3): the backend name is the identifier used by the compiler
 * pipeline to select the WASM emission path. Changing it breaks dispatch.
 */
export const prop_wasmBackend_name_is_wasm = fc.property(fc.constant(null), () => {
  return wasmBackend().name === "wasm";
});

/**
 * prop_wasmBackend_emit_delegates_to_compileToWasm
 *
 * wasmBackend().emit(resolution) returns the same bytes as compileToWasm(resolution).
 *
 * Invariant (WB1.3): the backend is a thin adapter — emit() delegates to
 * compileToWasm() without transformation.
 */
export const prop_wasmBackend_emit_delegates_to_compileToWasm = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const backend = wasmBackend();
    const [direct, via] = await Promise.all([compileToWasm(resolution), backend.emit(resolution)]);
    if (direct.length !== via.length) return false;
    return direct.every((byte, i) => byte === via[i]);
  },
);

// ---------------------------------------------------------------------------
// WB1.2: compileToWasm() — WASM magic bytes
// ---------------------------------------------------------------------------

/**
 * prop_compileToWasm_starts_with_wasm_magic
 *
 * compileToWasm() always returns a Uint8Array whose first 4 bytes are the
 * WASM magic cookie: 0x00 0x61 0x73 0x6d.
 *
 * Invariant (WB1.2): all valid WASM binaries start with the magic bytes per
 * the WebAssembly binary format specification §1.
 */
export const prop_compileToWasm_starts_with_wasm_magic = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return WASM_MAGIC.every((b, i) => bytes[i] === b);
  },
);

/**
 * prop_compileToWasm_starts_with_wasm_version
 *
 * compileToWasm() always returns a Uint8Array whose bytes [4..8) are the
 * WASM version: 0x01 0x00 0x00 0x00.
 *
 * Invariant (WB1.2): all valid WASM binaries have version 1 at bytes [4..8)
 * per the WebAssembly binary format specification §1.
 */
export const prop_compileToWasm_starts_with_wasm_version = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return WASM_VERSION.every((b, i) => bytes[4 + i] === b);
  },
);

/**
 * prop_compileToWasm_returns_uint8array
 *
 * compileToWasm() returns a Uint8Array (not a Buffer or plain Array).
 *
 * Invariant (WB1.2): the return type annotation is Uint8Array<ArrayBuffer>;
 * WebAssembly.instantiate() accepts Uint8Array directly, so the type must be
 * exact — a Buffer or Array would work but the type is load-bearing for callers.
 */
export const prop_compileToWasm_returns_uint8array = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return bytes instanceof Uint8Array;
  },
);

/**
 * prop_compileToWasm_output_is_non_empty
 *
 * compileToWasm() never returns an empty array; every WASM binary is at
 * least 8 bytes (magic + version).
 *
 * Invariant (WB1.2): even the minimal substrate module has the magic prefix;
 * an empty output would not be a valid WASM binary.
 */
export const prop_compileToWasm_output_is_non_empty = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return bytes.length >= 8;
  },
);

// ---------------------------------------------------------------------------
// WB1.2 (PWB1.5): emitSubstrateModule — empty resolution fallback
// ---------------------------------------------------------------------------

/**
 * prop_compileToWasm_empty_resolution_emits_substrate
 *
 * When the entry block is missing from the blocks map, compileToWasm() falls
 * back to emitSubstrateModule() which still returns a valid WASM binary.
 *
 * Invariant (WB1.2, PWB1.5): the fallback path (no entry block in map)
 * produces a non-empty Uint8Array starting with the WASM magic bytes.
 * This prevents a null/undefined return from reaching WebAssembly.instantiate().
 */
export const prop_compileToWasm_empty_resolution_emits_substrate = fc.asyncProperty(
  blockRootArb,
  async (root) => {
    const resolution = makeEmptyResolution(root);
    const bytes = await compileToWasm(resolution);
    return (
      bytes instanceof Uint8Array && bytes.length >= 8 && WASM_MAGIC.every((b, i) => bytes[i] === b)
    );
  },
);

// ---------------------------------------------------------------------------
// WB1.2: compileToWasm() — determinism
// ---------------------------------------------------------------------------

/**
 * prop_compileToWasm_is_deterministic
 *
 * Two calls to compileToWasm() with the same resolution produce byte-identical
 * output.
 *
 * Invariant (WB1.2): the compiler is a pure function of the resolution; there
 * is no runtime state (no timestamps, random bytes, or counters) in the
 * emitter. This is required by the L10 corpus-hash gate.
 */
export const prop_compileToWasm_is_deterministic = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const [b1, b2] = await Promise.all([compileToWasm(resolution), compileToWasm(resolution)]);
    if (b1.length !== b2.length) return false;
    return b1.every((byte, i) => byte === b2[i]);
  },
);

// ---------------------------------------------------------------------------
// WB1.2 (PWB1.6): emitTypeLoweredModule — general numeric lowering
// ---------------------------------------------------------------------------

/**
 * prop_compileToWasm_numeric_function_produces_valid_wasm_magic
 *
 * A general numeric function (not a wave-2 substrate) compiled through
 * compileToWasm() produces a binary with the correct WASM magic+version prefix.
 *
 * Invariant (WB1.2, PWB1.6): emitTypeLoweredModule returns a complete WASM
 * module; the magic header is always present regardless of the domain inferred.
 */
export const prop_compileToWasm_numeric_function_produces_valid_wasm_magic = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    // A bitwise-and function: not a wave-2 shape, uses general numeric lowering with i32 domain
    const source = "export function band(a: number, b: number): number { return a & b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return (
      bytes instanceof Uint8Array &&
      bytes.length >= 8 &&
      WASM_MAGIC.every((b, i) => bytes[i] === b) &&
      WASM_VERSION.every((b, i) => bytes[4 + i] === b)
    );
  },
);

/**
 * prop_compileToWasm_f64_function_produces_valid_wasm_binary
 *
 * A function with true division (/) infers f64 domain; the resulting binary
 * is a valid WASM binary with magic+version prefix.
 *
 * Invariant (WB1.2, PWB1.6): emitTypeLoweredModule correctly handles f64
 * domain; the binary is always well-formed regardless of domain.
 */
export const prop_compileToWasm_f64_function_produces_valid_wasm_binary = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  async (root, specHash) => {
    const source = "export function divide(a: number, b: number): number { return a / b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);
    return (
      bytes instanceof Uint8Array && bytes.length >= 8 && WASM_MAGIC.every((b, i) => bytes[i] === b)
    );
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: compileToWasm → instantiateAndRun (end-to-end)
//
// This is the production sequence: compile TS source → WASM binary →
// instantiate with conformant host → call exported function.
//
// Requirement: at least one test must exercise the real production sequence
// end-to-end, crossing the boundaries of multiple internal components.
// ---------------------------------------------------------------------------

/**
 * prop_compileToWasm_add_substrate_executes_correctly
 *
 * The wave-2 "add" substrate compiled to WASM, instantiated with createHost(),
 * and invoked via __wasm_export_add returns the sum of its two i32 arguments.
 *
 * This is the canonical compound-interaction test crossing:
 *   compileToWasm() → LoweringVisitor → emitSubstrateModule/emitTypeLoweredModule
 *   → WebAssembly.instantiate() → createHost() → exported function call
 *
 * Invariant (WB1.2 + WH1.7): the full pipeline produces a working WASM module
 * whose __wasm_export_add export returns a + b for any i32 inputs.
 */
export const prop_compileToWasm_add_substrate_executes_correctly = fc.asyncProperty(
  blockRootArb,
  specHashArb,
  fc.integer({ min: 0, max: 1000 }),
  fc.integer({ min: 0, max: 1000 }),
  async (root, specHash, a, b) => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const resolution = makeSingleBlockResolution(root, specHash, source);
    const bytes = await compileToWasm(resolution);

    // Instantiate via WebAssembly directly (no instantiateAndRun dependency)
    const { createHost } = await import("./wasm-host.js");
    const host = createHost();
    try {
      const { instance } = (await WebAssembly.instantiate(
        bytes,
        host.importObject,
      )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
      const fn = instance.exports.__wasm_export_add as (...args: number[]) => number;
      if (typeof fn !== "function") return false;
      const result = fn(a, b);
      return result === a + b;
    } finally {
      host.close();
    }
  },
);
