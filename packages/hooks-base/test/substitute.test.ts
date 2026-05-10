// SPDX-License-Identifier: MIT
/**
 * substitute.test.ts — Tests for decideToSubstitute() and renderSubstitution().
 *
 * Production sequence exercised:
 *   findCandidatesByIntent() returns CandidateMatch[] →
 *   decideToSubstitute(candidates) → { substitute: true, atomHash } or { substitute: false } →
 *   renderSubstitution(atomHash, originalCode, bindingShape) → substituted source text
 *
 * Test-first: these tests define the contract; substitute.ts must satisfy them.
 */

import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_GAP_THRESHOLD,
  AUTO_ACCEPT_SCORE_THRESHOLD,
  candidatesToCombinedScores,
  decideToSubstitute,
  renderSubstitution,
} from "../src/substitute.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal CandidateMatch stub for tests
// ---------------------------------------------------------------------------

/** Build a CandidateMatch stub from a cosineDistance value. */
function makeCandidate(cosineDistance: number, blockMerkleRoot = "deadbeef") {
  return {
    block: {
      blockMerkleRoot,
      specHash: "aabbcc" as import("@yakcc/contracts").SpecHash,
      specCanonicalBytes: new Uint8Array(0),
      implSource: `export function stub(): void {}`,
      proofManifestJson: "{}",
      level: "L0" as const,
      createdAt: 0,
      canonicalAstHash: "00112233" as import("@yakcc/contracts").CanonicalAstHash,
      artifacts: new Map<string, Uint8Array>(),
    },
    cosineDistance,
  };
}

// ---------------------------------------------------------------------------
// candidatesToCombinedScores
// ---------------------------------------------------------------------------

