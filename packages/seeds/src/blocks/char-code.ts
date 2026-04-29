// @decision DEC-SEEDS-CHARCODE-001: char-code exposes char-code lookup as an explicit contract.
// Status: implemented (WI-006)
// Rationale: Multiple blocks rely on charCodeAt arithmetic. Making it an explicit block
// documents the zero-extension property (always non-negative) and enables registry reuse.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based index to read from." },
  ],
  outputs: [
    {
      name: "code",
      type: "number",
      description: "UTF-16 char code at position, in [0, 65535].",
    },
  ],
  behavior:
    "Return the UTF-16 char code of the character at the given position in the input string. Throws RangeError if position is negative or out of bounds.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "non-negative", description: "Result is always >= 0." },
    { id: "bounded", description: "Result is in [0, 65535]." },
  ],
  errorConditions: [
    { description: "position < 0.", errorType: "RangeError" },
    { description: "position >= input.length.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "char-code-zero", description: "charCode('0abc', 0) returns 48" },
    { id: "char-code-a", description: "charCode('abc', 0) returns 97" },
    { id: "char-code-oob", description: "charCode('abc', 3) throws RangeError" },
    { id: "char-code-negative", description: "charCode('abc', -1) throws RangeError" },
    { id: "char-code-bracket", description: "charCode('[', 0) returns 91" },
  ],
};

export function charCode(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new RangeError(`Position ${position} out of bounds for input of length ${input.length}`);
  }
  return input.charCodeAt(position);
}
