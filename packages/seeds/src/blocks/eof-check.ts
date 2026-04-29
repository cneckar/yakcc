// @decision DEC-SEEDS-EOFCHECK-001: eof-check is the trailing-input rejection gate.
// Status: implemented (WI-006)
// Rationale: A parser that accepts input must also reject trailing garbage. This block
// is the explicit end-of-input assertion that composition blocks call after parsing.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Expected end position." },
  ],
  outputs: [{ name: "result", type: "void", description: "Returns undefined on success." }],
  behavior:
    "Assert that position equals input.length, indicating no trailing input remains. Throws SyntaxError if any input remains after position.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "exact", description: "Succeeds if and only if position === input.length." },
  ],
  errorConditions: [
    {
      description: "position < input.length — trailing characters remain.",
      errorType: "SyntaxError",
    },
    { description: "position > input.length — position overran input.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "eof-check-exact", description: "eofCheck('abc', 3) returns undefined" },
    { id: "eof-check-trailing", description: "eofCheck('abc', 2) throws SyntaxError" },
    { id: "eof-check-overrun", description: "eofCheck('abc', 4) throws RangeError" },
    { id: "eof-check-empty", description: "eofCheck('', 0) returns undefined" },
    { id: "eof-check-empty-nonzero", description: "eofCheck('', 1) throws RangeError" },
  ],
};

export function eofCheck(input: string, position: number): void {
  if (position > input.length) {
    throw new RangeError(`Position ${position} overruns input of length ${input.length}`);
  }
  if (position < input.length) {
    throw new SyntaxError(
      `Expected end of input at position ${position} but found ${JSON.stringify(input.slice(position))}`,
    );
  }
}
