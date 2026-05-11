// SPDX-License-Identifier: MIT
// @decision DEC-HOOKS-BASE-PROPTEST-SUBSTITUTE-001: hand-authored property-test corpus
// for @yakcc/hooks-base substitute.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (issue-87-fill-hooks-base)
// Rationale: candidatesToCombinedScores, decideToSubstitute, renderContractComment,
// and renderSubstitution are pure functions. Property tests exercise invariants that
// example-based tests cannot enumerate exhaustively: totality, determinism, score
// monotonicity, format invariants, and D2 decision boundary conditions.

// ---------------------------------------------------------------------------
// Property-test corpus for substitute.ts
//
// Functions covered (4):
//   candidatesToCombinedScores — cosineDistance → combinedScore conversion
//   decideToSubstitute        — D2 auto-accept rule
//   renderContractComment     — Phase 3 contract comment generation
//   renderSubstitution        — import + binding generation
//
// All functions are pure (no DB, no FS). Properties are authored against the
// exported functions directly — no re-implementation needed.
//
// Behaviors exercised:
//   C1  — score totality: never throws on any valid input
//   C2  — score range: combinedScore ∈ [0, 1] for any cosineDistance ∈ [0, 2]
//   C3  — score monotonicity: larger cosineDistance → smaller combinedScore
//   C4  — score determinism: same input → same output
//   C5  — score empty: empty array → empty result
//   D1  — decide totality: never throws on any valid input
//   D2  — decide determinism: same input → same output
//   D3  — decide empty: empty candidates → substitute=false
//   D4  — decide single strong: one candidate with score > threshold + gap → substitute=true
//   D5  — decide threshold boundary: score ≤ 0.85 → always substitute=false
//   D6  — decide gap boundary: gap ≤ 0.15 → substitute=false even if score > 0.85
//   R1  — renderSubstitution totality: never throws on any valid BindingShape
//   R2  — renderSubstitution determinism: same input → same output
//   R3  — renderSubstitution import path: always contains @yakcc/atoms/<atomName>
//   R4  — renderSubstitution binding: always contains `const <name>`
//   R5  — renderSubstitution no-spec: produces exactly 2 lines
//   R6  — renderSubstitution with-spec: produces exactly 3 lines
//   K1  — renderContractComment totality: never throws on any valid SpecYak
//   K2  — renderContractComment determinism: same input → same output
//   K3  — renderContractComment format: always starts with "// @atom "
//   K4  — renderContractComment hash: always ends with yakcc:<8 hex chars>
//   K5  — renderContractComment no-trailing-semicolon: empty guarantees produces no "; )"
// ---------------------------------------------------------------------------

import {
  AUTO_ACCEPT_GAP_THRESHOLD,
  AUTO_ACCEPT_SCORE_THRESHOLD,
  type BindingShape,
  candidatesToCombinedScores,
  decideToSubstitute,
  renderContractComment,
  renderSubstitution,
} from "./substitute.js";
import type { SpecYak } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Helper factories — avoid importing from @yakcc/registry in the corpus file
// ---------------------------------------------------------------------------

/** Build a minimal CandidateMatch-shaped object for property tests. */
function makeCandidate(cosineDistance: number, blockMerkleRoot = "deadbeef12345678") {
  return {
    block: {
      blockMerkleRoot: blockMerkleRoot as never,
      specHash: "aabbcc" as never,
      specCanonicalBytes: new Uint8Array(0),
      implSource: `export function stub(): void {}`,
      proofManifestJson: "{}",
      level: "L0" as const,
      createdAt: 0,
      canonicalAstHash: "00112233" as never,
      artifacts: new Map<string, Uint8Array>(),
    },
    cosineDistance,
  };
}

