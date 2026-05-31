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
 *     Stmts:  return, if/else, const/let/var -> :=, ExpressionStatement
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
 */

import { CannotLowerToGoError } from "@yakcc/contracts";
import { type FunctionDeclaration, Node, Project, SyntaxKind, type TypeNode } from "ts-morph";
import { toGoExportedName, toGoLocalName } from "./names.js";

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

  const ctx: Ctx = { warnings: [], typeParams: [] };
  const goLines: string[] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const fnLines = lowerFunctionDecl(stmt, ctx);
      goLines.push(...fnLines);
      goLines.push("");
    }
    // type aliases, import declarations, and comments are silently skipped
  }

  return { goLines, warnings: ctx.warnings };
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

  if (k === SyntaxKind.BreakStatement) return [`${ind}break`];
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

function lowerPropertyAccess(node: Node, ctx: Ctx): string {
  const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = lowerExpr(pa.getExpression(), ctx);
  const prop = pa.getName();

  // len(xs) for .length
  if (prop === "length") return `len(${obj})`;

  // For other properties, emit Go field access
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
