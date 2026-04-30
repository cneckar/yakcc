// @decision DEC-SEEDS-ASCIIDIGITSET-001: constant membership test avoids char comparison chains.
// Status: implemented (WI-006)
// Rationale: A Boolean predicate over the digit set is used by multiple blocks that need
// to check-without-consume. Separating it makes the predicate independently testable.

export function isAsciiDigit(c: string): boolean {
  return c.length === 1 && c >= "0" && c <= "9";
}
