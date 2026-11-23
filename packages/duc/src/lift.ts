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
import { KNOWN_PRIMITIVES } from "./base-set.js";
import { canonicalizeGraph } from "./canonical.js";
import { normalizeLiteral } from "./literal.js";
import { RUNTIME_MODULE } from "./runtime.js";
import type {
  DiamondReason,
  DucBranch,
  DucGraph,
  DucLoop,
  DucNode,
  NodeId,
  ValueId,
} from "./types.js";

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

// The platform primitives are the per-target base sets in base-set.ts (D5, #1282).

interface ImportBinding {
  readonly reason: DiamondReason;
  readonly module: string;
}

interface MutableNode {
  readonly id: NodeId;
  inputs: ValueId[];
  order?: 1;
  readonly outputs: ValueId[];
  loop?: DucLoop;
  closure?: DucGraph;
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

  // Names a target provides are platform primitives (D5); which target is checked by the closure check.
  const ambient = new Set(options.ambientGlobals ?? KNOWN_PRIMITIVES);
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
  /**
   * The lifted loop whose body is being lifted, when it has jumps: a break sets `brk`, a return sets
   * `ret` and `retv`, and each ends its path, as a continue does (#1276).
   */
  private bodyExits:
    | { readonly node: Node; readonly brk?: string; readonly ret?: string; readonly retv?: string }
    | undefined;
  /** A function body exits by return or throw, and ends with `return undefined`; a file does not. */
  private exitMode: "function" | "file" = "file";
  /** Import bindings, name -> classification. */
  private readonly imports = new Map<string, ImportBinding>();
  /** Memoized diamond-sources, keyed by symbol so one unknown = one source. */
  private readonly diamonds = new Map<string, ValueId>();
  private readonly obs: ValueId[] = [];

  /**
   * Names held in a cell (#1276): a closure rebinds them, so the closure and its scope share one
   * binding. The name's value is a cell `{ value }`; a read is `.value`, a write `.value =`.
   */
  private readonly cells = new Set<string>();

  /** The heap token at the start: an operation after it alone needs no ordering edge. */
  private readonly heapStart: ValueId;

  constructor(private readonly ambient: ReadonlySet<string>) {
    this.heapStart = this.undefinedValue();
    this.env.set(HEAP, this.heapStart);
  }

  // --- id minting ---
  private freshValue(): ValueId {
    return `v${this.valueCounter++}` as ValueId;
  }
  private freshNodeId(): NodeId {
    return `n${this.nodeCounter++}` as NodeId;
  }

