// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for spec-yak.ts atoms.
// Atoms covered: validateSpecYak (A1.16)

import * as fc from "fast-check";
import { validateSpecYak } from "./spec-yak.js";
import type { SpecYak } from "./spec-yak.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a valid SpecYak value with all required fields populated. */
const validSpecYakArb: fc.Arbitrary<SpecYak> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 32 }),
    inputs: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 16 }),
        type: fc.string({ minLength: 1, maxLength: 32 }),
      }),
      { maxLength: 4 },
    ),
    outputs: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 16 }),
        type: fc.string({ minLength: 1, maxLength: 32 }),
      }),
      { maxLength: 4 },
    ),
    preconditions: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    postconditions: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    invariants: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    effects: fc.array(fc.string({ maxLength: 64 }), { maxLength: 4 }),
    level: fc.constantFrom("L0", "L1", "L2", "L3") as fc.Arbitrary<"L0" | "L1" | "L2" | "L3">,
  })
  .map((s) => s as SpecYak);

/**
 * Arbitrary for garbage values that are definitely not valid SpecYaks.
 * Covers: null, primitives, empty object, objects missing required fields.
 */
const garbageArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.string(),
  fc.constant([]),
  fc.constant({}), // missing all required fields
  fc.constant({
    name: "",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  }), // empty name
  fc.constant({
    name: "x",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "INVALID",
  }), // invalid level
  fc.constant({
    name: "x",
    inputs: "not-an-array",
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  }), // inputs not array
  fc.constant({
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  }), // missing name
  fc.constant({
    name: "x",
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  }), // missing inputs
);

// ---------------------------------------------------------------------------
// A1.16: validateSpecYak properties
// ---------------------------------------------------------------------------

/**
 * prop_validateSpecYak_round_trip
 *
 * For every valid SpecYak, serializing to JSON and back preserves the value:
 * validateSpecYak(JSON.parse(JSON.stringify(s))) succeeds and returns a value
 * with the same required fields.
 * Invariant: the validator accepts its own outputs after JSON round-trip.
 */
export const prop_validateSpecYak_round_trip = fc.property(validSpecYakArb, (spec) => {
  const serialized = JSON.parse(JSON.stringify(spec)) as unknown;
  try {
    const result = validateSpecYak(serialized);
    return (
      result.name === spec.name &&
      result.level === spec.level &&
      result.inputs.length === spec.inputs.length &&
      result.outputs.length === spec.outputs.length
    );
  } catch {
    return false;
  }
});

/**
 * prop_validateSpecYak_rejects_garbage
 *
 * For every garbage value, validateSpecYak throws (never returns).
 * Invariant: the validator rejects all non-conforming inputs.
 */
export const prop_validateSpecYak_rejects_garbage = fc.property(garbageArb, (value) => {
  try {
    validateSpecYak(value);
    return false; // returned without throwing — property violated
  } catch {
    return true; // threw as expected
  }
});

/**
 * prop_validateSpecYak_idempotent
 *
 * validateSpecYak(validateSpecYak(x)) succeeds and produces the same structure
 * as validateSpecYak(x) for all valid inputs.
 * Invariant: re-validating an already-valid SpecYak is a no-op.
 */
export const prop_validateSpecYak_idempotent = fc.property(validSpecYakArb, (spec) => {
  const first = validateSpecYak(spec);
  const second = validateSpecYak(first);
  return (
    first.name === second.name &&
    first.level === second.level &&
    first.inputs.length === second.inputs.length &&
    first.outputs.length === second.outputs.length &&
    first.preconditions.length === second.preconditions.length
  );
});
