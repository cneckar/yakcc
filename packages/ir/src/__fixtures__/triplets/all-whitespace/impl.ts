// Fixture: impl.ts for the all-whitespace triplet block.
// Returns true if every character in the input string is a whitespace character.
// Used by parseBlockTriplet tests to exercise sub-block import detection:
// the import from "@yakcc/seeds/blocks/is-whitespace-char" is detected as a
// SpecHash reference by the composition scanner.

import type { IsWhitespaceCharFn } from "@yakcc/seeds/blocks/is-whitespace-char";

export function isAllWhitespace(s: string, isWs: IsWhitespaceCharFn): boolean {
  return s.split("").every(isWs);
}
