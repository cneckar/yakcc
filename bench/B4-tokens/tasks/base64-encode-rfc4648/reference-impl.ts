// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/base64-encode-rfc4648/reference-impl.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 task corpus: base64-encode-rfc4648 reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves oracle tests correctly
//   distinguish RFC-compliant from hallucinated-alphabet implementations. Hand-written;
//   not LLM-generated (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   Adversarial trap: alphabet must be exactly RFC 4648 §4 (index 62='+', index 63='/').
//   URL-safe variant (§5): replace '+' with '-' and '/' with '_'. Common failure:
//   swapping standard and URL-safe alphabets, or applying URL-safe by default.

export interface Base64EncodeOptions {
  padding?: boolean;   // default: true
  urlSafe?: boolean;   // default: false
}

// RFC 4648 §4 standard alphabet
const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// RFC 4648 §5 URL-safe alphabet (replaces +62 with - and /63 with _)
const URLSAFE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encode a Uint8Array to a Base64 string per RFC 4648.
 *
 * @param input - Raw bytes to encode
 * @param options - Encoding options (padding and alphabet variant)
 * @returns Base64-encoded string
 */
export function base64Encode(input: Uint8Array, options?: Base64EncodeOptions): string {
  const padding = options?.padding !== false; // default: true
  const urlSafe = options?.urlSafe === true;  // default: false
  const alphabet = urlSafe ? URLSAFE_ALPHABET : STANDARD_ALPHABET;

  if (input.length === 0) return "";

  let result = "";
  const len = input.length;

  // Process 3-byte groups
  for (let i = 0; i < len; i += 3) {
    const b0 = input[i]!;
    const b1 = i + 1 < len ? input[i + 1]! : 0;
    const b2 = i + 2 < len ? input[i + 2]! : 0;

    // Pack 3 bytes into a 24-bit integer
    const triple = (b0 << 16) | (b1 << 8) | b2;

    // Extract 4 6-bit indices
    const c0 = (triple >> 18) & 0x3f;
    const c1 = (triple >> 12) & 0x3f;
    const c2 = (triple >> 6) & 0x3f;
    const c3 = triple & 0x3f;

    const remaining = len - i;

    if (remaining >= 3) {
      // Full group: 4 characters
      result += alphabet[c0]! + alphabet[c1]! + alphabet[c2]! + alphabet[c3]!;
    } else if (remaining === 2) {
      // 2 remaining bytes → 3 chars + optional padding
      result += alphabet[c0]! + alphabet[c1]! + alphabet[c2]!;
      if (padding) result += "=";
    } else {
      // 1 remaining byte → 2 chars + optional padding
      result += alphabet[c0]! + alphabet[c1]!;
      if (padding) result += "==";
    }
  }

  return result;
}