  private emit(
    kind: DucNode["kind"],
    given: ValueId[],
    count: number,
    extra?: {
      diamond?: DucNode["diamond"];
      origin?: DucNode["origin"];
      label?: string;
      /** A heap operation whatever its label (an object literal with a spread entry). */
      heap?: boolean;
    },
  ): ValueId[] {
    // A heap operation is ordered after the one before it on the path (#1285), and is the token after.
    const label = extra?.label ?? (kind === "op" ? extra?.origin?.kind : undefined);
    const heap =
      extra?.heap === true ||
      ((kind === "op" || (kind === "loop" && label?.includes("#") === true)) &&
        label !== undefined &&
        (isHeapLabel(label) || label === "throw"));
    let inputs = given;
    let outCount = count;
    let ordered = false;
    if (heap) {
      const token = this.env.get(HEAP);
      if (token !== undefined && token !== this.heapStart) {
        inputs = [...given, this.loopFrames.length > 0 ? this.throughLoop(token) : token];
        ordered = true;
      }
      // Every heap operation is a token, a throw too: what follows a branch that may throw waits for it.
      if (outCount === 0) outCount = 1;
    }
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
          : kind === "sel" && extra?.origin?.text === HEAP
            ? { label: "heap" }
            : {}),
      ...(ordered ? { order: 1 as const } : {}),
    };
    this.nodes.push(node);
    if (heap && outputs[0] !== undefined) this.env.set(HEAP, outputs[0]);
    return outputs;
  }

  // --- imports ---
  collectImports(file: Node): void {
    for (const child of file.getChildrenOfKind(SyntaxKind.ImportDeclaration)) {
      const decl = child.asKindOrThrow(SyntaxKind.ImportDeclaration);
      const moduleSpec = decl.getModuleSpecifierValue();
      if (decl.isTypeOnly()) continue; // type-only imports carry no runtime value
      // The DUC runtime's names are platform primitives, as the lifter writes them (#1276).
      if (moduleSpec === RUNTIME_MODULE) continue;
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
      for (const name of cellNames(file)) this.cells.add(name);
      this.liftStatements(file.getChildSyntaxListOrThrow().getChildren());
      for (const name of exportedBindingNames(file)) {
        if (this.env.has(name)) this.obs.push(this.resolveIdentifier(name));
      }
    }
  }

  private liftFunction(fn: FunctionLike, paramOffset = 0): void {
    for (const name of cellNames(fn)) this.cells.add(name);
    for (const [index, param] of fn.getParameters().entries()) {
      const nameNode = param.getNameNode();
      const [value] = this.emit("param-source", [], 1, {
        origin: { kind: "Parameter", text: truncate(nameNode.getText()) },
        label: String(paramOffset + index),
      });
      // A default applies when the argument is undefined; a pattern reads each member (#1276).
      const init = param.getInitializer();
      this.bindPattern(
        nameNode,
        init !== undefined ? this.withDefault(value as ValueId, init) : (value as ValueId),
      );
    }
    const body = fn.getBody();
    if (body === undefined) return;
    if (Node.isBlock(body)) {
      this.exitMode = "function";
      const exited = this.liftStatements(body.getStatements(), []);
      // Returns on some paths: the observation is the value of the return state at the end. With
      // no return state, a body that falls off its end returns undefined.
      if (this.env.has(RETURN_DONE)) this.obs.push(this.env.get(RETURN_VALUE) as ValueId);
      else if (!exited) this.obs.push(this.undefinedValue());
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
  /**
   * `cont` is what runs after the list, up to the end of the function, when that is known. An `if`
   * that exits on some paths takes the rest of the list and `cont` onto both of its sides, so every
   * path ends in an exit and the exits join in one total `if` (#1276). Returns true when every path
   * through the list exits, so the continuation has been lifted.
   */
  private liftStatements(stmts: readonly Node[], cont?: readonly Node[]): boolean {
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
    for (const [i, written] of stmts.entries()) {
      // A switch whose clauses each end in an exit is the if chain it means (#1276).
      const stmt = Node.isSwitchStatement(written)
        ? (this.lowerSwitch(written) ?? written)
        : Node.isTryStatement(written)
          ? (this.lowerTry(written) ?? written)
          : written;
      const rest = stmts.slice(i + 1);
      const full = cont === undefined ? undefined : [...rest, ...cont];
      if (this.bodyExits !== undefined) {
        if (
          Node.isIfStatement(stmt) &&
          full !== undefined &&
          containsLoopJump(stmt, this.bodyExits.node)
        ) {
          const elseNode = stmt.getElseStatement();
          this.liftIf(
            stmt,
            {
              whenTrue: [stmt.getThenStatement(), ...full],
              whenFalse: [...(elseNode !== undefined ? [elseNode] : []), ...full],
            },
            "join",
          );
          return true;
        }
        const blockCont = Node.isBlock(stmt) && full !== undefined ? full : undefined;
        if (this.liftStatement(stmt, blockCont)) return true;
        continue;
      }
      // A loop that returns: after it, the function returns its value when it returned, and runs the
      // rest otherwise, as the two sides of a total if.
      if (
        full !== undefined &&
        this.exitMode === "function" &&
        isLoopStatement(stmt) &&
        loopReturns(stmt)
      ) {
        const flags = this.liftLoopWithExits(stmt);
        if (flags !== undefined) {
          this.exitAfterLoop(flags.ret, flags.retv, full);
          return true;
        }
      }
      if (Node.isIfStatement(stmt) && full !== undefined && this.canTakeTail(stmt, full)) {
        const elseNode = stmt.getElseStatement();
        this.liftIf(stmt, {
          whenTrue: [stmt.getThenStatement(), ...full],
          whenFalse: [...(elseNode !== undefined ? [elseNode] : []), ...full],
        });
        return true;
      }
      const blockCont =
        Node.isBlock(stmt) && full !== undefined && this.blockMayTake(stmt, full)
          ? full
          : undefined;
      if (this.liftStatement(stmt, blockCont)) return true;
      // An exit on some paths that no if could take the rest for: the rest runs only on the paths
      // that have not exited, under the return state (the fallback).
      if (containsDirectExit(stmt) && rest.length > 0 && this.env.has(RETURN_DONE)) {
        this.guardTail(rest);
        return false;
      }
    }
    return false;
  }

  private switchCount = 0;

  /**
   * A switch as a block that evaluates the discriminant once and tests the cases in order with
   * `===`: `{ const $s = d; if ($s === a || $s === b) { ... } else if (...) ... else { default } }`.
   * Undefined when the switch is not that: a clause that falls into the next, a break that is not
   * the clause's last statement, or a case expression that does more than produce a value.
   */
  private lowerSwitch(sw: import("ts-morph").SwitchStatement): Node | undefined {
    const tmp = `$switch${this.switchCount++}`;
    const arms = switchArms(sw);
    if (arms === undefined) return undefined;
    const test = (exprs: readonly string[]): string =>
      exprs.map((e) => `${tmp} === (${e})`).join(" || ");
    const fallback = arms.find((arm) => arm.isDefault);
    const chained = arms.filter((arm) => !arm.isDefault || arm.tests.length > 0);
    let text = fallback !== undefined ? `{\n${fallback.body}\n}` : "";
    for (const arm of [...chained].reverse()) {
      // An arm that is also the default runs when nothing else matches, so it is the else too.
      text = `if (${arm.tests.length > 0 ? test(arm.tests) : "false"}) {\n${arm.body}\n}${text !== "" ? ` else ${text}` : ""}`;
    }
    const source = `function __switch() {\n{\nconst ${tmp} = (${sw.getExpression().getText()});\n${text}\n}\n}`;
    const file = sw
      .getSourceFile()
      .getProject()
      .createSourceFile(`__switch${this.switchCount}.ts`, source, { overwrite: true });
    return file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
  }

  private tryCount = 0;

  /**
   * A try statement as the call it means (#1276): `__yakccTry(() => { body }, (e) => { handler })`, a
   * platform primitive that runs the body and, when it throws, the handler on what it threw. A return
   * inside returns `[1, value]` from its closure, and the call is followed by
   * `if ($t[0] === 1) return $t[1]`; the closures end with `return [0]`. Outer names the blocks assign
   * are cells (see cellNames), so the closures share them. Undefined when it is not that: a finally,
   * a var (it belongs to the function, not the block), a yield or an await, or a break or continue that
   * leaves the statement.
   */
  private lowerTry(t: import("ts-morph").TryStatement): Node | undefined {
    const handler = t.getCatchClause();
    if (handler === undefined || t.getFinallyBlock() !== undefined) return undefined;
    const parts = [t.getTryBlock(), handler.getBlock()];
    for (const part of parts) {
      const own = (n: Node): boolean => !isInsideNestedFunction(n, part);
      if (
        part
          .getDescendantsOfKind(SyntaxKind.VariableDeclarationList)
          .some((l) => own(l) && l.getDeclarationKind() === "var")
      )
        return undefined;
      if (
        [
          ...part.getDescendantsOfKind(SyntaxKind.YieldExpression),
          ...part.getDescendantsOfKind(SyntaxKind.AwaitExpression),
        ].some(own)
      )
        return undefined;
      const inside = (target: Node | undefined): boolean =>
        target !== undefined &&
        target.getAncestors().some((a) => a.compilerNode === part.compilerNode);
      for (const j of [
        ...part.getDescendantsOfKind(SyntaxKind.BreakStatement),
        ...part.getDescendantsOfKind(SyntaxKind.ContinueStatement),
      ]) {
        if (!own(j)) continue;
        if (j.getLabel() !== undefined) return undefined;
        const target = Node.isBreakStatement(j)
          ? breakTarget(j)
          : j.getAncestors().find((a) => isLoopStatement(a));
        if (!inside(target)) return undefined;
      }
    }
    const returns = parts.flatMap((part) =>
      part
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((r) => !isInsideNestedFunction(r, part)),
    );
    const completes = returns.length > 0;
    const full = t.getSourceFile().getFullText();
    const rewrite = (block: import("ts-morph").Block): string => {
      const start = block.getStart() + 1;
      const end = block.getEnd() - 1;
      let text = full.slice(start, end);
      const own = returns
        .filter((r) => r.getStart() >= start && r.getEnd() <= end)
        .sort((a, b) => b.getStart() - a.getStart());
      for (const r of own) {
        const expr = r.getExpression();
        const value = expr === undefined ? "undefined" : `(${expr.getText()})`;
        text = `${text.slice(0, r.getStart() - start)}return [1, ${value}];${text.slice(r.getEnd() - start)}`;
      }
      return completes ? `${text}\nreturn [0];` : text;
    };
    const n = this.tryCount++;
    const tmp = `$try${n}`;
    const param = handler.getVariableDeclaration()?.getText() ?? "";
    const call = `${TRY_PRIMITIVE}(() => {\n${rewrite(parts[0] as import("ts-morph").Block)}\n}, (${param}) => {\n${rewrite(parts[1] as import("ts-morph").Block)}\n})`;
    const source = completes
      ? `function __try() {\n{\nconst ${tmp} = ${call};\nif (${tmp}[0] === 1) return ${tmp}[1];\n}\n}`
      : `function __try() {\n${call};\n}`;
    const file = t
      .getSourceFile()
      .getProject()
      .createSourceFile(`__try${n}_${t.getStart()}.ts`, source, { overwrite: true });
    return file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
  }

  /** Whether an `if` that exits on some paths can take `tail` onto its sides. */
  private canTakeTail(stmt: import("ts-morph").IfStatement, tail: readonly Node[]): boolean {
    if (this.exitMode !== "function" || !containsDirectExit(stmt)) return false;
    // The tail's function declarations are hoisted by its own list.
    if (tail.some((t) => Node.isFunctionDeclaration(t))) return false;
    // A tail that both sides continue into is lifted twice: bound its size outside a total side.
    const elseNode = stmt.getElseStatement();
    const both =
      !alwaysReturns(stmt.getThenStatement()) &&
      !(elseNode !== undefined && alwaysReturns(elseNode));
    const size = tail.reduce((n, t) => n + t.getText().length, 0);
    return !(both && this.returnFrames.length === 0 && size > 4000);
  }

  /** Whether a block's statements can run with `tail` after them in the block's scope. */
  private blockMayTake(block: import("ts-morph").Block, tail: readonly Node[]): boolean {
    if (!containsDirectExit(block)) return false;
    const lexical = new Set<string>();
    for (const st of block.getStatements()) {
      if (Node.isVariableStatement(st))
        for (const d of st.getDeclarations())
          for (const n of patternNames(d.getNameNode())) lexical.add(n);
      if (
        (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) &&
        st.getName() !== undefined
      )
        lexical.add(st.getName() as string);
    }
    return !tail.some((t) => this.readNamesOf(t).some((n) => lexical.has(n)));
  }

  /**
   * The rest of a statement list after an exit on some paths, as the else-side of a branch on the
   * exited flag: its effects happen, and its names change, only on the paths that have not exited.
   */
  private guardTail(rest: readonly Node[]): void {
    const flag = this.env.get(RETURN_DONE) as ValueId;
    const before = new Map(this.env);
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: flag, ...(within !== undefined ? { within } : {}) });
    const elseEnv = this.inRegion(`${id}.e`, () =>
      this.inReturnFrame(undefined, () => this.branch(before, () => this.liftStatements(rest))),
    );
    for (const [name, beforeValue] of before) {
      const elseValue = elseEnv.get(name) ?? beforeValue;
      if (elseValue !== beforeValue) {
        const [joined] = this.emit("sel", [flag, beforeValue, elseValue], 1, {
          origin: { kind: "ExitGuard", text: name },
        });
        this.env.set(name, joined as ValueId);
      }
    }
  }

  /** Binds a function declaration to a closure value over the names it reads. */
  private bindFunctionDeclaration(
    stmt: import("ts-morph").FunctionDeclaration,
    name: string,
  ): void {
    // A function's own name inside its body is recursion, not an external read: the
    // recursive result is a value of the closure itself, not a new input to it.
    const value =
      this.liftClosure(stmt, name) ??
      (this.emit("op", this.collectReads(stmt, new Set([name])), 1, {
        origin: { kind: "Closure", text: truncate(name) },
        label: this.opaqueLabel("Closure", stmt, new Set([name])),
      })[0] as ValueId);
    this.env.set(name, value);
  }

  /**
   * Lifts a closure as its own graph (#1275, closures), by lambda lifting: the names it reads from
   * outside are its captures, and become its first parameters; the closure node takes their values
   * as inputs. Returns undefined for a closure this does not express, which stays opaque: one that
   * assigns to a name outside it, whose captured names are assigned elsewhere (a closure sees the
   * latest value), that uses this, super or arguments, that is recursive, async or a generator.
   */
  /**
   * The receiver: inside an arrow it is the enclosing function's, a capture; otherwise the function's
   * own, an operation of the graph with no inputs.
   */
  private thisValue(): ValueId {
    if (this.env.has(THIS)) return this.resolveIdentifier(THIS);
    const [value] = this.emit("op", [], 1, {
      origin: { kind: "ThisKeyword", text: "this" },
      label: "this",
    });
    this.env.set(THIS, value as ValueId);
    return value as ValueId;
  }

  private liftClosure(fn: FunctionLike, selfName?: string): ValueId | undefined {
    if (fn.isAsync() || (!Node.isArrowFunction(fn) && fn.isGenerator())) return undefined;
    if (fn.getDescendantsOfKind(SyntaxKind.SuperKeyword).length > 0) return undefined;
    // `this` in an arrow is the enclosing receiver, captured like a name; in a function it is the
    // caller's receiver, so the closure is a `function` (#1276).
    const thisUses = fn
      .getDescendantsOfKind(SyntaxKind.ThisKeyword)
      .filter(
        (t) =>
          receiverOwner(t) === fn ||
          (Node.isArrowFunction(fn) && receiverOwner(t) === receiverOwner(fn)),
      );
    const lexicalThis = Node.isArrowFunction(fn) && thisUses.length > 0;
    const dynamicThis = !Node.isArrowFunction(fn) && thisUses.length > 0;
    const locals = closureLocals(fn);
    const reads = fn.getDescendantsOfKind(SyntaxKind.Identifier);
    if (reads.some((id) => id.getText() === "arguments" && !locals.has("arguments")))
      return undefined;
    // A closure that rebinds a name outside itself needs a shared cell, which the graph does not
    // have. A write to a member of an outer object or of the receiver keeps the binding: it changes
    // the shared object, as a call that changes its argument does.
    // A name in a cell is shared: the closure writes the cell it captures.
    const rebindsOutside = (t: Node): boolean => {
      if (Node.isPropertyAccessExpression(t) || Node.isElementAccessExpression(t)) return false;
      const outer = (name: string): boolean => !locals.has(name) && !this.cells.has(name);
      if (Node.isIdentifier(t)) return outer(t.getText());
      return t.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => outer(id.getText()));
    };
    if (assignmentTargets(fn).some(rebindsOutside)) return undefined;
    const outerReads: string[] = [];
    for (const id of reads) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (!locals.has(name) && !outerReads.includes(name)) outerReads.push(name);
    }
    if (selfName !== undefined && outerReads.includes(selfName)) return undefined;
    // A platform primitive the scope does not bind is a source of its own in the closure's graph, so
    // a lowering knows it there (`new RangeError`, `JSON.parse`). Every other name is captured: a free
    // name or an import stays one source of the atom, at its top level, where it is linked.
    const platform = (name: string): boolean =>
      !this.env.has(name) &&
      !this.imports.has(name) &&
      (this.ambient.has(name) || name === TRY_PRIMITIVE);
    const captures = outerReads.filter((name) => !platform(name));
    if (lexicalThis) captures.push(THIS);
    // A captured name reassigned outside the closure could change after it is made. A write to a
    // member keeps the same object, so the closure still holds it. A reassignment that is certainly
    // done before the closure is made (earlier, in the same function, not in another closure, with
    // the closure in no loop and not hoisted) is the value the closure captures.
    const outside = assignmentTargets(fn.getSourceFile()).filter(
      (t) => !t.getAncestors().some((a) => a.compilerNode === fn.compilerNode),
    );
    const scopeOf = (n: Node): Node | undefined =>
      n.getAncestors().find((a) => isFunctionLikeNode(a));
    const inLoop = (n: Node, scope: Node | undefined): boolean => {
      for (const a of n.getAncestors()) {
        if (scope !== undefined && a.compilerNode === scope.compilerNode) return false;
        if (
          Node.isForStatement(a) ||
          Node.isForOfStatement(a) ||
          Node.isForInStatement(a) ||
          Node.isWhileStatement(a) ||
          Node.isDoStatement(a)
        )
          return true;
      }
      return false;
    };
    const fnScope = scopeOf(fn);
    const changesCapture = (t: Node): boolean => {
      // A destructuring assignment rebinds every name in it.
      if (Node.isArrayLiteralExpression(t) || Node.isObjectLiteralExpression(t)) {
        return t
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some((id) => captures.includes(id.getText()));
      }
      const base = baseIdentifierOfTarget(t);
      if (base === undefined || !captures.includes(base)) return false;
      if (!Node.isIdentifier(t)) return false;
      // The closure holds the cell, which every write changes.
      if (this.cells.has(base)) return false;
      const doneBefore =
        !Node.isFunctionDeclaration(fn) &&
        t.getEnd() <= fn.getStart() &&
        scopeOf(t)?.compilerNode === fnScope?.compilerNode &&
        !inLoop(fn, fnScope);
      return !doneBefore;
    };
    if (outside.some(changesCapture)) return undefined;

    let graph: DucGraph;
    try {
      const inner = new Lifter(this.ambient);
      for (const [name, binding] of this.imports) inner.imports.set(name, binding);
      graph = inner.liftClosureBody(
        fn,
        captures,
        captures.filter((name) => this.cells.has(name)),
      );
    } catch {
      return undefined;
    }
    const inputs = captures.map((name) =>
      name === THIS
        ? this.thisValue()
        : this.cells.has(name) && this.env.has(name)
          ? this.throughLoop(this.env.get(name) as ValueId)
          : this.resolveIdentifier(name),
    );
    const [value] = this.emit("op", inputs, 1, {
      origin: { kind: "Closure", text: truncate(selfName ?? fn.getText()) },
      label: dynamicThis ? "function" : "closure",
    });
    (this.nodes[this.nodes.length - 1] as MutableNode).closure = graph;
    return value as ValueId;
  }

  /** The graph of a closure's body: its captures are its first parameters, then its own. */
  liftClosureBody(
    fn: FunctionLike,
    captures: readonly string[],
    cellCaptures: readonly string[] = [],
  ): DucGraph {
    // A captured cell is the same cell inside: reads and writes go through it.
    for (const name of cellCaptures) this.cells.add(name);
    captures.forEach((name, i) => {
      const [value] = this.emit("param-source", [], 1, {
        origin: { kind: "Capture", text: truncate(name) },
        label: String(i),
      });
      this.env.set(name, value as ValueId);
    });
    this.liftFunction(fn, captures.length);
    return this.finish();
  }

  /** Names a subtree reads from an enclosing scope (identifiers not bound inside it). */
  private readNamesOf(node: Node): string[] {
    // Syntactic, and asked again for each tail an exit takes: memoized per node.
    const cached = readNamesCache.get(node.compilerNode);
    if (cached !== undefined) return cached;
    const names = this.readNamesOfUncached(node);
    readNamesCache.set(node.compilerNode, names);
    return names;
  }

  private readNamesOfUncached(node: Node): string[] {
    const locals = collectRegionLocals(node);
    const names = new Set<string>();
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (!locals.has(name)) names.add(name);
    }
    return [...names];
  }

  /** Lifts one statement; true when every path through it exits. */
  private liftStatement(node: Node, cont?: readonly Node[]): boolean {
    const exits = this.bodyExits;
    if (
      exits !== undefined &&
      (Node.isBreakStatement(node) ||
        Node.isContinueStatement(node) ||
        Node.isReturnStatement(node))
    ) {
      const yes = (): ValueId =>
        this.emit("literal-source", [], 1, {
          origin: { kind: "TrueKeyword", text: "true" },
          label: "true",
        })[0] as ValueId;
      if (Node.isBreakStatement(node) && exits.brk !== undefined) this.env.set(exits.brk, yes());
      if (Node.isReturnStatement(node) && exits.ret !== undefined && exits.retv !== undefined) {
        const expr = node.getExpression();
        this.env.set(exits.retv, expr !== undefined ? this.liftExpr(expr) : this.undefinedValue());
        this.env.set(exits.ret, yes());
      }
      return true;
    }
    if (exits !== undefined && Node.isThrowStatement(node)) {
      // A throw in a loop body ends its path; the function's return state is not touched.
      this.emit("op", [this.liftExpr(node.getExpression())], 0, {
        origin: { kind: "ThrowStatement" },
        label: "throw",
      });
      this.dead = true;
      return true;
    }
    this.liftStatementInner(node, cont);
    if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) return true;
    return Node.isBlock(node) ? this.lastBlockExited : false;
  }

  private lastBlockExited = false;
  /**
   * Whether every path from here has thrown, so nothing after it runs. A branch side that is dead
   * never reaches the join after its if, and the join takes the other side's values.
   */
  private dead = false;
  private lastSideDead = false;

  private liftStatementInner(node: Node, cont?: readonly Node[]): void {
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
            : this.emit("literal-source", [], 1, {
                origin: { kind: "Uninitialized" },
                label: "Uninitialized",
              })[0];
        this.bindPattern(decl.getNameNode(), value as ValueId);
      }
      return;
    }
    if (Node.isExpressionStatement(node)) {
      this.liftExpr(node.getExpression());
      return;
    }
    if (Node.isReturnStatement(node)) {
      const expr = node.getExpression();
      this.reportReturn(expr !== undefined ? this.liftExpr(expr) : this.undefinedValue());
      return;
    }
    if (Node.isIfStatement(node)) {
      this.liftIf(node);
      return;
    }
    if (
      (Node.isForStatement(node) || Node.isWhileStatement(node) || Node.isDoStatement(node)) &&
      this.liftLoop(node)
    )
      return;
    if ((Node.isForOfStatement(node) || Node.isForInStatement(node)) && this.liftIterate(node))
      return;
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
      this.lastBlockExited = this.liftStatements(node.getStatements(), cont);
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
      this.reportThrow();
      this.dead = true;
      return;
    }
    // Any other statement (expression-less, declarations we don't bind):
    // still resolve its reads so nothing is dropped.
    this.liftOpaqueRegion(node, "op", { discardOutputs: true });
  }

  /**
   * Lifts an `if`. With `sides`, the rest of the function is on both sides (see liftStatements):
   * every path exits, so the result is the join of the sides' returns, one observation under the
   * condition. Otherwise the sides are the statements written, and their values join as names.
   */
  private liftIf(
    node: import("ts-morph").IfStatement,
    sides?: IfSides,
    mode: "total" | "join" = "total",
  ): void {
    const condValue = this.liftExpr(node.getExpression());
    // A return on some paths: the return state must exist before the branch, so the join carries it.
    if (sides === undefined && containsDirectExit(node)) this.ensureReturnState();
    const before = new Map(this.env);
    // Record the branch, and lift each side inside its own region, so the structure is kept.
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: condValue, ...(within !== undefined ? { within } : {}) });

    const total = sides !== undefined && mode === "total";
    const elseNode = node.getElseStatement();
    const thenStmts: readonly Node[] = sides?.whenTrue ?? [node.getThenStatement()];
    const elseStmts: readonly Node[] =
      sides?.whenFalse ?? (elseNode !== undefined ? [elseNode] : []);
    // A total side runs to the end of the function: falling off its end returns undefined.
    const side = (stmts: readonly Node[], returns: ValueId[]) => () =>
      this.branch(before, () => {
        const cont = total || sides !== undefined ? [] : undefined;
        if (!this.liftStatements(stmts, cont) && total) returns.push(this.undefinedValue());
      });
    const thenReturns: ValueId[] = [];
    const sidesStart = this.valueCounter;
    const thenEnv = this.inRegion(`${id}.t`, () =>
      this.inReturnFrame(total ? thenReturns : undefined, side(thenStmts, thenReturns)),
    );
    const thenDead = this.lastSideDead;
    const elseReturns: ValueId[] = [];
    let elseDead = false;
    const elseEnv =
      elseStmts.length > 0 || sides !== undefined
        ? this.inRegion(`${id}.e`, () =>
            this.inReturnFrame(total ? elseReturns : undefined, side(elseStmts, elseReturns)),
          )
        : before;
    if (elseStmts.length > 0 || sides !== undefined) elseDead = this.lastSideDead;
    if (thenDead && elseDead) this.dead = true;

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
      // A side that has thrown on every path never reaches here. When the other side's value was made
      // before the if, it is the value; otherwise the join keeps the value from before on the dead side.
      // The heap token keeps the throwing side's: what follows waits for the branch (#1285).
      if (thenDead !== elseDead && name !== HEAP) {
        const live = thenDead ? elseValue : thenValue;
        if (valueIndex(live) < sidesStart) {
          this.env.set(name, live);
          continue;
        }
        const [joined] = this.emit(
          "sel",
          [condValue, thenDead ? beforeValue : live, thenDead ? live : beforeValue],
          1,
          { origin: { kind: "IfJoin", text: name } },
        );
        this.env.set(name, joined as ValueId);
        continue;
      }
      if (thenValue !== elseValue) {
        const [joined] = this.emit("sel", [condValue, thenValue, elseValue], 1, {
          origin: { kind: "IfJoin", text: name },
        });
        this.env.set(name, joined as ValueId);
      } else if (thenValue !== beforeValue) {
        // Both sides hold the same new value (made before the if): it is the value after it.
        this.env.set(name, thenValue);
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
   * A throw is an exit with no value. In a total side its value is undefined (the path never
   * observes it); on some paths it marks the path as exited, keeping the return value.
   */
  private reportThrow(): void {
    const frame = this.returnFrames[this.returnFrames.length - 1];
    if (frame !== undefined) frame.push(this.undefinedValue());
    else if (this.env.has(RETURN_DONE)) {
      const [flag] = this.emit("literal-source", [], 1, {
        origin: { kind: "TrueKeyword", text: "true" },
        label: "true",
      });
      this.env.set(RETURN_DONE, flag as ValueId);
    }
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
    const [kept] = this.emit("sel", [done, current, value], 1, {
      origin: { kind: "ReturnSelect" },
    });
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
  private liftLoop(
    node:
      | import("ts-morph").WhileStatement
      | import("ts-morph").ForStatement
      | import("ts-morph").DoStatement,
  ): boolean {
    if (hasJump(node)) {
      // A loop that only breaks and continues lifts here; one that returns needs the rest of the
      // function, and lifts from liftStatements.
      if (loopReturns(node) || !jumpsSupported(node)) return false;
      return this.liftLoopWithExits(node) !== undefined;
    }
    return this.liftLoopBody(node);
  }

  /**
   * A while or for loop with breaks, continues and returns that belong to it. Its exits are carried
   * flags: the loop continues while none is set, a for's incrementor runs only when none is, and
   * the returned value is carried too. Returns the loop's results for the return flag and value.
   */
  private liftLoopWithExits(node: Node): { ret: ValueId; retv: ValueId } | undefined {
    if (
      !(Node.isWhileStatement(node) || Node.isForStatement(node) || Node.isDoStatement(node)) ||
      !jumpsSupported(node)
    )
      return undefined;
    const id = this.loopCount;
    const breaks = hasOwnBreak(node);
    const returns = loopReturns(node);
    const no = (): ValueId =>
      this.emit("literal-source", [], 1, {
        origin: { kind: "FalseKeyword", text: "false" },
        label: "false",
      })[0] as ValueId;
    const exits = {
      node,
      ...(breaks ? { brk: `%break${id}` } : {}),
      ...(returns ? { ret: `%return${id}`, retv: `%returnValue${id}` } : {}),
    };
    if (exits.brk !== undefined) this.env.set(exits.brk, no());
    if (exits.ret !== undefined && exits.retv !== undefined) {
      this.env.set(exits.ret, no());
      this.env.set(exits.retv, this.undefinedValue());
    }
    const outer = this.bodyExits;
    this.bodyExits = exits;
    try {
      this.liftLoopBody(
        node,
        [exits.brk, exits.ret, exits.retv].filter((n): n is string => n !== undefined),
      );
    } finally {
      this.bodyExits = outer;
    }
    const ret = exits.ret !== undefined ? this.env.get(exits.ret) : undefined;
    const retv = exits.retv !== undefined ? this.env.get(exits.retv) : undefined;
    return ret !== undefined && retv !== undefined
      ? { ret, retv }
      : { ret: no(), retv: this.undefinedValue() };
  }

  /** After a loop that returns: a total if on its return flag, the rest of the function on the other side. */
  private exitAfterLoop(flag: ValueId, value: ValueId, tail: readonly Node[]): void {
    const before = new Map(this.env);
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: flag, ...(within !== undefined ? { within } : {}) });
    const elseReturns: ValueId[] = [];
    this.inRegion(`${id}.e`, () =>
      this.inReturnFrame(elseReturns, () =>
        this.branch(before, () => {
          if (!this.liftStatements(tail, [])) elseReturns.push(this.undefinedValue());
        }),
      ),
    );
    const [returned] = this.emit("sel", [flag, value, elseReturns[0] as ValueId], 1, {
      origin: { kind: "IfReturn" },
    });
    this.reportReturn(returned as ValueId);
  }

  private liftLoopBody(
    node: import("ts-morph").WhileStatement | import("ts-morph").ForStatement | Node,
    exitNames: readonly string[] = [],
  ): boolean {
    if (!(Node.isWhileStatement(node) || Node.isForStatement(node) || Node.isDoStatement(node)))
      return false;
    const isFor = Node.isForStatement(node);
    // A do loop is a while loop whose first test is skipped: a carried flag, true at the start.
    const isDo = Node.isDoStatement(node);
    const firstName = isDo ? `%first${this.loopCount}` : undefined;
    if (firstName !== undefined) {
      this.env.set(
        firstName,
        this.emit("literal-source", [], 1, {
          origin: { kind: "TrueKeyword", text: "true" },
          label: "true",
        })[0] as ValueId,
      );
    }
    const cond = Node.isForStatement(node) ? node.getCondition() : node.getExpression();
    const incrementor = Node.isForStatement(node) ? node.getIncrementor() : undefined;
    const body = node.getStatement();

    // A `for` initializer runs once, before the loop.
    if (Node.isForStatement(node)) {
      const init = node.getInitializer();
      if (init !== undefined && Node.isVariableDeclarationList(init))
        this.liftDeclarations(init.getDeclarations());
      else if (init !== undefined) this.liftExpr(init);
    }

    const assigned: string[] = [];
    for (const part of [cond, body, incrementor]) {
      if (part === undefined) continue;
      for (const name of this.collectAssignedOuterNames(part)) {
        if (!assigned.includes(name)) assigned.push(name);
      }
    }
    // The heap token is the last carry: the exit flags and a do loop's first-pass flag are ordinary
    // names when the emitted loop is lifted again, and come before it there too.
    const carried = [
      ...assigned.filter((name) => this.env.has(name)),
      ...exitNames,
      ...(firstName !== undefined ? [firstName] : []),
      ...([cond, body, incrementor].some((part) => part !== undefined && touchesHeap(part))
        ? [HEAP]
        : []),
    ];
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
            label: name === HEAP ? `carry:${i}:heap` : `carry:${i}`,
            origin: { kind: "LoopCarry", text: truncate(name) },
          });
          carrySources.push(value as ValueId);
          this.env.set(name, value as ValueId);
        });
        // With exits: the loop continues while no exit is set, and then while its condition holds.
        const stopped = (): ValueId | undefined => {
          const flags = exitNames
            .filter((n) => !n.startsWith("%returnValue"))
            .map((n) => this.env.get(n) as ValueId);
          if (flags.length === 0) return undefined;
          return flags.slice(1).reduce(
            (acc, f) =>
              this.emit("op", [acc, f], 1, {
                origin: { kind: "Binary", text: "||" },
                label: "||",
              })[0] as ValueId,
            flags[0] as ValueId,
          );
        };
        const stop = stopped();
        const going =
          stop !== undefined
            ? (this.emit("op", [stop], 1, {
                origin: { kind: "PrefixUnaryExpression" },
                label: "!",
              })[0] as ValueId)
            : undefined;
        // The written condition: a do loop's first pass does not test it (`first || cond`, lazily).
        const condInert = cond === undefined || isInert(cond);
        const liftCond = (): ValueId => {
          const c = cond as Node;
          if (firstName === undefined) return this.liftExpr(c);
          const first = this.env.get(firstName) as ValueId;
          if (isInert(c)) {
            return this.emit("op", [first, this.liftExpr(c)], 1, {
              origin: { kind: "Binary", text: "||" },
              label: "||",
            })[0] as ValueId;
          }
          return this.liftLazy(
            first,
            () => first,
            () => this.liftExpr(c),
          );
        };
        const written =
          cond !== undefined && going !== undefined && !condInert
            ? this.liftLazy(going, liftCond, () => going)
            : cond !== undefined
              ? liftCond()
              : undefined;
        if (firstName !== undefined) {
          this.env.set(
            firstName,
            this.emit("literal-source", [], 1, {
              origin: { kind: "FalseKeyword", text: "false" },
              label: "false",
            })[0] as ValueId,
          );
        }
        condition =
          going !== undefined && written !== undefined && condInert
            ? (this.emit("op", [going, written], 1, {
                origin: { kind: "Binary", text: "&&" },
                label: "&&",
              })[0] as ValueId)
            : (written ??
              going ??
              (this.emit("literal-source", [], 1, {
                origin: { kind: "TrueKeyword", text: "true" },
                label: "true",
              })[0] as ValueId));
        // The body ends on every path, so a continue, a break or a return ends only its own path.
        if (Node.isBlock(body)) this.liftStatements(body.getStatements(), []);
        else this.liftStatement(body, []);
        // A body that throws on every path still may run no iterations.
        this.dead = false;
        if (incrementor !== undefined) {
          const after = stopped();
          if (after === undefined) this.liftExpr(incrementor);
          else
            this.liftLazy(
              after,
              () => after,
              () => this.liftExpr(incrementor),
            );
        }
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
  private liftIterate(
    node: import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement,
  ): boolean {
    const jumps = hasJump(node);
    if (jumps && !jumpsSupported(node)) return false;
    if (Node.isForOfStatement(node) && node.isAwaited()) return false;
    const init = node.getInitializer();
    if (!Node.isVariableDeclarationList(init) || init.getDeclarations().length !== 1) return false;
    const decl = init.getDeclarations()[0] as import("ts-morph").VariableDeclaration;
    const declared = patternNames(decl.getNameNode());
    const of: "values" | "keys" = Node.isForOfStatement(node) ? "values" : "keys";
    const body = node.getStatement();

    const iterable = this.liftExpr(node.getExpression());
    // Each step reads the iterable, so an iterating loop always carries the heap token.
    const carried = [
      ...this.collectAssignedOuterNames(body).filter(
        (name) => this.env.has(name) && !declared.includes(name),
      ),
      HEAP,
    ];
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
            label: name === HEAP ? `carry:${i}:heap` : `carry:${i}`,
            origin: { kind: "LoopCarry", text: truncate(name) },
          });
          carrySources.push(value as ValueId);
          this.env.set(name, value as ValueId);
        });
        [element] = this.emit("carry-source", [], 1, {
          label: "element",
          origin: { kind: "LoopElement", text: truncate(decl.getNameNode().getText()) },
        }) as [ValueId];
        this.bindPattern(decl.getNameNode(), element);
        // With continues and throws, each ends its own path, and an if holding one takes the rest.
        const outer = this.bodyExits;
        if (jumps) this.bodyExits = { node };
        try {
          if (Node.isBlock(body)) this.liftStatements(body.getStatements(), []);
          else this.liftStatement(body, []);
        } finally {
          this.bodyExits = outer;
          this.dead = false;
        }
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
          : this.emit("literal-source", [], 1, {
              origin: { kind: "Uninitialized" },
              label: "Uninitialized",
            })[0];
      this.bindPattern(decl.getNameNode(), value as ValueId);
    }
  }

  /**
   * Bind a name or a destructuring pattern to a value: each element reads its member (`.key`, a
   * computed key, or an index) and takes its default when that is undefined. An array pattern reads
   * by index, which is what it means for arrays and strings; an object rest is an operation that
   * names the keys it leaves out.
   */
  private bindPattern(nameNode: Node, value: ValueId): void {
    if (Node.isIdentifier(nameNode)) {
      const name = nameNode.getText();
      if (this.cells.has(name)) {
        // A name a closure rebinds is declared as a new cell holding its first value.
        const [cell] = this.emit("op", [value], 1, {
          origin: { kind: "ObjectLiteral", text: truncate(name) },
          label: 'object:["value"]',
        });
        this.env.set(name, cell as ValueId);
        return;
      }
      this.env.set(name, value);
      return;
    }
    const read = (label: string, inputs: ValueId[], text: string): ValueId =>
      this.emit("op", inputs, 1, {
        origin: { kind: "Destructure", text: truncate(text) },
        label,
      })[0] as ValueId;
    const literal = (text: string): ValueId =>
      this.emit("literal-source", [], 1, {
        origin: { kind: "Literal", text },
        label: normalizeLiteral(text),
      })[0] as ValueId;
    if (Node.isObjectBindingPattern(nameNode)) {
      const taken: string[] = [];
      for (const el of nameNode.getElements()) {
        if (el.getDotDotDotToken() !== undefined) {
          this.bindPattern(
            el.getNameNode(),
            read(`ObjectRest:${JSON.stringify(taken)}`, [value], el.getText()),
          );
          continue;
        }
        const key = el.getPropertyNameNode() ?? el.getNameNode();
        let member: ValueId;
        if (Node.isComputedPropertyName(key)) {
          member = read("ElementAccess", [value, this.liftExpr(key.getExpression())], el.getText());
        } else {
          const name =
            Node.isStringLiteral(key) || Node.isNumericLiteral(key)
              ? key.getLiteralText()
              : key.getText();
          taken.push(name);
          member = /^[A-Za-z_$][\w$]*$/.test(name)
            ? read(`.${name}`, [value], el.getText())
            : read("ElementAccess", [value, literal(JSON.stringify(name))], el.getText());
        }
        const init = el.getInitializer();
        this.bindPattern(
          el.getNameNode(),
          init !== undefined ? this.withDefault(member, init) : member,
        );
      }
      return;
    }
    if (Node.isArrayBindingPattern(nameNode)) {
      for (const [i, el] of nameNode.getElements().entries()) {
        if (Node.isOmittedExpression(el)) continue;
        if (el.getDotDotDotToken() !== undefined) {
          const slice = read(".slice", [value], el.getText());
          this.bindPattern(
            el.getNameNode(),
            read("CallExpression", [slice, literal(String(i))], el.getText()),
          );
          continue;
        }
        const member = read("ElementAccess", [value, literal(String(i))], el.getText());
        const init = el.getInitializer();
        this.bindPattern(
          el.getNameNode(),
          init !== undefined ? this.withDefault(member, init) : member,
        );
      }
      return;
    }
    for (const name of patternNames(nameNode)) this.env.set(name, value);
  }

  /** `value`, or the default when value is undefined; the default runs only then. */
  private withDefault(value: ValueId, init: Node): ValueId {
    const missing = this.emit("op", [value, this.undefinedValue()], 1, {
      origin: { kind: "Binary", text: "===" },
      label: "===",
    })[0] as ValueId;
    if (isInert(init)) {
      const d = this.liftExpr(init);
      return this.emit("sel", [missing, d, value], 1, {
        origin: { kind: "Conditional" },
      })[0] as ValueId;
    }
    return this.liftLazy(
      missing,
      () => this.liftExpr(init),
      () => value,
    );
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
    const deadBefore = this.dead;
    this.dead = false;
    try {
      body();
    } finally {
      this.lastSideDead = this.dead;
      this.dead = deadBefore;
      this.env = saved;
    }
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
          ? (this.emit("op", reads, 1, {
              origin: { kind: "RegionScope" },
              label: this.opaqueLabel("RegionScope", node),
            })[0] as ValueId)
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
    // Only a step assigns its operand: `!x` and `-x` read it.
    for (const un of unaries) {
      const op = un.getOperatorToken();
      if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken)
        consider(un.getOperand());
    }
    return [...names];
  }

  // --- expressions ---
  private liftExpr(node: Node): ValueId {
    if (node.getKind() === SyntaxKind.ThisKeyword) return this.thisValue();
    if (Node.isIdentifier(node)) {
      // `undefined`, unless a binding shadows it, is the literal: the same value a bare `return;` has.
      if (node.getText() === "undefined" && !this.env.has("undefined"))
        return this.undefinedValue();
      return this.resolveIdentifier(node.getText());
    }
    if (isLiteralExpression(node)) {
      return this.emit("literal-source", [], 1, {
        origin: { kind: node.getKindName(), text: truncate(node.getText()) },
        label: normalizeLiteral(node.getText()),
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
        if (this.cells.has(operand.getText())) this.writeCell(operand.getText(), out as ValueId);
        else this.env.set(operand.getText(), out as ValueId);
      }
      return out as ValueId;
    }
    if (Node.isConditionalExpression(node)) {
      const cond = this.liftExpr(node.getCondition());
      // An arm that could do more than produce a value runs only when it is chosen: a branch.
      if (!isInert(node.getWhenTrue()) || !isInert(node.getWhenFalse())) {
        return this.liftLazy(
          cond,
          () => this.liftExpr(node.getWhenTrue()),
          () => this.liftExpr(node.getWhenFalse()),
        );
      }
      const whenTrue = this.liftExpr(node.getWhenTrue());
      const whenFalse = this.liftExpr(node.getWhenFalse());
      return this.emit("sel", [cond, whenTrue, whenFalse], 1, {
        origin: { kind: "Conditional" },
      })[0] as ValueId;
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      const inputs: ValueId[] = [];
      const callee = node.getExpression();
      if (callee !== undefined && Node.isPropertyAccessExpression(callee)) {
        // A method's lookup is ordered just before its call, after the arguments (#1285): a
        // lowering writes `o.f(args)`, the lookup inside the call, so that is the order it keeps.
        const base = this.liftExpr(callee.getExpression());
        const args = this.liftElements(node.getArguments() as Node[]);
        const [method] = this.emit("op", [base], 1, {
          origin: { kind: "PropertyAccess", text: truncate(callee.getText()) },
          label: `${callee.hasQuestionDotToken() ? "?." : "."}${callee.getName()}`,
        });
        inputs.push(method as ValueId, ...args);
      } else {
        if (callee !== undefined) inputs.push(this.liftExpr(callee));
        inputs.push(...this.liftElements(node.getArguments() as Node[]));
      }
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
      const inputs = this.liftElements(node.getElements());
      return this.emit("op", inputs, 1, { origin: { kind: "ArrayLiteral" } })[0] as ValueId;
    }
    if (Node.isObjectLiteralExpression(node)) {
      return this.liftObjectLiteral(node);
    }
    if (Node.isTemplateExpression(node)) {
      // The literal parts are structure; the expressions between them are the inputs.
      const parts = [
        rawTextOf(node.getHead()),
        ...node.getTemplateSpans().map((span) => rawTextOf(span.getLiteral())),
      ];
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
        parts = [
          rawTextOf(template.getHead()),
          ...template.getTemplateSpans().map((span) => rawTextOf(span.getLiteral())),
        ];
        for (const span of template.getTemplateSpans())
          inputs.push(this.liftExpr(span.getExpression()));
      } else {
        parts = [rawTextOf(template)];
      }
      return this.emit("op", inputs, 1, {
        origin: { kind: "TaggedTemplate" },
        label: `tagged:${labelJson(parts)}`,
      })[0] as ValueId;
    }
    if (Node.isTypeOfExpression(node) || Node.isVoidExpression(node)) {
      // An operator on one value: its operand is the input.
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: node.getKindName() },
        label: node.getKindName(),
      })[0] as ValueId;
    }
    if (Node.isAwaitExpression(node) || Node.isYieldExpression(node)) {
      const inner = node.getExpression();
      const inputs = inner !== undefined ? [this.liftExpr(inner)] : [];
      return this.emit("op", inputs, 1, { origin: { kind: node.getKindName() } })[0] as ValueId;
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      const lifted = this.liftClosure(node);
      if (lifted !== undefined) return lifted;
      // A closure it cannot express is a value that carries the free variables it captures.
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
      if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name))
        return name.getLiteralValue();
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
      // A spread entry reads the object it spreads, so the literal is ordered among heap operations.
      ...(entries.includes(null) ? { heap: true } : {}),
    })[0] as ValueId;
  }

  /**
   * The structural label of an opaque node: its kind and a hash of its text. The names it reads from
   * outside are replaced by their order of first use, so renaming an outer name keeps the label; the
   * rest of the text is the structure, since the node has no other.
   */
  private opaqueLabel(
    kind: string,
    node: Node,
    extraLocals: ReadonlySet<string> = new Set(),
  ): string {
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
    // A short-circuit operator evaluates its right side only on some paths: unless that side only
    // produces a value, it is a branch, as the equivalent if is (#1276).
    const right = node.getRight();
    if (
      (op === SyntaxKind.AmpersandAmpersandToken ||
        op === SyntaxKind.BarBarToken ||
        op === SyntaxKind.QuestionQuestionToken) &&
      !isInert(right)
    ) {
      if (op === SyntaxKind.AmpersandAmpersandToken)
        return this.liftLazy(
          l,
          () => this.liftExpr(right),
          () => l,
        );
      if (op === SyntaxKind.BarBarToken)
        return this.liftLazy(
          l,
          () => l,
          () => this.liftExpr(right),
        );
      const [nullValue] = this.emit("literal-source", [], 1, {
        origin: { kind: "NullKeyword", text: "null" },
        label: "null",
      });
      const [isNullish] = this.emit("op", [l, nullValue as ValueId], 1, {
        origin: { kind: "Binary", text: "==" },
        label: "==",
      });
      return this.liftLazy(
        isNullish as ValueId,
        () => this.liftExpr(right),
        () => l,
      );
    }
    const r = this.liftExpr(right);
    return this.emit("op", [l, r], 1, {
      origin: { kind: "Binary", text: node.getOperatorToken().getText() },
      label: node.getOperatorToken().getText(),
    })[0] as ValueId;
  }

  /**
   * A value chosen by a condition whose arms run only when chosen: a branch whose sides compute the
   * arms, joined into one value. Names an arm assigns join as an if's do.
   */
  /**
   * The inputs for a list of elements or arguments. A spread's operand is lifted in its place, and its
   * iteration (`...`) just before the list's consumer (#1285): a lowering writes `[a, ...xs, b]`, the
   * iteration inside the list, so that is the order it keeps.
   */
  private liftElements(elements: readonly Node[]): ValueId[] {
    const inputs: (ValueId | undefined)[] = [];
    const spreads: { at: number; operand: ValueId }[] = [];
    for (const el of elements) {
      if (Node.isSpreadElement(el)) {
        spreads.push({ at: inputs.length, operand: this.liftExpr(el.getExpression()) });
        inputs.push(undefined);
      } else inputs.push(this.liftExpr(el));
    }
    for (const { at, operand } of spreads) {
      inputs[at] = this.emit("op", [operand], 1, {
        origin: { kind: "SpreadElement" },
        label: "...",
      })[0] as ValueId;
    }
    return inputs as ValueId[];
  }

  private liftLazy(cond: ValueId, whenTrue: () => ValueId, whenFalse: () => ValueId): ValueId {
    const before = new Map(this.env);
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond, ...(within !== undefined ? { within } : {}) });
    let thenValue = cond;
    let elseValue = cond;
    const thenEnv = this.inRegion(`${id}.t`, () =>
      this.branch(before, () => {
        thenValue = whenTrue();
      }),
    );
    const elseEnv = this.inRegion(`${id}.e`, () =>
      this.branch(before, () => {
        elseValue = whenFalse();
      }),
    );
    for (const [name, beforeValue] of before) {
      const t = thenEnv.get(name) ?? beforeValue;
      const e = elseEnv.get(name) ?? beforeValue;
      if (t !== e || t !== beforeValue) {
        const [joined] = this.emit("sel", [cond, t, e], 1, {
          origin: { kind: "IfJoin", text: name },
        });
        this.env.set(name, joined as ValueId);
      }
    }
    return this.emit("sel", [cond, thenValue, elseValue], 1, {
      origin: { kind: "Conditional" },
    })[0] as ValueId;
  }

  /** Reassign an lvalue. Identifier -> rebind; member/element -> mutate base object. */
  private assignTo(lhs: Node, value: ValueId): void {
    if (Node.isIdentifier(lhs)) {
      if (this.cells.has(lhs.getText()) && this.env.has(lhs.getText()))
        this.writeCell(lhs.getText(), value);
      else this.env.set(lhs.getText(), value);
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
      if (this.cells.has(name) && this.env.has(name)) this.writeCell(name, value);
      else if (this.env.has(name)) this.env.set(name, value);
    }
  }

  /** Resolve an identifier read to a value: bound name, import, ambient, or free. */
  private resolveIdentifier(name: string): ValueId {
    const bound = this.throughLoop(this.resolveName(name));
    if (!this.cells.has(name) || !this.env.has(name)) return bound;
    return this.emit("op", [bound], 1, {
      origin: { kind: "PropertyAccess", text: truncate(name) },
      label: ".value",
    })[0] as ValueId;
  }

  /** Writes a cell's value: the cell after the write is the name's value. */
  private writeCell(name: string, value: ValueId): void {
    const cell = this.throughLoop(this.env.get(name) as ValueId);
    const [written] = this.emit("op", [cell, value], 1, {
      origin: { kind: "Write", text: truncate(name) },
      label: ".value=",
    });
    this.env.set(name, written as ValueId);
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
        : this.ambient.has(name) || name === TRY_PRIMITIVE
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
      ...(n.order !== undefined ? { order: n.order } : {}),
      ...(n.region !== undefined ? { region: n.region } : {}),
      ...(n.loop !== undefined ? { loop: n.loop } : {}),
      ...(n.closure !== undefined ? { closure: n.closure } : {}),
    }));
    return canonicalizeGraph(nodes, dedupe(this.obs), this.branches);
  }
}

