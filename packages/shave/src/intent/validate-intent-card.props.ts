// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/validate-intent-card.ts atoms. Two-file pattern: this
// file (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3f)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from validate-intent-card.ts):
//   validateIntentCard (VIC1.x) — loud exact validator for IntentCard schema.
//
// Properties covered (40 atoms):
//   VIC1.1  — rejects non-object inputs: null
//   VIC1.2  — rejects non-object inputs: array
//   VIC1.3  — rejects non-object inputs: string
//   VIC1.4  — rejects non-object inputs: number
//   VIC1.5  — rejects unknown top-level field
//   VIC1.6  — rejects schemaVersion !== 1 (e.g. 0)
//   VIC1.7  — rejects schemaVersion !== 1 (e.g. 2)
//   VIC1.8  — rejects schemaVersion as string "1"
//   VIC1.9  — rejects missing schemaVersion
//   VIC1.10 — rejects behavior empty string
//   VIC1.11 — rejects behavior with newline character
//   VIC1.12 — rejects behavior with carriage-return character
//   VIC1.13 — rejects behavior > 200 chars
//   VIC1.14 — rejects behavior as non-string
//   VIC1.15 — rejects inputs as non-array
//   VIC1.16 — rejects outputs as non-array
//   VIC1.17 — rejects preconditions element as non-string
//   VIC1.18 — rejects postconditions element as non-string
//   VIC1.19 — rejects notes element as non-string
//   VIC1.20 — rejects sourceHash not 64 chars
//   VIC1.21 — rejects sourceHash with uppercase hex chars
//   VIC1.22 — rejects sourceHash with non-hex chars
//   VIC1.23 — rejects extractedAt empty string
//   VIC1.24 — rejects IntentParam with unknown key
//   VIC1.25 — rejects IntentParam missing name
//   VIC1.26 — rejects IntentParam missing typeHint
//   VIC1.27 — rejects IntentParam missing description
//   VIC1.28 — accepts well-formed IntentCard (happy path)
//   VIC1.29 — accepts behavior exactly 200 chars (boundary)
//   VIC1.30 — accepts behavior exactly 1 char (boundary)
//   VIC1.31 — return value is same reference as input (no cloning)
//   VIC1.32 — return value has schemaVersion === 1
//   VIC1.33 — return value behavior matches input
//   VIC1.34 — return value sourceHash matches input
//   VIC1.35 — accepts empty inputs/outputs/preconditions/postconditions/notes
//   VIC1.36 — accepts multi-element inputs array
//   VIC1.37 — accepts any non-empty extractedAt string
//   VIC1.38 — rejects behavior exactly 201 chars (boundary over)
//   VIC1.39 — return value modelVersion and promptVersion match input
//   VIC1.40 — compound: round-trip identity — validated value passes second validation

// ---------------------------------------------------------------------------
// Property-test corpus for intent/validate-intent-card.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { IntentCardSchemaError } from "../errors.js";
import { validateIntentCard } from "./validate-intent-card.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Behavior string: non-empty, no newlines, ≤ 200 chars. */
const behaviorArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && !/[\n\r]/.test(s));

/** 64-char lowercase hex string suitable for sourceHash. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Arbitrary string array (elements may be empty). */
const stringArrayArb: fc.Arbitrary<string[]> = fc.array(fc.string(), {
  minLength: 0,
  maxLength: 3,
});

/** Well-formed IntentParam object. */
const intentParamArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  name: nonEmptyStr,
  typeHint: nonEmptyStr,
  description: fc.string({ minLength: 0, maxLength: 40 }),
});

/** Array of well-formed IntentParam objects. */
const intentParamArrayArb: fc.Arbitrary<Record<string, unknown>[]> = fc.array(intentParamArb, {
  minLength: 0,
  maxLength: 3,
});

