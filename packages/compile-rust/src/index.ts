// SPDX-License-Identifier: Apache-2.0
// @yakcc/compile-rust -- Rust lower adapter for TS-subset IR atoms.
// Part of the polyglot architecture (WI-869-compile-rust, Slice 1).
//
// @decision DEC-POLYGLOT-RUST-COMPILE-001
// @title compile-rust is the IR->Rust lower adapter, mirroring compile-go (#871) and compile-python (#783).
// @status decided (Slice 1)
// @rationale
//   The polyglot architecture (MASTER_PLAN.md polyglot section) adds per-language
//   adapter packages that lower the TS-subset IR to target languages. compile-python
//   (#783) and compile-go (#871) established the pattern: a canLowerTo() static gate
//   + a lower() emitter + rustfmt pretty-print seam.
//   This package is the Rust analogue. Slice 1 ships:
//     - canLowerTo() static gate (the lowerability authority for "rs" target)
//     - lowerSource() emitter (IR AST -> Rust lines via ts-morph walk)
//     - compileToRust() entry point (canLowerTo gate + lower + rustfmt)
//     - rustfmt injectable-spawn seam (pure-Node tests with no toolchain)
//     - names.ts (camelCase -> snake_case; inverse of shave-rust name-normalize)
//     - errors.ts (>=5-class error taxonomy; local in Slice 1, contracts in Slice 2)
//
//   canLowerTo() is the lowerability authority: it gates the discovery pipeline
//   and prevents atoms with unsupported Rust constructs from reaching the emitter.
//   compileToRust() is the emitter: it lowers the TS-subset IR to idiomatic Rust.
//
//   Supported surface (Slice 1 MVP):
//     number->i32, string->String, boolean->bool, T[]->Vec<T>,
//     return/const-let/if-else stmts, binary/unary ops, calls, property access.
//
//   Blocker surface (Slice 1 error taxonomy seed):
//     async/Promise/await (BLOCKER-RUST-001),
//     generics (BLOCKER-RUST-002),
//     bigint (BLOCKER-RUST-003),
//     union types A|B (BLOCKER-RUST-004),
//     function-typed values / closures (BLOCKER-RUST-005).

export type { CanLowerResult, TargetLanguage } from "./can-lower-to.js";
export { canLowerTo } from "./can-lower-to.js";
export type { RustCompileResult, CompileRustOptions } from "./compile-rust.js";
export { compileToRust } from "./compile-rust.js";
export type { RustLowerResult, RustLowerWarning } from "./lower.js";
export { lowerSource, lowerTypeNode } from "./lower.js";
export { toRustSnakeCase, toRustFunctionName, toRustLocalName } from "./names.js";
export {
  type SpawnImpl,
  type RustfmtOptions,
  RustfmtError,
  formatWithRustfmt,
  identityRustfmtSpawn,
} from "./rustfmt.js";
export {
  CannotLowerToRustError,
  RustUnsupportedTypeError,
  RustUnsupportedExprError,
  RustUnsupportedStmtError,
  RustAsyncError,
  RustGenericError,
} from "./errors.js";
