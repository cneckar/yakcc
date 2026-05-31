// SPDX-License-Identifier: MIT
// @yakcc/compile-go -- Go lower adapter for TS-subset IR atoms.
// Part of the polyglot architecture (WI-871-compile-go, compile-go MVP).
//
// @decision DEC-POLYGLOT-GO-COMPILE-001
// @title compile-go is the IR->Go lower adapter, mirroring compile-python (#783).
// @status decided
// @rationale
//   The polyglot architecture (MASTER_PLAN.md polyglot section) adds per-language
//   adapter packages that lower the TS-subset IR to target languages. compile-python
//   (#783) established the pattern: a canLowerTo() static gate + a lower() emitter.
//   This package is the Go analogue. Slice 1 ships canLowerTo() only -- the
//   compileToGo() emitter was added in WI-973 (compile-go MVP, #973).
//
//   canLowerTo() is the lowerability authority: it gates the discovery pipeline
//   and prevents atoms with unsupported Go constructs from reaching the emitter.
//   compileToGo() is the emitter: it lowers the TS-subset IR to idiomatic Go.
//
//   Supported surface (inverse of blocker set -- mirrors shave-go MVP):
//     number, string, boolean, Error, unknown, T[], Record<string,V>, *T,
//     return/expr/assign/decl stmts, limited binary/unary ops, for-of (range).
//
//   Blocker surface (Slice 1 error taxonomy seed):
//     bigint, union types (A|B), async/Promise/await,
//     function-typed values / higher-order closures.
//     (Note: generics are SUPPORTED from WI-973 onwards.)

export type { CanLowerResult, TargetLanguage } from "./can-lower-to.js";
export { canLowerTo } from "./can-lower-to.js";
export type { GoCompileResult, CompileGoOptions } from "./compile-go.js";
export { compileToGo } from "./compile-go.js";
export type { LowerResult, GoLowerWarning } from "./lower.js";
export { lowerSource, lowerTypeNode } from "./lower.js";
export { toGoExportedName, toGoLocalName } from "./names.js";