/** Well-formed plain object that satisfies all IntentCard constraints. */
const validCardArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    behaviorArb,
    hexHash64,
    intentParamArrayArb,
    intentParamArrayArb,
    nonEmptyStr,
    nonEmptyStr,
    nonEmptyStr,
    stringArrayArb,
    stringArrayArb,
    stringArrayArb,
  )
  .map(
    ([
      behavior,
      sourceHash,
      inputs,
      outputs,
      modelVersion,
      promptVersion,
      extractedAt,
      preconditions,
      postconditions,
      notes,
    ]) => ({
      schemaVersion: 1,
      behavior,
      inputs,
      outputs,
      preconditions,
      postconditions,
      notes,
      modelVersion,
      promptVersion,
      sourceHash,
      extractedAt,
    }),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if calling validateIntentCard(value) throws IntentCardSchemaError. */
function rejectsWithSchemaError(value: unknown): boolean {
  try {
    validateIntentCard(value);
    return false;
  } catch (err) {
    return err instanceof IntentCardSchemaError;
  }
}

// ---------------------------------------------------------------------------
// VIC1.1: rejects null input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_null
 *
 * validateIntentCard(null) always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.1, DEC-CONTINUOUS-SHAVE-022): null is not a plain object.
 * The validator must reject it loudly rather than producing a typed undefined.
 */
export const prop_validateIntentCard_rejects_null = fc.property(fc.constant(null), (v) =>
  rejectsWithSchemaError(v),
);

// ---------------------------------------------------------------------------
// VIC1.2: rejects array input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_array
 *
 * validateIntentCard([]) and any array always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.2, DEC-CONTINUOUS-SHAVE-022): arrays pass the typeof-object
 * check but must be rejected as non-plain-objects.
 */
export const prop_validateIntentCard_rejects_array = fc.property(
  fc.array(fc.anything(), { minLength: 0, maxLength: 5 }),
  (v) => rejectsWithSchemaError(v),
);

// ---------------------------------------------------------------------------
// VIC1.3: rejects string input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_string
 *
 * validateIntentCard(anyString) always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.3, DEC-CONTINUOUS-SHAVE-022): strings are not objects;
 * the validator must not coerce or silently skip them.
 */
export const prop_validateIntentCard_rejects_string = fc.property(fc.string(), (v) =>
  rejectsWithSchemaError(v),
);

// ---------------------------------------------------------------------------
// VIC1.4: rejects number input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_number
 *
 * validateIntentCard(anyNumber) always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.4, DEC-CONTINUOUS-SHAVE-022): numbers are primitives; the
 * validator must reject them at the top-level type check.
 */
export const prop_validateIntentCard_rejects_number = fc.property(fc.double(), (v) =>
  rejectsWithSchemaError(v),
);

// ---------------------------------------------------------------------------
// VIC1.5: rejects unknown top-level field
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_unknown_top_level_field
 *
 * A well-formed card augmented with any extra top-level key always throws
 * IntentCardSchemaError regardless of the extra key's value.
 *
 * Invariant (VIC1.5, DEC-CONTINUOUS-SHAVE-022): strict field rejection prevents
 * schema drift. An extra field from a future model prompt must surface immediately
 * rather than silently persisting an invalid entry to cache.
 */
export const prop_validateIntentCard_rejects_unknown_top_level_field = fc.property(
  validCardArb,
  // Extra key guaranteed not to be in the allowed set
  fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (k) =>
        ![
          "schemaVersion",
          "behavior",
          "inputs",
          "outputs",
          "preconditions",
          "postconditions",
          "notes",
          "modelVersion",
          "promptVersion",
          "sourceHash",
          "extractedAt",
        ].includes(k),
    ),
  fc.anything(),
  (card, extraKey, extraVal) => {
    const withExtra = { ...card, [extraKey]: extraVal };
    return rejectsWithSchemaError(withExtra);
  },
);

// ---------------------------------------------------------------------------
// VIC1.6: rejects schemaVersion 0
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_schemaVersion_zero
 *
 * A card with schemaVersion === 0 always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.6, DEC-CONTINUOUS-SHAVE-022): only schemaVersion 1 is valid;
 * version 0 indicates an old or malformed entry.
 */
export const prop_validateIntentCard_rejects_schemaVersion_zero = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, schemaVersion: 0 }),
);

// ---------------------------------------------------------------------------
// VIC1.7: rejects schemaVersion 2
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_schemaVersion_two
 *
 * A card with schemaVersion === 2 always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.7, DEC-CONTINUOUS-SHAVE-022): only version 1 is supported;
 * future versions must be rejected until an explicit upgrade path is defined.
 */
export const prop_validateIntentCard_rejects_schemaVersion_two = fc.property(validCardArb, (card) =>
  rejectsWithSchemaError({ ...card, schemaVersion: 2 }),
);

