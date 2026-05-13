// SPDX-License-Identifier: MIT
//
// @decision DEC-V0-B4-SEED-base64-alphabet-001
// @title base64-alphabet: RFC 4648 alphabet map and bit-shift encoder
// @status accepted
// @rationale
//   The base64-encode B4 task requires a standard base64 encoder that handles
//   both standard (RFC 4648 Section 4) and URL-safe (Section 5) alphabets.
//   This atom implements the core alphabet lookup and bit-extraction loop.
//
//   Design decisions:
//   (A) BIT EXTRACTION ORDER: Each 3-byte group (b0, b1, b2 = 24 bits) is
//       split into four 6-bit chunks in MSB-first order:
//         i0 = b0 >> 2
//         i1 = ((b0 & 0x3) << 4) | (b1 >> 4)
//         i2 = ((b1 & 0xf) << 2) | (b2 >> 6)
//         i3 = b2 & 0x3f
//       This is the normative bit ordering from RFC 4648 Section 3.
//
//   (B) PADDING EXCLUDED: The '=' padding character is not appended by this
//       atom. The B4 task's caller is expected to manage partial-block padding
//       (as per RFC 4648 Section 3.2). Excluding padding keeps the atom pure
//       and free of side-conditions about input length divisibility.
//       The precondition bytes.length % 3 === 0 is enforced with RangeError.
//
//   (C) CALLER-CONTROLLED URL-SAFE: A boolean flag selects between the two
//       alphabets rather than having two separate atoms, because they share
//       99% of their logic and the flag is a single conditional per output
//       (actually resolved once at function entry by selecting the alphabet
//       string). This keeps the corpus size down.
//
//   (D) MODULE-SCOPE CONST ALPHABETS: The two 64-character alphabet strings
//       are module-level constants. They satisfy the strict-subset validator
//       (const at top level is allowed) and are initialised once at module
//       load rather than on every call.
//
//   (E) noUncheckedIndexedAccess COMPLIANCE: The project tsconfig enables
//       noUncheckedIndexedAccess, which types arr[n] as T | undefined even
//       for loop variables proven safe by the loop bounds. Local variables
//       capture bytes[i], bytes[i+1], bytes[i+2] with ?? 0 fallbacks (the
//       out-of-range guard above makes these unreachable, but TypeScript
//       cannot prove that). RangeError validation precedes the fallback.
//
//   Reference: RFC 4648 (2006), "The Base16, Base32, and Base64 Data
//   Encodings", Sections 3, 4, and 5. https://www.rfc-editor.org/rfc/rfc4648

/** Standard RFC 4648 Section 4 base64 alphabet. */
const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** URL-safe RFC 4648 Section 5 base64 alphabet (+ -> -, / -> _). */
const URL_SAFE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encode a byte array to base64 using the RFC 4648 alphabet.
 *
 * Input length must be a multiple of 3. Padding ('=') is NOT appended;
 * the caller is responsible for padding partial input blocks.
 *
 * @param bytes   - Byte values, each in [0, 255]. Length must be % 3 === 0.
 * @param urlSafe - Use URL-safe alphabet (RFC 4648 Section 5) when true.
 * @returns Base64 encoded string without '=' padding.
 * @throws RangeError if bytes.length % 3 !== 0 or any byte is outside [0, 255].
 */
export function base64Encode(bytes: number[], urlSafe: boolean): string {
  if (bytes.length % 3 !== 0) {
    throw new RangeError(`base64Encode: input length must be a multiple of 3, got ${bytes.length}`);
  }

  const alphabet = urlSafe ? URL_SAFE_ALPHABET : STANDARD_ALPHABET;
  let result = "";

  for (let i = 0; i < bytes.length; i += 3) {
    // Capture with ?? 0: the loop bound (i < bytes.length) and length % 3 === 0 guarantee
    // bytes[i], bytes[i+1], bytes[i+2] are always defined here; ?? 0 is a TypeScript
    // appeasement for noUncheckedIndexedAccess and is never reached at runtime.
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;

    if (b0 > 255 || b1 > 255 || b2 > 255) {
      throw new RangeError(`base64Encode: byte value out of range [0, 255] at index ${i}`);
    }

    // Extract four 6-bit groups from three 8-bit bytes (MSB-first, RFC 4648 Section 3)
    const i0 = (b0 >> 2) & 0x3f;
    const i1 = ((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f);
    const i2 = ((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03);
    const i3 = b2 & 0x3f;

    // alphabet[n] is string | undefined per noUncheckedIndexedAccess.
    // Indices i0-i3 are in [0, 63] by construction (6-bit values), and alphabet
    // has exactly 64 characters, so these lookups always succeed.
    result +=
      (alphabet[i0] ?? "") + (alphabet[i1] ?? "") + (alphabet[i2] ?? "") + (alphabet[i3] ?? "");
  }

  return result;
}
