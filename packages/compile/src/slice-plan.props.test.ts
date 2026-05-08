// SPDX-License-Identifier: MIT
// Vitest harness for slice-plan.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling slice-plan.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_assert_passes_on_glue_free_plan,
  prop_assert_throws_on_first_glue_entry,
  prop_error_canonicalAstHash_preserved,
  prop_error_glueReason_preserved,
  prop_error_message_contains_hash_prefix,
  prop_error_message_contains_reason,
  prop_error_message_names_compileToTypeScript,
  prop_error_name_is_GlueLeafInWasmModeError,
  prop_ts_empty_plan_contains_only_header,
  prop_ts_foreign_leaf_entry_not_inlined,
  prop_ts_glue_entry_emits_source_between_markers,
  prop_ts_glue_entry_markers_contain_hash_prefix,
  prop_ts_novel_glue_entry_emits_hash_prefix,
  prop_ts_novel_glue_entry_emits_source,
  prop_ts_output_contains_header_comment,
  prop_ts_output_ends_with_newline,
  prop_ts_pointer_entry_emits_hash_prefix,
  prop_ts_pointer_entry_emits_merkle_root,
} from "./slice-plan.props.js";

// slice-plan.ts is pure in-memory logic — no IO, no ts-morph.
// numRuns: 100 (fast).
const opts = { numRuns: 100 };

// SP1.1 — GlueLeafInWasmModeError construction and field contract
it("property: prop_error_name_is_GlueLeafInWasmModeError", () => {
  fc.assert(prop_error_name_is_GlueLeafInWasmModeError, opts);
});

it("property: prop_error_message_contains_hash_prefix", () => {
  fc.assert(prop_error_message_contains_hash_prefix, opts);
});

it("property: prop_error_message_contains_reason", () => {
  fc.assert(prop_error_message_contains_reason, opts);
});

it("property: prop_error_message_names_compileToTypeScript", () => {
  fc.assert(prop_error_message_names_compileToTypeScript, opts);
});

it("property: prop_error_canonicalAstHash_preserved", () => {
  fc.assert(prop_error_canonicalAstHash_preserved, opts);
});

it("property: prop_error_glueReason_preserved", () => {
  fc.assert(prop_error_glueReason_preserved, opts);
});

// SP1.2 — compileToTypeScript emit rules
it("property: prop_ts_output_ends_with_newline", () => {
  fc.assert(prop_ts_output_ends_with_newline, opts);
});

it("property: prop_ts_output_contains_header_comment", () => {
  fc.assert(prop_ts_output_contains_header_comment, opts);
});

it("property: prop_ts_pointer_entry_emits_merkle_root", () => {
  fc.assert(prop_ts_pointer_entry_emits_merkle_root, opts);
});

it("property: prop_ts_pointer_entry_emits_hash_prefix", () => {
  fc.assert(prop_ts_pointer_entry_emits_hash_prefix, opts);
});

it("property: prop_ts_novel_glue_entry_emits_source", () => {
  fc.assert(prop_ts_novel_glue_entry_emits_source, opts);
});

it("property: prop_ts_novel_glue_entry_emits_hash_prefix", () => {
  fc.assert(prop_ts_novel_glue_entry_emits_hash_prefix, opts);
});

it("property: prop_ts_glue_entry_emits_source_between_markers", () => {
  fc.assert(prop_ts_glue_entry_emits_source_between_markers, opts);
});

it("property: prop_ts_glue_entry_markers_contain_hash_prefix", () => {
  fc.assert(prop_ts_glue_entry_markers_contain_hash_prefix, opts);
});

it("property: prop_ts_foreign_leaf_entry_not_inlined", () => {
  fc.assert(prop_ts_foreign_leaf_entry_not_inlined, opts);
});

it("property: prop_ts_empty_plan_contains_only_header", () => {
  fc.assert(prop_ts_empty_plan_contains_only_header, opts);
});

// SP1.3 — assertNoGlueLeaf validation
it("property: prop_assert_passes_on_glue_free_plan", () => {
  fc.assert(prop_assert_passes_on_glue_free_plan, opts);
});

it("property: prop_assert_throws_on_first_glue_entry", () => {
  fc.assert(prop_assert_throws_on_first_glue_entry, opts);
});
