// Fixture: impl.ts for the digit-of triplet block.
// This is the implementation file for the digitOf block, which parses a single
// ASCII digit character '0'-'9' to its integer value. Used by block-parser tests
// to exercise parseBlockTriplet against a valid triplet directory.

export function digitOf(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(`Not a digit: ${s}`);
  }
  return s.charCodeAt(0) - "0".charCodeAt(0);
}
