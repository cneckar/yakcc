// SPDX-License-Identifier: MIT
// Vitest harness for symbol-table.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling symbol-table.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_defineCapture_name_preserved,
  prop_defineCapture_returns_captured_slot,
  prop_defineLocal_domain_preserved,
  prop_defineLocal_index_continues_after_params,
  prop_defineLocal_returns_local_slot,
  prop_defineParam_domain_preserved,
  prop_defineParam_indexes_are_sequential,
  prop_defineParam_returns_param_slot,
  prop_define_throws_without_frame,
  prop_depth_decrements_on_pop,
  prop_depth_increments_on_push,
  prop_depth_starts_at_zero,
  prop_lookup_finds_defined_symbol,
  prop_lookup_inner_shadows_outer,
  prop_lookup_returns_undefined_for_missing,
  prop_popFrame_throws_on_empty_stack,
  prop_slot_counter_not_reset_on_block_pop,
  prop_slot_counter_resets_on_function_boundary,
} from "./symbol-table.props.js";

// SymbolTable is a pure in-memory data structure — no IO, no ts-morph.
// numRuns: 100 (fast).
const opts = { numRuns: 100 };

// ST1.1 — pushFrame / popFrame: depth tracking
it("property: prop_depth_starts_at_zero", () => {
  fc.assert(prop_depth_starts_at_zero, opts);
});

it("property: prop_depth_increments_on_push", () => {
  fc.assert(prop_depth_increments_on_push, opts);
});

it("property: prop_depth_decrements_on_pop", () => {
  fc.assert(prop_depth_decrements_on_pop, opts);
});

it("property: prop_popFrame_throws_on_empty_stack", () => {
  fc.assert(prop_popFrame_throws_on_empty_stack, opts);
});

// ST1.2 — defineParam
it("property: prop_defineParam_returns_param_slot", () => {
  fc.assert(prop_defineParam_returns_param_slot, opts);
});

it("property: prop_defineParam_indexes_are_sequential", () => {
  fc.assert(prop_defineParam_indexes_are_sequential, opts);
});

it("property: prop_defineParam_domain_preserved", () => {
  fc.assert(prop_defineParam_domain_preserved, opts);
});

// ST1.3 — defineLocal
it("property: prop_defineLocal_returns_local_slot", () => {
  fc.assert(prop_defineLocal_returns_local_slot, opts);
});

it("property: prop_defineLocal_index_continues_after_params", () => {
  fc.assert(prop_defineLocal_index_continues_after_params, opts);
});

it("property: prop_defineLocal_domain_preserved", () => {
  fc.assert(prop_defineLocal_domain_preserved, opts);
});

// ST1.4 — defineCapture
it("property: prop_defineCapture_returns_captured_slot", () => {
  fc.assert(prop_defineCapture_returns_captured_slot, opts);
});

it("property: prop_defineCapture_name_preserved", () => {
  fc.assert(prop_defineCapture_name_preserved, opts);
});

// ST1.5 — lookup
it("property: prop_lookup_finds_defined_symbol", () => {
  fc.assert(prop_lookup_finds_defined_symbol, opts);
});

it("property: prop_lookup_returns_undefined_for_missing", () => {
  fc.assert(prop_lookup_returns_undefined_for_missing, opts);
});

it("property: prop_lookup_inner_shadows_outer", () => {
  fc.assert(prop_lookup_inner_shadows_outer, opts);
});

// ST1.6 — slot counter behaviour
it("property: prop_slot_counter_resets_on_function_boundary", () => {
  fc.assert(prop_slot_counter_resets_on_function_boundary, opts);
});

it("property: prop_slot_counter_not_reset_on_block_pop", () => {
  fc.assert(prop_slot_counter_not_reset_on_block_pop, opts);
});

// ST1.7 — error paths
it("property: prop_define_throws_without_frame", () => {
  fc.assert(prop_define_throws_without_frame, opts);
});
