// SPDX-License-Identifier: MIT
// Vitest harness for ts-backend.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling ts-backend.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_assembleModule_deduplicates_contracts_imports,
  prop_assembleModule_includes_header_comment,
  prop_assembleModule_re_exports_entry_function,
  prop_cleanBlockSource_preserves_non_matching_lines,
  prop_cleanBlockSource_strips_CONTRACT_export_single_line,
  prop_cleanBlockSource_strips_contracts_imports,
  prop_cleanBlockSource_strips_dot_slash_imports,
  prop_cleanBlockSource_strips_seeds_imports,
  prop_cleanBlockSource_strips_shadow_type_aliases,
  prop_extractEntryFunctionName_finds_export_function,
  prop_extractEntryFunctionName_returns_null_for_no_export,
  prop_tsBackend_emit_deterministic,
  prop_tsBackend_emit_returns_string,
  prop_tsBackend_name_is_ts,
} from "./ts-backend.props.js";

// ts-backend uses pure string processing — no disk IO, no ts-morph.
// numRuns: 100 gives thorough coverage at low cost.
const opts = { numRuns: 100 };

it("property: prop_cleanBlockSource_strips_dot_slash_imports", () => {
  fc.assert(prop_cleanBlockSource_strips_dot_slash_imports, opts);
});

it("property: prop_cleanBlockSource_strips_seeds_imports", () => {
  fc.assert(prop_cleanBlockSource_strips_seeds_imports, opts);
});

it("property: prop_cleanBlockSource_strips_shadow_type_aliases", () => {
  fc.assert(prop_cleanBlockSource_strips_shadow_type_aliases, opts);
});

it("property: prop_cleanBlockSource_strips_contracts_imports", () => {
  fc.assert(prop_cleanBlockSource_strips_contracts_imports, opts);
});

it("property: prop_cleanBlockSource_strips_CONTRACT_export_single_line", () => {
  fc.assert(prop_cleanBlockSource_strips_CONTRACT_export_single_line, opts);
});

it("property: prop_cleanBlockSource_preserves_non_matching_lines", () => {
  fc.assert(prop_cleanBlockSource_preserves_non_matching_lines, opts);
});

it("property: prop_extractEntryFunctionName_finds_export_function", () => {
  fc.assert(prop_extractEntryFunctionName_finds_export_function, opts);
});

it("property: prop_extractEntryFunctionName_returns_null_for_no_export", () => {
  fc.assert(prop_extractEntryFunctionName_returns_null_for_no_export, opts);
});

it("property: prop_assembleModule_includes_header_comment", () => {
  fc.assert(prop_assembleModule_includes_header_comment, opts);
});

it("property: prop_assembleModule_deduplicates_contracts_imports", () => {
  fc.assert(prop_assembleModule_deduplicates_contracts_imports, opts);
});

it("property: prop_assembleModule_re_exports_entry_function", () => {
  fc.assert(prop_assembleModule_re_exports_entry_function, opts);
});

it("property: prop_tsBackend_name_is_ts", () => {
  fc.assert(prop_tsBackend_name_is_ts, opts);
});

it("property: prop_tsBackend_emit_returns_string", async () => {
  await fc.assert(prop_tsBackend_emit_returns_string, opts);
});

it("property: prop_tsBackend_emit_deterministic", async () => {
  await fc.assert(prop_tsBackend_emit_deterministic, opts);
});
