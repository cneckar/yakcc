// SPDX-License-Identifier: MIT
/**
 * Primary-declaration picker for TypeScript source files.
 *
 * Factored from packages/shave/src/intent/static-pick.ts as part of OD-2
 * Option A (DEC-EMBED-QUERY-ENRICH-HELPER-001): both the atomize path
 * (@yakcc/shave/intent/static-extract) and the query-enrichment path
 * (@yakcc/contracts/query-from-source) use this shared picker so the
 * "which function is primary?" logic is identical on both sides.
 *
 * @decision DEC-INTENT-STATIC-001
 * @title Primary-declaration picker: deterministic preference chain for static extraction
 * @status accepted
 * @rationale
 *   Static intent extraction needs a single "primary" declaration to extract a
 *   function signature and JSDoc from. The preference chain below is ordered by
 *   strength of intent signal:
 *
 *   1. export default <function|arrow> — strongest signal: the author explicitly
 *      named this the module's primary export.
 *   2. First exported FunctionDeclaration / VariableStatement-with-arrow — next
 *      best: exported by name, likely the public API.
 *   3. First non-exported FunctionDeclaration — common pattern in utility modules.
 *   4. First non-exported VariableStatement with ArrowFunction/FunctionExpression —
 *      covers `const f = () => ...` patterns.
 *   5. First ClassDeclaration's first method — for class-based modules.
 *   6. undefined — bare expression / pure statement block; caller handles this
 *      as the "no-declaration" fallback case.
 *
 *   Critical JSDoc gotcha: on `const f = () => ...`, JSDoc attaches to the
 *   VariableStatement, NOT the inner ArrowFunction. The picker returns the
 *   VariableStatement so the caller can call getJsDocs() on it directly.
 *   Returning the ArrowFunction would miss all JSDoc on arrow-const declarations.
 */

import {
  type ClassDeclaration,
  type FunctionDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableStatement,
} from "ts-morph";

/**
 * The primary declaration node (or undefined for bare expression blocks).
 *
 * Returns one of:
 *   - FunctionDeclaration
 *   - VariableStatement (for `const f = () => ...` and `export default const`)
 *   - MethodDeclaration (first method of first ClassDeclaration)
 *   - undefined
 *
 * NOTE: For arrow-const declarations, this returns the VariableStatement so
 * the caller can call Node.getJsDocs() on the statement (JSDoc attaches to the
 * VariableStatement, not the inner ArrowFunction).
 */
export type PrimaryDeclaration = Node | undefined;

/**
 * Select the primary declaration from a parsed source file.
 *
 * Implements the deterministic preference chain described in DEC-INTENT-STATIC-001.
 *
 * @param sourceFile - ts-morph SourceFile to inspect.
 * @returns The primary Node or undefined if no declaration found.
 */
export function pickPrimaryDeclaration(sourceFile: SourceFile): PrimaryDeclaration {
  // ------------------------------------------------------------------
  // Priority 1: export default function / export default arrow-const
  // ------------------------------------------------------------------
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport !== undefined) {
    const decls = defaultExport.getDeclarations();
    for (const decl of decls) {
      if (Node.isFunctionDeclaration(decl) || Node.isFunctionExpression(decl)) {
        return decl;
      }
      if (Node.isArrowFunction(decl)) {
        const parent = decl.getParent();
        const vs = getEnclosingVariableStatement(parent ?? decl);
        return vs ?? decl;
      }
      // export default expression (ExportAssignment) — skip to lower priorities
    }
  }

  const statements = sourceFile.getStatements();

  // ------------------------------------------------------------------
  // Priority 2: First exported FunctionDeclaration or exported
  //             VariableStatement whose initializer is arrow/function expr
  // ------------------------------------------------------------------
  for (const stmt of statements) {
    if (Node.isFunctionDeclaration(stmt) && isExported(stmt)) {
      return stmt;
    }
    if (Node.isVariableStatement(stmt) && isExported(stmt)) {
      const initializer = getFirstInitializer(stmt);
      if (
        initializer !== undefined &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ) {
        return stmt;
      }
    }
  }

  // ------------------------------------------------------------------
  // Priority 3: First non-exported FunctionDeclaration
  // ------------------------------------------------------------------
  for (const stmt of statements) {
    if (Node.isFunctionDeclaration(stmt)) {
      return stmt;
    }
  }

  // ------------------------------------------------------------------
  // Priority 4: First non-exported VariableStatement with arrow/function
  // ------------------------------------------------------------------
  for (const stmt of statements) {
    if (Node.isVariableStatement(stmt)) {
      const initializer = getFirstInitializer(stmt);
      if (
        initializer !== undefined &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ) {
        return stmt;
      }
    }
  }

  // ------------------------------------------------------------------
  // Priority 5: First method of first ClassDeclaration
  // ------------------------------------------------------------------
  for (const stmt of statements) {
    if (Node.isClassDeclaration(stmt)) {
      const method = getFirstMethod(stmt);
      if (method !== undefined) return method;
    }
  }

  // ------------------------------------------------------------------
  // Priority 6: None
  // ------------------------------------------------------------------
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExported(node: FunctionDeclaration | VariableStatement): boolean {
  return node.hasModifier(SyntaxKind.ExportKeyword);
}

function getFirstInitializer(stmt: VariableStatement): Node | undefined {
  const declarations = stmt.getDeclarationList().getDeclarations();
  if (declarations.length === 0) return undefined;
  return declarations[0]?.getInitializer();
}

function getEnclosingVariableStatement(node: Node): VariableStatement | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && !Node.isSourceFile(current)) {
    if (Node.isVariableStatement(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

function getFirstMethod(cls: ClassDeclaration): Node | undefined {
  for (const member of cls.getMembers()) {
    if (Node.isMethodDeclaration(member)) return member;
  }
  return undefined;
}
