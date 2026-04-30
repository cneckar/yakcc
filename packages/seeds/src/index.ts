// @decision DEC-SEEDS-BARREL-001: index.ts re-exports the public surface of @yakcc/seeds.
// Status: implemented (WI-006)
// Rationale: Callers that need only the seed loader (e.g. the CLI, examples) import from
// "@yakcc/seeds". Callers that need individual block functions import from the specific
// block module path. The barrel keeps the top-level surface minimal.

export { type SeedResult, seedRegistry } from "./seed.js";

// Block function re-exports — each block is also importable via "@yakcc/seeds/blocks/<name>"
// through the package.json exports map. This barrel re-exports all block functions for
// callers that want a single import point.
// WI-T05: import paths updated from ./blocks/<name>.js to ./blocks/<name>/impl.js
// (triplet directory structure — Sacred Practice #12, no parallel mechanisms).
export { asciiChar } from "./blocks/ascii-char/impl.js";
export { isAsciiDigit } from "./blocks/ascii-digit-set/impl.js";
export { bracket } from "./blocks/bracket/impl.js";
export { charCode } from "./blocks/char-code/impl.js";
export { comma } from "./blocks/comma/impl.js";
export { commaSeparatedIntegers } from "./blocks/comma-separated-integers/impl.js";
export { digit } from "./blocks/digit/impl.js";
export { digitOrThrow } from "./blocks/digit-or-throw/impl.js";
export { emptyListContent } from "./blocks/empty-list-content/impl.js";
export { eofCheck } from "./blocks/eof-check/impl.js";
export { integer } from "./blocks/integer/impl.js";
export { listOfInts } from "./blocks/list-of-ints/impl.js";
export { nonAsciiRejector } from "./blocks/non-ascii-rejector/impl.js";
export { nonemptyListContent } from "./blocks/nonempty-list-content/impl.js";
export { optionalWhitespace } from "./blocks/optional-whitespace/impl.js";
export { peekChar } from "./blocks/peek-char/impl.js";
export { positionStep } from "./blocks/position-step/impl.js";
export { signedInteger } from "./blocks/signed-integer/impl.js";
export { stringFromPosition } from "./blocks/string-from-position/impl.js";
export { whitespace } from "./blocks/whitespace/impl.js";
