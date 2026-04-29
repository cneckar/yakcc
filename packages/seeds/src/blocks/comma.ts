// @decision DEC-SEEDS-COMMA-001: comma follows the same positional combinator convention as bracket.
// Status: implemented (WI-006)
// Rationale: Consistent positional-return API across all terminal matchers means they
// can be composed without wrapping. Returns next position rather than a boolean.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based position to match at." },
  ],
  outputs: [
    {
      name: "newPosition",
      type: "number",
      description: "position + 1 after matching the comma.",
    },
  ],
  behavior:
    "Assert that the character at position is ',' (U+002C), then return position + 1. Throws SyntaxError if the character does not match or position is at end of input.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "advance-1", description: "Returns position + 1 on success." },
  ],
  errorConditions: [
    { description: "Character at position is not ','.", errorType: "SyntaxError" },
    { description: "position >= input.length (end of input).", errorType: "SyntaxError" },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "comma-match", description: "comma(',abc', 0) returns 1" },
    { id: "comma-mid", description: "comma('a,b', 1) returns 2" },
    { id: "comma-mismatch", description: "comma('abc', 0) throws SyntaxError" },
    { id: "comma-eof", description: "comma('', 0) throws SyntaxError" },
    { id: "comma-negative", description: "comma(',', -1) throws RangeError" },
  ],
};

export function comma(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected ',' at position ${position} but reached end of input`);
  }
  if (input[position] !== ",") {
    throw new SyntaxError(
      `Expected ',' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
