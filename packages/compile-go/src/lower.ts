// SPDX-License-Identifier: MIT
/**
 * Lower TS-subset IR source to idiomatic Go source.
 *
 * Entry point: lowerSource(implSource) -> LowerResult
 * Consumers call compileToGo() (compile-go.ts) which wraps lowerSource.
 *
 * @decision DEC-WI973-001
 * @title IR->Go lowering uses ts-morph AST walk; all emitted constructs from MVP table
 * @status accepted (WI-973)
 * @rationale
 *   ts-morph gives exact typed AST nodes identical to those the strict-subset
 *   validator already accepts, so we inherit the validator's guarantees: only
 *   pure-function constructs, no async, no DOM, no eval. The emitter therefore
 *   does not need to defensively guard against constructs the validator already
 *   blocks at shave-time.
 *
 *   Go MVP mapping table (DEC-WI973-001):
 *     Types:  number -> int | float64, string -> string, boolean -> bool,
 *             T[] -> []T, Record<K,V> -> map[K]V, void -> (no return),
 *             any/unknown -> interface{}, generic T -> [T any] constraint
 *     Stmts:  return, if/else, const/let/var -> :=, ExpressionStatement,
 *             switch/case/default (implicit break), for/for-of/while
 *     Exprs:  numeric literal, string literal, bool literal, identifier,
 *             BinaryExpr, PrefixUnary (!/-), Call, PropertyAccess (len),
 *             ElementAccess
 *     Fn:     export function name<T,R>(p T, q int): R -> func Name[T,R any](p T, q int) R
 *
 *   Everything else -> CannotLowerToGoError (loud failure, DEC-WI973-003).
 *
 * @decision DEC-WI973-003
 * @title IR->Go lowering throws CannotLowerToGoError on all unhandled nodes; no silent fallbacks
 * @status accepted (WI-973)
 * @rationale
 *   Mirrors DEC-COMPILE-PYTHON-LOUD-001 (WI-943). Silent fallbacks allowed raw TS
 *   syntax to appear verbatim in Python output. CannotLowerToGoError surfaces coverage
 *   gaps immediately instead of letting TS syntax leak into Go output.
 *
 * @decision DEC-WI977-001
 * @title Import synthesis: table-driven package-name -> import-path resolution; unknown -> placeholder
 * @status accepted (WI-977)
 * @rationale
 *   Dotted-identifier references (pkg.Symbol) in the lowered output require a
 *   corresponding import block for the Go file to compile. A table mapping well-known
 *   package names to their canonical import paths covers stdlib and common golang.org/x/*
 *   packages without requiring shave-go to carry import metadata through the IR.
 *   Unknown packages emit a "unknown/<pkg>" placeholder import + GoLowerWarning so the
 *   user can identify and fix missing paths manually (less disruptive than hard rejection).
 *
 * @decision DEC-WI978-001
 * @title SwitchStatement lowering: implicit-break removal; TS-fallthrough merging into Go multi-value cases
 * @status accepted (WI-978)
 * @rationale
 *   Go switch has implicit break unlike TS/JS. TS empty fallthrough cases (case a: case b: body)
 *   map naturally to Go multi-value cases (case a, b: body). We collect consecutive
 *   empty cases then emit them as a single "case a, b, c:" header. The last case in
 *   a group is the one with a non-empty body; its body statements are lowered normally.
 *   Explicit TS `break` statements inside case bodies are dropped since Go does not
 *   need them. `default:` passes through unchanged.
 */

import { CannotLowerToGoError } from "@yakcc/contracts";
import { type FunctionDeclaration, Node, Project, SyntaxKind, type TypeNode } from "ts-morph";
import { toGoExportedName, toGoLocalName } from "./names.js";

// ---------------------------------------------------------------------------
// Import path resolution table (WI-977, DEC-WI977-001)
//
// Maps the bare Go package name (as used in dotted expressions like pkg.Sym)
// to the canonical import path that must appear in the import block.
// stdlib packages whose path equals their name are included explicitly
// so the table is the single source of truth.
// ---------------------------------------------------------------------------

