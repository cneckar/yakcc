// SPDX-License-Identifier: MIT
// Vitest harness for universalize/slicer.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./slicer.props.js";

describe("universalize/slicer.ts — property corpus", () => {
  // SL-KIND-1: every SlicePlanEntry.kind is one of the 4 canonical values
  it("property: slice — all entries have a valid SlicePlanEntry kind", async () => {
    await fc.assert(Props.prop_slice_entries_all_have_valid_kind);
  });

  // SL-BYTES-1: sourceBytesByKind.pointer is always non-negative
  it("property: slice — sourceBytesByKind.pointer is always non-negative", async () => {
    await fc.assert(Props.prop_slice_pointer_bytes_is_non_negative);
  });

  // SL-BYTES-2: sourceBytesByKind.novelGlue is always non-negative
  it("property: slice — sourceBytesByKind.novelGlue is always non-negative", async () => {
    await fc.assert(Props.prop_slice_novel_glue_bytes_is_non_negative);
  });

  // SL-BYTES-3: sourceBytesByKind.glue is always non-negative
  it("property: slice — sourceBytesByKind.glue is always non-negative", async () => {
    await fc.assert(Props.prop_slice_glue_bytes_is_non_negative);
  });

  // SL-MATCH-1: matchedPrimitives.length <= PointerEntry count
  it("property: slice — matchedPrimitives.length is <= PointerEntry count (deduplication)", async () => {
    await fc.assert(Props.prop_slice_matchedPrimitives_length_le_pointer_entry_count);
  });

  // SL-MODE-1: strict mode never emits GlueLeafEntry
  it("property: slice — strict mode never emits GlueLeafEntry", async () => {
    await fc.assert(Props.prop_slice_strict_mode_never_emits_glue_entries);
  });

  // SL-FOREIGN-1: non-import source returns empty array from classifyForeign
  it("property: classifyForeign — non-import source returns empty array", () => {
    fc.assert(Props.prop_classifyForeign_non_import_source_returns_empty);
  });

  // SL-FOREIGN-2: foreign named import returns ForeignLeafEntry with pkg + export
  it("property: classifyForeign — foreign named import returns entry with correct pkg and export", () => {
    fc.assert(Props.prop_classifyForeign_foreign_named_import_returns_entry);
  });

  // SL-FOREIGN-3: type-only import returns empty array
  it("property: classifyForeign — type-only import returns empty array", () => {
    fc.assert(Props.prop_classifyForeign_type_only_import_returns_empty);
  });

  // SL-FOREIGN-4: relative import returns empty array
  it("property: classifyForeign — relative import returns empty array", () => {
    fc.assert(Props.prop_classifyForeign_relative_import_returns_empty);
  });

  // SL-FOREIGN-5: workspace import returns empty array
  it("property: classifyForeign — workspace import (@yakcc/) returns empty array", () => {
    fc.assert(Props.prop_classifyForeign_workspace_import_returns_empty);
  });

  // Compound: decompose → slice end-to-end joint invariants
  it("property: compound — real tree: pointer + novel-glue joint invariants (DFS order, bytes, matchedPrimitives)", async () => {
    await fc.assert(Props.prop_compound_slice_real_tree_joint_invariants);
  });
});
