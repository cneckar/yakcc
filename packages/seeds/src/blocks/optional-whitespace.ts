// @decision DEC-SEEDS-OPTWS-001: optional-whitespace is an explicit alias for whitespace.
// Status: implemented (WI-006)
// Rationale: Naming clarity for composition sites that want to communicate intent.
// "optional-whitespace" at a call site signals "whitespace may or may not be present here"
// vs a plain "whitespace" call which is ambiguous about whether whitespace is required.
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
      description: "Position after skipping any leading spaces or tabs.",
    },
  ],
  behavior:
    "Skip zero or more space (U+0020) or tab (U+0009) characters at position. Returns position unchanged if no whitespace is present. This is the same contract as whitespace but with an explicit name communicating optionality.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "monotonic", description: "Result is always >= position." },
    {
      id: "no-throw-on-eof",
      description: "Returns position unchanged when position >= input.length.",
    },
  ],
  errorConditions: [{ description: "position < 0.", errorType: "RangeError" }],
  nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "optws-none", description: "optionalWhitespace('abc', 0) returns 0" },
    { id: "optws-space", description: "optionalWhitespace('  x', 0) returns 2" },
    { id: "optws-tab", description: "optionalWhitespace('\\tx', 0) returns 1" },
    { id: "optws-eof", description: "optionalWhitespace('', 0) returns 0" },
    { id: "optws-negative", description: "optionalWhitespace('x', -1) throws RangeError" },
  ],
};

export function optionalWhitespace(input: string, position: number): number {
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
