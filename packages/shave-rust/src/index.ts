// SPDX-License-Identifier: Apache-2.0
//
// @yakcc/shave-rust -- Rust raise adapter for the TS-subset IR (WI-868).
//
// Slice 1: scaffold + syn-subprocess seam + function-signature surface.
// Slice 2: body raiser + purity inference + full error taxonomy integration.
//
// @decision DEC-POLYGLOT-RUST-001 (WI-868)
// @title shave-rust is the Rust raise adapter, mirroring shave-go architecture
// @status accepted (WI-868 slice 1)
// @rationale
//   The polyglot raise architecture (ADR Q2) requires one adapter package per
//   source language.  shave-rust follows the same structure as shave-go (#870)
//   and shave-python (#782): a subprocess seam (syn via `cargo run`) gates all
//   Rust toolchain concerns, tests run in pure-Node CI via a mockable SpawnImpl,
//   and the public API is stable across slices.  Using syn (the canonical Rust
//   AST library) rather than a Node native addon keeps the dependency footprint
//   minimal and the CI matrix simple.  The subprocess seam is intentionally
//   stateless per-file in the MVP; daemonization is deferred to a later slice
//   once corpus benchmarks justify it.
//
//   Key Rust-specific difference from shave-go: identifier normalization is
//   non-trivial — Rust uses snake_case where the TS-subset IR expects camelCase.
//   name-normalize.ts handles this conversion.

export {
  AdapterSubprocessError,
  parseRustSource,
  type RustAstFunction,
  type RustAstParam,
  type RustAstParseOptions,
  type RustAstParseResult,
  type SpawnImpl,
} from "./rust-ast-parser.js";
export {
  extractFunctionSignatures,
  SignatureRaiseError,
  type FunctionSignature,
  type RaisedParam,
} from "./parse-fn-signature.js";
export { mapRustType, UnsupportedTypeError } from "./type-map.js";
export { normalizeRustName, isPublic, InvalidIdentifierError } from "./name-normalize.js";
export {
  RustAmbiguousPurityError,
  RustAsyncError,
  RustClosureCaptureError,
  RustDynTraitError,
  RustRawPointerError,
  RustUnsafeError,
  RustUnsupportedConstructError,
  type SourceLocation,
} from "./errors.js";
export {
  renderFunctionDeclaration,
  renderSignatureType,
} from "./raise-function.js";
