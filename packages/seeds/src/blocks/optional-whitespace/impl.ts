// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-OPTWS-001: optional-whitespace is an explicit alias for whitespace.
// Status: implemented (WI-006)
// Rationale: Naming clarity for composition sites that want to communicate intent.
// "optional-whitespace" at a call site signals "whitespace may or may not be present here"
// vs a plain "whitespace" call which is ambiguous about whether whitespace is required.

export function optionalWhitespace(input: string, position: number): number {
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
