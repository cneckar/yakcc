// SPDX-License-Identifier: MIT
/**
 * Tests for lowerability-filter.ts -- post-retrieval output-target filter.
 *
 * Truth table: undefined|ts->pass-through; go|rs->unknown all; py->drop bigint, keep pure.
 * Compound-interaction test covers real production call chain (no mocks).
 *
 * @decision DEC-DISCOVERY-D2-LANGUAGE-001
 */

import type { BlockMerkleRoot, CandidateMatch, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import {
  type AnnotatedCandidateMatch,
  applyLowerabilityFilter,
  parseTargetLanguage,
} from "./lowerability-filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidateMatch(implSource: string): CandidateMatch {
  return {
    cosineDistance: 0.1,
    structuralScore: undefined,
    block: {
      blockMerkleRoot: "deadbeef1234" as BlockMerkleRoot,
      specHash: "dead" as SpecHash,
      specCanonicalBytes: new Uint8Array(),
      implSource,
      proofManifestJson: "{}",
      level: "L0",
      createdAt: 0,
      canonicalAstHash: "dead" as CanonicalAstHash,
      artifacts: new Map(),
    },
  };
}

// ---------------------------------------------------------------------------
// Atom source fixtures (mirroring can-lower-to.test.ts for consistency)
// ---------------------------------------------------------------------------

const PURE_ATOM_SRC = `
export function add(a: number, b: number): number {
  return a + b;
}`;

const BIGINT_TYPE_ATOM_SRC = `
export function widen(x: bigint): bigint {
  return x;
}`;

const BIGINT_LITERAL_ATOM_SRC = `
export function answer(): bigint {
  return 42n;
}`;

const STRING_ATOM_SRC = `
export function greet(name: string): string {
  return "hello " + name;
}`;

// ---------------------------------------------------------------------------
// parseTargetLanguage -- validation
// ---------------------------------------------------------------------------

describe("parseTargetLanguage", () => {
  it("returns 'ts' for 'ts'", () => {
    expect(parseTargetLanguage("ts")).toBe("ts");
  });
  it("returns 'py' for 'py'", () => {
    expect(parseTargetLanguage("py")).toBe("py");
  });
  it("returns 'go' for 'go'", () => {
    expect(parseTargetLanguage("go")).toBe("go");
  });
  it("returns 'rs' for 'rs'", () => {
    expect(parseTargetLanguage("rs")).toBe("rs");
  });
  it("returns undefined for invalid values", () => {
    expect(parseTargetLanguage("java")).toBeUndefined();
    expect(parseTargetLanguage("")).toBeUndefined();
    expect(parseTargetLanguage("PY")).toBeUndefined();
    expect(parseTargetLanguage("python")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pass-through: undefined and "ts"
// ---------------------------------------------------------------------------

describe("applyLowerabilityFilter -- pass-through (no filter)", () => {
  const candidates = [makeCandidateMatch(PURE_ATOM_SRC), makeCandidateMatch(BIGINT_TYPE_ATOM_SRC)];

  it("language=undefined returns filtered=false with same array reference", () => {
    const result = applyLowerabilityFilter(candidates, undefined);
    expect(result.filtered).toBe(false);
    expect(result.candidates).toBe(candidates);
  });

  it("language='ts' returns filtered=false with same array reference", () => {
    const result = applyLowerabilityFilter(candidates, "ts");
    expect(result.filtered).toBe(false);
    expect(result.candidates).toBe(candidates);
  });

  it("empty candidate list with undefined -> filtered=false, length=0", () => {
    const result = applyLowerabilityFilter([], undefined);
    expect(result.filtered).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// go / rs: no adapter shipped -- all lowerability="unknown", none dropped
// ---------------------------------------------------------------------------

describe("applyLowerabilityFilter -- go (no adapter shipped)", () => {
  it("pure atom gets lowerability=unknown, not dropped", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(PURE_ATOM_SRC)], "go");
    expect(result.filtered).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect((result.candidates[0] as AnnotatedCandidateMatch).lowerability).toBe("unknown");
  });

  it("bigint atom gets lowerability=unknown (NOT dropped for go)", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(BIGINT_TYPE_ATOM_SRC)], "go");
    expect(result.candidates).toHaveLength(1);
    expect((result.candidates[0] as AnnotatedCandidateMatch).lowerability).toBe("unknown");
  });

  it("all candidates retained with unknown for go", () => {
    const candidates = [
      makeCandidateMatch(PURE_ATOM_SRC),
      makeCandidateMatch(BIGINT_TYPE_ATOM_SRC),
    ];
    const result = applyLowerabilityFilter(candidates, "go");
    expect(result.candidates).toHaveLength(2);
  });
});

describe("applyLowerabilityFilter -- rs (no adapter shipped)", () => {
  it("returns lowerability=unknown for all candidates", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(PURE_ATOM_SRC)], "rs");
    expect(result.filtered).toBe(true);
    expect((result.candidates[0] as AnnotatedCandidateMatch).lowerability).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// py: real canLowerTo gate applied -- drop bigint, keep pure
// ---------------------------------------------------------------------------

describe("applyLowerabilityFilter -- py, pure atoms retained with lowerability=yes", () => {
  it("pure number/number atom -> lowerability=yes", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(PURE_ATOM_SRC)], "py");
    expect(result.filtered).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect((result.candidates[0] as AnnotatedCandidateMatch).lowerability).toBe("yes");
  });

  it("string atom -> lowerability=yes", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(STRING_ATOM_SRC)], "py");
    expect(result.filtered).toBe(true);
    expect((result.candidates[0] as AnnotatedCandidateMatch).lowerability).toBe("yes");
  });
});