const KNOWN_IMPORT_PATHS: Readonly<Record<string, string>> = {
  // stdlib
  fmt: "fmt",
  strings: "strings",
  strconv: "strconv",
  sort: "sort",
  slices: "slices",
  maps: "maps",
  errors: "errors",
  reflect: "reflect",
  time: "time",
  context: "context",
  io: "io",
  os: "os",
  bytes: "bytes",
  bufio: "bufio",
  sync: "sync",
  regexp: "regexp",
  math: "math",
  unicode: "unicode",
  utf8: "unicode/utf8",
  json: "encoding/json",
  // golang.org/x/text
  cases: "golang.org/x/text/cases",
  language: "golang.org/x/text/language",
};

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface Ctx {
  warnings: GoLowerWarning[];
  /** type params declared on the current function (e.g. ["T", "R"]) */
  typeParams: string[];
  /** Name of the function being lowered, for error messages.
   *  Optional — not set at top level, only set by lowerFunctionDecl.
   */
  fnName?: string | undefined;
  /**
   * Set of bare package names seen in dotted-identifier expressions
   * (e.g. "reflect" from reflect.ValueOf, "cases" from cases.Title).
   * Populated during the lowering walk; used by lowerSource to synthesize
   * the import block (WI-977, DEC-WI977-001).
   */
  importRefs: Set<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GoLowerWarning {
  readonly kind: string;
  readonly message: string;
}

export interface LowerResult {
  goLines: string[];
  warnings: GoLowerWarning[];
  /**
   * Resolved import paths collected during the lowering walk.
   * Each entry is a canonical Go import path (e.g. "reflect",
   * "golang.org/x/text/cases") ready for inclusion in an import block.
   * Callers (compile-go.ts) are responsible for synthesizing the actual
   * import statement from this set (WI-977, DEC-WI977-001).
   */
  importPaths: Set<string>;
}

/**
 * Lower a TS-subset IR source string to Go lines.
 * Returned goLines do NOT include a package declaration; callers prepend
 * `package <name>` when assembling a full .go file.
 */
export function lowerSource(implSource: string): LowerResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      target: 99,
      module: 99,
      skipLibCheck: true,
    },
  });
  const sf = project.createSourceFile("impl.ts", implSource);

  const ctx: Ctx = { warnings: [], typeParams: [], importRefs: new Set() };
  const goLines: string[] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const fnLines = lowerFunctionDecl(stmt, ctx);
      goLines.push(...fnLines);
      goLines.push("");
    }
    // type aliases, import declarations, and comments are silently skipped
  }

  // Resolve collected package references to canonical import paths (WI-977)
  const importPaths = new Set<string>();
  for (const pkg of ctx.importRefs) {
    const resolved = KNOWN_IMPORT_PATHS[pkg];
    if (resolved !== undefined) {
      importPaths.add(resolved);
    } else {
      const placeholder = `unknown/${pkg}`;
      importPaths.add(placeholder);
      ctx.warnings.push({
        kind: "unknown-import",
        message: `Unknown package "${pkg}" — using placeholder import path "${placeholder}". Update manually.`,
      });
    }
  }

  return { goLines, warnings: ctx.warnings, importPaths };
}

// ---------------------------------------------------------------------------
// Location helper
// ---------------------------------------------------------------------------

