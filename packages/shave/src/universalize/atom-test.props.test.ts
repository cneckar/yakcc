// SPDX-License-Identifier: MIT
// Vitest harness for universalize/atom-test.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./atom-test.props.js";

describe("universalize/atom-test.ts — property corpus", () => {
  // AT-REASON-1: reason is one of the 5 canonical AtomTestReason literals
  it("property: isAtom — reason is always a valid AtomTestReason", async () => {
    await fc.assert(Props.prop_isAtom_reason_is_valid_AtomTestReason);
  });

  // AT-CF-3: controlFlowBoundaryCount is always a non-negative integer
  it("property: isAtom — controlFlowBoundaryCount is non-negative", async () => {
    await fc.assert(Props.prop_isAtom_controlFlowBoundaryCount_is_non_negative);
  });

  // AT-CF-1: 0 CF boundaries + empty registry → always atomic
  it("property: isAtom — 0 CF boundaries with empty registry is always atomic", async () => {
    await fc.assert(Props.prop_isAtom_zero_cf_empty_registry_is_always_atomic);
  });

  // AT-CF-2: CF count > maxCF → too-many-cf-boundaries
  it("property: isAtom — excess CF count returns too-many-cf-boundaries", async () => {
    await fc.assert(Props.prop_isAtom_excess_cf_returns_too_many_cf_boundaries);
  });

  // AT-CF-4: undefined options → default maxCF = 1
  it("property: isAtom — undefined options uses default maxControlFlowBoundaries = 1", async () => {
    await fc.assert(Props.prop_isAtom_undefined_options_uses_default_max_cf_1);
  });

  // AT-REG-1: empty registry + 0 CF options sweep → always atomic
  it("property: isAtom — empty registry + 0-CF source is always atomic across options sweep", async () => {
    await fc.assert(Props.prop_isAtom_empty_registry_zero_cf_options_sweep_always_atomic);
  });

  // AT-MATCH-1: matchedPrimitive is absent for non-contains-known-primitive results
  it("property: isAtom — matchedPrimitive is absent for non-contains-known-primitive reason", async () => {
    await fc.assert(Props.prop_isAtom_matchedPrimitive_absent_for_non_contains_reason);
  });

  // AT-REG-2: always-match registry triggers contains-known-primitive
  it("property: isAtom — always-match registry triggers contains-known-primitive", async () => {
    await fc.assert(Props.prop_isAtom_always_match_registry_triggers_contains_known_primitive);
  });

  // Compound: real parse → isAtom → CF-varies-by-maxCF correctness
  it("property: compound — real parse sequence: CF-varies-by-maxCF joint invariants", async () => {
    await fc.assert(Props.prop_compound_isAtom_real_parse_cf_varies_by_maxcf);
  });
});
