// SPDX-License-Identifier: MIT
// Vitest harness for atom-persist.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling atom-persist.props.ts (vitest-free, hashable as a manifest artifact).
//
// NOTE: persistNovelGlueAtom calls extractCorpus() which performs filesystem
// IO (upstream-test + documented-usage sources). numRuns is capped at 20 to
// keep per-run IO cost bounded while still giving fast-check meaningful coverage.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_maybePersistNovelGlueAtom_delegates_when_store_block_present,
  prop_maybePersistNovelGlueAtom_returns_undefined_when_no_store_block,
  prop_maybePersistNovelGlueAtom_skips_no_intent_card,
  prop_persist_atom_compound_interaction,
  prop_persistNovelGlueAtom_calls_store_block_once,
  prop_persistNovelGlueAtom_distinct_sources_yield_distinct_merkle_roots,
  prop_persistNovelGlueAtom_forwards_parent_block_root,
  prop_persistNovelGlueAtom_is_deterministic,
  prop_persistNovelGlueAtom_return_equals_stored_merkle_root,
  prop_persistNovelGlueAtom_skips_no_intent_card,
  prop_persistNovelGlueAtom_stored_row_level_is_L0,
} from "./atom-persist.props.js";

// persistNovelGlueAtom calls extractCorpus() (filesystem-backed IO).
// Cap numRuns to stay within budget while giving meaningful coverage.
const opts = { numRuns: 20 };

it("property: prop_persistNovelGlueAtom_skips_no_intent_card", async () => {
  await fc.assert(prop_persistNovelGlueAtom_skips_no_intent_card, opts);
});

it("property: prop_persistNovelGlueAtom_calls_store_block_once", async () => {
  await fc.assert(prop_persistNovelGlueAtom_calls_store_block_once, opts);
});

it("property: prop_persistNovelGlueAtom_return_equals_stored_merkle_root", async () => {
  await fc.assert(prop_persistNovelGlueAtom_return_equals_stored_merkle_root, opts);
});

it("property: prop_persistNovelGlueAtom_is_deterministic", async () => {
  await fc.assert(prop_persistNovelGlueAtom_is_deterministic, opts);
});

it("property: prop_persistNovelGlueAtom_forwards_parent_block_root", async () => {
  await fc.assert(prop_persistNovelGlueAtom_forwards_parent_block_root, opts);
});

it("property: prop_persistNovelGlueAtom_stored_row_level_is_L0", async () => {
  await fc.assert(prop_persistNovelGlueAtom_stored_row_level_is_L0, opts);
});

it("property: prop_persistNovelGlueAtom_distinct_sources_yield_distinct_merkle_roots", async () => {
  await fc.assert(
    prop_persistNovelGlueAtom_distinct_sources_yield_distinct_merkle_roots,
    opts,
  );
});

it("property: prop_maybePersistNovelGlueAtom_returns_undefined_when_no_store_block", async () => {
  await fc.assert(prop_maybePersistNovelGlueAtom_returns_undefined_when_no_store_block, opts);
});

it("property: prop_maybePersistNovelGlueAtom_delegates_when_store_block_present", async () => {
  await fc.assert(prop_maybePersistNovelGlueAtom_delegates_when_store_block_present, opts);
});

it("property: prop_maybePersistNovelGlueAtom_skips_no_intent_card", async () => {
  await fc.assert(prop_maybePersistNovelGlueAtom_skips_no_intent_card, opts);
});

it("property: prop_persist_atom_compound_interaction", async () => {
  await fc.assert(prop_persist_atom_compound_interaction, opts);
});
