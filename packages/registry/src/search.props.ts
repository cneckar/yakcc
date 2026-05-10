// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-003: hand-authored property-test corpus for
// @yakcc/registry search.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (issue-87-fill-registry)
// Rationale: structuralMatch() has rich monotonicity invariants (DEC-SEARCH-STRUCTURAL-001)
// that cannot be exhaustively enumerated by example-based tests. Property tests
// cover totality, determinism, reflexivity, and the key monotonicity invariant:
// relaxing a caller's requirement never turns a match into a non-match.

// ---------------------------------------------------------------------------
// Property-test corpus for search.ts
//
// Functions covered:
//   structuralMatch() — pure structural match function (DEC-SEARCH-STRUCTURAL-001)
//
// structuralMatch() is a pure function with no DB access. Properties are authored
// against the exported function directly.
//
// Behaviors exercised:
//   M1  — totality: never throws on valid inputs
//   M2  — determinism: same input → same output
//   M3  — reflexivity: a spec always matches itself
//   M4  — input count mismatch → false with reason
//   M5  — output count mismatch → false with reason
//   M6  — error subset: candidate errors ⊆ caller errors → matches
//   M7  — error superset: candidate extra errors → not matches
//   M8  — monotonicity: relaxing error conditions never flips true → false
//   M9  — monotonicity: relaxing nf requirements never flips true → false
//   M10 — reasons array is non-empty on false result
// ---------------------------------------------------------------------------

import type { SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { structuralMatch } from "./search.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a type string — short alphanumeric tokens like "string", "number", "T". */
const typeStringArb: fc.Arbitrary<string> = fc.constantFrom(
  "string",
  "number",
  "boolean",
  "object",
  "unknown",
  "T",
  "U",
);

/** Arbitrary for a named typed parameter (one input or output slot). */
const paramArb: fc.Arbitrary<{ name: string; type: string }> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 10 }),
  type: typeStringArb,
});

/** Arbitrary for a list of 0–3 parameters. */
const paramListArb: fc.Arbitrary<readonly { name: string; type: string }[]> = fc.array(paramArb, {
  minLength: 0,
  maxLength: 3,
});

/** Arbitrary for a purity level (DEC-SEARCH-STRUCTURAL-001 ordering). */
const purityArb: fc.Arbitrary<"pure" | "io" | "stateful" | "nondeterministic"> = fc.constantFrom(
  "pure" as const,
  "io" as const,
  "stateful" as const,
  "nondeterministic" as const,
);

/** Arbitrary for a thread-safety level. */
const threadSafetyArb: fc.Arbitrary<"safe" | "sequential" | "unsafe"> = fc.constantFrom(
  "safe" as const,
  "sequential" as const,
  "unsafe" as const,
);

/**
 * Arbitrary for a minimal SpecYak. Both inputs and outputs are generated;
 * nonFunctional is included so NF checks can fire.
 */
const specArb: fc.Arbitrary<SpecYak> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 15 }),
    behavior: fc.string({ minLength: 1, maxLength: 30 }),
    inputs: paramListArb,
    outputs: paramListArb,
    purity: purityArb,
    threadSafety: threadSafetyArb,
  })
  .map(({ name, behavior, inputs, outputs, purity, threadSafety }) => ({
    name,
    inputs,
    outputs,
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0" as const,
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity, threadSafety },
    propertyTests: [],
  }));

// ---------------------------------------------------------------------------
// M1: Totality — structuralMatch() never throws
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_total
 *
 * For any two SpecYak values, structuralMatch() returns a MatchResult without
 * throwing. The result is always either { matches: true } or
 * { matches: false, reasons: [...] }.
 *
 * Invariant: structuralMatch() is total on any valid SpecYak pair.
 */
export const prop_structuralMatch_total = fc.property(specArb, specArb, (spec, candidate) => {
  const result = structuralMatch(spec, candidate);
  return typeof result.matches === "boolean";
});

// ---------------------------------------------------------------------------
// M2: Determinism — same inputs → same output
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_deterministic
 *
 * Two calls to structuralMatch() with the same arguments produce the same
 * matches boolean.
 *
 * Invariant: structuralMatch() is a pure, deterministic function.
 */
export const prop_structuralMatch_deterministic = fc.property(
  specArb,
  specArb,
  (spec, candidate) => {
    const r1 = structuralMatch(spec, candidate);
    const r2 = structuralMatch(spec, candidate);
    return r1.matches === r2.matches;
  },
);

// ---------------------------------------------------------------------------
// M3: Reflexivity — a spec matches itself
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_reflexive
 *
 * For any SpecYak spec, structuralMatch(spec, spec) returns { matches: true }.
 *
 * Invariant: the candidate satisfying the exact same spec it was registered
 * under always structurally matches the caller's identical spec. Input/output
 * counts and types are identical; error conditions are a subset (equal); NF
 * properties are at least as strong (equal).
 */
