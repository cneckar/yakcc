import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { __testing__, canonicalize, canonicalizeQueryText, canonicalizeText } from "./canonicalize.js";
import type { ContractSpec, QueryIntentCard } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string", description: "raw input" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers from a string.",
  guarantees: [{ id: "rejects-non-int", description: "Rejects non-integer values." }],
  errorConditions: [
    { description: "Throws SyntaxError on malformed input.", errorType: "SyntaxError" },
  ],
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
    errorConditions: [
      { errorType: "SyntaxError", description: "Throws SyntaxError on malformed input." },
    ],
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
      expect(parsed.errorConditions.map((e) => e.description)).toEqual([
        "first",
        "second",
        "third",
      ]);
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
      const inputs = parsed.inputs as Array<Record<string, unknown>>;
      expect(Object.prototype.hasOwnProperty.call(inputs[0], "description")).toBe(false);

      // nonFunctional should have no time or space keys
      const nf = parsed.nonFunctional as Record<string, unknown>;
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
        behavior: Number.NaN,
      } as unknown as ContractSpec;
      expect(() => canonicalizeText(specWithNaN)).toThrow(TypeError);
    });

    it("throws TypeError for Infinity in a nested numeric field", () => {
      const specWithInfinity = {
        ...MINIMAL_SPEC,
        behavior: Number.POSITIVE_INFINITY,
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

// ---------------------------------------------------------------------------
// canonicalizeQueryText — DEC-V3-IMPL-QUERY-001
// Tests: 6 dimension projections + safe-defaults + omitted-dimension rule
// ---------------------------------------------------------------------------

describe("canonicalizeQueryText", () => {
  // @decision DEC-V3-IMPL-QUERY-001
  // title: Symmetric query-text derivation via canonicalizeQueryText
  // status: accepted
  // rationale: canonicalizeQueryText projects a QueryIntentCard into a
  //   SpecYak-shaped canonical text so that query and document vectors are in
  //   the same semantic space. Each provided dimension field maps to the
  //   corresponding SpecYak optional field. Absent fields are omitted from the
  //   projection so they don't introduce noise in the embedding.

  it("projects behavior dimension into canonical text", () => {
    const card: QueryIntentCard = {
      behavior: "parse an integer from a string",
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["behavior"]).toBe("parse an integer from a string");
  });

  it("projects guarantees dimension as description array", () => {
    const card: QueryIntentCard = {
      guarantees: ["always returns a number", "never returns NaN"],
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as { guarantees?: Array<{ id: string; description: string }> };
    expect(parsed.guarantees).toHaveLength(2);
    expect(parsed.guarantees?.[0]?.description).toBe("always returns a number");
    expect(parsed.guarantees?.[1]?.description).toBe("never returns NaN");
    // ids are synthetic sentinels
    expect(parsed.guarantees?.[0]?.id).toBe("q0");
    expect(parsed.guarantees?.[1]?.id).toBe("q1");
  });

  it("projects errorConditions dimension as description array", () => {
    const card: QueryIntentCard = {
      errorConditions: ["throws RangeError when out of bounds"],
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as {
      errorConditions?: Array<{ description: string }>;
    };
    expect(parsed.errorConditions).toHaveLength(1);
    expect(parsed.errorConditions?.[0]?.description).toBe("throws RangeError when out of bounds");
  });

  it("projects nonFunctional dimension as spec-shaped object", () => {
    const card: QueryIntentCard = {
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as {
      nonFunctional?: { purity: string; threadSafety: string };
    };
    expect(parsed.nonFunctional?.purity).toBe("pure");
    expect(parsed.nonFunctional?.threadSafety).toBe("safe");
  });

  it("projects propertyTests dimension as description array", () => {
    const card: QueryIntentCard = {
      propertyTests: ["output equals reverse(reverse(output))"],
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as {
      propertyTests?: Array<{ id: string; description: string }>;
    };
    expect(parsed.propertyTests).toHaveLength(1);
    expect(parsed.propertyTests?.[0]?.description).toBe("output equals reverse(reverse(output))");
    expect(parsed.propertyTests?.[0]?.id).toBe("p0");
  });

  it("projects signature dimension as inputs/outputs arrays", () => {
    const card: QueryIntentCard = {
      signature: {
        inputs: [{ type: "string" }, { name: "radix", type: "number" }],
        outputs: [{ type: "number" }],
      },
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as {
      inputs?: Array<{ name: string; type: string }>;
      outputs?: Array<{ name: string; type: string }>;
    };
    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.inputs?.[0]?.type).toBe("string");
    expect(parsed.inputs?.[0]?.name).toBe("arg0"); // sentinel for absent name
    expect(parsed.inputs?.[1]?.name).toBe("radix");
    expect(parsed.outputs?.[0]?.type).toBe("number");
  });

  it("omits absent dimensions from the projection (safe-defaults rule)", () => {
    const card: QueryIntentCard = {
      behavior: "multiply two numbers",
      // guarantees, errorConditions, nonFunctional, propertyTests, signature all absent
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["behavior"]).toBe("multiply two numbers");
    expect(Object.prototype.hasOwnProperty.call(parsed, "guarantees")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "errorConditions")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "nonFunctional")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "propertyTests")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "inputs")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "outputs")).toBe(false);
  });

  it("safe-default: empty card produces minimal canonical text (no crash)", () => {
    const card: QueryIntentCard = {};
    // Should not throw; produces at minimum an empty object or minimal structure
    expect(() => canonicalizeQueryText(card)).not.toThrow();
    const text = canonicalizeQueryText(card);
    expect(typeof text).toBe("string");
    // Parse must succeed
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("produces deterministic output for the same card", () => {
    const card: QueryIntentCard = {
      behavior: "sort an array",
      guarantees: ["output is sorted ascending"],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    };
    const t1 = canonicalizeQueryText(card);
    const t2 = canonicalizeQueryText(card);
    expect(t1).toBe(t2);
  });

  it("keys in canonical text are sorted lexicographically", () => {
    const card: QueryIntentCard = {
      behavior: "compute hash",
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)" },
      guarantees: ["output is 32 bytes"],
    };
    const text = canonicalizeQueryText(card);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });
});