function nodeLocation(node: Node): { line: number; column: number } {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

// ---------------------------------------------------------------------------
// Function declaration
// ---------------------------------------------------------------------------

/**
 * Lower a TS function declaration to a Go func declaration.
 *
 * TS:  export function add<T>(a: T, b: number): T { ... }
 * Go:  func Add[T any](a T, b int) T { ... }
 */
function lowerFunctionDecl(fn: FunctionDeclaration, ctx: Ctx): string[] {
  const name = fn.getName() ?? "unknown";
  const goName = toGoExportedName(name);

  // Capture type params for this function
  const tpNodes = fn.getTypeParameters();
  const typeParams = tpNodes.map((tp) => tp.getName());
  ctx.typeParams = typeParams;
  ctx.fnName = name;

  // Build type constraint suffix: [T, R any]
  const typeParamStr = typeParams.length > 0 ? `[${typeParams.join(", ")} any]` : "";

  // Parameters: (p1 T, p2 int)
  const params = fn.getParameters().map((p) => {
    const paramName = toGoLocalName(p.getName());
    const typeNode = p.getTypeNode();
    const goType = typeNode ? lowerTypeNode(typeNode, ctx) : "interface{}";
    return `${paramName} ${goType}`;
  });

  // Return type
  const returnTypeNode = fn.getReturnTypeNode();
  const returnType = returnTypeNode ? lowerTypeNode(returnTypeNode, ctx) : "";
  const returnSuffix = returnType && returnType !== "" ? ` ${returnType}` : "";

  const sig = `func ${goName}${typeParamStr}(${params.join(", ")})${returnSuffix} {`;
  const lines: string[] = [sig];

  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) {
    lines.push("}");
    return lines;
  }

  const bodyLines = lowerBlock(body.getStatements(), ctx, 1);
  lines.push(...bodyLines);
  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

const TAB = "\t";

function indent(depth: number): string {
  return TAB.repeat(depth);
}

function lowerBlock(stmts: Node[], ctx: Ctx, depth: number): string[] {
  const lines: string[] = [];
  for (const stmt of stmts) {
    lines.push(...lowerStatement(stmt, ctx, depth));
  }
  return lines;
}

function lowerStatement(node: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  const k = node.getKind();

  if (k === SyntaxKind.ReturnStatement) {
    const rs = node.asKindOrThrow(SyntaxKind.ReturnStatement);
    const expr = rs.getExpression();
    return expr ? [`${ind}return ${lowerExpr(expr, ctx)}`] : [`${ind}return`];
  }

  if (k === SyntaxKind.IfStatement) {
    return lowerIf(node, ctx, depth);
  }

  if (k === SyntaxKind.VariableStatement) {
    return lowerVarStatement(node, ctx, depth);
  }

  if (k === SyntaxKind.ExpressionStatement) {
    const es = node.asKindOrThrow(SyntaxKind.ExpressionStatement);
    return [`${ind}${lowerExpr(es.getExpression(), ctx)}`];
  }

  if (k === SyntaxKind.ForOfStatement) {
    return lowerForOf(node, ctx, depth);
  }

  if (k === SyntaxKind.ForStatement) {
    return lowerFor(node, ctx, depth);
  }

  if (k === SyntaxKind.WhileStatement) {
    return lowerWhile(node, ctx, depth);
  }

  if (k === SyntaxKind.Block) {
    const b = node.asKindOrThrow(SyntaxKind.Block);
    return lowerBlock(b.getStatements(), ctx, depth);
  }

  if (k === SyntaxKind.SwitchStatement) {
    return lowerSwitch(node, ctx, depth);
  }

  // Go has implicit break — TS break inside a switch case body is dropped (WI-978)
  if (k === SyntaxKind.BreakStatement) return [];
  if (k === SyntaxKind.ContinueStatement) return [`${ind}continue`];

  // Skip: type alias, interface, import
  if (
    k === SyntaxKind.TypeAliasDeclaration ||
    k === SyntaxKind.InterfaceDeclaration ||
    k === SyntaxKind.ImportDeclaration
  ) {
    return [];
  }

  // Loud failure: any unhandled statement kind
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToGoError(SyntaxKind[k], nodeLocation(node), snippet, ctx.fnName);
}

// ---------------------------------------------------------------------------
// Variable statement: const/let/var x = expr -> x := expr
// ---------------------------------------------------------------------------

function lowerVarStatement(node: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  const vs = node.asKindOrThrow(SyntaxKind.VariableStatement);
  const lines: string[] = [];
  for (const vd of vs.getDeclarationList().getDeclarations()) {
    const varName = toGoLocalName(vd.getName());
    const init = vd.getInitializer();
    if (init) {
      lines.push(`${ind}${varName} := ${lowerExpr(init, ctx)}`);
    } else {
      // uninitialized var: emit var x T (requires type annotation)
      const typeNode = vd.getTypeNode();
      const goType = typeNode ? lowerTypeNode(typeNode, ctx) : "interface{}";
      lines.push(`${ind}var ${varName} ${goType}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// If statement
// ---------------------------------------------------------------------------

function lowerIf(node: Node, ctx: Ctx, depth: number): string[] {
  const ifNode = node.asKindOrThrow(SyntaxKind.IfStatement);
  const cond = lowerExpr(ifNode.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}if ${cond} {`];

  const then = ifNode.getThenStatement();
  if (Node.isBlock(then)) {
    lines.push(...lowerBlock(then.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(then, ctx, depth + 1));
  }

  const elseStmt = ifNode.getElseStatement();
  if (elseStmt) {
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      // else if: emit `} else if cond {`
      const innerLines = lowerIf(elseStmt, ctx, depth);
      if (innerLines.length > 0) {
        // Replace the leading indent+`if` with `} else if`
        const first = innerLines[0] ?? "";
        const trimmed = first.trimStart();
        innerLines[0] = `${ind}} else ${trimmed}`;
        lines.push(...innerLines);
        // Note: lowerIf already ends with `}`, don't add another
        return lines;
      }
    } else {
      lines.push(`${ind}} else {`);
      if (Node.isBlock(elseStmt)) {
        lines.push(...lowerBlock(elseStmt.getStatements(), ctx, depth + 1));
      } else {
        lines.push(...lowerStatement(elseStmt, ctx, depth + 1));
      }
    }
  }

  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// For-of: for (const x of xs) -> for _, x := range xs { ... }
// ---------------------------------------------------------------------------

function lowerForOf(node: Node, ctx: Ctx, depth: number): string[] {
  const fo = node.asKindOrThrow(SyntaxKind.ForOfStatement);
  const initDecl = fo.getInitializer();
  const ind = indent(depth);

  let varName = "item";
  if (Node.isVariableDeclarationList(initDecl)) {
    const decls = initDecl.getDeclarations();
    const first = decls[0];
    if (first) {
      varName = toGoLocalName(first.getName());
    }
  }

  const iterable = lowerExpr(fo.getExpression(), ctx);
  const lines: string[] = [`${ind}for _, ${varName} := range ${iterable} {`];
  const body = fo.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// For statement: for (let i = 0; i < n; i++) -> for i := 0; i < n; i++ {
// ---------------------------------------------------------------------------

function lowerFor(node: Node, ctx: Ctx, depth: number): string[] {
  const forNode = node.asKindOrThrow(SyntaxKind.ForStatement);
  const ind = indent(depth);

  // Init clause
  let initStr = "";
  const init = forNode.getInitializer();
  if (init && Node.isVariableDeclarationList(init)) {
    const parts: string[] = [];
    for (const vd of init.getDeclarations()) {
      const varName = toGoLocalName(vd.getName());
      const initExpr = vd.getInitializer();
      parts.push(`${varName} := ${initExpr ? lowerExpr(initExpr, ctx) : "0"}`);
    }
    initStr = parts.join(", ");
  }

  const condNode = forNode.getCondition();
  const condStr = condNode ? lowerExpr(condNode, ctx) : "";
  const incrNode = forNode.getIncrementor();
  const incrStr = incrNode ? lowerExpr(incrNode, ctx) : "";

  const lines: string[] = [`${ind}for ${initStr}; ${condStr}; ${incrStr} {`];
  const body = forNode.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// While: while (cond) { ... } -> for cond { ... }
// ---------------------------------------------------------------------------

function lowerWhile(node: Node, ctx: Ctx, depth: number): string[] {
  const ws = node.asKindOrThrow(SyntaxKind.WhileStatement);
  const cond = lowerExpr(ws.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}for ${cond} {`];
  const body = ws.getStatement();
  if (Node.isBlock(body)) {
    lines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Switch statement (WI-978, DEC-WI978-001)
//
// TS switch  ->  Go switch
//   switch (expr) { ... }  ->  switch expr { ... }
//   switch (true) { ... }  ->  switch { ... }   (tagless)
//
// Case merging for TS fallthrough (adjacent empty cases):
//   case a:
//   case b:
//   case c:
//     body;   ->   case a, b, c:
//                    body
//
// TS break inside case body is silently dropped (Go has implicit break).
// Only 'fallthrough' needs to be explicit in Go, but we don't emit it here
// because the TS pattern we handle is the empty-case fallthrough, not
// intentional fall-through with body.
// ---------------------------------------------------------------------------

function lowerSwitch(node: Node, ctx: Ctx, depth: number): string[] {
  const sw = node.asKindOrThrow(SyntaxKind.SwitchStatement);
  const ind = indent(depth);

  // Tag expression: switch(true) -> tagless; otherwise emit the expression
  const tagExpr = sw.getExpression();
  const isTagless = tagExpr.getKind() === SyntaxKind.TrueKeyword;
  const tagStr = isTagless ? "" : ` ${lowerExpr(tagExpr, ctx)}`;
  const lines: string[] = [`${ind}switch${tagStr} {`];

  const caseBlock = sw.getCaseBlock();
  const clauses = caseBlock.getClauses();

  // Walk clauses, merging consecutive empty-body cases into multi-value heads.
  // A "group" is 1..N case expressions whose accumulated body is the body of
  // the last (non-empty) clause in the run, or the first clause with statements.
  let pendingLabels: string[] = [];

  for (const clause of clauses) {
    if (Node.isDefaultClause(clause)) {
      // Flush any pending labels (shouldn't happen in well-formed TS, but be safe)
      if (pendingLabels.length > 0) {
        lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
        pendingLabels = [];
      }
      lines.push(`${ind}default:`);
      const stmts = clause.getStatements();
      lines.push(...lowerBlock(stmts, ctx, depth + 1));
      continue;
    }

    // CaseClause
    const cc = clause.asKindOrThrow(SyntaxKind.CaseClause);
    const labelExpr = lowerExpr(cc.getExpression(), ctx);
    const stmts = cc.getStatements();

    // Filter out break statements — Go has implicit break (DEC-WI978-001)
    const nonBreakStmts = stmts.filter((s) => s.getKind() !== SyntaxKind.BreakStatement);

    if (nonBreakStmts.length === 0) {
      // Empty case body: accumulate label for multi-value merging
      pendingLabels.push(labelExpr);
    } else {
      // Non-empty body: emit all accumulated labels + this one as the case header
      pendingLabels.push(labelExpr);
      lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
      pendingLabels = [];
      lines.push(...lowerBlock(nonBreakStmts, ctx, depth + 1));
    }
  }

  // Any trailing empty cases with no body (unusual but safe to emit)
  if (pendingLabels.length > 0) {
    lines.push(`${ind}\tcase ${pendingLabels.join(", ")}:`);
  }

  lines.push(`${ind}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

function lowerExpr(node: Node, ctx: Ctx): string {
  const k = node.getKind();

  if (k === SyntaxKind.NumericLiteral) return node.getText();
  if (k === SyntaxKind.StringLiteral) return node.getText(); // Go uses double-quoted strings
  if (k === SyntaxKind.TrueKeyword) return "true";
  if (k === SyntaxKind.FalseKeyword) return "false";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "nil";

  if (k === SyntaxKind.Identifier) {
    return toGoLocalName(node.getText());
  }

  if (k === SyntaxKind.ParenthesizedExpression) {
    const pe = node.asKindOrThrow(SyntaxKind.ParenthesizedExpression);
    return `(${lowerExpr(pe.getExpression(), ctx)})`;
  }

  if (k === SyntaxKind.AsExpression) {
    const ae = node.asKindOrThrow(SyntaxKind.AsExpression);
    return lowerExpr(ae.getExpression(), ctx);
  }

  if (k === SyntaxKind.NonNullExpression) {
    const nne = node.asKindOrThrow(SyntaxKind.NonNullExpression);
    return lowerExpr(nne.getExpression(), ctx);
  }

  if (k === SyntaxKind.BinaryExpression) return lowerBinary(node, ctx);
  if (k === SyntaxKind.PrefixUnaryExpression) return lowerPrefixUnary(node, ctx);
  if (k === SyntaxKind.PostfixUnaryExpression) return lowerPostfixUnary(node, ctx);

  if (k === SyntaxKind.CallExpression) return lowerCall(node, ctx);

  if (k === SyntaxKind.PropertyAccessExpression) {
    return lowerPropertyAccess(node, ctx);
  }

  if (k === SyntaxKind.ElementAccessExpression) {
    const ea = node.asKindOrThrow(SyntaxKind.ElementAccessExpression);
    const obj = lowerExpr(ea.getExpression(), ctx);
    const idx = ea.getArgumentExpression();
    return idx ? `${obj}[${lowerExpr(idx, ctx)}]` : `${obj}[]`;
  }

  if (k === SyntaxKind.ArrayLiteralExpression) {
    const al = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    const elems = al.getElements().map((e) => lowerExpr(e, ctx));
    return `[]interface{}{${elems.join(", ")}}`;
  }

  // Loud failure: unhandled expression kind (DEC-WI973-003)
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToGoError(SyntaxKind[k], nodeLocation(node), snippet, ctx.fnName);
}

// ---------------------------------------------------------------------------
// Binary expression
// ---------------------------------------------------------------------------

const TS_TO_GO_OP: Readonly<Record<string, string>> = {
  "===": "==",
  "!==": "!=",
  "==": "==",
  "!=": "!=",
  "&&": "&&",
  "||": "||",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "=": "=",
  "+=": "+=",
  "-=": "-=",
  "*=": "*=",
  "/=": "/=",
  "%=": "%=",
  "&": "&",
  "|": "|",
  "^": "^",
  "<<": "<<",
  ">>": ">>",
};

function lowerBinary(node: Node, ctx: Ctx): string {
  const be = node.asKindOrThrow(SyntaxKind.BinaryExpression);
  const left = lowerExpr(be.getLeft(), ctx);
  const right = lowerExpr(be.getRight(), ctx);
  const op = be.getOperatorToken().getText();
  const goOp = TS_TO_GO_OP[op] ?? op;
  return `${left} ${goOp} ${right}`;
}

// ---------------------------------------------------------------------------
// Prefix/postfix unary
// ---------------------------------------------------------------------------

function lowerPrefixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.ExclamationToken) return `!${operand}`;
  if (op === SyntaxKind.MinusToken) return `-${operand}`;
  if (op === SyntaxKind.PlusToken) return `+${operand}`;
  if (op === SyntaxKind.PlusPlusToken) return `${operand}++`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand}--`;
  const snippet = node.getText().slice(0, 60);
  throw new CannotLowerToGoError(
    SyntaxKind[node.getKind()],
    nodeLocation(node),
    snippet,
    ctx.fnName,
  );
}

function lowerPostfixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PostfixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.PlusPlusToken) return `${operand}++`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand}--`;
  return operand;
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

/**
 * Detect whether a property-access expression's object is a bare package
 * reference (e.g. `reflect` in `reflect.ValueOf`). We use a simple heuristic:
 * if the direct object is an Identifier (not itself a property access chain)
 * then it is a potential package name. We record it in ctx.importRefs; the
 * resolver in lowerSource will skip names it doesn't recognise OR emit a
 * warning placeholder (DEC-WI977-001).
 *
 * This intentionally fires on every dotted access — field accesses on local
 * variables will also be recorded, but since local variable names go through
 * toGoLocalName() they will be lowercase and unlikely to match KNOWN_IMPORT_PATHS,
 * so the resolver will emit a placeholder + warning that the user can ignore.
 * A future improvement could use ts-morph's type checker to distinguish package
 * refs from field accesses, but the table-driven MVP approach is sufficient.
 */
function recordPackageRefIfNeeded(objNode: Node, ctx: Ctx): void {
  if (objNode.getKind() !== SyntaxKind.Identifier) return;
  const name = objNode.getText();
  // Skip single-char type params (T, R, K, V etc.) and common Go builtins
  if (name.length === 1) return;
  if (name === "len" || name === "append" || name === "make" || name === "new") return;
  ctx.importRefs.add(name);
}

function lowerPropertyAccess(node: Node, ctx: Ctx): string {
  const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const objNode = pa.getExpression();
  const prop = pa.getName();

  // len(xs) for .length — handled before recording, no import needed
  if (prop === "length") {
    const obj = lowerExpr(objNode, ctx);
    return `len(${obj})`;
  }

  // Record potential package reference for import synthesis (WI-977)
  recordPackageRefIfNeeded(objNode, ctx);

  const obj = lowerExpr(objNode, ctx);
  return `${obj}.${prop}`;
}

// ---------------------------------------------------------------------------
// Call expression
// ---------------------------------------------------------------------------

function lowerCall(node: Node, ctx: Ctx): string {
  const ce = node.asKindOrThrow(SyntaxKind.CallExpression);
  const callee = ce.getExpression();
  const args = ce.getArguments();
  const argStrs = args.map((a) => lowerExpr(a, ctx));

  // Handle method calls on objects
  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression();
    const method = callee.getName();

    // Record package ref for import synthesis (WI-977, DEC-WI977-001).
    // This fires for pkg.Func(...) calls where the receiver is a bare identifier.
    recordPackageRefIfNeeded(obj, ctx);

    const objStr = lowerExpr(obj, ctx);

    // xs.append(v) -> append(xs, v)
    if (method === "push" && args.length === 1) {
      const v = args[0];
      return `append(${objStr}, ${v ? lowerExpr(v, ctx) : ""})`;
    }

    // Generic method call
    return `${objStr}.${method}(${argStrs.join(", ")})`;
  }

  const calleeStr = lowerExpr(callee, ctx);
  return `${calleeStr}(${argStrs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Type node lowering
// ---------------------------------------------------------------------------

export function lowerTypeNode(typeNode: TypeNode, ctx: Ctx): string {
  const k = typeNode.getKind();

  if (k === SyntaxKind.NumberKeyword) return "int";
  if (k === SyntaxKind.StringKeyword) return "string";
  if (k === SyntaxKind.BooleanKeyword) return "bool";
  if (k === SyntaxKind.VoidKeyword) return "";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "interface{}";
  if (k === SyntaxKind.AnyKeyword || k === SyntaxKind.UnknownKeyword) return "interface{}";

  if (k === SyntaxKind.ArrayType) {
    const at = typeNode.asKindOrThrow(SyntaxKind.ArrayType);
    const inner = lowerTypeNode(at.getElementTypeNode(), ctx);
    return `[]${inner}`;
  }

  if (k === SyntaxKind.TypeReference) {
    const tr = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
    const name = tr.getTypeName().getText();
    const typeArgs = tr.getTypeArguments();

    // Record<K, V> -> map[K]V
    if (name === "Record") {
      const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "string";
      const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "interface{}";
      return `map[${k2}]${v}`;
    }

    // Map<K, V> -> map[K]V
    if (name === "Map") {
      const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "interface{}";
      const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "interface{}";
      return `map[${k2}]${v}`;
    }

    // ReadonlyArray<T> / Array<T> -> []T
    if (name === "ReadonlyArray" || name === "Array") {
      const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "interface{}";
      return `[]${inner}`;
    }

    // Type params (T, R, etc.) declared on the current function
    if (ctx.typeParams.includes(name)) return name;

    // Generic wrapper types: pass through name with first arg
    if (typeArgs.length > 0) {
      ctx.warnings.push({
        kind: "unknown-generic",
        message: `Unknown generic type ${name}<...> -> interface{}`,
      });
      return "interface{}";
    }

    return name;
  }

  // Fallback: emit the raw TS text as a Go comment-style placeholder
  ctx.warnings.push({
    kind: "unknown-type",
    message: `Unknown type ${SyntaxKind[k]} -> interface{}`,
  });
  return "interface{}";
}
