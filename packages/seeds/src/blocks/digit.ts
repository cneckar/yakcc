// @decision DEC-SEEDS-DIGIT-001: digit block is the atomic unit of integer parsing.
// Status: implemented (WI-006)
// Rationale: Every integer parser reduces to recognizing individual digit characters.
// This block is the leaf of the composition graph and the simplest possible contract.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string", description: "A single character string." }],
  outputs: [{ name: "result", type: "number", description: "Integer value 0-9." }],
  behavior:
    "Parse a single ASCII digit character '0'-'9' to its integer value 0-9. Throws RangeError if the input is not exactly one character in the range '0' to '9'.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "range", description: "Result is an integer in the closed range [0, 9]." },
    { id: "inverse", description: "digit(String.fromCharCode(48 + n)) === n for n in [0,9]." },
  ],
  errorConditions: [
    { description: "Input is not exactly one character.", errorType: "RangeError" },
    { description: "Input character is not in '0'-'9'.", errorType: "RangeError" },
  ],
  nonFunctional: {
    time: "O(1)",
    space: "O(1)",
    purity: "pure",
    threadSafety: "safe",
  },
  propertyTests: [
    { id: "digit-zero", description: "digit('0') returns 0" },
    { id: "digit-nine", description: "digit('9') returns 9" },
    { id: "digit-five", description: "digit('5') returns 5" },
    { id: "digit-non-numeric", description: "digit('a') throws RangeError" },
    { id: "digit-empty", description: "digit('') throws RangeError" },
    { id: "digit-multi-char", description: "digit('12') throws RangeError" },
  ],
};

export function digit(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(`Not a digit: ${JSON.stringify(s)}`);
  }
  return s.charCodeAt(0) - 48;
}
