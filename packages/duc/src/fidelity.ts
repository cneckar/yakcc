// SPDX-License-Identifier: Apache-2.0
// @decision DEC-DUC-LIFT-FIDELITY-001 (#1173, DUC Norm 3): a lift drops no reference and invents
// none. The names an atom's source reads without declaring them, found by TypeScript's own binder
// on the parse the lifter uses, are exactly the names its graph reports as references (diamond
// sources, in the graph and in every closure graph inside it). A reference the lifter resolves
// wrongly, to a binding that is not there, shows as missing; a name the source binds but the graph
// reports as free shows as extra, unless the atom declares it at its own top level: that is a
// module binding, which the graph reads live, as JavaScript does, and the module record links
// (DEC-DUC-MODULE-SCOPE-001); recursion and forward references among a module's declarations are
// such reads. A name declared inside a function body has no module binding to link to, so there
// the lifter must bind it (a cell, for a closure that reads it later). The lifter's own primitives (`__yakcc…`), a function's own
// `arguments`, and meta-properties (`new.target`) are not source names and are left out.

import { ts } from "ts-morph";
import { parseAtomSource } from "./lift.js";
import { operationReference } from "./operations.js";
import type { DucGraph } from "./types.js";

export interface LiftFidelity {
  readonly holds: boolean;
  /** Read by the source without a declaration, but not a reference in the graph. */
  readonly missing: readonly string[];
  /** A reference in the graph, but declared by the source (or not read by it at all). */
  readonly extra: readonly string[];
}

const NOT_SOURCE_NAMES = new Set(["arguments", "undefined", "__atom__"]);

const notASourceName = (name: string): boolean =>
  NOT_SOURCE_NAMES.has(name) || name.startsWith("__yakcc") || name.includes(".");

/** Is this identifier a name in a value position (not a property name, a label, a type)? */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) || ts.isMetaProperty(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isEnumMember(p) && p.name === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p)) &&
    p.name === id
  )
    return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  // An import attribute's key (`with { type: "json" }`) names the attribute (#1297).
  if (ts.isImportAttribute(p) && p.name === id) return false;
  if (ts.isExportSpecifier(p)) return (p.propertyName ?? p.name) === id;
  return true;
}

/** The member whose computed name holds `id` (`[k]() {}`, `[k]: v`, `get [k]()`), if any. */
function computedMemberOf(id: ts.Node): ts.Node | undefined {
  for (let p = id.parent; p !== undefined; p = p.parent) {
    if (ts.isComputedPropertyName(p)) return p.parent;
    if (ts.isFunctionLike(p) || ts.isClassLike(p) || ts.isBlock(p)) return undefined;
  }
  return undefined;
}

/** Whether `node` lies within `ancestor`. */
function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p !== undefined; p = p.parent)
    if (p === ancestor) return true;
  return false;
}

