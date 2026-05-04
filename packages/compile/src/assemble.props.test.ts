// SPDX-License-Identifier: MIT
// Vitest harness for assemble.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling assemble.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_assemble_artifact_shape,
  prop_assemble_deterministic_byte_identical_reemit,
  prop_assemble_knownMerkleRoots_enables_sub_block_resolution,
  prop_assemble_source_includes_header_comment,
  prop_assemble_throws_ResolutionError_for_missing_block,
  prop_importPathStem_seeds_prefix_extracts_stem,
} from "./assemble.props.js";

// assemble() invokes registry.getBlock() (in-memory stub) and tsBackend.emit()
// (pure string processing). No ts-morph; stubs are fast.
// numRuns: 10 per dispatch budget for registry-backed atoms.
const opts = { numRuns: 10 };

it("property: prop_assemble_artifact_shape", async () => {
  await fc.assert(prop_assemble_artifact_shape, opts);
});

it("property: prop_assemble_source_includes_header_comment", async () => {
  await fc.assert(prop_assemble_source_includes_header_comment, opts);
});

it("property: prop_assemble_throws_ResolutionError_for_missing_block", async () => {
  await fc.assert(prop_assemble_throws_ResolutionError_for_missing_block, opts);
});

it("property: prop_assemble_deterministic_byte_identical_reemit", async () => {
  await fc.assert(prop_assemble_deterministic_byte_identical_reemit, opts);
});

it("property: prop_assemble_knownMerkleRoots_enables_sub_block_resolution", async () => {
  await fc.assert(prop_assemble_knownMerkleRoots_enables_sub_block_resolution, opts);
});

it("property: prop_importPathStem_seeds_prefix_extracts_stem", async () => {
  await fc.assert(prop_importPathStem_seeds_prefix_extracts_stem, opts);
});
