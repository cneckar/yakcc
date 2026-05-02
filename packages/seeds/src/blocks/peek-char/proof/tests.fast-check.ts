// SPDX-License-Identifier: MIT
// Property tests for the peek-char block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// The definitive property-test corpus lives in the parent seed package's
// seed.test.ts (Suite 4: "property-test corpora"). This file satisfies the
// L0 proof/manifest.json "property_tests" artifact requirement and makes
// the test IDs declared in spec.yak traceable to this directory.
//
// Test IDs declared in spec.yak:
//   peek-char-first
//   peek-char-eof
//   peek-char-negative
//   peek-char-empty-input
//   peek-char-last

// Re-export the implementation so runners importing this artifact directly
// can access the block function.
export * from "../impl.js";