export const prop_structuralMatch_reflexive = fc.property(specArb, (spec) => {
  const result = structuralMatch(spec, spec);
  return result.matches === true;
});

// ---------------------------------------------------------------------------
// M4: Input count mismatch → false with reason
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_input_count_mismatch_returns_false
 *
 * When caller has N inputs and candidate has M ≠ N inputs, structuralMatch()
 * returns { matches: false } and includes a reason string mentioning
 * "count mismatch".
 *
 * Invariant: input count divergence is always caught and reported (check 1
 * in DEC-SEARCH-V0-PRAGMATIC-001).
 */
export const prop_structuralMatch_input_count_mismatch_returns_false = fc.property(
  // Generate a list of 1–3 params and a different-length list
  fc.array(paramArb, { minLength: 1, maxLength: 3 }),
  fc.array(paramArb, { minLength: 0, maxLength: 3 }),
  (callerInputs, candidateInputs) => {
    // Only test when lengths differ
    if (callerInputs.length === candidateInputs.length) return true; // skip equal-length cases

    const callerSpec: SpecYak = {
      name: "caller",
      inputs: callerInputs,
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };
    const candidateSpec: SpecYak = { ...callerSpec, inputs: candidateInputs };

    const result = structuralMatch(callerSpec, candidateSpec);
    if (result.matches) return false;
    return result.reasons.some((r) => r.includes("count mismatch"));
  },
);

// ---------------------------------------------------------------------------
// M5: Output count mismatch → false with reason
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_output_count_mismatch_returns_false
 *
 * When caller and candidate have different output counts, structuralMatch()
 * returns { matches: false } with a reason mentioning "count mismatch".
 *
 * Invariant: output count divergence is always caught and reported (check 2).
 */
export const prop_structuralMatch_output_count_mismatch_returns_false = fc.property(
  fc.array(paramArb, { minLength: 1, maxLength: 3 }),
  fc.array(paramArb, { minLength: 0, maxLength: 3 }),
  (callerOutputs, candidateOutputs) => {
    if (callerOutputs.length === candidateOutputs.length) return true;

    const callerSpec: SpecYak = {
      name: "caller",
      inputs: [],
      outputs: callerOutputs,
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };
    const candidateSpec: SpecYak = { ...callerSpec, outputs: candidateOutputs };

    const result = structuralMatch(callerSpec, candidateSpec);
    if (result.matches) return false;
    return result.reasons.some((r) => r.includes("count mismatch"));
  },
);

// ---------------------------------------------------------------------------
// M6: Error subset — candidate errors ⊆ caller errors → match not blocked
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_error_subset_matches
 *
 * When candidate's error conditions are a strict subset of the caller's
 * tolerated errors (and all other checks pass), structuralMatch() returns true.
 *
 * Invariant: the subset-check rule (DEC-SEARCH-STRUCTURAL-001 check 3) does not
 * produce false positives — if the candidate declares nothing unexpected, the
 * error check passes.
 */
export const prop_structuralMatch_error_subset_matches = fc.property(
  fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 4 }),
  fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 4 }),
  (candidateErrorTypes, extraCallerTypes) => {
    const allCallerTypes = [...new Set([...candidateErrorTypes, ...extraCallerTypes])];
    const uniqueCandidateTypes = [...new Set(candidateErrorTypes)];

    const baseSpec: SpecYak = {
      name: "s",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "y", type: "string" }],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const callerSpec: SpecYak = {
      ...baseSpec,
      errorConditions: allCallerTypes.map((e) => ({ description: `Error ${e}`, errorType: e })),
    };
    const candidateSpec: SpecYak = {
      ...baseSpec,
      errorConditions: uniqueCandidateTypes.map((e) => ({
        description: `Error ${e}`,
        errorType: e,
      })),
    };

    const result = structuralMatch(callerSpec, candidateSpec);
    return result.matches === true;
  },
);

// ---------------------------------------------------------------------------
// M7: Error superset — candidate extra error → false
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_extra_candidate_error_returns_false
 *
 * When the candidate declares an error type that the caller does not tolerate,
 * structuralMatch() returns { matches: false }.
 *
 * Invariant: the subset-check rejects candidates with undeclared errors. The
 * caller would not handle such errors (DEC-SEARCH-V0-PRAGMATIC-001 check 3).
 */
