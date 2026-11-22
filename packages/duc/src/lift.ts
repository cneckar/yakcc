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

import { createHash } from "node:crypto";
import { Node, Project, ScriptKind, type SourceFile, SyntaxKind, ts } from "ts-morph";
import { canonicalizeGraph } from "./canonical.js";
import type { DiamondReason, DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

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
  loop?: DucLoop;
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
  /** The loops being lifted, innermost last. */
  private readonly loopFrames: LoopFrame[] = [];
  private loopCount = 0;
  /** Values made outside every region (free and ambient sources): visible to every loop body. */
  private readonly topLevel = new Set<ValueId>();
  /** Return frames: a total side collects its returns; undefined is a flat frame (observations). */
  private readonly returnFrames: (ValueId[] | undefined)[] = [];
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
    if (this.regionStack.length === 0) for (const v of outputs) this.topLevel.add(v);
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
      // Returns on some paths: the observation is the value of the return state at the end.
      if (this.env.has(RETURN_DONE)) this.obs.push(this.env.get(RETURN_VALUE) as ValueId);
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
    for (const [i, stmt] of stmts.entries()) {
      // An `if` whose side always returns takes the rest of the list onto its other side, so every
      // return is on one path, and the two returns join into one observation (see totalSides).
      if (Node.isIfStatement(stmt)) {
        const sides = totalSides(stmt, stmts.slice(i + 1));
        if (sides !== undefined) {
          this.liftIf(stmt, sides);
          return;
        }
      }
      this.liftStatement(stmt);
    }
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
      label: this.opaqueLabel("Closure", stmt, new Set([name])),
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
        label: this.opaqueLabel("Class", node, new Set([name])),
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
      if (expr !== undefined) this.reportReturn(this.liftExpr(expr));
      else if (this.env.has(RETURN_DONE)) this.recordPartialReturn(this.undefinedValue());
      return;
    }
    if (Node.isIfStatement(node)) {
      this.liftIf(node);
      return;
    }
    if ((Node.isForStatement(node) || Node.isWhileStatement(node)) && this.liftLoop(node)) return;
    if ((Node.isForOfStatement(node) || Node.isForInStatement(node)) && this.liftIterate(node)) return;
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
    if (Node.isThrowStatement(node)) {
      // The thrown value is structure: it is lifted like any expression.
      this.emit("op", [this.liftExpr(node.getExpression())], 0, {
        origin: { kind: "ThrowStatement" },
        label: "throw",
      });
      return;
    }
    // Any other statement (expression-less, declarations we don't bind):
    // still resolve its reads so nothing is dropped.
    this.liftOpaqueRegion(node, "op", { discardOutputs: true });
  }

  /**
   * Lifts an `if`. With `sides`, the statement list's rest belongs to a side (see totalSides): both
   * sides always return, so the result is the join of their returns, one observation under the
   * condition. Otherwise the sides are the statements written, and their values join as names.
   */
  private liftIf(node: import("ts-morph").IfStatement, sides?: IfSides): void {
    const condValue = this.liftExpr(node.getExpression());
    // A return on some paths: the return state must exist before the branch, so the join carries it.
    if (sides === undefined && containsDirectReturn(node)) this.ensureReturnState();
    const before = new Map(this.env);
    // Record the branch, and lift each side inside its own region, so the structure is kept.
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: condValue, ...(within !== undefined ? { within } : {}) });

    const total = sides !== undefined;
    const elseNode = node.getElseStatement();
    const thenStmts: readonly Node[] = sides?.then ?? [node.getThenStatement()];
    const elseStmts: readonly Node[] = sides?.else ?? (elseNode !== undefined ? [elseNode] : []);
    const thenReturns: ValueId[] = [];
    const thenEnv = this.inRegion(`${id}.t`, () =>
      this.inReturnFrame(total ? thenReturns : undefined, () =>
        this.branch(before, () => this.liftStatements(thenStmts)),
      ),
    );
    const elseReturns: ValueId[] = [];
    const elseEnv =
      elseStmts.length > 0
        ? this.inRegion(`${id}.e`, () =>
            this.inReturnFrame(total ? elseReturns : undefined, () =>
              this.branch(before, () => this.liftStatements(elseStmts)),
            ),
          )
        : before;

    if (total) {
      // Every path through the if returns: one observation, the return of the path taken.
      const [thenValue] = thenReturns;
      const [elseValue] = elseReturns;
      if (thenValue === undefined || elseValue === undefined) {
        throw new Error("internal: a total if has a side without a return");
      }
      const [returned] = this.emit("sel", [condValue, thenValue, elseValue], 1, {
        origin: { kind: "IfReturn" },
      });
      this.reportReturn(returned as ValueId);
      return;
    }

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

  /**
   * A return's value. Inside a total side it is collected by that side's frame; otherwise (no
   * frame, or a frame of a branch that does not always return) it is a flat observation, as before.
   */
  private reportReturn(value: ValueId): void {
    const frame = this.returnFrames[this.returnFrames.length - 1];
    if (frame !== undefined) frame.push(value);
    else if (this.env.has(RETURN_DONE)) this.recordPartialReturn(value);
    else this.obs.push(value);
  }

  /**
   * Return state: `RETURN_DONE` says whether a return has happened on the path, and `RETURN_VALUE` is
   * the value of the first one. A later return keeps the value when the function has already returned,
   * so the join of the branches carries the result, and the rest of the list needs no guard: the graph
   * is data flow, and nothing after a return can change the result.
   */
  private recordPartialReturn(value: ValueId): void {
    const done = this.env.get(RETURN_DONE) as ValueId;
    const current = this.env.get(RETURN_VALUE) as ValueId;
    const [kept] = this.emit("sel", [done, current, value], 1, { origin: { kind: "ReturnSelect" } });
    const [flag] = this.emit("literal-source", [], 1, {
      origin: { kind: "TrueKeyword", text: "true" },
      label: "true",
    });
    this.env.set(RETURN_VALUE, kept as ValueId);
    this.env.set(RETURN_DONE, flag as ValueId);
  }

  /** Starts the return state, as "not returned" with an undefined value, if it is not yet started. */
  private ensureReturnState(): void {
    if (this.env.has(RETURN_DONE)) return;
    const [flag] = this.emit("literal-source", [], 1, {
      origin: { kind: "FalseKeyword", text: "false" },
      label: "false",
    });
    this.env.set(RETURN_DONE, flag as ValueId);
    this.env.set(RETURN_VALUE, this.undefinedValue());
  }

  private undefinedValue(): ValueId {
    const [value] = this.emit("literal-source", [], 1, {
      origin: { kind: "Uninitialized" },
      label: "undefined",
    });
    return value as ValueId;
  }

  /** Run `body` with a return frame pushed: `frame` collects the side's returns, or undefined for flat. */
  private inReturnFrame<T>(frame: ValueId[] | undefined, body: () => T): T {
    this.returnFrames.push(frame);
    try {
      return body();
    } finally {
      this.returnFrames.pop();
    }
  }

  /**
   * Lifts a `while` or a classic `for` loop as a `loop` node with a body region (#1275). The carried
   * variables are the names the loop assigns; each starts from its value before the loop, and the
   * loop's results are their values when it stops. The outer values the body reads are its
   * invariants. Returns false for a loop it does not express (a jump, a return, or another kind of
   * loop), and the caller keeps the opaque summary.
   */
  private liftLoop(node: import("ts-morph").WhileStatement | import("ts-morph").ForStatement): boolean {
    if (hasJump(node)) return false;
    const isFor = Node.isForStatement(node);
    const cond = Node.isForStatement(node) ? node.getCondition() : node.getExpression();
    const incrementor = Node.isForStatement(node) ? node.getIncrementor() : undefined;
    const body = node.getStatement();

    // A `for` initializer runs once, before the loop.
    if (Node.isForStatement(node)) {
      const init = node.getInitializer();
      if (init !== undefined && Node.isVariableDeclarationList(init)) this.liftDeclarations(init.getDeclarations());
      else if (init !== undefined) this.liftExpr(init);
    }

    const assigned: string[] = [];
    for (const part of [cond, body, incrementor]) {
      if (part === undefined) continue;
      for (const name of this.collectAssignedOuterNames(part)) {
        if (!assigned.includes(name)) assigned.push(name);
      }
    }
    const carried = assigned.filter((name) => this.env.has(name));
    const inits = carried.map((name) => this.env.get(name) as ValueId);

    // The body runs on a copy of the environment, and the original object is restored after it: an
    // enclosing branch holds that object, so it must see the loop's results.
    const saved = this.env;
    this.env = new Map(saved);
    const frame: LoopFrame = {
      id: `L${this.loopCount++}`,
      start: this.valueCounter,
      depth: 0,
      invariants: [],
      invariantSources: [],
      byOuter: new Map(),
    };
    const carrySources: ValueId[] = [];
    const nexts: ValueId[] = [];
    let condition: ValueId | undefined;
    this.loopFrames.push(frame);
    try {
      this.inRegion(`${frame.id}.b`, () => {
        frame.depth = this.regionStack.length;
        carried.forEach((name, i) => {
          const [value] = this.emit("carry-source", [], 1, {
            label: `carry:${i}`,
            origin: { kind: "LoopCarry", text: truncate(name) },
          });
          carrySources.push(value as ValueId);
          this.env.set(name, value as ValueId);
        });
        condition =
          cond !== undefined
            ? this.liftExpr(cond)
            : (this.emit("literal-source", [], 1, { origin: { kind: "TrueKeyword", text: "true" }, label: "true" })[0] as ValueId);
        this.liftStatement(body);
        if (incrementor !== undefined) this.liftExpr(incrementor);
        for (const name of carried) nexts.push(this.env.get(name) as ValueId);
      });
    } finally {
      this.loopFrames.pop();
      this.env = saved;
    }

    const results = this.emit("loop", [...inits, ...frame.invariants], carried.length, {
      origin: { kind: isFor ? "ForStatement" : "WhileStatement", text: truncate(node.getText()) },
    });
    const loopNode = this.nodes[this.nodes.length - 1] as MutableNode;
    loopNode.loop = {
      id: frame.id,
      carry: carrySources,
      invariant: frame.invariantSources,
      next: nexts,
      cond: condition as ValueId,
    };
    carried.forEach((name, i) => {
      const out = results[i];
      if (out !== undefined) this.env.set(name, out);
    });
    return true;
  }

  /**
   * Lifts a `for...of` (values) or `for...in` (keys) loop as a loop node that iterates (#1275, 3A).
   * The iterable is lifted before the loop and is the loop's input after the carries' initial values;
   * the declared loop variable is the body's element source. Iterating is a platform primitive, so
   * this holds for any iterable. Returns false for a form it does not express (`for await`, a jump,
   * a loop variable that is not a single declaration).
   */
  private liftIterate(node: import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement): boolean {
    if (hasJump(node)) return false;
    if (Node.isForOfStatement(node) && node.isAwaited()) return false;
    const init = node.getInitializer();
    if (!Node.isVariableDeclarationList(init) || init.getDeclarations().length !== 1) return false;
    const decl = init.getDeclarations()[0] as import("ts-morph").VariableDeclaration;
    const declared = patternNames(decl.getNameNode());
    const of: "values" | "keys" = Node.isForOfStatement(node) ? "values" : "keys";
    const body = node.getStatement();

    const iterable = this.liftExpr(node.getExpression());
    const carried = this.collectAssignedOuterNames(body).filter(
      (name) => this.env.has(name) && !declared.includes(name),
    );
    const inits = carried.map((name) => this.env.get(name) as ValueId);

    const saved = this.env;
    this.env = new Map(saved);
    const frame: LoopFrame = {
      id: `L${this.loopCount++}`,
      start: this.valueCounter,
      depth: 0,
      invariants: [],
      invariantSources: [],
      byOuter: new Map(),
    };
    const carrySources: ValueId[] = [];
    const nexts: ValueId[] = [];
    let element: ValueId | undefined;
    this.loopFrames.push(frame);
    try {
      this.inRegion(`${frame.id}.b`, () => {
        frame.depth = this.regionStack.length;
        carried.forEach((name, i) => {
          const [value] = this.emit("carry-source", [], 1, {
            label: `carry:${i}`,
            origin: { kind: "LoopCarry", text: truncate(name) },
          });
          carrySources.push(value as ValueId);
          this.env.set(name, value as ValueId);
        });
        [element] = this.emit("carry-source", [], 1, {
          label: "element",
          origin: { kind: "LoopElement", text: truncate(decl.getNameNode().getText()) },
        }) as [ValueId];
        for (const name of declared) this.env.set(name, element);
        this.liftStatement(body);
        for (const name of carried) nexts.push(this.env.get(name) as ValueId);
      });
    } finally {
      this.loopFrames.pop();
      this.env = saved;
    }

    const results = this.emit("loop", [...inits, iterable, ...frame.invariants], carried.length, {
      origin: { kind: node.getKindName(), text: truncate(node.getText()) },
      label: of === "values" ? "for-of" : "for-in",
    });
    const loopNode = this.nodes[this.nodes.length - 1] as MutableNode;
    loopNode.loop = {
      id: frame.id,
      carry: carrySources,
      invariant: frame.invariantSources,
      next: nexts,
      iterate: { element: element as ValueId, of },
    };
    carried.forEach((name, i) => {
      const out = results[i];
      if (out !== undefined) this.env.set(name, out);
    });
    return true;
  }

  /**
   * The value a loop body sees for `value`. A value made before the loop, or at top level, is outside
   * the body: the body reads it as an invariant, a source inside the body, and the loop takes the
   * outer value as an input. Other values are the body's own, and are returned as they are.
   */
  private throughLoop(value: ValueId, level = this.loopFrames.length - 1): ValueId {
    const frame = this.loopFrames[level];
    if (frame === undefined) return value;
    if (valueIndex(value) >= frame.start && !this.topLevel.has(value)) return value;
    const known = frame.byOuter.get(value);
    if (known !== undefined) return known;
    // The loop takes the value as the enclosing loop's body sees it: an enclosing invariant, when the
    // value is outside that loop too, so every loop's inputs are what its body reads.
    const outerInput = this.throughLoop(value, level - 1);
    // The invariant sits at the body's own level, whatever nested region the read is in.
    const saved = this.regionStack.splice(frame.depth);
    let source: ValueId;
    try {
      [source] = this.emit("carry-source", [], 1, {
        label: `invariant:${frame.invariants.length}`,
        origin: { kind: "LoopInvariant", text: truncate(String(value)) },
      }) as [ValueId];
    } finally {
      this.regionStack.push(...saved);
    }
    frame.invariants.push(outerInput);
    frame.invariantSources.push(source);
    frame.byOuter.set(value, source);
    return source;
  }

  private liftDeclarations(decls: readonly import("ts-morph").VariableDeclaration[]): void {
    for (const decl of decls) {
      const init = decl.getInitializer();
      const value =
        init !== undefined
          ? this.liftExpr(init)
          : this.emit("literal-source", [], 1, { origin: { kind: "Uninitialized" }, label: "Uninitialized" })[0];
      for (const name of patternNames(decl.getNameNode())) this.env.set(name, value as ValueId);
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
      label: this.opaqueLabel(node.getKindName(), node),
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
          ? (this.emit("op", reads, 1, { origin: { kind: "RegionScope" }, label: this.opaqueLabel("RegionScope", node) })[0] as ValueId)
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
    // The node itself counts too: a loop's incrementor is often a bare assignment (`i = i + 1`).
    const bins = [
      ...(Node.isBinaryExpression(node) ? [node] : []),
      ...node.getDescendantsOfKind(SyntaxKind.BinaryExpression),
    ];
    for (const bin of bins) {
      const op = bin.getOperatorToken().getKind();
      if (op === SyntaxKind.EqualsToken || COMPOUND_ASSIGN.has(op)) consider(bin.getLeft());
    }
    const unaries = [
      ...(Node.isPostfixUnaryExpression(node) || Node.isPrefixUnaryExpression(node) ? [node] : []),
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
      // The operator is structure: `-x` and `+x`, `++x` and `x++` are different operations.
      const token = ts.tokenToString(node.getOperatorToken()) ?? node.getKindName();
      const [out] = this.emit("op", [value], 1, {
        origin: { kind: node.getKindName() },
        label: Node.isPrefixUnaryExpression(node) ? token : `post${token}`,
      });
      // ++/-- on a bound identifier reassigns it. No other unary operator does: `-x` leaves x as it is.
      const steps = token === "++" || token === "--";
      if (steps && Node.isIdentifier(operand) && this.env.has(operand.getText())) {
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
      const optional = Node.isCallExpression(node) && node.hasQuestionDotToken();
      return this.emit("op", inputs, 1, {
        origin: { kind: node.getKindName(), text: truncate(node.getText()) },
        ...(optional ? { label: `${node.getKindName()}?.` } : {}),
      })[0] as ValueId;
    }
    if (Node.isPropertyAccessExpression(node)) {
      // The member name is structure: `o.a` and `o.b` are different reads.
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: "PropertyAccess", text: truncate(node.getText()) },
        label: `${node.hasQuestionDotToken() ? "?." : "."}${node.getName()}`,
      })[0] as ValueId;
    }
    if (Node.isElementAccessExpression(node)) {
      const inputs = [
        this.liftExpr(node.getExpression()),
        this.liftExpr(node.getArgumentExpressionOrThrow()),
      ];
      return this.emit("op", inputs, 1, {
        origin: { kind: "ElementAccess" },
        ...(node.hasQuestionDotToken() ? { label: "ElementAccess?." } : {}),
      })[0] as ValueId;
    }
    if (Node.isSpreadElement(node)) {
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: "SpreadElement" },
        label: "...",
      })[0] as ValueId;
    }
    if (Node.isArrayLiteralExpression(node)) {
      const inputs = node.getElements().map((el) => this.liftExpr(el));
      return this.emit("op", inputs, 1, { origin: { kind: "ArrayLiteral" } })[0] as ValueId;
    }
    if (Node.isObjectLiteralExpression(node)) {
      return this.liftObjectLiteral(node);
    }
    if (Node.isTemplateExpression(node)) {
      // The literal parts are structure; the expressions between them are the inputs.
      const parts = [rawTextOf(node.getHead()), ...node.getTemplateSpans().map((span) => rawTextOf(span.getLiteral()))];
      const inputs = node.getTemplateSpans().map((span) => this.liftExpr(span.getExpression()));
      return this.emit("op", inputs, 1, {
        origin: { kind: "Template" },
        label: `template:${labelJson(parts)}`,
      })[0] as ValueId;
    }
    if (Node.isTaggedTemplateExpression(node)) {
      const template = node.getTemplate();
      const inputs = [this.liftExpr(node.getTag())];
      let parts: string[];
      if (Node.isTemplateExpression(template)) {
        parts = [rawTextOf(template.getHead()), ...template.getTemplateSpans().map((span) => rawTextOf(span.getLiteral()))];
        for (const span of template.getTemplateSpans()) inputs.push(this.liftExpr(span.getExpression()));
      } else {
        parts = [rawTextOf(template)];
      }
      return this.emit("op", inputs, 1, {
        origin: { kind: "TaggedTemplate" },
        label: `tagged:${labelJson(parts)}`,
      })[0] as ValueId;
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
        label: this.opaqueLabel("Closure", node),
      })[0] as ValueId;
    }
    // Fallback: opaque node over every value the expression reads (sound).
    return this.emit("op", this.collectReads(node), 1, {
      origin: { kind: node.getKindName(), text: truncate(node.getText()) },
      label: this.opaqueLabel(node.getKindName(), node),
    })[0] as ValueId;
  }

  /**
   * An object literal: one input per entry, in order, and its keys as structure. A static key is a
   * string, a spread is null, a computed key is 1 (its value is the input before the entry's
   * value), and a method or accessor is an object naming its kind and key, with an opaque value.
   */
  private liftObjectLiteral(node: import("ts-morph").ObjectLiteralExpression): ValueId {
    const entries: unknown[] = [];
    const inputs: ValueId[] = [];
    const keyOf = (name: Node): string | 1 => {
      if (Node.isComputedPropertyName(name)) {
        inputs.push(this.liftExpr(name.getExpression()));
        return 1;
      }
      if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) return name.getLiteralValue();
      if (Node.isNumericLiteral(name)) return String(name.getLiteralValue());
      return name.getText();
    };
    for (const prop of node.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        entries.push(keyOf(prop.getNameNode()));
        inputs.push(this.liftExpr(prop.getInitializerOrThrow()));
      } else if (Node.isShorthandPropertyAssignment(prop)) {
        entries.push(prop.getName());
        inputs.push(this.resolveIdentifier(prop.getName()));
      } else if (Node.isSpreadAssignment(prop)) {
        entries.push(null);
        inputs.push(this.liftExpr(prop.getExpression()));
      } else {
        // A method or an accessor: a closure-like value, opaque.
        const nameNode = (prop as import("ts-morph").MethodDeclaration).getNameNode();
        entries.push({ [prop.getKindName()]: keyOf(nameNode) });
        inputs.push(
          this.emit("op", this.collectReads(prop), 1, {
            origin: { kind: "Closure" },
            label: this.opaqueLabel("Closure", prop),
          })[0] as ValueId,
        );
      }
    }
    return this.emit("op", inputs, 1, {
      origin: { kind: "ObjectLiteral" },
      label: `object:${labelJson(entries)}`,
    })[0] as ValueId;
  }

  /**
   * The structural label of an opaque node: its kind and a hash of its text. The names it reads from
   * outside are replaced by their order of first use, so renaming an outer name keeps the label; the
   * rest of the text is the structure, since the node has no other.
   */
  private opaqueLabel(kind: string, node: Node, extraLocals: ReadonlySet<string> = new Set()): string {
    const locals = collectRegionLocals(node);
    for (const name of extraLocals) locals.add(name);
    const start = node.getStart();
    const text = node.getText();
    const order = new Map<string, number>();
    const spans: [number, number, string][] = [];
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (locals.has(name)) continue;
      if (!order.has(name)) order.set(name, order.size);
      spans.push([id.getStart() - start, id.getEnd() - start, `$${order.get(name)}`]);
    }
    let normalized = "";
    let at = 0;
    for (const [from, to, placeholder] of spans.sort((a, b) => a[0] - b[0])) {
      normalized += text.slice(at, from) + placeholder;
      at = to;
    }
    normalized += text.slice(at);
    return `${kind}#${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
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
      const label = Node.isPropertyAccessExpression(lhs) ? `.${lhs.getName()}=` : "[]=";
      const [mutated] = this.emit("op", inputs, 1, { origin: { kind: "Write" }, label });
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
    return this.throughLoop(this.resolveName(name));
  }

  private resolveName(name: string): ValueId {
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
      ...(n.loop !== undefined ? { loop: n.loop } : {}),
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

/** JSON as one token: whitespace inside strings is escaped, so a label is one word of the line form. */
function labelJson(value: unknown): string {
  return JSON.stringify(value).replace(/\s/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The raw text of a template part, exactly as written (escapes kept). */
function rawTextOf(part: Node): string {
  const raw = (part.compilerNode as { rawText?: string }).rawText;
  return raw ?? (part as import("ts-morph").TemplateHead).getLiteralText();
}

/** A loop being lifted (see `liftLoop`). */
interface LoopFrame {
  readonly id: string;
  /** Values numbered below this were made before the loop, so they are outside its body. */
  readonly start: number;
  /** The depth of the body region in the region path. */
  depth: number;
  /** The outer values the body reads, and the body's own source for each, in order. */
  readonly invariants: ValueId[];
  readonly invariantSources: ValueId[];
  readonly byOuter: Map<ValueId, ValueId>;
}

function valueIndex(value: ValueId): number {
  return Number(String(value).slice(1));
}

/** True when the loop body has a break, a continue or a return that belongs to it (not to a nested function). */
function hasJump(node: Node): boolean {
  const jumps = [
    ...node.getDescendantsOfKind(SyntaxKind.BreakStatement),
    ...node.getDescendantsOfKind(SyntaxKind.ContinueStatement),
    ...node.getDescendantsOfKind(SyntaxKind.ReturnStatement),
  ];
  return jumps.some((jump) => !isInsideNestedFunction(jump, node));
}

/** Names of the return state (not valid source names, so they never clash with a binding). */
const RETURN_DONE = "%returned";
const RETURN_VALUE = "%returnValue";

/** The statements of an `if`'s two sides, once the rest of its statement list is placed on a side. */
interface IfSides {
  readonly then: readonly Node[];
  readonly else: readonly Node[];
}

/** True when every path through the node reaches a return with a value. Loops and switches are not followed. */
function alwaysReturns(node: Node): boolean {
  if (Node.isReturnStatement(node)) return node.getExpression() !== undefined;
  if (Node.isBlock(node)) return node.getStatements().some(alwaysReturns);
  if (Node.isIfStatement(node)) {
    const elseNode = node.getElseStatement();
    return elseNode !== undefined && alwaysReturns(node.getThenStatement()) && alwaysReturns(elseNode);
  }
  return false;
}

/**
 * The sides of an `if` that takes the rest of its statement list (`tail`) onto the side that does not
 * always return. Undefined when no side returns on its own, or when a total `if` would need the tail
 * to be dead, or when the tail declares functions (their hoisting is bound by the list).
 */
function totalSides(node: import("ts-morph").IfStatement, tail: readonly Node[]): IfSides | undefined {
  if (tail.some((t) => Node.isFunctionDeclaration(t))) return undefined;
  const thenNode = node.getThenStatement();
  const elseNode = node.getElseStatement();
  const thenReturns = alwaysReturns(thenNode);
  const elseReturns = elseNode !== undefined && alwaysReturns(elseNode);
  let sides: IfSides | undefined;
  if (thenReturns && elseReturns) {
    if (tail.length === 0) sides = { then: [thenNode], else: [elseNode as Node] };
  } else if (thenReturns) {
    const side = [...(elseNode !== undefined ? [elseNode] : []), ...tail];
    if (side.some(alwaysReturns)) sides = { then: [thenNode], else: side };
  } else if (elseReturns) {
    const side = [thenNode, ...tail];
    if (side.some(alwaysReturns)) sides = { then: side, else: [elseNode as Node] };
  }
  if (sides === undefined) return undefined;
  // A side with a return on some paths only would leave its value to the return state, which the frame does not see.
  return totalCover(sides.then) && totalCover(sides.else) ? sides : undefined;
}

/**
 * True when every direct return in the list is inside a total `if` (or a block holding one): the
 * returns then all reach a frame. A return on some paths, or inside a loop or a switch, is not covered.
 */
function totalCover(stmts: readonly Node[]): boolean {
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i] as Node;
    if (!containsDirectReturn(stmt)) continue;
    if (Node.isBlock(stmt)) {
      if (!totalCover(stmt.getStatements())) return false;
      continue;
    }
    if (Node.isIfStatement(stmt)) return totalSides(stmt, stmts.slice(i + 1)) !== undefined;
    return false;
  }
  return true;
}

/** True when the node has a return that is not inside a nested function, loop, switch or try. */
function containsDirectReturn(node: Node): boolean {
  return node
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .some((ret) => !insideOpaque(ret, node));
}

function insideOpaque(ret: Node, root: Node): boolean {
  for (let p = ret.getParent(); p !== undefined && p.compilerNode !== root.compilerNode; p = p.getParent()) {
    if (
      Node.isFunctionDeclaration(p) ||
      Node.isFunctionExpression(p) ||
      Node.isArrowFunction(p) ||
      Node.isForStatement(p) ||
      Node.isForOfStatement(p) ||
      Node.isForInStatement(p) ||
      Node.isWhileStatement(p) ||
      Node.isDoStatement(p) ||
      Node.isSwitchStatement(p) ||
      Node.isTryStatement(p)
    ) {
      return true;
    }
  }
  return false;
}
