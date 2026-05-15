// SPDX-License-Identifier: MIT
/**
 * @decision DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001
 * title: STEF (Single Typed Exported Function) predicate for decompose() fast-path
 * status: decided
 * rationale:
 *   `decompose()` fragments a SourceFile that contains exactly one exported
 *   function with multiple control-flow boundaries into statement-level atoms,
 *   each producing an empty-signature SpecYak (`inputs:[]`, `outputs:[]`,
 *   `behavior:"source fragment (N statements, M bytes)"`). This destroys the
 *   round-trip retrieval signal that Step 9 of v0-release-smoke depends on
 *   (root cause of #444/#523/#549).
 *
 *   For a SourceFile that IS a single typed exported function (STEF shape), the
 *   *maximal* shaveable subgraph is the whole file — there is no glue to carve
 *   away. Preserving it as one atom lets `staticExtract` / `pickPrimaryDeclaration`
 *   find the exported function at priority 2, producing a rich SpecYak with
 *   non-empty inputs/outputs.
 *
 *   This is a **refinement, not a reversal** of DEC-V2-GLUE-AWARE-SHAVE-001:
 *   STEF is the degenerate case where fragmentation strictly destroys signal.
 *   All non-STEF files continue through the glue-aware fragmentation path
 *   unchanged.
 *
 *   Companion to DEC-EMBED-QUERY-ENRICH-HELPER-001: that decision closed the
 *   query-side field-coverage asymmetry; this decision closes the store-side
 *   fragmentation root cause. Together they constitute the complete fix for the
 *   v0 round-trip retrieval failure.
 *
 * STEF predicate (§3.3 of plans/wi-fix-549-shave-fragmentation.md):
 *   A SourceFile matches STEF when ALL of:
 *   1. Exactly one top-level exported function-like declaration (FunctionDeclaration
 *      OR VariableStatement with a single arrow/function-expression initializer).
 *   2. All parameters have explicit TS type annotations (no implicit any); zero
 *      parameters is permitted.
 *   3. Explicit return type annotation.
 *   4. Non-empty JSDoc block (/** … *‌/) on the function or enclosing VariableStatement.
 *   5. All other top-level statements restricted to: ImportDeclaration,
 *      ExportDeclaration (re-export), TypeAliasDeclaration, InterfaceDeclaration.
 *      Any other form (second function, class, bare const, expression statement)
 *      causes STEF to return false.
 *   6. The function body is non-empty (Block with at least one statement).
 *
 * Authority invariant:
 *   - STEF is a SourceFile-level predicate. It does NOT modify isAtom() (per-node).
 *   - pickPrimaryDeclaration and extractSignatureFromNode are not modified; they
 *     operate on the full source once STEF returns a single-leaf tree.
 *   - This module is the single canonical authority for the STEF predicate.
 *     Callers must not re-implement it.
 */

import { type Node, type SourceFile, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Allowed noise kinds at the top level (per plan §3.3)
// ---------------------------------------------------------------------------

/**
 * Top-level SyntaxKinds that are "permitted noise" — non-executing forms that
 * carry no shaveable behavior and do not disqualify a SourceFile from STEF.
 */
const STEF_PERMITTED_NOISE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ExportDeclaration, // re-exports without value semantics
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.InterfaceDeclaration,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if `node` is a FunctionDeclaration with the `export` modifier.
 */
function isExportedFunctionDeclaration(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.FunctionDeclaration) return false;
  const fn = node as Node & {
    hasModifier(kind: SyntaxKind): boolean;
  };
  return fn.hasModifier(SyntaxKind.ExportKeyword);
}

/**
 * Return true if `node` is a VariableStatement with `export` modifier whose
 * single declarator has an ArrowFunction or FunctionExpression initializer.
 */
function isExportedArrowOrFnConstDeclaration(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.VariableStatement) return false;
  const vs = node as Node & {
    hasModifier(kind: SyntaxKind): boolean;
    getDeclarationList(): Node & {
      getDeclarations(): Array<
        Node & { getInitializer(): Node | undefined }
      >;
    };
  };
  if (!vs.hasModifier(SyntaxKind.ExportKeyword)) return false;
  const decls = vs.getDeclarationList().getDeclarations();
  if (decls.length !== 1) return false;
  const init = decls[0]?.getInitializer();
  if (init === undefined) return false;
  const k = init.getKind();
  return k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression;
}

/**
 * Extract the function-like node from a top-level statement that passed
 * `isExportedFunctionDeclaration` or `isExportedArrowOrFnConstDeclaration`.
 * Returns `undefined` if the node is neither.
 */