// ---------------------------------------------------------------------------
// ts-morph helpers
// ---------------------------------------------------------------------------

/** The names bound inside a closure: its declarations, parameters, inner functions and classes, and its own name. */
function closureLocals(fn: Node): Set<string> {
  const locals = collectRegionLocals(fn);
  for (const decl of [
    ...fn.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...fn.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
    ...fn.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ]) {
    const name = decl.getName();
    if (name !== undefined) locals.add(name);
  }
  if (Node.isFunctionExpression(fn)) {
    const name = fn.getName();
    if (name !== undefined) locals.add(name);
  }
  return locals;
}

/**
 * The names a scope declares that a closure inside it rebinds (#1276): they are held in cells. A name
 * bound by a loop's header, or a `var` inside a loop, is left out: JavaScript gives the first a binding
 * per iteration and the second one binding for all of them, and a cell made at the declaration is
 * neither.
 */
function cellNames(scope: Node): Set<string> {
  // A try statement's blocks are closures once it is lowered (Lifter.lowerTry): they count as nested.
  const nested = scope
    .getDescendants()
    .filter(
      (d) =>
        isFunctionLikeNode(d) ||
        (Node.isBlock(d) &&
          d.getParent()?.asKind(SyntaxKind.TryStatement)?.getTryBlock().compilerNode ===
            d.compilerNode) ||
        Node.isCatchClause(d),
    );
  if (nested.length === 0) return new Set();
  const insideNested = (n: Node): boolean => {
    for (const a of n.getAncestors()) {
      if (a.compilerNode === scope.compilerNode) return false;
      if (isFunctionLikeNode(a)) return true;
    }
    return false;
  };
  const inLoop = (n: Node): boolean => {
    for (const a of n.getAncestors()) {
      if (a.compilerNode === scope.compilerNode) return false;
      if (isLoopStatement(a)) return true;
    }
    return false;
  };
  const declared = new Set<string>();
  if (isFunctionLikeNode(scope))
    for (const p of (scope as FunctionLike).getParameters())
      for (const name of patternNames(p.getNameNode())) declared.add(name);
  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (insideNested(decl)) continue;
    const list = decl.getParent();
    const header = list?.getParent();
    if (
      header !== undefined &&
      (Node.isForStatement(header) ||
        Node.isForOfStatement(header) ||
        Node.isForInStatement(header))
    )
      continue;
    if (Node.isVariableDeclarationList(list) && list.getDeclarationKind() === "var" && inLoop(decl))
      continue;
    for (const name of patternNames(decl.getNameNode())) declared.add(name);
  }
  const out = new Set<string>();
  for (const fn of nested) {
    const locals = closureLocals(fn);
    for (const t of assignmentTargets(fn)) {
      const ids = Node.isIdentifier(t)
        ? [t]
        : Node.isPropertyAccessExpression(t) || Node.isElementAccessExpression(t)
          ? []
          : t.getDescendantsOfKind(SyntaxKind.Identifier);
      for (const id of ids) {
        const name = id.getText();
        if (declared.has(name) && !locals.has(name)) out.add(name);
      }
    }
  }
  return out;
}

