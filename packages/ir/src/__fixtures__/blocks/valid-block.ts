// Fixture: valid strict-subset block used by strict-subset path-discovery tests.
// This block satisfies all strict-subset rules and follows the ContractSpec pattern.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number" }],
  behavior: "Parse a single ASCII digit character '0'-'9' to its integer value.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [
    { description: "Input is not a single digit character.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "zero", description: "digitOf('0') === 0" },
    { id: "nine", description: "digitOf('9') === 9" },
  ],
};

export function digitOf(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(`Not a digit: ${s}`);
  }
  return s.charCodeAt(0) - "0".charCodeAt(0);
}
