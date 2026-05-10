// SPDX-License-Identifier: MIT
// Vitest harness for universalize/recursion.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./recursion.props.js";

describe("universalize/recursion.ts — property corpus", () => {
  // DEC-REC-P1: leafCount is always a positive integer
  it("property: decompose — leafCount is a positive integer for any non-throwing call", async () => {
    await fc.assert(Props.prop_decompose_leafCount_is_positive_integer);
  });

  // DEC-REC-P2: maxDepth is always a non-negative integer
  it("property: decompose — maxDepth is a non-negative integer", async () => {
    await fc.assert(Props.prop_decompose_maxDepth_is_non_negative);
  });

  // DEC-REC-P3: root.kind is "atom" or "branch"
  it("property: decompose — root.kind is always atom or branch", async () => {
    await fc.assert(Props.prop_decompose_root_kind_is_atom_or_branch);
  });

  // DEC-REC-P4: atom root implies leafCount=1 and maxDepth=0
  it("property: decompose — atom root implies leafCount=1 and maxDepth=0", async () => {
    await fc.assert(Props.prop_decompose_atom_root_implies_leafCount_1_maxDepth_0);
  });

  // DEC-REC-P5: root.canonicalAstHash is a 64-char lowercase hex string
  it("property: decompose — root.canonicalAstHash is a 64-char lowercase hex string", async () => {
    await fc.assert(Props.prop_decompose_root_canonicalAstHash_is_64_char_hex);
  });

  // DEC-REC-P6: RecursionDepthExceededError.depth > .maxDepth
  it("property: RecursionDepthExceededError — depth strictly exceeds maxDepth", async () => {
    await fc.assert(Props.prop_RecursionDepthExceededError_depth_exceeds_maxDepth);
  });

  // DEC-REC-P7: DidNotReachAtomError.node.range is a valid positive-width interval
  it("property: DidNotReachAtomError — node.range has start < end (valid interval)", async () => {
    await fc.assert(Props.prop_DidNotReachAtomError_node_range_is_valid);
  });

  // DEC-REC-P8: empty registry + 0-CF source always produces atom root
  it("property: decompose — 0-CF source with empty registry always produces atom root", async () => {
    await fc.assert(Props.prop_decompose_zero_cf_always_produces_atom_root);
  });

  // Compound: real parse sequence → branch + atom invariants.
  // Creates a real ts-morph Project per run — cap numRuns to stay within the
  // 30s global testTimeout. 10 runs × ~0.8s/run ≈ 8s budget.
  it("property: compound — real parse: branch root joint invariants (leafCount, maxDepth, hash, consistency)", async () => {
    await fc.assert(Props.prop_compound_decompose_real_parse_branch_and_atom_invariants, { numRuns: 10 });
  });

  // canonicalAstHash stability across calls.
  // Two decompose() calls per run with a real ts-morph Project — cap numRuns.
  // 10 runs × ~0.4s/run ≈ 4s budget.
  it("property: decompose — canonicalAstHash is stable (same input → same hash on repeated calls)", async () => {
    await fc.assert(Props.prop_decompose_canonicalAstHash_is_stable_across_calls, { numRuns: 10 });
  });
});
