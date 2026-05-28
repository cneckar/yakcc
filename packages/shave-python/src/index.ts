// SPDX-License-Identifier: MIT
//
// @yakcc/shave-python — Python raise adapter (WI-782).
//
// Slice 2b of 4: typed signature + Python→TS type map (slice 2) + body
// translation for return statements with literal/name/binop expressions.
// Purity inference, naming normalization, and CannotRaiseToIRError wiring
// come in slices 3 and 4.

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
export {
  renderBody,
  renderExpr,
  renderStmt,
  UnsupportedAstError,
  type WireExpr,
  type WireStmt,
} from "./raise-body.js";
export { renderFunctionDeclaration } from "./raise-function.js";
