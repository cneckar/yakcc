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
 * contractIdFromBytes() is deterministic: same Uint8Array → same ContractId string.
 *
 * Invariant: the function is a pure, deterministic mapping.
 */
export const prop_contractIdFromBytes_deterministic = fc.property(uint8ArrayArb, (bytes) => {
  const id1 = contractIdFromBytes(bytes);
  const id2 = contractIdFromBytes(bytes);
  return id1 === id2;
});

/**
 * contractIdFromBytes() always produces a well-formed 64-char lowercase hex ContractId.
 *
 * Invariant: every output passes isValidContractId (64-char lowercase hex).
 */
export const prop_contractIdFromBytes_format_brand = fc.property(uint8ArrayArb, (bytes) => {
  return isValidContractId(contractIdFromBytes(bytes));
});

/**
 * contractIdFromBytes() maps distinct byte arrays to distinct ContractIds.
 *
 * For two distinct Uint8Arrays of the same length (≥32 bytes) the resulting
 * ContractIds are distinct (numRuns=200 to exercise a wider input space).
 * Invariant: BLAKE3-256 has sufficient collision resistance for any realistic input set.
 */
export const prop_contractIdFromBytes_collision_resistance = fc.property(
  distinctPairArb,
  ([a, b]) => {
    return contractIdFromBytes(a) !== contractIdFromBytes(b);
  },
);

/**
 * contractIdFromBytes() does not mutate its input Uint8Array.
 *
 * Invariant: the function is pure — the input bytes are unchanged after the call.
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
 * contractId(spec) equals contractIdFromBytes(canonicalize(spec)) for every ContractSpec.
 *
 * Invariant: contractId is a composition of canonicalize then contractIdFromBytes.
 */
export const prop_contractId_equals_idFromBytesOfCanonicalize = fc.property(
  contractSpecArb,
  (spec) => {
    return contractId(spec) === contractIdFromBytes(canonicalize(spec));
  },
);

/**
 * contractId() is invariant to ContractSpec key insertion order.
 *
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
 * isValidContractId() accepts every 64-character lowercase hex string.
 *
 * Invariant: the function accepts all well-formed ContractId strings.
 */
export const prop_isValidContractId_accepts_valid = fc.property(validContractIdArb, (id) => {
  return isValidContractId(id);
});

/**
 * isValidContractId() rejects any hex string whose length is not 64.
 *
 * Invariant: a ContractId must be exactly 64 characters.
 */
export const prop_isValidContractId_rejects_wrong_length = fc.property(wrongLengthHexArb, (s) => {
  return !isValidContractId(s);
});

/**
 * isValidContractId() rejects 64-char hex strings that contain uppercase letters.
 *
 * Invariant: a ContractId must be lowercase hex only.
 */
export const prop_isValidContractId_rejects_uppercase = fc.property(uppercaseHexArb, (s) => {
  return !isValidContractId(s);
});

/**
 * isValidContractId() rejects 64-char strings that contain non-hex characters.
 *
 * Invariant: a ContractId may only contain [0-9a-f].
 */
export const prop_isValidContractId_rejects_non_hex = fc.property(nonHexArb, (s) => {
  // The arbitrary may produce strings shorter than 64 due to replacement — only
  // assert when the string is exactly 64 chars to isolate the character class rule.
  if (s.length !== 64) return true;
  return !isValidContractId(s);
});

/**
 * isValidContractId() is total: never throws for any string input, only returns boolean.
 *
 * Invariant: the function is total — it handles empty, long, and Unicode inputs.
 */
export const prop_isValidContractId_total = fc.property(fc.string(), (s) => {
  try {
    const result = isValidContractId(s);
    return typeof result === "boolean";
  } catch {
    return false;
  }
});