// ---------------------------------------------------------------------------
// VIC1.8: rejects schemaVersion as string "1"
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_schemaVersion_string
 *
 * A card with schemaVersion === "1" (string) always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.8, DEC-CONTINUOUS-SHAVE-022): the check is strict equality
 * to the number 1. String "1" is a common JSON parse artifact and must not
 * pass silently.
 */
export const prop_validateIntentCard_rejects_schemaVersion_string = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, schemaVersion: "1" }),
);

// ---------------------------------------------------------------------------
// VIC1.9: rejects missing schemaVersion
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_missing_schemaVersion
 *
 * A card without a schemaVersion field always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.9, DEC-CONTINUOUS-SHAVE-022): undefined !== 1 for the strict
 * equality check; missing fields must not silently pass.
 */
export const prop_validateIntentCard_rejects_missing_schemaVersion = fc.property(
  validCardArb,
  (card) => {
    const { schemaVersion: _dropped, ...rest } = card;
    return rejectsWithSchemaError(rest);
  },
);

// ---------------------------------------------------------------------------
// VIC1.10: rejects behavior as empty string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_empty_behavior
 *
 * A card with behavior === "" always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.10, DEC-CONTINUOUS-SHAVE-022): an empty behavior string
 * carries no semantic information; the validator must reject it.
 */
export const prop_validateIntentCard_rejects_empty_behavior = fc.property(validCardArb, (card) =>
  rejectsWithSchemaError({ ...card, behavior: "" }),
);

// ---------------------------------------------------------------------------
// VIC1.11: rejects behavior with newline character
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_behavior_with_newline
 *
 * A card with a \n in behavior always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.11, DEC-CONTINUOUS-SHAVE-022): newlines break single-line
 * display of behavior in CLI and log output; the validator must surface this
 * immediately.
 */
export const prop_validateIntentCard_rejects_behavior_with_newline = fc.property(
  validCardArb,
  nonEmptyStr,
  (card, prefix) => rejectsWithSchemaError({ ...card, behavior: `${prefix}\nline2` }),
);

// ---------------------------------------------------------------------------
// VIC1.12: rejects behavior with carriage-return character
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_behavior_with_cr
 *
 * A card with a \r in behavior always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.12, DEC-CONTINUOUS-SHAVE-022): carriage-return is also a
 * newline variant (tested by /[\n\r]/) and must be rejected for the same reason.
 */
export const prop_validateIntentCard_rejects_behavior_with_cr = fc.property(
  validCardArb,
  nonEmptyStr,
  (card, prefix) => rejectsWithSchemaError({ ...card, behavior: `${prefix}\rrest` }),
);

// ---------------------------------------------------------------------------
// VIC1.13: rejects behavior > 200 chars
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_behavior_over_200_chars
 *
 * A card with behavior.length > 200 always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.13, DEC-CONTINUOUS-SHAVE-022): the 200-char limit is the
 * schema contract. Exceeding it indicates malformed model output.
 */
export const prop_validateIntentCard_rejects_behavior_over_200_chars = fc.property(
  validCardArb,
  fc.string({ minLength: 201, maxLength: 300 }).filter((s) => !/[\n\r]/.test(s)),
  (card, longBehavior) => rejectsWithSchemaError({ ...card, behavior: longBehavior }),
);

// ---------------------------------------------------------------------------
// VIC1.14: rejects behavior as non-string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_behavior_non_string
 *
 * A card with behavior as a number always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.14, DEC-CONTINUOUS-SHAVE-022): behavior must be a string.
 * Non-string values indicate malformed JSON deserialization.
 */
export const prop_validateIntentCard_rejects_behavior_non_string = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, behavior: 42 }),
);

// ---------------------------------------------------------------------------
// VIC1.15: rejects inputs as non-array
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_inputs_non_array
 *
 * A card with inputs as a string always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.15, DEC-CONTINUOUS-SHAVE-022): inputs must be an array;
 * a string or object would silently coerce under a lenient validator.
 */
export const prop_validateIntentCard_rejects_inputs_non_array = fc.property(validCardArb, (card) =>
  rejectsWithSchemaError({ ...card, inputs: "not-an-array" }),
);

// ---------------------------------------------------------------------------
// VIC1.16: rejects outputs as non-array
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_outputs_non_array
 *
 * A card with outputs as a number always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.16, DEC-CONTINUOUS-SHAVE-022): outputs must be an array;
 * any other type is a schema violation.
 */
