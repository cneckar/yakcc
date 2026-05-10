// SPDX-License-Identifier: MIT
/**
 * ast-binding.ts — Extract variable binding shape from agent-emitted TypeScript snippets.
 *
 * Uses ts-morph (already a dependency of @yakcc/ir) to parse a code snippet
 * in-memory and extract the binding name, called function name, and arguments.
 *
 * @decision DEC-HOOK-PHASE-2-001 (B)
 * @title Binding-extraction strategy for destructuring and generics edge cases
 * @status accepted
 * @rationale
 *   Binding extraction is the long-pole engineering item in Phase 2 (per #217 estimate:
 *   1.5–2 weeks). v1 handles the common case (single const/let + call expression) and
 *   documents the out-of-scope patterns explicitly.
 *
 *   IN SCOPE (v1):
 *   - Simple binding: `const x = fn(args)` and `let x = fn(args)`
 *   - Multi-arg calls: `const x = fn(a, b, c)`
 *   - Type-annotated bindings: `const x: T = fn(args)` — returnType captured
 *   - String/numeric/boolean literal args (getText() returns source text)
 *
 *   OUT OF SCOPE (v1) — returns null:
 *   - Destructuring: `const { a, b } = fn(args)` — requires multi-binding analysis
 *   - Default parameters: `fn(args = defaultVal)` — complex analysis, Phase 2.1
 *   - Generic call expressions: `fn<T>(args)` — Phase 2.1
 *   - Constructor calls: `new Foo(args)` — different substitution semantics
 *   - Multi-statement snippets: ambiguous target; Phase 2 handles single-declaration only
 *   - Bare expression statements (no binding): not substitutable
 *
 *   WHY ts-morph instead of a custom regex/split approach:
 *   - Correctness: ts-morph handles all TypeScript syntax edge cases (template literals,
 *     nested calls, type casts, etc.) without fragile regex matching.
 *   - Reuse: ts-morph is already a direct dependency of @yakcc/ir (block-parser.ts,
 *     strict-subset.ts use it). No new dependency is introduced.
 *   - Testability: the in-memory Project creation pattern is already established in
 *     validateStrictSubset() in strict-subset.ts. This module follows the same pattern.
 *
 *   Cross-reference:
 *     DEC-HOOK-PHASE-2-001 (parent — import path + invocation policy)
 *     DEC-IR-STRICT-001 (ts-morph as the AST tool for @yakcc/ir)
 *     DEC-HOOK-LAYER-001 (hook layer architecture)
 */

import { Node, Project, SyntaxKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The extracted binding shape from a single variable declaration with a call
 * expression as the initializer.
 *
 * Consumed by renderSubstitution() in @yakcc/hooks-base.
 */
export interface BindingShape {
  /** Variable name: `const <name> = fn(...)`. */
  readonly name: string;
  /** Arguments as source-text strings (getText() on each argument node). */
  readonly args: readonly string[];
  /**
   * Function name from the original call expression: `const x = <atomName>(...)`.
   * This becomes the named import and the import path segment in renderSubstitution().
   */
  readonly atomName: string;
  /**
   * Explicit type annotation text if present: `const x: <returnType> = fn(...)`.
   * Undefined when no type annotation is present.
   */
  readonly returnType?: string | undefined;
}

// ---------------------------------------------------------------------------
// Shared Project factory
// ---------------------------------------------------------------------------

/**
 * Create a minimal in-memory ts-morph Project for snippet parsing.
 *
 * Same pattern as validateStrictSubset() in strict-subset.ts (DEC-IR-STRICT-001):
 * skipLibCheck + addSourceFileAtPath avoid needing real node_modules.
 * addSourceFileAtPathIfExists is not used — we add in-memory source files directly.
 */
function makeSnippetProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      skipLibCheck: true,
      strict: false,
    },
  });
}

// ---------------------------------------------------------------------------
// extractBindingShape
// ---------------------------------------------------------------------------

/**
 * Extract the variable binding shape from a single TypeScript code snippet.
 *
 * Parses the snippet in-memory with ts-morph and looks for a single
 * `VariableStatement` with a `CallExpression` initializer.
 *
 * Returns null when:
 * - The snippet is empty or unparseable.
 * - The snippet contains no variable declarations.
 * - The snippet contains multiple variable statements (ambiguous target).
 * - The declaration's initializer is not a CallExpression (not a function call).
 * - The binding pattern is a destructuring pattern (out of scope for v1).
 *
 * @decision DEC-HOOK-PHASE-2-001 (B): v1 scope boundaries documented above.
 *
 * @param code - TypeScript snippet from an agent-emitted tool call.
 * @returns BindingShape or null if the snippet cannot be analyzed.
 */
export function extractBindingShape(code: string): BindingShape | null {
  if (!code.trim()) {
    return null;
  }

  const project = makeSnippetProject();
  const sourceFile = project.createSourceFile("__snippet__.ts", code);

  // Collect only VariableStatements at the top level of the snippet.
  const varStatements = sourceFile.getStatements().filter(Node.isVariableStatement);

  if (varStatements.length === 0) {
    // No variable declarations — could be expression statement, class, function, etc.
    return null;
  }

  if (varStatements.length > 1) {
    // Multiple variable statements — ambiguous target. Return null per v1 scope.
    // Best-effort: caller may want to handle multi-statement snippets later.
    // Returning null is the safe conservative choice.
    return null;
  }

  const varStatement = varStatements[0];
  if (varStatement === undefined) {
    return null;
  }

  // Get the declaration list — should have exactly one declarator.
  const declarationList = varStatement.getDeclarationList();
  const declarations = declarationList.getDeclarations();

  if (declarations.length !== 1) {
    // Multiple declarators in one statement: `const a = fn(), b = gn()`.
    // v1: not supported.
    return null;
  }

  const decl = declarations[0];
  if (decl === undefined) {
    return null;
  }

  // Check that the binding is a simple identifier (not destructuring).
  const nameNode = decl.getNameNode();
  if (!Node.isIdentifier(nameNode)) {
    // Destructuring pattern — out of scope for v1.
    return null;
  }

  const name = nameNode.getText();

  // Extract the optional type annotation.
  const typeNode = decl.getTypeNode();
  const returnType = typeNode !== undefined ? typeNode.getText() : undefined;

  // Check that the initializer is a CallExpression.
  const initializer = decl.getInitializer();
  if (initializer === undefined) {
    return null;
  }

  if (!Node.isCallExpression(initializer)) {
    // RHS is a literal, binary expression, new-expression, etc.
    return null;
  }

  // Extract the called function name.
  const expression = initializer.getExpression();
  if (!Node.isIdentifier(expression)) {
    // Member expression (`obj.method()`), new expression, etc.
    // v1: only plain identifier calls are supported.
    return null;
  }

  const atomName = expression.getText();

  // Extract arguments as source-text strings.
  const args = initializer
    .getArguments()
    .map((arg) => arg.getText())
    // Filter out SyntaxKind.CommaToken elements if any leak through.
    .filter((text) => text !== ",");

  return { name, args, atomName, returnType };
}
