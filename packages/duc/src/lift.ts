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

import { Node, Project, ScriptKind, type SourceFile, SyntaxKind } from "ts-morph";
import { canonicalizeGraph } from "./canonical.js";
import type { DiamondReason, DucBranch, DucGraph, DucNode, NodeId, ValueId } from "./types.js";

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
   * Free identifiers that name one of these are labelled `platform-primitive` rather
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
  "encodeURI",
  "decodeURI",
  // Pure legacy string codecs. Like encodeURIComponent they are total functions of their argument.
  "escape",
  "unescape",
  "globalThis",
  // Implicit per-call binding of a non-arrow function. It is a runtime input, not a
  // dangling name. The diamond still feeds the result, so influence is kept.
  "arguments",
  // Pure host data: reading these carries no authority and schedules no code. Timers,
  // process, require, module, exports, and the __dirname/__filename bindings are NOT here:
  // they reach the environment or run code later, so they stay unexplained until a
  // checker classifies them (DEC-DUC-HOST-GLOBALS-001).
  // Pure ECMAScript builtins: typed arrays and buffers are data constructors.
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "ArrayBuffer",
  "DataView",
  "Buffer",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "structuredClone",
  "atob",
  "btoa",
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
  readonly label?: string;
  readonly region?: string;
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
  // A shaved fragment is not always a standalone statement: it may be an anonymous
  // function expression (`function (a, b) {…}`) or a bare function body (`{ … return }`).
  // We try the source as written first. Only when it does not parse do we try the
  // analysis forms in order (a named function, then a function body, then an
  // expression). Each form keeps the fragment's parameters as parameter-sources and
  // its returns as observations, so no influence edge is lost. The first form that
  // parses wins. If none parses, the error reported is for the source as written.
  const forms = [source, ...wrapForms(source)];
  let file: SourceFile | undefined;
  let firstError: string[] = [];
  let project: Project | undefined;
  for (const [index, candidate] of forms.entries()) {
    // noLib + syntactic-only diagnostics: we never type-check (an unresolved name
    // is a diamond-source, not an error), so we skip loading lib.d.ts and the
    // semantic pass entirely. This is the difference between a fast lift and a
    // multi-second one under coverage instrumentation.
    const attempt = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: false, noEmit: true, noLib: true, skipLibCheck: true },
    });
    const sf = attempt.createSourceFile("atom.ts", candidate, { scriptKind: ScriptKind.TS });
    const diagnostics = attempt.getProgram().getSyntacticDiagnostics(sf);
    if (diagnostics.length === 0) {
      project = attempt;
      file = sf;
      break;
    }
    if (index === 0) {
      firstError = diagnostics.map((d) => {
        const msg = d.getMessageText();
        return typeof msg === "string" ? msg : msg.getMessageText();
      });
    }
  }
  if (project === undefined || file === undefined) {
    throw new DucLiftError(
      `TypeScript syntax error(s) in atom source: ${firstError[0] ?? "unknown"}`,
      firstError,
    );
  }

  const ambient = new Set(options.ambientGlobals ?? DEFAULT_AMBIENT_GLOBALS);
  const builder = new Lifter(ambient);
  builder.collectImports(file);
  builder.run(file);
  return builder.finish();
}

/**
 * Analysis forms for a fragment that is not a standalone statement, tried in order.
 * An anonymous `function (…) {…}` becomes a named declaration, so its parameters bind
 * as parameter-sources. A bare body becomes the body of a function, so its `return`s
 * are observations and its free reads are unknowns. An expression is wrapped in
 * parentheses as a last resort.
 */
