// SPDX-License-Identifier: MIT
// Vitest harness for wasm-backend.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling wasm-backend.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_compileToWasm_add_substrate_executes_correctly,
  prop_compileToWasm_empty_resolution_emits_substrate,
  prop_compileToWasm_f64_function_produces_valid_wasm_binary,
  prop_compileToWasm_is_deterministic,
  prop_compileToWasm_numeric_function_produces_valid_wasm_magic,
  prop_compileToWasm_output_is_non_empty,
  prop_compileToWasm_returns_uint8array,
  prop_compileToWasm_starts_with_wasm_magic,
  prop_compileToWasm_starts_with_wasm_version,
  prop_wasmBackend_emit_delegates_to_compileToWasm,
  prop_wasmBackend_name_is_wasm,
} from "./wasm-backend.props.js";

// wasmBackend() name check: pure, no compilation needed — fast.
const pureOpts = { numRuns: 100 };

// compileToWasm() invokes ts-morph LoweringVisitor per call — expensive.
// numRuns: 5 per dispatch budget.
const morphOpts = { numRuns: 5 };

it("property: prop_wasmBackend_name_is_wasm", () => {
  fc.assert(prop_wasmBackend_name_is_wasm, pureOpts);
});

it("property: prop_wasmBackend_emit_delegates_to_compileToWasm", async () => {
  await fc.assert(prop_wasmBackend_emit_delegates_to_compileToWasm, morphOpts);
});

it("property: prop_compileToWasm_starts_with_wasm_magic", async () => {
  await fc.assert(prop_compileToWasm_starts_with_wasm_magic, morphOpts);
});

it("property: prop_compileToWasm_starts_with_wasm_version", async () => {
  await fc.assert(prop_compileToWasm_starts_with_wasm_version, morphOpts);
});

it("property: prop_compileToWasm_returns_uint8array", async () => {
  await fc.assert(prop_compileToWasm_returns_uint8array, morphOpts);
});

it("property: prop_compileToWasm_output_is_non_empty", async () => {
  await fc.assert(prop_compileToWasm_output_is_non_empty, morphOpts);
});

it("property: prop_compileToWasm_empty_resolution_emits_substrate", async () => {
  await fc.assert(prop_compileToWasm_empty_resolution_emits_substrate, morphOpts);
});

it("property: prop_compileToWasm_is_deterministic", async () => {
  await fc.assert(prop_compileToWasm_is_deterministic, morphOpts);
});

it("property: prop_compileToWasm_numeric_function_produces_valid_wasm_magic", async () => {
  await fc.assert(prop_compileToWasm_numeric_function_produces_valid_wasm_magic, morphOpts);
});

it("property: prop_compileToWasm_f64_function_produces_valid_wasm_binary", async () => {
  await fc.assert(prop_compileToWasm_f64_function_produces_valid_wasm_binary, morphOpts);
});

// Compound interaction: compileToWasm → instantiate → execute
it("property: prop_compileToWasm_add_substrate_executes_correctly", async () => {
  await fc.assert(prop_compileToWasm_add_substrate_executes_correctly, morphOpts);
});
