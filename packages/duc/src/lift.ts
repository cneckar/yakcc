// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-GRAPH-MODEL-001 (the lifter)
// The lifter is yakcc's realization of a DUC "lift": it emits a def-use graph
// from an artifact (here, a strict-TS atom body) whose node semantics it never
// models. It follows the conservative-builder discipline (DUC §3, `push_op`):
// every use is resolved to an already-emitted value, or connected to a freshly
// emitted diamond-source, and *never silently dropped*. Control decisions flow
// as ordinary data into `sel` gates (Norm 2), so implicit flows are influence
// edges by construction.
//
// @decision DEC-DUC-SCOPE-001 (lift scope + soundness posture)
// The base graph is finite, acyclic, and path-insensitive. Precision is a
// refinement axis, not a soundness requirement: at any construct the lifter
// cannot model precisely it falls back to a single opaque node whose inputs are
// *all* the values the construct reads and whose outputs re-define every outer
// name it may assign. That is the coarsest sound summary opacity permits (the
// complete input->output relation), so the lift only ever over-approximates
// influence, never under-approximates it. Loops are summarized as one opaque
// node (mirrors shave's loop-is-the-atom bottoming-out); recursion-as-fixpoint
// is out of scope.

import { Node, Project, ScriptKind, SyntaxKind } from "ts-morph";
import type { DiamondReason, DucGraph, DucNode, NodeId, ValueId } from "./types.js";

/** Thrown when the source cannot be parsed into a graph (syntax error). */
export class DucLiftError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly string[],
  ) {
    super(message);
    this.name = "DucLiftError";
  }
}

/** Options controlling how free identifiers are classified into diamond reasons. */
export interface LiftOptions {
  /**
   * Free identifiers that name one of these are labelled `ambient-read` rather
   * than `free-identifier`. Defaults to the standard JS ambient globals a pure
   * atom may reference (Math, JSON, ...). They are still diamond-sources — the
   * label only records *why* the use is unresolved.
   */
  readonly ambientGlobals?: readonly string[];
}

const DEFAULT_AMBIENT_GLOBALS: readonly string[] = [
  "Math",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
];

interface ImportBinding {
  readonly reason: DiamondReason;
  readonly module: string;
}

interface MutableNode {
  readonly id: NodeId;
  inputs: ValueId[];
  readonly outputs: ValueId[];
  readonly kind: DucNode["kind"];
  readonly diamond?: DucNode["diamond"];
  readonly origin?: DucNode["origin"];
}

/**
 * Lift a strict-TS atom source into a DUC graph. The graph is single-assignment,
 * acyclic (loops are opaque nodes), and conservation-complete: every use is
 * resolved to a def or to a declared diamond-source. Deterministic: value and
 * node ids follow emission order, so the same source lifts to the same graph.
 *
 * @throws {DucLiftError} on a TypeScript *syntax* error (semantic errors such as
 *   "cannot find name" are expected — an unresolved name is exactly a
 *   diamond-source — and never throw).
 */
export function liftAtom(source: string, options: LiftOptions = {}): DucGraph {
  // noLib + syntactic-only diagnostics: we never type-check (an unresolved name
  // is a diamond-source, not an error), so we skip loading lib.d.ts and the
  // semantic pass entirely. This is the difference between a fast lift and a
  // multi-second one under coverage instrumentation.
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, noEmit: true, noLib: true, skipLibCheck: true },
  });
  const file = project.createSourceFile("atom.ts", source, { scriptKind: ScriptKind.TS });

  const syntaxDiagnostics = project.getProgram().getSyntacticDiagnostics(file);
  if (syntaxDiagnostics.length > 0) {
    const messages = syntaxDiagnostics.map((d) => {
      const msg = d.getMessageText();
      return typeof msg === "string" ? msg : msg.getMessageText();
    });
    throw new DucLiftError(
      `TypeScript syntax error(s) in atom source: ${messages[0] ?? "unknown"}`,
      messages,
    );
  }

  const ambient = new Set(options.ambientGlobals ?? DEFAULT_AMBIENT_GLOBALS);
  const builder = new Lifter(ambient);
  builder.collectImports(file);
  builder.run(file);
  return builder.finish();
}

// ---------------------------------------------------------------------------
// The lifter
// ---------------------------------------------------------------------------

