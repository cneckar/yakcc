// SPDX-License-Identifier: MIT
/**
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
 *   Critical JSDoc gotcha (per WI-022 plan): on `const f = () => ...`, JSDoc
 *   attaches to the VariableStatement, NOT the inner ArrowFunction. The picker
 *   returns the VariableStatement so the caller can call getJsDocs() on it
 *   directly. Returning the ArrowFunction would miss all JSDoc on arrow-const
 *   declarations. See static-extract.test.ts for the regression test.
 *
 *   Type-extraction depth: source-text only via getTypeNode()?.getText().
 *   We do NOT create a ts.Program with type-checker because:
 *   (a) shave's decompose() already parses with useInMemoryFileSystem:true and
 *       no lib loading; a full Program would need lib.d.ts resolution;
 *   (b) parse cost is ~5ms/call vs ~200ms/call with full lib resolution;
 *   (c) "unknown" is an established convention in the LLM prompt (prompt.ts:33).
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
 * Implements the deterministic preference chain described in
 * DEC-INTENT-STATIC-001.
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
        // Arrow assigned to `export default` — walk up to VariableStatement if present
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

/** True if the node has an `export` modifier. */
function isExported(node: FunctionDeclaration | VariableStatement): boolean {
  return node.hasModifier(SyntaxKind.ExportKeyword);
}

/**
 * Return the initializer of the first variable declarator in a VariableStatement.
 * Returns undefined if there are no declarators or the first has no initializer.
 */
function getFirstInitializer(stmt: VariableStatement): Node | undefined {
  const declarations = stmt.getDeclarationList().getDeclarations();
  if (declarations.length === 0) return undefined;
  return declarations[0]?.getInitializer();
}

/**
 * Walk up from a node to find the nearest enclosing VariableStatement.
 * Returns undefined if none is found before hitting the SourceFile.
 */
function getEnclosingVariableStatement(node: Node): VariableStatement | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && !Node.isSourceFile(current)) {
    if (Node.isVariableStatement(current)) return current;
    current = current.getParent();
  }
  return undefined;
}

/** Return the first MethodDeclaration from a ClassDeclaration. */
function getFirstMethod(cls: ClassDeclaration): Node | undefined {
  for (const member of cls.getMembers()) {
    if (Node.isMethodDeclaration(member)) return member;
  }
  return undefined;
}
