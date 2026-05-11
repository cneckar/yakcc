// SPDX-License-Identifier: MIT
// Vitest harness for wire.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling wire.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_deserialize_rejects_level_L1_L2_L3,
  prop_deserialize_rejects_non_object,
  prop_deserialize_rejects_tampered_blockMerkleRoot,
  prop_roundtrip_preserves_implSource,
  prop_roundtrip_preserves_merkle_root,
  prop_roundtrip_preserves_spec_hash,
  prop_serialize_artifactBytes_keys_match_artifacts_map,
  prop_serialize_is_deterministic,
  prop_serialize_maps_null_parentBlockRoot,
  prop_serialize_no_ownership_fields,
} from "./wire.props.js";

// Synchronous properties use numRuns: 100 (fast); async use 50.
const syncOpts = { numRuns: 100 };

it("property: prop_serialize_is_deterministic", () => {
  fc.assert(prop_serialize_is_deterministic, syncOpts);
});

it("property: prop_serialize_maps_null_parentBlockRoot", () => {
  fc.assert(prop_serialize_maps_null_parentBlockRoot, syncOpts);
});

it("property: prop_serialize_artifactBytes_keys_match_artifacts_map", () => {
  fc.assert(prop_serialize_artifactBytes_keys_match_artifacts_map, syncOpts);
});

it("property: prop_serialize_no_ownership_fields", () => {
  fc.assert(prop_serialize_no_ownership_fields, syncOpts);
});

it("property: prop_roundtrip_preserves_merkle_root", () => {
  fc.assert(prop_roundtrip_preserves_merkle_root, syncOpts);
});

it("property: prop_roundtrip_preserves_spec_hash", () => {
  fc.assert(prop_roundtrip_preserves_spec_hash, syncOpts);
});

it("property: prop_roundtrip_preserves_implSource", () => {
  fc.assert(prop_roundtrip_preserves_implSource, syncOpts);
});

it("property: prop_deserialize_rejects_non_object", () => {
  fc.assert(prop_deserialize_rejects_non_object, syncOpts);
});

it("property: prop_deserialize_rejects_level_L1_L2_L3", () => {
  fc.assert(prop_deserialize_rejects_level_L1_L2_L3, syncOpts);
});

it("property: prop_deserialize_rejects_tampered_blockMerkleRoot", () => {
  fc.assert(prop_deserialize_rejects_tampered_blockMerkleRoot, syncOpts);
});