/** The targets of assignments, compound assignments and ++/-- in a subtree. */
function assignmentTargets(node: Node): Node[] {
  // The whole file is asked for once per closure: memoized per node.
  const cached = assignmentTargetsCache.get(node.compilerNode);
  if (cached !== undefined) return cached;
  const targets = assignmentTargetsOf(node);
  assignmentTargetsCache.set(node.compilerNode, targets);
  return targets;
}

function assignmentTargetsOf(node: Node): Node[] {
  const targets: Node[] = [];
  for (const bin of node.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind();
    if (op === SyntaxKind.EqualsToken || COMPOUND_ASSIGN.has(op)) targets.push(bin.getLeft());
  }
  for (const un of [
    ...node.getDescendantsOfKind(SyntaxKind.PostfixUnaryExpression),
    ...node.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression),
  ]) {
    const op = un.getOperatorToken();
    if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken)
      targets.push(un.getOperand());
  }
  return targets;
}

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
  return JSON.stringify(value).replace(
    /\s/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
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
  // A break or continue that belongs to an inner loop or switch stays inside this loop.
  const leaves = (
    jump: import("ts-morph").BreakStatement | import("ts-morph").ContinueStatement,
  ): boolean => {
    if (jump.getLabel() !== undefined) return true;
    if (Node.isBreakStatement(jump)) return breakTarget(jump) === node;
    for (let p: Node | undefined = jump.getParent(); p !== undefined; p = p.getParent()) {
      if (
        Node.isForStatement(p) ||
        Node.isForOfStatement(p) ||
        Node.isForInStatement(p) ||
        Node.isWhileStatement(p) ||
        Node.isDoStatement(p)
      )
        return p === node;
    }
    return false;
  };
  const jumps = [
    ...node.getDescendantsOfKind(SyntaxKind.BreakStatement).filter(leaves),
    ...node.getDescendantsOfKind(SyntaxKind.ContinueStatement).filter(leaves),
    ...node.getDescendantsOfKind(SyntaxKind.ReturnStatement),
    // A throw leaves the loop too: the rest of the body would run unguarded (#1276).
    ...node.getDescendantsOfKind(SyntaxKind.ThrowStatement),
  ];
  return jumps.some((jump) => !isInsideNestedFunction(jump, node));
}

