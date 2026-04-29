// @decision DEC-SEEDS-ASCIICHAR-001: ascii-char is the positional consumption primitive.
// Status: implemented (WI-006)
// Rationale: Many parsing blocks need to consume a character at a known offset without
// interpretation. This block is the positional-read utility that others compose.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based index to read from." },
  ],
  outputs: [{ name: "char", type: "string", description: "Single character at position." }],
  behavior:
    "Return the single ASCII character at the given zero-based position in the input string. Throws RangeError if position is out of bounds or the character code is above 127.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "length-1", description: "Returned string always has length 1." },
    { id: "ascii", description: "Returned character has char code <= 127." },
  ],
  errorConditions: [
    { description: "position < 0 or position >= input.length.", errorType: "RangeError" },
    { description: "Character at position has code > 127.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "ascii-char-first", description: "asciiChar('abc', 0) returns 'a'" },
    { id: "ascii-char-middle", description: "asciiChar('abc', 1) returns 'b'" },
    { id: "ascii-char-oob", description: "asciiChar('abc', 3) throws RangeError" },
    { id: "ascii-char-negative", description: "asciiChar('abc', -1) throws RangeError" },
    { id: "ascii-char-non-ascii", description: "asciiChar('aéb', 1) throws RangeError" },
  ],
};

export function asciiChar(input: string, position: number): string {
  if (position < 0 || position >= input.length) {
    throw new RangeError(`Position ${position} out of bounds for input of length ${input.length}`);
  }
  const code = input.charCodeAt(position);
  if (code > 127) {
    throw new RangeError(`Non-ASCII character at position ${position}: code ${code}`);
  }
  return input[position] as string;
}
