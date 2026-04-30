// @decision DEC-SEEDS-DIGIT-001: digit block is the atomic unit of integer parsing.
// Status: implemented (WI-006)
// Rationale: Every integer parser reduces to recognizing individual digit characters.
// This block is the leaf of the composition graph and the simplest possible contract.

export function digit(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(`Not a digit: ${JSON.stringify(s)}`);
  }
  return s.charCodeAt(0) - 48;
}