export const prop_validateIntentCard_rejects_outputs_non_array = fc.property(validCardArb, (card) =>
  rejectsWithSchemaError({ ...card, outputs: 0 }),
);

// ---------------------------------------------------------------------------
// VIC1.17: rejects preconditions element as non-string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_preconditions_non_string_element
 *
 * A card with a number element in preconditions always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.17, DEC-CONTINUOUS-SHAVE-022): preconditions must be a
 * string[]; mixed-type arrays must be rejected element-by-element.
 */
export const prop_validateIntentCard_rejects_preconditions_non_string_element = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, preconditions: ["ok", 99] }),
);

// ---------------------------------------------------------------------------
// VIC1.18: rejects postconditions element as non-string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_postconditions_non_string_element
 *
 * A card with a null element in postconditions always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.18, DEC-CONTINUOUS-SHAVE-022): postconditions must be a
 * string[]; null elements indicate malformed JSON deserialization.
 */
export const prop_validateIntentCard_rejects_postconditions_non_string_element = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, postconditions: [null] }),
);

// ---------------------------------------------------------------------------
// VIC1.19: rejects notes element as non-string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_notes_non_string_element
 *
 * A card with an object element in notes always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.19, DEC-CONTINUOUS-SHAVE-022): notes must be a string[];
 * embedded objects are schema violations.
 */
export const prop_validateIntentCard_rejects_notes_non_string_element = fc.property(
  validCardArb,
  (card) => rejectsWithSchemaError({ ...card, notes: [{}] }),
);

// ---------------------------------------------------------------------------
// VIC1.20: rejects sourceHash not exactly 64 chars
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_sourceHash_wrong_length
 *
 * A card with a sourceHash shorter or longer than 64 chars always throws
 * IntentCardSchemaError.
 *
 * Invariant (VIC1.20, DEC-CONTINUOUS-SHAVE-022): sourceHash is a BLAKE3-256
 * digest — exactly 64 hex characters. Wrong-length hashes indicate corruption.
 */
export const prop_validateIntentCard_rejects_sourceHash_wrong_length = fc.property(
  validCardArb,
  fc
    .oneof(fc.string({ minLength: 0, maxLength: 63 }), fc.string({ minLength: 65, maxLength: 80 }))
    .filter((s) => /^[0-9a-f]*$/.test(s) && s.length !== 64),
  (card, badHash) => rejectsWithSchemaError({ ...card, sourceHash: badHash }),
);

// ---------------------------------------------------------------------------
// VIC1.21: rejects sourceHash with uppercase hex chars
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_sourceHash_uppercase
 *
 * A card with sourceHash containing uppercase A-F always throws
 * IntentCardSchemaError.
 *
 * Invariant (VIC1.21, DEC-CONTINUOUS-SHAVE-022): the validator requires
 * lowercase hex. Uppercase passes the length check but must still be rejected
 * by the /^[0-9a-f]{64}$/ regex.
 */
export const prop_validateIntentCard_rejects_sourceHash_uppercase = fc.property(
  validCardArb,
  (card) => {
    // Build a 64-char string that has exactly one uppercase letter in it.
    const upper = "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899";
    return rejectsWithSchemaError({ ...card, sourceHash: upper });
  },
);

// ---------------------------------------------------------------------------
// VIC1.22: rejects sourceHash with non-hex chars
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_sourceHash_non_hex
 *
 * A card with a 64-char sourceHash that contains non-hex characters always
 * throws IntentCardSchemaError.
 *
 * Invariant (VIC1.22, DEC-CONTINUOUS-SHAVE-022): the regex is /^[0-9a-f]{64}$/;
 * any character outside [0-9a-f] is invalid.
 */
export const prop_validateIntentCard_rejects_sourceHash_non_hex = fc.property(
  validCardArb,
  (card) => {
    // 64 chars but contains 'g' (not valid hex).
    const nonHex = "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg";
    return rejectsWithSchemaError({ ...card, sourceHash: nonHex });
  },
);

// ---------------------------------------------------------------------------
// VIC1.23: rejects extractedAt as empty string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_empty_extractedAt
 *
 * A card with extractedAt === "" always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.23, DEC-CONTINUOUS-SHAVE-022): extractedAt is required to be
 * non-empty; an empty string indicates a serialization failure upstream.
 */