describe("applyLowerabilityFilter -- py, bigint atoms dropped (lowerability=no)", () => {
  it("bigint type annotation atom is dropped (not in results)", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(BIGINT_TYPE_ATOM_SRC)], "py");
    expect(result.filtered).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("bigint literal atom is dropped", () => {
    const result = applyLowerabilityFilter([makeCandidateMatch(BIGINT_LITERAL_ATOM_SRC)], "py");
    expect(result.filtered).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("mixed set: 2 pure atoms kept, 1 bigint atom dropped", () => {
    const candidates = [
      makeCandidateMatch(PURE_ATOM_SRC),
      makeCandidateMatch(BIGINT_TYPE_ATOM_SRC),
      makeCandidateMatch(STRING_ATOM_SRC),
    ];
    const result = applyLowerabilityFilter(candidates, "py");
    expect(result.filtered).toBe(true);
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect((c as AnnotatedCandidateMatch).lowerability).toBe("yes");
    }
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test (#20):
// Real production sequence: registry KNN result -> applyLowerabilityFilter -> render.
// Crosses lowerability-filter.ts and @yakcc/compile-python (canLowerTo) without mocks.
// This is the actual production call sequence used by the query command.
// ---------------------------------------------------------------------------

describe("applyLowerabilityFilter -- compound interaction (production sequence)", () => {
  it("py: bigint dropped, pure and string kept in original order with yes annotation", () => {
    // Simulates registry returning 3 candidates sorted by cosine distance.
    // Production: query.ts calls findCandidatesByIntent then applyLowerabilityFilter.
    const allCandidates = [
      makeCandidateMatch(PURE_ATOM_SRC), // canLowerTo="py" -> true -> yes
      makeCandidateMatch(BIGINT_TYPE_ATOM_SRC), // canLowerTo="py" -> false -> dropped
      makeCandidateMatch(STRING_ATOM_SRC), // canLowerTo="py" -> true -> yes
    ];

    const pyResult = applyLowerabilityFilter(allCandidates, "py");
    expect(pyResult.filtered).toBe(true);
    expect(pyResult.candidates).toHaveLength(2);

    const first = pyResult.candidates[0] as AnnotatedCandidateMatch;
    const second = pyResult.candidates[1] as AnnotatedCandidateMatch;
    // Order is preserved -- PURE_ATOM first, STRING_ATOM second
    expect(first.lowerability).toBe("yes");
    expect(first.block.implSource).toContain("add(a");
    expect(second.lowerability).toBe("yes");
    expect(second.block.implSource).toContain("greet(");
  });

  it("go: all candidates retained with unknown, cosineDistance preserved", () => {
    const allCandidates = [
      makeCandidateMatch(BIGINT_TYPE_ATOM_SRC),
      makeCandidateMatch(PURE_ATOM_SRC),
    ];

    const goResult = applyLowerabilityFilter(allCandidates, "go");
    expect(goResult.filtered).toBe(true);
    expect(goResult.candidates).toHaveLength(2);
    for (const c of goResult.candidates) {
      expect((c as AnnotatedCandidateMatch).lowerability).toBe("unknown");
      // cosineDistance passes through unchanged
      expect(c.cosineDistance).toBe(0.1);
    }
  });

  it("ts: returns same array reference (zero overhead on the default path)", () => {
    // This is the hot path: all existing callers that do not pass --language
    // get the pass-through with NO allocation and NO canLowerTo call.
    const allCandidates = [makeCandidateMatch(BIGINT_TYPE_ATOM_SRC)];
    const tsResult = applyLowerabilityFilter(allCandidates, "ts");
    expect(tsResult.filtered).toBe(false);
    expect(tsResult.candidates).toBe(allCandidates); // same reference, zero copy
  });

  it("undefined: same as ts, same reference returned", () => {
    const allCandidates = [makeCandidateMatch(PURE_ATOM_SRC)];
    const undefResult = applyLowerabilityFilter(allCandidates, undefined);
    expect(undefResult.filtered).toBe(false);
    expect(undefResult.candidates).toBe(allCandidates);
  });
});
