// @decision DEC-SEEDS-DIGITORTHROW-001: digit-or-throw wraps positional digit reading with context.
// Status: implemented (WI-006)
// Rationale: Callers that have already peeked and confirmed a digit want a single call that
// reads-and-advances with a descriptive error. This combinator adds the position context
// that the raw digit() function lacks.

export function digitOrThrow(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected digit at position ${position} but reached end of input`);
  }
  const c = input[position] as string;
  if (c < "0" || c > "9") {
    throw new SyntaxError(`Expected digit at position ${position} but found ${JSON.stringify(c)}`);
  }
  return [c.charCodeAt(0) - 48, position + 1] as const;
}
