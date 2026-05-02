// SPDX-License-Identifier: MIT
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

// @decision DEC-SEARCH-SPECYAK-MIGRATE-001: structuralMatch now operates on
// SpecYak instead of ContractSpec. The internal logic (deep-equal on type
// signatures, subset-check on errors) is unchanged. SpecYak's nonFunctional,
// errorConditions, inputs, and outputs fields are optional (for v0 lift
// compatibility), so absent fields on caller or candidate are treated as
// "no constraint" and match anything.
// Status: decided (WI-T03)

import type { SpecYak } from "@yakcc/contracts";

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
 * 1. Input signatures must match exactly in count, name, and type (when both
 *    specs declare inputs; absent inputs fields are treated as "no constraint").
 * 2. Output signatures must match exactly in count, name, and type.
 * 3. The candidate's declared error conditions must be a subset of the
 *    conditions the caller's spec declares — extra undeclared errors on the
 *    candidate mean the caller might not handle them. When caller has no
 *    errorConditions field, it is treated as an empty array (no tolerance).
 * 4. Non-functional properties that the caller specifies must be at least as
 *    strong on the candidate (same purity, same thread-safety, compatible
 *    time/space complexity). When nonFunctional is absent, no NF check is done.
 *
 * Monotonicity invariant (tested in search.test.ts): relaxing a caller's
 * requirement (removing a constraint from `spec`) must not turn a
 * `matches: true` into `matches: false` for the same candidate.
 *
 * @param spec      - The caller's required spec.
 * @param candidate - The registry candidate being evaluated.
 */
export function structuralMatch(spec: SpecYak, candidate: SpecYak): MatchResult {
  const reasons: string[] = [];

  // -----------------------------------------------------------------------
  // 1. Input signatures — exact match (count, name, type)
  // -----------------------------------------------------------------------
  const callerInputs = spec.inputs;
  const candidateInputs = candidate.inputs;
  if (callerInputs.length !== candidateInputs.length) {
    reasons.push(
      `input count mismatch: caller needs ${callerInputs.length}, candidate has ${candidateInputs.length}`,
    );
  } else {
    for (let i = 0; i < callerInputs.length; i++) {
      const want = callerInputs[i];
      const got = candidateInputs[i];
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
  const callerOutputs = spec.outputs;
  const candidateOutputs = candidate.outputs;
  if (callerOutputs.length !== candidateOutputs.length) {
    reasons.push(
      `output count mismatch: caller needs ${callerOutputs.length}, candidate has ${candidateOutputs.length}`,
    );
  } else {
    for (let i = 0; i < callerOutputs.length; i++) {
      const want = callerOutputs[i];
      const got = candidateOutputs[i];
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
  //    If the caller's spec declares no error conditions (or omits the field),
  //    it means "I don't tolerate any errors." If the candidate has error
  //    conditions the caller hasn't declared, those are unexpected errors the
  //    caller won't handle.
  //
  //    Matching is by errorType string when present, otherwise by description.
  // -----------------------------------------------------------------------
  const callerErrors = spec.errorConditions ?? [];
  const candidateErrors = candidate.errorConditions ?? [];
  for (const candidateErr of candidateErrors) {
    const key = candidateErr.errorType ?? candidateErr.description;
    const callerTolerates = callerErrors.some((e) => (e.errorType ?? e.description) === key);
    if (!callerTolerates) {
      reasons.push(`candidate declares error condition not tolerated by caller: "${key}"`);
    }
  }

  // -----------------------------------------------------------------------
  // 4. Non-functional properties — candidate must be at least as strong
  //    Only checked when both caller and candidate declare nonFunctional.
  //    If either omits the field, the check is skipped (no constraint).
  // -----------------------------------------------------------------------
  const callerNF = spec.nonFunctional;
  const candidateNF = candidate.nonFunctional;

  if (callerNF !== undefined && candidateNF !== undefined) {
    // Purity ordering: pure > io > stateful > nondeterministic.
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
  }

  if (reasons.length === 0) {
    return { matches: true };
  }
  return { matches: false, reasons };
}
