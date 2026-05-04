// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for index.ts atoms.
// Atoms covered: proposeContract (A1.17)

import * as fc from "fast-check";
import { contractSpecArb } from "./canonicalize.props.js";
import { contractId, proposeContract } from "./index.js";

// ---------------------------------------------------------------------------
// A1.17: proposeContract properties
// ---------------------------------------------------------------------------

/**
 * prop_proposeContract_v0_always_accepted
 *
 * For every ContractSpec, proposeContract always returns a result with
 * status === "accepted". This is the v0 invariant documented in the JSDoc:
 * WI-003 will connect this to the live registry for real match detection;
 * until then, v0 always returns "accepted".
 * Invariant: proposeContract is a pure v0 facade — no registry connection yet.
 */
export const prop_proposeContract_v0_always_accepted = fc.asyncProperty(
  contractSpecArb,
  async (spec) => {
    const result = await proposeContract(spec);
    return result.status === "accepted";
  },
);

/**
 * prop_proposeContract_id_matches_contractId
 *
 * For every ContractSpec, the id in the ProposalResult equals contractId(spec).
 * Invariant: the facade does not introduce id drift — the id is derived
 * identically whether via proposeContract or the direct contractId function.
 */
export const prop_proposeContract_id_matches_contractId = fc.asyncProperty(
  contractSpecArb,
  async (spec) => {
    const result = await proposeContract(spec);
    const expected = contractId(spec);
    return result.id === expected;
  },
);
