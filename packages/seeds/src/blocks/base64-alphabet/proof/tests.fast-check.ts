// SPDX-License-Identifier: MIT
// Property tests for the base64-alphabet block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// Test IDs declared in spec.yak:
//   base64-empty
//   base64-standard-known
//   base64-url-safe-known
//   base64-output-length
//   base64-invalid-length
//   base64-byte-out-of-range
//   base64-all-zeros
//   base64-all-255

// Re-export implementation so runners importing this artifact directly
// can access the block functions.
export * from "../impl.js";
