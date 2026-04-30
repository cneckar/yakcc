// @decision DEC-SEEDS-COMMA-001: comma follows the same positional combinator convention as bracket.
// Status: implemented (WI-006)
// Rationale: Consistent positional-return API across all terminal matchers means they
// can be composed without wrapping. Returns next position rather than a boolean.

export function comma(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected ',' at position ${position} but reached end of input`);
  }
  if (input[position] !== ",") {
    throw new SyntaxError(
      `Expected ',' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
