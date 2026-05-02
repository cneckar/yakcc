// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-POSSTEP-001: position advancement is an explicit operation, not implicit mutation.
// Status: implemented (WI-006)
// Rationale: Parser blocks work with immutable position values. positionStep returns
// the new position rather than mutating any state, keeping all blocks pure.

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
