/**
 * Per-dimension scorer property tests for @yakcc/variance.
 *
 * Tests each of the 5 dimension scorers via compareDimensions, exercising
 * boundary conditions, both-absent cases, one-absent cases, and Jaccard
 * exact-value checks.
 */

import type { SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareDimensions } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minSpec(overrides: Partial<SpecYak> = {}): SpecYak {
  return {
    name: "test",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Security dimension
// ---------------------------------------------------------------------------

describe("security dimension", () => {
  it("identical specs → security = 1.0", () => {
    const spec: SpecYak = {
      name: "x",
      inputs: [],
      outputs: [],
      preconditions: ["x > 0"],
      postconditions: ["y > 0"],
      invariants: [],
      effects: [],
      level: "L0",
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      errorConditions: [{ description: "throws on negative" }],
    };
    const d = compareDimensions(spec, spec);
    expect(d.security).toBe(1);
  });

  it("security always in [0, 1] (property)", () => {
    const specArb = fc.record({
      name: fc.constant("t"),
      inputs: fc.constant([]),
      outputs: fc.constant([]),
      preconditions: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
      postconditions: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
      invariants: fc.constant([]),
      effects: fc.array(fc.string({ minLength: 1 }), { maxLength: 1 }),
      level: fc.constant("L0" as const),
      nonFunctional: fc.option(
        fc.record({
          purity: fc.constantFrom("pure" as const, "io" as const),
          threadSafety: fc.constant("safe" as const),
        }),
        { nil: undefined },
      ),
      errorConditions: fc.option(
        fc.array(fc.record({ description: fc.string({ minLength: 1 }) }), { maxLength: 2 }),
        { nil: undefined },
      ),
    });
    fc.assert(
      fc.property(specArb, specArb, (a, b) => {
        const d = compareDimensions(a, b);
        expect(d.security).toBeGreaterThanOrEqual(0);
        expect(d.security).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it("security symmetry: score(a,b) === score(b,a) (property)", () => {
    const specArb = fc.record({
      name: fc.constant("t"),
      inputs: fc.constant([]),
      outputs: fc.constant([]),
      preconditions: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
      postconditions: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
      invariants: fc.constant([]),
      effects: fc.array(fc.string({ minLength: 1 }), { maxLength: 1 }),
      level: fc.constant("L0" as const),
    });
    fc.assert(
      fc.property(specArb, specArb, (a, b) => {
        expect(compareDimensions(a, b).security).toBeCloseTo(compareDimensions(b, a).security, 10);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral dimension (Jaccard over postconditions)
// ---------------------------------------------------------------------------

describe("behavioral dimension", () => {
  it("both-empty postconditions → behavioral = 1.0", () => {
    const d = compareDimensions(minSpec(), minSpec());
    expect(d.behavioral).toBe(1);
  });

  it("one-empty postconditions → behavioral = 0.0", () => {
    const a = minSpec({ postconditions: [] });
    const b = minSpec({ postconditions: ["result >= 0"] });
    expect(compareDimensions(a, b).behavioral).toBe(0);
    expect(compareDimensions(b, a).behavioral).toBe(0);
  });

  it("identical postconditions → behavioral = 1.0", () => {
    const a = minSpec({ postconditions: ["result >= 0", "result is finite"] });
    const b = minSpec({ postconditions: ["result >= 0", "result is finite"] });
    expect(compareDimensions(a, b).behavioral).toBeCloseTo(1, 10);
  });

  it("disjoint postconditions → behavioral = 0.0", () => {
    const a = minSpec({ postconditions: ["result > 0"] });
    const b = minSpec({ postconditions: ["result < 0"] });
    // jaccard({normalized(>0)}, {normalized(<0)}) — different strings, intersection=0, union=2
    expect(compareDimensions(a, b).behavioral).toBe(0);
  });

  it("partial overlap: jaccard = |A∩B| / |A∪B|", () => {
    const shared = "result is finite";
    const a = minSpec({ postconditions: [shared, "result > 0"] });
    const b = minSpec({ postconditions: [shared, "result < 100"] });
    // intersection = {shared}, union = {shared, result > 0, result < 100} → 1/3
    expect(compareDimensions(a, b).behavioral).toBeCloseTo(1 / 3, 10);
  });

  it("normalization: same text with different casing/spacing → behavioral = 1.0", () => {
    const a = minSpec({ postconditions: ["Result Is Finite."] });
    const b = minSpec({ postconditions: ["result is finite"] });
    expect(compareDimensions(a, b).behavioral).toBeCloseTo(1, 10);
  });

  // F-WI011-001: behavioral monotonicity — adding the same postcondition to both sides must not
  // decrease the behavioral score. The Jaccard numerator (intersection) grows at least as fast
  // as the denominator (union) when a shared element is added, so the score is non-decreasing.
  it("monotonicity: adding same postcondition to both sides does not decrease behavioral score (property)", () => {
    const specArb = fc.record({
      name: fc.constant("t"),
      inputs: fc.constant([]),
      outputs: fc.constant([]),
      preconditions: fc.constant([]),
      postconditions: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 3 }),
      invariants: fc.constant([]),
      effects: fc.constant([]),
      level: fc.constant("L0" as const),
    });
    const postconditionArb = fc.string({ minLength: 1, maxLength: 30 });
    fc.assert(
      fc.property(specArb, specArb, postconditionArb, (canonical, candidate, p) => {
        const before = compareDimensions(canonical, candidate).behavioral;
        const canonicalPlus = {
          ...canonical,
          postconditions: [...canonical.postconditions, p],
        };
        const candidatePlus = {
          ...candidate,
          postconditions: [...candidate.postconditions, p],
        };
        const after = compareDimensions(canonicalPlus, candidatePlus).behavioral;
        // Adding the same postcondition to both sides: Jaccard(A∪{p}, B∪{p}) >= Jaccard(A, B)
        expect(after).toBeGreaterThanOrEqual(before - 1e-12); // 1e-12 tolerance for floating-point
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Error-handling dimension
// ---------------------------------------------------------------------------

describe("error_handling dimension", () => {
  it("both-absent errorConditions → 1.0", () => {
    const a = minSpec({ errorConditions: undefined });
    const b = minSpec({ errorConditions: undefined });
    expect(compareDimensions(a, b).error_handling).toBe(1);
  });

  it("both-empty errorConditions arrays → 1.0", () => {
    const a = minSpec({ errorConditions: [] });
    const b = minSpec({ errorConditions: [] });
    expect(compareDimensions(a, b).error_handling).toBe(1);
  });

  it("one-absent errorConditions → 0.0", () => {
    const a = minSpec({ errorConditions: undefined });
    const b = minSpec({ errorConditions: [{ description: "throws on null" }] });
    expect(compareDimensions(a, b).error_handling).toBe(0);
    expect(compareDimensions(b, a).error_handling).toBe(0);
  });

  it("identical error conditions → 1.0", () => {
    const errs = [
      { description: "throws RangeError on negative", errorType: "RangeError" as const },
    ];
    const a = minSpec({ errorConditions: errs });
    const b = minSpec({ errorConditions: errs });
    expect(compareDimensions(a, b).error_handling).toBeCloseTo(1, 10);
  });

  it("disjoint descriptions → error_handling = 0 (desc) + 1 (types if both empty) * 0.3", () => {
    const a = minSpec({ errorConditions: [{ description: "throws on null" }] });
    const b = minSpec({ errorConditions: [{ description: "throws on overflow" }] });
    // descScore = jaccard({null},{overflow}) = 0; both have no errorType → typeScore = 1
    // total = 0.7 * 0 + 0.3 * 1 = 0.3
    expect(compareDimensions(a, b).error_handling).toBeCloseTo(0.3, 10);
  });

  it("error_handling always in [0, 1] (property)", () => {
    const errArb = fc.option(
      fc.array(
        fc.record({
          description: fc.string({ minLength: 1, maxLength: 40 }),
          errorType: fc.option(fc.constantFrom("TypeError", "RangeError"), { nil: undefined }),
        }),
        { minLength: 0, maxLength: 3 },
      ),
      { nil: undefined },
    );
    fc.assert(
      fc.property(errArb, errArb, (eA, eB) => {
        const a = minSpec({ errorConditions: eA ?? undefined });
        const b = minSpec({ errorConditions: eB ?? undefined });
        const d = compareDimensions(a, b);
        expect(d.error_handling).toBeGreaterThanOrEqual(0);
        expect(d.error_handling).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Performance dimension
// ---------------------------------------------------------------------------

describe("performance dimension", () => {
  it("both nonFunctional absent → 1.0", () => {
    const d = compareDimensions(minSpec(), minSpec());
    expect(d.performance).toBe(1);
  });

  it("one nonFunctional absent → 0.0", () => {
    const a = minSpec();
    const b = minSpec({ nonFunctional: { purity: "pure", threadSafety: "safe" } });
    expect(compareDimensions(a, b).performance).toBe(0);
    expect(compareDimensions(b, a).performance).toBe(0);
  });

  it("both present with matching time and space → 1.0", () => {
    const nf = {
      purity: "pure" as const,
      threadSafety: "safe" as const,
      time: "O(n)",
      space: "O(1)",
    };
    const a = minSpec({ nonFunctional: nf });
    const b = minSpec({ nonFunctional: nf });
    expect(compareDimensions(a, b).performance).toBeCloseTo(1, 10);
  });

  it("both present with no time/space → 1.0 (both absent within present nonFunctional)", () => {
    const nf = { purity: "pure" as const, threadSafety: "safe" as const };
    const a = minSpec({ nonFunctional: nf });
    const b = minSpec({ nonFunctional: nf });
    expect(compareDimensions(a, b).performance).toBeCloseTo(1, 10);
  });

  it("time matches, space mismatches → 0.5", () => {
    const a = minSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    });
    const b = minSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(n)" },
    });
    // timeScore = 1 (match), spaceScore = 0 (mismatch) → 0.5
    expect(compareDimensions(a, b).performance).toBeCloseTo(0.5, 10);
  });

  it("time absent on one side → time contributes 0", () => {
    const a = minSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    });
    const b = minSpec({ nonFunctional: { purity: "pure", threadSafety: "safe", space: "O(1)" } });
    // timeScore = 0 (one absent), spaceScore = 1 (match) → 0.5
    expect(compareDimensions(a, b).performance).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// Interface dimension
// ---------------------------------------------------------------------------

describe("interface dimension", () => {
  it("both-empty inputs and outputs → interface = 1.0", () => {
    const d = compareDimensions(minSpec(), minSpec());
    expect(d.interface).toBe(1);
  });

  it("identical inputs and outputs → interface = 1.0", () => {
    const a: SpecYak = {
      ...minSpec(),
      inputs: [
        { name: "x", type: "number" },
        { name: "y", type: "string" },
      ],
      outputs: [{ name: "result", type: "boolean" }],
    };
    expect(compareDimensions(a, a).interface).toBeCloseTo(1, 10);
  });

  it("completely disjoint inputs → interface = 0.0 (when outputs also disjoint)", () => {
    const a: SpecYak = {
      ...minSpec(),
      inputs: [{ name: "foo", type: "string" }],
      outputs: [{ name: "bar", type: "number" }],
    };
    const b: SpecYak = {
      ...minSpec(),
      inputs: [{ name: "baz", type: "boolean" }],
      outputs: [{ name: "qux", type: "string" }],
    };
    expect(compareDimensions(a, b).interface).toBe(0);
  });

  it("partial input overlap, no output → uses 0.5 * jaccard weighting", () => {
    const a: SpecYak = {
      ...minSpec(),
      inputs: [
        { name: "x", type: "number" },
        { name: "y", type: "string" },
      ],
      outputs: [],
    };
    const b: SpecYak = {
      ...minSpec(),
      inputs: [
        { name: "x", type: "number" },
        { name: "z", type: "boolean" },
      ],
      outputs: [],
    };
    // inJaccard = 1/3 (x::number shared, y::string and z::boolean unique)
    // outJaccard = 1.0 (both empty)
    // interface = 0.5 * (1/3) + 0.5 * 1.0 = 1/6 + 0.5 ≈ 0.667
    expect(compareDimensions(a, b).interface).toBeCloseTo(0.5 * (1 / 3) + 0.5 * 1.0, 10);
  });

  it("interface always in [0, 1] (property)", () => {
    const paramArb = fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
        type: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
      }),
      { maxLength: 3 },
    );
    fc.assert(
      fc.property(paramArb, paramArb, paramArb, paramArb, (inA, outA, inB, outB) => {
        const a: SpecYak = { ...minSpec(), inputs: inA, outputs: outA };
        const b: SpecYak = { ...minSpec(), inputs: inB, outputs: outB };
        const d = compareDimensions(a, b);
        expect(d.interface).toBeGreaterThanOrEqual(0);
        expect(d.interface).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});
