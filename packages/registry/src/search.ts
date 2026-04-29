// @decision DEC-SEARCH-STRUCTURAL-001: Structural matching is a pure function
// with no DB access. Status: decided (WI-003)
// Rationale: Keeps the matching logic independently testable and reusable.
// The storage layer calls structuralMatch per candidate and filters on the
// result. This separation means the structural logic can evolve (v0.5+) without
// touching the persistence layer.

// @decision DEC-SEARCH-V0-PRAGMATIC-001: v0 structural matching uses deep-equal
// on TypeSignature arrays and subset-check on errorConditions. Status: decided (WI-003)
// Rationale: Full type-system subtyping is undecidable in general; v0 takes the
// pragmatic path of exact structural equality for types plus a subset-check for
// error conditions. This is sufficient for the seed corpus and flags divergences
// at selection time. Refinements land in v0.5+.

import type { ContractSpec } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/**
 * The result of a structural match check between a caller's spec and a
 * candidate spec from the registry.
 *
 * - `{ matches: true }` — the candidate satisfies the caller's requirements.
 * - `{ matches: false, reasons: string[] }` — the candidate does not satisfy
 *   the caller's requirements; `reasons` names each divergence.
 */
export type MatchResult =
  | { readonly matches: true }
  | { readonly matches: false; readonly reasons: readonly string[] };

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether `candidate` could satisfy the caller's `spec`.
 *
 * v0 matching rules (each failure appends a string to `reasons`):
 *
 * 1. Input signatures must match exactly in count, name, and type.
 * 2. Output signatures must match exactly in count, name, and type.
 * 3. The candidate's declared error conditions must be a subset of the
 *    conditions the caller's spec declares — extra undeclared errors on the
 *    candidate mean the caller might not handle them.
 * 4. Non-functional properties that the caller specifies must be at least as
 *    strong on the candidate (same purity, same thread-safety, compatible
 *    time/space complexity).
 *
 * Monotonicity invariant (tested in search.test.ts): relaxing a caller's
 * requirement (removing a constraint from `spec`) must not turn a
 * `matches: true` into `matches: false` for the same candidate. Equivalently,
 * if `candidate` matches `spec`, it must also match any looser spec.
 *
 * @param spec      - The caller's required contract specification.
 * @param candidate - The registry candidate being evaluated.
 */
export function structuralMatch(
  spec: ContractSpec,
  candidate: ContractSpec,
): MatchResult {
  const reasons: string[] = [];

  // -----------------------------------------------------------------------
  // 1. Input signatures — exact match (count, name, type)
  // -----------------------------------------------------------------------
  if (spec.inputs.length !== candidate.inputs.length) {
    reasons.push(
      `input count mismatch: caller needs ${spec.inputs.length}, candidate has ${candidate.inputs.length}`,
    );
  } else {
    for (let i = 0; i < spec.inputs.length; i++) {
      const want = spec.inputs[i];
      const got = candidate.inputs[i];
      // noUncheckedIndexedAccess: both arrays are same length so neither is undefined
      if (want === undefined || got === undefined) continue;
      if (want.name !== got.name) {
        reasons.push(
          `input[${i}] name mismatch: caller needs "${want.name}", candidate has "${got.name}"`,
        );
      }
      if (want.type !== got.type) {
        reasons.push(
          `input[${i}] type mismatch: caller needs "${want.type}", candidate has "${got.type}"`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 2. Output signatures — exact match (count, name, type)
  // -----------------------------------------------------------------------
  if (spec.outputs.length !== candidate.outputs.length) {
    reasons.push(
      `output count mismatch: caller needs ${spec.outputs.length}, candidate has ${candidate.outputs.length}`,
    );
  } else {
    for (let i = 0; i < spec.outputs.length; i++) {
      const want = spec.outputs[i];
      const got = candidate.outputs[i];
      if (want === undefined || got === undefined) continue;
      if (want.name !== got.name) {
        reasons.push(
          `output[${i}] name mismatch: caller needs "${want.name}", candidate has "${got.name}"`,
        );
      }
      if (want.type !== got.type) {
        reasons.push(
          `output[${i}] type mismatch: caller needs "${want.type}", candidate has "${got.type}"`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3. Error conditions — candidate's errors ⊆ caller's tolerated errors
  //
  //    If the caller's spec declares no error conditions, it means "I don't
  //    tolerate any errors." If the candidate has error conditions the caller
  //    hasn't declared, those are unexpected errors the caller won't handle.
  //
  //    Matching is by errorType string when present, otherwise by description.
  // -----------------------------------------------------------------------
  for (const candidateErr of candidate.errorConditions) {
    const key = candidateErr.errorType ?? candidateErr.description;
    const callerTolerates = spec.errorConditions.some(
      (e) => (e.errorType ?? e.description) === key,
    );
    if (!callerTolerates) {
      reasons.push(
        `candidate declares error condition not tolerated by caller: "${key}"`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 4. Non-functional properties — candidate must be at least as strong
  //
  //    - purity: candidate must be at least as pure as the caller requires
  //    - threadSafety: candidate must be at least as safe as the caller requires
  //    - time/space: if caller specifies a complexity, candidate must match or
  //      declare a complexity that is no worse (free-form strings: exact match
  //      in v0; later refinements can parse Big-O).
  // -----------------------------------------------------------------------
  const callerNF = spec.nonFunctional;
  const candidateNF = candidate.nonFunctional;

  // Purity ordering: pure > io > stateful > nondeterministic.
  // A candidate is at least as pure as the caller if its purity rank >= caller's.
  const PURITY_RANK: Record<string, number> = {
    pure: 3,
    io: 2,
    stateful: 1,
    nondeterministic: 0,
  };
  const callerPurityRank = PURITY_RANK[callerNF.purity] ?? 0;
  const candidatePurityRank = PURITY_RANK[candidateNF.purity] ?? 0;
  if (candidatePurityRank < callerPurityRank) {
    reasons.push(
      `purity mismatch: caller requires "${callerNF.purity}", candidate offers "${candidateNF.purity}"`,
    );
  }

  // Thread-safety ordering: safe > sequential > unsafe.
  const THREAD_RANK: Record<string, number> = {
    safe: 2,
    sequential: 1,
    unsafe: 0,
  };
  const callerThreadRank = THREAD_RANK[callerNF.threadSafety] ?? 0;
  const candidateThreadRank = THREAD_RANK[candidateNF.threadSafety] ?? 0;
  if (candidateThreadRank < callerThreadRank) {
    reasons.push(
      `threadSafety mismatch: caller requires "${callerNF.threadSafety}", candidate offers "${candidateNF.threadSafety}"`,
    );
  }

  // Time complexity: if caller specifies, candidate must match (exact in v0).
  if (
    callerNF.time !== undefined &&
    candidateNF.time !== undefined &&
    callerNF.time !== candidateNF.time
  ) {
    reasons.push(
      `time complexity mismatch: caller requires "${callerNF.time}", candidate offers "${candidateNF.time}"`,
    );
  }

  // Space complexity: same.
  if (
    callerNF.space !== undefined &&
    candidateNF.space !== undefined &&
    callerNF.space !== candidateNF.space
  ) {
    reasons.push(
      `space complexity mismatch: caller requires "${callerNF.space}", candidate offers "${candidateNF.space}"`,
    );
  }

  if (reasons.length === 0) {
    return { matches: true };
  }
  return { matches: false, reasons };
}
