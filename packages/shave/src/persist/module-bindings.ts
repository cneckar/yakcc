// SPDX-License-Identifier: MIT
//
// @decision DEC-DUC-MODULE-CAPTURE-001 (wi-explain #1171)
// A free identifier that names a module-scope binding whose value is fixed by its
// declaration is a recorded capture, not an unknown. `pure` means exactly that. It
// covers a literal value never mutated, an initializer that reads only pure, ambient,
// or declared-import names, a function that reads only pure names, and a value import.
//
// @decision DEC-DUC-MODULE-INIT-CLOSURE-001 (wi-explain #1173)
// A binding filled during module initialization is also pure. Examples are a lookup
// table built by a loop at module top level. Its value is fixed once the module has
// loaded, so it is classified pure when every write to it is a direct write, update,
// or method call at top level, and every top-level statement that writes it reads
// only pure, ambient, imported, or other init-fixed names. An alias or hand-off (`const
// u = t`, `f(t)`) disqualifies the binding outright: a write through an alias cannot be
// tracked. A write inside any function also disqualifies it. The check lifts each
// writing statement with the DUC lifter, so the lifter's own scoping decides what is
// local. The analysis is conservative: anything it cannot prove is mutable.
//
// Known limit. A binding is pure at module load time. An atom that runs before the
// module has finished initializing could observe a partial table. The yakcc shave
// path does not execute module code, so this does not arise there.

import { createHash } from "node:crypto";
import { type DiamondReason, liftAtom } from "@yakcc/duc";
import { Node, Project, ScriptKind, type SourceFile, SyntaxKind } from "ts-morph";

/** How a module-scope binding is classified. */
export type ModuleBinding = "pure" | "mutable";

