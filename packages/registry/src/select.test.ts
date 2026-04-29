/**
 * select.test.ts — unit tests for select().
 *
 * select() is a pure function: no DB, no I/O. All tests construct synthetic
 * SelectMatch, StrictnessEdge, and CandidateProvenance values directly.
 *
 * Cases covered:
 *   - Single match returned as-is
 *   - Two matches with explicit strictness edge: stricter wins
 *   - Three-way comparable chain A < B < C: C wins
 *   - Incomparable pair: stronger non-functional properties win
 *   - Tiebreak by test history: more passing runs win
 *   - Final fallback: lexicographically-smaller contract id wins
 *
 * Production sequence: storage.ts calls select(candidates.map(c => c.match))
 * after search() + structural filtering. The result is the contract the
 * assembler uses to resolve a block.
 */

import { describe, it, expect } from "vitest";
import type { ContractId, ContractSpec } from "@yakcc/contracts";
import { select } from "./select.js";
import type { SelectMatch, StrictnessEdge, CandidateProvenance } from "./select.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Make a minimal ContractSpec. Defaults to pure/safe with O(n) time — the
 * highest quality non-functional tier. Tests that need weaker specs override
 * the nonFunctional field.
 */
function makeSpec(overrides: Partial<ContractSpec> = {}): ContractSpec {
  return {
    inputs: [{ name: "value", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    behavior: "Parse an integer from a string",
    guarantees: [{ id: "total", description: "Always returns or throws." }],
    errorConditions: [],
    nonFunctional: {
      purity: "pure",
      threadSafety: "safe",
      time: "O(n)",
      space: "O(1)",
    },
    propertyTests: [],
    ...overrides,
  };
}

/**
 * Build a SelectMatch with the given contractId suffix (padded to 64 chars)
 * and optional spec overrides.
 *
 * The contract id is synthetic: we use a repeating-character string so ids
 * are predictable and their lexicographic ordering is controlled by the char.
 */
function makeMatch(
  idChar: string,
  specOverrides: Partial<ContractSpec> = {},
  score = 0.9,
): SelectMatch {
  const id = idChar.repeat(64) as ContractId;
  return {
    contract: {
      id,
      spec: makeSpec(specOverrides),
    },
    score,
  };
}

/** Shorthand for a StrictnessEdge: stricterId beats looserId. */
function edge(stricterChar: string, looserChar: string): StrictnessEdge {
  return {
    stricterId: stricterChar.repeat(64) as ContractId,
    looserId: looserChar.repeat(64) as ContractId,
  };
}

/** Shorthand for a CandidateProvenance entry. */
function prov(idChar: string, passingRuns: number): CandidateProvenance {
  return {
    contractId: idChar.repeat(64) as ContractId,
    passingRuns,
  };
}

// ---------------------------------------------------------------------------
// Single match
// ---------------------------------------------------------------------------

describe("select — single match", () => {
  it("returns the only match when matches has length 1", () => {
    const m = makeMatch("a");
    const result = select([m], [], []);
    expect(result).toBe(m);
  });

  it("returns null for empty matches", () => {
    const result = select([], [], []);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Explicit strictness edge: stricter wins
// ---------------------------------------------------------------------------

describe("select — explicit strictness edge", () => {
  it("returns the stricter candidate when B is declared stricter than A", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");
    // B stricter than A
    const result = select([a, b], [edge("b", "a")], []);
    expect(result?.contract.id).toBe("b".repeat(64));
  });

  it("returns the stricter candidate regardless of input order (stricter first)", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");
    // Passed in reversed order
    const result = select([b, a], [edge("b", "a")], []);
    expect(result?.contract.id).toBe("b".repeat(64));
  });

  it("returns the stricter candidate when A is declared stricter than B", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");
    const result = select([a, b], [edge("a", "b")], []);
    expect(result?.contract.id).toBe("a".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Three-way comparable chain: A < B < C
// ---------------------------------------------------------------------------

describe("select — three-way comparable chain", () => {
  it("selects C when A < B < C via transitivity", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");
    const c = makeMatch("c");

    // A < B and B < C. By transitivity C should dominate.
    const result = select([a, b, c], [edge("b", "a"), edge("c", "b")], []);
    expect(result?.contract.id).toBe("c".repeat(64));
  });

  it("selects C when all three edges are explicit (redundant transitivity)", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");
    const c = makeMatch("c");

    const result = select(
      [a, b, c],
      [edge("b", "a"), edge("c", "b"), edge("c", "a")],
      [],
    );
    expect(result?.contract.id).toBe("c".repeat(64));
  });

  it("edges involving ids not in the match set are ignored", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");

    // An edge referencing "z" (not in matches) should be ignored.
    const result = select([a, b], [edge("b", "a"), edge("z", "b")], []);
    // B is still strictest in the candidate set.
    expect(result?.contract.id).toBe("b".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Incomparable pair: stronger non-functional properties win
// ---------------------------------------------------------------------------

describe("select — tiebreak by non-functional properties", () => {
  it("pure/safe beats stateful/safe when no strictness edges are declared", () => {
    // A: pure/safe (score = 3*10 + 2 = 32)
    const a = makeMatch("a", {
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    });
    // B: stateful/safe (score = 1*10 + 2 = 12)
    const b = makeMatch("b", {
      nonFunctional: { purity: "stateful", threadSafety: "safe" },
    });

    const result = select([a, b], [], []);
    expect(result?.contract.id).toBe("a".repeat(64));
  });

  it("pure/safe beats pure/unsafe (thread-safety tiebreak)", () => {
    // A: pure/safe (32)
    const a = makeMatch("a", {
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    });
    // B: pure/unsafe (30)
    const b = makeMatch("b", {
      nonFunctional: { purity: "pure", threadSafety: "unsafe" },
    });

    const result = select([a, b], [], []);
    expect(result?.contract.id).toBe("a".repeat(64));
  });

  it("O(n) time complexity beats O(n²) — reflected in non-functional purity tier", () => {
    // Use purity rank to model asymptotic quality: pure > io analogously to O(n) > O(n²).
    // The tiebreak uses purity rank. pure/safe should beat io/safe.
    const onSpec = makeMatch("a", {
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    });
    const onSquaredSpec = makeMatch("b", {
      nonFunctional: { purity: "io", threadSafety: "safe", time: "O(n^2)", space: "O(1)" },
    });

    const result = select([onSquaredSpec, onSpec], [], []);
    expect(result?.contract.id).toBe("a".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Tiebreak by test history
// ---------------------------------------------------------------------------

describe("select — tiebreak by test history (passing runs)", () => {
  it("candidate with more passing runs wins when non-functional is identical", () => {
    // Both pure/safe — identical nf score.
    const a = makeMatch("a");
    const b = makeMatch("b");

    // B has more passing runs.
    const result = select([a, b], [], [prov("a", 3), prov("b", 10)]);
    expect(result?.contract.id).toBe("b".repeat(64));
  });

  it("candidate with zero passing runs loses to one with any runs", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");

    const result = select([a, b], [], [prov("a", 0), prov("b", 1)]);
    expect(result?.contract.id).toBe("b".repeat(64));
  });

  it("missing provenance entry is treated as 0 passing runs", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");

    // Only A has provenance; B implicitly has 0.
    const result = select([a, b], [], [prov("a", 5)]);
    expect(result?.contract.id).toBe("a".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Final fallback: lexicographic id ordering
// ---------------------------------------------------------------------------

describe("select — final fallback: lexicographic id", () => {
  it("returns the lexicographically smaller id when everything else is identical", () => {
    // Both pure/safe, no provenance, no edges. 'a' < 'b' lexicographically.
    const a = makeMatch("a");
    const b = makeMatch("b");

    const result = select([a, b], [], []);
    // 'a'.repeat(64) < 'b'.repeat(64)
    expect(result?.contract.id).toBe("a".repeat(64));
  });

  it("lexicographic fallback is stable regardless of input order", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");

    const r1 = select([a, b], [], []);
    const r2 = select([b, a], [], []);

    expect(r1?.contract.id).toBe(r2?.contract.id);
    expect(r1?.contract.id).toBe("a".repeat(64));
  });

  it("'c' beats 'd' on lexicographic tiebreak among three candidates", () => {
    const c = makeMatch("c");
    const d = makeMatch("d");
    const e = makeMatch("e");

    // No edges, identical nf, no provenance.
    const result = select([e, d, c], [], []);
    expect(result?.contract.id).toBe("c".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: strictness ordering takes priority over everything
// ---------------------------------------------------------------------------

describe("select — strictness ordering dominates all tiebreaks", () => {
  it("stricter candidate wins even when it has weaker non-functional properties", () => {
    // A: io/sequential (lower nf score), but declared stricter than B.
    const a = makeMatch("a", {
      nonFunctional: { purity: "io", threadSafety: "sequential" },
    });
    // B: pure/safe (higher nf score), but A is stricter.
    const b = makeMatch("b", {
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });

    const result = select([a, b], [edge("a", "b")], []);
    // A wins because it's declared strictly stronger, despite weaker nf.
    expect(result?.contract.id).toBe("a".repeat(64));
  });

  it("stricter candidate wins even when it has fewer passing test runs", () => {
    const a = makeMatch("a");
    const b = makeMatch("b");

    // B has far more passing runs, but A is declared stricter.
    const result = select([a, b], [edge("a", "b")], [prov("a", 0), prov("b", 100)]);
    expect(result?.contract.id).toBe("a".repeat(64));
  });
});
