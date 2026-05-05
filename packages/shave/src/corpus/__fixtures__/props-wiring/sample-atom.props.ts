// SPDX-License-Identifier: MIT
// Fixture: hand-authored property-test corpus for sample-atom.ts.
// Used in props-file corpus wiring tests (WI-V2-07-PREFLIGHT-L8).

import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// toUpperCase properties
// ---------------------------------------------------------------------------

/**
 * prop_toUpperCase_idempotent
 * Applying toUpperCase twice produces the same result as once.
 */
export const prop_toUpperCase_idempotent = fc.property(fc.string(), (s) => {
  const once = s.toUpperCase();
  const twice = once.toUpperCase();
  return once === twice;
});

/**
 * prop_toUpperCase_length_preserving
 * The length of the result equals the length of the input.
 */
export const prop_toUpperCase_length_preserving = fc.property(fc.string(), (s) => {
  return s.toUpperCase().length === s.length;
});
