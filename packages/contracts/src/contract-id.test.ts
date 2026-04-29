import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { contractId, contractIdFromBytes, isValidContractId } from "./contract-id.js";
import { canonicalize } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const BASE_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers from a string.",
  guarantees: [{ id: "rejects-non-int", description: "Rejects non-integer values." }],
  errorConditions: [{ description: "Throws SyntaxError on malformed input.", errorType: "SyntaxError" }],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

const contractSpecArb: fc.Arbitrary<ContractSpec> = fc.record({
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
  behavior: fc.string({ minLength: 1, maxLength: 256 }),
  guarantees: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      description: fc.string({ minLength: 1, maxLength: 128 }),
    }),
    { maxLength: 4 },
  ),
  errorConditions: fc.array(
    fc.record({
      description: fc.string({ minLength: 1, maxLength: 128 }),
      errorType: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
    }),
    { maxLength: 4 },
  ),
  nonFunctional: fc.record({
    purity: fc.constantFrom(
      "pure",
      "io",
      "stateful",
      "nondeterministic",
    ) as fc.Arbitrary<"pure" | "io" | "stateful" | "nondeterministic">,
    threadSafety: fc.constantFrom("safe", "unsafe", "sequential") as fc.Arbitrary<
      "safe" | "unsafe" | "sequential"
    >,
  }),
  propertyTests: fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      description: fc.string({ minLength: 1, maxLength: 128 }),
    }),
    { maxLength: 4 },
  ),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contractId", () => {
  describe("determinism", () => {
    it("same spec → same id on two consecutive calls", () => {
      fc.assert(
        fc.property(contractSpecArb, (spec) => {
          const id1 = contractId(spec);
          const id2 = contractId(spec);
          expect(id1).toBe(id2);
        }),
        { numRuns: 200 },
      );
    });

    it("contractId and contractIdFromBytes(canonicalize(spec)) agree", () => {
      fc.assert(
        fc.property(contractSpecArb, (spec) => {
          const idA = contractId(spec);
          const idB = contractIdFromBytes(canonicalize(spec));
          expect(idA).toBe(idB);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("sensitivity", () => {
    it("changing behavior field produces a different id", () => {
      const specA = BASE_SPEC;
      const specB: ContractSpec = { ...BASE_SPEC, behavior: `${BASE_SPEC.behavior} Modified.` };
      expect(contractId(specA)).not.toBe(contractId(specB));
    });

    it("changing any leaf field in inputs produces a different id", () => {
      const specA = BASE_SPEC;
      const specB: ContractSpec = {
        ...BASE_SPEC,
        inputs: [{ name: "different", type: "number" }],
      };
      expect(contractId(specA)).not.toBe(contractId(specB));
    });

    it("changing purity produces a different id", () => {
      const specA = BASE_SPEC;
      const specB: ContractSpec = {
        ...BASE_SPEC,
        nonFunctional: { purity: "io", threadSafety: "safe" },
      };
      expect(contractId(specA)).not.toBe(contractId(specB));
    });

    it("arbitrary distinct specs produce distinct ids (collision resistance)", () => {
      fc.assert(
        fc.property(contractSpecArb, contractSpecArb, (specA, specB) => {
          // Two specs that differ in behavior must produce different ids.
          // We only assert when they're canonically distinct to avoid the degenerate case.
          if (specA.behavior !== specB.behavior) {
            const idA = contractId({ ...specA, behavior: specA.behavior });
            const idB = contractId({ ...specB, behavior: specB.behavior });
            // If behaviors differ, ids must differ. (Collision would be BLAKE3 failure.)
            expect(idA).not.toBe(idB);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("format", () => {
    it("outputs 64 lowercase hex characters", () => {
      fc.assert(
        fc.property(contractSpecArb, (spec) => {
          const id = contractId(spec);
          expect(id).toMatch(/^[0-9a-f]{64}$/);
        }),
        { numRuns: 100 },
      );
    });

    it("isValidContractId returns true for contractId outputs", () => {
      fc.assert(
        fc.property(contractSpecArb, (spec) => {
          expect(isValidContractId(contractId(spec))).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it("isValidContractId returns false for malformed strings", () => {
      const invalid = [
        "",
        "abc",
        // 63 chars (one short)
        "a".repeat(63),
        // 65 chars (one long)
        "a".repeat(65),
        // 64 chars but uppercase
        "A".repeat(64),
        // 64 chars with non-hex character
        `${"a".repeat(63)}g`,
        // has a space
        `${"a".repeat(32)} ${"a".repeat(31)}`,
      ];
      for (const s of invalid) {
        expect(isValidContractId(s)).toBe(false);
      }
    });
  });

  describe("known-good tripwire", () => {
    it("BASE_SPEC produces a stable known content-address", () => {
      // This tripwire pins the BLAKE3-256 hash of the canonical encoding of BASE_SPEC.
      // If this value changes, the content-address scheme has changed and all existing
      // ids are invalidated. Update only with explicit intent and an entry in the
      // decision log.
      const id = contractId(BASE_SPEC);
      // Verify format
      expect(isValidContractId(id)).toBe(true);
      // Pin the specific value — change only with deliberate scheme migration
      expect(id).toMatchSnapshot();
    });
  });
});
