// SPDX-License-Identifier: Apache-2.0
/**
 * A bundle's wrapper, unwrapped (#1361): a module statement that only calls a function it writes,
 * `((module) => { … })(arg)`, is the function's body written as the module's own statements, after
 * its parameters bound to the arguments. That is what the call does when nothing else in the module
 * can tell the difference, and the body's statements are then lifted one by one, as any module's
 * are: the TypeScript compiler's bundle is one such statement of 9 MB, which lifted and lowered as one
 * graph, and lowering grows faster than the graph.
 *
 * A wrapper is unwrapped only when:
 * - it is an arrow, or a function expression whose own `this`, `arguments` and `new.target` are not
 *   used (the module's are not the function's), neither async nor a generator;
 * - its parameters are plain names, with no default and no rest;
 * - its body has no `return` of its own (a module statement cannot return its function);
 * - no name the body declares appears in the module outside the function (the arguments included):
 *   once the body's declarations are the module's, they are hoisted over the whole module, so any
 *   other use of the name would see them;
 * - the body declares no name of a parameter anywhere in it, so renaming the parameter is renaming
 *   every read of it.
 * Each parameter is renamed to a fresh name (none the module writes), bound by `let` to its argument,
 * or `undefined`, in order before the body, as a call evaluates them. Anything else is left as it is.
 */
import { ts } from "ts-morph";

/** The module's text with each bundle wrapper unwrapped; the text itself when none is. */
export function unwrapBundles(text: string): string {
  if (!/=>|function/.test(text)) return text;
  const sf = ts.createSourceFile("m.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: { from: number; to: number; text: string }[] = [];
  let fresh = 0;
  for (const st of sf.statements) {
    const fn = wrapperOf(st);
    if (fn === undefined) continue;
    const call = (st as ts.ExpressionStatement).expression as ts.CallExpression;
    const body = fn.body as ts.Block;
    const params = fn.parameters.map((p) => (p.name as ts.Identifier).text);
    const declared = bodyDeclarations(body);
    const outside = namesOutside(sf, fn);
    // A parameter is renamed to a fresh name, so its own name may be used outside (the TypeScript
    // bundle passes CommonJS's `module` to its parameter `module`).
    if ([...declared].some((n) => outside.has(n))) continue;
    if (params.some((p) => declaredAnywhere(body, p))) continue;
    // A fresh name for each parameter: one the module does not write anywhere.
    const renamed = new Map<string, string>();
    for (const p of params) {
      let name: string;
      do name = `$bundle${fresh++}$${p}`;
      while (text.includes(name));
      renamed.set(p, name);
    }
    const bodyEdits = renameReads(body, renamed);
    if (bodyEdits === undefined) continue;
    const inner = applyEdits(
      text.slice(body.getStart(sf) + 1, body.getEnd() - 1),
      bodyEdits.map((e) => ({
        ...e,
        from: e.from - body.getStart(sf) - 1,
        to: e.to - body.getStart(sf) - 1,
      })),
    );
    const bindings = params
      .map((p, i) => {
        const arg = call.arguments[i];
        return `let ${renamed.get(p)} = ${arg === undefined ? "undefined" : `(${arg.getText(sf)})`};`;
      })
      .join("\n");
    // The arguments beyond the parameters are still evaluated, in order.
    const extra = call.arguments
      .slice(params.length)
      .map((a) => `(${a.getText(sf)});`)
      .join("\n");
    edits.push({
      from: st.getStart(sf),
      to: st.getEnd(),
      text: `${bindings}${extra === "" ? "" : `\n${extra}`}\n${inner}`,
    });
  }
  return edits.length === 0 ? text : applyEdits(text, edits);
}

/** The function a statement only calls, when it is a wrapper this unwraps. */
function wrapperOf(st: ts.Statement): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!ts.isExpressionStatement(st)) return undefined;
  const call = st.expression;
  if (!ts.isCallExpression(call) || call.questionDotToken !== undefined) return undefined;
  if (call.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) return undefined;
  const fn = callee;
  if (fn.body === undefined || !ts.isBlock(fn.body)) return undefined;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
  if (ts.isFunctionExpression(fn) && (fn.asteriskToken !== undefined || fn.name !== undefined))
    return undefined;
  if (
    fn.parameters.some(
      (p) =>
        !ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken !== undefined,
    )
  )
    return undefined;
  if (ownUses(fn.body, ts.isFunctionExpression(fn))) return undefined;
  return fn;
}

