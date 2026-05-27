// SPDX-License-Identifier: MIT
//
// @yakcc/shave-python — Python raise adapter (WI-782).
//
// Slice 2 of 4: typed function signature extraction + Python → TS type mapping.
// The exported API now includes the libcst subprocess wrapper (slice 1) plus
// the signature extractor and type-map helpers.  Body translation, purity
// inference, and end-to-end raise come in slices 2b, 3, and 4.

export {
  AdapterSubprocessError,
  parsePythonSource,
  type LibcstParseOptions,
  type LibcstParseResult,
  type PythonAstNode,
} from "./libcst-parser.js";
export {
  extractFunctionSignatures,
  MissingTypeAnnotationError,
  type FunctionSignature,
  type RaisedParam,
} from "./parse-fn-signature.js";
export { mapPythonType, UnsupportedTypeError } from "./type-map.js";
