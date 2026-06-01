// SPDX-License-Identifier: MIT
/**
 * Lower TS-subset IR source to idiomatic Python source.
 *
 * @decision DEC-POLYGLOT-COMPILE-PY-001
 * @title IR→Python lowering uses ts-morph AST walk; all emitted constructs
 *   drawn from the MVP mapping table in the polyglot ADR (Q3).
 * @status decided
 * @rationale
 *   ts-morph gives exact typed AST nodes identical to those the strict-subset
 *   validator already accepts, so we inherit the validator's guarantees: only
 *   pure-function constructs, no async, no DOM, no eval. The emitter therefore
 *   does not need to defensively guard against constructs the validator already
 *   blocks at shave-time.
 */

import { CannotLowerToPythonError } from "@yakcc/contracts";
import { type FunctionDeclaration, Node, Project, SyntaxKind, type TypeNode } from "ts-morph";
import { toSnakeCase } from "./names.js";
import type { LowerWarning } from "./types.js";

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface Ctx {
  warnings: LowerWarning[];
  needsFunctools: boolean;
  needsOptional: boolean;
  needsCallable: boolean;
}

// ---------------------------------------------------------------------------
// Location helper
// ---------------------------------------------------------------------------

/**
 * Extract {line, column} from a ts-morph Node using the source file's
 * getLineAndColumnAtPos API. Line and column are 1-based.
 */
