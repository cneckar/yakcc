// @decision DEC-SEEDS-EMPTYLIST-001: empty-list-content recognizes the ']' that closes an empty list.
// Status: implemented (WI-006)
// Rationale: Splitting empty vs nonempty list content into two blocks keeps each block's
// contract minimal. list-of-ints dispatches based on the first character after '['.

export function emptyListContent(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected ']' at position ${position} but reached end of input`);
  }
  if (input[position] !== "]") {
    throw new SyntaxError(
      `Expected ']' at position ${position} but found ${JSON.stringify(input[position])}`,
    );
  }
  return position + 1;
}
