// SPDX-License-Identifier: MIT
// Property tests for the memoize block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// Test IDs declared in spec.yak:
//   memoize-returns-same-value
//   memoize-calls-fn-once
//   memoize-different-keys-call-fn
//   memoize-cache-hit-identity
//   memoize-exception-not-cached

// Re-export implementation so runners importing this artifact directly
// can access the block functions.
export * from "../impl.js";
