// @decision DEC-SEEDS-COMMASEP-001: comma-separated-integers parses the interior of a list after the first element.
// Status: implemented (WI-006)
// Rationale: The import-type declarations below declare the composition graph. Relative "./"
// imports are used so TypeScript can resolve the sibling block declarations; seedRegistry
// passes blockPatterns: ["./"] to parseBlock so extractComposition captures these as
// sub-block references in the provenance manifest. `import type` is used because
// strict-subset validates each block in an isolated single-file ts-morph project where
// sibling value imports resolve to `any` and fail no-untyped-imports. Type-only imports
// are unconditionally skipped by that rule.
// Composition graph — captured by extractComposition via the @yakcc/seeds/ builtin pattern.
// WI-T05-fix: import paths use "@yakcc/seeds/blocks/<name>" so the compile resolver's
// SUB_BLOCK_IMPORT_RE (which matches "@yakcc/seeds/" prefix) can extract sub-block deps.
// All imports are "import type" so the strict-subset validator skips them unconditionally
// and vitest/Vite erases them at transpile time (no runtime module resolution needed).
import type { comma } from "@yakcc/seeds/blocks/comma";
import type { integer } from "@yakcc/seeds/blocks/integer";
import type { optionalWhitespace } from "@yakcc/seeds/blocks/optional-whitespace";
import type { peekChar } from "@yakcc/seeds/blocks/peek-char";

// Suppress "imported but never used as a value" by surfacing type aliases.
type _Comma = typeof comma;
type _Integer = typeof integer;
type _OptionalWhitespace = typeof optionalWhitespace;
type _PeekChar = typeof peekChar;

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