class Lifter {
  private readonly nodes: MutableNode[] = [];
  private valueCounter = 0;
  private nodeCounter = 0;
  /** Flat current-value environment: name -> its current SSA value. */
  private env = new Map<string, ValueId>();
  /** Import bindings, name -> classification. */
  private readonly imports = new Map<string, ImportBinding>();
  /** Memoized diamond-sources, keyed by symbol so one unknown = one source. */
  private readonly diamonds = new Map<string, ValueId>();
  private readonly obs: ValueId[] = [];

  constructor(private readonly ambient: ReadonlySet<string>) {}

  // --- id minting ---
  private freshValue(): ValueId {
    return `v${this.valueCounter++}` as ValueId;
  }
  private freshNodeId(): NodeId {
    return `n${this.nodeCounter++}` as NodeId;
  }

  private emit(
    kind: DucNode["kind"],
    inputs: ValueId[],
    outCount: number,
    extra?: { diamond?: DucNode["diamond"]; origin?: DucNode["origin"] },
  ): ValueId[] {
    const outputs: ValueId[] = [];
    for (let i = 0; i < outCount; i++) outputs.push(this.freshValue());
    const node: MutableNode = {
      id: this.freshNodeId(),
      inputs,
      outputs,
      kind,
      ...(extra?.diamond !== undefined ? { diamond: extra.diamond } : {}),
      ...(extra?.origin !== undefined ? { origin: extra.origin } : {}),
    };
    this.nodes.push(node);
    return outputs;
  }

  // --- imports ---
  collectImports(file: Node): void {
    for (const child of file.getChildrenOfKind(SyntaxKind.ImportDeclaration)) {
      const decl = child.asKindOrThrow(SyntaxKind.ImportDeclaration);
      const moduleSpec = decl.getModuleSpecifierValue();
      if (decl.isTypeOnly()) continue; // type-only imports carry no runtime value
      const record = (name: string): void => {
        this.imports.set(name, { reason: "foreign-import", module: moduleSpec });
      };
      const clause = decl.getImportClause();
      if (clause === undefined) continue;
      const defaultImport = clause.getDefaultImport();
      if (defaultImport !== undefined) record(defaultImport.getText());
      const namespaceImport = clause.getNamespaceImport();
      if (namespaceImport !== undefined) record(namespaceImport.getText());
      for (const named of clause.getNamedImports()) {
        if (named.isTypeOnly()) continue;
        record((named.getAliasNode() ?? named.getNameNode()).getText());
      }
    }
  }

  // --- driver ---
  run(file: Node): void {
    const primary = findPrimaryFunction(file);
    if (primary !== undefined) {
      this.liftFunction(primary);
    } else {
      // No single exported function: lift the top-level statements in one scope,
      // and treat every exported binding's final value as an observation.
      for (const stmt of file.getChildSyntaxListOrThrow().getChildren()) {
        this.liftStatement(stmt);
      }
      for (const name of exportedBindingNames(file)) {
        const value = this.env.get(name);
        if (value !== undefined) this.obs.push(value);
      }
    }
  }

  private liftFunction(fn: FunctionLike): void {
    for (const param of fn.getParameters()) {
      const nameNode = param.getNameNode();
      const [value] = this.emit("param-source", [], 1, {
        origin: { kind: "Parameter", text: truncate(nameNode.getText()) },
      });
      // Destructured params: bind every identifier inside the pattern to the one
      // param-source value (conservative aliasing; sound).
      for (const name of patternNames(nameNode)) this.env.set(name, value as ValueId);
    }
    const body = fn.getBody();
    if (body === undefined) return;
    if (Node.isBlock(body)) {
      for (const stmt of body.getStatements()) this.liftStatement(stmt);
    } else {
      // Arrow with expression body: the expression is the observation.
      this.obs.push(this.liftExpr(body));
    }
  }

