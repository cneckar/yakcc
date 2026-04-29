// @decision DEC-SEEDS-EMPTYLIST-001: empty-list-content recognizes the ']' that closes an empty list.
// Status: implemented (WI-006)
// Rationale: Splitting empty vs nonempty list content into two blocks keeps each block's
// contract minimal. list-of-ints dispatches based on the first character after '['.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Position immediately after '['." },
  ],
  outputs: [
    {
      name: "newPosition",
      type: "number",
      description: "Position after the closing ']'.",
    },
  ],
  behavior:
    "Assert that the character at position is ']', indicating an empty list. Returns position + 1. Throws SyntaxError if anything other than ']' is found.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "advance-1", description: "Returns position + 1 on success." },
  ],
  errorConditions: [
    {
      description: "Character at position is not ']'.",
      errorType: "SyntaxError",
    },
    { description: "position >= input.length.", errorType: "SyntaxError" },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "empty-list-ok", description: "emptyListContent(']', 0) returns 1" },
    { id: "empty-list-mid", description: "emptyListContent('[]', 1) returns 2" },
    { id: "empty-list-nonempty", description: "emptyListContent('[1]', 1) throws SyntaxError" },
    { id: "empty-list-eof", description: "emptyListContent('', 0) throws SyntaxError" },
    { id: "empty-list-negative", description: "emptyListContent(']', -1) throws RangeError" },
  ],
};

export function emptyListContent(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected ']' at position ${position} but reached end of input`);
  }
  if (input[position] !== "]") {
    throw new SyntaxError(
      `Expected ']' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
