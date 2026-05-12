// SPDX-License-Identifier: MIT

/**
 * Validate whether a string is a valid IPv4 address in dotted-decimal notation.
 * Accepts addresses of the form "A.B.C.D" where each octet is an integer in [0, 255].
 * Rejects leading zeros, extra whitespace, and non-numeric characters.
 *
 * @param address - The string to validate.
 * @returns True if the string is a valid IPv4 address; false otherwise.
 */
export function isValidIPv4(address: string): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part[0] === "0") return false;
    const num = Number(part);
    if (num < 0 || num > 255 || !Number.isInteger(num)) return false;
  }
  return true;
}
