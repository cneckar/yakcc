// SPDX-License-Identifier: MIT
// Property tests for the semver-component-parser block.
// These tests exercise the contract declared in ../spec.yak against the
// implementation in ../impl.ts.
//
// Test IDs declared in spec.yak:
//   semver-simple
//   semver-prerelease
//   semver-build
//   semver-prerelease-and-build
//   semver-zeros
//   semver-large-numbers
//   semver-invalid-no-dots
//   semver-invalid-non-numeric
//   semver-empty

// Re-export implementation so runners importing this artifact directly
// can access the block functions.
export * from "../impl.js";
