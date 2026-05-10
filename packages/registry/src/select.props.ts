// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-002: hand-authored property-test corpus for
// @yakcc/registry select.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (issue-87-fill-registry)
// Rationale: select() is a pure function with a rich tiebreak chain
// (strictness → nf-quality → passing-runs → lexicographic-root). Property tests
// exercise invariants that example-based tests cannot enumerate exhaustively:
// totality, determinism, strictness dominance, tiebreak monotonicity.

// ---------------------------------------------------------------------------
// Property-test corpus for select.ts
//
// Functions covered:
//   select() — pure candidate-selection function (DEC-SELECT-001)
//
// select() is a pure function with no DB access. Properties are authored
// against the exported select() directly — no re-implementation needed.
//
// Behaviors exercised:
//   S1  — totality: never throws on any valid input
//   S2  — determinism: same input → same output
//   S3  — empty returns null
//   S4  — singleton returns the only match
//   S5  — strictness dominance: strictest candidate always wins
//   S6  — nf-score tiebreak: higher quality score wins when no edges
//   S7  — lexicographic fallback is stable regardless of input order
//   S8  — irrelevant edges (roots not in match set) are ignored
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, SpecYak } from "@yakcc/contracts";
import * as fc from "fast-check";
import { select } from "./select.js";
import type { CandidateProvenance, SelectMatch, StrictnessEdge } from "./select.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a synthetic BlockMerkleRoot: 64 lowercase hex characters.
 * We derive them from a single hex char repeated 64 times so that roots are
 * lexicographically ordered by that character — useful for tiebreak tests.
 */
const hexCharArb: fc.Arbitrary<string> = fc.constantFrom(
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
);

/**
 * Arbitrary for a BlockMerkleRoot built by repeating one hex char 64 times.
 * Root ordering is fully determined by the character (lexicographic).
 */
const blockRootArb: fc.Arbitrary<BlockMerkleRoot> = hexCharArb.map(
  (c) => c.repeat(64) as BlockMerkleRoot,
);

/**
 * Arbitrary for a SpecYak with no nonFunctional field (score 0 in nfScore).
 * All structural required fields are populated; behavior varies across samples.
 */