/**
 * Whether evaluating an expression can only produce a value: no call or `new`, no member read (which
 * can throw on null or run a getter), no assignment, step, delete, await or yield. Operators on
 * values count as producing a value. Such an expression may be computed on every path, so a
 * ternary of such arms is a select (D3); otherwise it is a branch.
 */
function isInert(node: Node): boolean {
  const effect = (n: Node): boolean => {
    if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isClassExpression(n))
      return false;
    if (
      Node.isCallExpression(n) ||
      Node.isNewExpression(n) ||
      Node.isPropertyAccessExpression(n) ||
      Node.isElementAccessExpression(n) ||
      Node.isTaggedTemplateExpression(n) ||
      Node.isDeleteExpression(n) ||
      Node.isAwaitExpression(n) ||
      Node.isYieldExpression(n)
    ) {
      return true;
    }
    if (Node.isBinaryExpression(n)) {
      const k = n.getOperatorToken().getKind();
      if (k === SyntaxKind.EqualsToken || COMPOUND_ASSIGN.has(k)) return true;
    }
    if (
      (Node.isPrefixUnaryExpression(n) || Node.isPostfixUnaryExpression(n)) &&
      [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(n.getOperatorToken())
    ) {
      return true;
    }
    return n.getChildren().some(effect);
  };
  return !effect(node);
}

