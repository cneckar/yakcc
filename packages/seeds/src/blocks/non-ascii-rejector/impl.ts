// @decision DEC-SEEDS-NONASCII-001: non-ascii-rejector is a full-input validation gate.
// Status: implemented (WI-006)
// Rationale: The seed corpus parsers only handle ASCII. Failing fast on non-ASCII at the
// entry point gives a clear error rather than a cryptic failure mid-parse.

export function nonAsciiRejector(input: string): void {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}: code ${code}`);
    }
  }
}
