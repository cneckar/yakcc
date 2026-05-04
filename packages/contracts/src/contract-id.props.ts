// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for contract-id.ts atoms.
// Atoms covered: contractIdFromBytes (A1.5), contractId (A1.6), isValidContractId (A1.7)

import * as fc from "fast-check";
import { canonicalize } from "./canonicalize.js";
import { contractSpecArb } from "./canonicalize.props.js";
import { contractId, contractIdFromBytes, isValidContractId } from "./contract-id.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a random non-empty Uint8Array (simulates canonical bytes). */
const uint8ArrayArb: fc.Arbitrary<Uint8Array> = fc
  .uint8Array({ minLength: 1, maxLength: 256 })
  .map((arr) => new Uint8Array(arr));

/** Two distinct Uint8Arrays of the same length (≥32 bytes) for collision tests. */
const distinctPairArb: fc.Arbitrary<[Uint8Array, Uint8Array]> = fc
  .uint8Array({ minLength: 32, maxLength: 64 })
  .chain((arr) =>
    fc
      .uint8Array({ minLength: arr.length, maxLength: arr.length })
      .filter((arr2) => {
        // Require at least one differing byte.
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] !== arr2[i]) return true;
        }
        return false;
      })
      .map((arr2) => [new Uint8Array(arr), new Uint8Array(arr2)] as [Uint8Array, Uint8Array]),
  );

// ---------------------------------------------------------------------------
// A1.5: contractIdFromBytes properties
// ---------------------------------------------------------------------------

/**
 * prop_contractIdFromBytes_deterministic
 *
 * For every Uint8Array, two consecutive calls to contractIdFromBytes with the
 * same input return the same ContractId string.
 * Invariant: the function is a pure, deterministic mapping.
 */
export const prop_contractIdFromBytes_deterministic = fc.property(uint8ArrayArb, (bytes) => {
  const id1 = contractIdFromBytes(bytes);
  const id2 = contractIdFromBytes(bytes);
  return id1 === id2;
});

/**
 * prop_contractIdFromBytes_format_brand
 *
 * For every Uint8Array, the returned ContractId passes isValidContractId.
 * Invariant: contractIdFromBytes always produces a well-formed 64-char lowercase hex id.
 */
export const prop_contractIdFromBytes_format_brand = fc.property(uint8ArrayArb, (bytes) => {
  return isValidContractId(contractIdFromBytes(bytes));
});

/**
 * prop_contractIdFromBytes_collision_resistance
 *
 * For two distinct Uint8Arrays of the same length (≥32 bytes), the resulting
 * ContractIds are distinct. Uses numRuns=200 to exercise a wider input space.
 * Invariant: BLAKE3-256 has sufficient collision resistance for any realistic input set.
 */
export const prop_contractIdFromBytes_collision_resistance = fc.property(
  distinctPairArb,
  ([a, b]) => {
    return contractIdFromBytes(a) !== contractIdFromBytes(b);
  },
);

/**
 * prop_contractIdFromBytes_pure
 *
 * The input Uint8Array is byte-equal before and after calling contractIdFromBytes.
 * Invariant: the function does not mutate its input in place.
 */
export const prop_contractIdFromBytes_pure = fc.property(uint8ArrayArb, (bytes) => {
  const snapshot = new Uint8Array(bytes);
  contractIdFromBytes(bytes);
  if (bytes.length !== snapshot.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== snapshot[i]) return false;
  }
  return true;
});

// ---------------------------------------------------------------------------
// A1.6: contractId properties
// ---------------------------------------------------------------------------

/**
 * prop_contractId_equals_idFromBytesOfCanonicalize
 *
 * For every ContractSpec, contractId(spec) === contractIdFromBytes(canonicalize(spec)).
 * Invariant: contractId is a composition of canonicalize then contractIdFromBytes.
 */
export const prop_contractId_equals_idFromBytesOfCanonicalize = fc.property(
  contractSpecArb,
  (spec) => {
    return contractId(spec) === contractIdFromBytes(canonicalize(spec));
  },
);

