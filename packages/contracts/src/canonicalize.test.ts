import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { canonicalize, canonicalizeText, __testing__ } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string", description: "raw input" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers from a string.",
  guarantees: [{ id: "rejects-non-int", description: "Rejects non-integer values." }],
  errorConditions: [{ description: "Throws SyntaxError on malformed input.", errorType: "SyntaxError" }],
  nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(n)" },
  propertyTests: [
    {
      id: "round-trip",
      description: "parse(serialize(xs)) deep-equals xs for valid int arrays.",
      arbitraries: ["fc.array(fc.integer())"],
    },
  ],
};

/** Build a ContractSpec using the same values as MINIMAL_SPEC but with properties
 *  inserted in a different order. This verifies that object construction order does
 *  not affect the canonical output. */
function buildSpecAlternateOrder(): ContractSpec {
  return {
    behavior: "Parse a JSON array of integers from a string.",
    errorConditions: [{ errorType: "SyntaxError", description: "Throws SyntaxError on malformed input." }],
    guarantees: [{ description: "Rejects non-integer values.", id: "rejects-non-int" }],
    inputs: [{ description: "raw input", name: "s", type: "string" }],
    nonFunctional: { purity: "pure", space: "O(n)", threadSafety: "safe", time: "O(n)" },
    outputs: [{ name: "result", type: "number[]" }],
    propertyTests: [
      {
        arbitraries: ["fc.array(fc.integer())"],
        description: "parse(serialize(xs)) deep-equals xs for valid int arrays.",
        id: "round-trip",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Arbitrary for ContractSpec (used in property tests)
// ---------------------------------------------------------------------------

const typeSignatureArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 32 }),
  type: fc.string({ minLength: 1, maxLength: 64 }),
  description: fc.option(fc.string({ maxLength: 128 }), { nil: undefined }),
});

const behavioralGuaranteeArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  description: fc.string({ minLength: 1, maxLength: 256 }),
});

const propertyTestCaseArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  description: fc.string({ minLength: 1, maxLength: 256 }),
  arbitraries: fc.option(fc.array(fc.string({ maxLength: 64 })), { nil: undefined }),
});

const purityArb = fc.constantFrom("pure", "io", "stateful", "nondeterministic") as fc.Arbitrary<
  "pure" | "io" | "stateful" | "nondeterministic"
>;
const threadSafetyArb = fc.constantFrom("safe", "unsafe", "sequential") as fc.Arbitrary<
  "safe" | "unsafe" | "sequential"
>;

const errorConditionArb = fc.record({
  description: fc.string({ minLength: 1, maxLength: 256 }),
  errorType: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
});

