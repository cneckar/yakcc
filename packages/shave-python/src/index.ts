// SPDX-License-Identifier: MIT
//
// @yakcc/shave-python — Python raise adapter (WI-782).
//
// Slice 3 of 4: purity inference (static reject-list) + snake_case→camelCase
// identifier normalization wired into the raise pipeline.
// CannotRaiseToIRError reconciliation and pyright-based purity escalation
// come in slice 4.

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
export {
  ImpureFunctionError,
  renderFunctionDeclaration,
  raiseFunctionWithPurityAndNormalization,
} from "./raise-function.js";
export type { ImpurityKind } from "./purity-check.js";
export {
  checkPurity,
  checkFunctionPurity,
  checkModuleImports,
  FORBIDDEN_MODULES,
  FORBIDDEN_BUILTINS,
  FORBIDDEN_ATTRS,
} from "./purity-check.js";
export {
  normalizeIdentifier,
  normalizeSignatureNames,
  normalizeBodyNames,
  buildParamRenameMap,
  normalizeExprNames,
} from "./normalize-names.js";