interface SwitchArm {
  /** The case expressions that select the arm, as source text. */
  readonly tests: readonly string[];
  readonly isDefault: boolean;
  /** The arm's statements, as source text, without its closing break. */
  readonly body: string;
}

/**
 * The arms of a switch whose every clause ends in a break, a return or a throw (or is the last), with
 * no other break of its own and only inert case expressions. Undefined for any other switch, which
 * stays opaque.
 */
function switchArms(sw: import("ts-morph").SwitchStatement): SwitchArm[] | undefined {
  const cached = switchArmsCache.get(sw.compilerNode);
  if (cached !== undefined) return cached ?? undefined;
  const arms = switchArmsOf(sw);
  switchArmsCache.set(sw.compilerNode, arms ?? null);
  return arms;
}

function switchArmsOf(sw: import("ts-morph").SwitchStatement): SwitchArm[] | undefined {
  const clauses = sw.getCaseBlock().getClauses();
  const arms: SwitchArm[] = [];
  let tests: string[] = [];
  let isDefault = false;
  for (const [i, clause] of clauses.entries()) {
    if (Node.isCaseClause(clause)) {
      const expr = clause.getExpression();
      if (!isInert(expr)) return undefined;
      tests.push(expr.getText());
    } else {
      isDefault = true;
    }
    let stmts: Node[] = clause.getStatements();
    if (stmts.length === 0) continue;
    if (stmts.length === 1 && Node.isBlock(stmts[0] as Node))
      stmts = (stmts[0] as import("ts-morph").Block).getStatements();
    const last = stmts[stmts.length - 1];
    const ownBreaks = clause
      .getDescendantsOfKind(SyntaxKind.BreakStatement)
      .filter((b) => b.getLabel() === undefined && breakTarget(b) === sw);
    if (last !== undefined && Node.isBreakStatement(last) && last.getLabel() === undefined) {
      if (ownBreaks.length !== 1) return undefined;
      stmts = stmts.slice(0, -1);
    } else if (ownBreaks.length > 0) {
      return undefined;
    } else if (!(last !== undefined && alwaysReturns(last)) && i !== clauses.length - 1) {
      return undefined; // Falls into the next clause.
    }
    arms.push({ tests, isDefault, body: stmts.map((st) => st.getText()).join("\n") });
    tests = [];
    isDefault = false;
  }
  // Trailing labels with no body: a match runs nothing.
  if (tests.length > 0 || isDefault) arms.push({ tests, isDefault, body: "" });
  return arms;
}

