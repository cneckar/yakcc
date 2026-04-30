/**
 * Public-API smoke tests, bounds, idempotence, and symmetry for @yakcc/variance.
 *
 * Production sequence exercised:
 *   caller builds two SpecYak values → compareDimensions → varianceScore →
 *   VarianceResult consumed by WI-012/WI-014 callers.
 *
 * Compound interaction: varianceScore internally calls compareDimensions and
 * applies the weight vector, crossing the scorer boundary and the aggregation
 * boundary in a single call, exercising the real production sequence end-to-end.
 */

import type { SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DIMENSION_WEIGHTS,
  applyContractDesignRules,
  compareDimensions,
  mapCweFamily,
  varianceScore,
} from "./index.js";

// ---------------------------------------------------------------------------
// Minimal-valid SpecYak arbitrary
// ---------------------------------------------------------------------------

/**
 * fc.Arbitrary<SpecYak> producing structurally valid specs with varied field
 * contents. Optional v0-lift fields (errorConditions, nonFunctional, behavior)
 * are included probabilistically to exercise optional-field branches.
 */
function specYakArbitrary(): fc.Arbitrary<SpecYak> {
  const paramArb = fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    type: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
  });

  const errorCondArb = fc.record({
    description: fc.string({ minLength: 1, maxLength: 60 }),
    errorType: fc.option(fc.constantFrom("TypeError", "RangeError", "SyntaxError"), {
      nil: undefined,
    }),
  });

  const nonFunctionalArb = fc.option(
    fc.record({
      purity: fc.constantFrom(
        "pure" as const,
        "io" as const,
        "stateful" as const,
        "nondeterministic" as const,
      ),
      threadSafety: fc.constantFrom("safe" as const, "unsafe" as const, "sequential" as const),
      time: fc.option(fc.constantFrom("O(1)", "O(n)", "O(n log n)"), { nil: undefined }),
      space: fc.option(fc.constantFrom("O(1)", "O(n)"), { nil: undefined }),
    }),
    { nil: undefined },
  );

  return fc.record({
    name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    inputs: fc.array(paramArb, { minLength: 0, maxLength: 3 }),
    outputs: fc.array(paramArb, { minLength: 0, maxLength: 2 }),
    preconditions: fc.array(
      fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
      { minLength: 0, maxLength: 3 },
    ),
    postconditions: fc.array(
      fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
      { minLength: 0, maxLength: 3 },
    ),
    invariants: fc.array(
      fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
      { minLength: 0, maxLength: 3 },
    ),
    effects: fc.array(
      fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
      { minLength: 0, maxLength: 2 },
    ),
    level: fc.constantFrom("L0" as const, "L1" as const, "L2" as const, "L3" as const),
    behavior: fc.option(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
      { nil: undefined },
    ),
    errorConditions: fc.option(fc.array(errorCondArb, { minLength: 0, maxLength: 3 }), {
      nil: undefined,
    }),
    nonFunctional: nonFunctionalArb,
  });
}

// ---------------------------------------------------------------------------
// DIMENSION_WEIGHTS invariant
// ---------------------------------------------------------------------------

