// @decision DEC-SEEDS-NONEMPTYLIST-001: nonempty-list-content parses interior with at least one element.
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
import type { bracket } from "./bracket.js";
import type { comma } from "./comma.js";
import type { integer } from "./integer.js";
import type { optionalWhitespace } from "./optional-whitespace.js";
import type { peekChar } from "./peek-char.js";

// Suppress "imported but never used as a value" by surfacing type aliases.
type _Bracket = typeof bracket;
type _Comma = typeof comma;
type _Integer = typeof integer;
type _OptionalWhitespace = typeof optionalWhitespace;
type _PeekChar = typeof peekChar;

export const CONTRACT: ContractSpec = {
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Position immediately after '['." },
  ],
  outputs: [
    {
      name: "result",
      type: "readonly [ReadonlyArray<number>, number]",
      description: "[parsedValues, newPosition] where newPosition is after the closing ']'.",
    },
  ],
  behavior:
    "Parse one or more comma-separated integers followed by ']'. Skips optional whitespace around each integer. Returns [values, newPosition] where newPosition is after the closing ']'. Throws SyntaxError if the first character is not a digit or if ']' is not found after all elements.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "nonempty", description: "Result array always contains at least one element." },
    {
      id: "closes",
      description: "newPosition is always after the closing ']' on success.",
    },
    {
      id: "composition",
      description:
        "Implemented by composing optionalWhitespace, integer, peekChar, comma, and bracket.",
    },
  ],
  errorConditions: [
    { description: "No digit found where first integer is expected.", errorType: "SyntaxError" },
    { description: "Missing ']' after last integer.", errorType: "SyntaxError" },
    { description: "position < 0.", errorType: "RangeError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(n)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    {
      id: "nonempty-single",
      description: "nonemptyListContent('1]', 0) returns [[1], 2]",
    },
    {
      id: "nonempty-multiple",
      description: "nonemptyListContent('1,2,3]', 0) returns [[1, 2, 3], 6]",
    },
    {
      id: "nonempty-spaces",
      description: "nonemptyListContent(' 42 ]', 0) returns [[42], 5]",
    },
    {
      id: "nonempty-no-digit",
      description: "nonemptyListContent('x]', 0) throws SyntaxError",
    },
    {
      id: "nonempty-no-close",
      description: "nonemptyListContent('1,2', 0) throws SyntaxError",
    },
  ],
};

// ---------------------------------------------------------------------------
// Implementation
//
// Each section mirrors one sub-block's contract boundary exactly:
//   optionalWhitespace(input, pos)  → skip spaces/tabs; return new pos
//   integer(input, pos)             → parse digits; return [value, newPos]
//   peekChar(input, pos)            → return char at pos or null (no advance)
//   comma(input, pos)               → assert ','; return pos+1
//   bracket(input, pos, ']')        → assert ']'; return pos+1
// ---------------------------------------------------------------------------

export function nonemptyListContent(
  input: string,
  position: number,
): readonly [ReadonlyArray<number>, number] {
  if (position < 0) {
    throw new RangeError(`Position ${position} is negative`);
  }

  const values: number[] = [];
  let pos = position;

  // optionalWhitespace: skip leading spaces/tabs before first integer.
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
    pos++;
  }

  // integer: parse first integer (one or more digits required).
  if (pos >= input.length || (input[pos] as string) < "0" || (input[pos] as string) > "9") {
    throw new SyntaxError(
      `Expected digit at position ${pos} but found ${JSON.stringify(input[pos] ?? "EOF")}`,
    );
  }
  let first = 0;
  while (pos < input.length) {
    const c = input[pos] as string;
    if (c < "0" || c > "9") break;
    first = first * 10 + (c.charCodeAt(0) - 48);
    pos++;
  }
  values.push(first);

  // optionalWhitespace: skip whitespace after first integer.
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
    pos++;
  }

  // peekChar + comma loop: consume each ", integer" pair while ',' is next.
  while (pos < input.length && input[pos] === ",") {
    // comma: assert ',' and advance.
    pos++;

    // optionalWhitespace: skip whitespace after comma.
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }

    // integer: parse next integer.
    if (pos >= input.length || (input[pos] as string) < "0" || (input[pos] as string) > "9") {
      throw new SyntaxError(
        `Expected digit after ',' at position ${pos} but found ${JSON.stringify(input[pos] ?? "EOF")}`,
      );
    }
    let val = 0;
    while (pos < input.length) {
      const c = input[pos] as string;
      if (c < "0" || c > "9") break;
      val = val * 10 + (c.charCodeAt(0) - 48);
      pos++;
    }
    values.push(val);

    // optionalWhitespace: skip whitespace after integer.
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }
  }

  // bracket(input, pos, ']'): expect closing ']'.
  if (pos >= input.length || input[pos] !== "]") {
    throw new SyntaxError(
      `Expected ']' at position ${pos} but found ${JSON.stringify(input[pos] ?? "EOF")}`,
    );
  }
  pos++;

  return [values, pos] as const;
}
