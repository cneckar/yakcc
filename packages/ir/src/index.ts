// @decision DEC-IR-FACADE-V0: The v0 IR exposes typed interfaces and opaque
// AST types with facade implementations that accept all input as valid.
// Status: superseded — WI-004 delivered real implementations in strict-subset.ts,
// annotations.ts, and block-parser.ts. This barrel re-exports everything.
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

// Contract-annotation extractor
export type { ExtractionErrorKind } from "./annotations.js";
export {
  ContractExtractionError,
  EXTRACTION_ERROR_KIND,
  extractContract,
  extractContractFromAst,
} from "./annotations.js";

// Block parser
export type { Block, ParseBlockOptions, SubBlockReference } from "./block-parser.js";
export { parseBlock } from "./block-parser.js";

// Legacy type kept for downstream packages that imported BlockAst from WI-001 facade.
// This is a structural alias; WI-005 will replace it with the real AST node type.
export type BlockAst = { readonly __kind: "BlockAst"; readonly _raw: string };