/** A module-scope binding's classification and the hash of its declaration. */
export interface ModuleBindingInfo {
  readonly binding: ModuleBinding;
  readonly declHash: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const ASSIGN_OPS = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether an expression is a pure literal value: no calls, no identifiers, no mutation. */
function isPureLiteral(node: Node): boolean {
  if (
    Node.isNumericLiteral(node) ||
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isRegularExpressionLiteral(node)
  ) {
    return true;
  }
  const kind = node.getKind();
  if (
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const op = node.getOperatorToken();
    return (
      (op === SyntaxKind.MinusToken || op === SyntaxKind.PlusToken) &&
      Node.isNumericLiteral(node.getOperand())
    );
  }
  if (Node.isParenthesizedExpression(node)) return isPureLiteral(node.getExpression());
  if (Node.isArrayLiteralExpression(node))
    return node.getElements().every((el) => isPureLiteral(el));
  if (Node.isObjectLiteralExpression(node)) {
    return node.getProperties().every((prop) => {
      if (!Node.isPropertyAssignment(prop)) return false;
      const name = prop.getNameNode();
      const keyOk =
        Node.isIdentifier(name) || Node.isStringLiteral(name) || Node.isNumericLiteral(name);
      const init = prop.getInitializer();
      return keyOk && init !== undefined && isPureLiteral(init);
    });
  }
  return false;
}

/**
 * What a binding's value can do under a method call or a hand-off. A primitive, a
 * non-global regex, and a function are inert. An object, an array, or a stateful regex
 * is opaque: a call or a hand-off may mutate it.
 */
interface MutationPolicy {
  readonly callsMutate: boolean;
  readonly handoffMutates: boolean;
}
/** Binary operators whose result is a primitive when both operands are primitives. */
const PRIMITIVE_BINARY_OPS = new Set<SyntaxKind>([
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.SlashToken,
  SyntaxKind.PercentToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/**
 * Whether an initializer always evaluates to a primitive, given the names already known to
 * hold primitives. Literals, names in `primitive`, parentheses, unary `+ - ! ~` and the
 * binary operators in PRIMITIVE_BINARY_OPS over primitives. Those operators invoke no user
 * code on primitive operands, so the result is a primitive that no call can mutate.
 */
function isPrimitiveExpr(node: Node, primitive: ReadonlySet<string>): boolean {
  if (Node.isParenthesizedExpression(node)) return isPrimitiveExpr(node.getExpression(), primitive);
  if (
    Node.isNumericLiteral(node) ||
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword ||
    node.getKind() === SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (Node.isIdentifier(node)) return primitive.has(node.getText());
  if (Node.isPrefixUnaryExpression(node)) {
    const op = node.getOperatorToken();
    if (
      op !== SyntaxKind.PlusToken &&
      op !== SyntaxKind.MinusToken &&
      op !== SyntaxKind.ExclamationToken &&
      op !== SyntaxKind.TildeToken
    )
      return false;
    return isPrimitiveExpr(node.getOperand(), primitive);
  }
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getKind();
    if (!PRIMITIVE_BINARY_OPS.has(op)) return false;
    return (
      isPrimitiveExpr(node.getLeft(), primitive) && isPrimitiveExpr(node.getRight(), primitive)
    );
  }
  return false;
}

const OPAQUE: MutationPolicy = { callsMutate: true, handoffMutates: true };
const INERT: MutationPolicy = { callsMutate: false, handoffMutates: false };

function policyForInit(init: Node | undefined): MutationPolicy {
  if (init === undefined) return OPAQUE;
  if (Node.isRegularExpressionLiteral(init)) {
    const text = init.getText();
    const flags = text.slice(text.lastIndexOf("/") + 1);
    return /[gy]/.test(flags) ? OPAQUE : INERT;
  }
  if (
    Node.isNumericLiteral(init) ||
    Node.isStringLiteral(init) ||
    Node.isNoSubstitutionTemplateLiteral(init) ||
    Node.isBigIntLiteral(init) ||
    init.getKind() === SyntaxKind.TrueKeyword ||
    init.getKind() === SyntaxKind.FalseKeyword ||
    init.getKind() === SyntaxKind.NullKeyword
  ) {
    return INERT;
  }
  return OPAQUE;
}

/** A place where a binding may be mutated: a direct write, a method call, or a hand-off. */
interface Site {
  readonly node: Node;
  readonly kind: "write" | "call" | "handoff";
}

/** Every mutation site of `name` in the module, classified by kind. */
function mutationSites(sf: SourceFile, name: string, policy: MutationPolicy): Site[] {
  const sites: Site[] = [];
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name) continue;
    const parent = id.getParent();
    if (parent === undefined) continue;
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) continue;
    if (
      Node.isBinaryExpression(parent) &&
      parent.getLeft() === id &&
      ASSIGN_OPS.has(parent.getOperatorToken().getKind())
    ) {
      sites.push({ node: id, kind: "write" });
      continue;
    }
    if (isUpdate(parent) && isOperandOf(parent, id)) {
      sites.push({ node: id, kind: "write" });
      continue;
    }
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === id) {
      if (policy.handoffMutates) sites.push({ node: id, kind: "handoff" });
      continue;
    }
    if (Node.isCallExpression(parent) && parent.getArguments().some((a) => a === id)) {
      if (policy.handoffMutates) sites.push({ node: id, kind: "handoff" });
      continue;
    }
    if (Node.isElementAccessExpression(parent) || Node.isPropertyAccessExpression(parent)) {
      if (parent.getExpression() !== id) continue;
      const grand = parent.getParent();
      if (grand === undefined) continue;
      if (
        Node.isBinaryExpression(grand) &&
        grand.getLeft() === parent &&
        ASSIGN_OPS.has(grand.getOperatorToken().getKind())
      ) {
        sites.push({ node: id, kind: "write" });
        continue;
      }
      if (isUpdate(grand) && isOperandOf(grand, parent)) {
        sites.push({ node: id, kind: "write" });
        continue;
      }
      if (Node.isCallExpression(grand) && grand.getExpression() === parent) {
        if (policy.callsMutate) sites.push({ node: id, kind: "call" });
        continue;
      }
      if (Node.isCallExpression(grand) && grand.getArguments().some((a) => a === parent)) {
        if (policy.handoffMutates) sites.push({ node: id, kind: "handoff" });
      }
    }
  }
  return sites;
}

function isUpdate(node: Node): boolean {
  if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
    const op = node.getOperatorToken();
    return op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken;
  }
  return false;
}

function isOperandOf(node: Node, operand: Node): boolean {
  if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
    return node.getOperand() === operand;
  }
  return false;
}

const FUNCTION_LIKE = (n: Node): boolean =>
  Node.isFunctionDeclaration(n) ||
  Node.isFunctionExpression(n) ||
  Node.isArrowFunction(n) ||
  Node.isMethodDeclaration(n) ||
  Node.isConstructorDeclaration(n) ||
  Node.isGetAccessorDeclaration(n) ||
  Node.isSetAccessorDeclaration(n) ||
  Node.isClassDeclaration(n) ||
  Node.isClassExpression(n);

const inFunction = (node: Node): boolean => node.getAncestors().some(FUNCTION_LIKE);

/** The top-level statement that contains a node. */
function topLevelStatementOf(node: Node, sf: SourceFile): Node | undefined {
  return node.getFirstAncestor((a) => a.getParent() === sf);
}