const contractSpecArb: fc.Arbitrary<ContractSpec> = fc.record({
  inputs: fc.array(typeSignatureArb, { maxLength: 8 }),
  outputs: fc.array(typeSignatureArb, { maxLength: 4 }),
  behavior: fc.string({ minLength: 1, maxLength: 512 }),
  guarantees: fc.array(behavioralGuaranteeArb, { maxLength: 8 }),
  errorConditions: fc.array(errorConditionArb, { maxLength: 8 }),
  nonFunctional: fc.record({
    purity: purityArb,
    threadSafety: threadSafetyArb,
    time: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
    space: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  }),
  propertyTests: fc.array(propertyTestCaseArb, { maxLength: 8 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  describe("determinism", () => {
    it("returns byte-identical Uint8Arrays for two calls on the same spec", () => {
      fc.assert(
        fc.property(contractSpecArb, (spec) => {
          const a = canonicalize(spec);
          const b = canonicalize(spec);
          expect(a).toEqual(b);
        }),
        { numRuns: 200 },
      );
    });

    it("same spec built in different property-insertion orders canonicalizes identically", () => {
      const canonical1 = canonicalize(MINIMAL_SPEC);
      const canonical2 = canonicalize(buildSpecAlternateOrder());
      expect(canonical1).toEqual(canonical2);
    });

    it("produces identical bytes across multiple calls on a fixed minimal spec", () => {
      const results = Array.from({ length: 5 }, () => canonicalize(MINIMAL_SPEC));
      for (const r of results) {
        expect(r).toEqual(results[0]);
      }
    });
  });

  describe("key ordering", () => {
    it("sorts object keys lexicographically at every depth", () => {
      const text = canonicalizeText(MINIMAL_SPEC);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const topKeys = Object.keys(parsed);
      const sortedKeys = [...topKeys].sort();
      expect(topKeys).toEqual(sortedKeys);
    });

    it("sorts nested object keys too (guarantees sub-objects)", () => {
      const text = canonicalizeText(MINIMAL_SPEC);
      const parsed = JSON.parse(text) as {
        guarantees: Array<Record<string, unknown>>;
      };
      for (const g of parsed.guarantees) {
        const keys = Object.keys(g);
        expect(keys).toEqual([...keys].sort());
      }
    });
  });

  describe("array ordering", () => {
    it("preserves array element order", () => {
      const spec: ContractSpec = {
        ...MINIMAL_SPEC,
        errorConditions: [
          { description: "first" },
          { description: "second" },
          { description: "third" },
        ],
      };
      const text = canonicalizeText(spec);
      const parsed = JSON.parse(text) as { errorConditions: Array<{ description: string }> };
      expect(parsed.errorConditions.map((e) => e.description)).toEqual(["first", "second", "third"]);
    });
  });

  describe("undefined field omission", () => {
    it("omits undefined optional fields from the canonical form", () => {
      const specWithOptionals: ContractSpec = {
        ...MINIMAL_SPEC,
        inputs: [{ name: "x", type: "string" }], // description absent on input
        guarantees: [], // remove guarantees so no guarantee description fields
        nonFunctional: { purity: "pure", threadSafety: "safe" }, // time/space absent
        propertyTests: [], // no arbitraries field
      };
      const text = canonicalizeText(specWithOptionals);
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // input should have no description key
      const inputs = parsed["inputs"] as Array<Record<string, unknown>>;
      expect(Object.prototype.hasOwnProperty.call(inputs[0], "description")).toBe(false);

      // nonFunctional should have no time or space keys
      const nf = parsed["nonFunctional"] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(nf, "time")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(nf, "space")).toBe(false);
    });

    it("encodes null as null (not omitted) when explicitly set to null", () => {
      // A field that is explicitly null should appear in the canonical form.
      // This is distinct from undefined/absent which must be omitted.
      // We verify via the encoder's explicit null branch.
      const specWithExplicitNull = {
        ...MINIMAL_SPEC,
        // Inject a null via cast — in real code this would be a type error,
        // but we verify the encoder handles it rather than crashing.
        behavior: null,
      } as unknown as ContractSpec;
      const text = canonicalizeText(specWithExplicitNull);
      expect(text).toContain('"behavior":null');
    });
  });

  describe("known-good tripwire", () => {
    it("produces a known canonical byte sequence for MINIMAL_SPEC", () => {
      // This tripwire is the ground truth for the canonical encoding of MINIMAL_SPEC.
      // If it changes, the content-address scheme has changed and all existing ids
      // are invalidated. Update only with explicit intent.
      const text = canonicalizeText(MINIMAL_SPEC);
      // Verify structure of the canonical JSON (stable properties)
      expect(text.startsWith("{")).toBe(true);
      expect(text.endsWith("}")).toBe(true);
      // Verify first key is "behavior" (lexicographically first among ContractSpec keys)
      expect(text.startsWith('{"behavior":')).toBe(true);
      // Verify the full canonical text matches our reference
      const expectedText =
        '{"behavior":"Parse a JSON array of integers from a string.",' +
        '"errorConditions":[{"description":"Throws SyntaxError on malformed input.","errorType":"SyntaxError"}],' +
        '"guarantees":[{"description":"Rejects non-integer values.","id":"rejects-non-int"}],' +
        '"inputs":[{"description":"raw input","name":"s","type":"string"}],' +
        '"nonFunctional":{"purity":"pure","space":"O(n)","threadSafety":"safe","time":"O(n)"},' +
        '"outputs":[{"name":"result","type":"number[]"}],' +
        '"propertyTests":[{"arbitraries":["fc.array(fc.integer())"],' +
        '"description":"parse(serialize(xs)) deep-equals xs for valid int arrays.",' +
        '"id":"round-trip"}]}';
      expect(text).toBe(expectedText);
    });
  });

  describe("invalid number handling", () => {
    it("throws TypeError for NaN in a nested numeric field", () => {
      // ContractSpec has no numeric fields today, but we can test the encoder
      // directly via canonicalizeText with a cast to prove the guard works.
      // We construct a spec-shaped object with NaN injected.
      const specWithNaN = {
        ...MINIMAL_SPEC,
        // Inject NaN via an unknown cast — in real usage this would be a type error
        behavior: NaN,
      } as unknown as ContractSpec;
      expect(() => canonicalizeText(specWithNaN)).toThrow(TypeError);
    });

    it("throws TypeError for Infinity in a nested numeric field", () => {
      const specWithInfinity = {
        ...MINIMAL_SPEC,
        behavior: Infinity,
      } as unknown as ContractSpec;
      expect(() => canonicalizeText(specWithInfinity)).toThrow(TypeError);
    });
  });

  describe("scientific notation tripwire (CANON-ENCNUM-SCI-001)", () => {
    it("encodeNumber throws for values that JSON.stringify renders in scientific notation", () => {
      // 5e-7 is a representative value that triggers scientific notation in JSON.stringify.
      // ContractSpec has no numeric fields today; this test guards against future
      // schema additions that would silently break determinism.
      expect(() => __testing__.encodeNumber(5e-7)).toThrow(TypeError);
      expect(() => __testing__.encodeNumber(5e-7)).toThrow(/scientific notation/);
    });

    it("encodeNumber throws for large-magnitude scientific notation values", () => {
      // 1e21 is where V8 switches to scientific notation for integers.
      // Number.isInteger(1e21) === true so it takes the integer path, but
      // String(1e21) === "1e+21". Verify the guard catches it.
      expect(() => __testing__.encodeNumber(1e21)).toThrow(TypeError);
      expect(() => __testing__.encodeNumber(1e21)).toThrow(/scientific notation/);
    });

    it("encodeNumber does NOT throw for ordinary fixed-decimal values", () => {
      expect(__testing__.encodeNumber(0.5)).toBe("0.5");
      expect(__testing__.encodeNumber(1.25)).toBe("1.25");
      expect(__testing__.encodeNumber(-3.14)).toBe("-3.14");
    });
  });
});
