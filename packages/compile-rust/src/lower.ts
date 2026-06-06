// SPDX-License-Identifier: Apache-2.0
/**
 * Lower TS-subset IR source to idiomatic Rust source.
 *
 * Entry point: lowerSource(implSource) -> RustLowerResult
 * Consumers call compileToRust() (compile-rust.ts) which wraps lowerSource.
 *
 * @decision DEC-POLYGLOT-RUST-COMPILE-001
 * @title IR->Rust lowering uses ts-morph AST walk; all emitted constructs from MVP table
 * @status decided (Slice 1)
 * @rationale
 *   ts-morph gives exact typed AST nodes identical to those the strict-subset
 *   validator already accepts, so we inherit the validator's guarantees: only
 *   pure-function constructs, no async, no DOM, no eval. The emitter therefore
 *   does not need to defensively guard against constructs the validator already
 *   blocks at shave-time.
 *
 *   Rust MVP mapping table (Slice 1):
 *     Types:  number -> i32 (DEFAULT; lossy for floats -- Slice 2 adds hints)
 *             string -> String, boolean -> bool,
 *             T[] -> Vec<T>, T | null -> Option<T>
 *     Stmts:  return, if/else, const/let -> let binding
 *     Exprs:  numeric literal, string literal, bool literal, identifier,
 *             BinaryExpr, PrefixUnary (!/-), Call, PropertyAccess
 *     Fn:     pub fn name(params) -> ReturnType { body }
 *
 *   Everything else -> CannotLowerToRustError (loud failure).
 *
 *   Type mapping note (DEC-POLYGLOT-RUST-COMPILE-001):
 *     number -> i32 is the DEFAULT in Slice 1. This is intentionally lossy
 *     for float values -- float/width hints are deferred to Slice 2.
 *     The inverse of shave-rust's type-map.ts maps all integer types to number;
 *     we default back to i32 as the most common integer type. Callers that need
 *     a different width can pass a type-hint in Slice 2.
 */

import { Node, Project, SyntaxKind, type TypeNode } from "ts-morph";
import {
  CannotLowerToRustError,
  RustUnsupportedExprError,
  RustUnsupportedStmtError,
  RustUnsupportedTypeError,
} from "./errors.js";
import { toRustFunctionName, toRustLocalName } from "./names.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RustLowerWarning {
  readonly kind: string;
  readonly message: string;
}

export interface RustLowerResult {
  /** Emitted Rust source lines (no module preamble). */
  rustLines: string[];
  warnings: RustLowerWarning[];
}

/**
 * Lower a TS-subset IR source string to Rust lines.
 * Returned rustLines do NOT include a module declaration; callers assemble the
 * full file by prepending any needed attributes.
 */
export function lowerSource(implSource: string): RustLowerResult {
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

  const ctx: Ctx = { warnings: [], fnName: undefined };
  const rustLines: string[] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const fnLines = lowerFunctionDecl(stmt, ctx);
      rustLines.push(...fnLines);
      rustLines.push("");
    }
    // type aliases, import declarations, and comments are silently skipped
  }

  return { rustLines, warnings: ctx.warnings };
}

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface Ctx {
  warnings: RustLowerWarning[];
  fnName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Location helper
// ---------------------------------------------------------------------------

function nodeLocation(node: Node): { line: number; column: number } {
  const pos = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return { line: pos.line, column: pos.column };
}

// ---------------------------------------------------------------------------
// Function declaration
// ---------------------------------------------------------------------------

/**
 * Lower a TS function declaration to a Rust fn declaration.
 *
 * TS:  export function add(a: number, b: number): number { return a + b; }
 * Rust: pub fn add(a: i32, b: i32) -> i32 { a + b }
 */
function lowerFunctionDecl(fn: import("ts-morph").FunctionDeclaration, ctx: Ctx): string[] {
  const name = fn.getName() ?? "unknown";
  const rustName = toRustFunctionName(name);
  ctx.fnName = name;

  // Parameters: (a: i32, b: i32)
  const params = fn.getParameters().map((p) => {
    const paramName = toRustLocalName(p.getName());
    const typeNode = p.getTypeNode();
    const rustType = typeNode ? lowerTypeNode(typeNode, ctx) : "i32";
    return `${paramName}: ${rustType}`;
  });

  // Return type
  const returnTypeNode = fn.getReturnTypeNode();
  const returnType = returnTypeNode ? lowerTypeNode(returnTypeNode, ctx) : "";
  const returnSuffix = returnType && returnType !== "()" ? ` -> ${returnType}` : "";

  const sig = `pub fn ${rustName}(${params.join(", ")})${returnSuffix} {`;
  const lines: string[] = [sig];

  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) {
    lines.push("}");
    return lines;
  }

  const stmts = body.getStatements();
  const bodyLines = lowerBlock(stmts, ctx, 1);
  lines.push(...bodyLines);
  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

const INDENT = "    "; // 4-space indent (Rust style)

function indent(depth: number): string {
  return INDENT.repeat(depth);
}

function lowerBlock(stmts: Node[], ctx: Ctx, depth: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (!stmt) continue;
    const isLast = i === stmts.length - 1;
    lines.push(...lowerStatement(stmt, ctx, depth, isLast));
  }
  return lines;
}

