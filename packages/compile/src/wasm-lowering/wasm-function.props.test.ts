// SPDX-License-Identifier: MIT
// Vitest harness for wasm-function.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling wasm-function.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_numericDomain_values_are_valid_strings,
  prop_valtypeByte_f64_is_0x7c,
  prop_valtypeByte_i32_is_0x7f,
  prop_valtypeByte_i64_is_0x7e,
  prop_valtypeByte_injective,
  prop_valtypeByte_result_in_valid_range,
  prop_wasmFunction_body_bytes_in_range,
  prop_wasmFunction_locals_count_positive,
  prop_wasmFunction_locals_type_valid_domain,
  prop_wasmFunction_valtypeByte_round_trips_locals,
} from "./wasm-function.props.js";

// valtypeByte and WasmFunction/LocalDecl are pure data-structure checks — no
// ts-morph or IO. numRuns: 100 (fast).
const opts = { numRuns: 100 };

it("property: prop_valtypeByte_i32_is_0x7f", () => {
  fc.assert(prop_valtypeByte_i32_is_0x7f, opts);
});

it("property: prop_valtypeByte_i64_is_0x7e", () => {
  fc.assert(prop_valtypeByte_i64_is_0x7e, opts);
});

it("property: prop_valtypeByte_f64_is_0x7c", () => {
  fc.assert(prop_valtypeByte_f64_is_0x7c, opts);
});

it("property: prop_valtypeByte_result_in_valid_range", () => {
  fc.assert(prop_valtypeByte_result_in_valid_range, opts);
});

it("property: prop_valtypeByte_injective", () => {
  fc.assert(prop_valtypeByte_injective, opts);
});

it("property: prop_numericDomain_values_are_valid_strings", () => {
  fc.assert(prop_numericDomain_values_are_valid_strings, opts);
});

it("property: prop_wasmFunction_body_bytes_in_range", () => {
  fc.assert(prop_wasmFunction_body_bytes_in_range, opts);
});

it("property: prop_wasmFunction_locals_count_positive", () => {
  fc.assert(prop_wasmFunction_locals_count_positive, opts);
});

it("property: prop_wasmFunction_locals_type_valid_domain", () => {
  fc.assert(prop_wasmFunction_locals_type_valid_domain, opts);
});

it("property: prop_wasmFunction_valtypeByte_round_trips_locals", () => {
  fc.assert(prop_wasmFunction_valtypeByte_round_trips_locals, opts);
});