  // --- statements ---
  private liftStatement(node: Node): void {
    if (Node.isVariableStatement(node)) {
      for (const decl of node.getDeclarations()) {
        const init = decl.getInitializer();
        const value =
          init !== undefined
            ? this.liftExpr(init)
            : this.emit("literal-source", [], 1, { origin: { kind: "Uninitialized" } })[0];
        for (const name of patternNames(decl.getNameNode())) {
          this.env.set(name, value as ValueId);
        }
      }
      return;
    }
    if (Node.isExpressionStatement(node)) {
      this.liftExpr(node.getExpression());
      return;
    }
    if (Node.isReturnStatement(node)) {
      const expr = node.getExpression();
      if (expr !== undefined) this.obs.push(this.liftExpr(expr));
      return;
    }
    if (Node.isIfStatement(node)) {
      this.liftIf(node);
      return;
    }
    if (
      Node.isForStatement(node) ||
      Node.isForOfStatement(node) ||
      Node.isForInStatement(node) ||
      Node.isWhileStatement(node) ||
      Node.isDoStatement(node)
    ) {
      this.liftOpaqueRegion(node, "loop");
      return;
    }
    if (Node.isBlock(node)) {
      for (const stmt of node.getStatements()) this.liftStatement(stmt);
      return;
    }
    if (Node.isSwitchStatement(node) || Node.isTryStatement(node)) {
      this.liftOpaqueRegion(node, "op");
      return;
    }
    // Any other statement (throw, expression-less, declarations we don't bind):
    // still resolve its reads so nothing is dropped.
    this.liftOpaqueRegion(node, "op", { discardOutputs: true });
  }

  private liftIf(node: import("ts-morph").IfStatement): void {
    const condValue = this.liftExpr(node.getExpression());
    const before = new Map(this.env);

    const thenEnv = this.branch(before, () => this.liftStatement(node.getThenStatement()));
    const elseStmt = node.getElseStatement();
    const elseEnv =
      elseStmt !== undefined ? this.branch(before, () => this.liftStatement(elseStmt)) : before;

    // Join: for every name live before the if, if the two branches disagree emit
    // a sel gate with the condition as an ordinary input (control-as-data).
    for (const [name, beforeValue] of before) {
      const thenValue = thenEnv.get(name) ?? beforeValue;
      const elseValue = elseEnv.get(name) ?? beforeValue;
      if (thenValue !== elseValue) {
        const [joined] = this.emit("sel", [condValue, thenValue, elseValue], 1, {
          origin: { kind: "IfJoin", text: name },
        });
        this.env.set(name, joined as ValueId);
      }
    }
  }

  /** Run `body` over a cloned env and return the resulting env, restoring `this.env`. */
  private branch(base: ReadonlyMap<string, ValueId>, body: () => void): Map<string, ValueId> {
    const saved = this.env;
    const clone = new Map(base);
    // Swap in the clone as the live env for the duration of the branch.
    this.env = clone;
    body();
    this.env = saved;
    return clone;
  }

  /**
   * Summarize a whole region (loop, switch, try, unknown statement) as one opaque
   * node: inputs are every value the region reads; outputs re-define every outer
   * name the region may assign. Any `return` inside contributes its expression as
   * an observation. This is the coarsest sound summary (DEC-DUC-SCOPE-001).
   */
  private liftOpaqueRegion(
    node: Node,
    kind: "loop" | "op",
    opts: { discardOutputs?: boolean } = {},
  ): void {
    const reads = this.collectReads(node);
    const assigned = opts.discardOutputs ? [] : this.collectAssignedOuterNames(node);
    const outputs = this.emit(kind, reads, assigned.length, {
      origin: { kind: node.getKindName(), text: truncate(node.getText()) },
    });
    assigned.forEach((name, i) => {
      const out = outputs[i];
      if (out !== undefined) this.env.set(name, out);
    });
    // Observations from returns inside the region (any return may be observed).
    for (const ret of node.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const expr = ret.getExpression();
      if (expr !== undefined) this.obs.push(this.liftExpr(expr));
    }
  }

  /**
   * Every value a subtree reads. Identifiers bound *inside* the subtree (loop
   * variables, body-local `const`/`let`, a nested closure's own parameters) are
   * internal to the opaque region and are skipped — resolving them would mint a
   * spurious diamond-source for a name that is not actually an external unknown.
   */
  private collectReads(node: Node): ValueId[] {
    const locals = collectRegionLocals(node);
    const values: ValueId[] = [];
    const seen = new Set<ValueId>();
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (locals.has(name)) continue; // declared inside this region — not a read of outer scope
      const value = this.resolveIdentifier(name);
      if (!seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
    return values;
  }

  /**
   * Outer names a subtree may assign. Covers identifier targets (`x = …`, `x +=
   * …`, `x++`) and member/element targets whose base is an outer identifier
   * (`o.v = …`, `arr[i] = …`) — the latter mutate the object the name refers to,
   * so the loop summary must re-define that name or the mutation's influence is
   * lost.
   */
  private collectAssignedOuterNames(node: Node): string[] {
    const names = new Set<string>();
    const consider = (target: Node | undefined): void => {
      const base = baseIdentifierOfTarget(target);
      if (base !== undefined && this.env.has(base)) names.add(base);
    };
    for (const bin of node.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const op = bin.getOperatorToken().getKind();
      if (op === SyntaxKind.EqualsToken || COMPOUND_ASSIGN.has(op)) consider(bin.getLeft());
    }
    const unaries = [
      ...node.getDescendantsOfKind(SyntaxKind.PostfixUnaryExpression),
      ...node.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression),
    ];
    for (const un of unaries) consider(un.getOperand());
    return [...names];
  }

