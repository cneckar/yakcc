// @decision DEC-SEEDS-LISTOFINTS-001: list-of-ints composes bracket/whitespace/nonempty/empty blocks.
// Status: implemented (WI-006)
// Rationale: This is the top-level compositor block. The import-type declarations below
// declare the composition graph. Relative "./" imports are used so TypeScript can resolve
// the sibling block declarations; seedRegistry passes blockPatterns: ["./"] to parseBlock
// so extractComposition captures these as sub-block references in the provenance manifest.
// Because strict-subset validates each block in an isolated single-file ts-morph project,
// `import type` is used — type-only imports are unconditionally skipped by no-untyped-imports.
import type { ContractSpec } from "@yakcc/contracts";
// Composition graph — captured by extractComposition when blockPatterns includes "./".
import type { bracket } from "./bracket.js";
import type { emptyListContent } from "./empty-list-content.js";
import type { eofCheck } from "./eof-check.js";
import type { nonAsciiRejector } from "./non-ascii-rejector.js";
import type { nonemptyListContent } from "./nonempty-list-content.js";
import type { optionalWhitespace } from "./optional-whitespace.js";
import type { peekChar } from "./peek-char.js";

// Suppress "imported but never used as a value" by surfacing type aliases.
// These are type-level witnesses documenting which sub-block signatures are mirrored below.
type _Bracket = typeof bracket;
type _EmptyListContent = typeof emptyListContent;
type _EofCheck = typeof eofCheck;
type _NonAsciiRejector = typeof nonAsciiRejector;
type _NonemptyListContent = typeof nonemptyListContent;
type _OptionalWhitespace = typeof optionalWhitespace;
type _PeekChar = typeof peekChar;

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "input", type: "string", description: "A JSON-style list of integers string." }],
  outputs: [
    {
      name: "result",
      type: "ReadonlyArray<number>",
      description: "The parsed list of non-negative integers.",
    },
  ],
  behavior:
    "Parse a string of the form '[i1,i2,...,iN]' where each element is a non-negative decimal integer. Surrounding whitespace around elements is allowed. Returns the parsed numbers as a readonly array. Throws SyntaxError on malformed input and RangeError on non-ASCII input.",
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects." },
    { id: "empty-ok", description: "Accepts '[]' and returns an empty array." },
    {
      id: "composition",
      description:
        "Implemented by composing nonAsciiRejector, bracket, optionalWhitespace, peekChar, emptyListContent, nonemptyListContent, and eofCheck.",
    },
    { id: "no-trailing", description: "Rejects input with characters after the closing ']'." },
  ],
  errorConditions: [
    { description: "Input does not start with '['.", errorType: "SyntaxError" },
    { description: "Input contains non-ASCII characters.", errorType: "RangeError" },
    { description: "List elements are not valid non-negative integers.", errorType: "SyntaxError" },
    { description: "Trailing characters after closing ']'.", errorType: "SyntaxError" },
    { description: "Input ends before closing ']'.", errorType: "SyntaxError" },
  ],
  nonFunctional: { time: "O(n)", space: "O(n)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "list-empty", description: "listOfInts('[]') returns []" },
    { id: "list-single", description: "listOfInts('[1]') returns [1]" },
    { id: "list-multiple", description: "listOfInts('[1,2,3]') returns [1, 2, 3]" },
    { id: "list-spaces", description: "listOfInts('[ 42 ]') returns [42]" },
    { id: "list-incomplete", description: "listOfInts('[1,2,') throws SyntaxError" },
    { id: "list-non-digit", description: "listOfInts('[abc]') throws SyntaxError" },
    { id: "list-no-open", description: "listOfInts('1,2,3]') throws SyntaxError" },
    { id: "list-trailing", description: "listOfInts('[1]x') throws SyntaxError" },
  ],
};

// ---------------------------------------------------------------------------
// Implementation
//
// Each section mirrors one sub-block's contract boundary exactly:
//   nonAsciiRejector(input)               → scan all chars; throw RangeError on code > 127
//   bracket(input, pos, '[')              → assert '[' at pos; return pos+1
//   optionalWhitespace(input, pos)        → skip spaces/tabs; return new pos
//   peekChar(input, pos)                  → return char at pos or null (no advance)
//   emptyListContent(input, pos)          → assert ']'; return pos+1
//   nonemptyListContent(input, pos)       → parse ints+commas+']'; return [values, newPos]
//   eofCheck(input, pos)                  → assert pos === input.length
// ---------------------------------------------------------------------------

export function listOfInts(input: string): ReadonlyArray<number> {
  // nonAsciiRejector: scan full input; throw RangeError on first code > 127.
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}: code ${input.charCodeAt(i)}`);
    }
  }

  // bracket(input, 0, '['): assert '[' at position 0.
  if (input.length === 0 || input[0] !== "[") {
    throw new SyntaxError(
      `Expected '[' at position 0 but found ${JSON.stringify(input[0] ?? "EOF")}`,
    );
  }
  let pos = 1;

  // optionalWhitespace(input, pos): skip spaces/tabs after '['.
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
    pos++;
  }

  // peekChar(input, pos): inspect next character without advancing.
  const next = pos < input.length ? input[pos] : null;

  let values: ReadonlyArray<number>;
  if (next === "]") {
    // emptyListContent(input, pos): assert ']', return pos+1.
    pos++;
    values = [] as const;
  } else {
    // nonemptyListContent(input, pos): parse one or more comma-separated ints + closing ']'.
    const result = _nonemptyListContent(input, pos);
    values = result[0];
    pos = result[1];
  }

  // eofCheck(input, pos): assert pos === input.length.
  if (pos > input.length) {
    throw new RangeError(`Position ${pos} overruns input of length ${input.length}`);
  }
  if (pos < input.length) {
    throw new SyntaxError(
      `Expected end of input at position ${pos} but found ${JSON.stringify(input.slice(pos))}`,
    );
  }

  return values;
}

// ---------------------------------------------------------------------------
// Internal: nonemptyListContent sub-block (mirrors nonempty-list-content.ts contract)
// ---------------------------------------------------------------------------

function _nonemptyListContent(
  input: string,
  position: number,
): readonly [ReadonlyArray<number>, number] {
  const values: number[] = [];
  let pos = position;

  // optionalWhitespace: skip leading spaces/tabs.
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

  // commaSeparatedIntegers: loop over ", integer" pairs.
  while (pos < input.length && input[pos] === ",") {
    // comma: consume ','.
    pos++;
    // optionalWhitespace: skip after comma.
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
    // optionalWhitespace: skip after integer.
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
