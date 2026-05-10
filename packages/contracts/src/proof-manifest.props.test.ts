// SPDX-License-Identifier: MIT
// Vitest harness for proof-manifest.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling proof-manifest.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_validateProofManifestL0_round_trip,
  prop_validateProofManifestL0_rejects_garbage,
  prop_validateProofManifestL0_idempotent,
} from "./proof-manifest.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };

it("property: prop_validateProofManifestL0_round_trip", () => {
  fc.assert(prop_validateProofManifestL0_round_trip, opts);
});

it("property: prop_validateProofManifestL0_rejects_garbage", () => {
  fc.assert(prop_validateProofManifestL0_rejects_garbage, opts);
});

it("property: prop_validateProofManifestL0_idempotent", () => {
  fc.assert(prop_validateProofManifestL0_idempotent, opts);
});