/** The names an atom's source reads without declaring them, by TypeScript's binder. */
export function sourceFreeNames(source: string): Set<string> {
  const { project, file } = parseAtomSource(source);
  const checker = project.getTypeChecker().compilerObject;
  const sf = file.compilerNode;
  const free = new Set<string>();
  // TypeScript binds `globalThis` to its own symbol, which has no declarations, even where the
  // source declares the name (Node's `const { globalThis } = primordials`): a declaration in the
  // source declares it (#1331).
  const bindsGlobalThis = (() => {
    let found = false;
    const find = (n: ts.Node): void => {
      if (found) return;
      if (
        (ts.isBindingElement(n) ||
          ts.isVariableDeclaration(n) ||
          ts.isParameter(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isClassDeclaration(n)) &&
        n.name !== undefined &&
        ts.isIdentifier(n.name) &&
        n.name.text === "globalThis"
      )
        found = true;
      else ts.forEachChild(n, find);
    };
    find(sf);
    return found;
  })();
  const visit = (node: ts.Node): void => {
    // Types are not values: their names are never references in the graph.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) return;
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    // A type-only export, and a re-export from another module, read no value of this atom (#1297).
    if (ts.isExportDeclaration(node) && (node.isTypeOnly || node.moduleSpecifier !== undefined))
      return;
    if (ts.isExportSpecifier(node) && node.isTypeOnly) return;
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const p = node.parent;
      const symbol = ts.isShorthandPropertyAssignment(p)
        ? checker.getShorthandAssignmentValueSymbol(p)
        : ts.isExportSpecifier(p)
          ? checker.getExportSpecifierLocalTargetSymbol(p)
          : checker.getSymbolAtLocation(node);
      // A computed member name is evaluated where the member is defined, outside it: a binding of
      // the same name inside the member does not declare it (TypeScript's binder resolves it there).
      const computed = computedMemberOf(node);
      const declared = (symbol?.declarations ?? []).some(
        (d) => computed === undefined || !isWithin(d, computed),
      );
      if (
        !declared &&
        !notASourceName(node.text) &&
        !(node.text === "globalThis" && bindsGlobalThis)
      )
        free.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return free;
}

/** The names an atom declares at its own top level: its module bindings. */
export function topLevelNames(source: string): Set<string> {
  const { file } = parseAtomSource(source);
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name);
  };
  for (const st of file.compilerNode.statements) {
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) addBinding(d.name);
    else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
      st.name !== undefined &&
      st.name.text !== "__atom__"
    )
      names.add(st.name.text);
    else if (ts.isImportDeclaration(st) && st.importClause !== undefined) {
      const c = st.importClause;
      if (c.name !== undefined) names.add(c.name.text);
      const b = c.namedBindings;
      if (b !== undefined && ts.isNamespaceImport(b)) names.add(b.name.text);
      else if (b !== undefined) for (const el of b.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * The names a graph reports as references: its diamond sources, the platform namespace of each
 * operation reference (`Math` for `Math.sin`, #1362), and its closures'.
 */
export function graphFreeNames(graph: DucGraph, into: Set<string> = new Set()): Set<string> {
  for (const n of graph.nodes) {
    if (n.diamond !== undefined && !notASourceName(n.diamond.symbol)) into.add(n.diamond.symbol);
    const op = n.kind === "op" ? operationReference(n.label) : undefined;
    if (op !== undefined) into.add(op.label.slice(0, op.label.indexOf(".")));
    if (n.closure !== undefined) graphFreeNames(n.closure, into);
  }
  return into;
}

/** Does the graph reference exactly the names its source reads without declaring? */
export function liftFidelity(source: string, graph: DucGraph): LiftFidelity {
  const inSource = sourceFreeNames(source);
  const inGraph = graphFreeNames(graph);
  const missing = [...inSource].filter((n) => !inGraph.has(n)).sort();
  const module = topLevelNames(source);
  const extra = [...inGraph].filter((n) => !inSource.has(n) && !module.has(n)).sort();
  return { holds: missing.length === 0 && extra.length === 0, missing, extra };
}

/** `typeof name` tested to be present: `typeof name === "function"`, `typeof name !== "undefined"`. */
function testsPresent(test: ts.Expression, name: string): boolean {
  let e = test;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken)
    return testsPresent(e.left, name) || testsPresent(e.right, name);
  const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const ne =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!eq && !ne) return false;
  const sides = [e.left, e.right];
  const probe = sides.find(
    (s) => ts.isTypeOfExpression(s) && ts.isIdentifier(s.expression) && s.expression.text === name,
  );
  const text = sides.find((s) => ts.isStringLiteral(s)) as ts.StringLiteral | undefined;
  if (probe === undefined || text === undefined) return false;
  return eq ? text.text !== "undefined" : text.text === "undefined";
}

const within = (node: ts.Node, part: ts.Node | undefined): boolean =>
  part !== undefined && node.pos >= part.pos && node.end <= part.end;

/** Is this read of a free name one the atom survives the name's absence at: a probe? */
function isProbe(id: ts.Identifier): boolean {
  if (ts.isTypeOfExpression(id.parent)) return true;
  const name = id.text;
  for (let a: ts.Node | undefined = id.parent; a !== undefined; a = a.parent) {
    if (ts.isIfStatement(a) && within(id, a.thenStatement) && testsPresent(a.expression, name))
      return true;
    if (ts.isConditionalExpression(a) && within(id, a.whenTrue) && testsPresent(a.condition, name))
      return true;
    if (
      ts.isBinaryExpression(a) &&
      a.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      within(id, a.right) &&
      testsPresent(a.left, name)
    )
      return true;
  }
  return false;
}

/**
 * The free names an atom only probes for (DEC-DUC-FEATURE-DETECTION-001, #1173): every read of the
 * name is `typeof name`, or lies under a test that `typeof name` is present (an `if`, a `?:`, the
 * right of an `&&`). The atom decides by its own test what to do when the name is absent, so it is
 * explained: feature detection (a UMD wrapper's `define`), not a hole. A read inside a `try` is not a
 * probe: a `catch` survives any missing name, a real hole included.
 */
export function probedNames(source: string): Set<string> {
  const { project, file } = parseAtomSource(source);
  const checker = project.getTypeChecker().compilerObject;
  const reads = new Map<string, boolean>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (
      ts.isIdentifier(node) &&
      isValueReference(node) &&
      !ts.isShorthandPropertyAssignment(node.parent)
    ) {
      const symbol = checker.getSymbolAtLocation(node);
      if ((symbol?.declarations ?? []).length === 0 && !notASourceName(node.text))
        reads.set(node.text, (reads.get(node.text) ?? true) && isProbe(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file.compilerNode);
  return new Set([...reads].filter(([, probed]) => probed).map(([name]) => name));
}
