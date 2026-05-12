// SPDX-License-Identifier: MIT

/**
 * Encode a Uint8Array as a lowercase hexadecimal string. Each byte is
 * represented as exactly two hex digits (with leading zero if needed).
 * An empty input produces an empty string.
 *
 * @param data - The binary data to encode.
 * @returns Lowercase hex string of length data.length * 2.
 */
export function hexEncodeLowercase(data: Uint8Array): string {
  const chars: string[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    chars[i] = (byte < 16 ? "0" : "") + byte.toString(16);
  }
  return chars.join("");
}
