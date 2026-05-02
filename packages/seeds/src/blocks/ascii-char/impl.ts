// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-ASCIICHAR-001: ascii-char is the positional consumption primitive.
// Status: implemented (WI-006)
// Rationale: Many parsing blocks need to consume a character at a known offset without
// interpretation. This block is the positional-read utility that others compose.

export function asciiChar(input: string, position: number): string {
  if (position < 0 || position >= input.length) {
    throw new RangeError(`Position ${position} out of bounds for input of length ${input.length}`);
  }
  const code = input.charCodeAt(position);
  if (code > 127) {
    throw new RangeError(`Non-ASCII character at position ${position}: code ${code}`);
  }
  return input[position] as string;
}
