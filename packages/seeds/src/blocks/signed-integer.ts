// @decision DEC-SEEDS-SIGNEDINT-001: signed-integer extends integer with optional leading minus.
// Status: implemented (WI-006)
// Rationale: A common extension of unsigned integer parsing. Demonstrates contract refinement:
// signed-integer has a strictly wider input domain than integer but same output type contract.
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based start position." },
  ],
  outputs: [
    {
      name: "result",
      type: "readonly [number, number]",
      description: "[parsedValue, newPosition] where parsedValue may be negative.",
    },
  ],
  behavior:
    "Parse an optional '-' sign followed by one or more decimal digits. Returns [value, newPosition]. A bare '-' with no digits throws SyntaxError. Negative zero is represented as 0.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "greedy", description: "Consumes as many digits as possible after the optional sign." },
  ],
  errorConditions: [
    { description: "No digit follows an optional '-' sign.", errorType: "SyntaxError" },
    { description: "No digit or '-' found at position.", errorType: "SyntaxError" },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "signed-int-positive", description: "signedInteger('42', 0) returns [42, 2]" },
    { id: "signed-int-negative", description: "signedInteger('-7', 0) returns [-7, 2]" },
    { id: "signed-int-bare-minus", description: "signedInteger('-x', 0) throws SyntaxError" },
    { id: "signed-int-no-digit", description: "signedInteger('abc', 0) throws SyntaxError" },
    { id: "signed-int-eof", description: "signedInteger('', 0) throws SyntaxError" },
    { id: "signed-int-negative-pos", description: "signedInteger('1', -1) throws RangeError" },
  ],
};

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
