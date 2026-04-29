// Tests for extractContract from annotations.ts.
//
// Structure:
//   - Happy path: valid CONTRACT literal is extracted and deep-equals source
//   - Absent CONTRACT: returns null
//   - Non-literal CONTRACT: throws ContractExtractionError with kind CONTRACT-not-literal
//   - Malformed shape: throws ContractExtractionError with kind CONTRACT-shape-invalid
//   - Round-trip: extracted spec produces same content-address as an equivalent
//     freshly-authored spec (proves extraction preserves canonical content)
//   - Integration: extractContract → contractId covers the full extraction pipeline

import { contractId } from "@yakcc/contracts";
import type { ContractSpec } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { ContractExtractionError, EXTRACTION_ERROR_KIND, extractContract } from "./annotations.js";

// ---------------------------------------------------------------------------
// Shared fixture: a minimal valid ContractSpec literal as source text.
// Also used as the reference spec object for round-trip tests.
// ---------------------------------------------------------------------------

const VALID_CONTRACT_SOURCE = `
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number" }],
  behavior: "Parse a single ASCII digit '0'-'9' to its integer value.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [
    { description: "Input is not a single digit.", errorType: "RangeError" }
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

const REFERENCE_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number" }],
  behavior: "Parse a single ASCII digit '0'-'9' to its integer value.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [{ description: "Input is not a single digit.", errorType: "RangeError" }],
  nonFunctional: {
    time: "O(1)",
    space: "O(1)",
    purity: "pure",
    threadSafety: "safe",
  },
  propertyTests: [
    { id: "zero", description: "digitOf('0') === 0" },
    { id: "nine", description: "digitOf('9') === 9" },
  ],
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("extractContract: valid CONTRACT literal", () => {
  it("returns a ContractSpec that deep-equals the reference spec", () => {
    const spec = extractContract(VALID_CONTRACT_SOURCE);
    expect(spec).not.toBeNull();
    expect(spec).toEqual(REFERENCE_SPEC);
  });

  it("extracts inputs array with correct names and types", () => {
    const spec = extractContract(VALID_CONTRACT_SOURCE);
    expect(spec?.inputs).toEqual([{ name: "s", type: "string" }]);
  });

  it("extracts behavior string verbatim", () => {
    const spec = extractContract(VALID_CONTRACT_SOURCE);
    expect(spec?.behavior).toBe("Parse a single ASCII digit '0'-'9' to its integer value.");
  });

  it("extracts nested nonFunctional object", () => {
    const spec = extractContract(VALID_CONTRACT_SOURCE);
    expect(spec?.nonFunctional).toEqual({
      time: "O(1)",
      space: "O(1)",
      purity: "pure",
      threadSafety: "safe",
    });
  });
});

// ---------------------------------------------------------------------------
// Absent CONTRACT
// ---------------------------------------------------------------------------

describe("extractContract: missing CONTRACT export", () => {
  it("returns null for a block with no CONTRACT export", () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const result = extractContract(source);
    expect(result).toBeNull();
  });

  it("returns null for a block with a non-exported CONTRACT variable", () => {
    const source = `