/**
 * prop_contractId_field_order_invariant
 *
 * Permuting object key insertion order in the input spec produces the same ContractId.
 * Invariant: contractId delegates to canonicalize which sorts keys — order is irrelevant.
 */
export const prop_contractId_field_order_invariant = fc.property(contractSpecArb, (spec) => {
  const reversed = {
    propertyTests: spec.propertyTests,
    nonFunctional: {
      space: spec.nonFunctional.space,
      time: spec.nonFunctional.time,
      threadSafety: spec.nonFunctional.threadSafety,
      purity: spec.nonFunctional.purity,
    },
    errorConditions: spec.errorConditions,
    guarantees: spec.guarantees,
    behavior: spec.behavior,
    outputs: spec.outputs,
    inputs: spec.inputs,
  };
  return contractId(spec) === contractId(reversed);
});

// ---------------------------------------------------------------------------
// A1.7: isValidContractId properties
// ---------------------------------------------------------------------------

/** Arbitrary for a 64-character lowercase hex string (always valid). */
const validContractIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9a-f]{64}$/);

/** Arbitrary for a hex string of length ≠ 64 (always invalid by length). */
const wrongLengthHexArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 128 })
  .filter((n) => n !== 64)
  .chain((len) =>
    len === 0 ? fc.constant("") : fc.stringMatching(new RegExp(`^[0-9a-f]{${len}}$`)),
  );

/** Arbitrary for a 64-char string containing at least one uppercase hex character. */
const uppercaseHexArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[0-9a-f]{63}$/)
  .map((s) => `${s}A`); // append a known uppercase char

/** Arbitrary for a 64-char string containing at least one non-hex character. */
const nonHexArb: fc.Arbitrary<string> = fc
  .string({ minLength: 63, maxLength: 63 })
  .map((s) => `${s.replace(/[0-9a-fA-F]/g, "x")}!`); // ensure at least one non-hex

/**
 * prop_isValidContractId_accepts_valid
 *
 * For every 64-character lowercase hex string, isValidContractId returns true.
 * Invariant: the function accepts all well-formed ContractId strings.
 */
export const prop_isValidContractId_accepts_valid = fc.property(validContractIdArb, (id) => {
  return isValidContractId(id);
});

/**
 * prop_isValidContractId_rejects_wrong_length
 *
 * For every hex string whose length ≠ 64, isValidContractId returns false.
 * Invariant: a ContractId must be exactly 64 characters.
 */
export const prop_isValidContractId_rejects_wrong_length = fc.property(wrongLengthHexArb, (s) => {
  return !isValidContractId(s);
});

/**
 * prop_isValidContractId_rejects_uppercase
 *
 * For 64-char hex strings containing an uppercase letter, isValidContractId returns false.
 * Invariant: a ContractId must be lowercase hex.
 */
export const prop_isValidContractId_rejects_uppercase = fc.property(uppercaseHexArb, (s) => {
  return !isValidContractId(s);
});

/**
 * prop_isValidContractId_rejects_non_hex
 *
 * For 64-char strings containing a non-hex character, isValidContractId returns false.
 * Invariant: a ContractId may only contain [0-9a-f].
 */
export const prop_isValidContractId_rejects_non_hex = fc.property(nonHexArb, (s) => {
  // The arbitrary may produce strings shorter than 64 due to replacement — only
  // assert when the string is exactly 64 chars to isolate the character class rule.
  if (s.length !== 64) return true;
  return !isValidContractId(s);
});

/**
 * prop_isValidContractId_total
 *
 * For every string (including empty, long, Unicode), isValidContractId never throws.
 * Invariant: the function is total — it never throws, only returns boolean.
 */
export const prop_isValidContractId_total = fc.property(fc.string(), (s) => {
  try {
    const result = isValidContractId(s);
    return typeof result === "boolean";
  } catch {
    return false;
  }
});