/** The statement an unlabelled break leaves: its nearest enclosing loop or switch. */
function breakTarget(node: Node): Node | undefined {
  for (let p = node.getParent(); p !== undefined; p = p.getParent()) {
    if (Node.isFunctionDeclaration(p) || Node.isFunctionExpression(p) || Node.isArrowFunction(p))
      return undefined;
    if (
      Node.isSwitchStatement(p) ||
      Node.isForStatement(p) ||
      Node.isForOfStatement(p) ||
      Node.isForInStatement(p) ||
      Node.isWhileStatement(p) ||
      Node.isDoStatement(p)
    )
      return p;
  }
  return undefined;
}

function isFunctionLikeNode(n: Node): boolean {
  return (
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n) ||
    Node.isConstructorDeclaration(n) ||
    Node.isGetAccessorDeclaration(n) ||
    Node.isSetAccessorDeclaration(n)
  );
}

function isLoopStatement(n: Node): boolean {
  return (
    Node.isForStatement(n) ||
    Node.isForOfStatement(n) ||
    Node.isForInStatement(n) ||
    Node.isWhileStatement(n) ||
    Node.isDoStatement(n)
  );
}

/** The jumps of a loop that leave it or end its iteration: its own breaks and continues, and its returns. */
function loopJumpsOf(loop: Node): Node[] {
  const own = (
    j: import("ts-morph").BreakStatement | import("ts-morph").ContinueStatement,
  ): boolean => {
    if (Node.isBreakStatement(j)) return breakTarget(j) === loop;
    for (let p: Node | undefined = j.getParent(); p !== undefined; p = p.getParent())
      if (isLoopStatement(p)) return p === loop;
    return false;
  };
  return [
    ...loop
      .getDescendantsOfKind(SyntaxKind.BreakStatement)
      .filter((b) => b.getLabel() === undefined && own(b)),
    ...loop
      .getDescendantsOfKind(SyntaxKind.ContinueStatement)
      .filter((c) => c.getLabel() === undefined && own(c)),
    ...loop
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => !isInsideNestedFunction(r, loop)),
    // A throw ends its path; one inside an inner loop is that loop's.
    ...loop.getDescendantsOfKind(SyntaxKind.ThrowStatement).filter((t) => {
      if (isInsideNestedFunction(t, loop)) return false;
      for (let p: Node | undefined = t.getParent(); p !== undefined; p = p.getParent())
        if (isLoopStatement(p)) return p === loop;
      return false;
    }),
  ];
}

