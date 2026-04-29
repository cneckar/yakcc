// @decision DEC-IR-ANNOT-001: Contract annotations are first-class IR syntax.
// Status: implemented (WI-004)
// Rationale: The dispatch spec requires contract metadata to be first-class IR
// syntax, not a comment convention or JSDoc tag. We achieve this by treating the
// `export const CONTRACT: ContractSpec = { ... }` declaration as a structurally
// recognized annotation. The extractor walks the AST to find that specific export,
// then evaluates its initializer as a literal object — refusing to eval arbitrary
// expressions, which would reintroduce the escape hatch the strict subset bans.

import type { ContractSpec } from "@yakcc/contracts";
import { Node, NodeFlags, Project, type SourceFile, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Error kinds
// ---------------------------------------------------------------------------

/** Enumeration of reasons contract extraction can fail on a malformed block. */
export const EXTRACTION_ERROR_KIND = {
  /** The source has no `export const CONTRACT` declaration. */
  MISSING_CONTRACT_EXPORT: "missing-CONTRACT-export",
  /** The CONTRACT export exists but its initializer is not a literal object expression. */
  CONTRACT_NOT_LITERAL: "CONTRACT-not-literal",
  /** The CONTRACT initializer is a literal but does not match the ContractSpec shape. */
  CONTRACT_SHAPE_INVALID: "CONTRACT-shape-invalid",
} as const;

export type ExtractionErrorKind =
  (typeof EXTRACTION_ERROR_KIND)[keyof typeof EXTRACTION_ERROR_KIND];

// ---------------------------------------------------------------------------
// ContractExtractionError
// ---------------------------------------------------------------------------

/**
 * Thrown when `extractContract` encounters a `CONTRACT` export that exists but
 * is not a valid literal `ContractSpec`.
 *
 * A missing CONTRACT export is *not* an error — `extractContract` returns `null`
 * in that case. An error is thrown only when the CONTRACT export is present but
 * malformed (non-literal initializer, missing required fields, wrong shape).
 */
export class ContractExtractionError extends Error {
  readonly kind: ExtractionErrorKind;

  constructor(kind: ExtractionErrorKind, message: string) {
    super(message);
    this.name = "ContractExtractionError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Internal: literal object evaluator
//
// Walks a ts-morph ObjectLiteralExpression and produces a plain JS object.
// Only handles: string literals, number literals, boolean literals,
// array literals (of the above), nested object literals, and null.
// Throws ContractExtractionError for anything else (call expressions, identifiers, etc.)
// ---------------------------------------------------------------------------

type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralValue[]
  | { [key: string]: LiteralValue };

function evalLiteralNode(node: Node): LiteralValue {
  // String literal
  if (Node.isStringLiteral(node)) {
    return node.getLiteralValue();
  }
  // Numeric literal
  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue();
  }
  // Boolean: true / false keywords
  if (node.getKind() === SyntaxKind.TrueKeyword) return true;
  if (node.getKind() === SyntaxKind.FalseKeyword) return false;
  // Null
  if (node.getKind() === SyntaxKind.NullKeyword) return null;
  // Array literal
  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().map(evalLiteralNode);
  }
  // Object literal
  if (Node.isObjectLiteralExpression(node)) {
    const result: { [key: string]: LiteralValue } = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        throw new ContractExtractionError(
          EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL,
          `CONTRACT initializer contains a non-property-assignment in an object literal (e.g. spread or shorthand): ${prop.getText()}`,
        );
      }
      const key = prop.getName();
      const valueNode = prop.getInitializer();
      if (valueNode === undefined) {
        throw new ContractExtractionError(
          EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL,
          `CONTRACT property "${key}" has no initializer`,
        );
      }
      result[key] = evalLiteralNode(valueNode);
    }
    return result;
  }
  // Anything else is not a literal
  throw new ContractExtractionError(
    EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL,
    `CONTRACT initializer contains a non-literal expression: ${node.getKindName()} — ${node.getText().slice(0, 60)}`,
  );
}

// ---------------------------------------------------------------------------
// Internal: ContractSpec shape validation
//
// We validate structural shape after literal evaluation, not via runtime
// property enumeration (which would be reflection). This is a whitelist check:
// required top-level keys must be present and have the right types.
// ---------------------------------------------------------------------------

