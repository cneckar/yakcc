// SPDX-License-Identifier: MIT
// Property tests for the queue-drain block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// Test IDs declared in spec.yak:
//   queue-drain-linear
//   queue-drain-empty
//   queue-drain-single
//   queue-drain-diamond
//   queue-drain-cycle-detected
//   queue-drain-parallel

// Re-export implementation so runners importing this artifact directly
// can access the block functions.
export * from "../impl.js";
