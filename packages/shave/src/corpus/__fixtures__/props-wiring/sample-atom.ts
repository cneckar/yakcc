// SPDX-License-Identifier: MIT
// Fixture: sample source atom used in props-file corpus wiring tests.
// This simulates a real source file with an exported function.

/**
 * Converts a string to its uppercase equivalent.
 * @param input - The string to uppercase.
 */
export function toUpperCase(input: string): string {
  return input.toUpperCase();
}
