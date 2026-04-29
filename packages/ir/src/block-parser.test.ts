// Tests for parseBlock from block-parser.ts.
//
// Structure:
//   - Valid canonical block: parses with validation.ok === true
//   - Invalid block (any annotation): validation.ok === false, no-any error present
//   - Composition detection: import from @yakcc/seeds/* surfaces in composition
//   - Content-address derivation: block.contract === contractId(block.contractSpec)
//   - Integration: full production sequence through validation + annotation + composition

import { contractId } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { parseBlock } from "./block-parser.js";

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

// A canonical valid block: CONTRACT literal + strict-TS-subset implementation.
const DIGIT_OF_SOURCE = `
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number" }],
  behavior: "Parse a single ASCII digit character '0'-'9' to its integer value.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [
    { description: "Input is not a single digit character.", errorType: "RangeError" }
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "zero", description: "digitOf('0') === 0" },
    { id: "nine", description: "digitOf('9') === 9" },
  ],
};

export function digitOf(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(\`Not a digit: \${s}\`);
  }
  return s.charCodeAt(0) - "0".charCodeAt(0);
}
`;

// A block that violates no-any.
const ANY_BLOCK_SOURCE = `
export function bad(x: any): number {
  return (x as any).value;
}
`;

// A block that imports a sub-block from @yakcc/seeds/blocks/whitespace.
// Uses `import type` so no-untyped-imports does not fire, while still
// producing a composition reference detectable by the import-path heuristic.
const COMPOSITION_SOURCE = `
import type { ContractSpec } from "@yakcc/contracts";
import type { IsWhitespaceFn } from "@yakcc/seeds/blocks/whitespace";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "boolean" }],
  behavior: "Return true if s consists entirely of whitespace characters.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

export function isAllWhitespace(s: string, isWhitespace: IsWhitespaceFn): boolean {
  return s.split("").every(isWhitespace);
}
`;

// ---------------------------------------------------------------------------
// Valid canonical block
// ---------------------------------------------------------------------------

describe("parseBlock: valid canonical block", () => {
  it("returns validation.ok === true for a clean strict-subset block", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.validation.ok).toBe(true);
  });

  it("returns the original source unchanged", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.source).toBe(DIGIT_OF_SOURCE);
  });

  it("populates contractSpec from the CONTRACT export", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.contractSpec).not.toBeNull();
    expect(block.contractSpec?.behavior).toBe(
      "Parse a single ASCII digit character '0'-'9' to its integer value.",
    );
  });

  it("populates contract (ContractId) from the extracted spec", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.contract).not.toBeNull();
    expect(typeof block.contract).toBe("string");
    expect(block.contract).toHaveLength(64);
    expect(block.contract).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an empty composition array when there are no block imports", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.composition).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Block with `any` annotation
// ---------------------------------------------------------------------------

