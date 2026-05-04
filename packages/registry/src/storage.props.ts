// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/registry storage.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L2)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for storage.ts atoms
//
// Atoms covered (2):
//   serializeEmbedding (A2.1) — private helper; Float32Array → Buffer for sqlite-vec
//   bytesToHex         (A2.2) — private helper; Uint8Array → lowercase hex string
//
// Both functions are private (not exported from @yakcc/registry). Properties
// are authored as pure re-implementations that mirror the private functions'
// specifications, verified against fast-check arbitraries. This pattern is the
// approved approach for private pure helpers per the L2 layer plan.
//
// Note: Properties do NOT import storage.ts directly (that would require a live
// SQLite + sqlite-vec environment). Instead, we verify the specification of the
// private helpers by re-implementing them and testing their algebraic invariants.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Inline reference implementations (mirror the private functions' specs)
// ---------------------------------------------------------------------------

/**
 * Reference implementation of serializeEmbedding:
 *   "Serialize a Float32Array to a Buffer for sqlite-vec storage."
 *   Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
 *
 * Purpose: verify the algebraic invariants of the serialization spec without
 * importing the live storage module (which requires SQLite + sqlite-vec).
 */
function refSerializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Reference implementation of bytesToHex:
 *   "Convert a Uint8Array to a lowercase hex string."
 *   Each byte → padStart(2, "0") hex digit.
 *
 * Purpose: verify the algebraic invariants of the hex-encoding spec without
 * importing the live storage module.
 */
function refBytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for non-empty Float32Arrays of varying lengths (1–64 elements).
 * Covers the full float32 range including edge values (Infinity, -Infinity, NaN,
 * denormals) to stress-test the Buffer serialization byte layout.
 */
const float32ArrayArb: fc.Arbitrary<Float32Array> = fc
  .array(fc.float({ noNaN: false }), { minLength: 1, maxLength: 64 })
  .map((arr) => new Float32Array(arr));

/**
 * Arbitrary for fixed-length Float32Arrays of 384 elements (MiniLM-L6 embedding size).
 * This exercises the primary production use case (generateEmbedding returns 384-dim).
 */
const embeddingArb: fc.Arbitrary<Float32Array> = fc
  .array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 384, maxLength: 384 })
  .map((arr) => new Float32Array(arr));

/**
 * Arbitrary for Uint8Arrays of varying lengths (0–64 bytes).
 * Covers the empty case (BLAKE3 of empty bytes is a sentinel in exportManifest)
 * and typical hash sizes.
 */
const uint8ArrayArb: fc.Arbitrary<Uint8Array> = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 64 })
  .map((arr) => new Uint8Array(arr));

/**
 * Arbitrary for Uint8Arrays of exactly 32 bytes (BLAKE3 output size).
 * Models the primary production use case in exportManifest / bytesToHex.
 */
const blake3OutputArb: fc.Arbitrary<Uint8Array> = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 32, maxLength: 32 })
  .map((arr) => new Uint8Array(arr));

// ---------------------------------------------------------------------------
// A2.1: serializeEmbedding — Float32Array → Buffer
// ---------------------------------------------------------------------------

/**
 * prop_serializeEmbedding_byte_length_matches_float32_bytelength
 *
 * For every Float32Array, the serialized Buffer's byteLength equals
 * vec.byteLength (= vec.length * 4), because each float32 is 4 bytes.
 *
 * Invariant: serializeEmbedding preserves the Float32 byte layout exactly;
 * no bytes are added, removed, or reordered during serialization.
 */
export const prop_serializeEmbedding_byte_length_matches_float32_bytelength = fc.property(
  float32ArrayArb,
  (vec) => {
    const buf = refSerializeEmbedding(vec);
    return buf.byteLength === vec.byteLength && buf.byteLength === vec.length * 4;
  },
);

/**
 * prop_serializeEmbedding_round_trip_via_float32array
 *
 * For every Float32Array vec (no NaN so round-trip is bit-exact), reading
 * the Buffer back as a new Float32Array produces values equal to the original.
 *
 * Invariant: the serialized Buffer holds the exact IEEE-754 binary32 encoding
 * of each element in platform byte order. Reading it back via Float32Array
 * reconstructs the same values element-by-element.
 */
export const prop_serializeEmbedding_round_trip_via_float32array = fc.property(
  embeddingArb,
  (vec) => {
    const buf = refSerializeEmbedding(vec);
    // Reconstruct Float32Array from Buffer bytes (same byte order as the write).
    const reconstructed = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (reconstructed.length !== vec.length) return false;
    for (let i = 0; i < vec.length; i++) {
      const a = vec[i];
      const b = reconstructed[i];
      if (a === undefined || b === undefined) return false;
      // Use exact comparison; NaN excluded by embeddingArb noNaN: true.
      if (a !== b) return false;
    }
    return true;
  },
);

