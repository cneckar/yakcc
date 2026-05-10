// SPDX-License-Identifier: MIT
// Vitest harness for visitor.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling visitor.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_LoweringError_is_Error_subclass,
  prop_LoweringError_kind_preserved,
  prop_LoweringError_message_preserved,
  prop_LoweringError_name_is_LoweringError,
  prop_detectArrayShape_array_param_sets_arrayShape,
  prop_detectArrayShape_non_array_returns_null_arrayShape,
  prop_lowerModule_funcIndexTable_has_all_functions,
  prop_lowerModule_missing_export_throws_LoweringError,
  prop_lowerModule_single_export_matches_lower,
  prop_lower_bigint_domain_infers_i64,
  prop_lower_bitop_domain_forces_i32,
  prop_lower_f64_domain_division_uses_f64_opcodes,
  prop_lower_f64_domain_float_literal_infers_f64,
  prop_lower_missing_export_throws_LoweringError,
  prop_lower_result_has_fnName,
  prop_lower_string_concat_sets_stringShape,
  prop_lower_string_length_fn_produces_str_length_shape,
  prop_lower_string_length_sets_stringShape,
  prop_lower_sum_record_wave2_fast_path,
  prop_lower_switch_numeric_succeeds,
  prop_lower_warnings_is_array,
  prop_lower_wave2_add_returns_wasmFn_with_i32_add_opcode,
  prop_lower_wave2_shape_null_for_general_lowering,
} from "./visitor.props.js";

// LoweringVisitor.lower() and lowerModule() invoke ts-morph per call — expensive.
// numRuns: 5 per dispatch budget for ts-morph-backed atoms.
// LoweringError tests are pure (no ts-morph); they can use 100 runs.
const pureOpts = { numRuns: 100 };
const morphOpts = { numRuns: 5 };

// Pure: LoweringError construction
it("property: prop_LoweringError_is_Error_subclass", () => {
  fc.assert(prop_LoweringError_is_Error_subclass, pureOpts);
});

it("property: prop_LoweringError_name_is_LoweringError", () => {
  fc.assert(prop_LoweringError_name_is_LoweringError, pureOpts);
});

it("property: prop_LoweringError_kind_preserved", () => {
  fc.assert(prop_LoweringError_kind_preserved, pureOpts);
});

it("property: prop_LoweringError_message_preserved", () => {
  fc.assert(prop_LoweringError_message_preserved, pureOpts);
});

// ts-morph backed: lower()
it("property: prop_lower_wave2_add_returns_wasmFn_with_i32_add_opcode", () => {
  fc.assert(prop_lower_wave2_add_returns_wasmFn_with_i32_add_opcode, morphOpts);
});

it("property: prop_lower_result_has_fnName", () => {
  fc.assert(prop_lower_result_has_fnName, morphOpts);
});

it("property: prop_lower_missing_export_throws_LoweringError", () => {
  fc.assert(prop_lower_missing_export_throws_LoweringError, morphOpts);
});

it("property: prop_lower_string_length_fn_produces_str_length_shape", () => {
  fc.assert(prop_lower_string_length_fn_produces_str_length_shape, morphOpts);
});

it("property: prop_lower_warnings_is_array", () => {
  fc.assert(prop_lower_warnings_is_array, morphOpts);
});

it("property: prop_lower_f64_domain_division_uses_f64_opcodes", () => {
  fc.assert(prop_lower_f64_domain_division_uses_f64_opcodes, morphOpts);
});

it("property: prop_lower_f64_domain_float_literal_infers_f64", () => {
  fc.assert(prop_lower_f64_domain_float_literal_infers_f64, morphOpts);
});

it("property: prop_lower_bitop_domain_forces_i32", () => {
  fc.assert(prop_lower_bitop_domain_forces_i32, morphOpts);
});

it("property: prop_lower_bigint_domain_infers_i64", () => {
  fc.assert(prop_lower_bigint_domain_infers_i64, morphOpts);
});

it("property: prop_lower_switch_numeric_succeeds", () => {
  fc.assert(prop_lower_switch_numeric_succeeds, morphOpts);
});

it("property: prop_lower_sum_record_wave2_fast_path", () => {
  fc.assert(prop_lower_sum_record_wave2_fast_path, morphOpts);
});

it("property: prop_lower_wave2_shape_null_for_general_lowering", () => {
  fc.assert(prop_lower_wave2_shape_null_for_general_lowering, morphOpts);
});

it("property: prop_lower_string_length_sets_stringShape", () => {
  fc.assert(prop_lower_string_length_sets_stringShape, morphOpts);
});

it("property: prop_lower_string_concat_sets_stringShape", () => {
  fc.assert(prop_lower_string_concat_sets_stringShape, morphOpts);
});

// lowerModule()
it("property: prop_lowerModule_single_export_matches_lower", () => {
  fc.assert(prop_lowerModule_single_export_matches_lower, morphOpts);
});

it("property: prop_lowerModule_missing_export_throws_LoweringError", () => {
  fc.assert(prop_lowerModule_missing_export_throws_LoweringError, morphOpts);
});

it("property: prop_lowerModule_funcIndexTable_has_all_functions", () => {
  fc.assert(prop_lowerModule_funcIndexTable_has_all_functions, morphOpts);
});

// detectArrayShape (exported)
it("property: prop_detectArrayShape_non_array_returns_null_arrayShape", () => {
  fc.assert(prop_detectArrayShape_non_array_returns_null_arrayShape, morphOpts);
});

it("property: prop_detectArrayShape_array_param_sets_arrayShape", () => {
  fc.assert(prop_detectArrayShape_array_param_sets_arrayShape, morphOpts);
});
