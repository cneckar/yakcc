// SPDX-License-Identifier: MIT
// Vitest harness for storage.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling storage.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_bytesToHex_blake3_output_is_64_chars,
  prop_bytesToHex_deterministic,
  prop_bytesToHex_empty_input_produces_empty_string,
  prop_bytesToHex_known_values,
  prop_bytesToHex_length_is_double_input,
  prop_bytesToHex_only_lowercase_hex_chars,
  prop_serializeEmbedding_byte_length_matches_float32_bytelength,
  prop_serializeEmbedding_deterministic,
  prop_serializeEmbedding_round_trip_via_float32array,
} from "./storage.props.js";

// serializeEmbedding/bytesToHex are pure in-memory functions.
// numRuns: 100 exercises the full arbitrary domain sufficiently.
const opts = { numRuns: 100 };

it("property: prop_serializeEmbedding_byte_length_matches_float32_bytelength", () => {
  fc.assert(prop_serializeEmbedding_byte_length_matches_float32_bytelength, opts);
});

it("property: prop_serializeEmbedding_round_trip_via_float32array", () => {
  fc.assert(prop_serializeEmbedding_round_trip_via_float32array, opts);
});

it("property: prop_serializeEmbedding_deterministic", () => {
  fc.assert(prop_serializeEmbedding_deterministic, opts);
});

it("property: prop_bytesToHex_length_is_double_input", () => {
  fc.assert(prop_bytesToHex_length_is_double_input, opts);
});

it("property: prop_bytesToHex_only_lowercase_hex_chars", () => {
  fc.assert(prop_bytesToHex_only_lowercase_hex_chars, opts);
});

it("property: prop_bytesToHex_empty_input_produces_empty_string", () => {
  fc.assert(prop_bytesToHex_empty_input_produces_empty_string, opts);
});

it("property: prop_bytesToHex_known_values", () => {
  fc.assert(prop_bytesToHex_known_values, opts);
});

it("property: prop_bytesToHex_blake3_output_is_64_chars", () => {
  fc.assert(prop_bytesToHex_blake3_output_is_64_chars, opts);
});

it("property: prop_bytesToHex_deterministic", () => {
  fc.assert(prop_bytesToHex_deterministic, opts);
});
