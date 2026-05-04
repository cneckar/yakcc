// SPDX-License-Identifier: MIT
// Vitest harness for manifest.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling manifest.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_buildManifest_entries_count_matches_order_length,
  prop_buildManifest_entry_field_matches_resolution_entry,
  prop_buildManifest_passing_when_at_least_one_passing_test,
  prop_buildManifest_referencedForeign_is_always_array,
  prop_buildManifest_single_block_shape,
  prop_buildManifest_unverified_when_all_tests_failed,
  prop_buildManifest_unverified_when_no_passing_history,
} from "./manifest.props.js";

// buildManifest uses in-memory stubs only — no disk IO, no ts-morph.
// numRuns: 50 gives good coverage without meaningful overhead.
const opts = { numRuns: 50 };

it("property: prop_buildManifest_single_block_shape", async () => {
  await fc.assert(prop_buildManifest_single_block_shape, opts);
});

it("property: prop_buildManifest_unverified_when_no_passing_history", async () => {
  await fc.assert(prop_buildManifest_unverified_when_no_passing_history, opts);
});

it("property: prop_buildManifest_unverified_when_all_tests_failed", async () => {
  await fc.assert(prop_buildManifest_unverified_when_all_tests_failed, opts);
});

it("property: prop_buildManifest_passing_when_at_least_one_passing_test", async () => {
  await fc.assert(prop_buildManifest_passing_when_at_least_one_passing_test, opts);
});

it("property: prop_buildManifest_referencedForeign_is_always_array", async () => {
  await fc.assert(prop_buildManifest_referencedForeign_is_always_array, opts);
});

it("property: prop_buildManifest_entries_count_matches_order_length", async () => {
  await fc.assert(prop_buildManifest_entries_count_matches_order_length, opts);
});

it("property: prop_buildManifest_entry_field_matches_resolution_entry", async () => {
  await fc.assert(prop_buildManifest_entry_field_matches_resolution_entry, opts);
});
