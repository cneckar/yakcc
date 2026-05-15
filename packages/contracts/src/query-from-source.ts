// SPDX-License-Identifier: MIT
/**
 * queryIntentCardFromSource — derive a QueryIntentCard from TypeScript source.
 *
 * @decision DEC-EMBED-QUERY-ENRICH-HELPER-001
 * @title Discovery queries enrich to match stored ContractSpec via a shared helper.
 * @status accepted
 * @rationale
 *   The field-coverage asymmetry between store-side (full ContractSpec canonical JSON)
 *   and query-side (historically behavior-only) is resolved here: given TypeScript
 *   source, this helper derives the same structural fields the atomize/storeBlock path
 *   produces, so cosine ranking operates on comparable vectors.
 *
 *   Uses the shared source-extraction primitives from ./source-extract.ts (OD-2
 *   Option A). Both this helper and @yakcc/shave's static-extract.ts ultimately
 *   call the same extraction functions, making extraction-asymmetry structurally
 *   harder to reintroduce (R1 mitigation from the plan risk register).
 *
 *   Pure, deterministic, no I/O. Throws TypeError on parse failure or when the
 *   requested entryFunction is not found. Absent-dimension rule (D1): fields that
 *   cannot be derived are omitted from the returned QueryIntentCard.
 *
 *   Cross-references:
 *   - DEC-V3-DISCOVERY-D2-001: QueryIntentCard schema (unchanged by this helper)
 *   - DEC-V3-IMPL-QUERY-001: canonicalizeQueryText projection rules (unchanged)
 *   - plans/wi-fix-523-query-enrich-helper.md §3.2 (output mapping table)
 */

import { Node, Project, type SourceFile } from "ts-morph";
import type { QueryIntentCard, QueryTypeSignatureParam } from "./canonicalize.js";
import {
  extractJsDoc,
  extractSignatureFromNode,
  findExportedDeclarationByName,
} from "./source-extract.js";
import { pickPrimaryDeclaration } from "./source-pick.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for queryIntentCardFromSource.
 */
export interface QueryIntentCardFromSourceOptions {
  /**
   * Name of the exported function to derive from.
   * When absent, the first exported function in the source is used
   * (per the same preference chain as @yakcc/shave's static-extract:
   *  export default > first exported fn/arrow > first non-exported fn >
   *  first non-exported arrow-const > first class method).
   *
   * Throws TypeError if the named function is not found in the source.
   */
  readonly entryFunction?: string | undefined;
}

/**
 * Derive a QueryIntentCard from TypeScript source code.
 *
 * Pure: no I/O, no network, no file system access. Deterministic.
 * Throws TypeError on parse failure or when entryFunction is specified
 * but not found.
 *
 * Field derivation (D1 absent-dimension rule — omit what cannot be derived):
 *   behavior           — JSDoc summary → signature string → fragment fallback
 *   signature.inputs   — TS parameter types (name optional, type required)
 *   signature.outputs  — TS return type
 *   errorConditions    — JSDoc @throws / @throw / @exception tags
 *   guarantees         — omitted (no static derivation path in P0)
 *   nonFunctional      — omitted (no static derivation path in P0)
 *   propertyTests      — omitted (callers don't have these from source alone)
 *
 * The extraction uses the SAME primitives as @yakcc/shave's atomize path
 * (DEC-EMBED-QUERY-ENRICH-HELPER-001 OD-2 Option A): given identical source,
 * the behavior/signature fields here are byte-identical to what specFromIntent()
 * would store.
 *
 * @param source  - Raw TypeScript/JavaScript source text.
 * @param options - Optional: entryFunction name to target.
 * @returns A QueryIntentCard with all derivable fields populated.
 * @throws TypeError if the source fails to parse.
 * @throws TypeError if entryFunction is specified and not found in source.
 * @throws TypeError if source has no function declarations and entryFunction is absent.
 */
export function queryIntentCardFromSource(
  source: string,
  options?: QueryIntentCardFromSourceOptions,
): QueryIntentCard {
  // Parse in-memory with ts-morph.
  // DEC-INTENT-STATIC-003: no type-checker, no lib loading (~5ms vs ~200ms).
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: false,
      allowJs: true,
      noLib: true,
    },
  });

  let sourceFile: SourceFile;
  try {
    sourceFile = project.createSourceFile("__query_from_source__.ts", source);
  } catch (err) {
    throw new TypeError(
      `queryIntentCardFromSource: failed to parse source: ${String(err)}`,
    );
  }

  // Select the target declaration node.
  let declarationNode: import("ts-morph").Node | undefined;

  if (options?.entryFunction !== undefined) {
    // Explicit entryFunction: look it up by name.
    declarationNode = findExportedDeclarationByName(sourceFile, options.entryFunction);
    if (declarationNode === undefined) {
      throw new TypeError(
        `queryIntentCardFromSource: entryFunction "${options.entryFunction}" not found in source. ` +
          `Available declarations: ${listDeclarationNames(sourceFile).join(", ") || "(none)"}`,
      );
    }
  } else {
    // No entryFunction: use the primary-declaration preference chain.
    declarationNode = pickPrimaryDeclaration(sourceFile);
    if (declarationNode === undefined) {
      throw new TypeError(
        "queryIntentCardFromSource: source contains no function declarations. " +
          "Pass TypeScript source with at least one exported or top-level function.",
      );
    }
  }

  // Extract signature and JSDoc from the selected node.
  const sig = extractSignatureFromNode(declarationNode);
  const jsdoc = extractJsDoc(declarationNode);

  // Behavior field: JSDoc summary → signature string → fragment fallback.
  const behavior: string =
    jsdoc.summary ??
    sig.signatureString ??
    buildFragmentFallback(sourceFile.getStatements().length, source.length);

  // Build the QueryIntentCard, omitting absent dimensions (D1 rule).
  // behavior dimension — always present (has at least a fragment fallback).
  const card: Record<string, unknown> = { behavior };

  // signature dimension — only when there are params or a non-unknown return type.
  const inputs: QueryTypeSignatureParam[] = sig.params.map((p) => {
    const entry: { name?: string; type: string } = { type: p.typeAnnotation };
    if (p.name !== "") {
      entry.name = p.name;
    }
    return entry;
  });
  const outputs: QueryTypeSignatureParam[] =
    sig.returnTypeAnnotation !== "unknown"
      ? [{ name: "result", type: sig.returnTypeAnnotation }]
      : [];

  if (inputs.length > 0 || outputs.length > 0) {
    const signatureDim: {
      inputs?: readonly QueryTypeSignatureParam[];
      outputs?: readonly QueryTypeSignatureParam[];
    } = {};
    if (inputs.length > 0) signatureDim.inputs = inputs;
    if (outputs.length > 0) signatureDim.outputs = outputs;
    card.signature = signatureDim;
  }

  // errorConditions dimension — from @throws / @throw / @exception tags (D1: omit if none).
  if (jsdoc.throwDescriptions.length > 0) {
    card.errorConditions = jsdoc.throwDescriptions;
  }

  // guarantees, nonFunctional, propertyTests — omitted in P0 (no static derivation path).

  return card as unknown as QueryIntentCard;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFragmentFallback(stmtCount: number, byteCount: number): string {
  return `source fragment (${stmtCount} statements, ${byteCount} bytes)`;
}

/**
 * Collect all declaration names from a source file for error messages.
 */
function listDeclarationNames(sourceFile: SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const name = stmt.getName();
      if (name !== undefined) names.push(name);
    }
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        names.push(decl.getName());
      }
    }
  }
  return [...new Set(names)];
}
