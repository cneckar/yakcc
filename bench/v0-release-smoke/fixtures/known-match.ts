// SPDX-License-Identifier: MIT
/**
 * Parse a JSON-encoded array of integers from a string.
 *
 * Accepts a string like "[1, 2, 3]" and returns an array of integers.
 * Rejects non-array JSON and arrays containing non-integer elements.
 *
 * @param raw - The raw JSON string to parse.
 * @returns An array of integers.
 * @throws {SyntaxError} When the input is not valid JSON.
 * @throws {TypeError} When the parsed value is not an array of integers.
 */
export function parseIntList(raw: string): number[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`Expected a JSON array, got ${typeof parsed}`);
  }
  const result: number[] = [];
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isInteger(item)) {
      throw new TypeError(`Expected integer elements, got ${typeof item}: ${String(item)}`);
    }
    result.push(item);
  }
  return result;
}
