// SPDX-License-Identifier: MIT
// Vitest harness for serve.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling serve.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_handleGetBlock_returns_200_json_object_when_block_present,
  prop_handleGetBlock_returns_404_when_block_absent,
  prop_handleGetSpec_returns_404_when_absent,
  prop_handleGetSpec_returns_roots_when_present,
  prop_handleListSpecs_returns_all_enumerated_spec_hashes,
  prop_handleListSpecs_returns_empty_array_for_empty_registry,
  prop_handleSchemaVersion_returns_200_with_local_version,
  prop_sendError_non_get_method_returns_405_method_not_allowed,
  prop_sendError_unknown_path_returns_not_found_envelope,
  prop_sendJson_body_matches_passed_object,
  prop_sendJson_content_type_is_application_json,
} from "./serve.props.js";

// serve.ts starts real node:http servers on port 0 (loopback only).
// numRuns: 25 balances coverage with async HTTP overhead per property.
const opts = { numRuns: 25 };

it("property: prop_sendJson_content_type_is_application_json", async () => {
  await fc.assert(prop_sendJson_content_type_is_application_json, opts);
});

it("property: prop_sendJson_body_matches_passed_object", async () => {
  await fc.assert(prop_sendJson_body_matches_passed_object, opts);
});

it("property: prop_sendError_unknown_path_returns_not_found_envelope", async () => {
  await fc.assert(prop_sendError_unknown_path_returns_not_found_envelope, opts);
});

it("property: prop_sendError_non_get_method_returns_405_method_not_allowed", async () => {
  await fc.assert(prop_sendError_non_get_method_returns_405_method_not_allowed, opts);
});

it("property: prop_handleSchemaVersion_returns_200_with_local_version", async () => {
  await fc.assert(prop_handleSchemaVersion_returns_200_with_local_version, opts);
});

it("property: prop_handleListSpecs_returns_all_enumerated_spec_hashes", async () => {
  await fc.assert(prop_handleListSpecs_returns_all_enumerated_spec_hashes, opts);
});

it("property: prop_handleListSpecs_returns_empty_array_for_empty_registry", async () => {
  await fc.assert(prop_handleListSpecs_returns_empty_array_for_empty_registry, opts);
});

it("property: prop_handleGetSpec_returns_roots_when_present", async () => {
  await fc.assert(prop_handleGetSpec_returns_roots_when_present, opts);
});

it("property: prop_handleGetSpec_returns_404_when_absent", async () => {
  await fc.assert(prop_handleGetSpec_returns_404_when_absent, opts);
});

it("property: prop_handleGetBlock_returns_404_when_block_absent", async () => {
  await fc.assert(prop_handleGetBlock_returns_404_when_block_absent, opts);
});

it("property: prop_handleGetBlock_returns_200_json_object_when_block_present", async () => {
  await fc.assert(prop_handleGetBlock_returns_200_json_object_when_block_present, opts);
});
