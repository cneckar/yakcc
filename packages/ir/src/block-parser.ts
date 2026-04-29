// @decision DEC-IR-BLOCK-001: parseBlock combines validator + annotation extractor.
// Status: implemented (WI-004)
// Rationale: The Block type is the canonical unit of the IR: it carries the
// strict-subset validation result, the extracted ContractSpec (if present), the
// content-address derived from the spec, and the composition graph (imports from
// @yakcc/seeds/* or other block packages). Separating parser from validator and
// annotation extractor keeps each concern independently testable while this
// function composes them into the single artifact callers need.

import { contractId } from "@yakcc/contracts";
import type { ContractId, ContractSpec } from "@yakcc/contracts";
import { Project } from "ts-morph";
import { extractContractFromAst } from "./annotations.js";
import { type ValidationResult, runAllRules } from "./strict-subset.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A reference to a sub-block imported by the current block.
 *
 * Sub-block detection is heuristic: any import from a path matching
 * `@yakcc/seeds/*`, `@yakcc/blocks/*`, or the configurable `blockPatterns`
 * option is treated as a sub-block reference.
 */
export interface SubBlockReference {
  /** The local identifier bound by the import statement (e.g. `digitOf`). */
  readonly localName: string;
  /** The module specifier as written in the source (e.g. `"@yakcc/seeds/blocks/digit"`). */
  readonly importedFrom: string;
  /**
   * Content-address of the referenced block's contract, if the block's CONTRACT
   * was resolvable at parse time. `null` when `resolveContractIds` option is false
   * or when the referenced block's source is unavailable.
   */
  readonly contract: ContractId | null;
}

/**
 * The result of parsing a Yakcc basic block.
 *
 * A Block always has a `source` and a `validation` result. When validation
 * passes and a CONTRACT export is present, `contractSpec` and `contract` are
 * populated. Callers should check `validation.ok` before treating the block
 * as registry-ready.
 */
export interface Block {
  /**
   * The content-address of this block's contract spec.
   * `null` when no CONTRACT export was found in the source.
   */
  readonly contract: ContractId | null;
  /**
   * The structured contract spec extracted from the `export const CONTRACT` declaration.
   * `null` when no CONTRACT export was found.
   */
  readonly contractSpec: ContractSpec | null;
  /** The original source string as passed to `parseBlock`. */
  readonly source: string;
  /**
   * Sub-block imports detected in the source. Only populated for imports
   * matching the block-package heuristic (see `SubBlockReference`).
   */
  readonly composition: ReadonlyArray<SubBlockReference>;
  /**
   * Result of running the strict-subset validator against `source`.
   * Check `validation.ok` to determine registry readiness.
   */
  readonly validation: ValidationResult;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseBlockOptions {
  /**
   * When true, attempt to resolve ContractIds for sub-block imports by reading
   * their source from the filesystem and extracting their CONTRACT.
   * Defaults to false (ContractId in SubBlockReference is null).
   */
  readonly resolveContractIds?: boolean | undefined;
  /**
   * Additional import path prefixes to treat as block references beyond the
   * built-in patterns (`@yakcc/seeds/`, `@yakcc/blocks/`).
   */
  readonly blockPatterns?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Built-in block import patterns
// ---------------------------------------------------------------------------

const BUILTIN_BLOCK_PATTERNS = ["@yakcc/seeds/", "@yakcc/blocks/"] as const;

function isBlockImport(moduleSpecifier: string, extraPatterns: readonly string[]): boolean {
  for (const pattern of BUILTIN_BLOCK_PATTERNS) {
    if (moduleSpecifier.startsWith(pattern)) return true;
  }
  for (const pattern of extraPatterns) {
    if (moduleSpecifier.startsWith(pattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Composition extraction
// ---------------------------------------------------------------------------

function extractComposition(source: string, extraPatterns: readonly string[]): SubBlockReference[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, skipLibCheck: true, target: 99, module: 99 },
  });
  const sourceFile = project.createSourceFile("__input__.ts", source);

  const refs: SubBlockReference[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getModuleSpecifierValue();
    if (!isBlockImport(specifier, extraPatterns)) continue;

    // Collect all local names bound by this import
    const namedImports = importDecl.getNamedImports();
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();

    if (namedImports.length > 0) {
      for (const named of namedImports) {
        refs.push({
          localName: named.getAliasNode()?.getText() ?? named.getName(),
          importedFrom: specifier,
          contract: null,
        });
      }
    } else if (defaultImport !== undefined) {
      refs.push({
        localName: defaultImport.getText(),
        importedFrom: specifier,
        contract: null,
      });
    } else if (namespaceImport !== undefined) {
      refs.push({
        localName: namespaceImport.getText(),
        importedFrom: specifier,
        contract: null,
      });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Yakcc basic block from a TypeScript source string.
 *
 * Steps:
 * 1. Validate the source against the strict-subset rules.
 * 2. Extract the `export const CONTRACT: ContractSpec` annotation (if present).
 * 3. Derive the content-address from the extracted spec.
 * 4. Identify sub-block composition references (imports from block packages).
 *
 * The returned `Block` always includes the validation result. If validation
 * fails, `contract` and `contractSpec` may still be populated (extraction is
 * attempted regardless), allowing callers to inspect the block's declared
 * contract even when the source contains rule violations.
 *
 * @example
 * ```ts
 * const block = parseBlock(source);
 * if (!block.validation.ok) {
 *   for (const e of block.validation.errors) console.error(e.message);
 * }
 * ```
 */
export function parseBlock(source: string, options?: ParseBlockOptions): Block {
  const resolveContractIds = options?.resolveContractIds ?? false;
  const extraPatterns = options?.blockPatterns ?? [];

  // 1. Run strict-subset validation
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, skipLibCheck: true, target: 99, module: 99 },
  });
  const sourceFile = project.createSourceFile("__input__.ts", source);
  const validationErrors = runAllRules(sourceFile, "<source>");
  const validation: ValidationResult =
    validationErrors.length === 0 ? { ok: true } : { ok: false, errors: validationErrors };

  // 2. Extract CONTRACT annotation (attempt even if validation failed —
  //    callers may want to know the declared contract for diagnostic purposes)
  let contractSpec: ContractSpec | null = null;
  let blockContractId: ContractId | null = null;
  try {
    contractSpec = extractContractFromAst(sourceFile);
    if (contractSpec !== null) {
      blockContractId = contractId(contractSpec);
    }
  } catch {
    // ContractExtractionError — the CONTRACT export was malformed.
    // We don't rethrow here: parseBlock is non-throwing for extraction failures.
    // The validation result already captures structural issues.
    contractSpec = null;
    blockContractId = null;
  }

  // 3. Extract composition references
  const composition = extractComposition(source, extraPatterns);

  return {
    contract: blockContractId,
    contractSpec,
    source,
    composition,
    validation,
  };
}
