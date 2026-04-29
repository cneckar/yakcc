// @decision DEC-SEEDS-STRFROMPOS-001: substring extraction at a position is a reusable primitive.
// Status: implemented (WI-006)
// Rationale: Multiple blocks need to extract substrings starting at a position. Centralising
// bounds checking avoids each block duplicating the same guard logic.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "start", type: "number", description: "Zero-based start index (inclusive)." },
    { name: "end", type: "number", description: "Zero-based end index (exclusive)." },
  ],
  outputs: [
    {
      name: "result",
      type: "string",
      description: "Substring input[start..end].",
    },
  ],
  behavior:
    "Return the substring of input from start (inclusive) to end (exclusive). Equivalent to input.slice(start, end) but with explicit bounds validation.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    {
      id: "length",
      description: "Result length equals end - start when inputs are valid.",
    },
  ],
  errorConditions: [
    { description: "start < 0 or end < 0.", errorType: "RangeError" },
    { description: "start > end.", errorType: "RangeError" },
    { description: "end > input.length.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(n)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "strfrompos-basic", description: "stringFromPosition('abcde', 1, 3) returns 'bc'" },
    { id: "strfrompos-empty", description: "stringFromPosition('abc', 1, 1) returns ''" },
    {
      id: "strfrompos-negative-start",
      description: "stringFromPosition('abc', -1, 2) throws RangeError",
    },
    {
      id: "strfrompos-start-gt-end",
      description: "stringFromPosition('abc', 2, 1) throws RangeError",
    },
    { id: "strfrompos-end-oob", description: "stringFromPosition('abc', 0, 4) throws RangeError" },
  ],
};

export function stringFromPosition(input: string, start: number, end: number): string {
  if (start < 0 || end < 0) {
    throw new RangeError(`Negative index: start=${start}, end=${end}`);
  }
  if (start > end) {
    throw new RangeError(`start ${start} > end ${end}`);
  }
  if (end > input.length) {
    throw new RangeError(`end ${end} exceeds input length ${input.length}`);
  }
  return input.slice(start, end);
}
