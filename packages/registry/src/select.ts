// @decision DEC-SELECT-001: select() takes pre-loaded strictness edges as an
// argument rather than querying the DB itself. Status: decided (WI-003)
// Rationale: Keeps select() a pure function testable without a DB. The storage
// layer loads strictness_edges for the candidate set and passes them in.
// This also avoids a round-trip per call when the caller already has the data.

// @decision DEC-SELECT-TIEBREAK-001: deterministic tiebreaker chain.
// Status: decided (WI-003)
// Rationale: When multiple candidates are incomparable under strictness_edges,
// selection must be deterministic so the same input always returns the same
// block. Tiebreaker priority: (1) stronger non-functional properties
// (purity rank, then thread-safety rank), (2) more passing test history entries,
// (3) lexicographically smaller block merkle root (always unique, decisive).

// @decision DEC-SELECT-TIEBREAK-MIGRATE-001: lexicographic comparator for the
// final tiebreak now operates on BlockMerkleRoot instead of ContractId. Both
// are 64-char hex strings, so the comparison is identical. The NF tiebreak
// uses SpecYak.nonFunctional (optional in SpecYak; absent values rank as 0).
// Status: decided (WI-T03)

import type { BlockMerkleRoot, SpecYak } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A candidate block paired with a similarity score. The block is identified by
 * its BlockMerkleRoot; the spec is the SpecYak that the block was registered
 * under, used for non-functional tiebreaking.
 *
 * select() is a pure function testable without a DB (DEC-SELECT-001).
 */
export interface SelectMatch {
  readonly block: {
    readonly root: BlockMerkleRoot;
    readonly spec: SpecYak;
  };
  readonly score: number;
}

/**
 * A strictness edge: `stricterRoot` is declared strictly stronger than `looserRoot`.
 * Both roots must be present in the candidate set for the edge to influence selection.
 */
export interface StrictnessEdge {
  readonly stricterRoot: BlockMerkleRoot;
  readonly looserRoot: BlockMerkleRoot;
}

/**
 * Per-candidate provenance data used for tiebreaking.
 * `passingRuns` is the count of `test_history` rows where `passed = 1`.
 */
export interface CandidateProvenance {
  readonly blockRoot: BlockMerkleRoot;
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
 * Build a set of (stricterRoot, looserRoot) pairs restricted to roots present
 * in the candidate set. Returns a Set of "stricterRoot|looserRoot" composite
 * keys for O(1) lookup.
 */
function buildEdgeSet(
  candidateRoots: ReadonlySet<BlockMerkleRoot>,
  edges: readonly StrictnessEdge[],
): Set<string> {
  const edgeSet = new Set<string>();
  for (const edge of edges) {
    if (
      candidateRoots.has(edge.stricterRoot) &&
      candidateRoots.has(edge.looserRoot) &&
      edge.stricterRoot !== edge.looserRoot
    ) {
      edgeSet.add(`${edge.stricterRoot}|${edge.looserRoot}`);
    }
  }
  return edgeSet;
}

/**
 * Return true if `aRoot` is declared strictly stronger than `bRoot`
 * (directly or transitively) within the edge set.
 *
 * Uses iterative BFS to avoid call-stack blowup on large graphs.
 */
function isStricterThan(
  aRoot: BlockMerkleRoot,
  bRoot: BlockMerkleRoot,
  edgeSet: ReadonlySet<string>,
  allRoots: readonly BlockMerkleRoot[],
): boolean {
  // BFS from aRoot following "is stricter than" edges.
  const visited = new Set<BlockMerkleRoot>();
  const queue: BlockMerkleRoot[] = [aRoot];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const id of allRoots) {
      if (!visited.has(id) && edgeSet.has(`${current}|${id}`)) {
        if (id === bRoot) return true;
        queue.push(id);
      }
    }
  }
  return false;
}

/**
 * Non-functional quality score for tiebreaking: higher is better.
 * Components: purity (0–3) and thread-safety (0–2).
 * SpecYak.nonFunctional is optional; absent values score 0 in each component.
 */
function nfScore(spec: SpecYak): number {
  const nf = spec.nonFunctional;
  if (nf === undefined) return 0;
  return (PURITY_RANK[nf.purity] ?? 0) * 10 + (THREAD_RANK[nf.threadSafety] ?? 0);
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
 *    c. Lexicographically smaller block merkle root (deterministic last resort).
 * 5. Returns null if `matches` is empty.
 *
 * @param matches          - Candidate matches to select from.
 * @param strictnessEdges  - Declared partial order edges (may include roots not in matches).
 * @param provenance       - Per-candidate test-history counts for tiebreaking.
 */
export function select(
  matches: readonly SelectMatch[],
  strictnessEdges: readonly StrictnessEdge[],
  provenance: readonly CandidateProvenance[],
): SelectMatch | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  const allRoots = matches.map((m) => m.block.root);
  const candidateRootSet = new Set<BlockMerkleRoot>(allRoots);
  const edgeSet = buildEdgeSet(candidateRootSet, strictnessEdges);

  // Build a provenance lookup for tiebreaking.
  const provenanceMap = new Map<BlockMerkleRoot, number>();
  for (const p of provenance) {
    if (candidateRootSet.has(p.blockRoot)) {
      provenanceMap.set(p.blockRoot, p.passingRuns);
    }
  }

  // Find maximally-strict candidates: those where no other candidate is
  // declared stricter than them.
  const maximal = matches.filter((m) => {
    const root = m.block.root;
    // Is any other candidate declared stricter than this one?
    return !allRoots.some(
      (otherRoot) => otherRoot !== root && isStricterThan(otherRoot, root, edgeSet, allRoots),
    );
  });

  // Should always have at least one maximal element.
  const pool = maximal.length > 0 ? maximal : matches;

  if (pool.length === 1) return pool[0] ?? null;

  // Tiebreak deterministically.
  const sorted = [...pool].sort((a, b) => {
    // a. Non-functional quality score — higher wins.
    const nfA = nfScore(a.block.spec);
    const nfB = nfScore(b.block.spec);
    if (nfA !== nfB) return nfB - nfA; // descending

    // b. Passing test history runs — more wins.
    const passingA = provenanceMap.get(a.block.root) ?? 0;
    const passingB = provenanceMap.get(b.block.root) ?? 0;
    if (passingA !== passingB) return passingB - passingA; // descending

    // c. Lexicographically smaller block merkle root — a < b means a wins.
    return a.block.root < b.block.root ? -1 : 1;
  });

  return sorted[0] ?? null;
}
