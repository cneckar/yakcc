// SPDX-License-Identifier: MIT
/**
 * substitute-behavior-summary.test.ts — Unit tests for WI-610: behavior summary
 * inline emission in the hook substitution contract comment.
 *
 * @decision DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
 * @title WI-610 — Append normalized spec.behavior trailer to @atom contract comment
 * @status accepted
 * @rationale
 *   B5-coherence 2026-05-14 identified opaque-hash as the dominant failure mode
 *   (36/37 of 156 turns). The LLM treats yakcc:<hash> as a token with no semantic
 *   meaning in subsequent turns. Appending a normalized behavior summary on the
 *   same line as the atom name and hash binds the behavior anchor, enabling
 *   multi-turn LLM coherence without restructuring the existing token boundary.
 *   Cross-reference: #610, plans/wi-610-behavior-summary-emit.md.
 *
 * Production sequence exercised (cases 1–8: unit layer):
 *   normalizeBehaviorForEmit(raw) → string | null
 *
 * Production sequence exercised (case 9: renderContractComment integration):
 *   renderContractComment(atomName, atomHash, spec) → comment string with behavior trailer
 *   renderSubstitution(atomHash, originalCode, binding, spec) → three-line fragment with behavior
 *
 * Production sequence exercised (case 10: regex stability):
 *   /yakcc:[0-9a-f]{8}/ matches rendered comment with and without the trailer
 *
 * Cases 1–10 map to plan §4.4 test specification:
 *   1. Behavior present, short → trailer rendered verbatim
 *   2. Behavior present, length 80 → rendered verbatim (no truncation at boundary)
 *   3. Behavior present, length 81 → truncated to 77 chars + "...", total length 80
 *   4. Behavior present with embedded newline → newline replaced with single space
 *   5. Behavior present with multiple internal spaces → collapsed to single spaces
 *   6. Behavior undefined → no trailer (base format preserved)
 *   7. Behavior empty string → no trailer
 *   8. Behavior whitespace-only → no trailer
 *   9. End-to-end: renderSubstitution + spec with behavior → behavior trailer in output
 *  10. Regex stability: /yakcc:[0-9a-f]{8}/ still matches with and without the trailer
 */

import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  normalizeBehaviorForEmit,
  renderContractComment,
  renderSubstitution,
} from "../src/substitute.js";

// ---------------------------------------------------------------------------
// Test helper: minimal SpecYak factory
// ---------------------------------------------------------------------------

/** Build a minimal SpecYak for contract-comment tests. */
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

// ---------------------------------------------------------------------------
// normalizeBehaviorForEmit — cases 1–8
// ---------------------------------------------------------------------------