function lowerStatement(node: Node, ctx: Ctx, depth: number, isLast: boolean): string[] {
  const ind = indent(depth);
  const k = node.getKind();

  if (k === SyntaxKind.ReturnStatement) {
    const rs = node.asKindOrThrow(SyntaxKind.ReturnStatement);
    const expr = rs.getExpression();
    if (!expr) return [`${ind}return;`];
    // Explicit return: emit `return expr;`
    return [`${ind}return ${lowerExpr(expr, ctx)};`];
  }

  if (k === SyntaxKind.IfStatement) {
    return lowerIf(node, ctx, depth);
  }

  if (k === SyntaxKind.VariableStatement) {
    return lowerVarStatement(node, ctx, depth);
  }

  if (k === SyntaxKind.ExpressionStatement) {
    const es = node.asKindOrThrow(SyntaxKind.ExpressionStatement);
    const exprStr = lowerExpr(es.getExpression(), ctx);
    // If last statement in a void function body, emit without semicolon as expression
    // (Rust tail-expression for unit-return). Add semicolon for expression-as-statement.
    if (isLast) {
      return [`${ind}${exprStr}`];
    }
    return [`${ind}${exprStr};`];
  }

  if (k === SyntaxKind.Block) {
    const b = node.asKindOrThrow(SyntaxKind.Block);
    return lowerBlock(b.getStatements(), ctx, depth);
  }

  // Skip: type alias, interface, import
  if (
    k === SyntaxKind.TypeAliasDeclaration ||
    k === SyntaxKind.InterfaceDeclaration ||
    k === SyntaxKind.ImportDeclaration
  ) {
    return [];
  }

  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new RustUnsupportedStmtError(
    SyntaxKind[k] ?? "Unknown",
    nodeLocation(node),
    snippet,
    ctx.fnName,
  );
}

// ---------------------------------------------------------------------------
// Variable statement: const/let x = expr -> let x = expr;
// ---------------------------------------------------------------------------

