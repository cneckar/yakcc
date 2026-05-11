// SPDX-License-Identifier: MIT
//
// Vitest harness for rebuild.props.ts
//
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling rebuild.props.ts (vitest-free, importable as a manifest artifact).
//
// Property tests exercised:
//   R6  — empty registry: reembedded=0
//   R3  — result.reembedded == block count
//   R4  — result.modelId matches provider
//   R1  — block data (all non-embedding fields) preserved byte-for-byte after rebuild
//   R2  — idempotent: second rebuild == first rebuild end state (compound-interaction test)
//   R5  — onProgress called exactly once per block, monotonically increasing done count
//
// numRuns: 5 — these are async property tests that open an in-memory SQLite
// registry per run; 5 runs exercises the arbitrary domain while keeping CI fast.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_rebuild_empty_registry_reembedded_zero,
  prop_rebuild_is_idempotent,
  prop_rebuild_preserves_block_data,
  prop_rebuild_progress_callback_called_per_block,
  prop_rebuild_result_model_id_matches_provider,
  prop_rebuild_result_reembedded_matches_block_count,
} from "./rebuild.props.js";

// Async property tests open SQLite in-memory per run; keep numRuns small.
const opts = { numRuns: 5 };

it("property: prop_rebuild_empty_registry_reembedded_zero", async () => {
  await fc.assert(prop_rebuild_empty_registry_reembedded_zero, opts);
});

it("property: prop_rebuild_result_reembedded_matches_block_count", async () => {
  await fc.assert(prop_rebuild_result_reembedded_matches_block_count, opts);
});

it("property: prop_rebuild_result_model_id_matches_provider", async () => {
  await fc.assert(prop_rebuild_result_model_id_matches_provider, opts);
});

it("property: prop_rebuild_preserves_block_data", async () => {
  await fc.assert(prop_rebuild_preserves_block_data, opts);
});

// Compound-interaction test: exercises the full production sequence
//   openRegistry → storeBlock × N → rebuildRegistry → rebuildRegistry (twice)
//   → getBlock × N → snapshot comparison.
// This is the canonical end-to-end path documented in docs/USING_YAKCC.md.
it("property: prop_rebuild_is_idempotent (compound-interaction — R2)", async () => {
  await fc.assert(prop_rebuild_is_idempotent, opts);
});

it("property: prop_rebuild_progress_callback_called_per_block", async () => {
  await fc.assert(prop_rebuild_progress_callback_called_per_block, opts);
});
