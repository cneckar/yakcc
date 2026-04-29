// @decision DEC-SELECT-001: select() takes pre-loaded strictness edges as an
// argument rather than querying the DB itself. Status: decided (WI-003)
// Rationale: Keeps select() a pure function testable without a DB. The storage
// layer loads strictness_edges for the candidate set and passes them in.
// This also avoids a round-trip per call when the caller already has the data.

// @decision DEC-SELECT-TIEBREAK-001: deterministic tiebreaker chain.
// Status: decided (WI-003)
// Rationale: When multiple candidates are incomparable under strictness_edges,
// selection must be deterministic so the same input always returns the same
// contract. Tiebreaker priority: (1) stronger non-functional properties
// (purity rank, then thread-safety rank), (2) more passing test history entries,
// (3) lexicographically smaller contract id (always unique, so always decisive).

import type { ContractId, ContractSpec } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A contract paired with a similarity score. Re-declared locally to avoid a
 * circular import with index.ts; the shapes are identical. The storage layer
 * passes Match[] values from its own internal hydration, and index.ts re-exports
 * both types from the same surface.
 */
export interface SelectMatch {
  readonly contract: {
    readonly id: ContractId;
    readonly spec: ContractSpec;
  };
  readonly score: number;
}

/**
 * A strictness edge: `stricterId` is declared strictly stronger than `looserId`.
 * Both ids must be present in the candidate set for the edge to influence selection.
 */
export interface StrictnessEdge {
  readonly stricterId: ContractId;
  readonly looserId: ContractId;
}

/**
 * Per-candidate provenance data used for tiebreaking.
 * `passingRuns` is the count of `test_history` rows where `passed = 1`.
 */
export interface CandidateProvenance {
  readonly contractId: ContractId;
  readonly passingRuns: number;
}

// ---------------------------------------------------------------------------
// Purity and thread-safety ranking (mirrors search.ts — kept local to avoid
// a circular dep; both files are in the same package)
// ---------------------------------------------------------------------------

const PURITY_RANK: Readonly<Record<string, number>> = {
  pure: 3,
  io: 2,
  stateful: 1,
  nondeterministic: 0,
};

const THREAD_RANK: Readonly<Record<string, number>> = {
  safe: 2,
  sequential: 1,
  unsafe: 0,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of (stricterId, looserId) pairs restricted to ids present in
 * the candidate set. Returns a Set of "stricterId|looserId" composite keys
 * for O(1) lookup.
 */
function buildEdgeSet(
  candidateIds: ReadonlySet<ContractId>,
  edges: readonly StrictnessEdge[],
): Set<string> {
  const edgeSet = new Set<string>();
  for (const edge of edges) {
    if (
      candidateIds.has(edge.stricterId) &&
      candidateIds.has(edge.looserId) &&
      edge.stricterId !== edge.looserId
    ) {
      edgeSet.add(`${edge.stricterId}|${edge.looserId}`);
    }
  }
  return edgeSet;
}

/**
 * Return true if `aId` is declared strictly stronger than `bId`
 * (directly or transitively) within the edge set.
 *
 * Uses iterative BFS to avoid call-stack blowup on large graphs.
 */
function isStricterThan(
  aId: ContractId,
  bId: ContractId,
  edgeSet: ReadonlySet<string>,
  allIds: readonly ContractId[],
): boolean {
  // BFS from aId following "is stricter than" edges.
  const visited = new Set<ContractId>();
  const queue: ContractId[] = [aId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const id of allIds) {
      if (!visited.has(id) && edgeSet.has(`${current}|${id}`)) {
        if (id === bId) return true;
        queue.push(id);
      }
    }
  }
  return false;
}

/**
 * Non-functional quality score for tiebreaking: higher is better.
 * Components: purity (0–3) and thread-safety (0–2).
 */
function nfScore(spec: ContractSpec): number {
  return (PURITY_RANK[spec.nonFunctional.purity] ?? 0) * 10 +
    (THREAD_RANK[spec.nonFunctional.threadSafety] ?? 0);
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Select the single best match from a set of candidates.
 *
 * Selection algorithm:
 * 1. If only one match, return it.
 * 2. Restrict `strictnessEdges` to candidates present in `matches`.
 * 3. Find the maximally-strict candidate: one that no other candidate is
 *    declared strictly stricter than. If there is exactly one such node,
 *    return it.
 * 4. Tiebreak among incomparable maximal nodes:
 *    a. Higher non-functional quality score (purity rank × 10 + thread-safety rank).
 *    b. More passing test-history runs (from `provenance`).
 *    c. Lexicographically smaller contract id (deterministic last resort).
 * 5. Returns null if `matches` is empty.
 *
 * @param matches          - Candidate matches to select from.
 * @param strictnessEdges  - Declared partial order edges (may include ids not in matches).
 * @param provenance       - Per-candidate test-history counts for tiebreaking.
 */
export function select(
  matches: readonly SelectMatch[],
  strictnessEdges: readonly StrictnessEdge[],
  provenance: readonly CandidateProvenance[],
): SelectMatch | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  const allIds = matches.map((m) => m.contract.id);
  const candidateIdSet = new Set<ContractId>(allIds);
  const edgeSet = buildEdgeSet(candidateIdSet, strictnessEdges);

  // Build a provenance lookup for tiebreaking.
  const provenanceMap = new Map<ContractId, number>();
  for (const p of provenance) {
    if (candidateIdSet.has(p.contractId)) {
      provenanceMap.set(p.contractId, p.passingRuns);
    }
  }

  // Find maximally-strict candidates: those where no other candidate is
  // declared stricter than them.
  const maximal = matches.filter((m) => {
    const id = m.contract.id;
    // Is any other candidate declared stricter than this one?
    return !allIds.some(
      (otherId) =>
        otherId !== id && isStricterThan(otherId, id, edgeSet, allIds),
    );
  });

  // Should always have at least one maximal element.
  const pool = maximal.length > 0 ? maximal : matches;

  if (pool.length === 1) return pool[0] ?? null;

  // Tiebreak deterministically.
  const sorted = [...pool].sort((a, b) => {
    // a. Non-functional quality score — higher wins.
    const nfA = nfScore(a.contract.spec);
    const nfB = nfScore(b.contract.spec);
    if (nfA !== nfB) return nfB - nfA; // descending

    // b. Passing test history runs — more wins.
    const passingA = provenanceMap.get(a.contract.id) ?? 0;
    const passingB = provenanceMap.get(b.contract.id) ?? 0;
    if (passingA !== passingB) return passingB - passingA; // descending

    // c. Lexicographically smaller id — a < b means a wins (ascending).
    return a.contract.id < b.contract.id ? -1 : 1;
  });

  return sorted[0] ?? null;
}
