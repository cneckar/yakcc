// @decision DEC-SEEDS-CHARCODE-001: char-code exposes char-code lookup as an explicit contract.
// Status: implemented (WI-006)
// Rationale: Multiple blocks rely on charCodeAt arithmetic. Making it an explicit block
// documents the zero-extension property (always non-negative) and enables registry reuse.

export function charCode(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new RangeError(`Position ${position} out of bounds for input of length ${input.length}`);
  }
  return input.charCodeAt(position);
}
