// SPDX-License-Identifier: MIT
// camelCase → snake_case de-normalization for Python lower adapter.

/**
 * Convert a camelCase identifier to snake_case.
 * "digitOrThrow" → "digit_or_throw"
 * "eofCheck" → "eof_check"
 * Already-snake or single-word identifiers are returned unchanged.
 */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