function nodeLocation(node: Node): { line: number; column: number } {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface LowerResult {
  pyLines: string[];
  needsFunctools: boolean;
  needsOptional: boolean;
  needsCallable: boolean;
  warnings: LowerWarning[];
}

/**
 * Lower a TS-subset IR source string to Python lines.
 * Returned pyLines do NOT include the import block; callers prepend imports.
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

  const ctx: Ctx = {
    warnings: [],
    needsFunctools: false,
    needsOptional: false,
    needsCallable: false,
  };

  const pyLines: string[] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const fnLines = lowerFunctionDecl(stmt, ctx);
      pyLines.push(...fnLines);
      pyLines.push("");
    }
    // type aliases, import declarations, and comments are silently skipped
  }

  return {
    pyLines,
    needsFunctools: ctx.needsFunctools,
    needsOptional: ctx.needsOptional,
    needsCallable: ctx.needsCallable,
    warnings: ctx.warnings,
  };
}

// ---------------------------------------------------------------------------
// Function declaration
// ---------------------------------------------------------------------------

function lowerFunctionDecl(fn: FunctionDeclaration, ctx: Ctx): string[] {
  const name = fn.getName() ?? "unknown";
  // #941: use classMethToSnake for call sites to split "ClassName_methodName"
  // back to "ClassName.method_name".  But on the def line Python rejects dotted
  // names ("def ClassName.method_name(…)" is a SyntaxError) so we must keep
  // the underscore form for the definition itself.
  //
  // @decision DEC-946-001 — def line keeps underscore form; call sites use dotted form
  // @title lowerFunctionDecl uses underscore identifier on def line, not dotted
  // @status accepted (#946)
  // @rationale Python's grammar forbids dotted names in `def` declarations:
  //   `def EntitySubstitution.substitute_xml(…)` is a SyntaxError.  The dotted
  //   form produced by classMethToSnake is valid only at CALL sites.  For the
  //   def line we preserve the underscore-joined form (e.g.
  //   "EntitySubstitution_substitute_xml") which is syntactically valid Python,
  //   losing dot-qualification but producing compilable code.  Dot-qualified
  //   class-method grouping is tracked as a follow-up in #946.
  //   Cross-reference: #941, #946.
  // def line: keep underscore form (valid Python — dotted names are a SyntaxError in def)
  const pyDefName = toSnakeCase(name);

  const params = fn.getParameters().map((p) => {
    const paramName = toSnakeCase(p.getName());
    const typeNode = p.getTypeNode();
    const pyType = typeNode ? lowerTypeNode(typeNode, ctx) : "Any";
    return `${paramName}: ${pyType}`;
  });

  const returnTypeNode = fn.getReturnTypeNode();
  const pyReturn = returnTypeNode ? lowerTypeNode(returnTypeNode, ctx) : "None";

  const lines: string[] = [];
  lines.push(`def ${pyDefName}(${params.join(", ")}) -> ${pyReturn}:`);

  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) {
    lines.push("    pass");
    return lines;
  }

  const bodyLines = lowerBlock(body.getStatements(), ctx, 1);
  if (bodyLines.length === 0) {
    lines.push("    pass");
  } else {
    lines.push(...bodyLines);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

const IND = "    ";

function indent(depth: number): string {
  return IND.repeat(depth);
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

  if (k === SyntaxKind.IfStatement) {
    return lowerIf(node, ctx, depth);
  }

  if (k === SyntaxKind.WhileStatement) {
    const ws = node.asKindOrThrow(SyntaxKind.WhileStatement);
    const cond = lowerExpr(ws.getExpression(), ctx);
    const body = ws.getStatement();
    const lines: string[] = [`${ind}while ${cond}:`];
    if (Node.isBlock(body)) {
      const inner = lowerBlock(body.getStatements(), ctx, depth + 1);
      lines.push(...(inner.length > 0 ? inner : [`${indent(depth + 1)}pass`]));
    } else {
      lines.push(...lowerStatement(body, ctx, depth + 1));
    }
    return lines;
  }

  if (k === SyntaxKind.ReturnStatement) {
    const rs = node.asKindOrThrow(SyntaxKind.ReturnStatement);
    const expr = rs.getExpression();
    return expr ? [`${ind}return ${lowerExpr(expr, ctx)}`] : [`${ind}return`];
  }

  if (k === SyntaxKind.ThrowStatement) {
    const ts = node.asKindOrThrow(SyntaxKind.ThrowStatement);
    const expr = ts.getExpression();
    return expr ? [`${ind}raise ${lowerExpr(expr, ctx)}`] : [`${ind}raise`];
  }

  if (k === SyntaxKind.VariableStatement) {
    const vs = node.asKindOrThrow(SyntaxKind.VariableStatement);
    const lines: string[] = [];
    for (const vd of vs.getDeclarationList().getDeclarations()) {
      const varName = toSnakeCase(vd.getName());
      const init = vd.getInitializer();
      lines.push(init ? `${ind}${varName} = ${lowerExpr(init, ctx)}` : `${ind}${varName} = None`);
    }
    return lines;
  }

  if (k === SyntaxKind.ExpressionStatement) {
    const es = node.asKindOrThrow(SyntaxKind.ExpressionStatement);
    return [`${ind}${lowerExpr(es.getExpression(), ctx)}`];
  }

  if (k === SyntaxKind.BreakStatement) return [`${ind}break`];
  if (k === SyntaxKind.ContinueStatement) return [`${ind}continue`];

  if (k === SyntaxKind.ForOfStatement) return lowerForOf(node, ctx, depth);
  if (k === SyntaxKind.ForStatement) return lowerFor(node, ctx, depth);

  if (k === SyntaxKind.Block) {
    const b = node.asKindOrThrow(SyntaxKind.Block);
    return lowerBlock(b.getStatements(), ctx, depth);
  }

  // type alias / interface / import → skip
  if (
    k === SyntaxKind.TypeAliasDeclaration ||
    k === SyntaxKind.InterfaceDeclaration ||
    k === SyntaxKind.ImportDeclaration ||
    k === SyntaxKind.ImportEqualsDeclaration
  ) {
    return [];
  }

  // No silent fallback — throw a loud, actionable error (WI-943).
  // Any statement kind that reaches here has no Python equivalent yet;
  // the error names the node kind, location, and enclosing function so the
  // next implementer knows exactly what coverage is missing.
  const snippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToPythonError(SyntaxKind[k], nodeLocation(node), snippet, undefined);
}

// ---------------------------------------------------------------------------
// If statement
// ---------------------------------------------------------------------------

function lowerIf(node: Node, ctx: Ctx, depth: number): string[] {
  const ifNode = node.asKindOrThrow(SyntaxKind.IfStatement);
  const cond = lowerExpr(ifNode.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}if ${cond}:`];

  const then = ifNode.getThenStatement();
  if (Node.isBlock(then)) {
    const inner = lowerBlock(then.getStatements(), ctx, depth + 1);
    lines.push(...(inner.length > 0 ? inner : [`${indent(depth + 1)}pass`]));
  } else {
    lines.push(...lowerStatement(then, ctx, depth + 1));
  }

  const elseStmt = ifNode.getElseStatement();
  if (elseStmt) {
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      const elseLines = lowerIf(elseStmt, ctx, depth);
      if (elseLines.length > 0) {
        elseLines[0] = (elseLines[0] ?? "").replace(/^(\s*)if /, "$1elif ");
      }
      lines.push(...elseLines);
    } else {
      lines.push(`${ind}else:`);
      if (Node.isBlock(elseStmt)) {
        const inner = lowerBlock(elseStmt.getStatements(), ctx, depth + 1);
        lines.push(...(inner.length > 0 ? inner : [`${indent(depth + 1)}pass`]));
      } else {
        lines.push(...lowerStatement(elseStmt, ctx, depth + 1));
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// For-of statement
// ---------------------------------------------------------------------------

function lowerForOf(node: Node, ctx: Ctx, depth: number): string[] {
  const fo = node.asKindOrThrow(SyntaxKind.ForOfStatement);
  const initDecl = fo.getInitializer();
  // #916 — when the loop variable is a destructured array pattern [k, v],
  // emit bare tuple target "for k, v in" (no brackets — list patterns are a
  // syntax error in classic Python for-loops).
  let varName = "item";
  if (Node.isVariableDeclarationList(initDecl)) {
    const decls = initDecl.getDeclarations();
    const first = decls[0];
    if (first) {
      const nameNode = first.getNameNode();
      if (Node.isArrayBindingPattern(nameNode)) {
        // Extract each binding element name and join without brackets.
        // BindingElement.getName() returns the identifier text for simple
        // patterns like [k, v]; omitted elements become "_".
        const elemNames: string[] = [];
        for (const e of nameNode.getElements()) {
          if (Node.isBindingElement(e)) {
            elemNames.push(toSnakeCase(e.getName()));
          } else {
            // OmittedExpression (e.g. [, v]) — use underscore placeholder
            elemNames.push("_");
          }
        }
        varName = elemNames.length > 0 ? elemNames.join(", ") : "item";
      } else {
        varName = toSnakeCase(first.getName());
      }
    }
  }
  const iterable = lowerExpr(fo.getExpression(), ctx);
  const ind = indent(depth);
  const lines: string[] = [`${ind}for ${varName} in ${iterable}:`];
  const body = fo.getStatement();
  if (Node.isBlock(body)) {
    const inner = lowerBlock(body.getStatements(), ctx, depth + 1);
    lines.push(...(inner.length > 0 ? inner : [`${indent(depth + 1)}pass`]));
  } else {
    lines.push(...lowerStatement(body, ctx, depth + 1));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// For statement (lowered as while loop)
// ---------------------------------------------------------------------------

function lowerFor(node: Node, ctx: Ctx, depth: number): string[] {
  const forNode = node.asKindOrThrow(SyntaxKind.ForStatement);
  const init = forNode.getInitializer();
  const cond = forNode.getCondition();
  const incr = forNode.getIncrementor();
  const ind = indent(depth);
  const lines: string[] = [];

  if (init && Node.isVariableDeclarationList(init)) {
    for (const vd of init.getDeclarations()) {
      const varName = toSnakeCase(vd.getName());
      const initExpr = vd.getInitializer();
      lines.push(`${ind}${varName} = ${initExpr ? lowerExpr(initExpr, ctx) : "0"}`);
    }
  }

  const condStr = cond ? lowerExpr(cond, ctx) : "True";
  lines.push(`${ind}while ${condStr}:`);

  const bodyLines: string[] = [];
  const body = forNode.getStatement();
  if (Node.isBlock(body)) {
    bodyLines.push(...lowerBlock(body.getStatements(), ctx, depth + 1));
  } else {
    bodyLines.push(...lowerStatement(body, ctx, depth + 1));
  }
  if (incr) bodyLines.push(`${indent(depth + 1)}${lowerExpr(incr, ctx)}`);

  lines.push(...(bodyLines.length > 0 ? bodyLines : [`${indent(depth + 1)}pass`]));
  return lines;
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

function lowerExpr(node: Node, ctx: Ctx): string {
  const k = node.getKind();

  if (k === SyntaxKind.NumericLiteral) return node.getText();

  if (k === SyntaxKind.StringLiteral) return pyStringLiteral(node.getText());

  if (k === SyntaxKind.TrueKeyword) return "True";
  if (k === SyntaxKind.FalseKeyword) return "False";
  if (k === SyntaxKind.NullKeyword) return "None";
  if (k === SyntaxKind.UndefinedKeyword) return "None";

  if (k === SyntaxKind.Identifier) {
    const text = node.getText();
    // PascalCase identifiers are class/type names — preserve them unchanged.
    // camelCase identifiers (starting lowercase) are converted to snake_case.
    const firstChar = text[0];
    if (
      firstChar &&
      firstChar === firstChar.toUpperCase() &&
      firstChar !== firstChar.toLowerCase()
    ) {
      return text;
    }
    return toSnakeCase(text);
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

  if (k === SyntaxKind.SatisfiesExpression) {
    // x satisfies T → x
    const inner = node.getChildAtIndex(0);
    return inner ? lowerExpr(inner, ctx) : node.getText();
  }

  if (k === SyntaxKind.PrefixUnaryExpression) return lowerPrefixUnary(node, ctx);
  if (k === SyntaxKind.PostfixUnaryExpression) return lowerPostfixUnary(node, ctx);
  if (k === SyntaxKind.BinaryExpression) return lowerBinary(node, ctx);

  if (k === SyntaxKind.ConditionalExpression) {
    const ce = node.asKindOrThrow(SyntaxKind.ConditionalExpression);
    const c = lowerExpr(ce.getCondition(), ctx);
    const whenTrue = lowerExpr(ce.getWhenTrue(), ctx);
    const whenFalse = lowerExpr(ce.getWhenFalse(), ctx);
    return `(${whenTrue} if ${c} else ${whenFalse})`;
  }

  if (k === SyntaxKind.TemplateExpression || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return lowerTemplate(node, ctx);
  }

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
    return `[${elems.join(", ")}]`;
  }

  if (k === SyntaxKind.ObjectLiteralExpression) {
    const ol = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const props = ol.getProperties().map((p) => {
      if (Node.isPropertyAssignment(p)) {
        const val = p.getInitializer();
        return `"${p.getName()}": ${val ? lowerExpr(val, ctx) : "None"}`;
      }
      return `# ${p.getText()}`;
    });
    return `{${props.join(", ")}}`;
  }

  if (k === SyntaxKind.ArrowFunction) return lowerArrow(node, ctx);

  if (k === SyntaxKind.NewExpression) return lowerNew(node, ctx);

  if (k === SyntaxKind.SpreadElement) {
    const se = node.asKindOrThrow(SyntaxKind.SpreadElement);
    return `*${lowerExpr(se.getExpression(), ctx)}`;
  }

  if (k === SyntaxKind.VoidExpression) return "None";

  if (k === SyntaxKind.TypeOfExpression) {
    const te = node.asKindOrThrow(SyntaxKind.TypeOfExpression);
    return `type(${lowerExpr(te.getExpression(), ctx)}).__name__`;
  }

  // No silent fallback — throw a loud, actionable error (WI-943).
  // This was previously `return node.getText().replace(/\n/g, " ")`, which
  // silently leaked raw TS syntax into Python output. Any expression kind
  // not handled above produces an unmistakable error instead.
  const exprSnippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToPythonError(SyntaxKind[k], nodeLocation(node), exprSnippet, undefined);
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

function lowerPropertyAccess(node: Node, ctx: Ctx): string {
  const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = lowerExpr(pa.getExpression(), ctx);
  const prop = pa.getName();

  if (prop === "length") return `len(${obj})`;
  if (prop === "push") return `${obj}.append`;

  return `${obj}.${toSnakeCase(prop)}`;
}

// ---------------------------------------------------------------------------
// Call expression
// ---------------------------------------------------------------------------

function lowerCall(node: Node, ctx: Ctx): string {
  const ce = node.asKindOrThrow(SyntaxKind.CallExpression);
  const callee = ce.getExpression();
  const args = ce.getArguments();

  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression();
    const method = callee.getName();
    const objStr = lowerExpr(obj, ctx);

    // xs.map((x) => expr) → [expr for x in xs]
    if (method === "map" && args.length === 1) {
      const fn = args[0];
      if (fn && isArrowLike(fn)) {
        const { params, body } = extractArrowBody(fn, ctx);
        return `[${body} for ${params.join(", ")} in ${objStr}]`;
      }
    }

    // xs.filter((x) => expr) → [x for x in xs if expr]
    if (method === "filter" && args.length === 1) {
      const fn = args[0];
      if (fn && isArrowLike(fn)) {
        const { params, body } = extractArrowBody(fn, ctx);
        const varName = params[0] ?? "x";
        return `[${varName} for ${varName} in ${objStr} if ${body}]`;
      }
    }

    // xs.reduce((acc, x) => expr, init) → functools.reduce(lambda, xs, init)
    if (method === "reduce" && args.length === 2) {
      const fn = args[0];
      const init = args[1];
      if (fn && init && isArrowLike(fn)) {
        ctx.needsFunctools = true;
        const { params, body } = extractArrowBody(fn, ctx);
        return `functools.reduce(lambda ${params.join(", ")}: ${body}, ${objStr}, ${lowerExpr(init, ctx)})`;
      }
    }

    // xs.charCodeAt(n) → ord(xs[n]) or ord(xs) when n=0
    if (method === "charCodeAt" && args.length === 1) {
      const n = args[0];
      if (n) {
        const nStr = lowerExpr(n, ctx);
        return nStr === "0" ? `ord(${objStr})` : `ord(${objStr}[${nStr}])`;
      }
    }

    // xs.slice(start, end) → xs[start:end]
    if (method === "slice") {
      if (args.length === 0) return `${objStr}[:]`;
      if (args.length === 1) {
        const start = args[0];
        return `${objStr}[${start ? lowerExpr(start, ctx) : ""}:]`;
      }
      const start = args[0];
      const end = args[1];
      // Extracted to locals so the template literal interpolates plain
      // identifiers — a single template with two inline ternary+call branches
      // is the one shape the self-shave atomizer can't decompose (single inline
      // ternary works at the args.length === 1 branch above).
      const startStr = start ? lowerExpr(start, ctx) : "";
      const endStr = end ? lowerExpr(end, ctx) : "";
      return `${objStr}[${startStr}:${endStr}]`;
    }

    // xs.push(v) → xs.append(v)
    if (method === "push" && args.length === 1) {
      const v = args[0];
      return `${objStr}.append(${v ? lowerExpr(v, ctx) : ""})`;
    }

    // xs.indexOf(v) → xs.index(v)
    if (method === "indexOf") {
      const argStrs = args.map((a) => lowerExpr(a, ctx));
      return `${objStr}.index(${argStrs.join(", ")})`;
    }

    // xs.join(sep) → sep.join(xs)
    if (method === "join" && args.length === 1) {
      const sep = args[0];
      return `${sep ? lowerExpr(sep, ctx) : '""'}.join(${objStr})`;
    }

    // xs.includes(v) → v in xs
    if (method === "includes" && args.length === 1) {
      const v = args[0];
      return `(${v ? lowerExpr(v, ctx) : "None"} in ${objStr})`;
    }

    // JSON.stringify(x) → repr(x)
    if ((objStr === "json" || objStr === "JSON") && method === "stringify") {
      const v = args[0];
      return `repr(${v ? lowerExpr(v, ctx) : ""})`;
    }

    // String.fromCharCode(n) → chr(n)
    if (method === "fromCharCode") {
      const v = args[0];
      return `chr(${v ? lowerExpr(v, ctx) : ""})`;
    }

    // Object.keys(x) → list(x.keys())
    if (method === "keys" && (objStr === "object" || objStr === "Object")) {
      const v = args[0];
      return `list(${v ? lowerExpr(v, ctx) : ""}.keys())`;
    }

    // Math.floor → int()
    if (method === "floor" && (objStr === "math" || objStr === "Math")) {
      ctx.warnings.push({ kind: "math-import", message: "Math.floor → int() (floor semantics)" });
      const v = args[0];
      return `int(${v ? lowerExpr(v, ctx) : ""})`;
    }
    if (method === "abs" && (objStr === "math" || objStr === "Math")) {
      const v = args[0];
      return `abs(${v ? lowerExpr(v, ctx) : ""})`;
    }
    if (method === "max" && (objStr === "math" || objStr === "Math")) {
      return `max(${args.map((a) => lowerExpr(a, ctx)).join(", ")})`;
    }
    if (method === "min" && (objStr === "math" || objStr === "Math")) {
      return `min(${args.map((a) => lowerExpr(a, ctx)).join(", ")})`;
    }

    // Generic method call
    const argStrs = args.map((a) => lowerExpr(a, ctx));
    return `${objStr}.${toSnakeCase(method)}(${argStrs.join(", ")})`;
  }

  // JSON.stringify as top-level call (unlikely but guard it)
  if (callee.getText() === "JSON.stringify") {
    const v = args[0];
    return `repr(${v ? lowerExpr(v, ctx) : ""})`;
  }

  const calleeStr = lowerExpr(callee, ctx);
  const argStrs = args.map((a) => lowerExpr(a, ctx));
  return `${calleeStr}(${argStrs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Arrow function
// ---------------------------------------------------------------------------

function isArrowLike(node: Node): boolean {
  const k = node.getKind();
  return k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression;
}

interface ArrowBody {
  params: string[];
  body: string;
}

/**
 * Extract the parameter name(s) from a single arrow/function parameter.
 * When the parameter is a destructured array binding [k, v], return the
 * individual element names joined without brackets (Python tuple target).
 * #916 — fixes "for [k, v] in" syntax error in comprehension targets.
 */
function extractParamName(p: { getName(): string; getNameNode(): Node }): string {
  const nameNode = p.getNameNode();
  if (Node.isArrayBindingPattern(nameNode)) {
    const elemNames: string[] = [];
    for (const e of nameNode.getElements()) {
      if (Node.isBindingElement(e)) {
        elemNames.push(toSnakeCase(e.getName()));
      } else {
        elemNames.push("_");
      }
    }
    return elemNames.join(", ");
  }
  return toSnakeCase(p.getName());
}

function extractArrowBody(node: Node, ctx: Ctx): ArrowBody {
  if (node.getKind() === SyntaxKind.ArrowFunction) {
    const af = node.asKindOrThrow(SyntaxKind.ArrowFunction);
    const params = af.getParameters().map((p) => extractParamName(p));
    const body = af.getBody();
    if (Node.isBlock(body)) {
      const lines = lowerBlock(body.getStatements(), ctx, 0);
      return { params, body: lines.map((l) => l.trim()).join("; ") };
    }
    return { params, body: lowerExpr(body, ctx) };
  }
  // FunctionExpression: extract params and body the same way as ArrowFunction.
  // If no Block body is found, there is nothing valid to lower — throw a loud
  // error instead of leaking raw TS getText() into Python (WI-943, Site 3).
  const params = node.getChildrenOfKind(SyntaxKind.Parameter).map((p) => extractParamName(p));
  const bodyNode = node.getChildrenOfKind(SyntaxKind.Block)[0];
  if (bodyNode) {
    const lines = lowerBlock(bodyNode.getStatements(), ctx, 0);
    return { params, body: lines.map((l) => l.trim()).join("; ") };
  }
  const fnSnippet = node.getText().slice(0, 60).replace(/\n/g, " ");
  throw new CannotLowerToPythonError(
    SyntaxKind[node.getKind()],
    nodeLocation(node),
    fnSnippet,
    undefined,
  );
}

function lowerArrow(node: Node, ctx: Ctx): string {
  const { params, body } = extractArrowBody(node, ctx);
  return `lambda ${params.join(", ")}: ${body}`;
}

// ---------------------------------------------------------------------------
// New expression
// ---------------------------------------------------------------------------

function lowerNew(node: Node, ctx: Ctx): string {
  const ne = node.asKindOrThrow(SyntaxKind.NewExpression);
  const ctor = lowerExpr(ne.getExpression(), ctx);
  const args = ne.getArguments() ?? [];
  const argStrs = args.map((a) => lowerExpr(a, ctx));
  return `${ctor}(${argStrs.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Binary expression
// ---------------------------------------------------------------------------

const TS_TO_PY_OP: Readonly<Record<string, string>> = {
  "===": "==",
  "!==": "!=",
  "&&": "and",
  "||": "or",
  "**": "**",
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
  "|": "|",
  "&": "&",
  "^": "^",
  "<<": "<<",
  ">>": ">>",
  ">>>": ">>",
  "??": "or",
};

function lowerBinary(node: Node, ctx: Ctx): string {
  const be = node.asKindOrThrow(SyntaxKind.BinaryExpression);
  const leftNode = be.getLeft();
  const rightNode = be.getRight();
  const op = be.getOperatorToken().getText();

  // #917 — === null / !== null → is None / is not None (PEP 8 identity checks)
  const rightIsNull =
    rightNode.getKind() === SyntaxKind.NullKeyword ||
    rightNode.getKind() === SyntaxKind.UndefinedKeyword;
  const leftIsNull =
    leftNode.getKind() === SyntaxKind.NullKeyword ||
    leftNode.getKind() === SyntaxKind.UndefinedKeyword;

  if ((op === "===" || op === "==") && rightIsNull) {
    return `${lowerExpr(leftNode, ctx)} is None`;
  }
  if ((op === "!==" || op === "!=") && rightIsNull) {
    return `${lowerExpr(leftNode, ctx)} is not None`;
  }
  if ((op === "===" || op === "==") && leftIsNull) {
    return `${lowerExpr(rightNode, ctx)} is None`;
  }
  if ((op === "!==" || op === "!=") && leftIsNull) {
    return `${lowerExpr(rightNode, ctx)} is not None`;
  }

  const left = lowerExpr(leftNode, ctx);
  const right = lowerExpr(rightNode, ctx);
  const pyOp = TS_TO_PY_OP[op] ?? op;
  return `${left} ${pyOp} ${right}`;
}

// ---------------------------------------------------------------------------
// Prefix/postfix unary
// ---------------------------------------------------------------------------

function lowerPrefixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();

  if (op === SyntaxKind.ExclamationToken) return `not ${operand}`;
  if (op === SyntaxKind.MinusToken) return `-${operand}`;
  if (op === SyntaxKind.PlusToken) return `+${operand}`;
  if (op === SyntaxKind.PlusPlusToken) return `${operand} + 1`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand} - 1`;
  return `${String(op)} ${operand}`;
}

function lowerPostfixUnary(node: Node, ctx: Ctx): string {
  const pu = node.asKindOrThrow(SyntaxKind.PostfixUnaryExpression);
  const operand = lowerExpr(pu.getOperand(), ctx);
  const op = pu.getOperatorToken();
  if (op === SyntaxKind.PlusPlusToken) return `${operand} += 1`;
  if (op === SyntaxKind.MinusMinusToken) return `${operand} -= 1`;
  return operand;
}

// ---------------------------------------------------------------------------
// Template literal
// ---------------------------------------------------------------------------

function lowerTemplate(node: Node, ctx: Ctx): string {
  if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const text = node.getText().slice(1, -1);
    return `"${escPyStr(text)}"`;
  }

  const te = node.asKindOrThrow(SyntaxKind.TemplateExpression);
  const headText = te.getHead().getText();
  // head is: `prefix${ — strip the backtick and `${
  const head = headText.slice(1, headText.length - 2);

  const parts: string[] = [];
  if (head) parts.push(escPyStr(head));

  for (const span of te.getTemplateSpans()) {
    const expr = lowerExpr(span.getExpression(), ctx);
    parts.push(`{${expr}}`);
    const literal = span.getLiteral().getText();
    // The literal is either `}suffix${` or `}suffix`
    const afterBrace = literal.startsWith("}") ? literal.slice(1) : literal;
    const stripped = afterBrace.endsWith("${")
      ? afterBrace.slice(0, -2)
      : afterBrace.endsWith("`")
        ? afterBrace.slice(0, -1)
        : afterBrace;
    if (stripped) parts.push(escPyStr(stripped));
  }

  return `f"${parts.join("")}"`;
}

function escPyStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pyStringLiteral(tsLit: string): string {
  const quote = tsLit[0];
  const inner = tsLit.slice(1, -1);
  if (quote === '"') {
    return `"${inner}"`;
  }
  // single-quoted TS string → double-quoted Python
  return `"${inner.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`;
}

// ---------------------------------------------------------------------------
// Type node lowering
// ---------------------------------------------------------------------------

export function lowerTypeNode(typeNode: TypeNode, ctx: Ctx): string {
  const k = typeNode.getKind();

  if (k === SyntaxKind.NumberKeyword) {
    ctx.warnings.push({
      kind: "number-to-float",
      message: "number → float: precision loss possible",
    });
    return "float";
  }

  if (k === SyntaxKind.StringKeyword) return "str";
  if (k === SyntaxKind.BooleanKeyword) return "bool";
  if (k === SyntaxKind.VoidKeyword) return "None";
  if (k === SyntaxKind.NullKeyword || k === SyntaxKind.UndefinedKeyword) return "None";

  if (
    k === SyntaxKind.AnyKeyword ||
    k === SyntaxKind.UnknownKeyword ||
    k === SyntaxKind.NeverKeyword
  ) {
    ctx.warnings.push({ kind: "any-type", message: `${SyntaxKind[k]} → Any (lossy)` });
    return "Any";
  }

  if (k === SyntaxKind.ArrayType) {
    const at = typeNode.asKindOrThrow(SyntaxKind.ArrayType);
    const inner = lowerTypeNode(at.getElementTypeNode(), ctx);
    return `list[${inner}]`;
  }

  if (k === SyntaxKind.TypeReference) return lowerTypeRef(typeNode, ctx);

  // #915 — (a: A, b: B) => R function type → Callable[[A, B], R]
  if (k === SyntaxKind.FunctionType) {
    const ft = typeNode.asKindOrThrow(SyntaxKind.FunctionType);
    const paramTypes = ft.getParameters().map((p) => {
      const pType = p.getTypeNode();
      return pType ? lowerTypeNode(pType, ctx) : "Any";
    });
    const retType = ft.getReturnTypeNode();
    const pyRet = retType ? lowerTypeNode(retType, ctx) : "None";
    ctx.needsCallable = true;
    return `Callable[[${paramTypes.join(", ")}], ${pyRet}]`;
  }

  if (k === SyntaxKind.UnionType) return lowerUnion(typeNode, ctx);

  if (k === SyntaxKind.TupleType) {
    const tt = typeNode.asKindOrThrow(SyntaxKind.TupleType);
    const elems = tt.getElements().map((e) => lowerTypeNode(e, ctx));
    return `tuple[${elems.join(", ")}]`;
  }

  // readonly modifier
  if (k === SyntaxKind.TypeOperator) {
    // The inner type is the second child
    const children = typeNode.getChildren();
    const inner = children[1];
    if (inner && Node.isTypeNode(inner)) return lowerTypeNode(inner, ctx);
    return "list";
  }

  // Named tuple member
  if (k === SyntaxKind.NamedTupleMember) {
    const children = typeNode.getChildren();
    // structure: name : type
    const typeChild = children.find((c) => Node.isTypeNode(c));
    if (typeChild) return lowerTypeNode(typeChild, ctx);
    return "Any";
  }

  if (k === SyntaxKind.LiteralType) {
    const lit = typeNode.asKindOrThrow(SyntaxKind.LiteralType).getLiteral();
    const lk = lit.getKind();
    if (lk === SyntaxKind.NullKeyword) return "None";
    if (lk === SyntaxKind.StringLiteral) return "str";
    if (lk === SyntaxKind.NumericLiteral) return "float";
    if (lk === SyntaxKind.TrueKeyword || lk === SyntaxKind.FalseKeyword) return "bool";
    return "Any";
  }

  if (k === SyntaxKind.ParenthesizedType) {
    const children = typeNode.getChildren();
    const inner = children[1];
    if (inner && Node.isTypeNode(inner)) return lowerTypeNode(inner, ctx);
  }

  // Intersection type: A & B → A (approximate, warn)
  if (k === SyntaxKind.IntersectionType) {
    ctx.warnings.push({
      kind: "intersection-type",
      message: "intersection type approximated as first member",
    });
    const it = typeNode.asKindOrThrow(SyntaxKind.IntersectionType);
    const first = it.getTypeNodes()[0];
    return first ? lowerTypeNode(first, ctx) : "Any";
  }

  // #960 — typeof X (TypeQuery) → type[X]
  //
  // @decision DEC-960-001
  // @title TypeQuery (typeof X) in type position lowers to Python type[X]
  // @status accepted (#960)
  // @rationale In TS, `typeof ClassName` used as a type annotation means "the
  //   class object itself, not an instance." Python's idiomatic equivalent is
  //   `type[ClassName]` (PEP 585 / typing.Type). Emitting the raw TS text as a
  //   forward-reference string literal ("typeof EntitySubstitution") is not
  //   valid Python — typing.get_type_hints() would fail to resolve it.
  //   We extract the exprText from the TypeQuery node and wrap it in type[...],
  //   preserving dotted qualifiers (e.g. typeof bs4.Tag → type[bs4.Tag]) verbatim
  //   since qualified names are valid in Python type annotations.
  //   NOTE: this handles TypeQuery only in type-annotation position (TypeNode).
  //   The expression-position typeof (runtime typeof operator) is handled
  //   separately in lowerExpr under SyntaxKind.TypeOfExpression.
  if (k === SyntaxKind.TypeQuery) {
    const exprText = typeNode.asKindOrThrow(SyntaxKind.TypeQuery).getExprName().getText();
    return `type[${exprText}]`;
  }

  return `"${typeNode.getText()}"`;
}

