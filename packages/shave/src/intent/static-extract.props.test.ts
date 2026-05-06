// SPDX-License-Identifier: MIT
// Vitest harness for static-extract.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./static-extract.props.js";

describe("static-extract.ts — Path A property corpus", () => {
  // -------------------------------------------------------------------------
  // EX1 — schemaVersion === 1 always
  // -------------------------------------------------------------------------
  it("property: EX1 — schemaVersion is always 1", () => {
    fc.assert(Props.prop_extract_schemaVersion_always_1, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX2 + EX67 + EX68 — envelope fields spread verbatim; extractedAt round-trips
  // -------------------------------------------------------------------------
  it("property: EX2/EX67/EX68 — envelope fields spread verbatim into returned card", () => {
    fc.assert(Props.prop_extract_envelope_fields_spread_verbatim, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX3 + EX66 — no-declaration behavior = fragment string; buildFragmentFallback deterministic
  // -------------------------------------------------------------------------
  it("property: EX3/EX66 — no-declaration source produces fragment behavior string", () => {
    fc.assert(Props.prop_extract_no_declaration_behavior_is_fragment, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX4 — no-declaration: all arrays empty
  // -------------------------------------------------------------------------
  it("property: EX4 — no-declaration source has all empty arrays", () => {
    fc.assert(Props.prop_extract_no_declaration_arrays_all_empty, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX5 + EX65 — JSDoc summary is behavior; beats signatureString and fragment
  // -------------------------------------------------------------------------
  it("property: EX5/EX65 — JSDoc summary is behavior when present (highest priority)", () => {
    fc.assert(Props.prop_extract_jsdoc_summary_is_behavior, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX6 — signatureString is behavior fallback when no JSDoc summary
  // -------------------------------------------------------------------------
  it("property: EX6 — signatureString is behavior fallback when no JSDoc summary", () => {
    fc.assert(Props.prop_extract_signature_string_is_behavior_fallback, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX7 — empty source → fragment fallback behavior
  // -------------------------------------------------------------------------
  it("property: EX7 — empty source produces fragment fallback behavior", () => {
    fc.assert(Props.prop_extract_fragment_fallback_empty_source, { numRuns: 20 });
  });

  // -------------------------------------------------------------------------
  // EX8 + EX21 + EX22 + EX26 + EX70 — inputs: one entry per param
  // -------------------------------------------------------------------------
  it("property: EX8/EX21/EX22/EX26/EX70 — inputs has one entry per parameter with name and typeHint", () => {
    fc.assert(Props.prop_extract_inputs_one_per_param_with_name_and_typehint, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX9 + EX28 + EX70 — outputs: always one "return" entry
  // -------------------------------------------------------------------------
  it("property: EX9/EX28/EX70 — outputs always has exactly one 'return' entry", () => {
    fc.assert(Props.prop_extract_outputs_always_one_return_entry, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX29 — void/never return type collapses to "void"
  // -------------------------------------------------------------------------
  it("property: EX29 — void and never return types collapse to 'void' in outputs typeHint", () => {
    fc.assert(Props.prop_extract_return_type_void_never_collapse, { numRuns: 30 });
  });

  // -------------------------------------------------------------------------
  // EX30 — "unknown" when no return-type annotation
  // -------------------------------------------------------------------------
  it("property: EX30 — 'unknown' typeHint when no return-type annotation", () => {
    fc.assert(Props.prop_extract_return_type_unknown_when_unannotated, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX27 — "unknown" typeHint when no param type annotation
  // -------------------------------------------------------------------------
  it("property: EX27 — 'unknown' typeHint when parameter has no type annotation", () => {
    fc.assert(Props.prop_extract_param_typehint_unknown_when_unannotated, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX10 + EX47 + EX48 — @requires → preconditions, @ensures → postconditions
  // -------------------------------------------------------------------------
  it("property: EX10/EX47/EX48 — @requires and @ensures map to preconditions and postconditions", () => {
    fc.assert(Props.prop_extract_requires_ensures_mapped_in_order, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX46 — @returns sets output description
  // -------------------------------------------------------------------------
  it("property: EX46 — @returns tag sets outputs[0].description", () => {
    fc.assert(Props.prop_extract_returns_tag_sets_output_description, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX45 — @param sets input description; first occurrence wins
  // -------------------------------------------------------------------------
  it("property: EX45 — @param tag sets inputs description; first occurrence wins", () => {
    fc.assert(Props.prop_extract_param_tag_sets_input_description, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX49 — @throws → notes "throws: <body>"
  // -------------------------------------------------------------------------
  it("property: EX49 — @throws tag maps to 'throws: <body>' in notes", () => {
    fc.assert(Props.prop_extract_throws_tag_maps_to_notes, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX50 — @remarks → notes "remarks: <body>"
  // -------------------------------------------------------------------------
  it("property: EX50 — @remarks tag maps to 'remarks: <body>' in notes", () => {
    fc.assert(Props.prop_extract_remarks_tag_maps_to_notes, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX51 — @example → notes "example: <body>"
  // -------------------------------------------------------------------------
  it("property: EX51 — @example tag maps to 'example: <body>' in notes", () => {
    fc.assert(Props.prop_extract_example_tag_maps_to_notes, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX52 — @note → notes raw collapsed body
  // -------------------------------------------------------------------------
  it("property: EX52 — @note tag maps to raw collapsed body in notes", () => {
    fc.assert(Props.prop_extract_note_tag_maps_raw_to_notes, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX53 — unknown tag names silently skipped
  // -------------------------------------------------------------------------
  it("property: EX53 — unknown JSDoc tag names are silently skipped", () => {
    fc.assert(Props.prop_extract_unknown_tags_silently_skipped, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX54 + EX57 — tag bodies whitespace-collapsed; collapseWhitespace
  // -------------------------------------------------------------------------
  it("property: EX54/EX57 — tag bodies are whitespace-collapsed before storage", () => {
    fc.assert(Props.prop_extract_tag_body_whitespace_collapsed, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX11 + EX34 — FunctionDeclaration → "function <name>(...) -> <ret>"
  // -------------------------------------------------------------------------
  it("property: EX11/EX34 — FunctionDeclaration produces 'function <name>(<params>) -> <ret>' sig", () => {
    fc.assert(Props.prop_extract_function_declaration_sig_string, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX12 + EX17 + EX36 — arrow const → "arrow const <name>(...) -> <ret>"
  // -------------------------------------------------------------------------
  it("property: EX12/EX17/EX36 — arrow-const VariableStatement produces 'arrow const <name>...' sig", () => {
    fc.assert(Props.prop_extract_arrow_const_sig_string, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX13 + EX19 — VariableStatement with non-function init → fragment fallback
  // -------------------------------------------------------------------------
  it("property: EX13/EX19 — non-function const VariableStatement falls through to fragment fallback", () => {
    fc.assert(Props.prop_extract_non_function_const_has_empty_sig, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX14 + EX31 + EX33 — MethodDeclaration → extractFromMethod path
  // -------------------------------------------------------------------------
  it("property: EX14/EX31/EX33 — MethodDeclaration produces 'method <name>(<params>) -> <ret>' sig", () => {
    fc.assert(Props.prop_extract_method_declaration_sig_string, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX35 — unnamed FunctionDeclaration uses "anonymous"
  // -------------------------------------------------------------------------
  it("property: EX35 — unnamed export default function uses 'anonymous' in sig", () => {
    fc.assert(Props.prop_extract_unnamed_function_declaration_uses_anonymous, { numRuns: 20 });
  });

  // -------------------------------------------------------------------------
  // EX37 + EX16 — FunctionExpression const → "function const <name>..."
  // -------------------------------------------------------------------------
  it("property: EX37/EX16 — FunctionExpression const produces 'function const <name>...' sig", () => {
    fc.assert(Props.prop_extract_function_expr_const_sig_string, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX40 — bare ArrowFunction → "arrow(<p>) -> <ret>"
  // -------------------------------------------------------------------------
  it("property: EX40 — bare export default arrow function produces 'arrow(...) -> ...' sig", () => {
    fc.assert(Props.prop_extract_bare_arrow_function_sig_string, { numRuns: 20 });
  });

  // -------------------------------------------------------------------------
  // EX43 — first JSDoc summary wins; subsequent JSDocs do not overwrite
  // -------------------------------------------------------------------------
  it("property: EX43 — first JSDoc description sets summary; subsequent do not overwrite", () => {
    fc.assert(Props.prop_extract_first_jsdoc_summary_wins, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX44 + EX60 — summary truncated to 197+... when > 200 chars
  // -------------------------------------------------------------------------
  it("property: EX44/EX60 — JSDoc summary truncated to 197+... when exceeds 200 chars", () => {
    fc.assert(Props.prop_extract_summary_truncated_past_200_chars, { numRuns: 20 });
  });

  // -------------------------------------------------------------------------
  // EX58 — extractFirstSentence: first .!? followed by whitespace or EOS
  // -------------------------------------------------------------------------
  it("property: EX58 — extractFirstSentence returns text up to first sentence terminator", () => {
    fc.assert(Props.prop_extract_summary_first_sentence_extraction, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX59 — extractFirstSentence: full string when no terminator
  // -------------------------------------------------------------------------
  it("property: EX59 — extractFirstSentence returns full collapsed string when no terminator", () => {
    fc.assert(Props.prop_extract_summary_no_terminator_returns_full, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX61 + EX57 — extractFirstSentence collapses whitespace before length check
  // -------------------------------------------------------------------------
  it("property: EX61/EX57 — summary whitespace is collapsed before storage", () => {
    fc.assert(Props.prop_extract_summary_whitespace_collapsed_before_length_check, {
      numRuns: 50,
    });
  });

  // -------------------------------------------------------------------------
  // EX24 + EX55 — rest param name prefixed with "..."; parseParamTag strips "..."
  // -------------------------------------------------------------------------
  it("property: EX24/EX55 — rest parameter name prefixed with '...' in inputs", () => {
    fc.assert(Props.prop_extract_rest_param_name_prefixed_with_ellipsis, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX56 — parseParamTag strips param-name prefix from comment body
  // -------------------------------------------------------------------------
  it("property: EX56 — @param tag body has param-name prefix stripped", () => {
    fc.assert(Props.prop_extract_param_tag_body_strips_param_name_prefix, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX23 — ObjectBindingPattern / ArrayBindingPattern → full pattern text
  // -------------------------------------------------------------------------
  it("property: EX23 — destructured parameter name is the full pattern text", () => {
    fc.assert(Props.prop_extract_destructured_param_name_is_full_pattern, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX64 — escapeRegex via param-name lookup production path
  // -------------------------------------------------------------------------
  it("property: EX64 — escapeRegex used in param name stripping works correctly", () => {
    fc.assert(Props.prop_extract_escape_regex_in_param_name_lookup, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX42 — extractJsDocFromNode: empty shape when no JSDoc
  // -------------------------------------------------------------------------
  it("property: EX42 — no JSDoc gives empty jsdoc info shape (empty arrays, empty description)", () => {
    fc.assert(Props.prop_extract_no_jsdoc_node_gives_empty_jsdoc_info, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX71 — no IO side effects
  // -------------------------------------------------------------------------
  it("property: EX71 — staticExtract has no IO side effects (returns synchronously)", () => {
    fc.assert(Props.prop_extract_no_io_side_effects, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX72 — determinism: same inputs → same output
  // -------------------------------------------------------------------------
  it("property: EX72 — staticExtract is deterministic for same inputs", () => {
    fc.assert(Props.prop_extract_determinism_same_inputs_same_output, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX69 — return type is unknown-shaped object
  // -------------------------------------------------------------------------
  it("property: EX69 — staticExtract returns a plain object (unknown-typed at call site)", () => {
    fc.assert(Props.prop_extract_return_type_is_unknown_shape, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // EX16 — resolveFunctionNode: FunctionDeclaration returned unchanged (params count)
  // -------------------------------------------------------------------------
  it("property: EX16 — FunctionDeclaration param count maps to inputs length", () => {
    fc.assert(Props.prop_extract_function_declaration_params_count, { numRuns: 50 });
  });

  // -------------------------------------------------------------------------
  // Compound interaction: full production sequence end-to-end
  // -------------------------------------------------------------------------
  it("property: compound — full production sequence with JSDoc, params, envelope spread", () => {
    fc.assert(Props.prop_extract_compound_full_production_sequence, { numRuns: 30 });
  });
});
