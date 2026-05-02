// SPDX-License-Identifier: MIT
// @decision DEC-IR-STRICT-001: Strict-TS-subset validator uses ts-morph AST walks.
// Status: implemented (WI-004)
// Rationale: ts-morph gives full typed AST access without forking the parser. Each
// rule is a discrete function that returns ValidationError[], aggregated by the
// top-level validator. This design makes rules independently testable and cheap to
// add or remove without touching the orchestration logic.

import { readFileSync } from "node:fs";
import {
  type Expression,
  Node,
  NodeFlags,
  Project,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from "ts-morph";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single rule violation emitted by the strict-subset validator. */
export interface ValidationError {
  /** Short identifier for the violated rule, e.g. "no-any". */
  readonly rule: string;
  /** Human-readable description of the violation. */
  readonly message: string;
  /** File path the violation was found in (may be "<source>" for in-memory sources). */
  readonly file: string;
  /** 1-based line number of the violating node. */
  readonly line: number;
  /** 1-based column number of the violating node. */
  readonly column: number;
  /** Short source snippet around the violating node, if available. */
  readonly snippet?: string | undefined;
}

/** Discriminated union result returned by all validate* functions. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: ReadonlyArray<ValidationError> };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a ValidationError from an AST node. */
function makeError(node: Node, rule: string, message: string, filePath: string): ValidationError {
  const start = node.getStart();
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(start);
  const snippet = node.getText().slice(0, 80);
  return { rule, message, file: filePath, line, column, snippet };
}

/** Shared Project factory — creates a ts-morph Project configured for strict analysis. */
function makeProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      target: 99, // ESNext
      module: 99, // ESNext
      skipLibCheck: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Rule: no-any
//
// Rejects `any` in type positions: explicit `: any`, `as any`, `<any>` casts,
// generic arguments `Foo<any>`, return-type `any`, parameter type `any`.
// ---------------------------------------------------------------------------

function isAnyTypeNode(node: TypeNode): boolean {
  return node.getKind() === SyntaxKind.AnyKeyword;
}

function checkNoAny(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Walk all nodes and find explicit `any` type annotations
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.AnyKeyword) {
      // Check if this any keyword appears in a type position (not as an identifier)
      const parent = node.getParent();
      if (parent !== undefined) {
        errors.push(
          makeError(
            node,
            "no-any",
            "Explicit `any` type is forbidden in the strict subset",
            filePath,
          ),
        );
      }
    }
    // `as any` — TypeAssertion or AsExpression with AnyKeyword type
    if (
      node.getKind() === SyntaxKind.AsExpression ||
      node.getKind() === SyntaxKind.TypeAssertionExpression
    ) {
      const typeNode = Node.isAsExpression(node)
        ? node.getTypeNode()
        : Node.isTypeAssertion(node)
          ? node.getTypeNode()
          : undefined;
      if (typeNode !== undefined && isAnyTypeNode(typeNode)) {
        // Already caught by the AnyKeyword walk above; skip to avoid double-reporting
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-eval
//
// Rejects calls to `eval(...)` and `new Function(...)`.
// ---------------------------------------------------------------------------

function checkNoEval(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      // eval(...)
      if (Node.isIdentifier(expr) && expr.getText() === "eval") {
        errors.push(
          makeError(node, "no-eval", "`eval()` is forbidden in the strict subset", filePath),
        );
      }
      // Function("code") — direct reference to the global `Function`
      if (Node.isIdentifier(expr) && expr.getText() === "Function") {
        errors.push(
          makeError(
            node,
            "no-eval",
            "`Function(...)` constructor call is forbidden in the strict subset",
            filePath,
          ),
        );
      }
    }
    if (Node.isNewExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === "Function") {
        errors.push(
          makeError(
            node,
            "no-eval",
            "`new Function(...)` is forbidden in the strict subset",
            filePath,
          ),
        );
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-runtime-reflection
//
// Rejects:
//   - Object.getPrototypeOf(...)
//   - Object.setPrototypeOf(...)
//   - Reflect.*
//   - __proto__ property access
//   - Object.getOwnPropertyDescriptor(...)
//   - Object.defineProperty(...)
// ---------------------------------------------------------------------------

const REFLECTION_METHODS = new Set([
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "defineProperty",
  "defineProperties",
]);

function checkNoRuntimeReflection(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  sourceFile.forEachDescendant((node) => {
    // Property access: X.member
    if (Node.isPropertyAccessExpression(node)) {
      const obj = node.getExpression();
      const member = node.getName();

      // Reflect.* — any access on `Reflect`
      if (Node.isIdentifier(obj) && obj.getText() === "Reflect") {
        errors.push(
          makeError(
            node,
            "no-runtime-reflection",
            `\`Reflect.${member}\` is forbidden in the strict subset`,
            filePath,
          ),
        );
      }

      // Object.getPrototypeOf, Object.defineProperty, etc.
      if (Node.isIdentifier(obj) && obj.getText() === "Object" && REFLECTION_METHODS.has(member)) {
        errors.push(
          makeError(
            node,
            "no-runtime-reflection",
            `\`Object.${member}\` is forbidden in the strict subset`,
            filePath,
          ),
        );
      }

      // __proto__
      if (member === "__proto__") {
        errors.push(
          makeError(
            node,
            "no-runtime-reflection",
            "`__proto__` access is forbidden in the strict subset",
            filePath,
          ),
        );
      }
    }

    // Element access: obj["__proto__"] or obj[expr]
    if (Node.isElementAccessExpression(node)) {
      const argExpr = node.getArgumentExpression();
      if (argExpr !== undefined) {
        const text = argExpr.getText();
        if (text === '"__proto__"' || text === "'__proto__'") {
          errors.push(
            makeError(
              node,
              "no-runtime-reflection",
              "`__proto__` access via bracket notation is forbidden in the strict subset",
              filePath,
            ),
          );
        }
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-with
//
// Rejects `with (obj) { ... }` statements.
// ---------------------------------------------------------------------------

function checkNoWith(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.WithStatement) {
      errors.push(
        makeError(
          node,
          "no-with",
          "`with` statements are forbidden in the strict subset",
          filePath,
        ),
      );
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-mutable-globals
//
// Rejects top-level `let` and `var` declarations. Top-level `const` is fine.
// Module-level (file scoped) only — block-scoped let inside functions is allowed.
// ---------------------------------------------------------------------------

function checkNoMutableGlobals(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Direct children of the SourceFile are top-level statements.
  // NodeFlags.Let = 1, NodeFlags.Const = 2; var has flags = 0.
  // VariableDeclarationList.getFlags() returns the ts.NodeFlags value.
  for (const statement of sourceFile.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      const declListFlags = statement.getDeclarationList().getFlags();
      const isLet = (declListFlags & NodeFlags.Let) !== 0;
      const isConst = (declListFlags & NodeFlags.Const) !== 0;
      // var: neither Let nor Const flag set
      if (isLet || (!isConst && !isLet)) {
        // isLet → definitely `let`; !isConst && !isLet → `var`
        errors.push(
          makeError(
            statement,
            "no-mutable-globals",
            "Top-level `let` and `var` are forbidden; use `const` for all module-level bindings",
            filePath,
          ),
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-throw-non-error
//
// Rejects `throw <literal>` where the thrown value is not an Error instance.
// Allows: throw new Error(...), throw new MyError(...), throw someErrorVar
// Rejects: throw "string", throw 42, throw null, throw undefined, throw { ... }
// ---------------------------------------------------------------------------

function checkNoThrowNonError(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isThrowStatement(node)) {
      const thrown = node.getExpression();
      if (thrown === undefined) return;
      // Allow new SomeError(...)
      if (Node.isNewExpression(thrown)) return;
      // Allow identifiers (variable references — we can't know statically if they're errors)
      if (Node.isIdentifier(thrown)) return;
      // Allow property access (e.g. this.error, someObj.error)
      if (Node.isPropertyAccessExpression(thrown)) return;
      // Allow call expressions that return errors (e.g. makeError())
      if (Node.isCallExpression(thrown)) return;
      // Allow awaited values
      if (Node.isAwaitExpression(thrown)) return;
      // Everything else is a literal or non-Error value — reject
      errors.push(
        makeError(
          thrown,
          "no-throw-non-error",
          "Throwing non-Error values is forbidden; use `throw new Error(...)` or a subclass",
          filePath,
        ),
      );
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-top-level-side-effects
//
// Rejects top-level statements that are not:
//   - import declarations
//   - export declarations (including `export const`, `export function`, etc.)
//   - empty statements
//   - const variable declarations (exported or not)
//   - type/interface/enum declarations
//   - class declarations
//   - function declarations
// Rejects top-level expression statements (side-effecting calls, assignments, etc.)
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KINDS = new Set([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.ExportAssignment,
  SyntaxKind.EmptyStatement,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ModuleDeclaration,
]);

function checkNoTopLevelSideEffects(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const statement of sourceFile.getStatements()) {
    const kind = statement.getKind();

    if (ALLOWED_TOP_LEVEL_KINDS.has(kind)) continue;

    // Variable statements — allow only `const` (let/var caught by no-mutable-globals)
    if (Node.isVariableStatement(statement)) {
      // All variable statements are handled by no-mutable-globals; skip here.
      continue;
    }

    // Expression statements at top level are side effects
    if (Node.isExpressionStatement(statement)) {
      errors.push(
        makeError(
          statement,
          "no-top-level-side-effects",
          "Top-level expression statements (side effects) are forbidden; wrap in a function",
          filePath,
        ),
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: no-untyped-imports
//
// Rejects imports where the module specifier is a relative path that doesn't
// resolve to a known .ts source or .d.ts declaration file within the project.
// For third-party imports (non-relative), we trust that the project has types
// configured (skipLibCheck is the fallback); in-project imports must resolve.
//
// In the in-memory project context: we check if the import declaration has
// a `type` qualifier or if every imported symbol has a known type (not `any`).
// Pragmatically for v0: we reject bare `import X from "mod"` where `X` resolves
// to `any` (which happens when there are no type declarations for the module).
// ---------------------------------------------------------------------------

function checkNoUntypedImports(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    // import type ... is always fine
    if (importDecl.isTypeOnly()) continue;

    const namedBindings = importDecl.getNamedImports();
    const defaultImport = importDecl.getDefaultImport();
    const namespaceImport = importDecl.getNamespaceImport();

    // For each imported binding, check if the symbol resolves to `any`
    const checkBinding = (expr: Expression | undefined): void => {
      if (expr === undefined) return;
      const type = expr.getType();
      if (type.isAny()) {
        errors.push(
          makeError(
            importDecl,
            "no-untyped-imports",
            `Import from "${importDecl.getModuleSpecifierValue()}" has unresolved types (resolves to \`any\`); ensure the module has TypeScript declarations`,
            filePath,
          ),
        );
      }
    };

    if (defaultImport !== undefined) {
      checkBinding(defaultImport);
    }
    for (const named of namedBindings) {
      checkBinding(named.getNameNode());
    }
    if (namespaceImport !== undefined) {
      checkBinding(namespaceImport);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Rule orchestration
// ---------------------------------------------------------------------------

type RuleChecker = (sourceFile: SourceFile, filePath: string) => ValidationError[];

const ALL_RULES: ReadonlyArray<RuleChecker> = [
  checkNoAny,
  checkNoEval,
  checkNoRuntimeReflection,
  checkNoWith,
  checkNoMutableGlobals,
  checkNoThrowNonError,
  checkNoTopLevelSideEffects,
  checkNoUntypedImports,
];

/** Run all rules against an already-created ts-morph SourceFile. */
export function runAllRules(sourceFile: SourceFile, filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const rule of ALL_RULES) {
    errors.push(...rule(sourceFile, filePath));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a TypeScript source string against the strict subset rules.
 *
 * The source is parsed in-memory with a ts-morph Project; no disk I/O occurs.
 * Returns `{ ok: true }` if all rules pass, or `{ ok: false, errors }` listing
 * every violation found (all rules are run even after the first failure).
 *
 * @example
 * ```ts
 * const result = validateStrictSubset(`export const x: any = 1;`);
 * // result.ok === false; result.errors[0].rule === "no-any"
 * ```
 */
export function validateStrictSubset(source: string): ValidationResult {
  const project = makeProject();
  const sourceFile = project.createSourceFile("__input__.ts", source);
  const errors = runAllRules(sourceFile, "<source>");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validate a TypeScript file on disk against the strict subset rules.
 *
 * Reads the file synchronously, then delegates to `validateStrictSubset`.
 * Returns `{ ok: true }` or `{ ok: false, errors }`.
 */
export function validateStrictSubsetFile(path: string): ValidationResult {
  const source = readFileSync(path, "utf-8");
  const project = makeProject();
  const sourceFile = project.createSourceFile(path, source);
  const errors = runAllRules(sourceFile, path);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
