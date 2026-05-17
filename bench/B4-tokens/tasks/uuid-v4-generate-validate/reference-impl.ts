// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/uuid-v4-generate-validate/reference-impl.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 task corpus: uuid-v4-generate-validate reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves the oracle correctly
//   distinguishes RFC 4122-conformant UUID generators from broken ones. Hand-written
//   from RFC 4122 §4.4 specification; not LLM-generated or copied from the uuid npm
//   package (per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   WI-510 atom backing: uuid Slice 4 — v4.js (generation) and validate.js (validation).
//   The benchmark tests whether the hooked LLM arm substitutes these shaved atoms
//   rather than regenerating the byte-manipulation from scratch.
//
//   Adversarial traps exercised by the oracle:
//   1. Math.random() vs crypto.randomBytes — distribution test over 10000 samples
//   2. Version nibble at hex position 12 (byte 6 high nibble) must be '4'
//   3. Variant nibble at hex position 16 (byte 8 high bits) must be 8/9/a/b
//   4. validateV4 must reject uppercase, wrong dash positions, wrong nibbles
//   5. NIL UUID (all zeros) is a valid UUID (version nibble = 0, variant nibble = 0)

import { randomBytes } from "node:crypto";

/**
 * Generate a cryptographically random RFC 4122 version-4 UUID.
 *
 * Structure: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * - All x: random hex digits (lowercase)
 * - Character at index 14 in the output string: version nibble = '4'
 * - Character at index 19 in the output string: variant nibble in {8,9,a,b}
 *
 * @returns A 36-character UUID string in canonical lowercase form.
 */
export function generateV4(): string {
  // 16 random bytes = 128 bits
  const bytes = randomBytes(16);

  // Set version bits: byte 6 high nibble = 0100 (version 4)
  // Buffer.from(randomBytes()) guarantees all 16 bytes are defined; index safety is certain.
  // biome-ignore lint/style/noNonNullAssertion: Buffer index always defined for 16-byte buffer
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;

  // Set variant bits: byte 8 high two bits = 10 (RFC 4122 variant)
  // biome-ignore lint/style/noNonNullAssertion: Buffer index always defined for 16-byte buffer
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  // Convert to hex string and insert dashes at canonical positions
  const hex = bytes.toString("hex");
  const b0 = hex.slice(0, 8);
  const b1 = hex.slice(8, 12);
  const b2 = hex.slice(12, 16);
  const b3 = hex.slice(16, 20);
  const b4 = hex.slice(20, 32);
  return `${b0}-${b1}-${b2}-${b3}-${b4}`;
}

// RFC 4122 canonical UUID regex:
// - 36 chars total
// - lowercase hex only
// - dashes at positions 8, 13, 18, 23
// - version nibble (index 14 in full string): 0-8
// - variant nibble (index 19 in full string): 0, 8, 9, a, b
//   (0 only valid for NIL UUID where all other nibbles are also 0)
//
// Note: We accept [089ab] at position 19 which covers NIL (0) and all
// RFC 4122 variant UUIDs (8,9,a,b). Variants c-f are Microsoft/NCS reserved.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Validate that `input` is a syntactically valid RFC 4122 UUID.
 *
 * Accepts all versions (v1–v8) and the NIL UUID (all zeros).
 * Only accepts the canonical lowercase 36-character form.
 * Rejects uppercase hex, URN prefix, curly braces, wrong nibble values.
 *
 * @param input - The string to validate
 * @returns true if `input` is a valid canonical UUID, false otherwise
 */
export function validateV4(input: string): boolean {
  if (typeof input !== "string") return false;
  return UUID_REGEX.test(input);
}
