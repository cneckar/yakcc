// SPDX-License-Identifier: MIT
// @decision DEC-IR-FACADE-V0: The v0 IR exposes typed interfaces and opaque
// AST types with facade implementations that accept all input as valid.
// Status: superseded — WI-T02 replaced the inline-CONTRACT path (annotations.ts,
// parseBlock) with the directory-based block authoring path (parseBlockTriplet).
// The barrel re-exports the new public API surface. The old parseBlock and all
// annotation symbols are deleted per Sacred Practice #12 (single source of truth).
// Rationale: Downstream packages need a stable API surface; the barrel is the
// single import point.

export type { ContractId } from "@yakcc/contracts";

// Strict-subset validator
export type { ValidationError, ValidationResult } from "./strict-subset.js";
export {
  runAllRules,
  validateStrictSubset,
  validateStrictSubsetFile,
} from "./strict-subset.js";

// Block parser (directory-based triplet authoring — replaces inline-CONTRACT parseBlock)
export type {
  BlockTripletParseResult,
  ParseBlockTripletOptions,
  SubBlockRef,
} from "./block-parser.js";
export { parseBlockTriplet } from "./block-parser.js";

// Project-mode strict-subset validator (WI-V2-01)
export type { ProjectValidationResult } from "./strict-subset-project.js";
export { validateStrictSubsetProject } from "./strict-subset-project.js";
