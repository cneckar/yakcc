// SPDX-License-Identifier: MIT
// Vitest harness for triplet.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling triplet.props.ts (vitest-free, hashable as a manifest artifact).
//
// buildTriplet() is synchronous and pure — no filesystem IO, no registry calls.
// numRuns is set to 50 to give good fast-check coverage at low cost.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_L0_bootstrap_manifest_shape,
  prop_buildTriplet_artifacts_map_contains_corpus_bytes,
  prop_buildTriplet_bootstrap_does_not_require_corpus,
  prop_buildTriplet_compound_content_address_stability,
  prop_buildTriplet_distinct_hash_yields_distinct_merkle_root,
  prop_buildTriplet_distinct_source_yields_distinct_merkle_root,
  prop_buildTriplet_has_all_required_fields,
  prop_buildTriplet_impl_equals_source,
  prop_buildTriplet_is_deterministic,
  prop_buildTriplet_manifest_artifact_kind_is_property_tests,
  prop_buildTriplet_merkle_root_is_non_empty,
  prop_buildTriplet_spec_level_is_L0,
  prop_buildTriplet_throws_without_corpus_and_without_bootstrap,
  prop_makeBootstrapArtifacts_has_one_empty_entry,
} from "./triplet.props.js";

// buildTriplet() is pure and synchronous — 50 runs is affordable.
const opts = { numRuns: 50 };

it("property: prop_buildTriplet_has_all_required_fields", () => {
  fc.assert(prop_buildTriplet_has_all_required_fields, opts);
});

it("property: prop_buildTriplet_impl_equals_source", () => {
  fc.assert(prop_buildTriplet_impl_equals_source, opts);
});

it("property: prop_buildTriplet_spec_level_is_L0", () => {
  fc.assert(prop_buildTriplet_spec_level_is_L0, opts);
});

it("property: prop_buildTriplet_merkle_root_is_non_empty", () => {
  fc.assert(prop_buildTriplet_merkle_root_is_non_empty, opts);
});

it("property: prop_buildTriplet_is_deterministic", () => {
  fc.assert(prop_buildTriplet_is_deterministic, opts);
});

it("property: prop_buildTriplet_distinct_source_yields_distinct_merkle_root", () => {
  fc.assert(prop_buildTriplet_distinct_source_yields_distinct_merkle_root, opts);
});

it("property: prop_buildTriplet_distinct_hash_yields_distinct_merkle_root", () => {
  fc.assert(prop_buildTriplet_distinct_hash_yields_distinct_merkle_root, opts);
});

it("property: prop_buildTriplet_manifest_artifact_kind_is_property_tests", () => {
  fc.assert(prop_buildTriplet_manifest_artifact_kind_is_property_tests, opts);
});

it("property: prop_buildTriplet_artifacts_map_contains_corpus_bytes", () => {
  fc.assert(prop_buildTriplet_artifacts_map_contains_corpus_bytes, opts);
});

it("property: prop_buildTriplet_bootstrap_does_not_require_corpus", () => {
  fc.assert(prop_buildTriplet_bootstrap_does_not_require_corpus, opts);
});

it("property: prop_buildTriplet_throws_without_corpus_and_without_bootstrap", () => {
  fc.assert(prop_buildTriplet_throws_without_corpus_and_without_bootstrap, opts);
});

it("property: prop_L0_bootstrap_manifest_shape", () => {
  fc.assert(prop_L0_bootstrap_manifest_shape, opts);
});

it("property: prop_makeBootstrapArtifacts_has_one_empty_entry", () => {
  fc.assert(prop_makeBootstrapArtifacts_has_one_empty_entry, opts);
});

it("property: prop_buildTriplet_compound_content_address_stability", () => {
  fc.assert(prop_buildTriplet_compound_content_address_stability, opts);
});