function hasOwnBreak(loop: Node): boolean {
  return loopJumpsOf(loop).some((j) => Node.isBreakStatement(j));
}

function loopReturns(loop: Node): boolean {
  return loopJumpsOf(loop).some((j) => Node.isReturnStatement(j));
}

/** Whether a statement holds a jump of `loop` (outside nested functions). */
function containsLoopJump(stmt: Node, loop: Node): boolean {
  const jumps = new Set(loopJumpsOf(loop).map((j) => j.compilerNode));
  return stmt.getDescendants().some((d) => jumps.has(d.compilerNode));
}

/**
 * Whether a loop's jumps can be lifted as exits: none labelled, none inside a nested loop or a switch
 * of the loop that could not take them, no throw, and a block holding a jump declares no name the
 * rest of the body could read.
 */
function jumpsSupported(loop: Node): boolean {
  if (Node.isForOfStatement(loop) || Node.isForInStatement(loop)) {
    // An iterating loop has no condition to stop it: only continues and throws, which end a path.
    if (loopJumpsOf(loop).some((j) => Node.isBreakStatement(j) || Node.isReturnStatement(j)))
      return false;
  } else if (
    !(Node.isWhileStatement(loop) || Node.isForStatement(loop) || Node.isDoStatement(loop))
  )
    return false;
  const labelled = [
    ...loop.getDescendantsOfKind(SyntaxKind.BreakStatement),
    ...loop.getDescendantsOfKind(SyntaxKind.ContinueStatement),
  ].some((j) => j.getLabel() !== undefined && !isInsideNestedFunction(j, loop));
  if (labelled) return false;
  const body = loop.getStatement();
  for (const j of loopJumpsOf(loop)) {
    for (
      let p: Node | undefined = j.getParent();
      p !== undefined && p.compilerNode !== body.compilerNode;
      p = p.getParent()
    ) {
      // A jump inside an inner loop, or a switch, try or label of the body, is not one this lifts.
      if (
        isLoopStatement(p) ||
        Node.isSwitchStatement(p) ||
        Node.isTryStatement(p) ||
        Node.isLabeledStatement(p)
      )
        return false;
      if (Node.isBlock(p)) {
        const lexical = p
          .getStatements()
          .flatMap((st) =>
            Node.isVariableStatement(st)
              ? st.getDeclarations().flatMap((d) => patternNames(d.getNameNode()))
              : [],
          );
        const outside = body
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => !id.getAncestors().some((a) => a.compilerNode === p?.compilerNode));
        if (lexical.some((n) => outside.some((id) => id.getText() === n))) return false;
      }
    }
  }
  return true;
}

/** The env name of the receiver (not a valid source name). */
const THIS = "%this";
/** The heap token (#1285): the last heap operation on the path, or the start. */
const HEAP = "%heap";
/** The platform primitive a try statement is a call of (#1276); see runtime.ts. */
const TRY_PRIMITIVE = "__yakccTry";

const HEAP_LABELS = new Set([
  "CallExpression",
  "CallExpression?.",
  "NewExpression",
  "ElementAccess",
  "[]=",
  "in",
  "instanceof",
  "...",
  "AwaitExpression",
  "YieldExpression",
  "TaggedTemplateExpression",
  "DeleteExpression",
]);

/**
 * Whether an operation reads or writes shared state, so its place among the others is structure: a
 * call, `new`, a member read or write, `in`, a spread, an opaque summary (its label has a hash).
 */
export function isHeapLabel(label: string): boolean {
  return (
    HEAP_LABELS.has(label) ||
    label.includes("#") ||
    label.startsWith("?.") ||
    label.startsWith("ElementAccess") ||
    (label.startsWith(".") && label.length > 1)
  );
}

const HEAP_SYNTAX = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.SpreadElement,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.YieldExpression,
  SyntaxKind.TryStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.LabeledStatement,
  SyntaxKind.WithStatement,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
]);

/** Whether code may run a heap operation: a loop over it carries the heap token. */
function touchesHeap(node: Node): boolean {
  return node.getDescendants().some((d) => HEAP_SYNTAX.has(d.getKind()));
}

/** The function whose `this` a node sees: its nearest enclosing function that is not an arrow. */
function receiverOwner(node: Node): Node | undefined {
  for (let p = node.getParent(); p !== undefined; p = p.getParent()) {
    if (
      Node.isFunctionDeclaration(p) ||
      Node.isFunctionExpression(p) ||
      Node.isMethodDeclaration(p) ||
      Node.isConstructorDeclaration(p) ||
      Node.isGetAccessorDeclaration(p) ||
      Node.isSetAccessorDeclaration(p) ||
      Node.isClassDeclaration(p) ||
      Node.isClassExpression(p)
    ) {
      return p;
    }
  }
  return undefined;
}

/** Names of the return state (not valid source names, so they never clash with a binding). */
const RETURN_DONE = "%returned";
const RETURN_VALUE = "%returnValue";

/** The statements of an `if`'s two sides, once the rest of its statement list is placed on a side. */
interface IfSides {
  readonly whenTrue: readonly Node[];
  readonly whenFalse: readonly Node[];
}

/** True when every path through the node reaches a return or a throw. Loops and switches are not followed. */
function alwaysReturns(node: Node): boolean {
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) return true;
  if (Node.isBlock(node)) return node.getStatements().some(alwaysReturns);
  if (Node.isIfStatement(node)) {
    const elseNode = node.getElseStatement();
    return (
      elseNode !== undefined && alwaysReturns(node.getThenStatement()) && alwaysReturns(elseNode)
    );
  }
  return false;
}

/** True when the node has a return that is not inside a nested function, loop, switch or try. */
function containsDirectReturn(node: Node): boolean {
  return node
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .some((ret) => !insideOpaque(ret, node));
}

/** True when the node has a return or a throw that is not inside a nested function, loop, switch or try. */
function containsDirectExit(node: Node): boolean {
  // Asked of the same statements many times (each list position, each tail): memoized per node.
  const key = node.compilerNode;
  const known = exitCache.get(key);
  if (known !== undefined) return known;
  const result =
    containsDirectReturn(node) ||
    node.getDescendantsOfKind(SyntaxKind.ThrowStatement).some((t) => !insideOpaque(t, node));
  exitCache.set(key, result);
  return result;
}

const exitCache = new WeakMap<object, boolean>();
const readNamesCache = new WeakMap<object, string[]>();
const switchArmsCache = new WeakMap<object, SwitchArm[] | null>();
const assignmentTargetsCache = new WeakMap<object, Node[]>();

function insideOpaque(ret: Node, root: Node): boolean {
  for (
    let p = ret.getParent();
    p !== undefined && p.compilerNode !== root.compilerNode;
    p = p.getParent()
  ) {
    if (
      Node.isFunctionDeclaration(p) ||
      Node.isFunctionExpression(p) ||
      Node.isArrowFunction(p) ||
      Node.isForStatement(p) ||
      Node.isForOfStatement(p) ||
      Node.isForInStatement(p) ||
      Node.isWhileStatement(p) ||
      Node.isDoStatement(p) ||
      (Node.isSwitchStatement(p) && switchArms(p) === undefined) ||
      Node.isTryStatement(p)
    ) {
      return true;
    }
  }
  return false;
}
