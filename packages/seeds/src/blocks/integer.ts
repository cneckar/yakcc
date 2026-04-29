// @decision DEC-SEEDS-INTEGER-001: integer composes digit; returns value + new position as a tuple.
// Status: implemented (WI-006)
// Rationale: Returning [value, newPosition] keeps the block pure while providing both the
// parsed value and the advanced cursor to the caller without a mutable context object.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based start position." },
  ],
  outputs: [
    {
      name: "result",
      type: "readonly [number, number]",
      description: "[parsedValue, newPosition] tuple.",
    },
  ],
  behavior:
    "Parse a sequence of one or more ASCII decimal digits starting at position. Returns [value, newPosition] where value is the decimal integer and newPosition is one past the last digit. Throws SyntaxError if no digit is found at position.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "greedy", description: "Consumes as many digits as possible from position." },
    { id: "non-negative", description: "Parsed value is always >= 0." },
  ],
  errorConditions: [
    {
      description: "No digit character found at position.",
      errorType: "SyntaxError",
    },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "integer-single", description: "integer('5', 0) returns [5, 1]" },
    { id: "integer-multi", description: "integer('123', 0) returns [123, 3]" },
    { id: "integer-mid", description: "integer('a42b', 1) returns [42, 3]" },
    { id: "integer-no-digit", description: "integer('abc', 0) throws SyntaxError" },
    { id: "integer-eof", description: "integer('', 0) throws SyntaxError" },
    { id: "integer-negative-pos", description: "integer('1', -1) throws RangeError" },
  ],
};

export function integer(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length || input[position] === undefined) {
    throw new SyntaxError(`Expected digit at position ${position} but reached end of input`);
  }
  const first = input[position] as string;
  if (first < "0" || first > "9") {
    throw new SyntaxError(
      `Expected digit at position ${position} but found ${JSON.stringify(first)}`,
    );
  }
  let value = 0;
  let pos = position;
  while (pos < input.length) {
    const c = input[pos] as string;
    if (c < "0" || c > "9") break;
    value = value * 10 + (c.charCodeAt(0) - 48);
    pos++;
  }
  return [value, pos] as const;
}
