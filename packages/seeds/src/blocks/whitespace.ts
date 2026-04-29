// @decision DEC-SEEDS-WHITESPACE-001: whitespace skipping returns a new position, not stripped text.
// Status: implemented (WI-006)
// Rationale: Position-returning parsers compose without allocating substrings.
// Returning the new position after whitespace is cheaper and composable with all other blocks.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based start position." },
  ],
  outputs: [
    {
      name: "newPosition",
      type: "number",
      description: "Position after skipping all leading spaces and tabs.",
    },
  ],
  behavior:
    "Skip zero or more space (U+0020) or tab (U+0009) characters starting at position. Return the first position that is not a space or tab. If no whitespace is present, returns position unchanged.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "monotonic", description: "Result is always >= position." },
    { id: "idempotent", description: "whitespace(whitespace(input, p)) === whitespace(input, p)." },
  ],
  errorConditions: [{ description: "position < 0.", errorType: "RangeError" }],
  nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "whitespace-spaces", description: "whitespace('   x', 0) returns 3" },
    { id: "whitespace-tab", description: "whitespace('\\tx', 0) returns 1" },
    { id: "whitespace-none", description: "whitespace('abc', 0) returns 0" },
    { id: "whitespace-mid", description: "whitespace('a   b', 1) returns 4" },
    { id: "whitespace-negative", description: "whitespace('abc', -1) throws RangeError" },
    { id: "whitespace-eof", description: "whitespace('abc', 3) returns 3" },
  ],
};

export function whitespace(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  let pos = position;
  while (pos < input.length) {
    const c = input[pos];
    if (c !== " " && c !== "\t") {
      break;
    }
    pos++;
  }
  return pos;
}