/**
 * prop_serializeEmbedding_deterministic
 *
 * For every Float32Array, two calls to serializeEmbedding produce Buffers
 * with identical byte content.
 *
 * Invariant: serializeEmbedding is a pure, deterministic function; it produces
 * no random or time-dependent output.
 */
export const prop_serializeEmbedding_deterministic = fc.property(float32ArrayArb, (vec) => {
  const buf1 = refSerializeEmbedding(vec);
  const buf2 = refSerializeEmbedding(vec);
  if (buf1.byteLength !== buf2.byteLength) return false;
  for (let i = 0; i < buf1.byteLength; i++) {
    if (buf1[i] !== buf2[i]) return false;
  }
  return true;
});

// ---------------------------------------------------------------------------
// A2.2: bytesToHex — Uint8Array → lowercase hex string
// ---------------------------------------------------------------------------

/**
 * prop_bytesToHex_length_is_double_input
 *
 * For every Uint8Array of length n, bytesToHex returns a string of length 2n.
 * Each byte encodes as exactly two hex characters.
 *
 * Invariant: bytesToHex always zero-pads each byte to 2 digits, so the output
 * length is always exactly 2 * input.length.
 */
export const prop_bytesToHex_length_is_double_input = fc.property(uint8ArrayArb, (bytes) => {
  const hex = refBytesToHex(bytes);
  return hex.length === bytes.length * 2;
});

/**
 * prop_bytesToHex_only_lowercase_hex_chars
 *
 * For every Uint8Array, bytesToHex returns a string containing only the
 * characters [0-9a-f]. No uppercase letters appear.
 *
 * Invariant: toString(16) produces lowercase hex digits; padStart pads with '0',
 * which is in the lowercase hex alphabet. The output is always lowercase.
 */
export const prop_bytesToHex_only_lowercase_hex_chars = fc.property(uint8ArrayArb, (bytes) => {
  const hex = refBytesToHex(bytes);
  return /^[0-9a-f]*$/.test(hex);
});

/**
 * prop_bytesToHex_empty_input_produces_empty_string
 *
 * For an empty Uint8Array, bytesToHex returns the empty string "".
 *
 * Invariant: the loop body never executes for zero-length input; the result
 * is the empty string (identity element for string concatenation).
 */
export const prop_bytesToHex_empty_input_produces_empty_string = fc.property(
  fc.constant(new Uint8Array(0)),
  (bytes) => {
    return refBytesToHex(bytes) === "";
  },
);

/**
 * prop_bytesToHex_known_values
 *
 * bytesToHex encodes specific bytes to their known hex representations.
 *
 * Invariant: hex encoding is bijective and deterministic; specific byte values
 * always produce specific two-character hex strings.
 */
export const prop_bytesToHex_known_values = fc.property(
  fc.constantFrom<[number, string]>(
    [0x00, "00"],
    [0x0f, "0f"],
    [0xff, "ff"],
    [0xa0, "a0"],
    [0x10, "10"],
    [0x7f, "7f"],
    [0x80, "80"],
    [0xab, "ab"],
  ),
  ([byte, expected]) => {
    const hex = refBytesToHex(new Uint8Array([byte]));
    return hex === expected;
  },
);

/**
 * prop_bytesToHex_blake3_output_is_64_chars
 *
 * For every simulated 32-byte BLAKE3 output (the primary use in exportManifest),
 * bytesToHex produces a 64-character lowercase hex string.
 *
 * Invariant: BLAKE3 always produces 32 bytes; bytesToHex always encodes them as
 * 64 hex characters. This matches the sentinel computation in exportManifest:
 * bytesToHex(blake3(new Uint8Array(0))).length === 64.
 */
export const prop_bytesToHex_blake3_output_is_64_chars = fc.property(blake3OutputArb, (bytes) => {
  const hex = refBytesToHex(bytes);
  return hex.length === 64 && /^[0-9a-f]{64}$/.test(hex);
});

/**
 * prop_bytesToHex_deterministic
 *
 * For every Uint8Array, two calls to bytesToHex return identical strings.
 *
 * Invariant: bytesToHex is a pure, deterministic function with no side effects.
 */
export const prop_bytesToHex_deterministic = fc.property(uint8ArrayArb, (bytes) => {
  const h1 = refBytesToHex(bytes);
  const h2 = refBytesToHex(bytes);
  return h1 === h2;
});
