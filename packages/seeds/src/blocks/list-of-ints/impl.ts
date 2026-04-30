// @decision DEC-SEEDS-LISTOFINTS-001: list-of-ints composes bracket/whitespace/nonempty/empty blocks.
// Status: implemented (WI-006)
// Rationale: This is the top-level compositor block. The import-type declarations below
// declare the composition graph. Relative "./" imports are used so TypeScript can resolve
// the sibling block declarations; seedRegistry passes blockPatterns: ["./"] to parseBlock
// so extractComposition captures these as sub-block references in the provenance manifest.
// Because strict-subset validates each block in an isolated single-file ts-morph project,
// `import type` is used — type-only imports are unconditionally skipped by no-untyped-imports.
// Composition graph — captured by extractComposition via the @yakcc/seeds/ builtin pattern.
// WI-T05-fix: import paths use "@yakcc/seeds/blocks/<name>" so the compile resolver's
// SUB_BLOCK_IMPORT_RE (which matches "@yakcc/seeds/" prefix) can extract sub-block deps.
// All imports are "import type" so the strict-subset validator skips them unconditionally
// and vitest/Vite erases them at transpile time (no runtime module resolution needed).
import type { bracket } from "@yakcc/seeds/blocks/bracket";
import type { emptyListContent } from "@yakcc/seeds/blocks/empty-list-content";
import type { eofCheck } from "@yakcc/seeds/blocks/eof-check";
import type { nonAsciiRejector } from "@yakcc/seeds/blocks/non-ascii-rejector";
import type { nonemptyListContent } from "@yakcc/seeds/blocks/nonempty-list-content";
import type { optionalWhitespace } from "@yakcc/seeds/blocks/optional-whitespace";
import type { peekChar } from "@yakcc/seeds/blocks/peek-char";

// Suppress "imported but never used as a value" by surfacing type aliases.
// These are type-level witnesses documenting which sub-block signatures are mirrored below.
type _Bracket = typeof bracket;
type _EmptyListContent = typeof emptyListContent;
type _EofCheck = typeof eofCheck;
type _NonAsciiRejector = typeof nonAsciiRejector;
type _NonemptyListContent = typeof nonemptyListContent;
type _OptionalWhitespace = typeof optionalWhitespace;
type _PeekChar = typeof peekChar;

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
