// SPDX-License-Identifier: MIT
// Vitest harness for universalize/types.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./types.props.js";

describe("universalize/types.ts — Path A property corpus", () => {
  // AtomTestOptions (ATO1.1)
  it("property: AtomTestOptions — maxControlFlowBoundaries is non-negative or undefined", () => {
    fc.assert(
      Props.prop_AtomTestOptions_maxControlFlowBoundaries_is_non_negative_or_undefined,
    );
  });

  // AtomTestReason (ATR1.1)
  it("property: AtomTestReason — is one of five literal values", () => {
    fc.assert(Props.prop_AtomTestReason_is_one_of_five_literals);
  });

  // AtomTestResult (ATR1.2)
  it("property: AtomTestResult — isAtom is a boolean", () => {
    fc.assert(Props.prop_AtomTestResult_isAtom_is_boolean);
  });

  it("property: AtomTestResult — reason is a valid AtomTestReason", () => {
    fc.assert(Props.prop_AtomTestResult_reason_is_valid_AtomTestReason);
  });

  it("property: AtomTestResult — controlFlowBoundaryCount is non-negative", () => {
    fc.assert(Props.prop_AtomTestResult_controlFlowBoundaryCount_is_non_negative);
  });

  // AtomLeaf (AL1.1)
  it("property: AtomLeaf — kind is 'atom'", () => {
    fc.assert(Props.prop_AtomLeaf_kind_is_atom);
  });

  it("property: AtomLeaf — sourceRange start <= end", () => {
    fc.assert(Props.prop_AtomLeaf_sourceRange_start_le_end);
  });

  it("property: AtomLeaf — canonicalAstHash is 64-char lowercase hex", () => {
    fc.assert(Props.prop_AtomLeaf_canonicalAstHash_is_64_char_hex);
  });

  // BranchNode (BN1.1)
  it("property: BranchNode — kind is 'branch'", () => {
    fc.assert(Props.prop_BranchNode_kind_is_branch);
  });

  it("property: BranchNode — children is a non-empty array", () => {
    fc.assert(Props.prop_BranchNode_children_is_non_empty_array);
  });

  // RecursionNode (RN1.1)
  it("property: RecursionNode — kind is 'atom' or 'branch'", () => {
    fc.assert(Props.prop_RecursionNode_kind_is_atom_or_branch);
  });

  // RecursionTree (RT1.1)
  it("property: RecursionTree — leafCount is non-negative", () => {
    fc.assert(Props.prop_RecursionTree_leafCount_is_non_negative);
  });

  it("property: RecursionTree — maxDepth is non-negative", () => {
    fc.assert(Props.prop_RecursionTree_maxDepth_is_non_negative);
  });

  it("property: RecursionTree — root has valid kind", () => {
    fc.assert(Props.prop_RecursionTree_root_has_valid_kind);
  });

  // RecursionOptions (RO1.1)
  it("property: RecursionOptions — maxDepth is positive or undefined", () => {
    fc.assert(Props.prop_RecursionOptions_maxDepth_is_positive_or_undefined);
  });

  // PointerEntry (PE1.1)
  it("property: PointerEntry — kind is 'pointer'", () => {
    fc.assert(Props.prop_PointerEntry_kind_is_pointer);
  });

  it("property: PointerEntry — matchedBy is 'canonical_ast_hash'", () => {
    fc.assert(Props.prop_PointerEntry_matchedBy_is_canonical_ast_hash);
  });

  it("property: PointerEntry — merkleRoot is 64-char lowercase hex", () => {
    fc.assert(Props.prop_PointerEntry_merkleRoot_is_64_char_hex);
  });

  // NovelGlueEntry (NG1.1)
  it("property: NovelGlueEntry — kind is 'novel-glue'", () => {
    fc.assert(Props.prop_NovelGlueEntry_kind_is_novel_glue);
  });

  it("property: NovelGlueEntry — source is a non-empty string", () => {
    fc.assert(Props.prop_NovelGlueEntry_source_is_non_empty_string);
  });

  // ForeignLeafEntry (FL1.1)
  it("property: ForeignLeafEntry — kind is 'foreign-leaf'", () => {
    fc.assert(Props.prop_ForeignLeafEntry_kind_is_foreign_leaf);
  });

  it("property: ForeignLeafEntry — pkg and export are non-empty strings", () => {
    fc.assert(Props.prop_ForeignLeafEntry_pkg_and_export_are_non_empty_strings);
  });

  // GlueLeafEntry (GL1.1)
  it("property: GlueLeafEntry — kind is 'glue'", () => {
    fc.assert(Props.prop_GlueLeafEntry_kind_is_glue);
  });

  it("property: GlueLeafEntry — reason is a non-empty string", () => {
    fc.assert(Props.prop_GlueLeafEntry_reason_is_non_empty_string);
  });

  // SlicePlanEntry (SP1.1)
  it("property: SlicePlanEntry — kind is one of four variants", () => {
    fc.assert(Props.prop_SlicePlanEntry_kind_is_one_of_four_variants);
  });

  // SlicePlan (SP1.2)
  it("property: SlicePlan — sourceBytesByKind values are non-negative", () => {
    fc.assert(Props.prop_SlicePlan_sourceBytesByKind_are_non_negative);
  });

  it("property: SlicePlan — matchedPrimitives is a subset of pointer entries", () => {
    fc.assert(Props.prop_SlicePlan_matchedPrimitives_is_subset_of_pointer_entries);
  });

  // Compound interaction (AL1.1 + RT1.1)
  it("property: compound — AtomLeaf as root produces leafCount=1 and maxDepth=0", () => {
    fc.assert(
      Props.prop_compound_AtomLeaf_as_root_produces_leafCount_1_and_maxDepth_0,
    );
  });
});
