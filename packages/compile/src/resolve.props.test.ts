// SPDX-License-Identifier: MIT
// Vitest harness for resolve.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling resolve.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_ResolutionError_cycle_detected,
  prop_ResolutionError_is_instanceof_Error,
  prop_ResolutionError_missing_block_kind_and_root,
  prop_SubBlockResolver_null_skips_sub_block,
  prop_extractSubBlockImports_dot_slash_prefix_resolved,
  prop_extractSubBlockImports_seeds_prefix_resolved,
  prop_resolveComposition_deterministic,
  prop_resolveComposition_resolved_block_fields,
  prop_resolveComposition_single_block_result_shape,
  prop_resolveComposition_topological_order_two_depth,
} from "./resolve.props.js";

// resolveComposition uses in-memory stub registries only — no disk IO, no ts-morph.
// numRuns: 50 gives good coverage without meaningful overhead.
const opts = { numRuns: 50 };

it("property: prop_resolveComposition_single_block_result_shape", async () => {
  await fc.assert(prop_resolveComposition_single_block_result_shape, opts);
});

it("property: prop_resolveComposition_resolved_block_fields", async () => {
  await fc.assert(prop_resolveComposition_resolved_block_fields, opts);
});

it("property: prop_resolveComposition_deterministic", async () => {
  await fc.assert(prop_resolveComposition_deterministic, opts);
});

it("property: prop_ResolutionError_missing_block_kind_and_root", async () => {
  await fc.assert(prop_ResolutionError_missing_block_kind_and_root, opts);
});

it("property: prop_ResolutionError_is_instanceof_Error", async () => {
  await fc.assert(prop_ResolutionError_is_instanceof_Error, opts);
});

it("property: prop_ResolutionError_cycle_detected", async () => {
  await fc.assert(prop_ResolutionError_cycle_detected, opts);
});

it("property: prop_SubBlockResolver_null_skips_sub_block", async () => {
  await fc.assert(prop_SubBlockResolver_null_skips_sub_block, opts);
});

it("property: prop_extractSubBlockImports_seeds_prefix_resolved", async () => {
  await fc.assert(prop_extractSubBlockImports_seeds_prefix_resolved, opts);
});

it("property: prop_extractSubBlockImports_dot_slash_prefix_resolved", async () => {
  await fc.assert(prop_extractSubBlockImports_dot_slash_prefix_resolved, opts);
});

it("property: prop_resolveComposition_topological_order_two_depth", async () => {
  await fc.assert(prop_resolveComposition_topological_order_two_depth, opts);
});
