// SPDX-License-Identifier: MIT
// Vitest harness for index.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling index.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_proposeContract_v0_always_accepted,
  prop_proposeContract_id_matches_contractId,
} from "./index.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };

it("property: prop_proposeContract_v0_always_accepted", async () => {
  await fc.assert(prop_proposeContract_v0_always_accepted, opts);
});

it("property: prop_proposeContract_id_matches_contractId", async () => {
  await fc.assert(prop_proposeContract_id_matches_contractId, opts);
});