/** The external reads of a snippet, as the DUC lifter classifies them. undefined if it does not lift. */
function readsOf(text: string): { symbol: string; reason: DiamondReason }[] | undefined {
  try {
    const graph = liftAtom(text);
    return graph.nodes.flatMap((n) =>
      n.diamond !== undefined ? [{ symbol: n.diamond.symbol, reason: n.diamond.reason }] : [],
    );
  } catch {
    return undefined;
  }
}

/** A read is allowed when it is ambient, a foreign import, or a name in `ok`. */
function allowedRead(
  read: { symbol: string; reason: DiamondReason },
  ok: ReadonlySet<string>,
): boolean {
  if (read.reason === "platform-primitive" || read.reason === "unlinked-reference") return true;
  return ok.has(read.symbol);
}

/**
 * The classification of every top-level binding of a module, with the hash of its
 * declaration. Computed as a least fixpoint, from a sound base, so it only grows:
 *
 * 1. imports are pure;
 * 2. a variable that is never mutated, and whose initializer reads only allowed names, is pure;
 * 3. a variable whose every mutation is a top-level write, update, or method call, and
 *    whose every writing statement reads only allowed names (or other candidates), is pure
 *    (the initialization closure, DEC-DUC-MODULE-INIT-CLOSURE-001);
 * 4. a function that is never mutated, and whose reachable reads are all allowed, is pure.
 *    Reachability is computed over the whole function set. Memoized recursion is unsound
 *    inside cycles.
 *
 * Anything else is mutable. Destructured bindings are not recorded, so they are unexplained.
 */
