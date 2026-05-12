// SPDX-License-Identifier: MIT

/**
 * Encode a non-negative integer as a base-128 variable-length integer (varint)
 * in the format used by Protocol Buffers. Each byte contributes 7 bits of the
 * value; the most-significant bit of each byte is 1 if more bytes follow and 0
 * for the final byte. Encodes values in [0, 2^53 - 1] (JavaScript safe integers).
 *
 * @param value - Non-negative safe integer to encode.
 * @returns Uint8Array containing the varint encoding (1–8 bytes).
 * @throws {RangeError} if value is not a non-negative safe integer.
 */
export function varintEncode(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("varintEncode: value must be a non-negative safe integer");
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128); // avoid bitwise ops losing high bits
  }
  bytes.push(remaining & 0x7f);
  return new Uint8Array(bytes);
}