/**
 * Whether the body uses what a module statement would not have: a `return` of its own, or, for a
 * function expression, its own `this`, `arguments` or `new.target`.
 */
function ownUses(body: ts.Block, isFunction: boolean): boolean {
  let found = false;
  const visit = (n: ts.Node, inArrow: boolean): void => {
    if (found) return;
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
    if (ts.isClassLike(n)) return;
    if (ts.isArrowFunction(n)) {
      if (isFunction) ts.forEachChild(n, (c) => visit(c, true));
      return;
    }
    if (ts.isReturnStatement(n) && !inArrow) found = true;
    if (isFunction) {
      if (n.kind === ts.SyntaxKind.ThisKeyword) found = true;
      if (ts.isIdentifier(n) && n.text === "arguments") found = true;
      if (ts.isMetaProperty(n)) found = true;
    }
    if (!found) ts.forEachChild(n, (c) => visit(c, inArrow));
  };
  ts.forEachChild(body, (c) => visit(c, false));
  return found;
}

/** The names a function body declares in its own scope: its statements', and each `var` in it. */
function bodyDeclarations(body: ts.Block): Set<string> {
  const names = new Set<string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  for (const st of body.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bind(d.name);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined)
      names.add(st.name.text);
  }
  // A `var` anywhere in the body, outside a nested function, is the body's; so is a function
  // declared in a block (sloppy mode's annex B hoists it).
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) names.add(n.name.text);
      return;
    }
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0)
      for (const d of n.declarations) bind(d.name);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return names;
}

/**
 * Every name the module uses outside `fn`: each identifier's text but a property's or a member's
 * name (`x.next`, `{ next: 1 }`, a method `next()`), which no binding is.
 */
function namesOutside(sf: ts.SourceFile, fn: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (n === fn) return;
    if (ts.isIdentifier(n) && !isMemberName(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/** Whether an identifier names a property or a member, not a binding. */
function isMemberName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === n) ||
    ((ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p)) &&
      p.name === n)
  );
}

/** Whether any scope in the body declares `name` (a variable, a parameter, a function or a class). */
function declaredAnywhere(body: ts.Block, name: string): boolean {
  let found = false;
  const bound = (b: ts.BindingName): boolean =>
    ts.isIdentifier(b)
      ? b.text === name
      : b.elements.some((el) => !ts.isOmittedExpression(el) && bound(el.name));
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
      bound(n.name)
    )
      found = true;
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n)) &&
      n.name?.text === name
    )
      found = true;
    if (
      ts.isCatchClause(n) &&
      n.variableDeclaration !== undefined &&
      bound(n.variableDeclaration.name)
    )
      found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/**
 * The edits renaming each read of a parameter in the body: a name in an expression, and a shorthand
 * property's (`{ module }` is `{ module: $fresh }`). A property name, a member name, a label, or the
 * name in a property access is not a read and is left. Undefined when an occurrence is none of these
 * (so renaming it would be a guess).
 */
function renameReads(
  body: ts.Block,
  renamed: ReadonlyMap<string, string>,
): { from: number; to: number; text: string }[] | undefined {
  const edits: { from: number; to: number; text: string }[] = [];
  let unsure = false;
  const sf = body.getSourceFile();
  const visit = (n: ts.Node): void => {
    if (unsure) return;
    if (ts.isIdentifier(n)) {
      const to = renamed.get(n.text);
      if (to !== undefined) {
        const p = n.parent;
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) {
          if (p.objectAssignmentInitializer !== undefined) unsure = true;
          else edits.push({ from: n.getStart(sf), to: n.getEnd(), text: `${n.text}: ${to}` });
        } else if (
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          ((ts.isMethodDeclaration(p) ||
            ts.isPropertyDeclaration(p) ||
            ts.isGetAccessorDeclaration(p) ||
            ts.isSetAccessorDeclaration(p)) &&
            p.name === n) ||
          ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) &&
            p.label === n)
        ) {
          // Not a read of the parameter.
        } else if (ts.isExportSpecifier(p) || ts.isImportSpecifier(p)) unsure = true;
        else edits.push({ from: n.getStart(sf), to: n.getEnd(), text: to });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return unsure ? undefined : edits;
}

function applyEdits(
  text: string,
  edits: readonly { from: number; to: number; text: string }[],
): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from))
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}
