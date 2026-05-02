// SPDX-License-Identifier: MIT
// @decision DEC-SEEDS-EOFCHECK-001: eof-check is the trailing-input rejection gate.
// Status: implemented (WI-006)
// Rationale: A parser that accepts input must also reject trailing garbage. This block
// is the explicit end-of-input assertion that composition blocks call after parsing.

export function eofCheck(input: string, position: number): void {
  if (position > input.length) {
    throw new RangeError(`Position ${position} overruns input of length ${input.length}`);
  }
  if (position < input.length) {
    throw new SyntaxError(
      `Expected end of input at position ${position} but found ${JSON.stringify(input.slice(position))}`,
    );
  }
}