function extractFunctionLike(
  node: Node,
): (Node & {
  getParameters(): Array<Node & { getTypeNode(): Node | undefined }>;
  getReturnTypeNode(): Node | undefined;
  getJsDocs(): Node[];
  getBody(): Node | undefined;
}) | undefined {
  if (node.getKind() === SyntaxKind.FunctionDeclaration) {
    return node as Node & {
      getParameters(): Array<Node & { getTypeNode(): Node | undefined }>;
      getReturnTypeNode(): Node | undefined;
      getJsDocs(): Node[];
      getBody(): Node | undefined;
    };
  }
  if (node.getKind() === SyntaxKind.VariableStatement) {
    const vs = node as Node & {
      getDeclarationList(): Node & {
        getDeclarations(): Array<
          Node & { getInitializer(): Node | undefined }
        >;
      };
    };
    const init = vs.getDeclarationList().getDeclarations()[0]?.getInitializer();
    if (init === undefined) return undefined;
    const k = init.getKind();
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
      return init as Node & {
        getParameters(): Array<Node & { getTypeNode(): Node | undefined }>;
        getReturnTypeNode(): Node | undefined;
        getJsDocs(): Node[];
        getBody(): Node | undefined;
      };
    }
  }
  return undefined;
}

/**
 * Return true if `fnNode` satisfies the STEF function-level requirements:
 *   - all parameters have explicit type annotations (zero params also passes)
 *   - explicit return type annotation
 *   - at least one non-empty JSDoc block
 *   - non-empty body (Block with ≥ 1 statement)
 *
 * For VariableStatement-wrapped arrow/fn-expressions, `enclosingNode` is the
 * VariableStatement (JSDoc lives on the var statement in ts-morph for arrow-const).
 */
function functionLikeSatisfiesStef(
  fnNode: Node & {
    getParameters(): Array<Node & { getTypeNode(): Node | undefined }>;
    getReturnTypeNode(): Node | undefined;
    getJsDocs(): Node[];
    getBody(): Node | undefined;
  },
  enclosingNode: Node,
): boolean {
  // 1. All parameters must have explicit type annotations (implicit any → false).
  const params = fnNode.getParameters();
  for (const param of params) {
    if (param.getTypeNode() === undefined) return false;
  }

  // 2. Explicit return type annotation.
  if (fnNode.getReturnTypeNode() === undefined) return false;

  // 3. Non-empty JSDoc block.
  //    For arrow-const, JSDoc attaches to the VariableStatement in ts-morph.
  //    Try the function node first; fall back to the enclosing node.
  const jsDocs =
    fnNode.getJsDocs().length > 0
      ? fnNode.getJsDocs()
      : (() => {
          const enc = enclosingNode as Node & { getJsDocs?(): Node[] };
          return enc.getJsDocs?.() ?? [];
        })();
  if (jsDocs.length === 0) return false;

  // 4. Non-empty body (Block with ≥ 1 statement).
  const body = fnNode.getBody();
  if (body === undefined) return false;
  if (body.getKind() !== SyntaxKind.Block) return false;
  const bodyStatements = (body as Node & { getStatements(): Node[] }).getStatements();
  if (bodyStatements.length === 0) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return true when the parsed `sourceFile` matches the STEF (Single Typed
 * Exported Function) predicate, meaning `decompose()` should return a single
 * AtomLeaf covering the entire source range rather than fragmenting the file.
 *
 * The predicate is intentionally narrow (per plan §3.3 and OD-1). Any shape
 * outside STEF continues through the normal glue-aware fragmentation path.
 *
 * @param sourceFile - A ts-morph SourceFile already parsed from the source text.
 */
export function matchesStefPredicate(sourceFile: SourceFile): boolean {
  const statements = sourceFile.getStatements();

  let functionLikeCount = 0;
  let candidateFunctionNode: Node | undefined;

  for (const stmt of statements) {
    const kind = stmt.getKind();

    if (STEF_PERMITTED_NOISE_KINDS.has(kind)) {
      // Permitted noise — continue scanning.
      continue;
    }

    // Check whether this statement is the (sole) exported function-like.
    if (isExportedFunctionDeclaration(stmt) || isExportedArrowOrFnConstDeclaration(stmt)) {
      functionLikeCount += 1;
      if (functionLikeCount > 1) {
        // More than one function-like → STEF fails immediately.
        return false;
      }
      candidateFunctionNode = stmt;
      continue;
    }

    // Any other top-level form disqualifies the file from STEF.
    return false;
  }

  // Must have exactly one exported function-like.
  if (functionLikeCount !== 1 || candidateFunctionNode === undefined) return false;

  // Extract the actual function-like node (the FunctionDeclaration itself, or
  // the ArrowFunction/FunctionExpression initializer of the VariableStatement).
  const fnLike = extractFunctionLike(candidateFunctionNode);
  if (fnLike === undefined) return false;

  // Validate function-level STEF requirements.
  return functionLikeSatisfiesStef(fnLike, candidateFunctionNode);
}
