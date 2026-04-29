// @decision DEC-SEEDS-POSSTEP-001: position advancement is an explicit operation, not implicit mutation.
// Status: implemented (WI-006)
// Rationale: Parser blocks work with immutable position values. positionStep returns
// the new position rather than mutating any state, keeping all blocks pure.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "position", type: "number", description: "Current zero-based position." },
    { name: "n", type: "number", description: "Number of characters to advance." },
    { name: "inputLength", type: "number", description: "Total input length for bounds check." },
  ],
  outputs: [
    {
      name: "newPosition",
      type: "number",
      description: "position + n, validated against inputLength.",
    },
  ],
  behavior:
    "Return position + n after validating that the result does not exceed inputLength. Throws RangeError if n < 0, position < 0, or position + n > inputLength.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "monotonic", description: "Result is always >= position when n >= 0." },
  ],
  errorConditions: [
    { description: "n < 0.", errorType: "RangeError" },
    { description: "position < 0.", errorType: "RangeError" },
    { description: "position + n > inputLength.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "pos-step-basic", description: "positionStep(0, 3, 5) returns 3" },
    { id: "pos-step-to-end", description: "positionStep(2, 3, 5) returns 5" },
    { id: "pos-step-overrun", description: "positionStep(3, 3, 5) throws RangeError" },
    { id: "pos-step-negative-n", description: "positionStep(0, -1, 5) throws RangeError" },
    { id: "pos-step-zero", description: "positionStep(2, 0, 5) returns 2" },
  ],
};

export function positionStep(position: number, n: number, inputLength: number): number {
  if (position < 0) {
    throw new RangeError(`position ${position} is negative`);
  }
  if (n < 0) {
    throw new RangeError(`step ${n} is negative`);
  }
  const next = position + n;
  if (next > inputLength) {
    throw new RangeError(
      `position ${position} + step ${n} = ${next} exceeds input length ${inputLength}`,
    );
  }
  return next;
}
