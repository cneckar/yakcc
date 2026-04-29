// @decision DEC-SEEDS-BRACKET-001: bracket matches a single bracket char and returns next position.
// Status: implemented (WI-006)
// Rationale: Bracket matching is a hot path in list parsing. Returning the post-bracket position
// follows the positional combinator convention used by all other blocks in this corpus.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based position to match at." },
    { name: "kind", type: "'[' | ']'", description: "Which bracket to expect." },
  ],
  outputs: [
    {
      name: "newPosition",
      type: "number",
      description: "position + 1 after matching the bracket.",
    },
  ],
  behavior:
    "Assert that the character at position equals kind ('[' or ']'), then return position + 1. Throws SyntaxError if the character does not match or if position is out of bounds.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "advance-1", description: "Returns position + 1 on success." },
  ],
  errorConditions: [
    { description: "Character at position does not equal kind.", errorType: "SyntaxError" },
    { description: "position >= input.length (end of input).", errorType: "SyntaxError" },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "bracket-open", description: "bracket('[abc', 0, '[') returns 1" },
    { id: "bracket-close", description: "bracket(']', 0, ']') returns 1" },
    { id: "bracket-mismatch", description: "bracket('[', 0, ']') throws SyntaxError" },
    { id: "bracket-oob", description: "bracket('', 0, '[') throws SyntaxError" },
    { id: "bracket-negative", description: "bracket('[', -1, '[') throws RangeError" },
  ],
};

export function bracket(input: string, position: number, kind: "[" | "]"): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected '${kind}' at position ${position} but reached end of input`);
  }
  if (input[position] !== kind) {
    throw new SyntaxError(
      `Expected '${kind}' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
