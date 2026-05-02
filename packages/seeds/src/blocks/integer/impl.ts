// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-INTEGER-001: integer composes digit; returns value + new position as a tuple.
// Status: implemented (WI-006)
// Rationale: Returning [value, newPosition] keeps the block pure while providing both the
// parsed value and the advanced cursor to the caller without a mutable context object.

export function integer(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length || input[position] === undefined) {
    throw new SyntaxError(`Expected digit at position ${position} but reached end of input`);
  }
  const first = input[position] as string;
  if (first < "0" || first > "9") {
    throw new SyntaxError(
      `Expected digit at position ${position} but found ${JSON.stringify(first)}`,
    );
  }
  let value = 0;
  let pos = position;
  while (pos < input.length) {
    const c = input[pos] as string;
    if (c < "0" || c > "9") break;
    value = value * 10 + (c.charCodeAt(0) - 48);
    pos++;
  }
  return [value, pos] as const;
}
