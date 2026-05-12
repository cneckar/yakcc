// SPDX-License-Identifier: MIT

/**
 * Detect whether a string is a valid UUID version 4 in canonical lowercase
 * hyphenated form (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx) where y ∈ {8,9,a,b}.
 * Rejects uppercase hex, missing hyphens, wrong version nibble, or wrong variant bits.
 *
 * @param input - The string to test.
 * @returns True if the string is a canonical UUID v4; false otherwise.
 */
export function isValidUuidV4(input: string): boolean {
  if (typeof input !== "string" || input.length !== 36) return false;
  // Verify hyphen positions
  if (input[8] !== "-" || input[13] !== "-" || input[18] !== "-" || input[23] !== "-") {
    return false;
  }
  // Verify version nibble at position 14 must be '4'
  if (input[14] !== "4") return false;
  // Verify variant nibble at position 19 must be 8, 9, a, or b
  const variant = input[19];
  if (variant !== "8" && variant !== "9" && variant !== "a" && variant !== "b") return false;
  // Verify all non-hyphen characters are lowercase hex digits
  const hexOnly = input.replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(hexOnly);
}