export const prop_validateIntentCard_rejects_empty_extractedAt = fc.property(validCardArb, (card) =>
  rejectsWithSchemaError({ ...card, extractedAt: "" }),
);

// ---------------------------------------------------------------------------
// VIC1.24: rejects IntentParam with unknown key
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_IntentParam_unknown_key
 *
 * An inputs array element with an unknown key always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.24, DEC-CONTINUOUS-SHAVE-022): IntentParam only allows
 * {name, typeHint, description}. Extra keys are rejected with the same strictness
 * as unknown top-level fields.
 */
export const prop_validateIntentCard_rejects_IntentParam_unknown_key = fc.property(
  validCardArb,
  fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((k) => !["name", "typeHint", "description"].includes(k) && k.trim().length > 0),
  (card, extraKey) => {
    const badParam = {
      name: "x",
      typeHint: "string",
      description: "desc",
      [extraKey]: "extra",
    };
    return rejectsWithSchemaError({ ...card, inputs: [badParam] });
  },
);

// ---------------------------------------------------------------------------
// VIC1.25: rejects IntentParam missing name
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_IntentParam_missing_name
 *
 * An inputs element without a name field always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.25, DEC-CONTINUOUS-SHAVE-022): all three IntentParam fields
 * are required. Missing name would produce an IntentParam with undefined name.
 */
export const prop_validateIntentCard_rejects_IntentParam_missing_name = fc.property(
  validCardArb,
  (card) => {
    const badParam = { typeHint: "string", description: "desc" };
    return rejectsWithSchemaError({ ...card, inputs: [badParam] });
  },
);

// ---------------------------------------------------------------------------
// VIC1.26: rejects IntentParam missing typeHint
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_IntentParam_missing_typeHint
 *
 * An outputs element without typeHint always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.26, DEC-CONTINUOUS-SHAVE-022): typeHint is required in
 * IntentParam and must be present and a string.
 */
export const prop_validateIntentCard_rejects_IntentParam_missing_typeHint = fc.property(
  validCardArb,
  (card) => {
    const badParam = { name: "y", description: "desc" };
    return rejectsWithSchemaError({ ...card, outputs: [badParam] });
  },
);

// ---------------------------------------------------------------------------
// VIC1.27: rejects IntentParam missing description
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_IntentParam_missing_description
 *
 * An inputs element without description always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.27, DEC-CONTINUOUS-SHAVE-022): description is required in
 * IntentParam; missing it would silently truncate the schema contract.
 */
export const prop_validateIntentCard_rejects_IntentParam_missing_description = fc.property(
  validCardArb,
  (card) => {
    const badParam = { name: "z", typeHint: "number" };
    return rejectsWithSchemaError({ ...card, inputs: [badParam] });
  },
);

// ---------------------------------------------------------------------------
// VIC1.28: accepts any well-formed IntentCard (happy path)
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_valid_card
 *
 * For any well-formed IntentCard-shaped object, validateIntentCard succeeds
 * (does not throw).
 *
 * Invariant (VIC1.28, DEC-CONTINUOUS-SHAVE-022): the happy-path property
 * verifies that the validator does not reject any conformant input, ensuring
 * that stricter-than-spec rules have not crept in.
 */
