// SPDX-License-Identifier: MIT
// @yakcc/compile-python — Python lower adapter for TS-subset IR atoms.
// Part of the polyglot architecture (WI-POLYGLOT-COMPILE-PY-MVP, ADR Q3).

export type { CanLowerResult, TargetLanguage } from "./can-lower-to.js";
export { canLowerTo } from "./can-lower-to.js";
export type { CompilePythonOptions } from "./compile-python.js";
export { compileToPython } from "./compile-python.js";
export { classMethToSnake, toSnakeCase } from "./names.js";
export type { LowerWarning, PythonCompileResult } from "./types.js";
