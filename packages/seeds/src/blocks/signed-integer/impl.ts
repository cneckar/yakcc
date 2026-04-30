// @decision DEC-SEEDS-SIGNEDINT-001: signed-integer extends integer with optional leading minus.
// Status: implemented (WI-006)
// Rationale: A common extension of unsigned integer parsing. Demonstrates contract refinement:
// signed-integer has a strictly wider input domain than integer but same output type contract.

export function signedInteger(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  if (position >= input.length) {
    throw new SyntaxError(`Expected digit or '-' at position ${position} but reached end of input`);
  }

  let pos = position;
  let sign = 1;

  if (input[pos] === "-") {
    sign = -1;
    pos++;
    if (pos >= input.length) {
      throw new SyntaxError(`Expected digit after '-' at position ${pos} but reached end of input`);
    }
  }

  const c = input[pos] as string;
  if (c < "0" || c > "9") {
    throw new SyntaxError(`Expected digit at position ${pos} but found ${JSON.stringify(c)}`);
  }

  let value = 0;
  while (pos < input.length) {
    const ch = input[pos] as string;
    if (ch < "0" || ch > "9") break;
    value = value * 10 + (ch.charCodeAt(0) - 48);
    pos++;
  }

  return [sign * value, pos] as const;
}