export function moduleBindingsOf(moduleSource: string): Map<string, ModuleBindingInfo> {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  const sf = project.createSourceFile("__module__.ts", moduleSource, { scriptKind: ScriptKind.TS });

  // Declarations.
  const imports = new Map<string, string>();
  for (const decl of sf.getImportDeclarations()) {
    if (decl.isTypeOnly()) continue;
    const declHash = sha(decl.getText());
    const locals: string[] = [];
    const defaultImport = decl.getDefaultImport();
    if (defaultImport !== undefined) locals.push(defaultImport.getText());
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport !== undefined) locals.push(namespaceImport.getText());
    for (const named of decl.getNamedImports()) {
      if (named.isTypeOnly()) continue;
      locals.push((named.getAliasNode() ?? named.getNameNode()).getText());
    }
    for (const local of locals) imports.set(local, declHash);
  }

  // A CommonJS import (#1173): `require("x")`, or a member of it, binds an imported value, as an
  // import declaration does, whether the name is an identifier or a destructuring pattern.
  const isRequireOf = (init: Node | undefined): boolean => {
    let e = init;
    while (e !== undefined && Node.isPropertyAccessExpression(e)) e = e.getExpression();
    if (e === undefined || !Node.isCallExpression(e)) return false;
    const callee = e.getExpression();
    const [arg] = e.getArguments();
    return (
      Node.isIdentifier(callee) &&
      callee.getText() === "require" &&
      e.getArguments().length === 1 &&
      arg !== undefined &&
      Node.isStringLiteral(arg)
    );
  };
  const bindingNames = (n: Node): string[] => {
    if (Node.isIdentifier(n)) return [n.getText()];
    if (Node.isObjectBindingPattern(n) || Node.isArrayBindingPattern(n))
      return n
        .getElements()
        .flatMap((el) => (Node.isBindingElement(el) ? bindingNames(el.getNameNode()) : []));
    return [];
  };
  const vars = new Map<string, { declHash: string; init: Node | undefined; statement: Node }>();
  for (const stmt of sf.getVariableStatements()) {
    const declHash = sha(stmt.getText());
    for (const decl of stmt.getDeclarations()) {
      const nameNode = decl.getNameNode();
      const init = decl.getInitializer();
      if (isRequireOf(init)) {
        for (const name of bindingNames(nameNode)) imports.set(name, declHash);
        continue;
      }
      // A destructuring declaration binds each name in it, from the same initializer.
      for (const name of bindingNames(nameNode))
        vars.set(name, { declHash, init, statement: stmt });
    }
  }

  const fns = new Map<
    string,
    { declHash: string; text: string; reads: ReturnType<typeof readsOf> }
  >();
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name === undefined) continue;
    const text = fn.getText();
    fns.set(name, { declHash: sha(text), text, reads: readsOf(text) });
  }

  // Names whose value is always a primitive (a literal, or arithmetic over primitives). A
  // call or hand-off cannot mutate a primitive, so these are inert. Writes are still
  // checked separately below. A single pass in source order: an initializer may only read
  // a name declared before it, since a later one is still in its temporal dead zone.
  const primitive = new Set<string>();
  for (const [name, v] of vars) {
    if (v.init !== undefined && isPrimitiveExpr(v.init, primitive)) primitive.add(name);
  }
  const varSites = new Map<string, Site[]>();
  for (const [name, v] of vars) {
    const policy = primitive.has(name) ? INERT : policyForInit(v.init);
    varSites.set(name, mutationSites(sf, name, policy));
  }
  const fnSites = new Map<string, Site[]>();
  for (const name of fns.keys()) fnSites.set(name, mutationSites(sf, name, INERT));

  const pure = new Set<string>(imports.keys());
  const initClosure = new Map<string, Node[]>(); // name -> the top-level statements that write it

  const initAllowed = (init: Node | undefined): boolean => {
    if (init === undefined) return false;
    const reads = readsOf(`(${init.getText()});`);
    return reads?.every((r) => allowedRead(r, pure)) === true;
  };

  let changed = true;
  while (changed) {
    changed = false;

    // (2) never-mutated variables with allowed initializers.
    for (const [name, v] of vars) {
      if (pure.has(name) || (varSites.get(name) ?? []).length > 0) continue;
      if (initAllowed(v.init)) {
        pure.add(name);
        changed = true;
      }
    }

    // (3) initialization closure over candidates.
    const candidates = new Set<string>();
    for (const [name, v] of vars) {
      if (pure.has(name)) continue;
      const sites = varSites.get(name) ?? [];
      if (sites.length === 0 || v.init === undefined || !initAllowed(v.init)) continue;
      const eligible = sites.every(
        (s) =>
          s.kind !== "handoff" &&
          !inFunction(s.node) &&
          topLevelStatementOf(s.node, sf) !== undefined,
      );
      if (eligible) candidates.add(name);
    }
    let refined = true;
    while (refined) {
      refined = false;
      for (const name of [...candidates]) {
        for (const site of varSites.get(name) ?? []) {
          const stmt = topLevelStatementOf(site.node, sf);
          const reads = stmt === undefined ? undefined : readsOf(stmt.getText());
          const ok = reads?.every((r) => allowedRead(r, pure) || candidates.has(r.symbol));
          if (!ok) {
            candidates.delete(name);
            refined = true;
            break;
          }
        }
      }
    }
    for (const name of candidates) {
      const writers = (varSites.get(name) ?? [])
        .map((s) => topLevelStatementOf(s.node, sf))
        .filter((n): n is Node => n !== undefined);
      initClosure.set(name, [...new Map(writers.map((n) => [n.getPos(), n])).values()]);
      pure.add(name);
      changed = true;
    }

    // (4) functions: reachability over the whole function set.
    for (const name of fns.keys()) {
      if (pure.has(name)) continue;
      if (functionIsPure(name, fns, fnSites, pure)) {
        pure.add(name);
        changed = true;
      }
    }
  }

  const bindings = new Map<string, ModuleBindingInfo>();
  for (const [name, declHash] of imports) bindings.set(name, { binding: "pure", declHash });
  for (const [name, v] of vars) {
    if (pure.has(name)) {
      const writers = initClosure.get(name);
      const hash =
        writers === undefined
          ? v.declHash
          : sha([v.statement.getText(), ...writers.map((w) => w.getText())].join("\n"));
      bindings.set(name, { binding: "pure", declHash: hash });
    } else {
      bindings.set(name, { binding: "mutable", declHash: v.declHash });
    }
  }
  for (const [name, f] of fns) {
    bindings.set(name, { binding: pure.has(name) ? "pure" : "mutable", declHash: f.declHash });
  }
  return bindings;
}

/**
 * Whether a function is pure: it is never mutated, and every read reachable from it is
 * an allowed name, a pure name, or another function in the reachable set. Cycles with no
 * impure read are pure.
 */
function functionIsPure(
  start: string,
  fns: ReadonlyMap<string, { reads: ReturnType<typeof readsOf> }>,
  fnSites: ReadonlyMap<string, Site[]>,
  pure: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    const info = fns.get(name);
    if (info === undefined || info.reads === undefined || info.reads === null) return false;
    if ((fnSites.get(name) ?? []).length > 0) return false;
    const reads = info.reads;
    for (const read of reads) {
      if (read.reason === "platform-primitive" || read.reason === "unlinked-reference") continue;
      if (pure.has(read.symbol)) continue;
      if (fns.has(read.symbol)) {
        if (!seen.has(read.symbol)) {
          seen.add(read.symbol);
          queue.push(read.symbol);
        }
        continue;
      }
      return false;
    }
  }
  return true;
}
