/**
 * CWE_474_FAMILY coverage tests.
 *
 * Each of the 5 entries must have at least one detect-true and one detect-false
 * case. Tests are exhaustive over the 5 CWE entries.
 */

import type { SpecYak } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { CWE_474_FAMILY, mapCweFamily } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minSpec(overrides: Partial<SpecYak> = {}): SpecYak {
  return {
    name: "test",
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CWE_474_FAMILY length
// ---------------------------------------------------------------------------

describe("CWE_474_FAMILY", () => {
  it("contains exactly 5 entries", () => {
    expect(CWE_474_FAMILY).toHaveLength(5);
  });

  it("contains the expected CWE IDs", () => {
    const ids = CWE_474_FAMILY.map((p) => p.cwe);
    expect(ids).toContain("CWE-474");
    expect(ids).toContain("CWE-440");
    expect(ids).toContain("CWE-573");
    expect(ids).toContain("CWE-684");
    expect(ids).toContain("CWE-710");
  });

  it("all entries have a non-empty title", () => {
    for (const pattern of CWE_474_FAMILY) {
      expect(pattern.title.length, `${pattern.cwe} title is empty`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CWE-474: Use of Function with Inconsistent Implementations
// Detected when: no effects declared AND purity is not "pure"
// ---------------------------------------------------------------------------

describe("CWE-474 detect", () => {
  const pattern = CWE_474_FAMILY.find((p) => p.cwe === "CWE-474");
  if (pattern === undefined) throw new Error("CWE-474 not found in CWE_474_FAMILY");

  it("PRESENT when no effects and purity is 'io' (inconsistency risk)", () => {
    const spec = minSpec({
      effects: [],
      nonFunctional: { purity: "io", threadSafety: "safe" },
    });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("PRESENT when no effects and nonFunctional is absent (purity unknown)", () => {
    const spec = minSpec({ effects: [] });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("CLEAR when effects are declared (explicit capability → consistent)", () => {
    const spec = minSpec({
      effects: ["WriteOnly:/tmp/x"],
      nonFunctional: { purity: "io", threadSafety: "safe" },
    });
    expect(pattern.detect(spec)).toBe(false);
  });

  it("CLEAR when purity is 'pure' and effects are empty (genuinely pure)", () => {
    const spec = minSpec({
      effects: [],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });
    expect(pattern.detect(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CWE-440: Expected Behavior Violation
// Detected when: postconditions array is empty
// ---------------------------------------------------------------------------

describe("CWE-440 detect", () => {
  const pattern = CWE_474_FAMILY.find((p) => p.cwe === "CWE-440");
  if (pattern === undefined) throw new Error("CWE-440 not found in CWE_474_FAMILY");

  it("PRESENT when postconditions are empty", () => {
    const spec = minSpec({ postconditions: [] });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("CLEAR when at least one postcondition is declared", () => {
    const spec = minSpec({ postconditions: ["result is finite"] });
    expect(pattern.detect(spec)).toBe(false);
  });

  it("CLEAR when multiple postconditions are declared", () => {
    const spec = minSpec({ postconditions: ["result >= 0", "result is a number"] });
    expect(pattern.detect(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CWE-573: Improper Following of Specification by Caller
// Detected when: preconditions array is empty
// ---------------------------------------------------------------------------

describe("CWE-573 detect", () => {
  const pattern = CWE_474_FAMILY.find((p) => p.cwe === "CWE-573");
  if (pattern === undefined) throw new Error("CWE-573 not found in CWE_474_FAMILY");

  it("PRESENT when preconditions are empty (caller has no constraints to follow)", () => {
    const spec = minSpec({ preconditions: [] });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("CLEAR when at least one precondition is declared", () => {
    const spec = minSpec({ preconditions: ["input is non-negative"] });
    expect(pattern.detect(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CWE-684: Incorrect Provision of Specified Functionality
// Detected when: preconditions exist AND no errorConditions declared
// ---------------------------------------------------------------------------

describe("CWE-684 detect", () => {
  const pattern = CWE_474_FAMILY.find((p) => p.cwe === "CWE-684");
  if (pattern === undefined) throw new Error("CWE-684 not found in CWE_474_FAMILY");

  it("PRESENT when preconditions exist but errorConditions are absent", () => {
    const spec = minSpec({
      preconditions: ["x > 0"],
      errorConditions: undefined,
    });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("PRESENT when preconditions exist and errorConditions is empty array", () => {
    const spec = minSpec({
      preconditions: ["x > 0"],
      errorConditions: [],
    });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("CLEAR when preconditions exist and errorConditions are declared", () => {
    const spec = minSpec({
      preconditions: ["x > 0"],
      errorConditions: [{ description: "throws RangeError for x <= 0", errorType: "RangeError" }],
    });
    expect(pattern.detect(spec)).toBe(false);
  });

  it("CLEAR when preconditions are empty (no constraints to violate)", () => {
    const spec = minSpec({
      preconditions: [],
      errorConditions: undefined,
    });
    expect(pattern.detect(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CWE-710: Improper Adherence to Coding Standards
// Detected when: nonFunctional is undefined
// ---------------------------------------------------------------------------

describe("CWE-710 detect", () => {
  const pattern = CWE_474_FAMILY.find((p) => p.cwe === "CWE-710");
  if (pattern === undefined) throw new Error("CWE-710 not found in CWE_474_FAMILY");

  it("PRESENT when nonFunctional is absent", () => {
    const spec = minSpec({ nonFunctional: undefined });
    expect(pattern.detect(spec)).toBe(true);
  });

  it("CLEAR when nonFunctional is declared", () => {
    const spec = minSpec({
      nonFunctional: { purity: "pure", threadSafety: "safe" },
    });
    expect(pattern.detect(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapCweFamily — integrates CWE_474_FAMILY detection
// ---------------------------------------------------------------------------

describe("mapCweFamily", () => {
  it("cwesPresent + cwesClear covers all 5 CWEs", () => {
    const spec = minSpec({
      postconditions: ["result is valid"],
      preconditions: ["input is non-null"],
      errorConditions: [{ description: "throws on null" }],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      effects: [],
    });
    const mapping = mapCweFamily(spec);
    const all = [...mapping.cwesPresent, ...mapping.cwesClear].sort();
    const expected = CWE_474_FAMILY.map((p) => p.cwe).sort();
    expect(all).toEqual(expected);
  });

  it("a fully declared spec clears all 5 CWEs", () => {
    const spec: SpecYak = {
      name: "well-specified",
      inputs: [{ name: "x", type: "number" }],
      outputs: [{ name: "y", type: "number" }],
      preconditions: ["x > 0"],
      postconditions: ["y === x * 2"],
      invariants: [],
      effects: [],
      level: "L0",
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      errorConditions: [{ description: "throws RangeError for x <= 0", errorType: "RangeError" }],
    };
    const mapping = mapCweFamily(spec);
    // CWE-474: pure + empty effects → CLEAR
    // CWE-440: postconditions non-empty → CLEAR
    // CWE-573: preconditions non-empty → CLEAR
    // CWE-684: preconditions + errorConditions → CLEAR
    // CWE-710: nonFunctional declared → CLEAR
    expect(mapping.cwesPresent).toHaveLength(0);
    expect(mapping.cwesClear).toHaveLength(5);
  });

  it("a minimal spec (no optional fields) has known CWE profile", () => {
    const spec = minSpec();
    const mapping = mapCweFamily(spec);
    // CWE-474: no effects + nonFunctional absent → PRESENT
    // CWE-440: postconditions empty → PRESENT
    // CWE-573: preconditions empty → PRESENT
    // CWE-684: preconditions empty → CLEAR (no preconditions to violate)
    // CWE-710: nonFunctional absent → PRESENT
    expect(mapping.cwesPresent).toContain("CWE-474");
    expect(mapping.cwesPresent).toContain("CWE-440");
    expect(mapping.cwesPresent).toContain("CWE-573");
    expect(mapping.cwesClear).toContain("CWE-684");
    expect(mapping.cwesPresent).toContain("CWE-710");
  });
});