  // --- expressions ---
  private liftExpr(node: Node): ValueId {
    if (Node.isIdentifier(node)) {
      return this.resolveIdentifier(node.getText());
    }
    if (isLiteralExpression(node)) {
      return this.emit("literal-source", [], 1, {
        origin: { kind: node.getKindName(), text: truncate(node.getText()) },
      })[0] as ValueId;
    }
    if (Node.isParenthesizedExpression(node)) {
      return this.liftExpr(node.getExpression());
    }
    if (
      Node.isAsExpression(node) ||
      Node.isTypeAssertion(node) ||
      Node.isNonNullExpression(node) ||
      Node.isSatisfiesExpression(node)
    ) {
      return this.liftExpr(node.getExpression());
    }
    if (Node.isBinaryExpression(node)) {
      return this.liftBinary(node);
    }
    if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
      const operand = node.getOperand();
      const value = this.liftExpr(operand);
      const [out] = this.emit("op", [value], 1, { origin: { kind: node.getKindName() } });
      // ++/-- on a bound identifier reassigns it.
      if (Node.isIdentifier(operand) && this.env.has(operand.getText())) {
        this.env.set(operand.getText(), out as ValueId);
      }
      return out as ValueId;
    }
    if (Node.isConditionalExpression(node)) {
      const cond = this.liftExpr(node.getCondition());
      const whenTrue = this.liftExpr(node.getWhenTrue());
      const whenFalse = this.liftExpr(node.getWhenFalse());
      return this.emit("sel", [cond, whenTrue, whenFalse], 1, {
        origin: { kind: "Conditional" },
      })[0] as ValueId;
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      const inputs: ValueId[] = [];
      const callee = node.getExpression();
      if (callee !== undefined) inputs.push(this.liftExpr(callee));
      for (const arg of node.getArguments()) inputs.push(this.liftExpr(arg as Node));
      return this.emit("op", inputs, 1, {
        origin: { kind: node.getKindName(), text: truncate(node.getText()) },
      })[0] as ValueId;
    }
    if (Node.isPropertyAccessExpression(node)) {
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: "PropertyAccess", text: truncate(node.getText()) },
      })[0] as ValueId;
    }
    if (Node.isElementAccessExpression(node)) {
      const inputs = [
        this.liftExpr(node.getExpression()),
        this.liftExpr(node.getArgumentExpressionOrThrow()),
      ];
      return this.emit("op", inputs, 1, { origin: { kind: "ElementAccess" } })[0] as ValueId;
    }
    if (Node.isArrayLiteralExpression(node)) {
      const inputs = node.getElements().map((el) => this.liftExpr(el));
      return this.emit("op", inputs, 1, { origin: { kind: "ArrayLiteral" } })[0] as ValueId;
    }
    if (Node.isObjectLiteralExpression(node)) {
      return this.emit("op", this.collectReads(node), 1, {
        origin: { kind: "ObjectLiteral" },
      })[0] as ValueId;
    }
    if (Node.isTemplateExpression(node)) {
      const inputs = node.getTemplateSpans().map((span) => this.liftExpr(span.getExpression()));
      return this.emit("op", inputs, 1, { origin: { kind: "Template" } })[0] as ValueId;
    }
    if (Node.isAwaitExpression(node) || Node.isYieldExpression(node)) {
      const inner = node.getExpression();
      const inputs = inner !== undefined ? [this.liftExpr(inner)] : [];
      return this.emit("op", inputs, 1, { origin: { kind: node.getKindName() } })[0] as ValueId;
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      // A closure is a value that carries the free variables it captures.
      return this.emit("op", this.collectReads(node), 1, {
        origin: { kind: "Closure" },
      })[0] as ValueId;
    }
    // Fallback: opaque node over every value the expression reads (sound).
    return this.emit("op", this.collectReads(node), 1, {
      origin: { kind: node.getKindName(), text: truncate(node.getText()) },
    })[0] as ValueId;
  }

  private liftBinary(node: import("ts-morph").BinaryExpression): ValueId {
    const op = node.getOperatorToken().getKind();
    const left = node.getLeft();
    if (op === SyntaxKind.EqualsToken) {
      const value = this.liftExpr(node.getRight());
      this.assignTo(left, value);
      return value;
    }
    if (COMPOUND_ASSIGN.has(op)) {
      // `x += e` reads the old value and the rhs, then rebinds.
      const oldValue = this.liftExpr(left);
      const rhs = this.liftExpr(node.getRight());
      const [out] = this.emit("op", [oldValue, rhs], 1, { origin: { kind: node.getKindName() } });
      this.assignTo(left, out as ValueId);
      return out as ValueId;
    }
    const l = this.liftExpr(left);
    const r = this.liftExpr(node.getRight());
    return this.emit("op", [l, r], 1, {
      origin: { kind: "Binary", text: node.getOperatorToken().getText() },
    })[0] as ValueId;
  }

  /** Reassign an lvalue. Identifier -> rebind; member/element -> mutate base object. */
  private assignTo(lhs: Node, value: ValueId): void {
    if (Node.isIdentifier(lhs)) {
      this.env.set(lhs.getText(), value);
      return;
    }
    if (Node.isPropertyAccessExpression(lhs) || Node.isElementAccessExpression(lhs)) {
      const base = lhs.getExpression();
      const inputs = [this.liftExpr(base)];
      // For `arr[i] = v`, the index chooses which slot is written, so it
      // influences the mutated object; include it as an input.
      if (Node.isElementAccessExpression(lhs)) {
        inputs.push(this.liftExpr(lhs.getArgumentExpressionOrThrow()));
      }
      inputs.push(value);
      const [mutated] = this.emit("op", inputs, 1, { origin: { kind: "Write" } });
      if (Node.isIdentifier(base) && this.env.has(base.getText())) {
        this.env.set(base.getText(), mutated as ValueId);
      }
      return;
    }
    // Destructuring / other lvalue: conservatively rebind every bound name inside.
    for (const name of patternNames(lhs)) {
      if (this.env.has(name)) this.env.set(name, value);
    }
  }

  /** Resolve an identifier read to a value: bound name, import, ambient, or free. */
  private resolveIdentifier(name: string): ValueId {
    const bound = this.env.get(name);
    if (bound !== undefined) return bound;

    const existingDiamond = this.diamonds.get(name);
    if (existingDiamond !== undefined) return existingDiamond;

    const imported = this.imports.get(name);
    const reason: DiamondReason =
      imported !== undefined
        ? "foreign-import"
        : this.ambient.has(name)
          ? "ambient-read"
          : "free-identifier";
    const [value] = this.emit("diamond-source", [], 1, {
      diamond: {
        reason,
        symbol: name,
        ...(imported !== undefined ? { module: imported.module } : {}),
      },
      origin: { kind: "DiamondSource", text: name },
    });
    this.diamonds.set(name, value as ValueId);
    return value as ValueId;
  }

  finish(): DucGraph {
    const nodes: DucNode[] = this.nodes.map((n) => ({
      id: n.id,
      inputs: n.inputs,
      outputs: n.outputs,
      kind: n.kind,
      ...(n.diamond !== undefined ? { diamond: n.diamond } : {}),
      ...(n.origin !== undefined ? { origin: n.origin } : {}),
    }));
    const values: ValueId[] = [];
    for (const node of nodes) for (const out of node.outputs) values.push(out);
    return { nodes, values, obs: dedupe(this.obs) };
  }
}