/** Build a minimal SpecYak for renderContractComment tests. */
function makeSpec(overrides: Partial<SpecYak> = {}): SpecYak {
  return {
    name: "testAtom",
    inputs: [{ name: "x", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    guarantees: [{ id: "G1", description: "a guarantee" }],
    ...overrides,
  };
}

/**
 * Convert combinedScore target to cosineDistance.
 * combinedScore = 1 - d² / 4  →  d = sqrt((1 - score) * 4)
 */
function scoreToDistance(score: number): number {
  return Math.sqrt(Math.max(0, (1 - score) * 4));
}

// ---------------------------------------------------------------------------
// Representative input sets for hand-crafted property sweeps
// ---------------------------------------------------------------------------

/** Cosine distances covering the full [0, 2] range. */
const DISTANCES_SWEEP = [0, 0.1, 0.2, 0.5, 0.8, 1.0, Math.sqrt(2), 1.5, 1.8, 2.0];

/** AtomNames for renderSubstitution. */
const ATOM_NAMES = ["listOfInts", "computeHash", "sortArray", "reverseString", "getTimestamp", "merge"];

/** Variable names for bindings. */
const VAR_NAMES = ["result", "x", "myVar", "output", "value"];

/** Full 32-char hex hashes for contract comment tests. */
const FULL_HASHES = [
  "deadbeef00112233445566778899aabb",
  "cafebabe1234567890abcdef01234567",
  "0000000000000000000000000000000f",
  "ffffffffffffffffffffffffffffffff",
];

// ---------------------------------------------------------------------------
// C1 — candidatesToCombinedScores: totality
// ---------------------------------------------------------------------------

/**
 * prop_candidatesToCombinedScores_total
 *
 * candidatesToCombinedScores never throws for any cosineDistance in [0, 2].
 *
 * Invariant: the score conversion is defined for the entire valid L2 distance
 * range and never produces an exception.
 */
export function prop_candidatesToCombinedScores_total(): boolean {
  for (const d of DISTANCES_SWEEP) {
    try {
      candidatesToCombinedScores([makeCandidate(d)]);
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// C2 — candidatesToCombinedScores: score range ∈ [0, 1]
// ---------------------------------------------------------------------------

/**
 * prop_candidatesToCombinedScores_range_zero_to_one
 *
 * For every cosineDistance in [0, 2], combinedScore is clamped to [0, 1].
 *
 * Invariant: Math.max(0, Math.min(1, ...)) clamps the score regardless of the
 * raw formula result. No score can be negative or exceed 1.
 */
export function prop_candidatesToCombinedScores_range_zero_to_one(): boolean {
  for (const d of DISTANCES_SWEEP) {
    const scores = candidatesToCombinedScores([makeCandidate(d)]);
    const score = scores[0];
    if (score === undefined) return false;
    if (score < 0 || score > 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// C3 — candidatesToCombinedScores: monotonicity
// ---------------------------------------------------------------------------

/**
 * prop_candidatesToCombinedScores_monotone_decreasing
 *
 * Larger cosineDistance → smaller combinedScore. The score function is strictly
 * monotone decreasing over [0, 2].
 *
 * Invariant: combinedScore = 1 - d²/4 is a strictly decreasing function of d
 * for d ∈ [0, 2]. Closer vectors (smaller d) have higher scores.
 */
export function prop_candidatesToCombinedScores_monotone_decreasing(): boolean {
  const distances = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8];
  for (let i = 0; i < distances.length - 1; i++) {
    const d1 = distances[i]!;
    const d2 = distances[i + 1]!;
    const score1 = candidatesToCombinedScores([makeCandidate(d1)])[0]!;
    const score2 = candidatesToCombinedScores([makeCandidate(d2)])[0]!;
    if (score1 <= score2) return false; // d1 < d2 means score1 > score2
  }
  return true;
}

// ---------------------------------------------------------------------------
// C4 — candidatesToCombinedScores: determinism
// ---------------------------------------------------------------------------

/**
 * prop_candidatesToCombinedScores_deterministic
 *
 * Two calls with identical inputs produce identical outputs.
 *
 * Invariant: candidatesToCombinedScores is a pure function — no side effects,
 * no random or time-dependent output.
 */
export function prop_candidatesToCombinedScores_deterministic(): boolean {
  for (const d of DISTANCES_SWEEP) {
    const c = makeCandidate(d);
    const r1 = candidatesToCombinedScores([c]);
    const r2 = candidatesToCombinedScores([c]);
    if (r1[0] !== r2[0]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// C5 — candidatesToCombinedScores: empty input → empty output
// ---------------------------------------------------------------------------

/**
 * prop_candidatesToCombinedScores_empty_in_empty_out
 *
 * candidatesToCombinedScores([]) returns an empty array.
 *
 * Invariant: the map over an empty array produces an empty array — no sentinel
 * values, no error, no default element.
 */
export function prop_candidatesToCombinedScores_empty_in_empty_out(): boolean {
  const result = candidatesToCombinedScores([]);
  return result.length === 0;
}

// ---------------------------------------------------------------------------
// D1 — decideToSubstitute: totality
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_total
 *
 * decideToSubstitute never throws for any non-empty or empty candidate list
 * with cosineDistances in [0, 2].
 *
 * Invariant: the decision function is total — it always returns a SubstituteDecision
 * discriminated union without throwing.
 */
export function prop_decideToSubstitute_total(): boolean {
  const testCases = [
    [],
    [makeCandidate(0)],
    [makeCandidate(0.5), makeCandidate(1.0)],
    [makeCandidate(2.0)],
    [makeCandidate(scoreToDistance(0.90), "aaa"), makeCandidate(scoreToDistance(0.60), "bbb")],
  ];
  for (const candidates of testCases) {
    try {
      decideToSubstitute(candidates);
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// D2 — decideToSubstitute: determinism
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_deterministic
 *
 * Two calls with identical candidate lists produce identical decisions.
 *
 * Invariant: decideToSubstitute is a pure function — no side effects, no
 * random or time-dependent output.
 */
export function prop_decideToSubstitute_deterministic(): boolean {
  const candidateSets = [
    [],
    [makeCandidate(0, "aaa")],
    [makeCandidate(scoreToDistance(0.92), "win"), makeCandidate(scoreToDistance(0.70), "lose")],
    [makeCandidate(scoreToDistance(0.80))],
  ];
  for (const candidates of candidateSets) {
    const r1 = decideToSubstitute(candidates);
    const r2 = decideToSubstitute(candidates);
    if (r1.substitute !== r2.substitute) return false;
    if (r1.substitute && r2.substitute) {
      if (r1.atomHash !== r2.atomHash) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// D3 — decideToSubstitute: empty → substitute=false
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_empty_returns_false
 *
 * An empty candidates array always produces substitute=false.
 *
 * Invariant: the early-return guard (candidates.length === 0) is always hit
 * before the score check. No candidates → no substitution.
 */
export function prop_decideToSubstitute_empty_returns_false(): boolean {
  const result = decideToSubstitute([]);
  return result.substitute === false;
}

// ---------------------------------------------------------------------------
// D4 — decideToSubstitute: strong single candidate → substitute=true
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_strong_single_candidate_substitutes
 *
 * A single candidate with combinedScore > 0.85 satisfies both conditions:
 * score > threshold AND gap = top1Score - 0 = top1Score > 0.15.
 * Therefore substitute=true for any single candidate with score > 0.85.
 *
 * Invariant: when there is no second candidate, gap = top1Score (compared
 * against 0), which is > 0.15 whenever top1Score > 0.85.
 */
export function prop_decideToSubstitute_strong_single_candidate_substitutes(): boolean {
  // Scores well above 0.85 with gap > 0.15 guaranteed (only one candidate)
  const strongScores = [0.86, 0.90, 0.95, 0.99, 1.0];
  for (const score of strongScores) {
    const d = scoreToDistance(score);
    const result = decideToSubstitute([makeCandidate(d, "winner")]);
    if (!result.substitute) return false;
    if (result.substitute && result.atomHash !== "winner") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// D5 — decideToSubstitute: score ≤ threshold → always substitute=false
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_below_threshold_is_false
 *
 * Any candidate whose combinedScore ≤ AUTO_ACCEPT_SCORE_THRESHOLD (0.85)
 * always produces substitute=false, regardless of gap.
 *
 * Invariant: the score gate is checked before the gap gate. A candidate
 * that fails the score check cannot substitute.
 */
export function prop_decideToSubstitute_below_threshold_is_false(): boolean {
  // Scores at or below 0.85
  const weakScores = [0.0, 0.3, 0.5, 0.7, 0.80, 0.84, AUTO_ACCEPT_SCORE_THRESHOLD];
  for (const score of weakScores) {
    const d = scoreToDistance(score);
    const result = decideToSubstitute([makeCandidate(d, "any")]);
    if (result.substitute) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// D6 — decideToSubstitute: gap ≤ gap threshold → substitute=false
// ---------------------------------------------------------------------------

/**
 * prop_decideToSubstitute_small_gap_is_false
 *
 * When top-1 > 0.85 but the gap to top-2 ≤ AUTO_ACCEPT_GAP_THRESHOLD (0.15),
 * substitute=false.
 *
 * Invariant: the gap check catches ambiguous cases where two candidates are
 * too close to each other for confident substitution.
 */
export function prop_decideToSubstitute_small_gap_is_false(): boolean {
  // top-1 = 0.92, top-2 = 0.80 → gap = 0.12 < 0.15
  const d1 = scoreToDistance(0.92);
  const d2 = scoreToDistance(0.80);
  const result = decideToSubstitute([makeCandidate(d1, "top"), makeCandidate(d2, "second")]);
  if (result.substitute) return false;

  // top-1 = 0.90, top-2 = 0.76 → gap = 0.14 < 0.15
  const d3 = scoreToDistance(0.90);
  const d4 = scoreToDistance(0.76);
  const result2 = decideToSubstitute([makeCandidate(d3, "top2"), makeCandidate(d4, "second2")]);
  if (result2.substitute) return false;

  // Exactly at gap threshold (gap === 0.15) — boundary, which uses `<=` so still false
  const d5 = scoreToDistance(0.90);
  const d6 = scoreToDistance(0.90 - AUTO_ACCEPT_GAP_THRESHOLD); // gap exactly 0.15
  const result3 = decideToSubstitute([makeCandidate(d5, "boundary"), makeCandidate(d6, "second3")]);
  if (result3.substitute) return false;

  return true;
}

// ---------------------------------------------------------------------------
// R1 — renderSubstitution: totality
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_total
 *
 * renderSubstitution never throws for any combination of valid atom hashes,
 * original code strings, and BindingShape values.
 *
 * Invariant: renderSubstitution performs only string concatenation — it is
 * total for all valid inputs.
 */
export function prop_renderSubstitution_total(): boolean {
  const bindings: BindingShape[] = [
    { name: "result", args: [], atomName: "getTimestamp" },
    { name: "x", args: ["input"], atomName: "listOfInts" },
    { name: "out", args: ["a", "b", "c"], atomName: "merge" },
    { name: "val", args: ['"string-literal"', "42"], atomName: "computeHash" },
  ];
  for (const binding of bindings) {
    for (const atomName of ATOM_NAMES) {
      for (const hash of FULL_HASHES) {
        try {
          renderSubstitution(hash, "const x = fn();", { ...binding, atomName });
        } catch {
          return false;
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// R2 — renderSubstitution: determinism
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_deterministic
 *
 * Two calls with identical inputs produce identical outputs.
 *
 * Invariant: renderSubstitution is a pure function — no side effects, no
 * random or time-dependent output.
 */
export function prop_renderSubstitution_deterministic(): boolean {
  const binding: BindingShape = { name: "result", args: ["input"], atomName: "listOfInts" };
  for (const hash of FULL_HASHES) {
    const r1 = renderSubstitution(hash, "const result = listOfInts(input);", binding);
    const r2 = renderSubstitution(hash, "const result = listOfInts(input);", binding);
    if (r1 !== r2) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// R3 — renderSubstitution: import path format
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_import_path_convention
 *
 * For every valid atomName, renderSubstitution always produces output that
 * contains `@yakcc/atoms/<atomName>`.
 *
 * Invariant: DEC-HOOK-PHASE-2-001(A) — the import path is always
 * `@yakcc/atoms/<atomName>`, never a relative or registry path.
 */
export function prop_renderSubstitution_import_path_convention(): boolean {
  for (const atomName of ATOM_NAMES) {
    const result = renderSubstitution(
      "deadbeef12345678",
      `const x = ${atomName}();`,
      { name: "x", args: [], atomName },
    );
    if (!result.includes(`@yakcc/atoms/${atomName}`)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// R4 — renderSubstitution: binding name preserved
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_binding_name_preserved
 *
 * For every variable name, renderSubstitution always produces output that
 * contains `const <name>`.
 *
 * Invariant: the binding name from the original code is preserved exactly
 * in the rendered output — no renaming, no mangling.
 */
export function prop_renderSubstitution_binding_name_preserved(): boolean {
  for (const name of VAR_NAMES) {
    const result = renderSubstitution(
      "abc12345",
      `const ${name} = fn(a);`,
      { name, args: ["a"], atomName: "fn" },
    );
    if (!result.includes(`const ${name}`)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// R5 — renderSubstitution without spec: exactly 2 lines
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_no_spec_two_lines
 *
 * When spec is not provided, renderSubstitution returns exactly 2 lines:
 * import line + const binding line.
 *
 * Invariant: the Phase 2 two-line format (no spec) is always produced when
 * spec is undefined. No contract comment line is prepended.
 */
export function prop_renderSubstitution_no_spec_two_lines(): boolean {
  for (const atomName of ATOM_NAMES) {
    const result = renderSubstitution(
      "deadbeef12345678",
      `const x = ${atomName}(input);`,
      { name: "x", args: ["input"], atomName },
      // no spec
    );
    const lines = result.split("\n");
    if (lines.length !== 2) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// R6 — renderSubstitution with spec: exactly 3 lines
// ---------------------------------------------------------------------------

/**
 * prop_renderSubstitution_with_spec_three_lines
 *
 * When spec is provided, renderSubstitution returns exactly 3 lines:
 * contract comment + import line + const binding line.
 *
 * Invariant: the Phase 3 three-line format (with spec) is always produced
 * when spec is defined. The contract comment is always prepended first.
 */
export function prop_renderSubstitution_with_spec_three_lines(): boolean {
  const spec = makeSpec();
  for (const atomName of ATOM_NAMES) {
    const result = renderSubstitution(
      "deadbeef12345678",
      `const x = ${atomName}(input);`,
      { name: "x", args: ["input"], atomName },
      spec,
    );
    const lines = result.split("\n");
    if (lines.length !== 3) return false;
    // First line must be the contract comment
    if (!lines[0]!.startsWith("// @atom ")) return false;
    // Second line must be the import
    if (!lines[1]!.startsWith("import {")) return false;
    // Third line must be the const binding
    if (!lines[2]!.startsWith("const ")) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// K1 — renderContractComment: totality
// ---------------------------------------------------------------------------

/**
 * prop_renderContractComment_total
 *
 * renderContractComment never throws for any valid combination of atomName,
 * full hash, and SpecYak (including edge cases: no inputs, no guarantees).
 *
 * Invariant: the comment renderer does only string operations — it is total
 * for all valid inputs.
 */
export function prop_renderContractComment_total(): boolean {
  const specs = [
    makeSpec(),
    makeSpec({ inputs: [], guarantees: [] }),
    makeSpec({ inputs: [], guarantees: undefined }),
    makeSpec({ inputs: [{ name: "a", type: "string" }, { name: "b", type: "number" }] }),
    makeSpec({ guarantees: [{ id: "G1", description: "first" }, { id: "G2", description: "second" }] }),
  ];
  for (const spec of specs) {
    for (const atomName of ATOM_NAMES) {
      for (const hash of FULL_HASHES) {
        try {
          renderContractComment(atomName, hash, spec);
        } catch {
          return false;
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// K2 — renderContractComment: determinism
// ---------------------------------------------------------------------------

/**
 * prop_renderContractComment_deterministic
 *
 * Two calls with identical inputs produce identical outputs.
 *
 * Invariant: renderContractComment is a pure function — no side effects, no
 * random or time-dependent output.
 */
export function prop_renderContractComment_deterministic(): boolean {
  const spec = makeSpec();
  for (const atomName of ATOM_NAMES) {
    for (const hash of FULL_HASHES) {
      const c1 = renderContractComment(atomName, hash, spec);
      const c2 = renderContractComment(atomName, hash, spec);
      if (c1 !== c2) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// K3 — renderContractComment: always starts with "// @atom "
// ---------------------------------------------------------------------------

/**
 * prop_renderContractComment_starts_with_at_atom
 *
 * For every valid input, renderContractComment always produces a string that
 * starts with "// @atom ".
 *
 * Invariant: the comment format prefix is always present — parsers and LLMs
 * that look for the "// @atom " marker can rely on it.
 */
export function prop_renderContractComment_starts_with_at_atom(): boolean {
  const spec = makeSpec();
  for (const atomName of ATOM_NAMES) {
    const comment = renderContractComment(atomName, "deadbeef12345678", spec);
    if (!comment.startsWith("// @atom ")) return false;
    // The atom name immediately follows the prefix
    if (!comment.startsWith(`// @atom ${atomName} `)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// K4 — renderContractComment: hash truncation to 8 chars
// ---------------------------------------------------------------------------

/**
 * prop_renderContractComment_hash_truncated_to_8_chars
 *
 * For every full 32+ char hash, the comment always ends with
 * `yakcc:<first 8 chars of hash>`.
 *
 * Invariant: only the first 8 hex characters of the BlockMerkleRoot are
 * emitted per DEC-HOOK-PHASE-3-001. The full hash is not exposed in the comment.
 */
export function prop_renderContractComment_hash_truncated_to_8_chars(): boolean {
  const spec = makeSpec();
  for (const hash of FULL_HASHES) {
    const comment = renderContractComment("testAtom", hash, spec);
    const expected = `yakcc:${hash.slice(0, 8)}`;
    if (!comment.endsWith(expected)) return false;
    // The full hash (beyond 8 chars) must NOT appear
    if (comment.includes(`yakcc:${hash.slice(0, 16)}`)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// K5 — renderContractComment: no trailing semicolon with empty guarantees
// ---------------------------------------------------------------------------

/**
 * prop_renderContractComment_no_trailing_semicolon_when_no_guarantees
 *
 * When guarantees is empty or undefined, renderContractComment produces a
 * comment without "; )" or ";)" — no trailing semicolon artifact.
 *
 * Invariant: the `; <key-guarantee>` portion is omitted entirely when there
 * is no guarantee to show. The output is always syntactically clean.
 */
export function prop_renderContractComment_no_trailing_semicolon_when_no_guarantees(): boolean {
  const emptyGuaranteesSpecs = [
    makeSpec({ guarantees: [] }),
    makeSpec({ guarantees: undefined }),
  ];
  for (const spec of emptyGuaranteesSpecs) {
    const comment = renderContractComment("testAtom", "deadbeef12345678", spec);
    if (comment.includes("; )")) return false;
    if (comment.includes(";)")) return false;
    // Must still be a valid comment (no semicolons anywhere)
    if (comment.includes(";")) return false;
  }
  return true;
}