function lowerTypeRef(typeNode: TypeNode, ctx: Ctx): string {
  const tr = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
  const name = tr.getTypeName().getText();
  const typeArgs = tr.getTypeArguments();

  // #915 — TS built-in buffer type → Python bytes
  if (name === "Uint8Array" || name === "Buffer") {
    return "bytes";
  }

  if (name === "Record") {
    const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "str";
    const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "Any";
    return `dict[${k2}, ${v}]`;
  }

  if (name === "ReadonlyArray" || name === "Array") {
    const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "Any";
    return `list[${inner}]`;
  }

  if (name === "Readonly") {
    return typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "Any";
  }

  if (name === "Map") {
    const k2 = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "Any";
    const v = typeArgs[1] ? lowerTypeNode(typeArgs[1], ctx) : "Any";
    return `dict[${k2}, ${v}]`;
  }

  if (name === "Set") {
    const inner = typeArgs[0] ? lowerTypeNode(typeArgs[0], ctx) : "Any";
    return `set[${inner}]`;
  }

  if (typeArgs.length > 0) {
    const args = typeArgs.map((a) => lowerTypeNode(a, ctx));
    return `${name}[${args.join(", ")}]`;
  }
  return name;
}

function isNullishTypeNode(t: TypeNode): boolean {
  if (t.getKind() === SyntaxKind.NullKeyword) return true;
  if (t.getKind() === SyntaxKind.UndefinedKeyword) return true;
  if (t.getKind() === SyntaxKind.LiteralType) {
    const lit = t.asKindOrThrow(SyntaxKind.LiteralType).getLiteral();
    return lit.getKind() === SyntaxKind.NullKeyword;
  }
  return false;
}

function lowerUnion(typeNode: TypeNode, ctx: Ctx): string {
  const ut = typeNode.asKindOrThrow(SyntaxKind.UnionType);
  const types = ut.getTypeNodes();
  const nonNull = types.filter((t) => !isNullishTypeNode(t));

  if (nonNull.length === 1 && nonNull.length < types.length) {
    ctx.needsOptional = true;
    const [innerType] = nonNull;
    if (innerType) {
      const inner = lowerTypeNode(innerType, ctx);
      return `Optional[${inner}]`;
    }
    return "Any";
  }

  const parts = types.map((t) => lowerTypeNode(t, ctx));
  return `Union[${parts.join(", ")}]`;
}