describe("DIMENSION_WEIGHTS", () => {
  it("sums to 1.0 within 1e-9", () => {
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });

  it("contains exactly the 5 canonical dimensions", () => {
    const keys = Object.keys(DIMENSION_WEIGHTS).sort();
    expect(keys).toEqual(["behavioral", "error_handling", "interface", "performance", "security"]);
  });

  it("all individual weights are positive", () => {
    for (const [dim, w] of Object.entries(DIMENSION_WEIGHTS)) {
      expect(w, `weight for ${dim}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// compareDimensions — bounds
// ---------------------------------------------------------------------------

describe("compareDimensions", () => {
  it("all dimensions in [0, 1] for arbitrary spec pairs (property)", () => {
    fc.assert(
      fc.property(specYakArbitrary(), specYakArbitrary(), (a, b) => {
        const d = compareDimensions(a, b);
        for (const [dim, score] of Object.entries(d)) {
          expect(score, `${dim} out of [0,1]`).toBeGreaterThanOrEqual(0);
          expect(score, `${dim} out of [0,1]`).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("identical spec → all dimensions are 1.0", () => {
    const spec: SpecYak = {
      name: "test",
      inputs: [{ name: "x", type: "number" }],
      outputs: [{ name: "result", type: "number" }],
      preconditions: ["x > 0"],
      postconditions: ["result > x"],
      invariants: [],
      effects: [],
      level: "L0",
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      errorConditions: [{ description: "throws on negative", errorType: "RangeError" }],
    };
    const d = compareDimensions(spec, spec);
    expect(d.security).toBe(1);
    expect(d.behavioral).toBe(1);
    expect(d.error_handling).toBe(1);
    expect(d.performance).toBe(1);
    expect(d.interface).toBe(1);
  });

  it("empty-empty postconditions → behavioral = 1.0", () => {
    const base = (): SpecYak => ({
      name: "empty",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
    });
    const d = compareDimensions(base(), base());
    expect(d.behavioral).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// varianceScore — idempotence (self-score = 1.0)
// ---------------------------------------------------------------------------

describe("varianceScore — idempotence", () => {
  it("varianceScore(a, a).score === 1.0 for any valid SpecYak (property)", () => {
    fc.assert(
      fc.property(specYakArbitrary(), (spec) => {
        const result = varianceScore(spec, spec);
        expect(result.score).toBeCloseTo(1.0, 10);
      }),
      { numRuns: 200 },
    );
  });

  it("varianceScore(a, a).score === 1.0 for concrete spec with all fields", () => {
    const spec: SpecYak = {
      name: "parseIntList",
      inputs: [{ name: "raw", type: "string" }],
      outputs: [{ name: "nums", type: "number[]" }],
      preconditions: ["raw is comma-separated integers"],
      postconditions: ["each element is a finite integer"],
      invariants: ["output length matches input count"],
      effects: [],
      level: "L0",
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(n)" },
      errorConditions: [
        { description: "throws SyntaxError on malformed input", errorType: "SyntaxError" },
      ],
      behavior: "Parses a comma-separated string into an array of integers.",
    };
    const result = varianceScore(spec, spec);
    expect(result.score).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// varianceScore — symmetry
// ---------------------------------------------------------------------------

describe("varianceScore — symmetry", () => {
  it("varianceScore(a, b).score === varianceScore(b, a).score for all generated pairs (property)", () => {
    fc.assert(
      fc.property(specYakArbitrary(), specYakArbitrary(), (a, b) => {
        const ab = varianceScore(a, b);
        const ba = varianceScore(b, a);
        expect(ab.score).toBeCloseTo(ba.score, 10);
      }),
      { numRuns: 200 },
    );
  });

  it("symmetry holds for concrete pair", () => {
    const a: SpecYak = {
      name: "a",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "y", type: "number" }],
      preconditions: ["x is non-empty"],
      postconditions: ["y is finite"],
      invariants: [],
      effects: [],
      level: "L0",
    };
    const b: SpecYak = {
      name: "b",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "y", type: "number" }],
      preconditions: [],
      postconditions: ["y is finite", "y >= 0"],
      invariants: [],
      effects: [],
      level: "L0",
    };
    expect(varianceScore(a, b).score).toBeCloseTo(varianceScore(b, a).score, 10);
  });
});

// ---------------------------------------------------------------------------
// varianceScore — score in [0, 1] (property)
// ---------------------------------------------------------------------------

describe("varianceScore — bounds", () => {
  it("score always in [0, 1] for arbitrary spec pairs (property)", () => {
    fc.assert(
      fc.property(specYakArbitrary(), specYakArbitrary(), (a, b) => {
        const r = varianceScore(a, b);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// varianceScore — custom weights validation
// ---------------------------------------------------------------------------

describe("varianceScore — custom weights", () => {
  it("accepts valid custom weights summing to 1.0", () => {
    const spec: SpecYak = {
      name: "x",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
    };
    const result = varianceScore(spec, spec, {
      weights: {
        security: 0.2,
        behavioral: 0.2,
        error_handling: 0.2,
        performance: 0.2,
        interface: 0.2,
      },
    });
    expect(result.score).toBeCloseTo(1.0, 10);
  });

  it("throws RangeError when custom weights do not sum to 1.0", () => {
    const spec: SpecYak = {
      name: "x",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
    };
    expect(() =>
      varianceScore(spec, spec, {
        weights: {
          security: 0.5,
          behavioral: 0.5,
          error_handling: 0.5,
          performance: 0.0,
          interface: 0.0,
        },
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when custom weights are missing a dimension", () => {
    const spec: SpecYak = {
      name: "x",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
    };
    expect(() =>
      varianceScore(spec, spec, {
        weights: {
          security: 1.0,
        } as Parameters<typeof varianceScore>[2] extends { weights?: infer W }
          ? NonNullable<W>
          : never,
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: full production sequence end-to-end
// ---------------------------------------------------------------------------

describe("compound interaction — production sequence", () => {
  it("varianceScore internally invokes compareDimensions and weight aggregation correctly", () => {
    // Two specs that differ only in postconditions.
    // security: identical CWE profile → security = 1.0
    // behavioral: one postcondition shared, one extra in b → jaccard = 1/2
    // error_handling: both absent → 1.0
    // performance: both absent → 1.0
    // interface: identical → 1.0
    const shared = "result is finite";
    const a: SpecYak = {
      name: "a",
      inputs: [{ name: "n", type: "number" }],
      outputs: [{ name: "result", type: "number" }],
      preconditions: [],
      postconditions: [shared],
      invariants: [],
      effects: [],
      level: "L0",
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    };
    const b: SpecYak = {
      ...a,
      postconditions: [shared, "result > 0"],
    };

    const result = varianceScore(a, b);

    // security: both have same effect/purity profile → CWE-474 present on both (no effects, pure),
    // CWE-440 clear on both (postconditions exist), CWE-573 clear on both (no preconditions → CWE-573 present on both)
    // Let's verify via mapCweFamily
    const cweA = mapCweFamily(a);
    const cweB = mapCweFamily(b);
    // Both have same CWE profile → security = 1.0
    expect(cweA.cwesPresent).toEqual(cweB.cwesPresent);

    // behavioral: jaccard({shared}, {shared, "result > 0"}) = 1/2
    expect(result.dimensions.behavioral).toBeCloseTo(1 / 2, 10);

    // composite score = 0.35*1 + 0.25*0.5 + 0.20*1 + 0.10*1 + 0.10*1
    const expectedScore =
      DIMENSION_WEIGHTS.security * 1.0 +
      DIMENSION_WEIGHTS.behavioral * (1 / 2) +
      DIMENSION_WEIGHTS.error_handling * 1.0 +
      DIMENSION_WEIGHTS.performance * 1.0 +
      DIMENSION_WEIGHTS.interface * 1.0;
    expect(result.score).toBeCloseTo(expectedScore, 10);
  });
});