import type { ContractSpec } from "@yakcc/contracts";
// NOT exported — should not be picked up
const CONTRACT: ContractSpec = {
  inputs: [],
  outputs: [],
  behavior: "noop",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
export function noop(): void {}
`;
    const result = extractContract(source);
    expect(result).toBeNull();
  });

  it("returns null for an empty source file", () => {
    expect(extractContract("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-literal CONTRACT initializer
// ---------------------------------------------------------------------------

describe("extractContract: CONTRACT not a literal", () => {
  it("throws ContractExtractionError with kind CONTRACT-not-literal when CONTRACT is a call expression", () => {
    const source = `
import type { ContractSpec } from "@yakcc/contracts";
declare function buildContract(): ContractSpec;
export const CONTRACT = buildContract();
`;
    expect(() => extractContract(source)).toThrow(ContractExtractionError);

    let thrown: ContractExtractionError | undefined;
    try {
      extractContract(source);
    } catch (e) {
      thrown = e as ContractExtractionError;
    }
    expect(thrown).toBeInstanceOf(ContractExtractionError);
    expect(thrown?.kind).toBe(EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL);
  });

  it("throws ContractExtractionError with kind CONTRACT-not-literal when CONTRACT is an identifier reference", () => {
    const source = `
import type { ContractSpec } from "@yakcc/contracts";
const spec: ContractSpec = {
  inputs: [],
  outputs: [],
  behavior: "x",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
export const CONTRACT = spec;
`;
    let thrown: ContractExtractionError | undefined;
    try {
      extractContract(source);
    } catch (e) {
      thrown = e as ContractExtractionError;
    }
    expect(thrown).toBeInstanceOf(ContractExtractionError);
    expect(thrown?.kind).toBe(EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL);
  });
});

// ---------------------------------------------------------------------------
// Malformed shape
// ---------------------------------------------------------------------------

describe("extractContract: CONTRACT shape invalid", () => {
  it("throws ContractExtractionError with kind CONTRACT-shape-invalid when required field 'inputs' is missing", () => {
    const source = `
import type { ContractSpec } from "@yakcc/contracts";
export const CONTRACT: ContractSpec = {
  outputs: [{ name: "x", type: "number" }],
  behavior: "does something",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
} as unknown as ContractSpec;
`;
    // The ContractExtractionError path is hit when CONTRACT is a literal but
    // cast via `as unknown as ContractSpec` — the cast makes it non-literal.
    // Test with a genuine shape-invalid literal instead.
    const source2 = `
export const CONTRACT = {
  outputs: [{ name: "x", type: "number" }],
  behavior: "does something",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
`;
    let thrown: ContractExtractionError | undefined;
    try {
      extractContract(source2);
    } catch (e) {
      thrown = e as ContractExtractionError;
    }
    expect(thrown).toBeInstanceOf(ContractExtractionError);
    expect(thrown?.kind).toBe(EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID);
    expect(thrown?.message).toMatch(/inputs/);
  });

  it("throws ContractExtractionError with kind CONTRACT-shape-invalid when 'behavior' is not a string", () => {
    const source = `
export const CONTRACT = {
  inputs: [],
  outputs: [],
  behavior: 42,
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
`;
    let thrown: ContractExtractionError | undefined;
    try {
      extractContract(source);
    } catch (e) {
      thrown = e as ContractExtractionError;
    }
    expect(thrown).toBeInstanceOf(ContractExtractionError);
    expect(thrown?.kind).toBe(EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID);
    expect(thrown?.message).toMatch(/behavior/);
  });

  it("throws ContractExtractionError with kind CONTRACT-not-literal when CONTRACT is a string literal (not an ObjectLiteralExpression)", () => {
    // A string literal initializer is rejected at the object-literal gate
    // in extractContractFromAst before evalLiteralNode is reached, so the
    // thrown kind is CONTRACT-not-literal, not CONTRACT-shape-invalid.
    const source = `export const CONTRACT = "not-an-object";`;
    let thrown: ContractExtractionError | undefined;
    try {
      extractContract(source);
    } catch (e) {
      thrown = e as ContractExtractionError;
    }
    expect(thrown).toBeInstanceOf(ContractExtractionError);
    expect(thrown?.kind).toBe(EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: content-address stability
//
// Extract spec from source, call contractId(spec), and compare to
// contractId computed directly from an equivalent freshly-authored spec.
// If extraction preserves canonical content, the ids are identical.
// ---------------------------------------------------------------------------

describe("round-trip: extraction preserves canonical content-address", () => {
  it("contractId(extractContract(source)) === contractId(referenceSpec)", () => {
    const extracted = extractContract(VALID_CONTRACT_SOURCE);
    expect(extracted).not.toBeNull();
    if (extracted === null) throw new Error("extracted is null");

    const idFromExtracted = contractId(extracted);
    const idFromReference = contractId(REFERENCE_SPEC);

    expect(typeof idFromExtracted).toBe("string");
    expect(idFromExtracted).toHaveLength(64);
    expect(idFromExtracted).toMatch(/^[0-9a-f]{64}$/);
    expect(idFromExtracted).toBe(idFromReference);
  });

  it("two sources with identical CONTRACT bodies produce the same content-address", () => {
    // Minimal block source A
    const sourceA = `
export const CONTRACT = {
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "result", type: "string" }],
  behavior: "Convert a number to its decimal string representation.",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
`;
    // Same CONTRACT body, different implementation function
    const sourceB = `
export const CONTRACT = {
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "result", type: "string" }],
  behavior: "Convert a number to its decimal string representation.",
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};
export function numToStr(n: number): string { return String(n); }
`;
    const specA = extractContract(sourceA);
    const specB = extractContract(sourceB);
    expect(specA).not.toBeNull();
    expect(specB).not.toBeNull();
    if (!specA || !specB) throw new Error("extraction returned null");

    expect(contractId(specA)).toBe(contractId(specB));
  });
});

// ---------------------------------------------------------------------------
// Integration: full extraction pipeline — source → extract → contractId
// ---------------------------------------------------------------------------

describe("integration: extractContract → contractId pipeline", () => {
  it("produces a 64-char hex ContractId from a valid block source", () => {
    const id = contractId(extractContract(VALID_CONTRACT_SOURCE) as ContractSpec);
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same source always produces the same ContractId (determinism)", () => {
    const id1 = contractId(extractContract(VALID_CONTRACT_SOURCE) as ContractSpec);
    const id2 = contractId(extractContract(VALID_CONTRACT_SOURCE) as ContractSpec);
    expect(id1).toBe(id2);
  });
});
