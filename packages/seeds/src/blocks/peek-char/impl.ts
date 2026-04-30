// @decision DEC-SEEDS-PEEKCHAR-001: peek-without-advance is a fundamental parser combinator primitive.
// Status: implemented (WI-006)
// Rationale: Many parsing decisions are made by inspecting the next character without consuming it.
// Separating peek from consume avoids coupling lookahead to position advancement.

export function peekChar(input: string, position: number): string | null {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    return null;
  }
  return input[position] as string;
}