function validateContractSpecShape(obj: LiteralValue): ContractSpec {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT must be an object literal",
    );
  }

  const required = [
    "inputs",
    "outputs",
    "behavior",
    "guarantees",
    "errorConditions",
    "nonFunctional",
    "propertyTests",
  ] as const;
  for (const key of required) {
    if (!(key in obj)) {
      throw new ContractExtractionError(
        EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
        `CONTRACT is missing required field: "${key}"`,
      );
    }
  }

  const { inputs, outputs, behavior, guarantees, errorConditions, nonFunctional, propertyTests } =
    obj as Record<string, LiteralValue>;

  if (!Array.isArray(inputs)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.inputs must be an array",
    );
  }
  if (!Array.isArray(outputs)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.outputs must be an array",
    );
  }
  if (typeof behavior !== "string") {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.behavior must be a string",
    );
  }
  if (!Array.isArray(guarantees)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.guarantees must be an array",
    );
  }
  if (!Array.isArray(errorConditions)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.errorConditions must be an array",
    );
  }
  if (typeof nonFunctional !== "object" || nonFunctional === null || Array.isArray(nonFunctional)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.nonFunctional must be an object",
    );
  }
  if (!Array.isArray(propertyTests)) {
    throw new ContractExtractionError(
      EXTRACTION_ERROR_KIND.CONTRACT_SHAPE_INVALID,
      "CONTRACT.propertyTests must be an array",
    );
  }

  // Cast is safe: we've verified all required fields have the right base types.
  // ContractSpec uses readonly arrays of typed objects; our literal evaluator
  // produces plain arrays of plain objects, which are structurally compatible.
  return obj as unknown as ContractSpec;
}

// ---------------------------------------------------------------------------
// Core extraction logic (shared between string and SourceFile entry points)
// ---------------------------------------------------------------------------

/**
 * Extract a ContractSpec from a ts-morph SourceFile.
 *
 * Looks for `export const CONTRACT: ContractSpec = { ... }` at the top level.
 * Returns the evaluated spec, or `null` if no such export exists.
 * Throws `ContractExtractionError` if CONTRACT exists but is malformed.
 */
export function extractContractFromAst(sourceFile: SourceFile): ContractSpec | null {
  for (const statement of sourceFile.getStatements()) {
    // Must be a variable statement
    if (!Node.isVariableStatement(statement)) continue;
    // Must be exported
    if (!statement.isExported()) continue;
    // Must be `const` — check via NodeFlags (Let=1, Const=2, var=0)
    const declListFlags = statement.getDeclarationList().getFlags();
    if ((declListFlags & NodeFlags.Const) === 0) continue;

    for (const decl of statement.getDeclarationList().getDeclarations()) {
      if (decl.getName() !== "CONTRACT") continue;

      // Found the CONTRACT export. Now evaluate its initializer.
      const initializer = decl.getInitializer();
      if (initializer === undefined) {
        throw new ContractExtractionError(
          EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL,
          "CONTRACT export has no initializer",
        );
      }

      // Must be an object literal — reject function calls, identifiers, etc.
      if (!Node.isObjectLiteralExpression(initializer)) {
        throw new ContractExtractionError(
          EXTRACTION_ERROR_KIND.CONTRACT_NOT_LITERAL,
          `CONTRACT initializer must be an object literal; got: ${initializer.getKindName()} — "${initializer.getText().slice(0, 60)}"`,
        );
      }

      const evaluated = evalLiteralNode(initializer) as LiteralValue;
      return validateContractSpecShape(evaluated);
    }
  }

  // No CONTRACT export found — not an error, just absent
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a ContractSpec from a TypeScript source string.
 *
 * Parses the source in-memory with ts-morph, then delegates to
 * `extractContractFromAst`. Returns `null` if the source has no
 * `export const CONTRACT` declaration. Throws `ContractExtractionError`
 * if CONTRACT is present but malformed (non-literal, wrong shape, etc.).
 *
 * @example
 * ```ts
 * const spec = extractContract(`
 *   import type { ContractSpec } from "@yakcc/contracts";
 *   export const CONTRACT: ContractSpec = { behavior: "...", ... };
 * `);
 * ```
 */
export function extractContract(source: string): ContractSpec | null {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, skipLibCheck: true },
  });
  const sourceFile = project.createSourceFile("__input__.ts", source);
  return extractContractFromAst(sourceFile);
}
