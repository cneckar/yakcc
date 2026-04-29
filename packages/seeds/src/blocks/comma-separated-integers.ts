// @decision DEC-SEEDS-COMMASEP-001: comma-separated-integers parses the interior of a list after the first element.
// Status: implemented (WI-006)
// Rationale: The import-type declarations below declare the composition graph. Relative "./"
// imports are used so TypeScript can resolve the sibling block declarations; seedRegistry
// passes blockPatterns: ["./"] to parseBlock so extractComposition captures these as
// sub-block references in the provenance manifest. `import type` is used because
// strict-subset validates each block in an isolated single-file ts-morph project where
// sibling value imports resolve to `any` and fail no-untyped-imports. Type-only imports
// are unconditionally skipped by that rule.
import type { ContractSpec } from "@yakcc/contracts";
// Composition graph — captured by extractComposition when blockPatterns includes "./".
import type { comma } from "./comma.js";
import type { integer } from "./integer.js";
import type { optionalWhitespace } from "./optional-whitespace.js";
import type { peekChar } from "./peek-char.js";

// Suppress "imported but never used as a value" by surfacing type aliases.
type _Comma = typeof comma;
type _Integer = typeof integer;
type _OptionalWhitespace = typeof optionalWhitespace;
type _PeekChar = typeof peekChar;

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    {
      name: "position",
      type: "number",
      description: "Position immediately after the first integer.",
    },
  ],
  outputs: [
    {
      name: "result",
      type: "readonly [ReadonlyArray<number>, number]",
      description: "Tuple of [additionalValues, newPosition] for zero or more ', integer' pairs.",
    },
  ],
  behavior:
    "Parse zero or more ', integer' sequences. Each iteration skips optional whitespace, expects ',', skips optional whitespace, then parses an integer. Returns [values, newPosition] where values is the list of additional integers found. Stops when the next character is not ','.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "greedy", description: "Consumes as many comma-integer pairs as possible." },
    { id: "empty-ok", description: "Returns [[], position] when no comma follows." },
    {
      id: "composition",
      description: "Implemented by composing peekChar, comma, optionalWhitespace, and integer.",
    },
  ],
  errorConditions: [
    {
      description: "A comma is present but not followed by a valid integer.",
      errorType: "SyntaxError",
    },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(n)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    {
      id: "commasep-none",
      description: "commaSeparatedIntegers(']', 0) returns [[], 0]",
    },
    {
      id: "commasep-one",
      description: "commaSeparatedIntegers(',2]', 0) returns [[2], 2]",
    },
    {
      id: "commasep-two",
      description: "commaSeparatedIntegers(',2,3]', 0) returns [[2, 3], 4]",
    },
    {
      id: "commasep-trailing-comma",
      description: "commaSeparatedIntegers(',]', 0) throws SyntaxError",
    },
    {
      id: "commasep-negative-pos",
      description: "commaSeparatedIntegers(',1', -1) throws RangeError",
    },
  ],
};

// ---------------------------------------------------------------------------
// Implementation
//
// Each section mirrors one sub-block's contract boundary exactly:
//   peekChar(input, pos)            → return char at pos or null (no advance)
//   comma(input, pos)               → assert ','; return pos+1
//   optionalWhitespace(input, pos)  → skip spaces/tabs; return new pos
//   integer(input, pos)             → parse digits; return [value, newPos]
// ---------------------------------------------------------------------------

export function commaSeparatedIntegers(
  input: string,
  position: number,
): readonly [ReadonlyArray<number>, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }
  const values: number[] = [];
  let pos = position;

  // peekChar: inspect next char without advancing; loop while ',' is next.
  while (pos < input.length && input[pos] === ",") {
    // comma: assert ',' and advance past it.
    pos++;

    // optionalWhitespace: skip spaces/tabs after comma.
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }

    // integer: parse one or more digits.
    if (pos >= input.length) {
      throw new SyntaxError(
        `Expected integer after ',' at position ${pos} but reached end of input`,
      );
    }
    const c = input[pos] as string;
    if (c < "0" || c > "9") {
      throw new SyntaxError(
        `Expected integer after ',' at position ${pos} but found ${JSON.stringify(c)}`,
      );
    }
    let value = 0;
    while (pos < input.length) {
      const ch = input[pos] as string;
      if (ch < "0" || ch > "9") break;
      value = value * 10 + (ch.charCodeAt(0) - 48);
      pos++;
    }
    values.push(value);

    // optionalWhitespace: skip spaces/tabs after integer.
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }
  }

  return [values, pos] as const;
}
