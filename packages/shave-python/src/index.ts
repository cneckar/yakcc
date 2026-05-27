// SPDX-License-Identifier: MIT
//
// @yakcc/shave-python — Python raise adapter (WI-782).
//
// Slice 1 of 4: package scaffolding + libcst subprocess primitive.
// The exported API surface is the subprocess wrapper and its types only;
// AST → IR mapping, purity inference, and end-to-end raise come in slices 2–4.
//
// @decision DEC-POLYGLOT-IR-CANONICAL-001 (parent — polyglot architecture ADR)
// @decision DEC-POLYGLOT-IR-ENVELOPE-001 (held-the-line; this adapter throws
//   CannotRaiseToIRError from @yakcc/contracts for out-of-envelope Python
//   constructs — wired in slice 4)

export {
  AdapterSubprocessError,
  parsePythonSource,
  type LibcstParseOptions,
  type LibcstParseResult,
  type PythonAstNode,
} from "./libcst-parser.js";
