// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-WHITESPACE-001: whitespace skipping returns a new position, not stripped text.
// Status: implemented (WI-006)
// Rationale: Position-returning parsers compose without allocating substrings.
// Returning the new position after whitespace is cheaper and composable with all other blocks.

export function whitespace(input: string, position: number): number {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  let pos = position;
  while (pos < input.length) {
    const c = input[pos];
    if (c !== " " && c !== "\t") {
      break;
    }
    pos++;
  }
  return pos;
}
