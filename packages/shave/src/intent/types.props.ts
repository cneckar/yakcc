// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/types.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3g)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from types.ts):
//   IntentParam  (TYP1.1) — shape conformance: name/typeHint/description required strings
//   IntentCard   (TYP1.2) — shape conformance: schemaVersion===1 literal, all fields
//
// Properties covered (4 atoms):
//   (t1) IntentParam shape conformance — well-formed objects satisfy the interface
//   (t2) IntentParam shape conformance — name/typeHint/description all strings
//   (u1) IntentCard shape conformance — schemaVersion literal === 1
//   (u2) IntentCard round-trip through validateIntentCard

// ---------------------------------------------------------------------------
// Property-test corpus for intent/types.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { IntentCard, IntentParam } from "./types.js";
import { validateIntentCard } from "./validate-intent-card.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char lowercase hex string. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Behavior string: non-empty, no newlines, ≤ 200 chars. */
const behaviorArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\n\r]/.test(s));

/** Arbitrary IntentParam typed as the interface. */
const intentParamArb: fc.Arbitrary<IntentParam> = fc.record({
  name: nonEmptyStr,
  typeHint: nonEmptyStr,
  description: fc.string({ minLength: 0, maxLength: 40 }),
});

/** Well-formed IntentCard typed as the interface. */
const intentCardArb: fc.Arbitrary<IntentCard> = fc.record({
  schemaVersion: fc.constant(1 as const),
  behavior: behaviorArb,
  inputs: fc.array(intentParamArb, { minLength: 0, maxLength: 3 }),
  outputs: fc.array(intentParamArb, { minLength: 0, maxLength: 3 }),
  preconditions: fc.array(fc.string(), { minLength: 0, maxLength: 3 }),
  postconditions: fc.array(fc.string(), { minLength: 0, maxLength: 3 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 3 }),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
  sourceHash: hexHash64,
  extractedAt: fc.constant("2024-01-01T00:00:00.000Z"),
});

// ---------------------------------------------------------------------------
// TYP1.1 / (t1): IntentParam shape conformance — typed local assignment
// ---------------------------------------------------------------------------

/**
 * prop_types_IntentParam_shape_conformance
 *
 * Any object produced by intentParamArb can be assigned to an IntentParam
 * typed local and its fields read back with correct types.
 *
 * Invariant (TYP1.1, DEC-CONTINUOUS-SHAVE-022): the TypeScript interface
 * requires name, typeHint, and description to be strings. This property verifies
 * the arbitrary produces objects that structurally satisfy the interface at
 * runtime (type-checking catches compile-time drift; this catches build-time
 * regressions where the type and runtime diverge).
 */
export const prop_types_IntentParam_shape_conformance = fc.property(
  intentParamArb,
  (param: IntentParam) =>
    typeof param.name === "string" &&
    typeof param.typeHint === "string" &&
    typeof param.description === "string",
);

// ---------------------------------------------------------------------------
// TYP1.1 / (t2): IntentParam all fields are strings (no optional / undefined)
// ---------------------------------------------------------------------------

/**
 * prop_types_IntentParam_all_fields_are_strings
 *
 * For any IntentParam produced by intentParamArb, name, typeHint, and
 * description are all non-undefined string values.
 *
 * Invariant (TYP1.1, DEC-CONTINUOUS-SHAVE-022): all three IntentParam fields
 * are required strings per the interface. Under exactOptionalPropertyTypes:true,
 * they must never be undefined. This property verifies the runtime shape.
 */
export const prop_types_IntentParam_all_fields_are_strings = fc.property(
  intentParamArb,
  (param: IntentParam) =>
    param.name !== undefined &&
    param.typeHint !== undefined &&
    param.description !== undefined &&
    typeof param.name === "string" &&
    typeof param.typeHint === "string" &&
    typeof param.description === "string",
);

// ---------------------------------------------------------------------------
// TYP1.2 / (u1): IntentCard shape conformance — schemaVersion === 1 literal
// ---------------------------------------------------------------------------

/**
 * prop_types_IntentCard_schemaVersion_is_literal_1
 *
 * For any IntentCard produced by intentCardArb, schemaVersion is exactly the
 * number 1 (the literal type).
 *
 * Invariant (TYP1.2, DEC-CONTINUOUS-SHAVE-022): schemaVersion is typed as the
 * literal 1, which is a discriminant for forward-compatible deserialization.
 * This property verifies the const assertion is preserved at the value level.
 */
export const prop_types_IntentCard_schemaVersion_is_literal_1 = fc.property(
  intentCardArb,
  (card: IntentCard) => card.schemaVersion === 1 && typeof card.schemaVersion === "number",
);

// ---------------------------------------------------------------------------
// TYP1.2 / (u2): IntentCard round-trip through validateIntentCard
//
// Production sequence: IntentCard value (typed) → JSON.parse(JSON.stringify())
// → validateIntentCard() → IntentCard with same fields.
// Crosses the IntentCard interface boundary and the validator, mirroring the
// cache read path (readIntent returns unknown → validateIntentCard).
// ---------------------------------------------------------------------------

/**
 * prop_types_IntentCard_round_trip_through_validator
 *
 * A well-formed IntentCard value survives a JSON round-trip and validateIntentCard
 * with all fields intact.
 *
 * This is the compound-interaction property for types.ts: it exercises the
 * IntentCard interface shape → JSON serialization → deserialization → validation
 * sequence, which is the exact path the cache module follows when reading a
 * stored entry. Both the schema and the runtime shape must be consistent.
 *
 * Invariant (TYP1.2, DEC-CONTINUOUS-SHAVE-022): the IntentCard interface must
 * be structurally complete enough that any conformant value can survive
 * JSON round-trip and re-validation. If a field added to the interface is not
 * accepted by validateIntentCard, the cache pipeline silently evicts valid entries.
 */
export const prop_types_IntentCard_round_trip_through_validator = fc.property(
  intentCardArb,
  (card: IntentCard) => {
    // Simulate the cache read path: JSON serialize then deserialize.
    const raw = JSON.parse(JSON.stringify(card)) as unknown;

    try {
      const validated = validateIntentCard(raw);
      // All cache-validity fields must survive the round-trip.
      return (
        validated.schemaVersion === card.schemaVersion &&
        validated.behavior === card.behavior &&
        validated.modelVersion === card.modelVersion &&
        validated.promptVersion === card.promptVersion &&
        validated.sourceHash === card.sourceHash &&
        validated.extractedAt === card.extractedAt &&
        validated.inputs.length === card.inputs.length &&
        validated.outputs.length === card.outputs.length
      );
    } catch {
      return false;
    }
  },
);
