// @decision DEC-SEEDS-PEEKCHAR-001: peek-without-advance is a fundamental parser combinator primitive.
// Status: implemented (WI-006)
// Rationale: Many parsing decisions are made by inspecting the next character without consuming it.
// Separating peek from consume avoids coupling lookahead to position advancement.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based position to peek at." },
  ],
  outputs: [
    {
      name: "char",
      type: "string | null",
      description: "Character at position, or null if at end of input.",
    },
  ],
  behavior:
    "Return the character at the given position without advancing. Returns null if position is at or beyond the end of input. Throws RangeError if position is negative.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "no-advance", description: "Does not modify position; caller position is unchanged." },
    { id: "null-at-eof", description: "Returns null exactly when position >= input.length." },
  ],
  errorConditions: [{ description: "position < 0.", errorType: "RangeError" }],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "peek-char-first", description: "peekChar('abc', 0) returns 'a'" },
    { id: "peek-char-eof", description: "peekChar('abc', 3) returns null" },
    { id: "peek-char-negative", description: "peekChar('abc', -1) throws RangeError" },
    { id: "peek-char-empty-input", description: "peekChar('', 0) returns null" },
    { id: "peek-char-last", description: "peekChar('abc', 2) returns 'c'" },
  ],
};

export function peekChar(input: string, position: number): string | null {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    return null;
  }
  return input[position] as string;
}
