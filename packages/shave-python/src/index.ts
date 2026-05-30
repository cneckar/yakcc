// SPDX-License-Identifier: MIT
//
// @yakcc/shave-python — Python raise adapter (WI-782).
//
// Slice 4 of 4 (final): full MVP mapping table (IfExp, LenCall, ListComp,
// Raise, Call, UnaryOp), CannotRaiseToIRError taxonomy unification,
// integration test suite, and polyglot-py.yml CI workflow.
// Closes #782.

export {
  AdapterSubprocessError,
  parsePythonSource,
  type LibcstParseOptions,
  type LibcstParseResult,
  type PythonAstNode,
} from "./libcst-parser.js";
export {
  extractFunctionSignatures,
  extractClassEnvelopes,
  MissingTypeAnnotationError,
  type FunctionSignature,
  type MethodKind,
  type RaisedParam,
  type EnvelopeClass,
  type EnvelopeMethod,
  type EnvelopeInitParam,
  type EnvelopeInitAssignment,
  type EnvelopeClassVar,
} from "./parse-fn-signature.js";
export {
  mapPythonType,
  UnsupportedTypeError,
  type LowerWarning,
  type MapPythonTypeResult,
} from "./type-map.js";
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
export { raiseClass, type RaisedClass } from "./raise-class.js";