const minimalSpecArb: fc.Arbitrary<SpecYak> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    behavior: fc.string({ minLength: 1, maxLength: 30 }),
  })
  .map(({ name, behavior }) => ({
    name,
    inputs: [{ name: "x", type: "string" }],
    outputs: [{ name: "y", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0" as const,
    behavior,
    guarantees: [],
    errorConditions: [],
    propertyTests: [],
  }));

/**
 * Arbitrary for a SelectMatch with a fixed root char and minimal spec.
 * score defaults to 0.9 (irrelevant to select() logic).
 */
function makeMatchArb(rootChar: string): fc.Arbitrary<SelectMatch> {
  return minimalSpecArb.map((spec) => ({
    block: { root: rootChar.repeat(64) as BlockMerkleRoot, spec },
    score: 0.9,
  }));
}

/**
 * Arbitrary for a non-empty list of SelectMatch with distinct root chars.
 * Length 1–4 to keep tests fast.
 */
const distinctMatchListArb: fc.Arbitrary<readonly SelectMatch[]> = fc
  .uniqueArray(hexCharArb, { minLength: 1, maxLength: 4 })
  .chain((chars) =>
    fc.tuple(...chars.map((c) => makeMatchArb(c))).map((matches) => matches as SelectMatch[]),
  );

// ---------------------------------------------------------------------------
// S1: Totality — select() never throws on valid inputs
// ---------------------------------------------------------------------------

/**
 * prop_select_total
 *
 * For any non-empty list of SelectMatch values, any set of StrictnessEdges
 * (including edges referencing roots not in the match set), and any provenance
 * array, select() returns a non-null SelectMatch without throwing.
 *
 * Invariant: select() is total on valid inputs — it always returns a result
 * or null (for empty lists) but never throws.
 */
export const prop_select_total = fc.property(
  distinctMatchListArb,
  fc.array(
    fc.record({
      stricterRoot: blockRootArb,
      looserRoot: blockRootArb,
    }),
    { minLength: 0, maxLength: 5 },
  ),
  fc.array(
    fc.record({
      blockRoot: blockRootArb,
      passingRuns: fc.integer({ min: 0, max: 100 }),
    }),
    { minLength: 0, maxLength: 5 },
  ),
  (matches, edges, provenance) => {
    // Must not throw
    const result = select(matches, edges, provenance);
    // Non-empty matches → result must be non-null
    return result !== null;
  },
);

// ---------------------------------------------------------------------------
// S2: Determinism — same input produces same output
// ---------------------------------------------------------------------------

/**
 * prop_select_deterministic
 *
 * For any set of inputs, two calls to select() produce the same result
 * (same block root or both null).
 *
 * Invariant: select() is a pure, deterministic function with no side effects.
 * Multiple calls on the same inputs always agree.
 */
export const prop_select_deterministic = fc.property(
  distinctMatchListArb,
  fc.array(fc.record({ stricterRoot: blockRootArb, looserRoot: blockRootArb }), {
    minLength: 0,
    maxLength: 4,
  }),
  fc.array(fc.record({ blockRoot: blockRootArb, passingRuns: fc.integer({ min: 0, max: 50 }) }), {
    minLength: 0,
    maxLength: 4,
  }),
  (matches, edges, provenance) => {
    const r1 = select(matches, edges, provenance);
    const r2 = select(matches, edges, provenance);
    return r1?.block.root === r2?.block.root;
  },
);

// ---------------------------------------------------------------------------
// S3: Empty returns null
// ---------------------------------------------------------------------------

/**
 * prop_select_empty_returns_null
 *
 * select() with an empty matches array always returns null, regardless of
 * the edges and provenance supplied.
 *
 * Invariant: the null path is the only permitted result for empty input.
 */
export const prop_select_empty_returns_null = fc.property(
  fc.array(fc.record({ stricterRoot: blockRootArb, looserRoot: blockRootArb }), {
    minLength: 0,
    maxLength: 4,
  }),
  fc.array(fc.record({ blockRoot: blockRootArb, passingRuns: fc.integer({ min: 0, max: 50 }) }), {
    minLength: 0,
    maxLength: 4,
  }),
  (edges, provenance) => {
    return select([], edges, provenance) === null;
  },
);

// ---------------------------------------------------------------------------
// S4: Singleton returns the only match
// ---------------------------------------------------------------------------

/**
 * prop_select_singleton_returns_only_match
 *
 * When matches has exactly one element, select() returns that element,
 * regardless of what edges or provenance are supplied.
 *
 * Invariant: the fast-path for length === 1 always returns that element.
 */
export const prop_select_singleton_returns_only_match = fc.property(
  makeMatchArb("a"),
  fc.array(fc.record({ stricterRoot: blockRootArb, looserRoot: blockRootArb }), {
    minLength: 0,
    maxLength: 3,
  }),
  fc.array(fc.record({ blockRoot: blockRootArb, passingRuns: fc.integer({ min: 0, max: 50 }) }), {
    minLength: 0,
    maxLength: 3,
  }),
  (match, edges, provenance) => {
    const result = select([match], edges, provenance);
    return result?.block.root === match.block.root;
  },
);

// ---------------------------------------------------------------------------
// S5: Strictness dominance — the declared-strictest candidate wins
// ---------------------------------------------------------------------------

/**
 * prop_select_strict_candidate_wins
 *
 * When A is declared strictly stronger than B (via a StrictnessEdge), and
 * both are in the match set, select() returns A regardless of nf-quality,
 * provenance, or lexicographic ordering.
 *
 * Invariant: strictness ordering dominates all tiebreak criteria
 * (DEC-SELECT-TIEBREAK-001 step 3 before steps 4a/4b/4c).
 */
export const prop_select_strict_candidate_wins = fc.property(
  // Use two distinct chars so roots differ
  fc.constantFrom<[string, string]>(["a", "b"], ["b", "c"], ["c", "d"], ["0", "f"]),
  minimalSpecArb,
  minimalSpecArb,
  ([stricterChar, looserChar], stricterSpec, looserSpec) => {
    const stricterRoot = stricterChar.repeat(64) as BlockMerkleRoot;
    const looserRoot = looserChar.repeat(64) as BlockMerkleRoot;

    const stricterMatch: SelectMatch = {
      block: { root: stricterRoot, spec: stricterSpec },
      score: 0.9,
    };
    const looserMatch: SelectMatch = {
      block: { root: looserRoot, spec: looserSpec },
      score: 0.9,
    };

    const edge: StrictnessEdge = { stricterRoot, looserRoot };
    const result = select([stricterMatch, looserMatch], [edge], []);
    return result?.block.root === stricterRoot;
  },
);

/**
 * prop_select_strict_candidate_wins_reversed_input_order
 *
 * The strictness dominance invariant holds regardless of input array order.
 * select([A, B], [A > B]) and select([B, A], [A > B]) both return A.
 *
 * Invariant: select() does not depend on input array ordering for its
 * strictness-based result (the candidate set is order-independent).
 */
export const prop_select_strict_candidate_wins_reversed_input_order = fc.property(
  fc.constantFrom<[string, string]>(["a", "b"], ["b", "c"], ["c", "d"], ["0", "f"]),
  minimalSpecArb,
  minimalSpecArb,
  ([stricterChar, looserChar], stricterSpec, looserSpec) => {
    const stricterRoot = stricterChar.repeat(64) as BlockMerkleRoot;
    const looserRoot = looserChar.repeat(64) as BlockMerkleRoot;

    const stricterMatch: SelectMatch = {
      block: { root: stricterRoot, spec: stricterSpec },
      score: 0.9,
    };
    const looserMatch: SelectMatch = {
      block: { root: looserRoot, spec: looserSpec },
      score: 0.9,
    };

    const edge: StrictnessEdge = { stricterRoot, looserRoot };

    const r1 = select([stricterMatch, looserMatch], [edge], []);
    const r2 = select([looserMatch, stricterMatch], [edge], []);
    return r1?.block.root === stricterRoot && r2?.block.root === stricterRoot;
  },
);

// ---------------------------------------------------------------------------
// S6: NF-quality tiebreak — higher quality wins when no strictness edges
// ---------------------------------------------------------------------------

/**
 * prop_select_nf_quality_tiebreak_pure_beats_stateful
 *
 * When no strictness edges are declared, a candidate with higher nf-quality
 * score (pure/safe = 32) beats one with lower score (stateful/safe = 12).
 *
 * Invariant: tiebreak step 4a (DEC-SELECT-TIEBREAK-001) selects by
 * non-functional quality before consulting provenance or lexicographic order.
 */
export const prop_select_nf_quality_tiebreak_pure_beats_stateful = fc.property(
  fc.constantFrom<{ pureChar: string; statefulChar: string }>(
    { pureChar: "a", statefulChar: "b" },
    { pureChar: "c", statefulChar: "d" },
    { pureChar: "e", statefulChar: "f" },
  ),
  ({ pureChar, statefulChar }) => {
    const pureRoot = pureChar.repeat(64) as BlockMerkleRoot;
    const statefulRoot = statefulChar.repeat(64) as BlockMerkleRoot;

    const pureSpec: SpecYak = {
      name: "p",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "pure",
      guarantees: [],
      errorConditions: [],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      propertyTests: [],
    };

    const statefulSpec: SpecYak = {
      ...pureSpec,
      behavior: "stateful",
      nonFunctional: { purity: "stateful", threadSafety: "safe" },
    };

    const pureMatch: SelectMatch = { block: { root: pureRoot, spec: pureSpec }, score: 0.9 };
    const statefulMatch: SelectMatch = {
      block: { root: statefulRoot, spec: statefulSpec },
      score: 0.9,
    };

    const result = select([pureMatch, statefulMatch], [], []);
    return result?.block.root === pureRoot;
  },
);

// ---------------------------------------------------------------------------
// S7: Lexicographic fallback is stable and order-independent
// ---------------------------------------------------------------------------

/**
 * prop_select_lexicographic_fallback_stable
 *
 * When all candidates have identical nf-quality (no nonFunctional) and
 * zero provenance, and no strictness edges exist, select() returns the
 * lexicographically smallest block root — and this result is stable
 * regardless of input array order.
 *
 * Invariant: the final tiebreak (DEC-SELECT-TIEBREAK-001 step 4c) is
 * deterministic and order-independent, always yielding the smallest root.
 */
export const prop_select_lexicographic_fallback_stable = fc.property(
  // Two distinct hex chars so we know the expected winner
  fc.constantFrom<{ smallChar: string; largeChar: string }>(
    { smallChar: "0", largeChar: "1" },
    { smallChar: "a", largeChar: "b" },
    { smallChar: "c", largeChar: "f" },
    { smallChar: "1", largeChar: "9" },
  ),
  ({ smallChar, largeChar }) => {
    const smallRoot = smallChar.repeat(64) as BlockMerkleRoot;
    const largeRoot = largeChar.repeat(64) as BlockMerkleRoot;

    const spec: SpecYak = {
      name: "s",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "x",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const matchSmall: SelectMatch = { block: { root: smallRoot, spec }, score: 0.9 };
    const matchLarge: SelectMatch = { block: { root: largeRoot, spec }, score: 0.9 };

    const r1 = select([matchSmall, matchLarge], [], []);
    const r2 = select([matchLarge, matchSmall], [], []);

    return r1?.block.root === smallRoot && r2?.block.root === smallRoot;
  },
);

// ---------------------------------------------------------------------------
// S8: Irrelevant edges (roots not in match set) are ignored
// ---------------------------------------------------------------------------

/**
 * prop_select_irrelevant_edges_ignored
 *
 * StrictnessEdges referencing roots that are not present in the candidate
 * match set do not affect the selection result.
 *
 * Invariant: buildEdgeSet filters to candidateRoots before constructing the
 * edge set, so foreign-root edges have no effect on the outcome.
 */
export const prop_select_irrelevant_edges_ignored = fc.property(
  fc.constantFrom<{ charA: string; charB: string }>(
    { charA: "a", charB: "b" },
    { charA: "c", charB: "d" },
  ),
  ({ charA, charB }) => {
    const rootA = charA.repeat(64) as BlockMerkleRoot;
    const rootB = charB.repeat(64) as BlockMerkleRoot;
    const foreignRoot = "f".repeat(64) as BlockMerkleRoot;

    const spec: SpecYak = {
      name: "s",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "x",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const matchA: SelectMatch = { block: { root: rootA, spec }, score: 0.9 };
    const matchB: SelectMatch = { block: { root: rootB, spec }, score: 0.9 };

    // Edge declaring B > A (candidate roots)
    const relevantEdge: StrictnessEdge = { stricterRoot: rootB, looserRoot: rootA };
    // Irrelevant edge referencing a foreign root (not in match set)
    const irrelevantEdge: StrictnessEdge = { stricterRoot: foreignRoot, looserRoot: rootB };

    const withIrrelevant = select([matchA, matchB], [relevantEdge, irrelevantEdge], []);
    const withoutIrrelevant = select([matchA, matchB], [relevantEdge], []);

    // Result should be B (stricter) in both cases
    return withIrrelevant?.block.root === rootB && withoutIrrelevant?.block.root === rootB;
  },
);

// ---------------------------------------------------------------------------
// S9: Provenance tiebreak — more passing runs wins
// ---------------------------------------------------------------------------

/**
 * prop_select_provenance_tiebreak
 *
 * When nf-quality scores are tied (identical specs, no nonFunctional) but
 * provenance differs, the candidate with more passing runs wins.
 *
 * Invariant: tiebreak step 4b (DEC-SELECT-TIEBREAK-001) applies after 4a
 * (nf-quality). When 4a is tied, more passing runs is decisive.
 */
export const prop_select_provenance_tiebreak = fc.property(
  fc.integer({ min: 0, max: 50 }),
  fc.integer({ min: 1, max: 100 }),
  (fewer, more) => {
    const rootA = "a".repeat(64) as BlockMerkleRoot;
    const rootB = "b".repeat(64) as BlockMerkleRoot;

    const spec: SpecYak = {
      name: "s",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: "x",
      guarantees: [],
      errorConditions: [],
      propertyTests: [],
    };

    const matchA: SelectMatch = { block: { root: rootA, spec }, score: 0.9 };
    const matchB: SelectMatch = { block: { root: rootB, spec }, score: 0.9 };

    const provenance: CandidateProvenance[] = [
      { blockRoot: rootA, passingRuns: fewer },
      // B always has strictly more passing runs
      { blockRoot: rootB, passingRuns: fewer + more },
    ];

    const result = select([matchA, matchB], [], provenance);
    // B has more passing runs → B wins (when fewer < fewer+more, and lex: a < b so
    // we need to ensure runs difference is decisive before lex kicks in).
    // Since B has more runs, it wins over A even though lex would favor A.
    return result?.block.root === rootB;
  },
);
