/**
 * applyContractDesignRules property tests for @yakcc/variance.
 *
 * Tests the star-topology merge rules:
 *   safety = ∩, behavioral = majority-vote, capability = ∪
 *
 * Covers: empty-input rejection, N=1 passthrough, N=2 intersection,
 * majority vote threshold, effects union, behavior tie-break, and
 * CWE-clear intersection.
 */

import type { SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyContractDesignRules, mapCweFamily } from "./index.js";

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
// Empty input
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — empty input", () => {
  it("throws RangeError for empty specs array", () => {
    expect(() => applyContractDesignRules([])).toThrow(RangeError);
  });

  it("RangeError message mentions the empty-input policy", () => {
    expect(() => applyContractDesignRules([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// N=1 passthrough
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — N=1", () => {
  it("single spec: preconditions pass through unchanged", () => {
    const spec = minSpec({ preconditions: ["x > 0", "x is finite"] });
    const result = applyContractDesignRules([spec]);
    // After normalization, preconditions appear in intersection
    expect(result.safety.preconditions).toContain("x > 0");
    expect(result.safety.preconditions).toContain("x is finite");
  });

  it("single spec: postconditions pass through as majority vote (1 ≥ ceil(1/2)=1)", () => {
    const spec = minSpec({ postconditions: ["result >= 0", "result is finite"] });
    const result = applyContractDesignRules([spec]);
    // Both postconditions should appear (each has count=1, threshold=1)
    expect(result.behavioral.postconditions).toContain("result >= 0");
    expect(result.behavioral.postconditions).toContain("result is finite");
  });

  it("single spec: effects pass through via union", () => {
    const spec = minSpec({ effects: ["WriteOnly:/tmp/x"] });
    const result = applyContractDesignRules([spec]);
    expect(result.capability.effects).toContain("writeonly:/tmp/x");
  });

  it("single spec: contributorCount = 1", () => {
    const result = applyContractDesignRules([minSpec()]);
    expect(result.source.contributorCount).toBe(1);
  });

  it("single spec with behavior: no tie-break recorded", () => {
    const spec = minSpec({ behavior: "parses integers" });
    const result = applyContractDesignRules([spec]);
    expect(result.behavioral.behavior).toBe("parses integers");
    expect(result.source.tieBreaks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Safety: preconditions = intersection
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — safety (intersection)", () => {
  it("intersection of preconditions keeps only shared items", () => {
    const a = minSpec({ preconditions: ["x > 0", "x is finite"] });
    const b = minSpec({ preconditions: ["x > 0", "x is an integer"] });
    const result = applyContractDesignRules([a, b]);
    expect(result.safety.preconditions).toContain("x > 0");
    expect(result.safety.preconditions).not.toContain("x is finite");
    expect(result.safety.preconditions).not.toContain("x is an integer");
  });

  it("intersection of disjoint preconditions is empty", () => {
    const a = minSpec({ preconditions: ["x > 0"] });
    const b = minSpec({ preconditions: ["y > 0"] });
    const result = applyContractDesignRules([a, b]);
    expect(result.safety.preconditions).toHaveLength(0);
  });

  it("intersection of invariants keeps only shared items", () => {
    const a = minSpec({ invariants: ["state is valid", "count >= 0"] });
    const b = minSpec({ invariants: ["state is valid"] });
    const result = applyContractDesignRules([a, b]);
    expect(result.safety.invariants).toContain("state is valid");
    expect(result.safety.invariants).not.toContain("count >= 0");
  });

  it("CWE-clear intersection: only CWEs clear on ALL specs survive (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
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
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (specs) => {
          const result = applyContractDesignRules(specs);
          // Every CWE in cweClear must be clear in every individual spec
          for (const cwe of result.safety.cweClear) {
            for (const spec of specs) {
              const mapping = mapCweFamily(spec);
              expect(mapping.cwesClear, `CWE ${cwe} should be clear in all specs`).toContain(cwe);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral: majority vote
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — behavioral (majority vote)", () => {
  it("majority vote N=2: postcondition appearing in both survives", () => {
    const shared = "result is finite";
    const a = minSpec({ postconditions: [shared, "result > 0"] });
    const b = minSpec({ postconditions: [shared, "result < 100"] });
    const result = applyContractDesignRules([a, b]);
    // shared appears in 2/2 → survives (threshold=1)
    expect(result.behavioral.postconditions).toContain(shared);
    // "result > 0" appears in 1/2 → fails threshold (ceil(2/2)=1 — wait, 1 >= 1 → survives!)
    // Actually ceil(2/2) = 1, so threshold=1, so ALL postconditions survive for N=2.
    // That's correct: majority vote with N=2 means ≥1 contributor needed.
  });

  it("majority vote N=3: postcondition must appear in ≥ 2 specs (ceil(3/2)=2)", () => {
    const dominant = "result is finite";
    const minor = "result > 1000";
    const a = minSpec({ postconditions: [dominant, minor] });
    const b = minSpec({ postconditions: [dominant] });
    const c = minSpec({ postconditions: [dominant] });
    const result = applyContractDesignRules([a, b, c]);
    // dominant appears 3/3 → survives
    expect(result.behavioral.postconditions).toContain(dominant);
    // minor appears 1/3 < 2 → eliminated
    expect(result.behavioral.postconditions).not.toContain(minor);
  });

  it("majority vote N=4: threshold is ceil(4/2)=2", () => {
    const inMajority = "result is non-null";
    const inMinority = "result has type string";
    const specs = [
      minSpec({ postconditions: [inMajority, inMinority] }),
      minSpec({ postconditions: [inMajority] }),
      minSpec({ postconditions: [inMajority] }),
      minSpec({ postconditions: [] }),
    ];
    const result = applyContractDesignRules(specs);
    // inMajority: 3/4 ≥ 2 → survives
    expect(result.behavioral.postconditions).toContain(inMajority);
    // inMinority: 1/4 < 2 → eliminated
    expect(result.behavioral.postconditions).not.toContain(inMinority);
  });

  it("contributorCount is always the number of input specs (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.constant(minSpec()), { minLength: 1, maxLength: 5 }), (specs) => {
        const result = applyContractDesignRules(specs);
        expect(result.source.contributorCount).toBe(specs.length);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Capability: effects union
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — capability (effects union)", () => {
  it("union includes effects from all specs", () => {
    const a = minSpec({ effects: ["ReadOnly:/data"] });
    const b = minSpec({ effects: ["WriteOnly:/output"] });
    const result = applyContractDesignRules([a, b]);
    expect(result.capability.effects).toContain("readonly:/data");
    expect(result.capability.effects).toContain("writeonly:/output");
  });

  it("duplicate effects are deduplicated in union", () => {
    const a = minSpec({ effects: ["ReadOnly:/data"] });
    const b = minSpec({ effects: ["ReadOnly:/data", "WriteOnly:/output"] });
    const result = applyContractDesignRules([a, b]);
    const count = result.capability.effects.filter((e) => e === "readonly:/data").length;
    expect(count).toBe(1);
  });

  it("no effects in any spec → empty effects in result", () => {
    const a = minSpec({ effects: [] });
    const b = minSpec({ effects: [] });
    const result = applyContractDesignRules([a, b]);
    expect(result.capability.effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Behavior prose tie-break
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — behavior tie-break", () => {
  it("single behavior → no tie-break recorded", () => {
    const a = minSpec({ behavior: "parses integers from string" });
    const b = minSpec(); // no behavior
    const result = applyContractDesignRules([a, b]);
    expect(result.behavioral.behavior).toBe("parses integers from string");
    expect(result.source.tieBreaks).toHaveLength(0);
  });

  it("two distinct behaviors → first lexicographic chosen, tie-break recorded", () => {
    const a = minSpec({ behavior: "zeta behavior" });
    const b = minSpec({ behavior: "alpha behavior" });
    const result = applyContractDesignRules([a, b]);
    expect(result.behavioral.behavior).toBe("alpha behavior");
    expect(result.source.tieBreaks).toHaveLength(1);
    expect(result.source.tieBreaks[0]?.field).toBe("behavior");
    expect(result.source.tieBreaks[0]?.resolution).toBe("first_lexicographic");
  });

  it("no behaviors from any spec → behavior is undefined", () => {
    const specs = [minSpec(), minSpec()];
    const result = applyContractDesignRules(specs);
    expect(result.behavioral.behavior).toBeUndefined();
    expect(result.source.tieBreaks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Star-topology idempotence: merging a spec with itself = that spec's values
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — idempotence", () => {
  it("merging identical specs preserves all preconditions (intersection of identical = original)", () => {
    const spec = minSpec({
      preconditions: ["x > 0", "x is finite"],
      postconditions: ["result >= 0"],
      effects: ["WriteOnly:/tmp"],
    });
    const result = applyContractDesignRules([spec, spec]);
    expect(result.safety.preconditions).toContain("x > 0");
    expect(result.safety.preconditions).toContain("x is finite");
    expect(result.behavioral.postconditions).toContain("result >= 0");
    expect(result.capability.effects).toContain("writeonly:/tmp");
  });
});

// ---------------------------------------------------------------------------
// F-WI011-002: order-independence of applyContractDesignRules
// ---------------------------------------------------------------------------

// Arbitrary SpecYak generator shared across order-independence and concern property tests.
const specYakArb = fc.record({
  name: fc.constant("t"),
  inputs: fc.constant([]),
  outputs: fc.constant([]),
  preconditions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
  postconditions: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
  invariants: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 2 }),
  effects: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 2 }),
  level: fc.constant("L0" as const),
  nonFunctional: fc.option(
    fc.record({
      purity: fc.constantFrom("pure" as const, "io" as const),
      threadSafety: fc.constant("safe" as const),
    }),
    { nil: undefined },
  ),
  errorConditions: fc.option(
    fc.array(fc.record({ description: fc.string({ minLength: 1, maxLength: 20 }) }), {
      maxLength: 2,
    }),
    { nil: undefined },
  ),
});

/**
 * Normalize a MergedContract for stable comparison: sort all string-array fields
 * so that insertion-order differences between forward and reversed inputs do not
 * produce false failures on structurally equal results.
 */
function normalizeResult(r: ReturnType<typeof applyContractDesignRules>): string {
  return JSON.stringify({
    safety: {
      preconditions: [...r.safety.preconditions].sort(),
      invariants: [...r.safety.invariants].sort(),
      cweClear: [...r.safety.cweClear].sort(),
    },
    behavioral: {
      postconditions: [...r.behavioral.postconditions].sort(),
      // behavior prose is not order-dependent by construction (lexicographic tie-break),
      // but the choice may differ when ordering changes the tie-break inputs. Omit to
      // isolate the structural invariants under test.
    },
    capability: {
      effects: [...r.capability.effects].sort(),
    },
    source: {
      contributorCount: r.source.contributorCount,
    },
  });
}

describe("applyContractDesignRules — order-independence", () => {
  // F-WI011-002: The star-topology merge rules (∩, majority-vote, ∪) are all
  // commutative and associative over sets; the output must be the same regardless
  // of input ordering (modulo the lexicographic tie-break on behavior prose, which
  // is excluded from the normalized comparison).
  it("result is the same for forward and reversed input ordering (property)", () => {
    fc.assert(
      fc.property(fc.array(specYakArb, { minLength: 2, maxLength: 5 }), (specs) => {
        const forward = applyContractDesignRules(specs);
        const reversed = applyContractDesignRules([...specs].reverse());
        expect(normalizeResult(forward)).toEqual(normalizeResult(reversed));
      }),
      { numRuns: 200 },
    );
  });

  it("result is the same for shuffled input ordering (property)", () => {
    fc.assert(
      fc.property(
        fc.array(specYakArb, { minLength: 2, maxLength: 5 }),
        fc.integer({ min: 0, max: 999 }),
        (specs, seed) => {
          // Deterministic Fisher-Yates shuffle seeded from fast-check's integer arb.
          const shuffled = [...specs];
          let s = seed;
          for (let i = shuffled.length - 1; i > 0; i--) {
            s = (s * 1664525 + 1013904223) >>> 0; // LCG step
            const j = s % (i + 1);
            // Avoid non-null assertions: copy to temp vars (both indices are in-bounds by loop invariant)
            const tmp = shuffled[i];
            shuffled[i] = shuffled[j] as (typeof shuffled)[number];
            shuffled[j] = tmp as (typeof shuffled)[number];
          }
          const forward = applyContractDesignRules(specs);
          const shuffledResult = applyContractDesignRules(shuffled);
          expect(normalizeResult(forward)).toEqual(normalizeResult(shuffledResult));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// F-WI011-003: Safety subset, capability superset, CWE determinism (property)
// ---------------------------------------------------------------------------

describe("applyContractDesignRules — structural invariants (property)", () => {
  // Mirror the implementation's normalize function exactly so that property tests
  // can compare normalized forms without re-implementing the algorithm differently.
  // Implementation: lowercase → collapse whitespace → trim → strip trailing [.;!?,]+
  const implNormalize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.;!?,]+$/, "");

  // Safety preconditions subset: every precondition in the result must appear
  // in every input spec's preconditions (after normalization). The intersection
  // definition guarantees result.safety.preconditions ⊆ each spec's normalized
  // precondition set. Result values are already normalized by the implementation,
  // so we compare them directly against each spec's normalized precondition set.
  it("safety.preconditions ⊆ every input spec's preconditions (property)", () => {
    fc.assert(
      fc.property(fc.array(specYakArb, { minLength: 1, maxLength: 4 }), (specs) => {
        const result = applyContractDesignRules(specs);
        for (const resultPre of result.safety.preconditions) {
          // resultPre is already normalized by the implementation
          for (const spec of specs) {
            const specNormalized = spec.preconditions.map(implNormalize);
            expect(
              specNormalized,
              `precondition "${resultPre}" in result must appear in every input spec`,
            ).toContain(resultPre);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // Capability superset: every effect from every input spec must appear in the
  // result's capability.effects. The union definition guarantees each spec's
  // effects ⊆ result.capability.effects (after normalization). Result values are
  // already normalized by the implementation; we normalize input effects to match.
  it("every input spec's effects ⊆ result.capability.effects (property)", () => {
    fc.assert(
      fc.property(fc.array(specYakArb, { minLength: 1, maxLength: 4 }), (specs) => {
        const result = applyContractDesignRules(specs);
        const resultEffects = new Set(result.capability.effects);
        for (const spec of specs) {
          for (const effect of spec.effects) {
            const normalizedEffect = implNormalize(effect);
            expect(
              resultEffects,
              `effect "${effect}" (normalized: "${normalizedEffect}") from input spec must appear in result capability.effects`,
            ).toSatisfy((s: Set<string>) => s.has(normalizedEffect));
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // CWE determinism: calling mapCweFamily twice on the same spec must return
  // deeply equal results. Guards against accidental Set-iteration-order bugs.
  it("mapCweFamily is deterministic — two calls return deeply equal results (property)", () => {
    fc.assert(
      fc.property(specYakArb, (spec) => {
        const first = mapCweFamily(spec);
        const second = mapCweFamily(spec);
        expect([...first.cwesPresent].sort()).toEqual([...second.cwesPresent].sort());
        expect([...first.cwesClear].sort()).toEqual([...second.cwesClear].sort());
      }),
      { numRuns: 200 },
    );
  });
});
