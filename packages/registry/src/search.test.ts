/**
 * search.test.ts — unit tests for structuralMatch().
 *
 * structuralMatch is a pure function: no DB, no I/O.
 * Tests cover:
 *   - Identical specs match
 *   - Input/output type divergence produces false with reasons
 *   - Candidate extra error conditions produce false
 *   - Monotonicity: relaxing caller requirements never turns true → false
 *
 * Production sequence: search() in storage.ts calls structuralMatch per
 * vec0 candidate, then discards candidates where matches === false.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { ContractSpec } from "@yakcc/contracts";
import { structuralMatch } from "./search.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A minimal ContractSpec for test fixtures. */
function makeSpec(overrides: Partial<ContractSpec> = {}): ContractSpec {
  return {
    inputs: [{ name: "value", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    behavior: "Parse an integer from a string",
    guarantees: [{ id: "total", description: "Always returns or throws." }],
    errorConditions: [
      {
        description: "Throws on invalid input",
        errorType: "SyntaxError",
      },
    ],
    nonFunctional: {
      purity: "pure",
      threadSafety: "safe",
      time: "O(n)",
      space: "O(1)",
    },
    propertyTests: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identical specs
// ---------------------------------------------------------------------------

describe("structuralMatch — identical specs", () => {
  it("matches when caller and candidate are identical", () => {
    const spec = makeSpec();
    const result = structuralMatch(spec, spec);
    expect(result.matches).toBe(true);
  });

  it("matches with different behavior text (behavior is not structurally checked)", () => {
    const caller = makeSpec({ behavior: "Parse integer" });
    const candidate = makeSpec({ behavior: "Completely different description" });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input type mismatches
// ---------------------------------------------------------------------------

describe("structuralMatch — input type mismatches", () => {
  it("returns false when input types differ", () => {
    const caller = makeSpec({
      inputs: [{ name: "value", type: "string" }],
    });
    const candidate = makeSpec({
      inputs: [{ name: "value", type: "number" }],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons.some((r) => r.includes("type mismatch"))).toBe(true);
    }
  });

  it("returns false when input names differ", () => {
    const caller = makeSpec({
      inputs: [{ name: "value", type: "string" }],
    });
    const candidate = makeSpec({
      inputs: [{ name: "input", type: "string" }],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.some((r) => r.includes("name mismatch"))).toBe(true);
    }
  });

  it("returns false when input count differs", () => {
    const caller = makeSpec({
      inputs: [{ name: "a", type: "string" }],
    });
    const candidate = makeSpec({
      inputs: [
        { name: "a", type: "string" },
        { name: "b", type: "number" },
      ],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.some((r) => r.includes("count mismatch"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Output type mismatches
// ---------------------------------------------------------------------------

describe("structuralMatch — output type mismatches", () => {
  it("returns false when output types differ", () => {
    const caller = makeSpec({
      outputs: [{ name: "result", type: "number" }],
    });
    const candidate = makeSpec({
      outputs: [{ name: "result", type: "string" }],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.some((r) => r.includes("output"))).toBe(true);
    }
  });

  it("returns false when output count differs", () => {
    const caller = makeSpec({
      outputs: [{ name: "result", type: "number" }],
    });
    const candidate = makeSpec({
      outputs: [
        { name: "result", type: "number" },
        { name: "error", type: "string" },
      ],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error condition subset check
// ---------------------------------------------------------------------------

describe("structuralMatch — errorConditions subset", () => {
  it("matches when candidate has a subset of caller's error conditions", () => {
    const caller = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
        { description: "Throws RangeError", errorType: "RangeError" },
      ],
    });
    const candidate = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
      ],
    });
    expect(structuralMatch(caller, candidate).matches).toBe(true);
  });

  it("returns false when candidate declares an error the caller doesn't tolerate", () => {
    const caller = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
      ],
    });
    const candidate = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
        { description: "Throws RangeError", errorType: "RangeError" },
      ],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(
        result.reasons.some((r) => r.includes("RangeError")),
      ).toBe(true);
    }
  });

  it("matches when both have empty error conditions", () => {
    const spec = makeSpec({ errorConditions: [] });
    expect(structuralMatch(spec, spec).matches).toBe(true);
  });

  it("matches when candidate has no error conditions and caller tolerates some", () => {
    const caller = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
      ],
    });
    const candidate = makeSpec({ errorConditions: [] });
    expect(structuralMatch(caller, candidate).matches).toBe(true);
  });

  it("returns false when caller tolerates no errors but candidate declares one", () => {
    const caller = makeSpec({ errorConditions: [] });
    const candidate = makeSpec({
      errorConditions: [
        { description: "Throws SyntaxError", errorType: "SyntaxError" },
      ],
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-functional property checks
// ---------------------------------------------------------------------------

describe("structuralMatch — non-functional properties", () => {
  it("matches when candidate purity equals caller purity", () => {
    const spec = makeSpec({ nonFunctional: { purity: "pure", threadSafety: "safe" } });
    expect(structuralMatch(spec, spec).matches).toBe(true);
  });

  it("returns false when candidate purity is weaker than caller requires", () => {
    const caller = makeSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });
    const candidate = makeSpec({
      nonFunctional: { purity: "stateful", threadSafety: "safe" },
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.some((r) => r.includes("purity"))).toBe(true);
    }
  });

  it("matches when candidate purity is stronger than caller requires", () => {
    // Caller wants io; candidate is pure (strictly stronger).
    const caller = makeSpec({
      nonFunctional: { purity: "io", threadSafety: "safe" },
    });
    const candidate = makeSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });
    expect(structuralMatch(caller, candidate).matches).toBe(true);
  });

  it("returns false when candidate thread-safety is weaker than caller requires", () => {
    const caller = makeSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });
    const candidate = makeSpec({
      nonFunctional: { purity: "pure", threadSafety: "unsafe" },
    });
    const result = structuralMatch(caller, candidate);
    expect(result.matches).toBe(false);
    if (!result.matches) {
      expect(result.reasons.some((r) => r.includes("threadSafety"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Monotonicity property test
// ---------------------------------------------------------------------------

// @decision DEC-SEARCH-STRUCTURAL-001 (WI-003): monotonicity is a documented
// invariant of structuralMatch. If candidate matches a spec, it must also match
// any spec that relaxes caller requirements. We test this via fast-check:
// generate a matching pair, then derive a looser caller spec and confirm it
// still matches.

describe("structuralMatch — monotonicity invariant", () => {
  it(
    "relaxing caller error-condition requirements never turns true → false",
    () => {
      fc.assert(
        fc.property(
          // Generate a ContractSpec where caller and candidate share inputs/outputs
          // and have a common set of error conditions.
          fc.record({
            behaviorCaller: fc.string({ minLength: 1, maxLength: 30 }),
            behaviorCandidate: fc.string({ minLength: 1, maxLength: 30 }),
            // Generate between 0 and 3 error condition errorTypes
            candidateErrors: fc.array(
              fc.string({ minLength: 1, maxLength: 10 }),
              { minLength: 0, maxLength: 3 },
            ),
            // Caller tolerates extra errors beyond what candidate declares
            extraCallerErrors: fc.array(
              fc.string({ minLength: 1, maxLength: 10 }),
              { minLength: 0, maxLength: 3 },
            ),
          }),
          ({ behaviorCaller, behaviorCandidate, candidateErrors, extraCallerErrors }) => {
            // Deduplicate to avoid test noise from collision
            const uniqueCandidateErrors = [...new Set(candidateErrors)];
            const allCallerErrors = [
              ...new Set([...uniqueCandidateErrors, ...extraCallerErrors]),
            ];

            const candidateSpec = makeSpec({
              behavior: behaviorCandidate,
              errorConditions: uniqueCandidateErrors.map((e) => ({
                description: `Error ${e}`,
                errorType: e,
              })),
            });

            // Caller with ALL errors (superset of candidate) — must match.
            const callerWithAll = makeSpec({
              behavior: behaviorCaller,
              errorConditions: allCallerErrors.map((e) => ({
                description: `Error ${e}`,
                errorType: e,
              })),
            });

            const initialResult = structuralMatch(callerWithAll, candidateSpec);
            // By construction (callerWithAll tolerates everything candidate declares)
            // the error-condition check should never produce a failure here.
            // Other checks (types) are identical since we use the same base spec.
            expect(initialResult.matches).toBe(true);

            // Now relax further: add one more tolerated error to the caller.
            const callerRelaxed = makeSpec({
              behavior: behaviorCaller,
              errorConditions: [
                ...allCallerErrors.map((e) => ({
                  description: `Error ${e}`,
                  errorType: e,
                })),
                { description: "Extra tolerated error", errorType: "ExtraError" },
              ],
            });

            const relaxedResult = structuralMatch(callerRelaxed, candidateSpec);
            // Relaxing must not turn true → false.
            expect(relaxedResult.matches).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  it(
    "removing a constraint from caller nonFunctional never turns true → false",
    () => {
      fc.assert(
        fc.property(
          fc.record({
            // Generate candidate purity and thread-safety levels
            candidatePurity: fc.constantFrom(
              "pure" as const,
              "io" as const,
              "stateful" as const,
              "nondeterministic" as const,
            ),
            candidateThread: fc.constantFrom(
              "safe" as const,
              "sequential" as const,
              "unsafe" as const,
            ),
          }),
          ({ candidatePurity, candidateThread }) => {
            const candidate = makeSpec({
              nonFunctional: {
                purity: candidatePurity,
                threadSafety: candidateThread,
              },
            });

            // Caller that matches candidate's exact purity/thread (same values).
            const callerExact = makeSpec({
              nonFunctional: {
                purity: candidatePurity,
                threadSafety: candidateThread,
              },
            });
            const exactResult = structuralMatch(callerExact, candidate);
            // Same nonFunctional: must match.
            expect(exactResult.matches).toBe(true);

            // Relax caller to nondeterministic + unsafe (weakest requirements).
            const callerRelaxed = makeSpec({
              nonFunctional: {
                purity: "nondeterministic",
                threadSafety: "unsafe",
              },
            });
            const relaxedResult = structuralMatch(callerRelaxed, candidate);
            // Weakening requirements cannot flip a passing match to failing.
            expect(relaxedResult.matches).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