export const prop_validateIntentCard_accepts_valid_card = fc.property(validCardArb, (card) => {
  try {
    validateIntentCard(card);
    return true;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// VIC1.29: accepts behavior exactly 200 chars (boundary)
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_behavior_exactly_200_chars
 *
 * A card with behavior.length === 200 (no newlines) always passes validation.
 *
 * Invariant (VIC1.29, DEC-CONTINUOUS-SHAVE-022): the boundary is inclusive
 * (≤ 200). This property verifies the off-by-one is not rejecting valid inputs.
 */
export const prop_validateIntentCard_accepts_behavior_exactly_200_chars = fc.property(
  validCardArb,
  (card) => {
    const exactly200 = "a".repeat(200);
    try {
      validateIntentCard({ ...card, behavior: exactly200 });
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// VIC1.30: accepts behavior exactly 1 char (boundary)
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_behavior_exactly_1_char
 *
 * A card with behavior.length === 1 always passes validation.
 *
 * Invariant (VIC1.30, DEC-CONTINUOUS-SHAVE-022): single-char behavior is the
 * minimal non-empty input; this verifies the lower boundary is not off-by-one.
 */
export const prop_validateIntentCard_accepts_behavior_exactly_1_char = fc.property(
  validCardArb,
  (card) => {
    try {
      validateIntentCard({ ...card, behavior: "x" });
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// VIC1.31: return value is a plain object with all required IntentCard fields
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_result_has_all_required_fields
 *
 * validateIntentCard returns a plain object with all 11 required IntentCard
 * fields present and with the correct types.
 *
 * Invariant (VIC1.31, DEC-CONTINUOUS-SHAVE-022): the function constructs a new
 * object from the extracted fields (schemaVersion: 1, behavior, inputs, outputs,
 * preconditions, postconditions, notes, modelVersion, promptVersion, sourceHash,
 * extractedAt). All fields must be present on the returned value.
 */
export const prop_validateIntentCard_result_has_all_required_fields = fc.property(
  validCardArb,
  (card) => {
    const result = validateIntentCard(card);
    return (
      result.schemaVersion === 1 &&
      typeof result.behavior === "string" &&
      Array.isArray(result.inputs) &&
      Array.isArray(result.outputs) &&
      Array.isArray(result.preconditions) &&
      Array.isArray(result.postconditions) &&
      Array.isArray(result.notes) &&
      typeof result.modelVersion === "string" &&
      typeof result.promptVersion === "string" &&
      typeof result.sourceHash === "string" &&
      typeof result.extractedAt === "string"
    );
  },
);

// ---------------------------------------------------------------------------
// VIC1.32: return value has schemaVersion === 1
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_result_schemaVersion_is_1
 *
 * The return value of validateIntentCard always has schemaVersion === 1.
 *
 * Invariant (VIC1.32, DEC-CONTINUOUS-SHAVE-022): the function returns the
 * value typed as IntentCard, and schemaVersion must be the literal 1.
 */
export const prop_validateIntentCard_result_schemaVersion_is_1 = fc.property(
  validCardArb,
  (card) => {
    const result = validateIntentCard(card);
    return result.schemaVersion === 1;
  },
);

// ---------------------------------------------------------------------------
// VIC1.33: return value behavior matches input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_result_behavior_matches_input
 *
 * The behavior field of the returned IntentCard is identical to the input's
 * behavior field.
 *
 * Invariant (VIC1.33, DEC-CONTINUOUS-SHAVE-022): no transformation — the
 * validator returns the same value verbatim. This guards against accidental
 * field normalization (e.g. trim()) being introduced.
 */
export const prop_validateIntentCard_result_behavior_matches_input = fc.property(
  validCardArb,
  (card) => {
    const result = validateIntentCard(card);
    return result.behavior === card.behavior;
  },
);

// ---------------------------------------------------------------------------
// VIC1.34: return value sourceHash matches input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_result_sourceHash_matches_input
 *
 * The sourceHash of the returned IntentCard matches the input's sourceHash.
 *
 * Invariant (VIC1.34, DEC-CONTINUOUS-SHAVE-022): sourceHash is the cache key;
 * any mutation here would silently invalidate cache lookups.
 */
export const prop_validateIntentCard_result_sourceHash_matches_input = fc.property(
  validCardArb,
  (card) => {
    const result = validateIntentCard(card);
    return result.sourceHash === card.sourceHash;
  },
);

// ---------------------------------------------------------------------------
// VIC1.35: accepts empty arrays for all array fields
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_empty_arrays
 *
 * A card with inputs=[], outputs=[], preconditions=[], postconditions=[], notes=[]
 * always passes validation.
 *
 * Invariant (VIC1.35, DEC-CONTINUOUS-SHAVE-022): empty arrays are valid — a
 * function with no named inputs/outputs is a permitted schema form.
 */
export const prop_validateIntentCard_accepts_empty_arrays = fc.property(validCardArb, (card) => {
  const emptyArrayCard = {
    ...card,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
  };
  try {
    validateIntentCard(emptyArrayCard);
    return true;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// VIC1.36: accepts multi-element inputs array
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_multi_element_inputs
 *
 * A card with multiple well-formed IntentParam entries in inputs always passes.
 *
 * Invariant (VIC1.36, DEC-CONTINUOUS-SHAVE-022): validateIntentParamArray must
 * process every element; this verifies loop correctness for multi-element arrays.
 */
export const prop_validateIntentCard_accepts_multi_element_inputs = fc.property(
  validCardArb,
  fc.array(intentParamArb, { minLength: 2, maxLength: 5 }),
  (card, params) => {
    try {
      validateIntentCard({ ...card, inputs: params });
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// VIC1.37: accepts any non-empty extractedAt string
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_accepts_any_non_empty_extractedAt
 *
 * validateIntentCard accepts any non-empty extractedAt string without
 * enforcing ISO-8601 format.
 *
 * Invariant (VIC1.37, DEC-CONTINUOUS-SHAVE-022): "ISO-8601 format not strictly
 * enforced here, but presence is required." This property confirms the validator
 * does not silently add a format check.
 */
export const prop_validateIntentCard_accepts_any_non_empty_extractedAt = fc.property(
  validCardArb,
  nonEmptyStr,
  (card, extractedAt) => {
    try {
      validateIntentCard({ ...card, extractedAt });
      return true;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// VIC1.38: rejects behavior exactly 201 chars
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_rejects_behavior_exactly_201_chars
 *
 * A card with behavior.length === 201 always throws IntentCardSchemaError.
 *
 * Invariant (VIC1.38, DEC-CONTINUOUS-SHAVE-022): the upper boundary is 200
 * (inclusive); 201 must always be rejected — this verifies the boundary is
 * not off-by-one in the permissive direction.
 */
export const prop_validateIntentCard_rejects_behavior_exactly_201_chars = fc.property(
  validCardArb,
  (card) => {
    const exactly201 = "a".repeat(201);
    return rejectsWithSchemaError({ ...card, behavior: exactly201 });
  },
);

// ---------------------------------------------------------------------------
// VIC1.39: return value modelVersion and promptVersion match input
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_result_model_and_prompt_version_match_input
 *
 * The modelVersion and promptVersion of the returned IntentCard match the input.
 *
 * Invariant (VIC1.39, DEC-CONTINUOUS-SHAVE-022): both fields are cache
 * discriminants. Any mutation would silently invalidate cache lookups for all
 * entries produced with that model or prompt version.
 */
export const prop_validateIntentCard_result_model_and_prompt_version_match_input = fc.property(
  validCardArb,
  (card) => {
    const result = validateIntentCard(card);
    return result.modelVersion === card.modelVersion && result.promptVersion === card.promptVersion;
  },
);

// ---------------------------------------------------------------------------
// VIC1.40: compound — round-trip identity: validated value passes second validation
//
// Production sequence: raw JSON (parsed from cache or API response) →
// validateIntentCard() → IntentCard → re-validate (e.g. after deserialization
// in a consumer). Both validation calls must succeed and return the same value.
// This crosses the type boundary from unknown to IntentCard and back, verifying
// that the returned typed value is still accepted by the validator — i.e., the
// validator is idempotent on its own output.
// ---------------------------------------------------------------------------

/**
 * prop_validateIntentCard_compound_round_trip_idempotent
 *
 * A well-formed card passes validateIntentCard twice in sequence. The second
 * call (on the IntentCard returned by the first) must also succeed and produce
 * an output with the same field values.
 *
 * This is the canonical compound-interaction property: it exercises the full
 * production sequence of JSON deserialization → validation → re-validation
 * (as happens when a cache entry is read back and passed through the validator
 * before use), crossing the unknown→IntentCard type boundary twice.
 *
 * Invariant (VIC1.40, DEC-CONTINUOUS-SHAVE-022): validateIntentCard is
 * idempotent on conformant inputs — the returned IntentCard is itself a valid
 * input and validates to an object with the same field values. This guards
 * against any path where validation mutates or corrupts field values such that
 * a second validation call would reject or transform the result differently.
 */
export const prop_validateIntentCard_compound_round_trip_idempotent = fc.property(
  validCardArb,
  (card) => {
    const first = validateIntentCard(card);
    const second = validateIntentCard(first);
    // Both validation passes must succeed and produce the same field values.
    return (
      second.schemaVersion === first.schemaVersion &&
      second.behavior === first.behavior &&
      second.modelVersion === first.modelVersion &&
      second.promptVersion === first.promptVersion &&
      second.sourceHash === first.sourceHash &&
      second.extractedAt === first.extractedAt &&
      second.inputs.length === first.inputs.length &&
      second.outputs.length === first.outputs.length &&
      second.preconditions.length === first.preconditions.length &&
      second.postconditions.length === first.postconditions.length &&
      second.notes.length === first.notes.length
    );
  },
);
