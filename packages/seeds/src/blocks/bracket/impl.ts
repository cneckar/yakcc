// @decision DEC-SEEDS-BRACKET-001: bracket matches a single bracket char and returns next position.
// Status: implemented (WI-006)
// Rationale: Bracket matching is a hot path in list parsing. Returning the post-bracket position
// follows the positional combinator convention used by all other blocks in this corpus.

export function bracket(input: string, position: number, kind: "[" | "]"): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected '${kind}' at position ${position} but reached end of input`);
  }
  if (input[position] !== kind) {
    throw new SyntaxError(
      `Expected '${kind}' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