function lowerVarStatement(node: Node, ctx: Ctx, depth: number): string[] {
  const ind = indent(depth);
  const vs = node.asKindOrThrow(SyntaxKind.VariableStatement);
  const lines: string[] = [];
  for (const vd of vs.getDeclarationList().getDeclarations()) {
    const varName = toRustLocalName(vd.getName());
    const init = vd.getInitializer();
    const typeNode = vd.getTypeNode();
    if (init) {
      if (typeNode) {
        const rustType = lowerTypeNode(typeNode, ctx);
        const initStr = lowerExpr(init, ctx);
        lines.push(`${ind}let ${varName}: ${rustType} = ${initStr};`);
      } else {
        const initStr = lowerExpr(init, ctx);
        lines.push(`${ind}let ${varName} = ${initStr};`);
      }
    } else {
      // Uninitialized var -- requires type annotation in Rust
      const rustType = typeNode ? lowerTypeNode(typeNode, ctx) : "i32";
      lines.push(`${ind}let ${varName}: ${rustType};`);
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
    lines.push(...lowerStatement(then, ctx, depth + 1, false));
  }

  const elseStmt = ifNode.getElseStatement();
  if (elseStmt) {
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      const innerLines = lowerIf(elseStmt, ctx, depth);
      if (innerLines.length > 0) {
        const first = innerLines[0] ?? "";
        const trimmed = first.trimStart();
        innerLines[0] = `${ind}} else ${trimmed}`;
        lines.push(...innerLines);
        return lines;
      }
    } else {
      lines.push(`${ind}} else {`);
      if (Node.isBlock(elseStmt)) {
        lines.push(...lowerBlock(elseStmt.getStatements(), ctx, depth + 1));
      } else {
        lines.push(...lowerStatement(elseStmt, ctx, depth + 1, false));
      }
    }
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
  if (k === SyntaxKind.StringLiteral) {
    // TS string literal: "hello" -> Rust string literal: "hello".to_string()
    // We need an owned String for function returns; borrow as &str is Slice 2.
    const text = node.getText();
    return `${text}.to_string()`;
  }
  if (k === SyntaxKind.TrueKeyword) return "true";
  if (k === SyntaxKind.FalseKeyword) return "false";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "None";

  if (k === SyntaxKind.Identifier) {
    return toRustLocalName(node.getText());
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

  if (k === SyntaxKind.CallExpression) return lowerCall(node, ctx);

  if (k === SyntaxKind.PropertyAccessExpression) {
    return lowerPropertyAccess(node, ctx);
  }

  // Loud failure: unhandled expression kind
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new RustUnsupportedExprError(
    SyntaxKind[k] ?? "Unknown",
    nodeLocation(node),
    snippet,
    ctx.fnName,
  );
}

// ---------------------------------------------------------------------------
// Binary expression
// ---------------------------------------------------------------------------

// TS operator -> Rust operator mapping
const TS_TO_RUST_OP: Readonly<Record<string, string>> = {
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
  const rustOp = TS_TO_RUST_OP[op] ?? op;
  return `${left} ${rustOp} ${right}`;
}

// ---------------------------------------------------------------------------
// Prefix unary
// ---------------------------------------------------------------------------

function lowerPrefixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.ExclamationToken) return `!${operand}`;
  if (op === SyntaxKind.MinusToken) return `-${operand}`;
  if (op === SyntaxKind.PlusToken) return `+${operand}`;
  const snippet = node.getText().slice(0, 60);
  throw new CannotLowerToRustError(
    SyntaxKind[node.getKind()] ?? "Unknown",
    nodeLocation(node),
    snippet,
    ctx.fnName,
  );
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

function lowerPropertyAccess(node: Node, ctx: Ctx): string {
  const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const objNode = pa.getExpression();
  const prop = pa.getName();

  // .length -> .len() in Rust
  if (prop === "length") {
    const obj = lowerExpr(objNode, ctx);
    return `${obj}.len()`;
  }

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

  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression();
    const method = callee.getName();
    const objStr = lowerExpr(obj, ctx);

    // xs.push(v) -> xs.push(v)  (Vec push in Rust)
    if (method === "push" && args.length === 1) {
      const v = args[0];
      return `${objStr}.push(${v ? lowerExpr(v, ctx) : ""})`;
    }

    // Generic method call: obj.method(args...)
    return `${objStr}.${method}(${argStrs.join(", ")})`;
  }

  const calleeStr = lowerExpr(callee, ctx);
  return `${calleeStr}(${argStrs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Type node lowering
// ---------------------------------------------------------------------------

/**
 * Map a TS-subset IR type node to a Rust type string.
 *
 * Type mapping (inverse of shave-rust type-map.ts):
 *   number   -> i32  (DEFAULT; lossy for floats -- Slice 2 adds hints)
 *   string   -> String
 *   boolean  -> bool
 *   void     -> () [function return position]
 *   T[]      -> Vec<T>
 *   null     -> Option<T> (handled by union check in canLowerTo)
 *   any/unknown -> handled conservatively
 */
export function lowerTypeNode(typeNode: TypeNode, ctx: Ctx): string {
  const k = typeNode.getKind();

  if (k === SyntaxKind.NumberKeyword) return "i32";
  if (k === SyntaxKind.StringKeyword) return "String";
  if (k === SyntaxKind.BooleanKeyword) return "bool";
  if (k === SyntaxKind.VoidKeyword) return "()";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "()";
  if (k === SyntaxKind.AnyKeyword || k === SyntaxKind.UnknownKeyword) {
    ctx.warnings.push({
      kind: "unknown-type",
      message: "any/unknown -> i32 (default; review needed)",
    });
    return "i32";
  }

  if (k === SyntaxKind.ArrayType) {
    const at = typeNode.asKindOrThrow(SyntaxKind.ArrayType);
    const inner = lowerTypeNode(at.getElementTypeNode(), ctx);
    return `Vec<${inner}>`;
  }

  if (k === SyntaxKind.TypeReference) {
    const tr = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
    const name = tr.getTypeName().getText();
    const typeArgs = tr.getTypeArguments();

    // Option<T> (from T | null / T | undefined -- canLowerTo blocks union types,
    // but callers may explicitly pass an Option-typed atom through a known path)
    if (name === "Option") {
      const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "i32";
      return `Option<${inner}>`;
    }

    // Vec<T>
    if (name === "Vec" || name === "Array" || name === "ReadonlyArray") {
      const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "i32";
      return `Vec<${inner}>`;
    }

    // Pass-through unknown type references with a warning
    ctx.warnings.push({
      kind: "unknown-type-ref",
      message: `Unknown type reference ${name} -> i32 (default)`,
    });
    return "i32";
  }

  // Fallback: emit a warning and use i32
  ctx.warnings.push({
    kind: "unknown-type",
    message: `Unknown type ${SyntaxKind[k] ?? "?"} -> i32 (default)`,
  });
  const snippet = typeNode.getText().slice(0, 40);
  throw new RustUnsupportedTypeError(snippet, nodeLocation(typeNode), snippet, ctx.fnName);
}
