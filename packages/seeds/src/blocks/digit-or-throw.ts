// @decision DEC-SEEDS-DIGITORTHROW-001: digit-or-throw wraps positional digit reading with context.
// Status: implemented (WI-006)
// Rationale: Callers that have already peeked and confirmed a digit want a single call that
// reads-and-advances with a descriptive error. This combinator adds the position context
// that the raw digit() function lacks.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based position to read from." },
  ],
  outputs: [
    {
      name: "result",
      type: "readonly [number, number]",
      description: "[digitValue, newPosition] where newPosition = position + 1.",
    },
  ],
  behavior:
    "Read the character at position, parse it as a decimal digit 0-9, and return [value, position + 1]. Throws SyntaxError with position context if the character is not a digit or position is out of bounds.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "advance-1", description: "newPosition is always position + 1 on success." },
    { id: "range", description: "digitValue is in [0, 9] on success." },
  ],
  errorConditions: [
    {
      description: "position >= input.length or character is not a digit.",
      errorType: "SyntaxError",
    },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "digitorthrow-zero", description: "digitOrThrow('0x', 0) returns [0, 1]" },
    { id: "digitorthrow-nine", description: "digitOrThrow('9', 0) returns [9, 1]" },
    { id: "digitorthrow-letter", description: "digitOrThrow('a', 0) throws SyntaxError" },
    { id: "digitorthrow-eof", description: "digitOrThrow('', 0) throws SyntaxError" },
    { id: "digitorthrow-negative", description: "digitOrThrow('5', -1) throws RangeError" },
  ],
};

export function digitOrThrow(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected digit at position ${position} but reached end of input`);
  }
  const c = input[position] as string;
  if (c < "0" || c > "9") {
    throw new SyntaxError(`Expected digit at position ${position} but found ${JSON.stringify(c)}`);
  }
  return [c.charCodeAt(0) - 48, position + 1] as const;
}
