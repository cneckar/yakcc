// SPDX-License-Identifier: MIT
//
// @yakcc/shave-go -- Go raise adapter for the TS-subset IR (WI-870).
//
// Slice 1 of N: scaffold + go/ast subprocess seam + function-signature surface.
// Purity inference, function-body raise, and init routing come in slices 2/3.
//
// @decision DEC-POLYGLOT-GO-001 (WI-870)
// @title shave-go is the Go raise adapter, mirroring shave-python architecture
// @status accepted (WI-870 slice 1)
// @rationale
//   The polyglot raise architecture (ADR Q2) requires one adapter package per
//   source language.  shave-go follows the same structure as shave-python
//   (#782): a subprocess seam (go/ast via `go run`) gates all Go toolchain
//   concerns, tests run in pure-Node CI via a mockable SpawnImpl, and the
//   public API is stable across slices.  Using go/ast (stdlib) rather than a
//   Node native addon keeps the dependency footprint minimal and the CI matrix
//   simple.  The subprocess seam is intentionally stateless per-file in the
//   MVP; daemonization is deferred to a later slice once corpus benchmarks
//   justify it.

export {
  AdapterSubprocessError,
  parseGoSource,
  type GoAstFunction,
  type GoAstParam,
  type GoAstParseOptions,
  type GoAstParseResult,
  type GoAstTypeParam,
  type SpawnImpl,
} from "./go-ast-parser.js";
export {
  extractFunctionSignatures,
  SignatureRaiseError,
  type FunctionSignature,
  type RaisedParam,
  type RaisedTypeParam,
} from "./parse-fn-signature.js";
export { mapGoType, UnsupportedTypeError } from "./type-map.js";
export { normalizeGoName, isExported, InvalidIdentifierError } from "./name-normalize.js";
