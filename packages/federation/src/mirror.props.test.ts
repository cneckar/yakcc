// SPDX-License-Identifier: MIT
// Vitest harness for mirror.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling mirror.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_full_walk_compound_interaction,
  prop_idempotency_skips_existing_blocks,
  prop_partial_failure_resilience,
  prop_report_fields_well_formed,
  prop_schema_version_gate_accepts_equal_version,
  prop_schema_version_gate_rejects_newer_remote,
} from "./mirror.props.js";

// Async properties use numRuns: 20 — mirrorRegistry does several awaits per run.
const asyncOpts = { numRuns: 20 };

it("property: prop_schema_version_gate_rejects_newer_remote", async () => {
  await fc.assert(prop_schema_version_gate_rejects_newer_remote, asyncOpts);
});

it("property: prop_schema_version_gate_accepts_equal_version", async () => {
  await fc.assert(prop_schema_version_gate_accepts_equal_version, asyncOpts);
});

it("property: prop_idempotency_skips_existing_blocks", async () => {
  await fc.assert(prop_idempotency_skips_existing_blocks, asyncOpts);
});

it("property: prop_partial_failure_resilience", async () => {
  await fc.assert(prop_partial_failure_resilience, asyncOpts);
});

it("property: prop_report_fields_well_formed", async () => {
  await fc.assert(prop_report_fields_well_formed, asyncOpts);
});

it("property: prop_full_walk_compound_interaction", async () => {
  await fc.assert(prop_full_walk_compound_interaction, asyncOpts);
});
