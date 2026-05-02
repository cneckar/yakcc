// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-STRFROMPOS-001: substring extraction at a position is a reusable primitive.
// Status: implemented (WI-006)
// Rationale: Multiple blocks need to extract substrings starting at a position. Centralising
// bounds checking avoids each block duplicating the same guard logic.

export function stringFromPosition(input: string, start: number, end: number): string {
  if (start < 0 || end < 0) {
    throw new RangeError(`Negative index: start=${start}, end=${end}`);
  }
  if (start > end) {
    throw new RangeError(`start ${start} > end ${end}`);
  }
  if (end > input.length) {
    throw new RangeError(`end ${end} exceeds input length ${input.length}`);
  }
  return input.slice(start, end);
}
