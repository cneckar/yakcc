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
import {
  Node,
  Project,
  ScriptKind,
  type SourceFile,
  SyntaxKind,
  VariableDeclarationKind,
  ts,
} from "ts-morph";
import { KNOWN_PRIMITIVES } from "./base-set.js";
import { canonicalizeGraph } from "./canonical.js";
import { isHeapLabel } from "./heap-labels.js";
import { normalizeLiteral } from "./literal.js";
import { jsOperation } from "./ops.js";
import { RUNTIME_MODULE } from "./runtime.js";
import type {
  DiamondReason,
  DucBranch,
  DucGraph,
  DucLoop,
  DucNode,
  FunctionMode,
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
  const parsed = parseAtomSource(source);
  const project = parsed.project;
  const file = normalizeJumps(project, parsed.file);
  // Names a target provides are platform primitives (D5); which target is checked by the closure check.
  const ambient = new Set(options.ambientGlobals ?? KNOWN_PRIMITIVES);
  const builder = new Lifter(ambient);
  builder.collectImports(file);
  builder.run(file);
  return builder.finish();
}

/**
 * The atom's source parsed: as written, or else the first analysis form that parses (a named
 * function, a function body, an expression). Throws DucLiftError when none parses.
 */
/** The functions in a statement, itself included: each makes a closure when it runs. */
function functionsWithin(node: Node): Node[] {
  const fns: Node[] = node.getDescendants().filter(isFunctionLikeNode);
  if (isFunctionLikeNode(node)) fns.unshift(node);
  return fns;
}

/** The label prefix of a module statement's one result: the names it declares, and their values. */
export const DECLARES = "declares:";

/** The names a module statement's graph declares, in order, when it is one (#1290, #1292). */
/**
 * The label prefix of a fragment's one result when the fragment can return (#1297): its completion
 * record. The inputs are whether it returned, the value it returned, then its declared values, in
 * the order the label names them.
 */
export const COMPLETES = "completes:";

/** The two module names a completion's TypeScript form gives the returned flag and the value. */
export const RETURNED_NAME = "__yakccReturned";
export const RETURN_VALUE_NAME = "__yakccReturnValue";

/** A fragment's completion, when its one result is a completion record: the names it declares. */
export function completionOf(graph: {
  readonly nodes: readonly { readonly outputs: readonly string[]; readonly label?: string }[];
  readonly obs: readonly string[];
}): string[] | undefined {
  if (graph.obs.length !== 1) return undefined;
  const node = graph.nodes.find((n) => n.outputs.includes(graph.obs[0] as string));
  const label = node?.label;
  return label?.startsWith(COMPLETES) === true
    ? (JSON.parse(label.slice(COMPLETES.length)) as string[])
    : undefined;
}

export function declaredNamesOf(graph: {
  readonly nodes: readonly { readonly outputs: readonly string[]; readonly label?: string }[];
  readonly obs: readonly string[];
}): string[] | undefined {
  if (graph.obs.length !== 1) return undefined;
  const node = graph.nodes.find((n) => n.outputs.includes(graph.obs[0] as string));
  const label = node?.label;
  return label?.startsWith(DECLARES) === true
    ? (JSON.parse(label.slice(DECLARES.length)) as string[])
    : undefined;
}

export function parseAtomSource(source: string): { project: Project; file: SourceFile } {
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
    let sf = attempt.createSourceFile("atom.ts", candidate, { scriptKind: ScriptKind.TS });
    // A fragment of an async function's body awaits at its top level: as a script, `await x` is a
    // call of a name `await`; as a module it is the await it means (#1297).
    if (
      /\bawait\b/.test(candidate) &&
      sf.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === "await")
    ) {
      // An empty export list makes the file a module, and lifts to nothing.
      const asModule = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { allowJs: false, noEmit: true, noLib: true, skipLibCheck: true },
      });
      const moduleFile = asModule.createSourceFile("atom.ts", `${candidate}\nexport {};`, {
        scriptKind: ScriptKind.TS,
      });
      if (asModule.getProgram().getSyntacticDiagnostics(moduleFile).length === 0) sf = moduleFile;
    }
    const diagnostics = sf.getProject().getProgram().getSyntacticDiagnostics(sf);
    if (diagnostics.length === 0) {
      project = sf.getProject();
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

  return { project, file };
}

/** What an atom's source is, as a module sees it (#1290). */
export type AtomShape =
  | { readonly kind: "function"; readonly name?: string }
  | { readonly kind: "statement"; readonly names: readonly string[] };

/**
 * Whether an atom is a function or module statements, and for statements the names its graph
 * observes, in the graph's observation order: the exported names, then the names it declares.
 */
export function atomShape(source: string): AtomShape {
  const { file } = parseAtomSource(source);
  const primary = findPrimaryFunction(file);
  if (primary !== undefined) {
    const name = Node.isFunctionDeclaration(primary)
      ? primary.getName()
      : primary.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName();
    // `__atom__` is the analysis form's name for an anonymous function, not the atom's.
    return name !== undefined && name !== "__atom__"
      ? { kind: "function", name }
      : { kind: "function" };
  }
  const names = exportedBindingNames(file);
  for (const name of moduleDeclaredNames(file)) if (!names.includes(name)) names.push(name);
  return { kind: "statement", names };
}

/**
 * Jumps that cross a loop, rewritten to jumps that do not (#1276): a return inside an inner loop,
 * and a labelled break or continue of an outer loop, set a flag and break out of their own loop,
 * and after it `if (flag)` jumps again, one loop further out, until each jump is one of its own
 * loop's. A label whose jumps are all of its own loop is dropped. A jump with a switch between it
 * and its loop, or to a labelled block, is left as it is.
 */
function normalizeJumps(project: Project, file: SourceFile): SourceFile {
  let sf = file;
  for (let round = 0; round < 64; round++) {
    const text = nextJumpRewrite(sf, round);
    if (text === undefined) return sf;
    sf = project.createSourceFile("atom.ts", text, { overwrite: true, scriptKind: ScriptKind.TS });
  }
  return sf;
}

/** The innermost loop around a node, inside its own function. */
function ownLoop(n: Node): Node | undefined {
  for (let p: Node | undefined = n.getParent(); p !== undefined; p = p.getParent()) {
    if (isFunctionLikeNode(p)) return undefined;
    if (isLoopStatement(p)) return p;
  }
  return undefined;
}

/** The statement a jump labelled `name` leaves or continues, inside its own function. */
function labelTarget(j: Node, name: string): import("ts-morph").LabeledStatement | undefined {
  for (let p: Node | undefined = j.getParent(); p !== undefined; p = p.getParent()) {
    if (isFunctionLikeNode(p)) return undefined;
    if (Node.isLabeledStatement(p) && p.getLabel().getText() === name) return p;
  }
  return undefined;
}

/** The statement a label names, through any further labels on it. */
function labelled(l: import("ts-morph").LabeledStatement): Node {
  let st: Node = l.getStatement();
  while (Node.isLabeledStatement(st)) st = st.getStatement();
  return st;
}

