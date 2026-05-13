// SPDX-License-Identifier: MIT
// Property tests for the lru-node block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// Test IDs declared in spec.yak:
//   lru-node-key-stored
//   lru-node-value-stored
//   lru-node-prev-null
//   lru-node-next-null
//   lru-node-independent
//   lru-node-mutable-prev

// Re-export implementation so runners importing this artifact directly
// can access the block functions.
export * from "../impl.js";