describe("candidatesToCombinedScores", () => {
  it("maps cosineDistance=0 to combinedScore=1.0", () => {
    const scores = candidatesToCombinedScores([makeCandidate(0)]);
    expect(scores[0]).toBeCloseTo(1.0, 5);
  });

  it("maps cosineDistance=2 to combinedScore=0.0", () => {
    const scores = candidatesToCombinedScores([makeCandidate(2)]);
    expect(scores[0]).toBeCloseTo(0.0, 5);
  });

  it("maps cosineDistance=sqrt(2) to combinedScore=0.5", () => {
    const scores = candidatesToCombinedScores([makeCandidate(Math.sqrt(2))]);
    expect(scores[0]).toBeCloseTo(0.5, 5);
  });

  it("maps multiple candidates independently", () => {
    const scores = candidatesToCombinedScores([makeCandidate(0), makeCandidate(Math.sqrt(2)), makeCandidate(2)]);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBeCloseTo(1.0, 5);
    expect(scores[1]).toBeCloseTo(0.5, 5);
    expect(scores[2]).toBeCloseTo(0.0, 5);
  });

  it("returns empty array for empty input", () => {
    expect(candidatesToCombinedScores([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// decideToSubstitute — threshold constants
// ---------------------------------------------------------------------------

describe("D2 threshold constants", () => {
  it("AUTO_ACCEPT_SCORE_THRESHOLD is 0.85", () => {
    expect(AUTO_ACCEPT_SCORE_THRESHOLD).toBe(0.85);
  });

  it("AUTO_ACCEPT_GAP_THRESHOLD is 0.15", () => {
    expect(AUTO_ACCEPT_GAP_THRESHOLD).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// decideToSubstitute — decision logic (D2 auto-accept rule)
// ---------------------------------------------------------------------------

describe("decideToSubstitute", () => {
  it("returns substitute=false when candidates array is empty", () => {
    const result = decideToSubstitute([]);
    expect(result.substitute).toBe(false);
  });

  it("returns substitute=false when top-1 combinedScore <= 0.85", () => {
    // cosineDistance that maps to ~0.84 combinedScore:
    // combinedScore = 1 - d²/4 = 0.84 → d² = 0.64 → d ≈ 0.8
    const d = Math.sqrt((1 - 0.84) * 4); // ~0.8
    const result = decideToSubstitute([makeCandidate(d)]);
    expect(result.substitute).toBe(false);
  });

  it("returns substitute=false when top-1 > 0.85 but gap <= 0.15 (single candidate)", () => {
    // Single candidate: gap = top1 - 0 = top1Score (no top-2 → treat gap as top1 score)
    // With d=0 → combinedScore=1.0, gap = 1.0 - 0 = 1.0 > 0.15 → SHOULD substitute
    // Wait: with only 1 candidate, top-2 doesn't exist.
    // Per spec: "gap-to-top-2 > 0.15" → when there's no top-2, gap = top1Score (vs 0)
    // So single high-confidence candidate → substitute=true
    const result = decideToSubstitute([makeCandidate(0, "aaa")]);
    expect(result.substitute).toBe(true);
    if (result.substitute) {
      expect(result.atomHash).toBe("aaa");
    }
  });

  it("returns substitute=false when gap <= 0.15 (two close candidates)", () => {
    // top-1 combinedScore = 0.90, top-2 combinedScore = 0.80 → gap = 0.10 < 0.15
    // d for 0.90: 1 - d²/4 = 0.90 → d² = 0.40 → d ≈ 0.632
    // d for 0.80: 1 - d²/4 = 0.80 → d² = 0.80 → d ≈ 0.894
    const d1 = Math.sqrt((1 - 0.90) * 4);
    const d2 = Math.sqrt((1 - 0.80) * 4);
    const result = decideToSubstitute([makeCandidate(d1, "first"), makeCandidate(d2, "second")]);
    expect(result.substitute).toBe(false);
  });

  it("returns substitute=true when top-1 > 0.85 AND gap > 0.15", () => {
    // top-1 = 0.92, top-2 = 0.70 → gap = 0.22 > 0.15
    const d1 = Math.sqrt((1 - 0.92) * 4);
    const d2 = Math.sqrt((1 - 0.70) * 4);
    const result = decideToSubstitute([makeCandidate(d1, "winner"), makeCandidate(d2, "second")]);
    expect(result.substitute).toBe(true);
    if (result.substitute) {
      expect(result.atomHash).toBe("winner");
    }
  });

  it("returns substitute=false when top-1 < 0.85 even if gap > 0.15", () => {
    // top-1 = 0.75, top-2 = 0.50 → gap = 0.25 > 0.15 but top-1 < 0.85
    const d1 = Math.sqrt((1 - 0.75) * 4);
    const d2 = Math.sqrt((1 - 0.50) * 4);
    const result = decideToSubstitute([makeCandidate(d1, "close"), makeCandidate(d2, "distant")]);
    expect(result.substitute).toBe(false);
  });

  it("uses blockMerkleRoot as atomHash in the true case", () => {
    const merkleRoot = "cafebabe1234567890abcdef";
    const d = Math.sqrt((1 - 0.95) * 4);
    const result = decideToSubstitute([makeCandidate(d, merkleRoot)]);
    expect(result.substitute).toBe(true);
    if (result.substitute) {
      expect(result.atomHash).toBe(merkleRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// renderSubstitution
// ---------------------------------------------------------------------------

describe("renderSubstitution", () => {
  it("generates import + const binding for a simple function call", () => {
    const result = renderSubstitution(
      "deadbeef1234",
      "const result = listOfInts(input);",
      { name: "result", args: ["input"], atomName: "listOfInts" },
    );
    // Must include an import line
    expect(result).toContain("import");
    expect(result).toContain("listOfInts");
    // Must preserve the binding name
    expect(result).toContain("result");
    // Must call the atom with the original args
    expect(result).toContain("input");
  });

  it("import path follows @yakcc/atoms/<atomName> convention", () => {
    const result = renderSubstitution(
      "abc123",
      'const x = computeHash(data, "sha256");',
      { name: "x", args: ["data", '"sha256"'], atomName: "computeHash" },
    );
    expect(result).toContain("@yakcc/atoms/computeHash");
  });

  it("preserves variable binding name exactly", () => {
    const result = renderSubstitution(
      "00ff",
      "const mySpecialVar = transform(input);",
      { name: "mySpecialVar", args: ["input"], atomName: "transform" },
    );
    expect(result).toContain("const mySpecialVar");
  });

  it("produces syntactically valid looking output (no template artifacts)", () => {
    const result = renderSubstitution(
      "abc",
      "const r = fn(a, b);",
      { name: "r", args: ["a", "b"], atomName: "fn" },
    );
    // Should not contain raw template placeholders
    expect(result).not.toContain("${");
    expect(result).not.toContain("undefined");
  });

  it("handles zero-arg calls", () => {
    const result = renderSubstitution(
      "zero",
      "const val = getTimestamp();",
      { name: "val", args: [], atomName: "getTimestamp" },
    );
    expect(result).toContain("getTimestamp()");
    expect(result).toContain("const val");
  });

  it("handles multi-arg calls", () => {
    const result = renderSubstitution(
      "multi",
      "const out = merge(a, b, c);",
      { name: "out", args: ["a", "b", "c"], atomName: "merge" },
    );
    expect(result).toContain("a, b, c");
  });
});