function nextJumpRewrite(sf: SourceFile, round: number): string | undefined {
  const full = sf.getFullText();
  const jumps = [
    ...sf.getDescendantsOfKind(SyntaxKind.ReturnStatement),
    ...sf.getDescendantsOfKind(SyntaxKind.BreakStatement),
    ...sf.getDescendantsOfKind(SyntaxKind.ContinueStatement),
  ];
  // A label whose jumps are all of the loop it labels is dropped, and the labels from its jumps.
  for (const l of sf.getDescendantsOfKind(SyntaxKind.LabeledStatement)) {
    const name = l.getLabel().getText();
    const target = labelled(l);
    if (!isLoopStatement(target)) continue;
    const mine = jumps.filter(
      (j) =>
        !Node.isReturnStatement(j) &&
        (j as import("ts-morph").BreakStatement).getLabel()?.getText() === name &&
        labelTarget(j, name) === l,
    );
    const own = mine.every((j) =>
      Node.isBreakStatement(j) ? breakTarget(j) === target : ownLoop(j) === target,
    );
    if (!own) continue;
    const edits = [
      { from: l.getStart(), to: target.getStart(), text: "" },
      ...mine.map((j) => ({
        from: j.getStart(),
        to: j.getEnd(),
        text: Node.isBreakStatement(j) ? "break;" : "continue;",
      })),
    ].sort((a, b) => b.from - a.from);
    let text = full;
    for (const e of edits) text = text.slice(0, e.from) + e.text + text.slice(e.to);
    return text;
  }
  // A jump that leaves its own loop for one further out: lifted one loop out.
  for (const j of jumps) {
    const inner = ownLoop(j);
    if (inner === undefined) continue;
    let needs: boolean;
    if (Node.isReturnStatement(j)) needs = ownLoop(inner) !== undefined;
    else {
      const label = (j as import("ts-morph").BreakStatement).getLabel()?.getText();
      if (label === undefined) continue;
      const l = labelTarget(j, label);
      if (l === undefined || !isLoopStatement(labelled(l))) continue;
      needs = labelled(l) !== inner;
    }
    if (!needs) continue;
    // A plain break must leave the inner loop: no switch between them.
    let blocked = false;
    for (let p: Node | undefined = j.getParent(); p !== undefined && p !== inner; p = p.getParent())
      if (Node.isSwitchStatement(p)) blocked = true;
    if (blocked) continue;
    let outer: Node = inner;
    while (Node.isLabeledStatement(outer.getParent())) outer = outer.getParent() as Node;
    const flag = `$jump${round}`;
    const value = `$jumpv${round}`;
    const ret = Node.isReturnStatement(j) ? j : undefined;
    const expr = ret?.getExpression();
    const replaced = `{ ${flag} = true;${expr !== undefined ? ` ${value} = (${expr.getText()});` : ""} break; }`;
    const again =
      ret !== undefined ? (expr !== undefined ? `return ${value};` : "return;") : j.getText();
    const start = outer.getStart();
    const body =
      full.slice(start, j.getStart()) + replaced + full.slice(j.getEnd(), outer.getEnd());
    const wrapped = `{ let ${flag} = false;${expr !== undefined ? ` let ${value};` : ""}\n${body}\nif (${flag}) ${again} }`;
    return full.slice(0, start) + wrapped + full.slice(outer.getEnd());
  }
  return undefined;
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
  // A class member sliced out of its class (a method, an accessor, a constructor), #1297.
  forms.push(`class __atom__ {\n${source}\n}`);
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
  /**
   * Names made cells ahead of their declaration, for a function hoisted above it (#1173): the
   * declaration writes the cell, which the function captured.
   */
  private readonly hoistedCells = new Set<string>();
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
  /** The name of the class whose member this graph is: it reads as `class-self` (#1276). */
  private classSelf: string | undefined;
  private classSelfValue: ValueId | undefined;
  /** The name of the function this graph is, when it reads it: `function-self` (#1276). */
  private functionSelf: string | undefined;
  private functionSelfValue: ValueId | undefined;
  /**
   * Free names the atom assigns (#1276): each is a binding outside the atom, so a read is a
   * `binding` operation on it and a write a `binding=`, ordered among the heap operations. The
   * name's value is the binding itself (its source, or a closure's capture of it).
   */
  private bindings = new Set<string>();
  /** This graph is a derived class's constructor: `this` is what its `super(..)` call makes. */
  private derived = false;
  /** The atom is a fragment that can return (#1297): its declared names are joined over its exits. */
  private completing = false;

  private readonly obs: ValueId[] = [];
  /** The atom's function is async or a generator (#1276). */
  private mode: FunctionMode | undefined;

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
      // Structural label (D6): explicit, else the syntactic kind of the origin. An ECMAScript
      // operator is named as an operation (`+` is `js.add`, #1310).
      ...(extra?.label !== undefined
        ? { label: kind === "op" ? jsOperation(extra.label, given.length) : extra.label }
        : extra?.origin !== undefined && (kind === "op" || kind === "literal-source")
          ? {
              label:
                kind === "op" ? jsOperation(extra.origin.kind, given.length) : extra.origin.kind,
            }
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
    for (const name of writtenFreeNames(file)) if (!this.imports.has(name)) this.bindings.add(name);
    const primary = findPrimaryFunction(file);
    if (primary !== undefined) {
      this.mode = functionModeOf(primary);
      this.liftFunction(primary);
    } else {
      // No single exported function: lift the top-level statements in one scope,
      // and treat every exported binding's final value as an observation.
      for (const name of cellNames(file)) this.cells.add(name);
      // A fragment that returns at its top level was sliced from a function body (#1297): it runs in
      // the function's exit mode, under the return state, and its result is its completion record.
      const returns = (file as SourceFile)
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .some((r) => !r.getAncestors().some(isFunctionLikeNode));
      if (returns) {
        this.exitMode = "function";
        this.completing = true;
        this.ensureReturnState();
      }
      // Import declarations are the file's imports (recorded above), not statements it runs.
      this.hoistVars(file);
      // Statements, not syntax-list children: those can include comment trivia.
      this.liftStatements(
        (file as SourceFile).getStatements().filter((stmt) => !Node.isImportDeclaration(stmt)),
      );
      // An exported name is observed: one the file binds, an import exported again, or a name the
      // fragment exports without binding it (free). So is a name a module statement declares
      // (#1290): it is the module's, and the atoms that read it read this value.
      const observed = exportedBindingNames(file);
      for (const name of moduleDeclaredNames(file))
        if (!observed.includes(name)) observed.push(name);
      // One result, naming each declared value (#1292): two names with one value stay two, and a
      // name that is undefined stays one, as a list of results would not keep them.
      // A completion's TypeScript form names the returned flag and value (emit-ts): read back, they
      // are the record's first two inputs, as lifting the fragment itself gives them.
      const emittedCompletion = observed[0] === RETURNED_NAME && observed[1] === RETURN_VALUE_NAME;
      const named = emittedCompletion ? observed.slice(2) : observed;
      const values = named.map((name) => this.resolveIdentifier(name));
      if (returns || emittedCompletion) {
        const record = returns
          ? [this.env.get(RETURN_DONE) as ValueId, this.env.get(RETURN_VALUE) as ValueId]
          : [this.resolveIdentifier(RETURNED_NAME), this.resolveIdentifier(RETURN_VALUE_NAME)];
        const [completion] = this.emit("op", [...record, ...values], 1, {
          origin: { kind: "Completes" },
          label: `${COMPLETES}${JSON.stringify(named)}`,
        });
        this.obs.push(completion as ValueId);
        return;
      }
      const [declared] = this.emit("op", values, 1, {
        origin: { kind: "Declares" },
        label: `${DECLARES}${JSON.stringify(observed)}`,
      });
      this.obs.push(declared as ValueId);
    }
  }

  private liftFunction(fn: FunctionLike, paramOffset = 0): void {
    for (const name of cellNames(fn)) this.cells.add(name);
    for (const [index, param] of fn.getParameters().entries()) {
      const nameNode = param.getNameNode();
      const [value] = this.emit("param-source", [], 1, {
        origin: { kind: "Parameter", text: truncate(nameNode.getText()) },
        label: `${paramOffset + index}${param.isRestParameter() ? "..." : ""}`,
      });
      // A default applies when the argument is undefined; a pattern reads each member (#1276).
      const init = param.getInitializer();
      this.bindPattern(
        nameNode,
        init !== undefined ? this.withDefault(value as ValueId, init) : (value as ValueId),
      );
    }
    // A constructor's parameter property (`constructor(private readonly x: T)`) is the write
    // `this.x = x` before its body runs (#1297).
    if (Node.isConstructorDeclaration(fn))
      for (const param of fn.getParameters()) {
        if (param.getScope() === undefined && !param.isReadonly()) continue;
        const name = param.getName();
        this.emit("op", [this.thisValue(), this.resolveIdentifier(name)], 1, {
          origin: { kind: "Write" },
          label: `.${name}=`,
        });
      }
    const body = fn.getBody();
    if (body === undefined) return;
    if (Node.isBlock(body)) {
      this.exitMode = "function";
      this.hoistVars(body);
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

  /**
   * `var` is function-scoped and hoisted (#1173): a name it declares inside a nested block
   * (`if (c) var r = 1;`) is the function's from its start, `undefined` until assigned, so a read
   * after the block reads it, not a free name. A parameter of that name keeps its value.
   */
  private hoistVars(body: Node): void {
    for (const name of nestedVarNames(body)) {
      if (this.env.has(name)) continue;
      this.env.set(name, this.undefinedValue());
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
    // Names declared in the list by `var`: hoisted as undefined, as JavaScript hoists them. A `let`,
    // `const` or class read before its declaration throws, so a function reading one is not hoisted
    // over it: it is bound where it stands, and the name stays reported.
    const declaredValues = new Set<string>();
    for (const stmt of stmts) {
      if (
        Node.isVariableStatement(stmt) &&
        stmt.getDeclarationKind() === VariableDeclarationKind.Var
      )
        for (const decl of stmt.getDeclarations())
          for (const name of patternNames(decl.getNameNode())) declaredValues.add(name);
    }
    // A function declaration is hoisted, as JavaScript hoists it (#1173). A later-declared value it
    // reads is a cell from here, holding undefined until its declaration writes it, so the function
    // sees the value it has when it runs. One that reads a later function waits for it: passes repeat
    // until no more can be hoisted, and the rest are bound where they stand.
    let progress = true;
    while (progress) {
      progress = false;
      for (const stmt of stmts) {
        if (!Node.isFunctionDeclaration(stmt)) continue;
        const name = stmt.getName();
        if (name === undefined || hoistedNames.has(name)) continue;
        // Already bound by the list it was hoisted in (a tail lifted again on a side).
        if (this.hoisted.has(stmt.compilerNode)) {
          hoistedNames.add(name);
          progress = true;
          continue;
        }
        const reads = this.readNamesOf(stmt).filter(
          (read) => read !== name && declared.has(read) && !hoistedNames.has(read),
        );
        if (reads.some((read) => !declaredValues.has(read))) continue;
        for (const read of reads) this.hoistCell(read);
        this.bindFunctionDeclaration(stmt, name);
        this.hoisted.add(stmt.compilerNode);
        hoistedNames.add(name);
        progress = true;
      }
    }
    // A closure made before a later `var` it reads (`o.f = function () { return K }; … var K = 10`),
    // or in the `var`'s own initializer (`var m = function () { return m.cache }`), reads the binding
    // when it runs, not the value when it is made: the name is a cell from here.
    for (const [j, stmt] of stmts.entries()) {
      if (!Node.isVariableStatement(stmt)) continue;
      const isVar = stmt.getDeclarationKind() === VariableDeclarationKind.Var;
      for (const decl of stmt.getDeclarations())
        for (const name of patternNames(decl.getNameNode())) {
          const readEarlier = stmts
            .slice(0, isVar ? j + 1 : j)
            .some((earlier) =>
              functionsWithin(earlier).some((fn) => this.readNamesOf(fn).includes(name)),
            );
          // A `let` or `const` too, read by a closure made before it, which runs after it is
          // initialized (#1297); or assigned by a closure in its own initializer (`let id =
          // setTimeout(() => { id = null })`). A const arrow calling itself is `function-self`.
          const writtenByOwn =
            !isVar &&
            functionsWithin(stmt).some((fn) =>
              assignmentTargets(fn).some((t) => Node.isIdentifier(t) && t.getText() === name),
            );
          if (readEarlier || writtenByOwn) this.hoistCell(name);
        }
    }
    for (const [i, written] of stmts.entries()) {
      // A switch whose clauses each end in an exit is the if chain it means (#1276).
      const stmt = Node.isSwitchStatement(written)
        ? (this.lowerSwitch(written) ?? this.lowerSwitchAsPass(written) ?? written)
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
        // A condition that assigns is tested in the body, as liftLoop does.
        const tested =
          Node.isWhileStatement(stmt) || Node.isForStatement(stmt) || Node.isDoStatement(stmt)
            ? this.testedInBody(stmt)
            : undefined;
        const flags = this.liftLoopWithExits(tested ?? stmt);
        if (flags !== undefined) {
          this.exitAfterLoop(flags.ret, flags.retv, full);
          return true;
        }
      }
      // A loop that returns where the rest of the function is not known (under the return state):
      // its return is a partial return on the paths where it returned, and the rest is guarded.
      if (
        full === undefined &&
        this.exitMode === "function" &&
        this.env.has(RETURN_DONE) &&
        this.returnFrames[this.returnFrames.length - 1] === undefined &&
        isLoopStatement(stmt) &&
        loopReturns(stmt)
      ) {
        const tested =
          Node.isWhileStatement(stmt) || Node.isForStatement(stmt) || Node.isDoStatement(stmt)
            ? this.testedInBody(stmt)
            : undefined;
        const flags = this.liftLoopWithExits(tested ?? stmt);
        if (flags !== undefined) {
          const done = this.env.get(RETURN_DONE) as ValueId;
          const current = this.env.get(RETURN_VALUE) as ValueId;
          const [first] = this.emit("sel", [done, current, flags.retv], 1, {
            origin: { kind: "ReturnSelect" },
          });
          const [value] = this.emit("sel", [flags.ret, first as ValueId, current], 1, {
            origin: { kind: "ReturnSelect" },
          });
          const [flag] = this.emit("literal-source", [], 1, {
            origin: { kind: "TrueKeyword", text: "true" },
            label: "true",
          });
          const [nowDone] = this.emit("sel", [flags.ret, flag as ValueId, done], 1, {
            origin: { kind: "ReturnSelect" },
          });
          this.env.set(RETURN_VALUE, value as ValueId);
          this.env.set(RETURN_DONE, nowDone as ValueId);
          if (rest.length > 0) this.guardTail(rest);
          return false;
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
   * A class as one operation over its members' closures (#1276): the constructor, then each method
   * and accessor in order, its label naming each member's kind, name and whether it is static. A
   * member reads the class's own name as `class-self`. Undefined when it is not that: a heritage
   * clause (`super` needs the parent), a field, a static block, a computed or private name, a
   * parameter property, or a member that is not a closure. An async or generator method is one.
   */
  private liftClass(
    node: import("ts-morph").ClassDeclaration | import("ts-morph").ClassExpression,
  ): ValueId | undefined {
    // `extends P` is evaluated first: the parent is the class's first input, `["extends"]` its
    // first entry (#1276). An `implements` clause is a type and computes nothing.
    const heritage = node.getExtends();
    const parent = heritage !== undefined ? this.liftExpr(heritage.getExpression()) : undefined;
    const self = node.getName();
    const members: unknown[] = [];
    const closures: FunctionLike[] = [];
    for (const m of node.getMembers()) {
      if (Node.isConstructorDeclaration(m)) {
        if (m.getBody() === undefined) continue;
        if (m.getParameters().some((p) => p.getScope() !== undefined || p.isReadonly()))
          return undefined;
        members.unshift(["constructor"]);
        closures.unshift(m);
        continue;
      }
      if (
        !(
          Node.isMethodDeclaration(m) ||
          Node.isGetAccessorDeclaration(m) ||
          Node.isSetAccessorDeclaration(m)
        )
      )
        return undefined;
      const nameNode = m.getNameNode();
      if (!Node.isIdentifier(nameNode)) return undefined;
      if (m.getBody() === undefined) return undefined;
      const kind = Node.isMethodDeclaration(m)
        ? "method"
        : Node.isGetAccessorDeclaration(m)
          ? "get"
          : "set";
      members.push([kind, nameNode.getText(), m.isStatic()]);
      closures.push(m);
    }
    const values: ValueId[] = [];
    for (const fn of closures) {
      const value = this.liftClosure(fn, undefined, self);
      if (value === undefined) return undefined;
      values.push(value);
    }
    if (parent !== undefined) {
      members.unshift(["extends"]);
      values.unshift(parent);
    }
    return this.emit("op", values, 1, {
      origin: { kind: "Class", text: truncate(self ?? "class") },
      label: `class:${labelJson(members)}`,
    })[0] as ValueId;
  }

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
    const finalizer = t.getFinallyBlock();
    const parts = [
      t.getTryBlock(),
      ...(handler !== undefined ? [handler.getBlock()] : []),
      ...(finalizer !== undefined ? [finalizer] : []),
    ];
    const vars: string[] = [];
    let awaits = false;
    for (const part of parts) {
      const own = (n: Node): boolean => !isInsideNestedFunction(n, part);
      for (const list of part.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
        if (!own(list) || list.getDeclarationKind() !== "var") continue;
        // A var belongs to the function: only a plain name can be declared there instead.
        const header = list.getParent();
        if (Node.isForInStatement(header) || Node.isForOfStatement(header)) return undefined;
        for (const d of list.getDeclarations()) {
          if (!Node.isIdentifier(d.getNameNode())) return undefined;
          if (!vars.includes(d.getName())) vars.push(d.getName());
        }
      }
      // A yield cannot move into a closure; an await can, into an async one.
      if (part.getDescendantsOfKind(SyntaxKind.YieldExpression).some(own)) return undefined;
      if (part.getDescendantsOfKind(SyntaxKind.AwaitExpression).some(own)) awaits = true;
      if (part.getDescendantsOfKind(SyntaxKind.ForOfStatement).some((f) => own(f) && f.isAwaited()))
        awaits = true;
      const inside = (target: Node | undefined): boolean =>
        target?.getAncestors().some((a) => a.compilerNode === part.compilerNode) === true;
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
      const edits: { from: number; to: number; text: string }[] = [];
      for (const r of returns) {
        if (r.getStart() < start || r.getEnd() > end) continue;
        const expr = r.getExpression();
        const value = expr === undefined ? "undefined" : `(${expr.getText()})`;
        edits.push({ from: r.getStart(), to: r.getEnd(), text: `return [1, ${value}];` });
      }
      // `var x = v` inside is the assignment `x = v` of the function's x, declared before the call.
      for (const list of block.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
        if (isInsideNestedFunction(list, block) || list.getDeclarationKind() !== "var") continue;
        const statement = list.getParent();
        const inFor = Node.isForStatement(statement);
        const target = inFor ? list : (statement as Node);
        if (edits.some((e) => e.from <= target.getStart() && target.getEnd() <= e.to)) continue;
        const assigned = list
          .getDeclarations()
          .filter((d) => d.getInitializer() !== undefined)
          .map((d) => `${d.getName()} = (${d.getInitializer()?.getText()})`)
          .join(", ");
        edits.push({
          from: target.getStart(),
          to: target.getEnd(),
          text: inFor ? assigned : `${assigned};`,
        });
      }
      edits.sort((a, b) => b.from - a.from);
      let text = full.slice(start, end);
      for (const e of edits)
        text = `${text.slice(0, e.from - start)}${e.text}${text.slice(e.to - start)}`;
      return completes ? `${text}\nreturn [0];` : text;
    };
    const n = this.tryCount++;
    const tmp = `$try${n}`;
    // A block that awaits is an async closure, and the call is of the async primitive, awaited.
    const a = awaits ? "async " : "";
    const body = `${a}() => {\n${rewrite(t.getTryBlock())}\n}`;
    const caught =
      handler !== undefined
        ? `${a}(${handler.getVariableDeclaration()?.getText() ?? ""}) => {\n${rewrite(handler.getBlock())}\n}`
        : "undefined";
    const last = finalizer !== undefined ? `, ${a}() => {\n${rewrite(finalizer)}\n}` : "";
    const call = awaits
      ? `(await ${ASYNC_TRY_PRIMITIVE}(${body}, ${caught}${last}))`
      : `${TRY_PRIMITIVE}(${body}, ${caught}${last})`;
    const source = completes
      ? `${a}function __try() {\n{\nconst ${tmp} = ${call};\nif (${tmp}[0] === 1) return ${tmp}[1];\n}\n}`
      : `${a}function __try() {\n${call};\n}`;
    // The function's own names declared in the blocks are bound before the call, as JavaScript
    // hoists them; the closures assign them, so they are cells.
    for (const name of vars) {
      if (this.env.has(name)) continue;
      const start = this.undefinedValue();
      // A block's closure assigns it, so it is a cell, a var in a loop inside the block included.
      this.cells.add(name);
      const [cell] = this.emit("op", [start], 1, {
        origin: { kind: "ObjectLiteral", text: truncate(name) },
        label: 'object:["value"]',
      });
      this.env.set(name, cell as ValueId);
    }
    const file = t
      .getSourceFile()
      .getProject()
      .createSourceFile(`__try${n}_${t.getStart()}.ts`, source, { overwrite: true });
    return file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
  }

  /**
   * Any switch, as one pass of a loop (#1276): the index of the clause to start at (the first case
   * that matches, tested lazily in order, else the default's, else past the end), then each clause
   * in order under `if ($at <= i)`, so a clause falls into the next, and a break leaves the pass.
   * Undefined for a continue inside (it would continue the pass) and for a name a clause declares
   * and another clause reads (the clauses share one scope).
   */
  private lowerSwitchAsPass(sw: import("ts-morph").SwitchStatement): Node | undefined {
    const clauses = sw.getCaseBlock().getClauses();
    const own = (n: Node): boolean => !isInsideNestedFunction(n, sw);
    if (sw.getDescendantsOfKind(SyntaxKind.ContinueStatement).some(own)) return undefined;
    if (
      sw
        .getDescendantsOfKind(SyntaxKind.BreakStatement)
        .some((b) => b.getLabel() !== undefined && own(b))
    )
      return undefined;
    for (const clause of clauses) {
      const declared = clause
        .getStatements()
        .flatMap((st) =>
          Node.isVariableStatement(st)
            ? st.getDeclarations().flatMap((d) => patternNames(d.getNameNode()))
            : Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)
              ? [st.getName() ?? ""]
              : [],
        );
      const elsewhere = clauses
        .filter((c) => c !== clause)
        .flatMap((c) => c.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
      if (declared.some((name) => elsewhere.includes(name))) return undefined;
    }
    const n = this.switchCount++;
    const tmp = `$switch${n}`;
    const at = `$at${n}`;
    const end = clauses.length;
    const fallback = clauses.findIndex((c) => Node.isDefaultClause(c));
    let chain = String(fallback === -1 ? end : fallback);
    for (let i = clauses.length - 1; i >= 0; i--) {
      const c = clauses[i] as Node;
      if (Node.isCaseClause(c))
        chain = `${tmp} === (${c.getExpression().getText()}) ? ${i} : ${chain}`;
    }
    const bodies = clauses
      .map(
        (c, i) =>
          `if (${at} <= ${i}) {\n${c
            .getStatements()
            .map((st) => st.getText())
            .join("\n")}\n}`,
      )
      .join("\n");
    const source = `function __switch() {\n{\nconst ${tmp} = (${sw.getExpression().getText()});\nconst ${at} = ${chain};\ndo {\n${bodies}\n} while (false);\n}\n}`;
    const file = sw
      .getSourceFile()
      .getProject()
      .createSourceFile(`__switchpass${n}_${sw.getStart()}.ts`, source, { overwrite: true });
    return file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
  }

  /** Whether an `if` that exits on some paths can take `tail` onto its sides. */
  private canTakeTail(stmt: import("ts-morph").IfStatement, tail: readonly Node[]): boolean {
    if (this.exitMode !== "function" || !containsExitOrLoopReturn(stmt)) return false;
    // A function declaration in the tail binds on each side: hoisted there when what it reads is
    // bound, at its place otherwise.
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
    if (!containsExitOrLoopReturn(block)) return false;
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
  /**
   * Whether lifting a node makes a heap operation: by its syntax, or by a name it reads or writes
   * that is a cell or a binding outside the atom, whose reads and writes are heap operations.
   */
  private touchesHeap(node: Node): boolean {
    if (touchesHeap(node)) return true;
    return [node, ...node.getDescendantsOfKind(SyntaxKind.Identifier)].some(
      (id) =>
        Node.isIdentifier(id) &&
        (this.bindings.has(id.getText()) ||
          (this.cells.has(id.getText()) && this.env.has(id.getText()))),
    );
  }

  /**
   * Whether an expression only produces a value: inert syntax (isInert) that reads no cell and no
   * binding outside the atom, whose reads are heap operations.
   */
  private inert(node: Node): boolean {
    if (!isInert(node)) return false;
    return ![node, ...node.getDescendantsOfKind(SyntaxKind.Identifier)].some(
      (id) =>
        Node.isIdentifier(id) &&
        isValueRead(id) &&
        (this.bindings.has(id.getText()) ||
          (this.cells.has(id.getText()) && this.env.has(id.getText()))),
    );
  }

  /** The return flags of the guards the statement being lifted is under. */
  private readonly guardFlags: ValueId[] = [];

  private guardTail(rest: readonly Node[]): void {
    const flag = this.env.get(RETURN_DONE) as ValueId;
    // No path has returned yet (an exit so far was a throw), or an enclosing guard already tests
    // this flag (no return since): the rest runs unguarded.
    if (
      this.guardFlags.includes(flag) ||
      this.nodes.some(
        (n) => n.kind === "literal-source" && n.outputs[0] === flag && n.label === "false",
      )
    ) {
      this.liftStatements(rest);
      return;
    }
    const before = new Map(this.env);
    const id = `b${this.branchCount++}`;
    const within = this.regionStack.length > 0 ? this.regionStack.join("/") : undefined;
    this.branches.push({ id, cond: flag, ...(within !== undefined ? { within } : {}) });
    this.guardFlags.push(flag);
    const elseEnv = this.inRegion(`${id}.e`, () =>
      this.inReturnFrame(undefined, () => this.branch(before, () => this.liftStatements(rest))),
    );
    this.guardFlags.pop();
    for (const [name, beforeValue] of before) {
      const elseValue = elseEnv.get(name) ?? beforeValue;
      if (elseValue !== beforeValue) {
        const [joined] = this.emit("sel", [flag, beforeValue, elseValue], 1, {
          origin: { kind: "ExitGuard", text: name },
        });
        this.env.set(name, joined as ValueId);
      }
    }
    // A fragment's names are its results (#1297): one first declared under the guard is its value
    // where the fragment did not return, and undefined where it did.
    if (this.completing)
      for (const [name, elseValue] of elseEnv) {
        if (before.has(name) || name.startsWith("%")) continue;
        const [joined] = this.emit("sel", [flag, this.undefinedValue(), elseValue], 1, {
          origin: { kind: "ExitGuard", text: name },
        });
        this.env.set(name, joined as ValueId);
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
  private receiver: ValueId | undefined;

  /**
   * The function's receiver. A captured one (an arrow's) is a name; otherwise it is one source of
   * the graph, at its top level wherever it is first read, as a free name's source is: a read in a
   * branch and one after it are the same value.
   */
  private thisValue(): ValueId {
    if (this.env.has(THIS)) return this.resolveIdentifier(THIS);
    // A derived constructor has no receiver before its `super(..)` call.
    if (this.derived) throw new Error("this before super() in a derived constructor");
    if (this.receiver === undefined) {
      const saved = this.regionStack.splice(0);
      try {
        [this.receiver] = this.emit("op", [], 1, {
          origin: { kind: "ThisKeyword", text: "this" },
          label: "this",
        }) as [ValueId];
        this.topLevel.add(this.receiver);
      } finally {
        this.regionStack.push(...saved);
      }
    }
    return this.throughLoop(this.receiver);
  }

  private liftClosure(
    fn: FunctionLike,
    givenSelf?: string,
    classSelf?: string,
  ): ValueId | undefined {
    let selfName = givenSelf;
    const mode = functionModeOf(fn);
    // `super(..)` is a derived constructor's own statement, and nothing else uses `super` (#1276).
    const derived =
      Node.isConstructorDeclaration(fn) &&
      (fn.getParent() as import("ts-morph").ClassDeclaration).getHeritageClauses().length > 0;
    const supers = fn.getDescendantsOfKind(SyntaxKind.SuperKeyword);
    // `super(..);`, or `const v = super(..);` as the TypeScript lowering writes it.
    const superStatement = (k: Node): boolean => {
      const call = k.getParent();
      if (!Node.isCallExpression(call) || call.getExpression() !== k) return false;
      const up = call.getParent();
      const statement = Node.isVariableDeclaration(up) ? up.getParent()?.getParent() : up;
      return (
        (Node.isExpressionStatement(up) || Node.isVariableStatement(statement)) &&
        statement?.getParent()?.getParent() === fn
      );
    };
    // `super.name` (read or called) in a member of a derived class, or an arrow inside one: the
    // parent's member, with this function's receiver (#1294). A write through `super` is not.
    const superMember = (k: Node): boolean => {
      const access = k.getParent();
      if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== k) return false;
      const up = access.getParent();
      if (
        Node.isBinaryExpression(up) &&
        up.getLeft() === access &&
        /^(=|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=)$/.test(up.getOperatorToken().getText())
      )
        return false;
      if (Node.isPrefixUnaryExpression(up) || Node.isPostfixUnaryExpression(up)) {
        const op = up.getOperatorToken();
        if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) return false;
      }
      const owner = receiverOwner(k);
      if (
        !(
          Node.isMethodDeclaration(owner) ||
          Node.isGetAccessorDeclaration(owner) ||
          Node.isSetAccessorDeclaration(owner) ||
          Node.isConstructorDeclaration(owner)
        )
      )
        return false;
      const cls = owner.getParent();
      return (
        (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) &&
        cls.getHeritageClauses().some((h) => h.getToken() === SyntaxKind.ExtendsKeyword)
      );
    };
    if (supers.length > 0 && !supers.every((k) => (derived && superStatement(k)) || superMember(k)))
      return undefined;
    // `this` in an arrow is the enclosing receiver, captured like a name; in a function it is the
    // caller's receiver, so the closure is a `function` (#1276).
    const thisUses = [
      ...fn.getDescendantsOfKind(SyntaxKind.ThisKeyword),
      // `super.name` reads with the receiver: it uses `this` as much as `this.name` does.
      ...supers.filter(superMember),
    ].filter(
      (t) =>
        receiverOwner(t) === fn ||
        (Node.isArrowFunction(fn) && receiverOwner(t) === receiverOwner(fn)),
    );
    const lexicalThis = Node.isArrowFunction(fn) && thisUses.length > 0;
    // A derived constructor has its own receiver, made by its `super(..)`, used or not.
    const dynamicThis = !Node.isArrowFunction(fn) && (thisUses.length > 0 || derived);
    const locals = closureLocals(fn);
    // A member's own name (a method's, an accessor's) names it; it is not a read.
    const ownName =
      Node.isMethodDeclaration(fn) ||
      Node.isGetAccessorDeclaration(fn) ||
      Node.isSetAccessorDeclaration(fn)
        ? fn.getNameNode().compilerNode
        : undefined;
    const reads = fn
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((id) => id.compilerNode !== ownName);
    if (reads.some((id) => id.getText() === "arguments" && !locals.has("arguments")))
      return undefined;
    // A closure that rebinds a name outside itself needs a shared cell, which the graph does not
    // have. A write to a member of an outer object or of the receiver keeps the binding: it changes
    // the shared object, as a call that changes its argument does.
    // A name in a cell is shared: the closure writes the cell it captures.
    const rebindsOutside = (t: Node): boolean => {
      if (Node.isPropertyAccessExpression(t) || Node.isElementAccessExpression(t)) return false;
      const outer = (id: Node): boolean =>
        !declaredWithin(id, fn) &&
        !this.cells.has(id.getText()) &&
        !this.bindings.has(id.getText());
      if (Node.isIdentifier(t)) return outer(t);
      return t.getDescendantsOfKind(SyntaxKind.Identifier).some(outer);
    };
    if (assignmentTargets(fn).some(rebindsOutside)) return undefined;
    const outerReads: string[] = [];
    for (const id of reads) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (!declaredWithin(id, fn) && !outerReads.includes(name)) outerReads.push(name);
    }
    // A class's own name in its members is the class (`class-self`), not a capture.
    if (classSelf !== undefined) {
      const at = outerReads.indexOf(classSelf);
      if (at !== -1) outerReads.splice(at, 1);
    }
    // A function's own name inside it is the function (`function-self`), not a capture (#1276).
    // So is the name of the const it initializes directly: `const f = (n) => f(n - 1)` can only ever
    // read the function itself, as a named function expression does (#1173).
    if (selfName === undefined && !(Node.isFunctionExpression(fn) && fn.getName() !== undefined))
      selfName = constInitializedBy(fn);
    const selfOf: string | undefined =
      selfName ?? (Node.isFunctionExpression(fn) ? fn.getName() : undefined);
    if (selfName !== undefined) {
      const at = outerReads.indexOf(selfName);
      if (at !== -1) outerReads.splice(at, 1);
    }
    // A platform primitive the scope does not bind is a source of its own in the closure's graph, so
    // a lowering knows it there (`new RangeError`, `JSON.parse`). Every other name is captured: a free
    // name or an import stays one source of the atom, at its top level, where it is linked.
    const platform = (name: string): boolean =>
      !this.env.has(name) &&
      !this.imports.has(name) &&
      (this.ambient.has(name) || RUNTIME_PRIMITIVES.has(name));
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
    // A write the closure sees as it was made: before it, in its own scope, and in no loop.
    const doneBefore = (t: Node): boolean =>
      !Node.isFunctionDeclaration(fn) &&
      t.getEnd() <= fn.getStart() &&
      scopeOf(t)?.compilerNode === fnScope?.compilerNode &&
      !inLoop(fn, fnScope);
    // The closure holds the cell (or the binding), which every write changes.
    const shared = (name: string): boolean => this.cells.has(name) || this.bindings.has(name);
    const changesCapture = (t: Node): boolean => {
      // A destructuring assignment rebinds every name in it, under the same rules as a single
      // name: a shared one, or one rebound before the closure is made, does not change it (#1173).
      if (Node.isArrayLiteralExpression(t) || Node.isObjectLiteralExpression(t)) {
        return t
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some((id) => captures.includes(id.getText()) && !shared(id.getText()) && !doneBefore(t));
      }
      const base = baseIdentifierOfTarget(t);
      if (base === undefined || !captures.includes(base)) return false;
      if (!Node.isIdentifier(t)) return false;
      if (shared(base)) return false;
      return !doneBefore(t);
    };
    // Only the closure's own enclosing function can change a capture under it: an assignment in a
    // scope further out was settled there (a cell, or a value captured by the closure in between).
    const withinScope = (t: Node): boolean =>
      fnScope === undefined ||
      t.getAncestors().some((a) => a.compilerNode === fnScope.compilerNode);
    if (outside.filter(withinScope).some(changesCapture)) return undefined;

    let graph: DucGraph;
    try {
      const inner = new Lifter(this.ambient);
      for (const [name, binding] of this.imports) inner.imports.set(name, binding);
      // A member reads its class as `class-self`; a closure inside it captures that value.
      inner.classSelf = classSelf;
      inner.functionSelf = selfOf;
      inner.derived = derived;
      for (const name of captures) if (this.bindings.has(name)) inner.bindings.add(name);
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
        : this.bindings.has(name)
          ? this.throughLoop(this.resolveName(name))
          : this.cells.has(name) && this.env.has(name)
            ? this.throughLoop(this.env.get(name) as ValueId)
            : this.resolveIdentifier(name),
    );
    const [value] = this.emit("op", inputs, 1, {
      origin: { kind: "Closure", text: truncate(selfName ?? fn.getText()) },
      label: closureLabel(dynamicThis, mode),
    });
    (this.nodes[this.nodes.length - 1] as MutableNode).closure = graph;
    return value as ValueId;
  }

  /**
   * Makes a later-declared `var` a cell from here, holding undefined until its declaration writes
   * it (#1173), so a closure made before the declaration reads the value it has when it runs.
   */
  private hoistCell(name: string): void {
    if (this.hoistedCells.has(name)) return;
    if (this.env.has(name) && !this.cells.has(name)) return;
    this.cells.add(name);
    this.hoistedCells.add(name);
    const [cell] = this.emit("op", [this.undefinedValue()], 1, {
      origin: { kind: "ObjectLiteral", text: truncate(name) },
      label: 'object:["value"]',
    });
    this.env.set(name, cell as ValueId);
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
      const value =
        this.liftClass(node) ??
        (this.emit("op", this.collectReads(node, new Set([name])), 1, {
          origin: { kind: "Class", text: truncate(name) },
          label: this.opaqueLabel("Class", node, new Set([name])),
        })[0] as ValueId);
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
    // An empty statement computes nothing.
    if (Node.isEmptyStatement(node)) return;
    // `export default x` (and `export = x`) exports one value: the module's name `default`
    // (#1276, #1292), declared with the others.
    if (Node.isExportAssignment(node)) {
      this.env.set("default", this.liftExpr(node.getExpression()));
      return;
    }
    // A local export list computes nothing: the names it exports are observed (exportedBindingNames).
    // A re-export (`export { a } from "m"`) computes nothing here either: its values are m's.
    if (Node.isExportDeclaration(node)) return;
    // TypeScript's types compute nothing: a type alias, an interface, an ambient `declare`, an
    // overload signature (#1297). Their names are types, never values the graph reads.
    if (
      Node.isTypeAliasDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      (Node.isFunctionDeclaration(node) && !node.hasBody()) ||
      ((Node.isVariableStatement(node) ||
        Node.isClassDeclaration(node) ||
        Node.isModuleDeclaration(node) ||
        Node.isEnumDeclaration(node)) &&
        node.hasDeclareKeyword())
    )
      return;
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
      // A side that throws on every path returns nothing: the other side's return is the return,
      // when it is visible after the if (made before it, or a constant); otherwise a select keeps it.
      if (thenDead !== elseDead) {
        const live = thenDead ? elseValue : thenValue;
        const constant = this.nodes.some(
          (n) => n.kind === "literal-source" && n.outputs[0] === live,
        );
        if (valueIndex(live) < sidesStart || constant) {
          this.reportReturn(live);
          return;
        }
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
      // before the if (or is a constant), it is the value; otherwise the join takes `undefined` on the
      // dead side, never read: the value the name had before the if depends on how the source named
      // its values, and the TypeScript lowering names them differently (#1316).
      // The heap token keeps the throwing side's: what follows waits for the branch (#1285).
      if (thenDead !== elseDead && name !== HEAP) {
        const live = thenDead ? elseValue : thenValue;
        const constant = this.nodes.some(
          (n) => n.kind === "literal-source" && n.outputs[0] === live,
        );
        if (valueIndex(live) < sidesStart || constant) {
          this.env.set(name, live);
          continue;
        }
        const dead = this.undefinedValue();
        const [joined] = this.emit(
          "sel",
          [condValue, thenDead ? dead : live, thenDead ? live : dead],
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
    // A lowering writes a condition it cannot put in the header as `while (true) { ..; if (!(c))
    // break; .. }`: it is that loop's condition, computed at the top of its body (#1276).
    const guard = whileGuard(node);
    if (
      guard !== undefined &&
      [guard.cond, ...guard.prefix].every((n) => this.collectAssignedOuterNames(n).length === 0)
    )
      return this.liftLoopBody(node, [], guard);
    // A condition that assigns is tested in the body, so its last assignment outlives the loop.
    const tested = this.testedInBody(node);
    if (tested !== undefined) return this.liftLoop(tested);
    if (hasJump(node)) {
      // A loop that only breaks and continues lifts here; one that returns needs the rest of the
      // function, and lifts from liftStatements.
      if (loopReturns(node) || !jumpsSupported(node)) return false;
      return this.liftLoopWithExits(node) !== undefined;
    }
    return this.liftLoopBody(node);
  }

  private testedCount = 0;

  /**
   * A loop whose condition assigns a name, as one that tests it in its body (#1276):
   * `while (C) B` is `while (true) { if (!(C)) break; B }`, `for (i; C; u) B` is
   * `for (i; ; u) { if (!(C)) break; B }`, and `do B while (C)` is `do { B; if (!(C)) break; }
   * while (true)`. The loop's results are its carried values when it stops, and a test in the body
   * carries what the condition assigned on its last run. Undefined for any other loop, and for a do
   * loop whose body continues (a continue there would skip the test).
   */
  private testedInBody(
    node:
      | import("ts-morph").WhileStatement
      | import("ts-morph").ForStatement
      | import("ts-morph").DoStatement,
  ):
    | import("ts-morph").WhileStatement
    | import("ts-morph").ForStatement
    | import("ts-morph").DoStatement
    | undefined {
    const cond = Node.isForStatement(node) ? node.getCondition() : node.getExpression();
    if (cond === undefined || cond.getKind() === SyntaxKind.TrueKeyword) return undefined;
    if (this.collectAssignedOuterNames(cond).length === 0) return undefined;
    const body = node.getStatement();
    const inner = Node.isBlock(body)
      ? body
          .getStatements()
          .map((st) => st.getText())
          .join("\n")
      : body.getText();
    const test = `if (!(${cond.getText()})) break;`;
    let text: string;
    if (Node.isWhileStatement(node)) text = `while (true) {\n${test}\n${inner}\n}`;
    else if (Node.isForStatement(node)) {
      const init = node.getInitializer()?.getText() ?? "";
      const update = node.getIncrementor()?.getText() ?? "";
      text = `for (${init}; ; ${update}) {\n${test}\n${inner}\n}`;
    } else {
      if (loopJumpsOf(node).some((j) => Node.isContinueStatement(j))) return undefined;
      text = `do {\n${inner}\n${test}\n} while (true);`;
    }
    const n = this.testedCount++;
    const file = node
      .getSourceFile()
      .getProject()
      .createSourceFile(`__tested${n}_${node.getStart()}.ts`, `function __tested() {\n${text}\n}`, {
        overwrite: true,
      });
    const loop = file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
    return loop !== undefined &&
      (Node.isWhileStatement(loop) || Node.isForStatement(loop) || Node.isDoStatement(loop))
      ? loop
      : undefined;
  }

  /**
   * A while or for loop with breaks, continues and returns that belong to it. Its exits are carried
   * flags: the loop continues while none is set, a for's incrementor runs only when none is, and
   * the returned value is carried too. Returns the loop's results for the return flag and value.
   */
  private liftLoopWithExits(node: Node): { ret: ValueId; retv: ValueId } | undefined {
    const iterating =
      (Node.isForOfStatement(node) || Node.isForInStatement(node)) && iterateLiftable(node);
    if (
      !(
        iterating ||
        Node.isWhileStatement(node) ||
        Node.isForStatement(node) ||
        Node.isDoStatement(node)
      ) ||
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
      const names = [exits.brk, exits.ret, exits.retv].filter((n): n is string => n !== undefined);
      if (iterating)
        this.liftIterateBody(
          node as import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement,
          names,
        );
      else this.liftLoopBody(node, names);
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
    guard?: WhileGuard,
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
    const cond =
      guard !== undefined
        ? guard.cond
        : Node.isForStatement(node)
          ? node.getCondition()
          : node.getExpression();
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
      ...([cond, body, incrementor].some((part) => part !== undefined && this.touchesHeap(part))
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
        // A guarded loop's condition needs the statements before its test.
        if (guard !== undefined) this.liftStatements(guard.prefix);
        // The written condition: a do loop's first pass does not test it (`first || cond`, lazily).
        const condInert = cond === undefined || this.inert(cond);
        const liftCond = (): ValueId => {
          const c = cond as Node;
          if (firstName === undefined) return this.liftExpr(c);
          const first = this.env.get(firstName) as ValueId;
          if (this.inert(c)) {
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
        if (guard !== undefined) this.liftStatements(guard.rest, []);
        else if (Node.isBlock(body)) this.liftStatements(body.getStatements(), []);
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
    if (!iterateLiftable(node)) return false;
    // A lowering writes an iterating loop's condition as a leading `if (!(c)) break;`: it is that.
    const guard = iterateGuard(node);
    if (guard !== undefined) return this.liftIterateBody(node, [], guard);
    if (hasJump(node)) {
      // A loop that returns needs the rest of the function, and lifts from liftStatements.
      if (loopReturns(node) || !jumpsSupported(node)) return false;
      return this.liftLoopWithExits(node) !== undefined;
    }
    return this.liftIterateBody(node, []);
  }

  /**
   * The body of an iterating loop, with the exit flags `exitNames` carried (#1276): the loop goes on
   * while none is set, its condition, tested before the body. `guard` is a written condition.
   */
  private liftIterateBody(
    node: import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement,
    exitNames: readonly string[],
    guard?: Node,
  ): boolean {
    const initializer = node.getInitializer();
    // `for (x in o)` with an existing x: each element is assigned to x, which the loop carries.
    const existing = Node.isIdentifier(initializer) ? initializer : undefined;
    const list = existing ? undefined : (initializer as import("ts-morph").VariableDeclarationList);
    const decl = list?.getDeclarations()[0];
    const declared = decl !== undefined ? patternNames(decl.getNameNode()) : [];
    const of: "values" | "keys" = Node.isForOfStatement(node) ? "values" : "keys";
    const body = node.getStatement();

    const iterable = this.liftExpr(node.getExpression());
    // Each step reads the iterable, so an iterating loop always carries the heap token, last.
    const assigned = this.collectAssignedOuterNames(body).filter(
      (name) => this.env.has(name) && !declared.includes(name),
    );
    if (
      existing !== undefined &&
      this.env.has(existing.getText()) &&
      !this.cells.has(existing.getText()) &&
      !assigned.includes(existing.getText())
    )
      assigned.unshift(existing.getText());
    const carried = [...assigned, ...exitNames, HEAP];
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
        [element] = this.emit("carry-source", [], 1, {
          label: "element",
          origin: {
            kind: "LoopElement",
            text: truncate((decl?.getNameNode() ?? existing)?.getText() ?? ""),
          },
        }) as [ValueId];
        // The condition is tested first: none of the exits is set (or the written guard holds).
        const flags = exitNames
          .filter((n) => !n.startsWith("%returnValue"))
          .map((n) => this.env.get(n) as ValueId);
        if (guard !== undefined) condition = this.liftExpr(guard);
        else if (flags.length > 0) {
          const stop = flags.slice(1).reduce(
            (acc, f) =>
              this.emit("op", [acc, f], 1, {
                origin: { kind: "Binary", text: "||" },
                label: "||",
              })[0] as ValueId,
            flags[0] as ValueId,
          );
          condition = this.emit("op", [stop], 1, {
            origin: { kind: "PrefixUnaryExpression" },
            label: "!",
          })[0] as ValueId;
        }
        if (decl !== undefined) this.bindPattern(decl.getNameNode(), element);
        else if (existing !== undefined) this.assignTo(existing, element as ValueId);
        try {
          const statements = Node.isBlock(body) ? body.getStatements() : [body];
          this.liftStatements(guard !== undefined ? statements.slice(1) : statements, []);
        } finally {
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
      ...(condition !== undefined ? { cond: condition } : {}),
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
      // A cell made ahead of the declaration, for a hoisted function: the declaration writes it.
      if (this.hoistedCells.has(name) && this.env.has(name)) {
        this.writeCell(name, value);
        return;
      }
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
    if (this.inert(init)) {
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
      // A cell is one object for the whole scope: writing it rebinds nothing (#1276).
      // So is a binding outside the atom: a write changes the binding, not a value carried here.
      if (
        base !== undefined &&
        this.env.has(base) &&
        !this.cells.has(base) &&
        !this.bindings.has(base)
      )
        names.add(base);
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
    // `new.target` and `import.meta` are what the platform gives the call or the module, read like
    // a platform primitive by their text (#1173).
    if (Node.isMetaProperty(node)) return this.resolveName(node.getText());
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
      // `x++` and `x--` are worth the value before the step, as a number (#1276).
      const parent = node.getParent();
      const valueUsed =
        Node.isPostfixUnaryExpression(node) &&
        !Node.isExpressionStatement(parent) &&
        !(Node.isForStatement(parent) && parent.getIncrementor() === node);
      const before = valueUsed
        ? (this.emit("op", [value], 1, {
            origin: { kind: "PrefixUnaryExpression" },
            label: "+",
          })[0] as ValueId)
        : undefined;
      const [out] = this.emit("op", [value], 1, {
        origin: { kind: node.getKindName() },
        label: Node.isPrefixUnaryExpression(node) ? token : `post${token}`,
      });
      // ++/-- on a bound identifier reassigns it. No other unary operator does: `-x` leaves x as it is.
      const steps = token === "++" || token === "--";
      if (steps && Node.isIdentifier(operand) && this.isBinding(operand.getText()))
        this.writeBinding(operand.getText(), out as ValueId);
      else if (steps && Node.isIdentifier(operand) && this.env.has(operand.getText())) {
        if (this.cells.has(operand.getText())) this.writeCell(operand.getText(), out as ValueId);
        else this.env.set(operand.getText(), out as ValueId);
      }
      return before ?? (out as ValueId);
    }
    if (Node.isConditionalExpression(node)) {
      const cond = this.liftExpr(node.getCondition());
      // An arm that could do more than produce a value runs only when it is chosen: a branch.
      if (!this.inert(node.getWhenTrue()) || !this.inert(node.getWhenFalse())) {
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
    if (Node.isCallExpression(node) && Node.isSuperExpression(node.getExpression())) {
      // `super(args)` in a derived constructor (#1276): it makes the receiver, so it is `this` after.
      const [made] = this.emit("op", this.liftElements(node.getArguments() as Node[]), 1, {
        origin: { kind: "SuperCall", text: truncate(node.getText()) },
        label: "super",
        heap: true,
      });
      this.env.set(THIS, made as ValueId);
      return made as ValueId;
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      const inputs: ValueId[] = [];
      const callee = node.getExpression();
      if (callee !== undefined && Node.isPropertyAccessExpression(callee)) {
        // A method's lookup is ordered just before its call, after the arguments (#1285): a
        // lowering writes `o.f(args)`, the lookup inside the call, so that is the order it keeps.
        // `super.f(args)` is the parent's f, called with this function's receiver (#1294).
        const viaSuper = Node.isSuperExpression(callee.getExpression());
        const base = viaSuper ? this.thisValue() : this.liftExpr(callee.getExpression());
        const args = this.liftElements(node.getArguments() as Node[]);
        const [method] = this.emit("op", [base], 1, {
          origin: { kind: "PropertyAccess", text: truncate(callee.getText()) },
          label: viaSuper
            ? `super.${callee.getName()}`
            : `${callee.hasQuestionDotToken() ? "?." : "."}${callee.getName()}`,
        });
        inputs.push(method as ValueId, ...args);
      } else if (callee !== undefined && Node.isElementAccessExpression(callee)) {
        // So is a method looked up by a key, `o[k](args)`: the object and the key first, then the
        // arguments, then the lookup.
        const base = this.liftExpr(callee.getExpression());
        const key = this.liftExpr(callee.getArgumentExpressionOrThrow());
        const args = this.liftElements(node.getArguments() as Node[]);
        const [method] = this.emit("op", [base, key], 1, {
          origin: { kind: "ElementAccess" },
          ...(callee.hasQuestionDotToken() ? { label: "ElementAccess?." } : {}),
        });
        inputs.push(method as ValueId, ...args);
      } else if (
        callee !== undefined &&
        Node.isIdentifier(callee) &&
        this.cells.has(callee.getText()) &&
        this.env.has(callee.getText())
      ) {
        // A call through a cell is `(0, cell.value)(args)`: the function, with no receiver (#1276).
        const read = this.resolveIdentifier(callee.getText());
        const [zero] = this.emit("literal-source", [], 1, {
          origin: { kind: "NumericLiteral", text: "0" },
          label: "0",
        });
        const [fn] = this.emit("op", [zero as ValueId, read], 1, {
          origin: { kind: "Binary", text: "," },
          label: ",",
        });
        inputs.push(fn as ValueId, ...this.liftElements(node.getArguments() as Node[]));
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
    if (Node.isPropertyAccessExpression(node) && Node.isSuperExpression(node.getExpression())) {
      // `super.a`: the parent's member a, read with this function's receiver (#1294).
      return this.emit("op", [this.thisValue()], 1, {
        origin: { kind: "PropertyAccess", text: truncate(node.getText()) },
        label: `super.${node.getName()}`,
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
      // The literal parts are structure; the expressions between them are the inputs. A part is its
      // value (cooked), as a string literal's label is: `\x61` and `a` are one part (#1303).
      const parts = [
        cookedTextOf(node.getHead()),
        ...node.getTemplateSpans().map((span) => cookedTextOf(span.getLiteral())),
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
      // A tag sees each part's value and its raw text (`strings.raw`): the label carries both, the
      // value null where an escape has none (#1303).
      const both = (part: Node): [string | null, string] => [
        hasInvalidEscape(part) ? null : cookedTextOf(part),
        rawTextOf(part),
      ];
      let parts: [string | null, string][];
      if (Node.isTemplateExpression(template)) {
        parts = [
          both(template.getHead()),
          ...template.getTemplateSpans().map((span) => both(span.getLiteral())),
        ];
        for (const span of template.getTemplateSpans())
          inputs.push(this.liftExpr(span.getExpression()));
      } else {
        parts = [both(template)];
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
      const delegates = Node.isYieldExpression(node) && node.getAsteriskToken() !== undefined;
      return this.emit("op", inputs, 1, {
        origin: { kind: node.getKindName() },
        label: delegates ? "YieldExpression*" : node.getKindName(),
      })[0] as ValueId;
    }
    if (Node.isClassExpression(node)) {
      const lifted = this.liftClass(node);
      if (lifted !== undefined) return lifted;
    }
    // `delete o.p` and `delete o[k]`: a heap operation on the object; its value is delete's result.
    if (Node.isDeleteExpression(node)) {
      const target = node.getExpression();
      if (Node.isPropertyAccessExpression(target) && !target.hasQuestionDotToken())
        return this.emit("op", [this.liftExpr(target.getExpression())], 1, {
          origin: { kind: "DeleteExpression", text: truncate(node.getText()) },
          label: `delete.${target.getName()}`,
        })[0] as ValueId;
      if (Node.isElementAccessExpression(target) && !target.hasQuestionDotToken())
        return this.emit(
          "op",
          [
            this.liftExpr(target.getExpression()),
            this.liftExpr(target.getArgumentExpressionOrThrow()),
          ],
          1,
          {
            origin: { kind: "DeleteExpression", text: truncate(node.getText()) },
            label: "delete[]",
          },
        )[0] as ValueId;
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
        // A method or an accessor is a closure, its entry `{method|get|set: key}` (#1276); one that
        // is not a closure is opaque, its entry named by its syntax.
        const member = prop as import("ts-morph").MethodDeclaration;
        const key = keyOf(member.getNameNode());
        const lifted =
          Node.isMethodDeclaration(prop) ||
          Node.isGetAccessorDeclaration(prop) ||
          Node.isSetAccessorDeclaration(prop)
            ? this.liftClosure(prop)
            : undefined;
        if (lifted !== undefined) {
          const kind = Node.isMethodDeclaration(prop)
            ? "method"
            : Node.isGetAccessorDeclaration(prop)
              ? "get"
              : "set";
          entries.push({ [kind]: key });
          inputs.push(lifted);
          continue;
        }
        entries.push({ [prop.getKindName()]: key });
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
      !this.inert(right)
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
    if (Node.isIdentifier(lhs) && this.isBinding(lhs.getText())) {
      this.writeBinding(lhs.getText(), value);
      return;
    }
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
      // The base name is the written object after the write, unless it is a cell, which holds it.
      if (
        Node.isIdentifier(base) &&
        this.env.has(base.getText()) &&
        !this.cells.has(base.getText())
      ) {
        this.env.set(base.getText(), mutated as ValueId);
      }
      return;
    }
    // A destructuring assignment reads each member as a declaration's pattern does (#1276).
    if (Node.isObjectLiteralExpression(lhs) || Node.isArrayLiteralExpression(lhs)) {
      this.assignPattern(lhs, value);
      return;
    }
    if (Node.isParenthesizedExpression(lhs)) {
      this.assignTo(lhs.getExpression(), value);
      return;
    }
    // Another lvalue: conservatively rebind every bound name inside.
    for (const name of patternNames(lhs)) {
      if (this.isBinding(name)) this.writeBinding(name, value);
      else if (this.cells.has(name) && this.env.has(name)) this.writeCell(name, value);
      else if (this.env.has(name)) this.env.set(name, value);
    }
  }

  /**
   * `{ a, b: [c], d = e, ...rest } = v` and `[a, , b = e, ...rest] = v`: each target is assigned the
   * member it names, read as bindPattern reads a declaration's, its default applied when undefined.
   */
  private assignPattern(
    lhs: import("ts-morph").ObjectLiteralExpression | import("ts-morph").ArrayLiteralExpression,
    value: ValueId,
  ): void {
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
    // A target with `= default` is the target, its member defaulted.
    const assign = (target: Node, member: ValueId): void => {
      if (
        Node.isBinaryExpression(target) &&
        target.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      ) {
        this.assignTo(target.getLeft(), this.withDefault(member, target.getRight()));
        return;
      }
      this.assignTo(target, member);
    };
    if (Node.isObjectLiteralExpression(lhs)) {
      const taken: string[] = [];
      for (const prop of lhs.getProperties()) {
        if (Node.isSpreadAssignment(prop)) {
          assign(
            prop.getExpression(),
            read(`ObjectRest:${JSON.stringify(taken)}`, [value], prop.getText()),
          );
          continue;
        }
        if (Node.isShorthandPropertyAssignment(prop)) {
          const name = prop.getName();
          taken.push(name);
          const member = read(`.${name}`, [value], prop.getText());
          const init = prop.getObjectAssignmentInitializer();
          this.assignTo(
            prop.getNameNode(),
            init !== undefined ? this.withDefault(member, init) : member,
          );
          continue;
        }
        if (!Node.isPropertyAssignment(prop))
          throw new Error("a destructuring target with a method");
        const key = prop.getNameNode();
        let member: ValueId;
        if (Node.isComputedPropertyName(key)) {
          member = read(
            "ElementAccess",
            [value, this.liftExpr(key.getExpression())],
            prop.getText(),
          );
        } else {
          const name =
            Node.isStringLiteral(key) || Node.isNumericLiteral(key)
              ? key.getLiteralText()
              : key.getText();
          taken.push(name);
          member = /^[A-Za-z_$][\w$]*$/.test(name)
            ? read(`.${name}`, [value], prop.getText())
            : read("ElementAccess", [value, literal(JSON.stringify(name))], prop.getText());
        }
        assign(prop.getInitializerOrThrow(), member);
      }
      return;
    }
    for (const [i, el] of lhs.getElements().entries()) {
      if (Node.isOmittedExpression(el)) continue;
      if (Node.isSpreadElement(el)) {
        const slice = read(".slice", [value], el.getText());
        assign(
          el.getExpression(),
          read("CallExpression", [slice, literal(String(i))], el.getText()),
        );
        continue;
      }
      assign(el, read("ElementAccess", [value, literal(String(i))], el.getText()));
    }
  }

  /** Resolve an identifier read to a value: bound name, import, ambient, or free. */
  private resolveIdentifier(name: string): ValueId {
    if (this.isBinding(name))
      return this.emit("op", [this.throughLoop(this.resolveName(name))], 1, {
        origin: { kind: "Identifier", text: truncate(name) },
        label: "binding",
        heap: true,
      })[0] as ValueId;
    const bound = this.throughLoop(this.resolveName(name));
    if (!this.cells.has(name) || !this.env.has(name)) return bound;
    return this.emit("op", [bound], 1, {
      origin: { kind: "PropertyAccess", text: truncate(name) },
      label: ".value",
    })[0] as ValueId;
  }

  /** Whether a name is a binding outside the atom that it writes (its value is the binding). */
  private isBinding(name: string): boolean {
    return this.bindings.has(name);
  }

  /** Writes a binding outside the atom: `name = value`, a heap operation. */
  private writeBinding(name: string, value: ValueId): void {
    this.emit("op", [this.throughLoop(this.resolveName(name)), value], 1, {
      origin: { kind: "Write", text: truncate(name) },
      label: "binding=",
      heap: true,
    });
  }

  /**
   * Writes a cell's value. The cell stays the name's value: it is one object, shared with the
   * closures that hold it, and heap order puts every later read after the write.
   */
  private writeCell(name: string, value: ValueId): void {
    const cell = this.throughLoop(this.env.get(name) as ValueId);
    this.emit("op", [cell, value], 1, {
      origin: { kind: "Write", text: truncate(name) },
      label: ".value=",
    });
  }

  private resolveName(name: string): ValueId {
    const bound = this.env.get(name);
    if (bound !== undefined) return bound;
    if (name === this.functionSelf && name !== undefined) {
      // The function itself, one source per graph, at its top level.
      if (this.functionSelfValue === undefined) {
        const saved = this.regionStack.splice(0);
        try {
          [this.functionSelfValue] = this.emit("op", [], 1, {
            origin: { kind: "FunctionSelf", text: truncate(name) },
            label: "function-self",
          }) as [ValueId];
        } finally {
          this.regionStack.push(...saved);
        }
      }
      return this.functionSelfValue;
    }
    if (name === this.classSelf) {
      // The class itself, one source per graph, at its top level.
      if (this.classSelfValue === undefined) {
        const saved = this.regionStack.splice(0);
        try {
          [this.classSelfValue] = this.emit("op", [], 1, {
            origin: { kind: "ClassSelf", text: truncate(name) },
            label: "class-self",
          }) as [ValueId];
        } finally {
          this.regionStack.push(...saved);
        }
      }
      return this.classSelfValue;
    }

    const existingDiamond = this.diamonds.get(name);
    if (existingDiamond !== undefined) return existingDiamond;

    const imported = this.imports.get(name);
    const reason: DiamondReason =
      imported !== undefined
        ? "unlinked-reference"
        : this.ambient.has(name) || RUNTIME_PRIMITIVES.has(name)
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
    const graph = canonicalizeGraph(nodes, dedupe(this.obs), this.branches);
    return this.mode !== undefined ? { ...graph, mode: this.mode } : graph;
  }
}

// ---------------------------------------------------------------------------
// ts-morph helpers
// ---------------------------------------------------------------------------

/** The names bound inside a closure: its declarations, parameters, inner functions and classes, and its own name. */
/**
 * Whether the name an identifier reads is declared between it and `fn`, `fn` included: by a
 * function's parameters, own name or `var`s, a block's or a case block's declarations, a loop's
 * header or a catch clause. A name declared only in a nested function elsewhere is not.
 */
function declaredWithin(id: Node, fn: Node): boolean {
  const name = id.getText();
  for (let p: Node | undefined = id.getParent(); p !== undefined; p = p.getParent()) {
    if (scopeNames(p).has(name)) return true;
    if (p.compilerNode === fn.compilerNode) return false;
  }
  return false;
}

/** Whether a scope strictly inside `top` (not `top` itself) declares the name `id` reads. */
function declaredBelow(id: Node, top: Node): boolean {
  const name = id.getText();
  for (let p: Node | undefined = id.getParent(); p !== undefined; p = p.getParent()) {
    if (p.compilerNode === top.compilerNode) return false;
    if (scopeNames(p).has(name)) return true;
  }
  return false;
}

const scopeNamesCache = new WeakMap<object, Set<string>>();
const NO_NAMES: Set<string> = new Set();

/** The names a node declares as a scope (see declaredWithin), memoized. */
function scopeNames(scope: Node): Set<string> {
  const known = scopeNamesCache.get(scope.compilerNode);
  if (known !== undefined) return known;
  const names = new Set<string>();
  const add = (n: Node): void => {
    for (const x of patternNames(n)) names.add(x);
  };
  const statements =
    Node.isBlock(scope) || Node.isSourceFile(scope)
      ? scope.getStatements()
      : Node.isCaseBlock(scope)
        ? scope.getClauses().flatMap((c) => c.getStatements())
        : [];
  for (const st of statements) {
    if (Node.isVariableStatement(st) && st.getDeclarationKind() !== "var")
      for (const d of st.getDeclarations()) add(d.getNameNode());
    if (
      (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) &&
      st.getName() !== undefined
    )
      names.add(st.getName() as string);
  }
  if (Node.isForStatement(scope) || Node.isForOfStatement(scope) || Node.isForInStatement(scope)) {
    const init = scope.getInitializer();
    if (Node.isVariableDeclarationList(init))
      for (const d of init.getDeclarations()) add(d.getNameNode());
  }
  if (Node.isCatchClause(scope)) {
    const v = scope.getVariableDeclaration();
    if (v !== undefined) add(v.getNameNode());
  }
  if (isFunctionLikeNode(scope)) {
    const f = scope as FunctionLike;
    for (const p of f.getParameters()) add(p.getNameNode());
    if (Node.isFunctionExpression(scope) || Node.isClassExpression(scope)) {
      const own = scope.getName();
      if (own !== undefined) names.add(own);
    }
    // A `var` anywhere in the function, outside nested functions, is the function's.
    for (const list of scope.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
      if (list.getDeclarationKind() !== "var" || isInsideNestedFunction(list, scope)) continue;
      for (const d of list.getDeclarations()) add(d.getNameNode());
    }
  }
  const result = names.size > 0 ? names : NO_NAMES;
  scopeNamesCache.set(scope.compilerNode, result);
  return result;
}

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
        (Node.isBlock(d) && Node.isTryStatement(d.getParent())) ||
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
    if (!isFunctionLikeNode(fn)) {
      // A var in a try statement's block is the function's: the block's closure assigns it.
      for (const list of fn.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
        if (list.getDeclarationKind() !== "var" || isInsideNestedFunction(list, fn)) continue;
        for (const d of list.getDeclarations()) {
          for (const name of patternNames(d.getNameNode())) {
            locals.delete(name);
            if (declared.has(name)) out.add(name);
          }
        }
      }
    }
    for (const t of assignmentTargets(fn)) {
      for (const id of targetNames(t)) {
        const name = id.getText();
        if (declared.has(name) && !declaredWithin(id, fn)) out.add(name);
      }
    }
  }
  // A name a closure reads and the scope reassigns after the closure may exist is shared too: the
  // closure sees its value when it runs. A reassignment certainly done before the closure is made (in
  // the scope itself, earlier, with the closure in no loop and not hoisted) is the value it captures.
  const scopeAssignments = assignmentTargets(scope).filter((t) => !insideNested(t));
  const inLoopOf = (n: Node): boolean => {
    for (const a of n.getAncestors()) {
      if (a.compilerNode === scope.compilerNode) return false;
      if (isLoopStatement(a)) return true;
    }
    return false;
  };
  for (const fn of nested) {
    if (!isFunctionLikeNode(fn)) continue;
    const locals = closureLocals(fn);
    const reads = new Set(
      fn
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => isValueRead(id) && !declaredWithin(id, fn))
        .map((id) => id.getText()),
    );
    for (const t of scopeAssignments) {
      const before =
        !Node.isFunctionDeclaration(fn) &&
        t.getEnd() <= fn.getStart() &&
        !inLoopOf(fn) &&
        !insideNested(fn.getParent() ?? fn);
      if (before) continue;
      for (const id of targetNames(t)) {
        const name = id.getText();
        if (declared.has(name) && reads.has(name)) out.add(name);
      }
    }
  }
  return out;
}

/** The names an assignment target rebinds: itself, or those inside a destructuring; none for a member. */
function targetNames(t: Node): Node[] {
  if (Node.isIdentifier(t)) return [t];
  if (Node.isPropertyAccessExpression(t) || Node.isElementAccessExpression(t)) return [];
  return t.getDescendantsOfKind(SyntaxKind.Identifier);
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

/**
 * The names an atom assigns that it declares nowhere (#1276): bindings outside it. A name declared
 * anywhere in the atom is not one, though a shadowed declaration may be another binding.
 */
function writtenFreeNames(file: Node): string[] {
  const declared = new Set<string>();
  for (const d of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration))
    for (const name of patternNames(d.getNameNode())) declared.add(name);
  for (const p of file.getDescendantsOfKind(SyntaxKind.Parameter))
    for (const name of patternNames(p.getNameNode())) declared.add(name);
  for (const kind of [
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.ClassExpression,
  ]) {
    for (const d of file.getDescendantsOfKind(kind)) {
      const name = (d as import("ts-morph").FunctionDeclaration).getName();
      if (name !== undefined) declared.add(name);
    }
  }
  const written: string[] = [];
  for (const t of assignmentTargets(file)) {
    for (const name of assignedNames(t))
      if (!declared.has(name) && !written.includes(name)) written.push(name);
  }
  return written;
}

/** The names an assignment target rebinds: a name, or the names in a destructuring pattern. */
function assignedNames(t: Node): string[] {
  if (Node.isIdentifier(t)) return [t.getText()];
  if (Node.isParenthesizedExpression(t)) return assignedNames(t.getExpression());
  if (Node.isBinaryExpression(t) && t.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
    return assignedNames(t.getLeft());
  if (Node.isArrayLiteralExpression(t))
    return t
      .getElements()
      .flatMap((e) => assignedNames(Node.isSpreadElement(e) ? e.getExpression() : e));
  if (Node.isObjectLiteralExpression(t))
    return t
      .getProperties()
      .flatMap((p) =>
        Node.isShorthandPropertyAssignment(p)
          ? [p.getName()]
          : Node.isPropertyAssignment(p)
            ? assignedNames(p.getInitializerOrThrow())
            : Node.isSpreadAssignment(p)
              ? assignedNames(p.getExpression())
              : [],
      );
  return [];
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
  | import("ts-morph").FunctionExpression
  | import("ts-morph").MethodDeclaration
  | import("ts-morph").ConstructorDeclaration
  | import("ts-morph").GetAccessorDeclaration
  | import("ts-morph").SetAccessorDeclaration;

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
  // A name in a type (an annotation, a cast's type, a type argument, `implements`) is a type, never
  // a value the graph reads (#1297). An `extends` clause's expression is a value.
  for (let a: Node | undefined = parent; a !== undefined; a = a.getParent()) {
    if (Node.isTypeNode(a) && !Node.isExpressionWithTypeArguments(a)) return false;
    if (Node.isHeritageClause(a)) {
      if (a.getToken() === SyntaxKind.ImplementsKeyword) return false;
      break;
    }
    if (Node.isStatement(a) || Node.isSourceFile(a)) break;
  }
  // `new.target` and `import.meta` are one name, read as a whole (#1173): `target` is not a variable.
  if (Node.isMetaProperty(parent)) return false;
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
  // A destructuring pattern's key (`{ key: local }`) names the property, not a binding (#1297).
  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === id) return false;
  // An import attribute's key (`with { type: "json" }`) names the attribute.
  if (Node.isImportAttribute(parent) && parent.getNameNode() === id) return false;
  // A binding/declaration name is not a read.
  if (
    (Node.isVariableDeclaration(parent) ||
      Node.isParameterDeclaration(parent) ||
      Node.isBindingElement(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isClassExpression(parent) ||
      Node.isMethodDeclaration(parent) ||
      // A class member's own name (a field, an accessor) names it (#1294).
      Node.isPropertyDeclaration(parent) ||
      // An enum's name and its members' names are declared, not read (#1297).
      Node.isEnumDeclaration(parent) ||
      Node.isEnumMember(parent) ||
      Node.isPropertySignature(parent) ||
      Node.isMethodSignature(parent) ||
      Node.isGetAccessorDeclaration(parent) ||
      Node.isSetAccessorDeclaration(parent)) &&
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
  // A class member sliced out of its class, parsed in the `class __atom__` form (#1297): the atom is
  // that member's function, its receiver the instance it is called on.
  const [only0, ...more] = sourceFile.getStatements();
  if (more.length === 0 && Node.isClassDeclaration(only0) && only0.getName() === "__atom__") {
    const [member, ...others] = only0.getMembers();
    if (
      others.length === 0 &&
      (Node.isMethodDeclaration(member) ||
        Node.isConstructorDeclaration(member) ||
        Node.isGetAccessorDeclaration(member) ||
        Node.isSetAccessorDeclaration(member)) &&
      member.getBody() !== undefined
    )
      return member;
  }
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

  // A function is the atom only when nothing else at the top level runs (#1290): other statements
  // (module state, a call, an assignment) are part of the atom, and the module path lifts them all.
  const only =
    exported.length === 1
      ? exported[0]
      : exported.length === 0 && all.length === 1
        ? all[0]
        : undefined;
  if (only === undefined) return undefined;
  const own = Node.isFunctionDeclaration(only)
    ? only
    : only.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  for (const stmt of sourceFile.getStatements()) {
    if (stmt === own || !runsAtModuleLevel(stmt)) continue;
    return undefined;
  }
  return only;
}

/** Whether a top-level statement does anything when the module runs (#1290). */
function runsAtModuleLevel(stmt: Node): boolean {
  if (
    Node.isImportDeclaration(stmt) ||
    Node.isTypeAliasDeclaration(stmt) ||
    Node.isInterfaceDeclaration(stmt) ||
    Node.isEmptyStatement(stmt)
  )
    return false;
  if (Node.isExportDeclaration(stmt)) return false; // export lists and re-exports bind nothing new
  if (Node.isFunctionDeclaration(stmt) && !stmt.hasBody()) return false; // an overload signature
  // A directive ("use strict") is a string expression statement.
  if (Node.isExpressionStatement(stmt) && Node.isStringLiteral(stmt.getExpression())) return false;
  return true;
}

/** Whether a function is async, a generator, or both (#1276). */
function functionModeOf(fn: FunctionLike): FunctionMode | undefined {
  const isAsync =
    (Node.isFunctionDeclaration(fn) ||
      Node.isFunctionExpression(fn) ||
      Node.isArrowFunction(fn) ||
      Node.isMethodDeclaration(fn)) &&
    fn.isAsync();
  const isGenerator =
    (Node.isFunctionDeclaration(fn) ||
      Node.isFunctionExpression(fn) ||
      Node.isMethodDeclaration(fn)) &&
    fn.isGenerator();
  if (isAsync && isGenerator) return "async generator";
  if (isAsync) return "async";
  if (isGenerator) return "generator";
  return undefined;
}

/**
 * A closure's label: `function` when it has its own receiver, else `closure`; `async ` before it
 * when it is async. A generator is always a `function*`: it has no arrow form.
 */
/** The const a function expression or arrow initializes directly, when it does. */
function constInitializedBy(fn: Node): string | undefined {
  if (!Node.isFunctionExpression(fn) && !Node.isArrowFunction(fn)) return undefined;
  let up = fn.getParent();
  while (up !== undefined && Node.isParenthesizedExpression(up)) up = up.getParent();
  if (!Node.isVariableDeclaration(up)) return undefined;
  const list = up.getParent();
  if (
    !Node.isVariableDeclarationList(list) ||
    list.getDeclarationKind() !== VariableDeclarationKind.Const
  )
    return undefined;
  const nameNode = up.getNameNode();
  return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
}

export function closureLabel(dynamicThis: boolean, mode: FunctionMode | undefined): string {
  const generator = mode === "generator" || mode === "async generator";
  const base = generator ? "function*" : dynamicThis ? "function" : "closure";
  return mode === "async" || mode === "async generator" ? `async ${base}` : base;
}

/** Names of all exported top-level bindings (for the no-primary-function case). */
/**
 * The names a module statement declares at its top level (#1290): `var`/`let`/`const`, and
 * function and class declarations, in order.
 */
function moduleDeclaredNames(file: Node): string[] {
  const names: string[] = [];
  // A `__yakcc` name is a lowering's own (the TypeScript lowering's default export), not the module's.
  const add = (name: string): void => {
    if (!names.includes(name) && !name.startsWith("__yakcc")) names.push(name);
  };
  for (const stmt of (file as import("ts-morph").SourceFile).getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarations())
        for (const n of patternNames(decl.getNameNode())) add(n);
    } else if (Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) {
      const name = stmt.getName();
      if (name !== undefined) add(name);
    }
  }
  return names;
}

function exportedBindingNames(file: Node): string[] {
  const sf = file as import("ts-morph").SourceFile;
  const names: string[] = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  // In the order the file writes them (#1292): `export const x`, `export { a, b as c }` (the file's
  // own bindings a and b, #1276), and `export default …` (the name `default`).
  for (const stmt of sf.getStatements()) {
    if (Node.isVariableStatement(stmt) && stmt.hasExportKeyword()) {
      for (const decl of stmt.getDeclarations())
        for (const n of patternNames(decl.getNameNode())) add(n);
    } else if (Node.isExportDeclaration(stmt)) {
      if (stmt.getModuleSpecifier() !== undefined || stmt.isTypeOnly()) continue;
      for (const spec of stmt.getNamedExports())
        if (!spec.isTypeOnly()) add(spec.getNameNode().getText());
    } else if (Node.isExportAssignment(stmt)) add("default");
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

/** A template part's value: its escapes applied, a line break in the source as LF (#1303). */
function cookedTextOf(part: Node): string {
  return (part.compilerNode as unknown as { text: string }).text;
}

/** Whether a tagged template's part has an escape with no value (`\unicode` in a tag). */
function hasInvalidEscape(part: Node): boolean {
  // TokenFlags.ContainsInvalidEscape, which TypeScript does not export.
  const flags = (part.compilerNode as { templateFlags?: number }).templateFlags ?? 0;
  return (flags & 2048) !== 0;
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

interface WhileGuard {
  /** The statements before the test: what the condition needs. */
  readonly prefix: readonly Node[];
  readonly cond: Node;
  /** The statements after the test: the rest of the body. */
  readonly rest: readonly Node[];
}

/**
 * `while (true) { ...prefix; if (!(c)) break; ...rest }` whose only jump of its own is that break:
 * how a lowering writes a condition it cannot put in the loop's header (#1276).
 */
function whileGuard(loop: Node): WhileGuard | undefined {
  if (!Node.isWhileStatement(loop) || loop.getExpression().getKind() !== SyntaxKind.TrueKeyword)
    return undefined;
  const body = loop.getStatement();
  if (!Node.isBlock(body)) return undefined;
  const statements = body.getStatements();
  const jumps = loopJumpsOf(loop);
  if (jumps.length !== 1) return undefined;
  const at = statements.findIndex((st) => {
    if (!Node.isIfStatement(st) || st.getElseStatement() !== undefined) return false;
    const then = st.getThenStatement();
    const inner =
      Node.isBlock(then) && then.getStatements().length === 1 ? then.getStatements()[0] : then;
    return (
      inner !== undefined &&
      Node.isBreakStatement(inner) &&
      inner.getLabel() === undefined &&
      inner.compilerNode === jumps[0]?.compilerNode
    );
  });
  if (at === -1) return undefined;
  const test = (statements[at] as import("ts-morph").IfStatement).getExpression();
  if (
    !Node.isPrefixUnaryExpression(test) ||
    test.getOperatorToken() !== SyntaxKind.ExclamationToken
  )
    return undefined;
  let c: Node = test.getOperand();
  while (Node.isParenthesizedExpression(c)) c = c.getExpression();
  return { prefix: statements.slice(0, at), cond: c, rest: statements.slice(at + 1) };
}

/** Whether an iterating loop has a form the lifter expresses: not `for await`, one declared variable. */
function iterateLiftable(
  node: import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement,
): boolean {
  if (Node.isForOfStatement(node) && node.isAwaited()) return false;
  const init = node.getInitializer();
  // One declared variable, or an existing name the loop assigns each element to (#1276).
  return (
    (Node.isVariableDeclarationList(init) && init.getDeclarations().length === 1) ||
    Node.isIdentifier(init)
  );
}

/**
 * The condition `c` of an iterating loop whose body starts with `if (!(c)) break;` and has no other
 * jump of its own: how a lowering writes an iterating loop's condition (#1276).
 */
function iterateGuard(loop: Node): Node | undefined {
  if (!(Node.isForOfStatement(loop) || Node.isForInStatement(loop))) return undefined;
  const body = loop.getStatement();
  if (!Node.isBlock(body)) return undefined;
  const first = body.getStatements()[0];
  if (first === undefined || !Node.isIfStatement(first) || first.getElseStatement() !== undefined)
    return undefined;
  const then = first.getThenStatement();
  const inner =
    Node.isBlock(then) && then.getStatements().length === 1 ? then.getStatements()[0] : then;
  if (inner === undefined || !Node.isBreakStatement(inner) || inner.getLabel() !== undefined)
    return undefined;
  const jumps = loopJumpsOf(loop);
  if (jumps.length !== 1 || jumps[0]?.compilerNode !== inner.compilerNode) return undefined;
  const test = first.getExpression();
  if (
    !Node.isPrefixUnaryExpression(test) ||
    test.getOperatorToken() !== SyntaxKind.ExclamationToken
  )
    return undefined;
  let c: Node = test.getOperand();
  while (Node.isParenthesizedExpression(c)) c = c.getExpression();
  return c;
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
  if (!isLoopStatement(loop)) return false;
  const labelled = [
    ...loop.getDescendantsOfKind(SyntaxKind.BreakStatement),
    ...loop.getDescendantsOfKind(SyntaxKind.ContinueStatement),
  ].some((j) => j.getLabel() !== undefined && !isInsideNestedFunction(j, loop));
  if (labelled) return false;
  // Every loop statement has a body statement.
  const body = (loop as import("ts-morph").WhileStatement).getStatement();
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
        // A read outside the block of a name some scope inside the body declares (a sibling
        // block's own declaration) is not the name moved into the block.
        const outside = body
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => !id.getAncestors().some((a) => a.compilerNode === p?.compilerNode))
          .filter((id) => isValueRead(id) && !declaredBelow(id, body));
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
const ASYNC_TRY_PRIMITIVE = "__yakccTryAsync";
const RUNTIME_PRIMITIVES = new Set([TRY_PRIMITIVE, ASYNC_TRY_PRIMITIVE]);

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

/**
 * Whether a statement exits on some path, by a direct exit or by a return from a loop inside it:
 * a loop that returns lifts with the rest of the function after it (#1276).
 */
function containsExitOrLoopReturn(node: Node): boolean {
  if (containsDirectExit(node)) return true;
  const loops = [...node.getDescendants()].filter(
    (d) => isLoopStatement(d) && !insideOpaqueNonLoop(d, node),
  );
  return loops.some((l) => loopReturns(l));
}

/** Whether a node lies inside a nested function, a try, or a switch with no arms, below `root`. */
function insideOpaqueNonLoop(n: Node, root: Node): boolean {
  for (
    let p = n.getParent();
    p !== undefined && p.compilerNode !== root.compilerNode;
    p = p.getParent()
  ) {
    if (
      isFunctionLikeNode(p) ||
      (Node.isSwitchStatement(p) && switchArms(p) === undefined) ||
      Node.isTryStatement(p)
    )
      return true;
  }
  return false;
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

/**
 * Names `var` declares inside nested blocks of a body (not at its top level, and not inside a
 * nested function or class): the names hoisting binds at the body's start.
 */
function nestedVarNames(body: Node): string[] {
  const names: string[] = [];
  const topLevel = new Set(
    (Node.isBlock(body) || Node.isSourceFile(body) ? body.getStatements() : []).map(
      (st) => st.compilerNode,
    ),
  );
  const visit = (node: Node): void => {
    for (const child of node.getChildren()) {
      // A try's own lowering carries the names its blocks declare out of them (#1276).
      if (
        isFunctionLikeNode(child) ||
        Node.isClassDeclaration(child) ||
        Node.isClassExpression(child) ||
        Node.isTryStatement(child)
      )
        continue;
      if (
        Node.isVariableStatement(child) &&
        !topLevel.has(child.compilerNode) &&
        child.getDeclarationKind() === VariableDeclarationKind.Var
      ) {
        for (const decl of child.getDeclarations())
          for (const n of patternNames(decl.getNameNode())) if (!names.includes(n)) names.push(n);
      }
      visit(child);
    }
  };
  visit(body);
  return names;
}
