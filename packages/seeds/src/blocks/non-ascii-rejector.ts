// @decision DEC-SEEDS-NONASCII-001: non-ascii-rejector is a full-input validation gate.
// Status: implemented (WI-006)
// Rationale: The seed corpus parsers only handle ASCII. Failing fast on non-ASCII at the
// entry point gives a clear error rather than a cryptic failure mid-parse.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "input", type: "string", description: "The full input string to validate." }],
  outputs: [
    { name: "result", type: "void", description: "Returns undefined if all bytes are ASCII." },
  ],
  behavior:
    "Scan the entire input string and throw RangeError at the first character with code > 127. Returns undefined if all characters are ASCII (code <= 127).",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    {
      id: "first-violation",
      description: "Error message includes the position and code of the first non-ASCII character.",
    },
  ],
  errorConditions: [
    {
      description: "Any character in input has char code > 127.",
      errorType: "RangeError",
    },
  ],
  nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "non-ascii-rejector-clean", description: "nonAsciiRejector('hello') returns undefined" },
    { id: "non-ascii-rejector-empty", description: "nonAsciiRejector('') returns undefined" },
    {
      id: "non-ascii-rejector-unicode",
      description: "nonAsciiRejector('caf\\u00e9') throws RangeError",
    },
    {
      id: "non-ascii-rejector-digits",
      description: "nonAsciiRejector('[1,2,3]') returns undefined",
    },
    {
      id: "non-ascii-rejector-mid",
      description: "nonAsciiRejector('ab\\u0080c') throws RangeError",
    },
  ],
};

export function nonAsciiRejector(input: string): void {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}: code ${code}`);
    }
  }
}