describe("normalizeBehaviorForEmit", () => {
  // Case 1: Behavior present, short → rendered verbatim
  it("case 1: short behavior string is returned verbatim", () => {
    const result = normalizeBehaviorForEmit("Parses integers from a string");
    expect(result).toBe("Parses integers from a string");
  });

  // Case 2: Behavior present, exactly 80 chars → rendered verbatim (no truncation at boundary)
  it("case 2: behavior of exactly 80 chars is returned verbatim (boundary: no truncation)", () => {
    // Build a string of exactly 80 characters.
    const behavior80 = "a".repeat(80);
    expect(behavior80).toHaveLength(80);
    const result = normalizeBehaviorForEmit(behavior80);
    expect(result).toBe(behavior80);
    expect(result).toHaveLength(80);
  });

  // Case 3: Behavior present, exactly 81 chars → truncated to 77 + "...", total length 80
  it("case 3: behavior of 81 chars is truncated to 77 chars + ellipsis (total 80)", () => {
    const behavior81 = "b".repeat(81);
    expect(behavior81).toHaveLength(81);
    const result = normalizeBehaviorForEmit(behavior81);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(80);
    expect(result).toBe(`${"b".repeat(77)}...`);
    expect(result?.endsWith("...")).toBe(true);
  });

  // Case 4: Behavior with embedded newline → newline replaced with single space
  it("case 4: embedded newline is replaced with single space", () => {
    const result = normalizeBehaviorForEmit("first line\nsecond line");
    expect(result).toBe("first line second line");
    expect(result).not.toContain("\n");
  });

  // Case 4a: Carriage return is also replaced
  it("case 4a: embedded carriage-return is replaced with single space", () => {
    const result = normalizeBehaviorForEmit("first\r\nsecond");
    expect(result).toBe("first second");
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\n");
  });

  // Case 5: Behavior with multiple internal spaces → collapsed to single spaces
  it("case 5: multiple internal spaces are collapsed to a single space", () => {
    const result = normalizeBehaviorForEmit("too   many    spaces   here");
    expect(result).toBe("too many spaces here");
  });

  // Case 5a: Leading/trailing whitespace is trimmed
  it("case 5a: leading and trailing whitespace is trimmed", () => {
    const result = normalizeBehaviorForEmit("  leading and trailing  ");
    expect(result).toBe("leading and trailing");
  });

  // Case 6: Behavior undefined → returns null
  it("case 6: undefined behavior returns null", () => {
    const result = normalizeBehaviorForEmit(undefined);
    expect(result).toBeNull();
  });

  // Case 7: Behavior empty string → returns null
  it("case 7: empty string behavior returns null", () => {
    const result = normalizeBehaviorForEmit("");
    expect(result).toBeNull();
  });

  // Case 8: Behavior whitespace-only → returns null
  it("case 8: whitespace-only behavior returns null", () => {
    expect(normalizeBehaviorForEmit("   ")).toBeNull();
    expect(normalizeBehaviorForEmit("\t\n  ")).toBeNull();
    expect(normalizeBehaviorForEmit("\r\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderContractComment with behavior — integration with normalizeBehaviorForEmit
// ---------------------------------------------------------------------------

describe("renderContractComment — behavior trailer (WI-610)", () => {
  it("appends behavior trailer when spec.behavior is set", () => {
    const spec = makeSpec({ behavior: "Parses integers from a string" });
    const comment = renderContractComment("parseInteger", "abc12345deadbeef", spec);
    // Must contain the behavior trailer after yakcc:<hash>
    expect(comment).toContain("— yakcc:abc12345");
    expect(comment).toContain("— Parses integers from a string");
    // Full expected format
    expect(comment).toBe(
      "// @atom parseInteger (string => number; rejects non-int) — yakcc:abc12345 — Parses integers from a string",
    );
  });

  it("omits behavior trailer when spec.behavior is undefined (no regression to base format)", () => {
    const spec = makeSpec({ behavior: undefined });
    const comment = renderContractComment("parseInteger", "abc12345deadbeef", spec);
    // Must NOT have a second em-dash beyond yakcc:<hash>
    expect(comment).toBe(
      "// @atom parseInteger (string => number; rejects non-int) — yakcc:abc12345",
    );
  });

  it("omits behavior trailer when spec.behavior is empty string", () => {
    const spec = makeSpec({ behavior: "" });
    const comment = renderContractComment("parseInteger", "abc12345deadbeef", spec);
    expect(comment).toBe(
      "// @atom parseInteger (string => number; rejects non-int) — yakcc:abc12345",
    );
  });

  it("truncates behavior when it exceeds 80 chars", () => {
    const longBehavior = "x".repeat(100); // 100 chars — must be truncated to 80
    const spec = makeSpec({ behavior: longBehavior });
    const comment = renderContractComment("fn", "deadbeef12345678", spec);
    // Trailer portion: " — <behavior>" where behavior is max 80 chars
    const expectedBehavior = `${"x".repeat(77)}...`;
    expect(comment).toContain(`— ${expectedBehavior}`);
    expect(expectedBehavior).toHaveLength(80);
  });

  it("normalizes embedded newlines in behavior before rendering", () => {
    const spec = makeSpec({ behavior: "line one\nline two" });
    const comment = renderContractComment("fn", "deadbeef12345678", spec);
    expect(comment).toContain("line one line two");
    expect(comment).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Case 9: End-to-end via renderSubstitution with spec carrying behavior
// ---------------------------------------------------------------------------

describe("case 9: renderSubstitution with spec.behavior — end-to-end production sequence", () => {
  it("three-line fragment includes behavior trailer in contract comment line", () => {
    const spec = makeSpec({
      name: "listOfInts",
      inputs: [{ name: "text", type: "string" }],
      outputs: [{ name: "result", type: "number[]" }],
      guarantees: [{ id: "G1", description: "rejects non-int" }],
      behavior: "Produces a list of integers from a delimited string",
    });

    const result = renderSubstitution(
      "abc12345deadbeef",
      "const result = listOfInts(input);",
      { name: "result", args: ["input"], atomName: "listOfInts" },
      spec,
    );

    const lines = result.split("\n");

    // Still exactly 3 lines (behavior trailer does NOT add a line)
    expect(lines).toHaveLength(3);

    // Line 0: contract comment with behavior trailer
    expect(lines[0]).toContain("// @atom listOfInts");
    expect(lines[0]).toContain("yakcc:abc12345");
    expect(lines[0]).toContain("— Produces a list of integers from a delimited string");

    // Line 1: import (unchanged from Phase 2)
    expect(lines[1]).toContain("import { listOfInts }");
    expect(lines[1]).toContain("@yakcc/atoms/listOfInts");

    // Line 2: binding (unchanged from Phase 2)
    expect(lines[2]).toContain("const result = listOfInts(input)");
  });

  it("three-line fragment is unchanged when spec has no behavior (backward compat)", () => {
    const spec = makeSpec({
      name: "listOfInts",
      inputs: [{ name: "text", type: "string" }],
      outputs: [{ name: "result", type: "number[]" }],
      guarantees: [{ id: "G1", description: "rejects non-int" }],
      behavior: undefined,
    });

    const result = renderSubstitution(
      "abc12345deadbeef",
      "const result = listOfInts(input);",
      { name: "result", args: ["input"], atomName: "listOfInts" },
      spec,
    );

    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    // Exact base format — no behavior trailer
    expect(lines[0]).toBe(
      "// @atom listOfInts (string => number[]; rejects non-int) — yakcc:abc12345",
    );
  });

  it("two-line fragment (Phase 2 no-spec path) is completely unchanged", () => {
    // No spec → no contract comment → no behavior trailer possible
    const result = renderSubstitution(
      "abc12345deadbeef",
      "const result = listOfInts(input);",
      { name: "result", args: ["input"], atomName: "listOfInts" },
      // no spec
    );

    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("import { listOfInts }");
    expect(lines[1]).toContain("const result = listOfInts(input)");
    // No contract comment at all
    expect(result).not.toContain("@atom");
    expect(result).not.toContain("yakcc:");
  });
});

// ---------------------------------------------------------------------------
// Case 10: Regex stability — yakcc:<hash> token boundary preserved
// ---------------------------------------------------------------------------

describe("case 10: regex stability — yakcc:<hash[:8]> token boundary preserved", () => {
  const YAKCC_HASH_REGEX = /yakcc:[0-9a-f]{8}/;

  it("regex matches contract comment WITHOUT behavior trailer (base format)", () => {
    const spec = makeSpec({ behavior: undefined });
    const comment = renderContractComment("parseInteger", "abc12345deadbeef", spec);
    expect(comment).toMatch(YAKCC_HASH_REGEX);
  });

  it("regex matches contract comment WITH behavior trailer (WI-610 extended format)", () => {
    const spec = makeSpec({ behavior: "Parses integers from a string" });
    const comment = renderContractComment("parseInteger", "abc12345deadbeef", spec);
    expect(comment).toMatch(YAKCC_HASH_REGEX);
  });

  it("yakcc:<hash> token boundary is preserved — hash is not modified by the trailer", () => {
    const spec = makeSpec({ behavior: "some behavior" });
    const comment = renderContractComment("fn", "cafebabe12345678", spec);

    // The hash substring must appear exactly as yakcc:cafebabe (no character after the 8th hex char
    // that would be part of the hash).
    expect(comment).toContain("yakcc:cafebabe");

    // The separator between hash and behavior is " — " (space+em-dash+space).
    // This keeps yakcc:<hash> as a clean token boundary.
    const hashPlusTrailer = comment.slice(comment.indexOf("yakcc:"));
    expect(hashPlusTrailer).toMatch(/^yakcc:[0-9a-f]{8} — /);
  });

  it("full hash (beyond 8 chars) does NOT appear in the comment — DEC-HOOK-PHASE-3-001", () => {
    const fullHash = "cafebabe12345678abcdef0011223344";
    const spec = makeSpec({ behavior: "some behavior" });
    const comment = renderContractComment("fn", fullHash, spec);

    // Only first 8 chars emitted
    expect(comment).toContain("yakcc:cafebabe");
    // The 16-char form must not appear
    expect(comment).not.toContain("yakcc:cafebabe12345678");
  });

  it("regex matches substituted output from renderSubstitution with behavior", () => {
    const spec = makeSpec({
      behavior: "Produces a sorted array",
      inputs: [{ name: "arr", type: "number[]" }],
      outputs: [{ name: "result", type: "number[]" }],
    });
    const result = renderSubstitution(
      "deadbeef12345678",
      "const sorted = sortArray(items);",
      { name: "sorted", args: ["items"], atomName: "sortArray" },
      spec,
    );
    // The first line of the substitution output must match the hash regex
    const contractLine = result.split("\n")[0] ?? "";
    expect(contractLine).toMatch(YAKCC_HASH_REGEX);
    // And it must also contain the behavior trailer
    expect(contractLine).toContain("— Produces a sorted array");
  });
});