export const prop_structuralMatch_extra_candidate_error_returns_false = fc.property(
  fc.string({ minLength: 1, maxLength: 8 }),
  (extraErrorType) => {
    const baseSpec: SpecYak = {
      name: "s",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const callerSpec: SpecYak = {
      ...baseSpec,
      errorConditions: [], // tolerates nothing
    };
    const candidateSpec: SpecYak = {
      ...baseSpec,
      errorConditions: [{ description: `Error ${extraErrorType}`, errorType: extraErrorType }],
    };

    const result = structuralMatch(callerSpec, candidateSpec);
    return result.matches === false;
  },
);

// ---------------------------------------------------------------------------
// M8: Monotonicity — relaxing error conditions never flips true → false
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_monotone_error_relaxation
 *
 * If structuralMatch(callerA, candidate) is true, and callerB is callerA with
 * one or more additional tolerated error types, then
 * structuralMatch(callerB, candidate) must also be true.
 *
 * Invariant (DEC-SEARCH-STRUCTURAL-001): relaxing a caller requirement
 * (adding more tolerated errors) never turns a match into a non-match.
 */
export const prop_structuralMatch_monotone_error_relaxation = fc.property(
  fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 3 }),
  fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 3 }),
  (candidateErrorTypes, extraToleratedTypes) => {
    const uniqueCandidate = [...new Set(candidateErrorTypes)];
    // callerA tolerates all candidate errors (guaranteed to pass error check)
    const callerAErrors = [...uniqueCandidate];
    // callerB tolerates callerA's errors PLUS extra types (strictly more permissive)
    const callerBErrors = [...new Set([...callerAErrors, ...extraToleratedTypes])];

    const baseSpec: SpecYak = {
      name: "s",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "y", type: "string" }],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const candidateSpec: SpecYak = {
      ...baseSpec,
      errorConditions: uniqueCandidate.map((e) => ({ description: `E ${e}`, errorType: e })),
    };
    const callerA: SpecYak = {
      ...baseSpec,
      errorConditions: callerAErrors.map((e) => ({ description: `E ${e}`, errorType: e })),
    };
    const callerB: SpecYak = {
      ...baseSpec,
      errorConditions: callerBErrors.map((e) => ({ description: `E ${e}`, errorType: e })),
    };

    const resultA = structuralMatch(callerA, candidateSpec);
    // By construction callerA tolerates all candidate errors → must match
    if (!resultA.matches) return true; // skip (other checks may have failed; not our invariant)

    const resultB = structuralMatch(callerB, candidateSpec);
    // Relaxing callerA → callerB must not flip true → false
    return resultB.matches === true;
  },
);

// ---------------------------------------------------------------------------
// M9: Monotonicity — relaxing NF requirements never flips true → false
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_monotone_nf_relaxation
 *
 * If a caller requires purity P and thread-safety T, and a candidate satisfies
 * both, then relaxing the caller to require weaker purity P' < P (or weaker
 * thread-safety T' < T) must still produce matches: true.
 *
 * The weakest possible requirement is nondeterministic/unsafe, which every
 * candidate satisfies for the NF check.
 *
 * Invariant (DEC-SEARCH-STRUCTURAL-001): relaxing NF requirements is monotone.
 */
export const prop_structuralMatch_monotone_nf_relaxation = fc.property(
  purityArb,
  threadSafetyArb,
  (candidatePurity, candidateThread) => {
    const baseSpec: SpecYak = {
      name: "s",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "y", type: "string" }],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "b",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const candidateSpec: SpecYak = {
      ...baseSpec,
      nonFunctional: { purity: candidatePurity, threadSafety: candidateThread },
    };

    // callerExact: requires the exact same purity/thread as candidate → must match
    const callerExact: SpecYak = {
      ...baseSpec,
      nonFunctional: { purity: candidatePurity, threadSafety: candidateThread },
    };

    // callerRelaxed: requires the weakest possible NF → must also match
    const callerRelaxed: SpecYak = {
      ...baseSpec,
      nonFunctional: { purity: "nondeterministic", threadSafety: "unsafe" },
    };

    const exactResult = structuralMatch(callerExact, candidateSpec);
    if (!exactResult.matches) return true; // skip (shouldn't happen; same NF values)

    const relaxedResult = structuralMatch(callerRelaxed, candidateSpec);
    return relaxedResult.matches === true;
  },
);

// ---------------------------------------------------------------------------
// M10: Reasons non-empty on false result
// ---------------------------------------------------------------------------

/**
 * prop_structuralMatch_reasons_nonempty_on_false
 *
 * Whenever structuralMatch() returns { matches: false }, the reasons array
 * contains at least one string explaining the divergence.
 *
 * Invariant: false results are always accompanied by diagnostic reasons.
 * A false result with an empty reasons array would be a silent failure.
 */
export const prop_structuralMatch_reasons_nonempty_on_false = fc.property(
  specArb,
  specArb,
  (spec, candidate) => {
    const result = structuralMatch(spec, candidate);
    if (result.matches) return true;
    return result.reasons.length > 0;
  },
);
