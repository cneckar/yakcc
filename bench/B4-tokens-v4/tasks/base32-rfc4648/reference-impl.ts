// SPDX-License-Identifier: MIT
// Base32 encoder/decoder — RFC 4648 §6.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Pre-build decode table: char code → 5-bit value (-1 = invalid)
const DECODE_TABLE: Int8Array = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    const code = ALPHABET.charCodeAt(i);
    t[code] = i;
    // Only add lowercase for letters A-Z (codes 65-90); digits 2-7 have no lowercase
    if (code >= 65 && code <= 90) t[code + 32] = i;
  }
  return t;
})();

// Valid lengths mod 8 after stripping padding: 0, 2, 4, 5, 7
const VALID_REMAINDERS = new Set([0, 2, 4, 5, 7]);

export class Base32Codec {
  encode(input: Uint8Array): string {
    let out = '';
    let bits = 0;
    let value = 0;
    for (let i = 0; i < input.length; i++) {
      value = (value << 8) | input[i]!;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += ALPHABET[(value >> bits) & 0x1F];
      }
    }
    if (bits > 0) {
      out += ALPHABET[(value << (5 - bits)) & 0x1F];
    }
    // Pad to multiple of 8
    while (out.length % 8 !== 0) {
      out += '=';
    }
    return out;
  }

  decode(input: string): Uint8Array {
    // Strip trailing padding
    const stripped = input.replace(/=+$/, '');
    const rem = stripped.length % 8;
    if (!VALID_REMAINDERS.has(rem)) {
      throw new TypeError(
        `Invalid Base32 input length ${stripped.length} (mod 8 = ${rem}). ` +
        'Valid remainder values are 0, 2, 4, 5, 7.',
      );
    }

    const out: number[] = [];
    let bits = 0;
    let value = 0;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped.charCodeAt(i);
      const v = ch < 256 ? DECODE_TABLE[ch] : -1;
      if (v === -1) {
        throw new TypeError(
          `Invalid Base32 character '${stripped[i]}' at position ${i}`,
        );
      }
      value = (value << 5) | (v as number);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >> bits) & 0xFF);
      }
    }
    return new Uint8Array(out);
  }
}
