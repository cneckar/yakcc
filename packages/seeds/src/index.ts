// @decision DEC-SEEDS-BARREL-001: index.ts re-exports the public surface of @yakcc/seeds.
// Status: implemented (WI-006)
// Rationale: Callers that need only the seed loader (e.g. the CLI, examples) import from
// "@yakcc/seeds". Callers that need individual block functions import from the specific
// block module path. The barrel keeps the top-level surface minimal.

export { type SeedResult, seedRegistry } from "./seed.js";

// Block function re-exports — each block is also importable via "@yakcc/seeds/blocks/<name>"
// through the package.json exports map. This barrel re-exports all block functions for
// callers that want a single import point.
export { asciiChar } from "./blocks/ascii-char.js";
export { isAsciiDigit } from "./blocks/ascii-digit-set.js";
export { bracket } from "./blocks/bracket.js";
export { charCode } from "./blocks/char-code.js";
export { comma } from "./blocks/comma.js";
export { commaSeparatedIntegers } from "./blocks/comma-separated-integers.js";
export { digit } from "./blocks/digit.js";
export { digitOrThrow } from "./blocks/digit-or-throw.js";
export { emptyListContent } from "./blocks/empty-list-content.js";
export { eofCheck } from "./blocks/eof-check.js";
export { integer } from "./blocks/integer.js";
export { listOfInts } from "./blocks/list-of-ints.js";
export { nonAsciiRejector } from "./blocks/non-ascii-rejector.js";
export { nonemptyListContent } from "./blocks/nonempty-list-content.js";
export { optionalWhitespace } from "./blocks/optional-whitespace.js";
export { peekChar } from "./blocks/peek-char.js";
export { positionStep } from "./blocks/position-step.js";
export { signedInteger } from "./blocks/signed-integer.js";
export { stringFromPosition } from "./blocks/string-from-position.js";
export { whitespace } from "./blocks/whitespace.js";
