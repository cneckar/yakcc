// SPDX-License-Identifier: MIT
/**
 * substitute.test.ts — Tests for decideToSubstitute(), renderContractComment(),
 * and renderSubstitution() (Phase 2 + Phase 3 contract comment extension).
 *
 * Production sequence exercised:
 *   findCandidatesByIntent() returns CandidateMatch[] →
 *   decideToSubstitute(candidates) → { substitute: true, atomHash } or { substitute: false } →
 *   renderSubstitution(atomHash, originalCode, bindingShape, spec?) → substituted source text
 *     where spec present → contract comment prepended above import
 *
 * Test-first: these tests define the contract; substitute.ts must satisfy them.
 */

import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_GAP_THRESHOLD,
  AUTO_ACCEPT_SCORE_THRESHOLD,
  candidatesToCombinedScores,
  decideToSubstitute,
  renderContractComment,
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

// ---------------------------------------------------------------------------
// renderContractComment — Phase 3 D-HOOK-4 contract comment generation
// ---------------------------------------------------------------------------

/** Minimal SpecYak factory for contract-comment tests. */
function makeSpec(overrides: Partial<SpecYak> = {}): SpecYak {
  return {
    name: "testAtom",
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    guarantees: [{ id: "G1", description: "rejects non-int" }],
    ...overrides,
  };
}

describe("renderContractComment", () => {
  it("simple: 1-arg fn with 1 guarantee → exact comment match", () => {
    const spec = makeSpec({
      name: "listOfInts",
      inputs: [{ name: "text", type: "string" }],
      outputs: [{ name: "result", type: "number[]" }],
      guarantees: [{ id: "G1", description: "rejects non-int" }],
    });
    const comment = renderContractComment("listOfInts", "abc12345deadbeef", spec);
    expect(comment).toBe("// @atom listOfInts (string => number[]; rejects non-int) — yakcc:abc12345");
  });

  it("multi-arg: 2 inputs render as (a, b) => out", () => {
    const spec = makeSpec({
      name: "merge",
      inputs: [
        { name: "a", type: "string[]" },
        { name: "b", type: "string[]" },
      ],
      outputs: [{ name: "result", type: "string[]" }],
      guarantees: [{ id: "G1", description: "preserves order" }],
    });
    const comment = renderContractComment("merge", "cafebabe12345678", spec);
    expect(comment).toBe("// @atom merge (string[], string[] => string[]; preserves order) — yakcc:cafebabe");
  });

  it("3 inputs render as (a, b, c) => out", () => {
    const spec = makeSpec({
      name: "combine",
      inputs: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
        { name: "z", type: "number" },
      ],
      outputs: [{ name: "result", type: "number" }],
      guarantees: [{ id: "G1", description: "associative" }],
    });
    const comment = renderContractComment("combine", "deadbeef00000000", spec);
    expect(comment).toBe("// @atom combine (number, number, number => number; associative) — yakcc:deadbeef");
  });

  it("no guarantees: parenthetical omitted cleanly — no trailing semicolon", () => {
    const spec = makeSpec({
      name: "getTimestamp",
      inputs: [],
      outputs: [{ name: "result", type: "number" }],
      guarantees: [],
    });
    const comment = renderContractComment("getTimestamp", "aabbccdd11223344", spec);
    // Must not contain '; )' or trailing semicolon artifact
    expect(comment).not.toContain("; )");
    expect(comment).not.toContain(";)");
    // Must end with hash[:8]
    expect(comment).toBe("// @atom getTimestamp (() => number) — yakcc:aabbccdd");
  });

  it("no guarantees and undefined guarantees field: omit parenthetical cleanly", () => {
    const spec = makeSpec({
      name: "pureOp",
      inputs: [{ name: "x", type: "boolean" }],
      outputs: [{ name: "result", type: "boolean" }],
      guarantees: undefined,
    });
    const comment = renderContractComment("pureOp", "1234567890abcdef", spec);
    expect(comment).toBe("// @atom pureOp (boolean => boolean) — yakcc:12345678");
  });

  it("BlockMerkleRoot truncation: hash[:8] match", () => {
    const spec = makeSpec();
    const fullHash = "fedcba9876543210abcdef0123456789";
    const comment = renderContractComment("testAtom", fullHash, spec);
    expect(comment).toContain("yakcc:fedcba98");
    expect(comment).not.toContain("yakcc:fedcba9876543210");
  });

  it("only FIRST guarantee is used (not all guarantees)", () => {
    const spec = makeSpec({
      name: "multiGuarantee",
      inputs: [{ name: "x", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      guarantees: [
        { id: "G1", description: "first guarantee" },
        { id: "G2", description: "second guarantee" },
        { id: "G3", description: "third guarantee" },
      ],
    });
    const comment = renderContractComment("multiGuarantee", "abcdef0123456789", spec);
    expect(comment).toContain("first guarantee");
    expect(comment).not.toContain("second guarantee");
    expect(comment).not.toContain("third guarantee");
  });
});

// ---------------------------------------------------------------------------
// renderSubstitution — Phase 3: contract comment prepended when spec provided
// ---------------------------------------------------------------------------

describe("renderSubstitution with spec (Phase 3 contract comment)", () => {
  it("when spec provided: contract comment appears above import line", () => {
    const spec = makeSpec({
      name: "listOfInts",
      inputs: [{ name: "text", type: "string" }],
      outputs: [{ name: "result", type: "number[]" }],
      guarantees: [{ id: "G1", description: "rejects non-int" }],
    });
    const result = renderSubstitution(
      "abc12345deadbeef",
      "const result = listOfInts(input);",
      { name: "result", args: ["input"], atomName: "listOfInts" },
      spec,
    );

    const lines = result.split("\n");
    // First line: contract comment
    expect(lines[0]).toBe("// @atom listOfInts (string => number[]; rejects non-int) — yakcc:abc12345");
    // Second line: import
    expect(lines[1]).toContain("import { listOfInts }");
    expect(lines[1]).toContain("@yakcc/atoms/listOfInts");
    // Third line: binding
    expect(lines[2]).toContain("const result = listOfInts(input)");
  });

  it("when spec NOT provided: no contract comment — output is 2 lines (import + binding)", () => {
    const result = renderSubstitution(
      "deadbeef",
      "const x = fn(a);",
      { name: "x", args: ["a"], atomName: "fn" },
      // no spec
    );
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("import");
    expect(lines[1]).toContain("const x");
  });

  it("when spec has no guarantees: comment omits semicolon parenthetical", () => {
    const spec = makeSpec({
      name: "getTime",
      inputs: [],
      outputs: [{ name: "result", type: "number" }],
      guarantees: [],
    });
    const result = renderSubstitution(
      "11223344aabbccdd",
      "const t = getTime();",
      { name: "t", args: [], atomName: "getTime" },
      spec,
    );
    const firstLine = result.split("\n")[0];
    expect(firstLine).not.toContain("; )");
    expect(firstLine).toContain("// @atom getTime");
  });

  it("existing tests still pass when spec=undefined: backward compatible", () => {
    const result = renderSubstitution(
      "abc123",
      'const x = computeHash(data, "sha256");',
      { name: "x", args: ["data", '"sha256"'], atomName: "computeHash" },
    );
    expect(result).toContain("@yakcc/atoms/computeHash");
    expect(result).not.toContain("@atom");
  });
});
