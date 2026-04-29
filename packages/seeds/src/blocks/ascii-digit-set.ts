// @decision DEC-SEEDS-ASCIIDIGITSET-001: constant membership test avoids char comparison chains.
// Status: implemented (WI-006)
// Rationale: A Boolean predicate over the digit set is used by multiple blocks that need
// to check-without-consume. Separating it makes the predicate independently testable.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "c", type: "string", description: "A single character." }],
  outputs: [
    {
      name: "result",
      type: "boolean",
      description: "True iff c is an ASCII digit '0'-'9'.",
    },
  ],
  behavior:
    "Return true if and only if the single character c is in the ASCII digit set '0'-'9'. Returns false for all other characters including empty string or multi-char strings.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "total", description: "Never throws; always returns a boolean." },
    {
      id: "consistent",
      description: "isAsciiDigit(c) === (c >= '0' && c <= '9' && c.length === 1).",
    },
  ],
  errorConditions: [],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "ascii-digit-set-zero", description: "isAsciiDigit('0') returns true" },
    { id: "ascii-digit-set-nine", description: "isAsciiDigit('9') returns true" },
    { id: "ascii-digit-set-letter", description: "isAsciiDigit('a') returns false" },
    { id: "ascii-digit-set-empty", description: "isAsciiDigit('') returns false" },
    { id: "ascii-digit-set-multi", description: "isAsciiDigit('12') returns false" },
  ],
};

export function isAsciiDigit(c: string): boolean {
  return c.length === 1 && c >= "0" && c <= "9";
}
