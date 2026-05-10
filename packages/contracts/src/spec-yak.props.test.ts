// SPDX-License-Identifier: MIT
// Vitest harness for spec-yak.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling spec-yak.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_validateSpecYak_idempotent,
  prop_validateSpecYak_rejects_garbage,
  prop_validateSpecYak_round_trip,
} from "./spec-yak.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };

it("property: prop_validateSpecYak_round_trip", () => {
  fc.assert(prop_validateSpecYak_round_trip, opts);
});

it("property: prop_validateSpecYak_rejects_garbage", () => {
  fc.assert(prop_validateSpecYak_rejects_garbage, opts);
});

it("property: prop_validateSpecYak_idempotent", () => {
  fc.assert(prop_validateSpecYak_idempotent, opts);
});