// ---------------------------------------------------------------------------
// ts-morph helpers
// ---------------------------------------------------------------------------

type FunctionLike =
  | import("ts-morph").FunctionDeclaration
  | import("ts-morph").ArrowFunction
  | import("ts-morph").FunctionExpression;

const COMPOUND_ASSIGN = new Set<SyntaxKind>([
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

function isLiteralExpression(node: Node): boolean {
  return (
    Node.isNumericLiteral(node) ||
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isRegularExpressionLiteral(node) ||
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword ||
    node.getKind() === SyntaxKind.NullKeyword
  );
}

/** Whether an identifier node is a *value read* (not a declaration name, property key, etc.). */
function isValueRead(id: import("ts-morph").Identifier): boolean {
  const parent = id.getParent();
  if (parent === undefined) return false;
  // Property access member name (`obj.PROP`) is not a free read.
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false;
  // Property assignment key (`{ KEY: v }`) is not a read.
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return false;
  // A binding/declaration name is not a read.
  if (
    (Node.isVariableDeclaration(parent) ||
      Node.isParameterDeclaration(parent) ||
      Node.isBindingElement(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isMethodDeclaration(parent)) &&
    (parent as { getNameNode?: () => Node | undefined }).getNameNode?.() === id
  ) {
    return false;
  }
  return true;
}

/**
 * Names bound *inside* a region: variable declarations (including `for`-header
 * and `for-of`/`for-in` loop variables) and parameters of nested functions. Used
 * to tell an opaque region's genuine external reads from its own internal names.
 */
function collectRegionLocals(node: Node): Set<string> {
  const locals = new Set<string>();
  for (const decl of node.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    for (const name of patternNames(decl.getNameNode())) locals.add(name);
  }
  for (const param of node.getDescendantsOfKind(SyntaxKind.Parameter)) {
    for (const name of patternNames(param.getNameNode())) locals.add(name);
  }
  return locals;
}

/**
 * The root identifier name of an assignment target: `x` for `x`, `o` for `o.v`
 * or `o.a.b`, `arr` for `arr[i]`. Returns undefined for any other lvalue shape
 * (e.g. a destructuring pattern), which the caller handles conservatively.
 */
function baseIdentifierOfTarget(target: Node | undefined): string | undefined {
  let current = target;
  while (current !== undefined) {
    if (Node.isIdentifier(current)) return current.getText();
    if (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** All identifier names bound by a (possibly destructuring) binding-name node. */
function patternNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  const names: string[] = [];
  for (const id of nameNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
    // Inside a binding pattern, an identifier is a bound name iff it is the
    // name-node of its binding element (excludes property keys, computed keys,
    // and default-value references to outer scope).
    const parent = id.getParent();
    if (parent !== undefined && Node.isBindingElement(parent) && parent.getNameNode() === id) {
      names.push(id.getText());
    }
  }
  return names.length > 0 ? names : [nameNode.getText()];
}

/**
 * The atom's primary function-like, if it has one. A shaved atom is typically a
 * single factored function; that function's parameters are the atom's boundary
 * (parameter-sources) and its returns are the observations.
 *
 * Selection order:
 *   1. If exactly one top-level function-like is *exported*, it is primary
 *      (an entry point among helpers). More than one exported → ambiguous, none.
 *   2. Otherwise, if the file has exactly one top-level function-like at all
 *      (whether or not it is exported), that lone function is primary. This is
 *      the common shave-atom shape: a bare `function f(...) {…}` fragment. Without
 *      this clause such an atom falls to the top-level-statement path, where the
 *      declaration is summarized as one opaque region and its `return`s are
 *      re-lifted in the empty outer scope — so the function's own parameters and
 *      `var` locals surface as spurious `free-identifier` diamonds and the
 *      observations disconnect from the body.
 *
 * Only genuine top-level bindings are considered (nested closures are not
 * candidates); imports are irrelevant here (handled by `collectImports`).
 */
function findPrimaryFunction(file: Node): FunctionLike | undefined {
  const sourceFile = file as import("ts-morph").SourceFile;
  const exported: FunctionLike[] = [];
  const all: FunctionLike[] = [];

  for (const fn of sourceFile.getFunctions()) {
    all.push(fn);
    if (fn.isExported()) exported.push(fn);
  }
  // Only top-level variable statements bind module-scope names; iterating
  // statements (not getVariableDeclarations, which can reach into nested scopes)
  // keeps a nested arrow from being mistaken for a top-level function-like.
  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (init === undefined) continue;
      if (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) continue;
      all.push(init);
      if (stmt.isExported()) exported.push(init);
    }
  }

  if (exported.length === 1) return exported[0];
  if (exported.length > 1) return undefined; // ambiguous entry point — top-level path
  // No exported function-like: a lone bare function declaration is the atom.
  return all.length === 1 ? all[0] : undefined;
}

/** Names of all exported top-level bindings (for the no-primary-function case). */
function exportedBindingNames(file: Node): string[] {
  const names: string[] = [];
  for (const decl of (file as import("ts-morph").SourceFile).getVariableDeclarations()) {
    if (decl.isExported()) names.push(...patternNames(decl.getNameNode()));
  }
  return names;
}

function truncate(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function dedupe(values: readonly ValueId[]): ValueId[] {
  return [...new Set(values)];
}