describe("parseBlock: block with `any` annotation", () => {
  it("returns validation.ok === false", () => {
    const block = parseBlock(ANY_BLOCK_SOURCE);
    expect(block.validation.ok).toBe(false);
  });

  it("reports at least one error with rule === 'no-any'", () => {
    const block = parseBlock(ANY_BLOCK_SOURCE);
    if (block.validation.ok) throw new Error("expected validation failure");
    const anyErrors = block.validation.errors.filter((e) => e.rule === "no-any");
    expect(anyErrors.length).toBeGreaterThan(0);
  });

  it("still returns source and composition even when validation fails", () => {
    const block = parseBlock(ANY_BLOCK_SOURCE);
    expect(block.source).toBe(ANY_BLOCK_SOURCE);
    expect(Array.isArray(block.composition)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composition detection
// ---------------------------------------------------------------------------

describe("parseBlock: composition references from @yakcc/seeds/* imports", () => {
  it("detects a named import from @yakcc/seeds/blocks/whitespace", () => {
    const block = parseBlock(COMPOSITION_SOURCE);
    expect(block.composition.length).toBeGreaterThan(0);
  });

  it("sets localName to the bound identifier name", () => {
    const block = parseBlock(COMPOSITION_SOURCE);
    const ref = block.composition.find((r) => r.localName === "IsWhitespaceFn");
    expect(ref).toBeDefined();
  });

  it("sets importedFrom to the full module specifier", () => {
    const block = parseBlock(COMPOSITION_SOURCE);
    const ref = block.composition.find((r) => r.localName === "IsWhitespaceFn");
    expect(ref?.importedFrom).toBe("@yakcc/seeds/blocks/whitespace");
  });

  it("does not include non-block imports (e.g. @yakcc/contracts) in composition", () => {
    const block = parseBlock(COMPOSITION_SOURCE);
    const contractsRef = block.composition.find((r) =>
      r.importedFrom.startsWith("@yakcc/contracts"),
    );
    expect(contractsRef).toBeUndefined();
  });

  it("respects custom blockPatterns option", () => {
    const source = `
import { helper } from "@my-org/blocks/util";
export function f(): void {}
`;
    const block = parseBlock(source, { blockPatterns: ["@my-org/blocks/"] });
    const ref = block.composition.find((r) => r.localName === "helper");
    expect(ref).toBeDefined();
    expect(ref?.importedFrom).toBe("@my-org/blocks/util");
  });
});

// ---------------------------------------------------------------------------
// Content-address derivation
// ---------------------------------------------------------------------------

describe("parseBlock: content-address derivation", () => {
  it("block.contract === contractId(block.contractSpec) when spec is present", () => {
    const block = parseBlock(DIGIT_OF_SOURCE);
    expect(block.contractSpec).not.toBeNull();
    if (block.contractSpec === null) throw new Error("contractSpec is null");

    const expected = contractId(block.contractSpec);
    expect(block.contract).toBe(expected);
  });

  it("block.contract is null when no CONTRACT export is present", () => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const block = parseBlock(source);
    expect(block.contract).toBeNull();
    expect(block.contractSpec).toBeNull();
  });

  it("same source always produces the same contract id (deterministic)", () => {
    const b1 = parseBlock(DIGIT_OF_SOURCE);
    const b2 = parseBlock(DIGIT_OF_SOURCE);
    expect(b1.contract).toBe(b2.contract);
  });

  it("different behavior strings produce different contract ids", () => {
    const sourceA = `
export const CONTRACT = {
  inputs: [],
  outputs: [],
  behavior: "behavior-A",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
`;
    const sourceB = `
export const CONTRACT = {
  inputs: [],
  outputs: [],
  behavior: "behavior-B",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
`;
    const bA = parseBlock(sourceA);
    const bB = parseBlock(sourceB);
    expect(bA.contract).not.toBeNull();
    expect(bB.contract).not.toBeNull();
    expect(bA.contract).not.toBe(bB.contract);
  });
});

// ---------------------------------------------------------------------------
// Integration: full production sequence
//
// Exercises the real production pipeline:
//   source string → in-memory ts-morph parse → all strict-subset rules →
//   CONTRACT annotation extraction → contractId derivation → composition scan
//
// This is the compound-interaction test that crosses validator, annotation
// extractor, and composition extractor boundaries in a single call path.
// ---------------------------------------------------------------------------

describe("integration: full production sequence through parseBlock", () => {
  it("a valid strict-TS block with CONTRACT and a seed import produces a complete Block", () => {
    const block = parseBlock(COMPOSITION_SOURCE);

    // Validation passed
    expect(block.validation.ok).toBe(true);

    // CONTRACT was extracted
    expect(block.contractSpec).not.toBeNull();
    expect(block.contractSpec?.behavior).toBe(
      "Return true if s consists entirely of whitespace characters.",
    );

    // Content-address is a valid 64-char hex string and matches contractId(spec)
    expect(block.contract).toHaveLength(64);
    expect(block.contract).toMatch(/^[0-9a-f]{64}$/);
    if (block.contractSpec === null) throw new Error("contractSpec unexpectedly null");
    expect(block.contract).toBe(contractId(block.contractSpec));

    // Composition has one entry pointing at the seed
    expect(block.composition).toHaveLength(1);
    expect(block.composition[0]?.localName).toBe("IsWhitespaceFn");
    expect(block.composition[0]?.importedFrom).toBe("@yakcc/seeds/blocks/whitespace");
  });

  it("a block failing strict-subset still returns its CONTRACT and composition (non-throwing)", () => {
    // Block has `any` (fails strict-subset) but also has a valid CONTRACT.
    const source = `
export const CONTRACT = {
  inputs: [],
  outputs: [],
  behavior: "broken block for test",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
export function bad(x: any): void { void x; }
`;
    const block = parseBlock(source);
    expect(block.validation.ok).toBe(false);
    // ContractSpec is still extracted despite the validation failure
    expect(block.contractSpec).not.toBeNull();
    expect(block.contractSpec?.behavior).toBe("broken block for test");
    // contractId is still derived
    expect(block.contract).not.toBeNull();
  });

  it("parseBlock is non-throwing for ContractExtractionError (malformed CONTRACT treated as null)", () => {
    const source = `
declare function buildSpec(): unknown;
export const CONTRACT = buildSpec();
export function f(): void {}
`;
    // CONTRACT is a call expression — extractContractFromAst would throw
    // ContractExtractionError, but parseBlock catches it and returns null.
    const block = parseBlock(source);
    expect(block.contractSpec).toBeNull();
    expect(block.contract).toBeNull();
    // Source is preserved
    expect(block.source).toBe(source);
  });
});