function wrapForms(source: string): string[] {
  const forms: string[] = [];
  const anonymousFunction = /^\s*(async\s+)?function\s*(\*?)\s*\(/;
  const match = anonymousFunction.exec(source);
  if (match !== null) {
    const async = match[1] !== undefined ? "async " : "";
    const star = match[2] !== "" ? "*" : "";
    forms.push(source.replace(anonymousFunction, `${async}function${star} __atom__(`));
  }
  forms.push(`function __atom__() {\n${source}\n}`);
  forms.push(`(${source}\n)`);
  return forms;
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
  /** Function declarations already bound by hoisting (compiler nodes). */
  private readonly hoisted = new Set<unknown>();
  /** The `if` branches recorded so far, in lifting order (ids are assigned here). */
  private readonly branches: DucBranch[] = [];
  private branchCount = 0;
  /** The branch path the statement being lifted lies in, outermost first. */
  private readonly regionStack: string[] = [];
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
    extra?: { diamond?: DucNode["diamond"]; origin?: DucNode["origin"]; label?: string },
  ): ValueId[] {
    const outputs: ValueId[] = [];
    for (let i = 0; i < outCount; i++) outputs.push(this.freshValue());
    const node: MutableNode = {
      id: this.freshNodeId(),
      inputs,
      outputs,
      kind,
      ...(this.regionStack.length > 0 ? { region: this.regionStack.join("/") } : {}),
      ...(extra?.diamond !== undefined ? { diamond: extra.diamond } : {}),
      ...(extra?.origin !== undefined ? { origin: extra.origin } : {}),
      // Structural label (D6): explicit, else the syntactic kind of the origin.
      ...(extra?.label !== undefined
        ? { label: extra.label }
        : extra?.origin !== undefined && (kind === "op" || kind === "literal-source")
          ? { label: extra.origin.kind }
          : {}),
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
        this.imports.set(name, { reason: "unlinked-reference", module: moduleSpec });
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
      this.liftStatements(file.getChildSyntaxListOrThrow().getChildren());
      for (const name of exportedBindingNames(file)) {
        const value = this.env.get(name);
        if (value !== undefined) this.obs.push(value);
      }
    }
  }

  private liftFunction(fn: FunctionLike): void {
    for (const [index, param] of fn.getParameters().entries()) {
      const nameNode = param.getNameNode();
      const [value] = this.emit("param-source", [], 1, {
        origin: { kind: "Parameter", text: truncate(nameNode.getText()) },
        label: String(index),
      });
      // Destructured params: bind every identifier inside the pattern to the one
      // param-source value (conservative aliasing; sound).
      for (const name of patternNames(nameNode)) this.env.set(name, value as ValueId);
    }
    const body = fn.getBody();
    if (body === undefined) return;
    if (Node.isBlock(body)) {
      this.liftStatements(body.getStatements());
    } else {
      // Arrow with expression body: the expression is the observation.
      this.obs.push(this.liftExpr(body));
    }
  }

  // --- statements ---

  /**
   * Lifts a statement list. Function declarations are bound before the statements run
   * (hoisting), so a call that precedes the declaration resolves to it. A function is
   * hoisted only when every name it reads that is declared in this list is already
   * bound; otherwise it is bound at its own position. The deferred case is sound: a
   * call before that position resolves to an unknown, never to a missing edge.
   */
  private liftStatements(stmts: readonly Node[]): void {
    const declared = new Set<string>();
    for (const stmt of stmts) {
      if (Node.isVariableStatement(stmt)) {
        for (const decl of stmt.getDeclarations()) {
          for (const name of patternNames(decl.getNameNode())) declared.add(name);
        }
      } else if (Node.isFunctionDeclaration(stmt)) {
        const name = stmt.getName();
        if (name !== undefined) declared.add(name);
      }
    }
    const hoistedNames = new Set<string>();
    for (const stmt of stmts) {
      if (!Node.isFunctionDeclaration(stmt)) continue;
      const name = stmt.getName();
      if (name === undefined) continue;
      const pending = this.readNamesOf(stmt).some(
        (read) => read !== name && declared.has(read) && !hoistedNames.has(read),
      );
      if (pending) continue;
      this.bindFunctionDeclaration(stmt, name);
      this.hoisted.add(stmt.compilerNode);
      hoistedNames.add(name);
    }
    for (const stmt of stmts) this.liftStatement(stmt);
  }

  /** Binds a function declaration to a closure value over the names it reads. */
  private bindFunctionDeclaration(
    stmt: import("ts-morph").FunctionDeclaration,
    name: string,
  ): void {
    // A function's own name inside its body is recursion, not an external read: the
    // recursive result is a value of the closure itself, not a new input to it.
    const value = this.emit("op", this.collectReads(stmt, new Set([name])), 1, {
      origin: { kind: "Closure", text: truncate(name) },
    })[0] as ValueId;
    this.env.set(name, value);
  }

  /** Names a subtree reads from an enclosing scope (identifiers not bound inside it). */
  private readNamesOf(node: Node): string[] {
    const locals = collectRegionLocals(node);
    const names = new Set<string>();
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (!locals.has(name)) names.add(name);
    }
    return [...names];
  }

  private liftStatement(node: Node): void {
    if (Node.isClassDeclaration(node) && node.getName() !== undefined) {
      // A named class is bound at its own position. Its own name inside its body is
      // a self-reference, not an external read, as with a recursive function.
      const name = node.getName() as string;
      const value = this.emit("op", this.collectReads(node, new Set([name])), 1, {
        origin: { kind: "Class", text: truncate(name) },
      })[0] as ValueId;
      this.env.set(name, value);
      return;
    }
    if (Node.isFunctionDeclaration(node)) {
      // Bound by liftStatements when hoisted; otherwise bind at this position.
      const name = node.getName();
      if (name !== undefined && !this.hoisted.has(node.compilerNode)) {
        this.bindFunctionDeclaration(node, name);
      }
      return;
    }
    if (Node.isVariableStatement(node)) {
      for (const decl of node.getDeclarations()) {
        const init = decl.getInitializer();
        const value =
          init !== undefined
            ? this.liftExpr(init)
            : this.emit("literal-source", [], 1, { origin: { kind: "Uninitialized" }, label: "Uninitialized" })[0];
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
      this.liftStatements(node.getStatements());
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
    // Record the branch, and lift each side inside its own region, so the structure is kept.
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: condValue, ...(within !== undefined ? { within } : {}) });

    const thenEnv = this.inRegion(`${id}.t`, () =>
      this.branch(before, () => this.liftStatement(node.getThenStatement())),
    );
    const elseStmt = node.getElseStatement();
    const elseEnv =
      elseStmt !== undefined
        ? this.inRegion(`${id}.e`, () => this.branch(before, () => this.liftStatement(elseStmt)))
        : before;

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

  /** Run `body` with `segment` pushed onto the region path, then restore it. */
  private inRegion<T>(segment: string, body: () => T): T {
    this.regionStack.push(segment);
    try {
      return body();
    } finally {
      this.regionStack.pop();
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
    // Observations from returns that belong to this region's own scope. A return
    // inside a nested function, method, or accessor returns from that closure, not
    // from the atom, so it is not an observation here; the closure's captured reads
    // are already in `reads`. A return's expression is lifted with the region's own
    // bindings (loop variables, body-local declarations, parameters of nested
    // closures) in scope, bound to the region's output, so they are not reported as
    // free identifiers of the atom.
    const returns = node
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((ret) => ret.getExpression() !== undefined && !isInsideNestedFunction(ret, node));
    if (returns.length > 0) {
      const locals = collectRegionLocals(node);
      const scope =
        locals.size > 0
          ? (this.emit("op", reads, 1, { origin: { kind: "RegionScope" } })[0] as ValueId)
          : undefined;
      for (const ret of returns) {
        const expr = ret.getExpression() as Node;
        this.obs.push(
          scope === undefined ? this.liftExpr(expr) : this.liftExprWithShadow(expr, locals, scope),
        );
      }
    }
  }

  /** Lifts `expr` with each name in `shadowed` bound to `value`, then restores the environment. */
  private liftExprWithShadow(expr: Node, shadowed: Set<string>, value: ValueId): ValueId {
    const saved = new Map<string, ValueId | undefined>();
    for (const name of shadowed) {
      saved.set(name, this.env.get(name));
      this.env.set(name, value);
    }
    try {
      return this.liftExpr(expr);
    } finally {
      for (const [name, prev] of saved) {
        if (prev === undefined) this.env.delete(name);
        else this.env.set(name, prev);
      }
    }
  }

  /**
   * Every value a subtree reads. Identifiers bound *inside* the subtree (loop
   * variables, body-local `const`/`let`, a nested closure's own parameters) are
   * internal to the opaque region and are skipped — resolving them would mint a
   * spurious diamond-source for a name that is not actually an external unknown.
   */
  private collectReads(node: Node, extraLocals: ReadonlySet<string> = new Set()): ValueId[] {
    const locals = collectRegionLocals(node);
    for (const name of extraLocals) locals.add(name);
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
        label: node.getText(),
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
      const [out] = this.emit("op", [oldValue, rhs], 1, {
        origin: { kind: node.getKindName() },
        label: node.getOperatorToken().getText(),
      });
      this.assignTo(left, out as ValueId);
      return out as ValueId;
    }
    const l = this.liftExpr(left);
    const r = this.liftExpr(node.getRight());
    return this.emit("op", [l, r], 1, {
      origin: { kind: "Binary", text: node.getOperatorToken().getText() },
      label: node.getOperatorToken().getText(),
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
        ? "unlinked-reference"
        : this.ambient.has(name)
          ? "platform-primitive"
          : "free-identifier";
    // A source is one per symbol and is reused wherever the name is read, so it lives at the top
    // level, not in the branch where it was first read.
    const savedRegion = this.regionStack.splice(0);
    let value: ValueId;
    try {
      [value] = this.emit("diamond-source", [], 1, {
        diamond: {
          reason,
          symbol: name,
          ...(imported !== undefined ? { module: imported.module } : {}),
        },
        origin: { kind: "DiamondSource", text: name },
      }) as [ValueId];
    } finally {
      this.regionStack.push(...savedRegion);
    }
    this.diamonds.set(name, value as ValueId);
    return value as ValueId;
  }

  finish(): DucGraph {
    // Renumber by structure, so the graph does not depend on traversal order (P1, #1275).
    const nodes: DucNode[] = this.nodes.map((n) => ({
      id: n.id,
      inputs: n.inputs,
      outputs: n.outputs,
      kind: n.kind,
      ...(n.diamond !== undefined ? { diamond: n.diamond } : {}),
      ...(n.origin !== undefined ? { origin: n.origin } : {}),
      ...(n.label !== undefined ? { label: n.label } : {}),
      ...(n.region !== undefined ? { region: n.region } : {}),
    }));
    return canonicalizeGraph(nodes, dedupe(this.obs), this.branches);
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
  // Names inside JSDoc (tags such as @param, @returns, and type expressions) are
  // documentation, not value reads.
  if (id.getFirstAncestor((n) => n.getKindName().startsWith("JSDoc")) !== undefined) return false;
  const parent = id.getParent();
  if (parent === undefined) return false;
  // Statement labels (`outer:` and `break outer` / `continue outer`) name a statement,
  // not a value.
  if (
    (Node.isLabeledStatement(parent) ||
      Node.isBreakStatement(parent) ||
      Node.isContinueStatement(parent)) &&
    (parent as { getLabel?: () => Node | undefined }).getLabel?.() === id
  ) {
    return false;
  }
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
 * Whether `node` sits inside a function-like scope nested within `boundary`
 * (a function, arrow, method, constructor, or accessor). Such a node belongs to
 * that closure, not to the enclosing region's own control flow.
 */
function isInsideNestedFunction(node: Node, boundary: Node): boolean {
  for (let cur = node.getParent(); cur !== undefined; cur = cur.getParent()) {
    if (cur.compilerNode === boundary.compilerNode) return false;
    if (
      Node.isFunctionDeclaration(cur) ||
      Node.isFunctionExpression(cur) ||
      Node.isArrowFunction(cur) ||
      Node.isMethodDeclaration(cur) ||
      Node.isConstructorDeclaration(cur) ||
      Node.isGetAccessorDeclaration(cur) ||
      Node.isSetAccessorDeclaration(cur)
    ) {
      return true;
    }
  }
  return false;
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
