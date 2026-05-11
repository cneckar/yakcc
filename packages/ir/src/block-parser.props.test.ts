// SPDX-License-Identifier: MIT
// Vitest harness for block-parser.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling block-parser.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { describe, it } from "vitest";
import {
  prop_parseBlockTriplet_composition_detected_for_seeds_import,
  prop_parseBlockTriplet_composition_empty_for_simple_blocks,
  prop_parseBlockTriplet_composition_ref_shape,
  prop_parseBlockTriplet_deterministic,
  prop_parseBlockTriplet_merkleRoot_hex,
  prop_parseBlockTriplet_result_shape,
  prop_parseBlockTriplet_specHashRef_null_at_L0,
  prop_parseBlockTriplet_specHashValue_nonempty,
  prop_parseBlockTriplet_validation_shape,
} from "./block-parser.props.js";

// parseBlockTriplet invokes ts-morph and file I/O per call (~100-500ms).
// numRuns: 3 exercises all three fixture directories (constantFrom corpus) without
// excessive runtime. Invariants are structural; 3 runs saturates the finite corpus.
const opts = { numRuns: 3 };
const timeout = 120_000;

describe("block-parser properties", () => {
  it(
    "property: prop_parseBlockTriplet_result_shape",
    () => {
      fc.assert(prop_parseBlockTriplet_result_shape, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_deterministic",
    () => {
      fc.assert(prop_parseBlockTriplet_deterministic, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_validation_shape",
    () => {
      fc.assert(prop_parseBlockTriplet_validation_shape, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_merkleRoot_hex",
    () => {
      fc.assert(prop_parseBlockTriplet_merkleRoot_hex, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_specHashValue_nonempty",
    () => {
      fc.assert(prop_parseBlockTriplet_specHashValue_nonempty, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_composition_ref_shape",
    () => {
      fc.assert(prop_parseBlockTriplet_composition_ref_shape, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_composition_empty_for_simple_blocks",
    () => {
      fc.assert(prop_parseBlockTriplet_composition_empty_for_simple_blocks, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_specHashRef_null_at_L0",
    () => {
      fc.assert(prop_parseBlockTriplet_specHashRef_null_at_L0, opts);
    },
    timeout,
  );

  it(
    "property: prop_parseBlockTriplet_composition_detected_for_seeds_import",
    () => {
      fc.assert(prop_parseBlockTriplet_composition_detected_for_seeds_import, opts);
    },
    timeout,
  );
});
