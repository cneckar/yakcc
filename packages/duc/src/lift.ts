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
  type CallExpression,
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
import { mathOperation } from "./operations.js";
import { jsOperation } from "./ops.js";
import { RUNTIME_MODULE } from "./runtime.js";
import type {
  DiamondReason,
  DucBranch,
  DucGraph,
  DucLoop,
  DucNode,
  FunctionMode,
  IterateKind,
  NodeId,
  ValueId,
} from "./types.js";
import { ITERATE_LABEL } from "./types.js";

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
  const file = normalizeJumps(parsed.file);
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
      // A fragment of a generator's body yields: outside a generator, `yield* g()` is a name
      // `yield` times g(), and `yield` is never a name in a module. It is the body of the
      // generator it was sliced from (#1330), async when it awaits too.
      const asName = sf
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => id.getText() === "yield" && isValueRead(id));
      if (asName) {
        const generator = new Project({
          useInMemoryFileSystem: true,
          compilerOptions: { allowJs: false, noEmit: true, noLib: true, skipLibCheck: true },
        });
        const awaits = /\bawait\b/.test(source) ? "async " : "";
        const body = generator.createSourceFile(
          "atom.ts",
          `${awaits}function* __atom__() {\n${source}\n}`,
          { scriptKind: ScriptKind.TS },
        );
        if (generator.getProgram().getSyntacticDiagnostics(body).length === 0) {
          project = generator;
          file = body;
        }
      }
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
function normalizeJumps(
  file: SourceFile,
  reparse: (text: string) => SourceFile = (text) =>
    file.getProject().createSourceFile("atom.ts", text, {
      overwrite: true,
      scriptKind: ScriptKind.TS,
    }),
): SourceFile {
  let sf = file;
  for (let round = 0; round < 64; round++) {
    const text = dropUnreachable(sf);
    if (text === undefined) break;
    sf = reparse(text);
  }
  const braced = braceLoopBodies(sf);
  if (braced !== undefined) sf = reparse(braced);
  for (let round = 0; round < 64; round++) {
    const text = perPassForBinding(sf);
    if (text === undefined) break;
    sf = reparse(text);
  }
  for (let round = 0; round < 64; round++) {
    const text = forUpdateAsTail(sf);
    if (text === undefined) break;
    sf = reparse(text);
  }
  for (let round = 0; round < 64; round++) {
    const text = nextJumpRewrite(sf, round);
    if (text === undefined) return sf;
    sf = reparse(text);
  }
  return sf;
}

/**
 * Whether a scope between a node and `scope` (exclusive) declares `name`: a block's or a clause's
 * own declaration, a function's parameter, a loop header's or a catch clause's binding. A read of the
 * name from the node is that declaration's, not one in `scope`.
 */
function declaredBetween(node: Node, name: string, scope: Node | undefined): boolean {
  const declares = (st: Node): boolean =>
    Node.isVariableStatement(st)
      ? st.getDeclarations().some((d) => patternNames(d.getNameNode()).includes(name))
      : (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) && st.getName() === name;
  for (
    let p: Node | undefined = node.getParent();
    p !== undefined && p.compilerNode !== scope?.compilerNode;
    p = p.getParent()
  ) {
    if (Node.isBlock(p) || Node.isCaseClause(p) || Node.isDefaultClause(p)) {
      if (p.getStatements().some(declares)) return true;
    } else if (isFunctionLikeNode(p)) {
      if (
        (p as FunctionLike)
          .getParameters()
          .some((param) => patternNames(param.getNameNode()).includes(name))
      )
        return true;
    } else if (Node.isForStatement(p) || Node.isForOfStatement(p) || Node.isForInStatement(p)) {
      const init = p.getInitializer();
      if (
        init !== undefined &&
        Node.isVariableDeclarationList(init) &&
        init.getDeclarations().some((d) => patternNames(d.getNameNode()).includes(name))
      )
        return true;
    } else if (Node.isCatchClause(p)) {
      const v = p.getVariableDeclaration();
      if (v !== undefined && patternNames(v.getNameNode()).includes(name)) return true;
    }
  }
  return false;
}

/**
 * A loop's carried names in the order they are declared (#1292), not the order the loop first
 * assigns them: the emitted loop declares its carries, in order, just before it, and assigns each
 * where its next value is ready, so only the declarations' order is the same in both. A name with no
 * declaration in sight (a binding outside the atom) keeps its place after the declared ones.
 */
function byDeclaration(loop: Node, names: readonly string[]): string[] {
  const at = (name: string): number => {
    for (let p: Node | undefined = loop.getParent(); p !== undefined; p = p.getParent()) {
      if (
        Node.isBlock(p) ||
        Node.isSourceFile(p) ||
        Node.isCaseClause(p) ||
        Node.isDefaultClause(p)
      ) {
        for (const st of p.getStatements()) {
          if (Node.isVariableStatement(st))
            for (const d of st.getDeclarations())
              if (patternNames(d.getNameNode()).includes(name)) return d.getStart();
        }
      } else if (isFunctionLikeNode(p)) {
        for (const param of (p as FunctionLike).getParameters())
          if (patternNames(param.getNameNode()).includes(name)) return param.getStart();
        return Number.POSITIVE_INFINITY;
      } else if (Node.isForStatement(p) || Node.isForOfStatement(p) || Node.isForInStatement(p)) {
        const init = p.getInitializer();
        if (init !== undefined && Node.isVariableDeclarationList(init))
          for (const d of init.getDeclarations())
            if (patternNames(d.getNameNode()).includes(name)) return d.getStart();
      }
    }
    return Number.POSITIVE_INFINITY;
  };
  const position = new Map(names.map((name) => [name, at(name)] as const));
  return [...names].sort(
    (a, b) =>
      (position.get(a) as number) - (position.get(b) as number) ||
      names.indexOf(a) - names.indexOf(b),
  );
}

/** A constructor's parameter properties: parameters with an accessibility or `readonly`. */
function parameterProperties(
  ctor: import("ts-morph").ConstructorDeclaration,
): import("ts-morph").ParameterDeclaration[] {
  return ctor
    .getParameters()
    .filter((p) => p.getScope() !== undefined || p.isReadonly() || p.hasOverrideKeyword());
}

/**
 * Whether a class extends another: its constructor is a derived one, whose receiver its `super(..)`
 * makes. An `implements` clause is a type, and makes nothing derived (#1292).
 */
function extendsSomething(
  cls: import("ts-morph").ClassDeclaration | import("ts-morph").ClassExpression,
): boolean {
  return cls.getHeritageClauses().some((h) => h.getToken() === SyntaxKind.ExtendsKeyword);
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

/**
 * The statements after a `return`, `throw`, `break` or `continue` in the same list, which never run,
 * dropped (#1292): what the graph holds, and so what the emitter writes back. Left in, a write there
 * (`throw e; n--;`) makes `n` a binding the atom writes, which the emitted source does not. A function
 * declaration there is hoisted and stays; a `var` keeps its binding without its initializer. A list
 * whose dead statements declare a `let`, `const` or `class` (a binding of the block's, though never
 * initialized) is left as it is. Undefined when nothing is dropped.
 */
function dropUnreachable(sf: SourceFile): string | undefined {
  const jump = (st: Node): boolean =>
    Node.isReturnStatement(st) ||
    Node.isThrowStatement(st) ||
    Node.isBreakStatement(st) ||
    Node.isContinueStatement(st);
  const edits: { start: number; end: number; text: string }[] = [];
  const lists = [sf, ...sf.getDescendants()].filter(
    (n) =>
      Node.isSourceFile(n) || Node.isBlock(n) || Node.isCaseClause(n) || Node.isDefaultClause(n),
  ) as (SourceFile | import("ts-morph").Block | import("ts-morph").CaseClause)[];
  for (const list of lists) {
    const statements = list.getStatements();
    const at = statements.findIndex(jump);
    if (at === -1 || at === statements.length - 1) continue;
    const dead = statements.slice(at + 1);
    const binds = dead.some(
      (st) =>
        Node.isClassDeclaration(st) ||
        (Node.isVariableStatement(st) && st.getDeclarationKind() !== VariableDeclarationKind.Var),
    );
    if (binds) continue;
    const kept = dead.flatMap((st) => {
      if (Node.isFunctionDeclaration(st)) return [st.getText()];
      if (Node.isVariableStatement(st))
        return [
          `var ${st
            .getDeclarations()
            .flatMap((d) => patternNames(d.getNameNode()))
            .join(", ")};`,
        ];
      return [];
    });
    edits.push({
      start: dead[0]?.getStart() ?? 0,
      end: dead[dead.length - 1]?.getEnd() ?? 0,
      text: kept.join(" "),
    });
  }
  if (edits.length === 0) return undefined;
  // Outermost first: a nested list's edit inside a dropped range goes with it.
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const outer: typeof edits = [];
  for (const e of edits) {
    const last = outer[outer.length - 1];
    if (last !== undefined && e.start < last.end) continue;
    outer.push(e);
  }
  let text = sf.getFullText();
  for (const e of outer.reverse()) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

/**
 * Every loop body that is one statement, written as a block (`for (..) return x;` is
 * `for (..) { return x; }`): the same loop, whose body the jump rewrites and the lifter take as a
 * block (#1368). Undefined when every body is one already.
 */
function braceLoopBodies(sf: SourceFile): string | undefined {
  const bodies = sf
    .getDescendants()
    .filter(isLoopStatement)
    .map((l) => (l as import("ts-morph").WhileStatement).getStatement())
    .filter((b) => !Node.isBlock(b));
  if (bodies.length === 0) return undefined;
  const edits = bodies.flatMap((b) => [
    { at: b.getStart(), text: "{ " },
    { at: b.getEnd(), text: " }" },
  ]);
  // From the end, so earlier positions hold; at one position, a close before an open.
  edits.sort((a, b) => b.at - a.at || (a.text === "{ " ? 1 : -1));
  let text = sf.getFullText();
  for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.at);
  return text;
}

/**
 * A `for` header's `let` that something nested in the body rebinds (a closure, or a try statement's
 * block, which is one once lowered), written as a binding of the body's own, copied from the header's
 * at the start of each pass and back at its end and at each `continue` (#1292):
 * `for (let a = 0; c(a); a++) { B }` is `for (let a$1 = 0; c(a$1); a$1++) { let a = a$1; B a$1 = a; }`.
 * That is JavaScript's own rule (each pass has its binding, copied into the next before the update),
 * and the body's `let` is a cell made each pass, as any other block's is. A header whose initializer,
 * condition or update holds a function, or a body that declares the name itself, is left as it is.
 * Undefined when no header needs it.
 */
function perPassForBinding(sf: SourceFile): string | undefined {
  const text = sf.getFullText();
  for (const loop of sf.getDescendantsOfKind(SyntaxKind.ForStatement)) {
    const init = loop.getInitializer();
    const body = loop.getStatement();
    if (
      init === undefined ||
      !Node.isVariableDeclarationList(init) ||
      init.getDeclarationKind() !== "let" ||
      !Node.isBlock(body)
    )
      continue;
    const header: Node[] = [init];
    for (const part of [loop.getCondition(), loop.getIncrementor()])
      if (part !== undefined) header.push(part);
    if (
      header.some((n) =>
        n.getDescendants().some((d) => isFunctionLikeNode(d) || Node.isClassExpression(d)),
      )
    )
      continue;
    const nested = body
      .getDescendants()
      .filter(
        (d) =>
          isFunctionLikeNode(d) ||
          Node.isClassStaticBlockDeclaration(d) ||
          (Node.isBlock(d) && Node.isTryStatement(d.getParent())) ||
          Node.isCatchClause(d),
      );
    if (nested.length === 0) continue;
    const ownDeclared = new Set(
      body
        .getStatements()
        .flatMap((st) =>
          Node.isVariableStatement(st)
            ? st.getDeclarations().flatMap((d) => patternNames(d.getNameNode()))
            : (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) &&
                st.getName() !== undefined
              ? [st.getName() as string]
              : [],
        ),
    );
    const names = init
      .getDeclarations()
      .map((d) => d.getNameNode())
      .filter((n) => Node.isIdentifier(n))
      .map((n) => n.getText())
      .filter(
        (name) =>
          !ownDeclared.has(name) &&
          nested.some((fn) =>
            assignmentTargetsOf(fn).some((t) =>
              targetNames(t).some(
                (id) => id.getText() === name && !declaredBetween(id, name, loop),
              ),
            ),
          ),
      );
    if (names.length === 0) continue;
    const fresh = new Map<string, string>();
    for (const name of names) {
      let n = 1;
      while (text.includes(`${name}$${n}`)) n++;
      fresh.set(name, `${name}$${n}`);
    }
    // The header's references, renamed: its declarations, and the names its expressions use.
    const edits: { from: number; to: number; text: string }[] = [];
    let shorthand = false;
    for (const part of header) {
      for (const id of [
        ...(Node.isIdentifier(part) ? [part] : []),
        ...part.getDescendantsOfKind(SyntaxKind.Identifier),
      ]) {
        const to = fresh.get(id.getText());
        if (to === undefined) continue;
        const parent = id.getParent();
        if (Node.isShorthandPropertyAssignment(parent)) shorthand = true;
        if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue;
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) continue;
        edits.push({ from: id.getStart(), to: id.getEnd(), text: to });
      }
    }
    if (shorthand) continue;
    const copyBack = names.map((name) => `${fresh.get(name)} = ${name};`).join(" ");
    for (const j of body.getDescendantsOfKind(SyntaxKind.ContinueStatement)) {
      const label = j.getLabel()?.getText();
      const target =
        label === undefined
          ? ownLoop(j)
          : (() => {
              const l = labelTarget(j, label);
              return l === undefined ? undefined : labelled(l);
            })();
      if (target?.compilerNode !== loop.compilerNode) continue;
      edits.push({ from: j.getStart(), to: j.getEnd(), text: `{ ${copyBack} ${j.getText()} }` });
    }
    const open = body.getStart() + 1;
    const close = body.getEnd() - 1;
    edits.push({
      from: open,
      to: open,
      text: ` ${names.map((name) => `let ${name} = ${fresh.get(name)};`).join(" ")}`,
    });
    edits.push({ from: close, to: close, text: ` ${copyBack} ` });
    edits.sort((a, b) => b.from - a.from);
    let out = text;
    for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
    return out;
  }
  return undefined;
}

/**
 * A `for` loop with a `continue` of its own, written with its update as the body's last statement
 * and before each such `continue` (#1292): `for (i = 0; c; i++) { if (a) continue; B }` is
 * `for (i = 0; c; ) { if (a) { i++; continue; } B i++; }`. That is when JavaScript runs it, and it
 * is how a loop with no `continue` is lifted already (the update is its body's tail): a loop
 * emitted from either is a `while` whose body ends with the update, which lifts the same. A loop
 * whose body or update holds a function or class is left as it is. Undefined when no loop needs it.
 */
function forUpdateAsTail(sf: SourceFile): string | undefined {
  const text = sf.getFullText();
  for (const loop of sf.getDescendantsOfKind(SyntaxKind.ForStatement)) {
    const update = loop.getIncrementor();
    const body = loop.getStatement();
    if (update === undefined || !Node.isBlock(body)) continue;
    // A closure in the body holds its pass's bindings: the update writes the next pass's copy, so it
    // stays in the header (the closure would see it otherwise). So does one in the update.
    const closureIn = (n: Node): boolean =>
      n
        .getDescendants()
        .some(
          (d) => isFunctionLikeNode(d) || Node.isClassExpression(d) || Node.isClassDeclaration(d),
        );
    if (closureIn(update) || closureIn(body)) continue;
    const own = body.getDescendantsOfKind(SyntaxKind.ContinueStatement).filter((j) => {
      const label = j.getLabel()?.getText();
      const target =
        label === undefined
          ? ownLoop(j)
          : (() => {
              const l = labelTarget(j, label);
              return l === undefined ? undefined : labelled(l);
            })();
      return target?.compilerNode === loop.compilerNode;
    });
    if (own.length === 0) continue;
    const step = `${update.getText()};`;
    const edits: { from: number; to: number; text: string }[] = [
      // The header's update goes, with the space before it: `for (a; b; c)` is `for (a; b; )`.
      { from: update.getStart(), to: update.getEnd(), text: "" },
      ...own.map((j) => ({
        from: j.getStart(),
        to: j.getEnd(),
        text: `{ ${step} ${j.getText()} }`,
      })),
      { from: body.getEnd() - 1, to: body.getEnd() - 1, text: ` ${step} ` },
    ];
    edits.sort((a, b) => b.from - a.from);
    let out = text;
    for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
    return out;
  }
  return undefined;
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
    // A plain break must leave the inner loop: with a switch between them, the jump first leaves
    // the switch nearest it, by a flag and a break of the switch, and is written again after it
    // (#1368); the next round takes it on from there.
    let sw: Node | undefined;
    for (let p: Node | undefined = j.getParent(); p !== undefined && p !== inner; p = p.getParent())
      if (Node.isSwitchStatement(p)) {
        sw = p;
        break;
      }
    let needs: boolean;
    if (Node.isReturnStatement(j)) needs = ownLoop(inner) !== undefined;
    else {
      const label = (j as import("ts-morph").BreakStatement).getLabel()?.getText();
      if (label === undefined) continue;
      const l = labelTarget(j, label);
      if (l === undefined || !isLoopStatement(labelled(l))) continue;
      // A labelled break of its own loop, from a switch in it, leaves the switch first: then it is
      // the loop's plain break, and its label is dropped (#1368).
      needs = labelled(l) !== inner || (Node.isBreakStatement(j) && sw !== undefined);
    }
    if (!needs) continue;
    let outer: Node = sw ?? inner;
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

  /** Optional links whose chain has been tested, read plainly (#1360). */
  private readonly plainLinks = new Set<ts.Node>();
  /** The bases of the chains being lifted, already evaluated (#1360). */
  private readonly chainBases = new Map<ts.Node, ValueId>();

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
    // The atom is the function: a name the file declares outside it, and the function writes, is a
    // binding outside the atom too (#1330): `let d = function () { .. d = g; .. }`.
    if (primary !== undefined)
      for (const name of writtenFreeNames(primary))
        if (!this.imports.has(name)) this.bindings.add(name);
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
    // A derived constructor with an arrow made before its `super(..)` that reads `this` when it
    // runs (#1330): the receiver is a cell from the start, which the call writes.
    if (
      this.derived &&
      Node.isConstructorDeclaration(fn) &&
      (arrowReadsThisBeforeSuper(fn) || superInTry(fn))
    ) {
      this.cells.add(THIS);
      const [cell] = this.emit("op", [this.undefinedValue()], 1, {
        origin: { kind: "ObjectLiteral", text: "this" },
        label: 'object:["value"]',
      });
      this.env.set(THIS, cell as ValueId);
    }
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
      } else if (Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) {
        // A class too (#1330): a function hoisted over it reads it through a cell.
        const name = stmt.getName();
        if (name !== undefined) declared.add(name);
      }
    }
    const hoistedNames = new Set<string>();
    // The names made cells ahead of their declarations in this scope.
    const cellsHere = new Set<string>();
    // Names declared in the list by `var`: hoisted as undefined, as JavaScript hoists them. A `let`,
    // `const` or class read before its declaration throws, so a function reading one is not hoisted
    // over it: it is bound where it stands, and the name stays reported.
    // A `let`, `const` or class too (#1330): a function declaration is hoisted over it, as
    // JavaScript hoists it, and reads it through a cell when it runs. (Run before the declaration,
    // JavaScript throws; the cell gives undefined.)
    const declaredValues = new Set<string>();
    for (const stmt of stmts) {
      if (Node.isVariableStatement(stmt))
        for (const decl of stmt.getDeclarations())
          for (const name of patternNames(decl.getNameNode())) declaredValues.add(name);
      else if (Node.isClassDeclaration(stmt) && stmt.getName() !== undefined)
        declaredValues.add(stmt.getName() as string);
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
        // Already bound by the list it was hoisted in (a tail lifted again on a side), when this
        // side still has the binding; a side that does not is bound again (#1330).
        if (this.hoisted.has(stmt.compilerNode) && this.env.has(name)) {
          hoistedNames.add(name);
          progress = true;
          continue;
        }
        const reads = this.readNamesOf(stmt).filter(
          (read) => read !== name && declared.has(read) && !hoistedNames.has(read),
        );
        if (reads.some((read) => !declaredValues.has(read))) continue;
        for (const read of reads) this.hoistCell(read, cellsHere);
        this.bindFunctionDeclaration(stmt, name);
        this.hoisted.add(stmt.compilerNode);
        hoistedNames.add(name);
        progress = true;
      }
    }
    // Function declarations that call one another (#1349): each is a cell from here, and each
    // declaration writes its cell, before any statement runs, as JavaScript hoists them. A function
    // that reads a later `let`, `const` or class is still bound where it stands.
    const waiting = new Map<string, import("ts-morph").FunctionDeclaration>();
    for (const stmt of stmts) {
      const name = Node.isFunctionDeclaration(stmt) ? stmt.getName() : undefined;
      if (name !== undefined && !hoistedNames.has(name) && !this.hoisted.has(stmt.compilerNode))
        waiting.set(name, stmt as import("ts-morph").FunctionDeclaration);
    }
    const blockers = new Map(
      [...waiting].map(([name, stmt]) => [
        name,
        this.readNamesOf(stmt).filter(
          (read) => read !== name && declared.has(read) && !hoistedNames.has(read),
        ),
      ]),
    );
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [name, reads] of blockers)
        if (reads.some((read) => !declaredValues.has(read) && !blockers.has(read))) {
          blockers.delete(name);
          pruned = true;
        }
    }
    if (blockers.size > 0) {
      for (const [name, reads] of blockers) {
        this.hoistCell(name, cellsHere);
        for (const read of reads) if (!blockers.has(read)) this.hoistCell(read, cellsHere);
      }
      for (const [name] of blockers) {
        const stmt = waiting.get(name) as import("ts-morph").FunctionDeclaration;
        this.bindFunctionDeclaration(stmt, name);
        this.hoisted.add(stmt.compilerNode);
        hoistedNames.add(name);
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
          // A closure reads this binding only where no scope between it and this one declares
          // the name again (#1292): an inner block's own `const r` is the `r` its closure reads.
          const readsThis = (fn: Node): boolean =>
            this.readNamesOf(fn).includes(name) && !declaredBetween(fn, name, stmt.getParent());
          const readEarlier =
            stmts
              .slice(0, isVar ? j + 1 : j)
              .some((earlier) => functionsWithin(earlier).some(readsThis)) ||
            // A closure in a let's or const's own initializer that reads it when it runs, after
            // the initializer (#1330): `const c = eos(s, () => c())`. One that is the initializer
            // itself is `function-self`.
            (!isVar &&
              functionsWithin(stmt).some((fn) => readsThis(fn) && constInitializedBy(fn) !== name));
          // A `let` or `const` too, read by a closure made before it, which runs after it is
          // initialized (#1297); or assigned by a closure in its own initializer (`let id =
          // setTimeout(() => { id = null })`). A const arrow calling itself is `function-self`.
          const writtenByOwn =
            !isVar &&
            functionsWithin(stmt).some((fn) =>
              assignmentTargets(fn).some((t) => Node.isIdentifier(t) && t.getText() === name),
            );
          if (readEarlier || writtenByOwn) this.hoistCell(name, cellsHere);
        }
    }
    for (const [i, written] of stmts.entries()) {
      // The rest of a scope a block took: the block's names are the scope's again (#1330).
      const scope = this.tailScopes.get(written.compilerNode);
      if (scope !== undefined) this.restoreScope(scope);
      // A switch whose clauses each end in an exit is the if chain it means (#1276).
      const stmt = Node.isSwitchStatement(written)
        ? (this.lowerSwitch(written) ?? this.lowerSwitchAsPass(written) ?? written)
        : Node.isTryStatement(written)
          ? (this.lowerTry(written) ?? written)
          : written;
      const rest = stmts.slice(i + 1);
      const full = cont === undefined ? undefined : [...rest, ...cont];
      if (this.bodyExits !== undefined) {
        // Not an if whose only exits are throws (#1292): a throw ends its path, so the rest of the
        // body is the rest of every path that goes on, as in a function. A for loop's update is not
        // part of its body, but a while loop's is: taking the rest made them two graphs.
        if (
          Node.isIfStatement(stmt) &&
          full !== undefined &&
          this.holdsLoopExit(stmt, this.bodyExits.node) &&
          !this.throwsOnlyIn(stmt, this.bodyExits.node)
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
      if (
        containsDirectExit(stmt) &&
        !(Node.isIfStatement(stmt) && throwsOnly(stmt)) &&
        rest.length > 0 &&
        this.env.has(RETURN_DONE)
      ) {
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
    const source = `${syntheticFunction(sw)} __switch() {\n{\nconst ${tmp} = (${sw.getExpression().getText()});\n${text}\n}\n}`;
    const file = syntheticFile(sw, "__switch", source);
    return this.noteExits(
      file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0],
    );
  }

  private tryCount = 0;

  /**
   * A class as one operation over its members (#1276, #1330): the constructor, then each member in
   * order, its label naming each member's kind, name and whether it is static. A member reads the
   * class's own name as `class-self`.
   *
   * - A method, accessor or the constructor is its closure.
   * - A field (`x = e`, `static y = e`) is its initializer: a closure run with the instance (or the
   *   class) as its receiver, when the instance is made (or the class defined), in order. A field
   *   with no initializer is `undefined`'s; one whose initializer is `(() => { body })()` is `body`'s
   *   (the TypeScript lowering writes an initializer so).
   * - A static block (`static { .. }`) is a closure run with the class as its receiver, in order.
   * - A computed name (`[k]`), or a name that is not an identifier (`"a-b"`, `1`), is the key's
   *   value: an input before the member's closure, evaluated when the class is defined, in member
   *   order. Its entry's name is null.
   *
   * - A private name (`#x`) is the member's name: reads and writes of it (`o.#x`) are labelled with
   *   it, and resolve to the nearest enclosing class that declares it.
   *
   * Undefined when it is not that: a parameter property, a decorator, or a member that is not one
   * of these.
   */
  private liftClass(
    node: import("ts-morph").ClassDeclaration | import("ts-morph").ClassExpression,
  ): ValueId | undefined {
    if (node.getDecorators().length > 0) return undefined;
    const members = node.getMembers().filter((m) => !isTypeOnlyMember(m));
    for (const m of members) {
      // A parameter property is rewritten as what it means (rewriteClass, #1292).
      if (Node.isConstructorDeclaration(m)) continue;
      if (Node.isClassStaticBlockDeclaration(m)) continue;
      if (
        !(
          Node.isMethodDeclaration(m) ||
          Node.isGetAccessorDeclaration(m) ||
          Node.isSetAccessorDeclaration(m) ||
          Node.isPropertyDeclaration(m)
        )
      )
        return undefined;
      if (!Node.isPropertyDeclaration(m) && m.getBody() === undefined) return undefined;
    }
    // Fields and static blocks are lifted as the methods they mean, and a computed name as an
    // identifier, from a copy of the file with the class rewritten so: the members' scopes are the
    // file's, so what they read and what is assigned around them are as written.
    const rewritten = this.rewriteClass(node, members);
    if (rewritten === undefined) return undefined;
    // `extends P` is evaluated first: the parent is the class's first input, `["extends"]` its
    // first entry (#1276). An `implements` clause is a type and computes nothing.
    const heritage = node.getExtends();
    const parent = heritage !== undefined ? this.liftExpr(heritage.getExpression()) : undefined;
    const self = node.getName();
    const entries: unknown[] = [];
    const values: ValueId[] = [];
    let ctor: { entry: unknown; value: ValueId } | undefined;
    for (const [i, m] of members.entries()) {
      const fn = rewritten[i] as FunctionLike;
      if (Node.isConstructorDeclaration(m)) {
        if (m.getBody() === undefined) continue;
        const value = this.liftClosure(fn, undefined, self);
        if (value === undefined) return undefined;
        ctor = { entry: ["constructor"], value };
        continue;
      }
      if (Node.isClassStaticBlockDeclaration(m)) {
        const value = this.liftClosure(fn, undefined, self);
        if (value === undefined) return undefined;
        entries.push(["block"]);
        values.push(value);
        continue;
      }
      const nameNode = m.getNameNode();
      // A computed or literal name: the key's value, now, in member order.
      let name: string | null = null;
      // A private name (`#x`) is a name, not a key: it is its class's own, resolved where it is
      // written to the nearest class that declares it.
      if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode))
        name = nameNode.getText();
      else
        values.push(
          this.liftExpr(
            Node.isComputedPropertyName(nameNode) ? nameNode.getExpression() : (nameNode as Node),
          ),
        );
      const kind = Node.isPropertyDeclaration(m)
        ? "field"
        : Node.isMethodDeclaration(m)
          ? "method"
          : Node.isGetAccessorDeclaration(m)
            ? "get"
            : "set";
      const value = this.liftClosure(fn, undefined, self);
      if (value === undefined) return undefined;
      entries.push([kind, name, m.isStatic()]);
      values.push(value);
    }
    if (ctor !== undefined) {
      entries.unshift(ctor.entry);
      values.unshift(ctor.value);
    }
    if (parent !== undefined) {
      entries.unshift(["extends"]);
      values.unshift(parent);
    }
    // Defining a class with a static field or block runs code: it is ordered among the heap
    // operations, as a call is.
    const runsAtDefinition = entries.some(
      (e) => Array.isArray(e) && (e[0] === "block" || (e[0] === "field" && e[2] === true)),
    );
    return this.emit("op", values, 1, {
      origin: { kind: "Class", text: truncate(self ?? "class") },
      label: `class:${labelJson(entries)}`,
      ...(runsAtDefinition ? { heap: true } : {}),
    })[0] as ValueId;
  }

  /**
   * Each member of a class as the function it lifts as, in the same order: a method, accessor or
   * constructor as itself (renamed when its name is not an identifier), a field as a method that
   * returns its initializer, a static block as a static method. Members that need no rewriting are
   * returned as they are; otherwise from a copy of the file with the class rewritten.
   */
  private rewriteClass(
    node: import("ts-morph").ClassDeclaration | import("ts-morph").ClassExpression,
    members: readonly Node[],
  ): (FunctionLike | undefined)[] | undefined {
    const plain = (m: Node): boolean =>
      (Node.isConstructorDeclaration(m) && parameterProperties(m).length === 0) ||
      ((Node.isMethodDeclaration(m) ||
        Node.isGetAccessorDeclaration(m) ||
        Node.isSetAccessorDeclaration(m)) &&
        (Node.isIdentifier(m.getNameNode()) || Node.isPrivateIdentifier(m.getNameNode())));
    if (members.every(plain)) return members.map((m) => m as FunctionLike);
    const file = node.getSourceFile();
    let text = file.getFullText();
    const edits: [number, number, string][] = [];
    for (const [i, m] of members.entries()) {
      if (plain(m)) continue;
      // A parameter property (`constructor(public readonly x: T)`) is a parameter and an assignment
      // to the receiver, at the start of the body, or after its `super(..)` in a derived class
      // (#1292): TypeScript's meaning, and its lowering.
      if (Node.isConstructorDeclaration(m)) {
        const body = m.getBody();
        if (body === undefined || !Node.isBlock(body)) return undefined;
        const props = parameterProperties(m);
        for (const param of props)
          for (const mod of param.getModifiers()) edits.push([mod.getStart(), mod.getEnd(), ""]);
        const assigns = props
          .map((param) => `this.${param.getName()} = ${param.getName()};`)
          .join(" ");
        if (node.getHeritageClauses().some((h) => h.getToken() === SyntaxKind.ExtendsKeyword)) {
          const call = body
            .getStatements()
            .find(
              (st) =>
                Node.isExpressionStatement(st) &&
                Node.isCallExpression(st.getExpression()) &&
                (st.getExpression() as import("ts-morph").CallExpression)
                  .getExpression()
                  .getKind() === SyntaxKind.SuperKeyword,
            );
          if (call === undefined) return undefined;
          edits.push([call.getEnd(), call.getEnd(), ` ${assigns}`]);
        } else edits.push([body.getStart() + 1, body.getStart() + 1, ` ${assigns}`]);
        continue;
      }
      if (Node.isClassStaticBlockDeclaration(m)) {
        edits.push([m.getStart(), m.getEnd(), `static __yk_member${i}() ${staticBody(m)}`]);
        continue;
      }
      if (Node.isPropertyDeclaration(m)) {
        const body = initializerBody(m.getInitializer());
        edits.push([
          m.getStart(),
          m.getEnd(),
          `${m.isStatic() ? "static " : ""}__yk_member${i}() ${body}`,
        ]);
        continue;
      }
      // A method or accessor whose name is not an identifier: the same member, renamed.
      const nameNode = (m as import("ts-morph").MethodDeclaration).getNameNode();
      edits.push([nameNode.getStart(), nameNode.getEnd(), `__yk_member${i}`]);
    }
    for (const [from, to, replacement] of edits.sort((a, b) => b[0] - a[0]))
      text = text.slice(0, from) + replacement + text.slice(to);
    const copy = syntheticFile(file, "__class", text);
    const at = node.getStart();
    const cls = [
      ...copy.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
      ...copy.getDescendantsOfKind(SyntaxKind.ClassExpression),
    ].find((c) => c.getStart() === at);
    if (cls === undefined) return undefined;
    const out = cls.getMembers().filter((m) => !isTypeOnlyMember(m));
    if (out.length !== members.length) return undefined;
    return out.map((m) => m as FunctionLike);
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
    const shape = tryShape(t);
    if (shape === undefined) return undefined;
    const { parts, vars, awaits, yields, leaves } = shape;
    const handler = t.getCatchClause();
    const finalizer = t.getFinallyBlock();
    const returns = parts.flatMap((part) =>
      part
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((r) => !isInsideNestedFunction(r, part)),
    );
    const completes = returns.length > 0 || leaves.length > 0;
    const full = t.getSourceFile().getFullText();
    const n = this.tryCount++;
    // A generator closure has its own receiver: the statement's is read through a name (#1330).
    const owner = t.getAncestors().find((x) => isFunctionLikeNode(x));
    const self = `$self${n}`;
    const receivers = yields
      ? parts.flatMap((part) =>
          part
            .getDescendantsOfKind(SyntaxKind.ThisKeyword)
            .filter((k) => receiverOwner(k) === owner),
        )
      : [];
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
      for (const k of receivers)
        if (k.getStart() >= start && k.getEnd() <= end)
          edits.push({ from: k.getStart(), to: k.getEnd(), text: self });
      // A break or continue of the loop around the statement is `[2]` or `[3]` (#1330).
      for (const j of leaves) {
        if (j.getStart() < start || j.getEnd() > end) continue;
        const code = Node.isBreakStatement(j) ? 2 : 3;
        edits.push({ from: j.getStart(), to: j.getEnd(), text: `return [${code}];` });
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
    const tmp = `$try${n}`;
    // A block that awaits is an async closure, and the call is of the async primitive, awaited. A
    // block that yields is a generator closure, and the call is of the generator primitive,
    // delegated to (#1330): next, throw and return reach the blocks as they reach the statement.
    const ownerAsync =
      (Node.isFunctionDeclaration(owner) ||
        Node.isFunctionExpression(owner) ||
        Node.isMethodDeclaration(owner)) &&
      owner.isAsync();
    const inAsync = awaits || (yields && ownerAsync);
    const a = inAsync ? "async " : "";
    const closure = (params: string, block: import("ts-morph").Block): string =>
      yields
        ? `${a}function* (${params}) {\n${rewrite(block)}\n}`
        : `${a}(${params}) => {\n${rewrite(block)}\n}`;
    const body = closure("", t.getTryBlock());
    const caught =
      handler !== undefined
        ? closure(handler.getVariableDeclaration()?.getText() ?? "", handler.getBlock())
        : "undefined";
    const last = finalizer !== undefined ? `, ${closure("", finalizer)}` : "";
    const call = yields
      ? `(yield* ${inAsync ? ASYNC_GEN_TRY_PRIMITIVE : GEN_TRY_PRIMITIVE}(${body}, ${caught}${last}))`
      : awaits
        ? `(await ${ASYNC_TRY_PRIMITIVE}(${body}, ${caught}${last}))`
        : `${TRY_PRIMITIVE}(${body}, ${caught}${last})`;
    const wrapper = `${a}function${yields ? "*" : ""} __try()`;
    const after = [
      ...(returns.length > 0 ? [`if (${tmp}[0] === 1) return ${tmp}[1];`] : []),
      ...(leaves.some((j) => Node.isBreakStatement(j)) ? [`if (${tmp}[0] === 2) break;`] : []),
      ...(leaves.some((j) => Node.isContinueStatement(j))
        ? [`if (${tmp}[0] === 3) continue;`]
        : []),
    ];
    const bindSelf = receivers.length > 0 ? `const ${self} = this;\n` : "";
    const source = completes
      ? `${wrapper} {\n{\n${bindSelf}const ${tmp} = ${call};\n${after.join("\n")}\n}\n}`
      : receivers.length > 0
        ? `${wrapper} {\n{\n${bindSelf}${call};\n}\n}`
        : `${wrapper} {\n${call};\n}`;
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
    const file = syntheticFile(t, "__try", source);
    // The return after the call is the try's returns: in a loop's body, an exit of the loop (#1330).
    return this.noteExits(
      file.getFunctions()[0]?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0],
    );
  }

  /**
   * A lowered statement's returns are the function's: in a loop's body, exits of the loop, as the
   * returns of the statement it was lowered from are (#1330).
   */
  private noteExits(lowered: Node | undefined): Node | undefined {
    for (const r of [
      ...(lowered?.getDescendantsOfKind(SyntaxKind.ReturnStatement) ?? []),
      ...(lowered?.getDescendantsOfKind(SyntaxKind.BreakStatement) ?? []),
      ...(lowered?.getDescendantsOfKind(SyntaxKind.ContinueStatement) ?? []),
      // A throw too, as a loop's own throw is (loopJumpsOf), outside a try the lowering holds: a
      // switch's clause that throws is an exit of the loop around it, as the if it lowers to is when
      // written (#1292).
      ...(lowered?.getDescendantsOfKind(SyntaxKind.ThrowStatement) ?? []).filter(
        (t) => outermostTry(t, lowered as Node) === undefined,
      ),
    ])
      if (!isInsideNestedFunction(r, lowered as Node) && !insideLoop(r, lowered as Node))
        this.loweredExits.add(r.compilerNode);
    return lowered;
  }

  /**
   * Where the rest of a scope starts that a block took (see the Block case of liftStatementInner):
   * the block's own names, with the values they had outside it.
   */
  private readonly tailScopes = new Map<
    import("ts-morph").ts.Node,
    ReadonlyMap<string, ValueId | undefined>
  >();

  /** Puts names back to the values they had outside a block (absent: not bound outside it). */
  private restoreScope(outer: ReadonlyMap<string, ValueId | undefined>): void {
    for (const [name, value] of outer) {
      if (value === undefined) this.env.delete(name);
      else this.env.set(name, value);
    }
  }

  /** The returns of lowered statements (see noteExits). */
  private readonly loweredExits = new Set<import("ts-morph").ts.Node>();

  /**
   * Lifts a guarded loop's body (a condition written as `if (!(c)) break;`) whose only other exits
   * are throws as a body with exits, with no flags (#1292): a branch that throws takes the rest of
   * the body onto its other side, as in a loop with exits, not the rest of the function.
   */
  private withThrowExits<T>(loop: Node, guarded: boolean, body: () => T): T {
    if (!guarded || this.bodyExits !== undefined || !loopJumpsOf(loop).some(Node.isThrowStatement))
      return body();
    this.bodyExits = { node: loop };
    try {
      return body();
    } finally {
      this.bodyExits = undefined;
    }
  }

  /** Whether every exit of a loop a statement holds, written or lowered, is a throw. */
  private throwsOnlyIn(stmt: Node, loop: Node): boolean {
    const jumps = new Set(loopJumpsOf(loop).map((j) => j.compilerNode));
    const exits = stmt
      .getDescendants()
      .filter((d) => jumps.has(d.compilerNode) || this.loweredExits.has(d.compilerNode));
    return exits.length > 0 && exits.every((d) => Node.isThrowStatement(d));
  }

  /** Whether a statement holds an exit of the loop whose body is being lifted. */
  private holdsLoopExit(stmt: Node, loop: Node): boolean {
    return (
      containsLoopJump(stmt, loop) ||
      stmt.getDescendants().some((r) => this.loweredExits.has(r.compilerNode))
    );
  }

  /**
   * Any switch, as one pass of a loop (#1276): the index of the clause to start at (the first case
   * that matches, tested lazily in order, else the default's, else past the end), then each clause
   * in order under `if ($at <= i)`, so a clause falls into the next, and a break leaves the pass.
   * A continue of the loop around it, and a return, set a flag and leave the pass; after it, the
   * loop continues or the function returns (#1330, #1368). Undefined where `switchPassShape` is.
   */
  private lowerSwitchAsPass(sw: import("ts-morph").SwitchStatement): Node | undefined {
    const shape = switchPassShape(sw);
    if (shape === undefined) return undefined;
    const { continues, returns } = shape;
    const clauses = sw.getCaseBlock().getClauses();
    const n = this.switchCount++;
    const tmp = `$switch${n}`;
    const at = `$at${n}`;
    const cont = `$continue${n}`;
    const ret = `$return${n}`;
    const value = `$value${n}`;
    const leaving = new Set([...continues, ...returns].map((c) => c.compilerNode));
    /** A clause's statement as written, with each of the switch's continues and returns a flag's. */
    const textOf = (st: Node): string => {
      let text = st.getText();
      const inside = [
        ...(Node.isContinueStatement(st) || Node.isReturnStatement(st) ? [st] : []),
        ...st.getDescendantsOfKind(SyntaxKind.ContinueStatement),
        ...st.getDescendantsOfKind(SyntaxKind.ReturnStatement),
      ]
        .filter((c) => leaving.has(c.compilerNode))
        .sort((a, b) => b.getStart() - a.getStart());
      for (const c of inside) {
        const from = c.getStart() - st.getStart();
        const expr = Node.isReturnStatement(c) ? c.getExpression() : undefined;
        const set = Node.isReturnStatement(c)
          ? `${ret} = true;${expr !== undefined ? ` ${value} = (${expr.getText()});` : ""}`
          : `${cont} = true;`;
        text = `${text.slice(0, from)}{ ${set} break; }${text.slice(c.getEnd() - st.getStart())}`;
      }
      return text;
    };
    const end = clauses.length;
    const fallback = clauses.findIndex((c) => Node.isDefaultClause(c));
    let chain = String(fallback === -1 ? end : fallback);
    for (let i = clauses.length - 1; i >= 0; i--) {
      const c = clauses[i] as Node;
      if (Node.isCaseClause(c))
        chain = `${tmp} === (${c.getExpression().getText()}) ? ${i} : ${chain}`;
    }
    const bodies = clauses
      .map((c, i) => `if (${at} <= ${i}) {\n${c.getStatements().map(textOf).join("\n")}\n}`)
      .join("\n");
    const before =
      (continues.length > 0 ? `let ${cont} = false;\n` : "") +
      (returns.length > 0 ? `let ${ret} = false;\nlet ${value};\n` : "");
    const after =
      (returns.length > 0 ? `\nif (${ret}) return ${value};` : "") +
      (continues.length > 0 ? `\nif (${cont}) continue;` : "");
    const loop = continues.length > 0 ? "while (true) {\n" : "";
    const source = `${syntheticFunction(sw)} __switch() {\n${loop}{\n${before}const ${tmp} = (${sw.getExpression().getText()});\nconst ${at} = ${chain};\ndo {\n${bodies}\n} while (false);${after}\n}\n${continues.length > 0 ? "}\n" : ""}}`;
    // A return in a loop within a clause is now one inside a loop of the pass's: it leaves its own
    // loops as a jump does (#1368).
    const file = normalizeJumps(syntheticFile(sw, "__switchpass", source), (text) =>
      syntheticFile(sw, "__switchpass", text),
    );
    const synthetic = file.getFunctions()[0];
    // A flag a closure in a clause sets (a try's block, lowered, that returns) is a cell, as any
    // name a closure rebinds is (#1292): the function's cells were found before the pass existed.
    if (synthetic !== undefined)
      for (const name of cellNames(synthetic))
        if (name === cont || name === ret || name === value) this.cells.add(name);
    const first = synthetic?.getBody()?.asKind(SyntaxKind.Block)?.getStatements()[0];
    // With a continue, the block sits in a loop of the synthetic function only so it parses: the
    // block is what replaces the switch, inside the real loop, and its continue is that loop's.
    return this.noteExits(
      continues.length > 0 ? first?.asKind(SyntaxKind.WhileStatement)?.getStatement() : first,
    );
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
    // An if whose only exits are throws, both of whose sides go on, needs no tail: a throw ends its
    // path, so the rest after the if is the rest of every path that goes on (#1292). Taking the tail
    // (twice) or not, by its size, made the same program two graphs: a long one emitted and lifted
    // again crossed the size where a short one's source had not.
    if (both && throwsOnly(stmt)) return false;
    const size = tail.reduce((n, t) => n + t.getText().length, 0);
    return !(both && this.returnFrames.length === 0 && size > 4000);
  }

  /**
   * Whether a block's statements can run with `tail` after them. The tail reads the names outside
   * the block, as written: the block's own are put back where the tail starts (#1330), so a name
   * the block declares does not refuse it (before, it did: DEC-LIFT-BLOCK-TAIL-SHADOW-001).
   */
  private blockMayTake(block: import("ts-morph").Block, _tail: readonly Node[]): boolean {
    return containsExitOrLoopReturn(block);
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
    // A declaration hoisted ahead of the functions it calls, which call it (#1349), writes its cell.
    if (this.hoistedCells.has(name) && this.cells.has(name) && this.env.has(name))
      this.writeCell(name, value);
    else this.env.set(name, value);
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

  /** Whether the function being lifted has its own `arguments` (it is not an arrow). */
  ownsArguments = true;

  /**
   * The function's `arguments` (#1330): a captured one (an arrow's, the enclosing function's) is a
   * name; otherwise the platform's source for it in this graph, as it has always been read
   * (#1173), which is the function's own.
   */
  private argumentsValue(): ValueId {
    if (this.env.has(ARGUMENTS)) return this.resolveIdentifier(ARGUMENTS);
    return this.resolveIdentifier("arguments");
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
      extendsSomething(fn.getParent() as import("ts-morph").ClassDeclaration);
    // Its own: one in a function or class inside it is that function's (#1330).
    const supers = fn
      .getDescendantsOfKind(SyntaxKind.SuperKeyword)
      .filter(
        (k) =>
          receiverOwner(k) === fn ||
          (Node.isArrowFunction(fn) && receiverOwner(k) === receiverOwner(fn)),
      );
    // `super(..);`, or `const v = super(..);` as the TypeScript lowering writes it.
    const superStatement = (k: Node): boolean => {
      const call = k.getParent();
      if (!Node.isCallExpression(call) || call.getExpression() !== k) return false;
      const up = call.getParent();
      const statement = Node.isVariableDeclaration(up) ? up.getParent()?.getParent() : up;
      if (!(Node.isExpressionStatement(up) || Node.isVariableStatement(statement))) return false;
      // A statement of the constructor's body, or of a branch inside it (#1330): each path makes the
      // receiver once, and the receiver after an if is the join of its sides'. Not in a loop or a
      // nested function, where it could run other than once.
      for (let p = statement?.getParent(); p !== undefined; p = p.getParent()) {
        if (p === fn) return true;
        // In a try's block (#1330): the receiver is a cell, which the try's closure writes.
        if (
          Node.isTryStatement(p) &&
          derived &&
          k.getAncestors().some((a) => a.compilerNode === p.getTryBlock().compilerNode)
        )
          continue;
        // In an arrow of the constructor: the arrow makes the receiver when it runs (#1330).
        if (Node.isArrowFunction(p) && derived) continue;
        if (isFunctionLikeNode(p) || isLoopStatement(p) || Node.isTryStatement(p)) return false;
      }
      // An arrow that makes the receiver: one in a derived constructor, or a try's block lowered,
      // writing the receiver's cell (#1330).
      return Node.isArrowFunction(fn) && (receiverCell || inDerivedConstructor);
    };
    // The receiver of the constructor around, held in a cell this closure can write (#1330).
    const receiverCell = Node.isArrowFunction(fn) && this.cells.has(THIS) && this.env.has(THIS);
    const arrowOwner = Node.isArrowFunction(fn) ? receiverOwner(fn) : undefined;
    const inDerivedConstructor =
      arrowOwner !== undefined &&
      Node.isConstructorDeclaration(arrowOwner) &&
      extendsSomething(arrowOwner.getParent() as import("ts-morph").ClassDeclaration);
    // `super.name` (read or called) in a member of a derived class, or an arrow inside one: the
    // parent's member, with this function's receiver (#1294). A write through `super` is not.
    const superMember = (k: Node): boolean => {
      const access = k.getParent();
      // `super.name`, or `super[key]` (#1330).
      if (
        !(Node.isPropertyAccessExpression(access) || Node.isElementAccessExpression(access)) ||
        access.getExpression() !== k
      )
        return false;
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
    if (
      supers.length > 0 &&
      !supers.every(
        (k) =>
          ((derived || receiverCell || inDerivedConstructor) && superStatement(k)) ||
          superMember(k),
      )
    )
      return undefined;
    // `this` in an arrow is the enclosing receiver, captured like a name; in a function it is the
    // caller's receiver, so the closure is a `function` (#1276).
    const thisUses = [
      ...fn.getDescendantsOfKind(SyntaxKind.ThisKeyword),
      // `super.name` reads with the receiver: it uses `this` as much as `this.name` does.
      ...supers.filter(superMember),
      // An arrow's `super(..)` writes the receiver's cell (#1330).
      ...(receiverCell ? supers.filter((k) => !superMember(k)) : []),
    ].filter(
      (t) =>
        receiverOwner(t) === fn ||
        (Node.isArrowFunction(fn) && receiverOwner(t) === receiverOwner(fn)),
    );
    // `arguments` is a function's own (#1330): read in it, or in an arrow inside it, which captures
    // it as it captures `this`. An arrow with no function around it has none.
    const argumentsUses = closureLocals(fn).has("arguments")
      ? []
      : fn
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (id) =>
              id.getText() === "arguments" &&
              isValueRead(id) &&
              (receiverOwner(id) === fn ||
                (Node.isArrowFunction(fn) && receiverOwner(id) === receiverOwner(fn))),
          );
    const lexicalArguments = Node.isArrowFunction(fn) && argumentsUses.length > 0;
    if (lexicalArguments && !this.env.has(ARGUMENTS) && !this.ownsArguments) return undefined;
    const lexicalThis = Node.isArrowFunction(fn) && thisUses.length > 0;
    // A derived constructor has its own receiver, made by its `super(..)`, used or not.
    const dynamicThis =
      !Node.isArrowFunction(fn) && (thisUses.length > 0 || derived || argumentsUses.length > 0);
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
      // A destructuring rebinds the names it assigns, not its property names (#1330).
      const names = assignedNames(t);
      return t
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => names.includes(id.getText()) && !isPropertyKey(id))
        .some(outer);
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
    // A class's or function's own name is bound by it, though a platform name too (`class URL`, #1292).
    const platform = (name: string): boolean =>
      !this.env.has(name) &&
      !this.imports.has(name) &&
      name !== this.classSelf &&
      name !== this.functionSelf &&
      (this.ambient.has(name) || RUNTIME_PRIMITIVES.has(name));
    const captures = outerReads.filter(
      (name) => !platform(name) && !(name === "arguments" && !locals.has("arguments")),
    );
    if (lexicalThis) captures.push(THIS);
    if (lexicalArguments) captures.push(ARGUMENTS);
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
    // A write to another binding of the same name (a parameter of another function, a block's own
    // `let`) does not change the one the closure captures.
    const sameBinding = (id: Node, name: string): boolean =>
      bindingScope(id, name) === bindingScope(fn, name);
    const changesCapture = (t: Node): boolean => {
      // A destructuring assignment rebinds every name in it, under the same rules as a single
      // name: a shared one, or one rebound before the closure is made, does not change it (#1173).
      if (Node.isArrayLiteralExpression(t) || Node.isObjectLiteralExpression(t)) {
        return t
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some(
            (id) =>
              captures.includes(id.getText()) &&
              sameBinding(id, id.getText()) &&
              !shared(id.getText()) &&
              !doneBefore(t),
          );
      }
      const base = baseIdentifierOfTarget(t);
      if (base === undefined || !captures.includes(base)) return false;
      if (!Node.isIdentifier(t)) return false;
      if (!sameBinding(t, base)) return false;
      if (shared(base)) return false;
      if (perPass(t, base)) return false;
      return !doneBefore(t);
    };
    // A `for (let i ..; ..; i++)` header's write, to a name the closure in the loop's body captures
    // (#1330): each pass has its own binding, copied from the last before the incrementor writes the
    // copy, so the closure holds the value of the pass it was made in: a value, as a capture is. A
    // write in the body is another target, and is judged as any other.
    const perPass = (t: Node, name: string): boolean => {
      const loop = t.getAncestors().find((a) => Node.isForStatement(a));
      if (loop === undefined || !Node.isForStatement(loop)) return false;
      const inc = loop.getIncrementor();
      if (inc === undefined || !inc.getDescendants().some((d) => d.compilerNode === t.compilerNode))
        return false;
      const init = loop.getInitializer();
      if (init === undefined || !Node.isVariableDeclarationList(init)) return false;
      if (init.getDeclarationKind() === "var") return false;
      if (!init.getDeclarations().some((d) => patternNames(d.getNameNode()).includes(name)))
        return false;
      return fn.getAncestors().some((a) => a.compilerNode === loop.getStatement().compilerNode);
    };
    // Only the closure's own enclosing function can change a capture under it: an assignment in a
    // scope further out was settled there (a cell, or a value captured by the closure in between).
    const withinScope = (t: Node): boolean =>
      fnScope === undefined ||
      t.getAncestors().some((a) => a.compilerNode === fnScope.compilerNode);
    if (outside.filter(withinScope).some(changesCapture)) return undefined;

    let graph: DucGraph;
    // Two captures of one outer value are one capture (#1292): `const self = this` read in an arrow
    // that also uses `this` (or `super`) is the receiver twice. Found without making a node: a name's
    // current value, or the receiver.
    const pureValue = (name: string): ValueId | undefined =>
      name === THIS
        ? this.env.has(THIS)
          ? this.cells.has(THIS)
            ? undefined
            : this.env.get(THIS)
          : this.receiver
        : name === ARGUMENTS || this.bindings.has(name) || this.cells.has(name)
          ? undefined
          : this.env.get(name);
    const aliasOf = new Map<string, string>();
    const firstOf = new Map<ValueId, string>();
    for (const name of captures) {
      const v = pureValue(name);
      if (v === undefined) continue;
      const first = firstOf.get(v);
      if (first !== undefined) aliasOf.set(name, first);
      else firstOf.set(v, name);
    }
    const unique = captures.filter((name) => !aliasOf.has(name));
    try {
      const inner = new Lifter(this.ambient);
      for (const [name, binding] of this.imports) inner.imports.set(name, binding);
      // A member reads its class as `class-self`; a closure inside it captures that value.
      inner.classSelf = classSelf;
      inner.functionSelf = selfOf;
      inner.derived = derived;
      inner.ownsArguments = !Node.isArrowFunction(fn);
      for (const name of captures) if (this.bindings.has(name)) inner.bindings.add(name);
      // A binding outside the atom the closure only writes is still that binding inside it, for a
      // closure within it that writes it too (#1330): `let d = function () { try { .. } catch {
      // d = g; } }` at a module's top level.
      for (const t of assignmentTargets(fn))
        for (const name of assignedNames(t))
          if (this.bindings.has(name) && !closureLocals(fn).has(name)) inner.bindings.add(name);
      graph = inner.liftClosureBody(
        fn,
        unique,
        unique.filter((name) => this.cells.has(name)),
        aliasOf,
      );
    } catch {
      return undefined;
    }
    const inputs = unique.map((name) =>
      name === THIS
        ? this.cells.has(THIS) && this.env.has(THIS)
          ? (this.env.get(THIS) as ValueId)
          : this.thisValue()
        : name === ARGUMENTS
          ? this.argumentsValue()
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
   * Once per name in a scope: another scope's declaration of the name is its own cell (#1331).
   */
  private hoistCell(name: string, scope: Set<string>): void {
    if (scope.has(name)) return;
    scope.add(name);
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
    aliasOf: ReadonlyMap<string, string> = new Map(),
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
    // A name whose outer value another capture holds is that capture inside.
    for (const [name, target] of aliasOf) this.env.set(name, this.env.get(target) as ValueId);
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
    // In a function, a read is of an outer name when no scope inside it declares the name where it
    // is read: a nested loop's own `m` does not hide the function's read of the outer one (#1330).
    const fn = isFunctionLikeNode(node);
    const names = new Set<string>();
    for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!isValueRead(id)) continue;
      const name = id.getText();
      if (fn ? !declaredWithin(id, node) : !locals.has(name)) names.add(name);
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
      // A function hoisted over it reads it through a cell, which the declaration writes (#1330).
      if (this.hoistedCells.has(name) && this.cells.has(name) && this.env.has(name))
        this.writeCell(name, value);
      else this.env.set(name, value);
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
      // A block's own names (let, const, class, function) are its scope's: after it, and in the
      // rest of the scope when the block takes that rest (`cont`), a name it declares is the
      // binding outside it again (#1330). Nothing inside the block can change that binding: the
      // block's own shadows it everywhere in the block.
      const own = blockLexicalNames(node);
      const outer = new Map(own.map((n) => [n, this.env.get(n)] as const));
      const first = cont?.[0];
      if (first !== undefined && own.length > 0) this.tailScopes.set(first.compilerNode, outer);
      this.lastBlockExited = this.liftStatements(node.getStatements(), cont);
      this.restoreScope(outer);
      return;
    }
    if (Node.isSwitchStatement(node) || Node.isTryStatement(node)) {
      this.liftOpaqueRegion(node, "op");
      return;
    }
    // An empty statement computes nothing.
    // `debugger` is an implementation's hook, and does nothing where no debugger is attached
    // (ECMA-262 14.16): no target of the graph has one, so it is the empty statement (#1368).
    if (Node.isEmptyStatement(node) || Node.isDebuggerStatement(node)) return;
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
    // Not for an if whose only exits are throws (#1292): no path through it returns, and the rest of
    // the function is the rest of the paths that go on.
    if (
      sides === undefined &&
      containsDirectExit(node) &&
      !(this.exitMode === "function" && throwsOnly(node))
    )
      this.ensureReturnState();
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

    // A derived constructor's receiver made on the sides (#1330): it is live after the if when every
    // side that falls through made it. It joins as a name would; the join's before-value is never read.
    if (!before.has(THIS)) {
      const made = [
        ...(thenDead ? [] : [thenEnv.get(THIS)]),
        ...(elseDead ? [] : [elseEnv.get(THIS)]),
      ];
      if (made.length > 0 && made.every((v) => v !== undefined)) {
        before.set(THIS, made[0] as ValueId);
      }
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
    const file = syntheticFile(
      node,
      "__tested",
      `${syntheticFunction(node)} __tested() {\n${text}\n}`,
    );
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
      ...byDeclaration(
        node,
        assigned.filter((name) => this.env.has(name)),
      ),
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
        // With no continue of its own, a `for` loop's update is the last statement of its body
        // (`for (..; c; u) B` is `while (c) { B; u }`): a statement that takes the rest of the body
        // onto its sides takes the update too, as it would the same update written in the body
        // (#1292, the round trip).
        const update =
          incrementor !== undefined && !loopJumpsOf(node).some((j) => Node.isContinueStatement(j))
            ? syntheticFile(node, "__update", `${incrementor.getText()};`).getStatements()[0]
            : undefined;
        const tail = update !== undefined ? [update] : [];
        const tookUpdate =
          guard !== undefined
            ? this.withThrowExits(node, true, () => this.liftStatements(guard.rest, tail))
            : Node.isBlock(body)
              ? this.liftStatements(body.getStatements(), tail)
              : this.liftStatement(body, tail);
        // A body that throws on every path still may run no iterations.
        this.dead = false;
        if (incrementor !== undefined && !(update !== undefined && tookUpdate)) {
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
    const of: IterateKind = Node.isForOfStatement(node)
      ? node.isAwaited()
        ? "async values"
        : "values"
      : "keys";
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
    const carried = [...byDeclaration(node, assigned), ...exitNames, HEAP];
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
          // The written guard, first, and again last when a lowering tests it after each pass too.
          const trailing = guard !== undefined && trailingIterateGuard(node) !== undefined ? 1 : 0;
          this.withThrowExits(node, guard !== undefined, () =>
            this.liftStatements(
              guard !== undefined ? statements.slice(1, statements.length - trailing) : statements,
              [],
            ),
          );
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
      label: ITERATE_LABEL[of],
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
    // A destructuring assignment's targets are every name its pattern writes (`({ a: x, b } = o)`,
    // `[x, , ...y] = xs`, defaults and nested patterns included).
    const considerPattern = (target: Node): void => {
      if (Node.isParenthesizedExpression(target)) {
        considerPattern(target.getExpression());
        return;
      }
      if (Node.isObjectLiteralExpression(target)) {
        for (const p of target.getProperties()) {
          if (Node.isShorthandPropertyAssignment(p)) consider(p.getNameNode());
          else if (Node.isPropertyAssignment(p)) {
            const init = p.getInitializer();
            if (init !== undefined) considerPattern(init);
          } else if (Node.isSpreadAssignment(p)) considerPattern(p.getExpression());
        }
        return;
      }
      if (Node.isArrayLiteralExpression(target)) {
        for (const el of target.getElements()) {
          if (Node.isSpreadElement(el)) considerPattern(el.getExpression());
          else if (!Node.isOmittedExpression(el)) considerPattern(el);
        }
        return;
      }
      // A default (`x = 1` in a pattern) writes its left side.
      if (
        Node.isBinaryExpression(target) &&
        target.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      )
        considerPattern(target.getLeft());
      else consider(target);
    };
    for (const bin of bins) {
      const op = bin.getOperatorToken().getKind();
      if (op === SyntaxKind.EqualsToken) considerPattern(bin.getLeft());
      else if (COMPOUND_ASSIGN.has(op)) consider(bin.getLeft());
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
    const overridden = this.chainBases.get(node.compilerNode);
    if (overridden !== undefined) return overridden;
    // `a?.b.c`: the whole chain short-circuits on its first optional link (#1360).
    const optionalLink = this.innermostOptionalLink(node);
    if (optionalLink !== undefined) return this.liftOptionalChain(node, optionalLink);
    if (node.getKind() === SyntaxKind.ThisKeyword) return this.thisValue();
    // `new.target` and `import.meta` are what the platform gives the call or the module, read like
    // a platform primitive by their text (#1173).
    if (Node.isMetaProperty(node)) return this.resolveName(node.getText());
    if (Node.isIdentifier(node)) {
      // `undefined`, unless a binding shadows it, is the literal: the same value a bare `return;` has.
      if (node.getText() === "undefined" && !this.env.has("undefined"))
        return this.undefinedValue();
      // `arguments`, unless a binding shadows it, is the function's own (#1330).
      if (
        node.getText() === "arguments" &&
        !this.env.has("arguments") &&
        !this.bindings.has("arguments") &&
        (this.ownsArguments || this.env.has(ARGUMENTS))
      )
        return this.argumentsValue();
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
      // The operator is structure: `-x` and `+x`, `++x` and `x++` are different operations.
      const token = ts.tokenToString(node.getOperatorToken()) ?? node.getKindName();
      const value = this.liftExpr(operand);
      // `o[k]++` reads and writes the member of one lifting of `o` and `k`.
      const target =
        (token === "++" || token === "--") && this.plainMember(operand)
          ? this.targetOfRead(operand, value)
          : undefined;
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
      // ++/-- writes its operand: a binding is reassigned, a member written (`o.x++`, `o[k]--`,
      // `this.#n++`), as `x += 1` would. No other unary operator does: `-x` leaves x as it is.
      const steps = token === "++" || token === "--";
      if (
        steps &&
        (Node.isPropertyAccessExpression(operand) || Node.isElementAccessExpression(operand))
      )
        this.assignTo(operand, out as ValueId, target);
      else if (steps && Node.isIdentifier(operand) && this.isBinding(operand.getText()))
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
    // `import(specifier)`: loading a module at run time, a heap operation on its arguments whose value
    // is the promise of the module's namespace (#1292).
    if (Node.isCallExpression(node) && node.getExpression().getKind() === SyntaxKind.ImportKeyword)
      return this.emit("op", this.liftElements(node.getArguments() as Node[]), 1, {
        origin: { kind: "ImportCall", text: truncate(node.getText()) },
        label: "import()",
        heap: true,
      })[0] as ValueId;
    if (Node.isCallExpression(node) && Node.isSuperExpression(node.getExpression())) {
      // `super(args)` in a derived constructor (#1276): it makes the receiver, so it is `this` after.
      const [made] = this.emit("op", this.liftElements(node.getArguments() as Node[]), 1, {
        origin: { kind: "SuperCall", text: truncate(node.getText()) },
        label: "super",
        heap: true,
      });
      // A receiver held in a cell (an arrow made before the call reads it) is written there (#1330).
      if (this.cells.has(THIS) && this.env.has(THIS)) this.writeCell(THIS, made as ValueId);
      else this.env.set(THIS, made as ValueId);
      return made as ValueId;
    }
    if (Node.isCallExpression(node) && !this.optional(node)) {
      // `__yakccObjectRest(o, ["a", ..])`, the runtime's, as the TypeScript lowering writes an
      // object rest: the `ObjectRest` operation it stands for (#1330).
      const callee = node.getExpression();
      const [restOf, takenList] = node.getArguments();
      if (
        Node.isIdentifier(callee) &&
        callee.getText() === OBJECT_REST_PRIMITIVE &&
        this.isPlatformName(OBJECT_REST_PRIMITIVE) &&
        node.getArguments().length === 2 &&
        restOf !== undefined &&
        Node.isArrayLiteralExpression(takenList) &&
        takenList.getElements().every((e) => Node.isStringLiteral(e))
      ) {
        const taken = takenList
          .getElements()
          .map((e) => (e as import("ts-morph").StringLiteral).getLiteralValue());
        return this.emit("op", [this.liftExpr(restOf)], 1, {
          origin: { kind: "Destructure", text: truncate(node.getText()) },
          label: `ObjectRest:${JSON.stringify(taken)}`,
        })[0] as ValueId;
      }
    }
    if (Node.isCallExpression(node) && !this.optional(node)) {
      // `Math.sin(x)`, with `Math` the platform's: the operation `Math.sin`, a reference to the atom
      // that implements it (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1362). Pure, as `+` is.
      const op = this.operationCall(node);
      if (op !== undefined)
        return this.emit("op", this.liftElements(node.getArguments() as Node[]), 1, {
          origin: { kind: "Operation", text: truncate(node.getText()) },
          label: op,
        })[0] as ValueId;
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
            : `${this.optional(callee) ? "?." : "."}${callee.getName()}`,
        });
        inputs.push(method as ValueId, ...args);
      } else if (callee !== undefined && Node.isElementAccessExpression(callee)) {
        // So is a method looked up by a key, `o[k](args)`: the object and the key first, then the
        // arguments, then the lookup. `super[k](args)` is the parent's member k, called with this
        // function's receiver (#1330).
        const viaSuper = Node.isSuperExpression(callee.getExpression());
        const base = viaSuper ? this.thisValue() : this.liftExpr(callee.getExpression());
        const key = this.liftExpr(callee.getArgumentExpressionOrThrow());
        const args = this.liftElements(node.getArguments() as Node[]);
        const [method] = this.emit("op", [base, key], 1, {
          origin: { kind: "ElementAccess" },
          ...(viaSuper
            ? { label: "super[]" }
            : this.optional(callee)
              ? { label: "ElementAccess?." }
              : {}),
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
        let fn = callee !== undefined ? this.liftExpr(callee) : undefined;
        // A function read into a name and then called has no receiver: `const m = o.m; m()` is not
        // `o.m()`. A call of a member read's value means the method call, so the name's value is
        // `(0, m)`, as a lowering writes it (#1330).
        if (
          fn !== undefined &&
          callee !== undefined &&
          !this.isMemberCallee(callee) &&
          this.isMemberRead(fn)
        ) {
          const [zero] = this.emit("literal-source", [], 1, {
            origin: { kind: "NumericLiteral", text: "0" },
            label: "0",
          });
          fn = this.emit("op", [zero as ValueId, fn], 1, {
            origin: { kind: "Binary", text: "," },
            label: ",",
          })[0] as ValueId;
        }
        if (fn !== undefined) inputs.push(fn);
        inputs.push(...this.liftElements(node.getArguments() as Node[]));
      }
      const optional = Node.isCallExpression(node) && this.optional(node);
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
    if (Node.isElementAccessExpression(node) && Node.isSuperExpression(node.getExpression())) {
      // `super[k]`: the parent's member k, read with this function's receiver (#1330).
      return this.emit(
        "op",
        [this.thisValue(), this.liftExpr(node.getArgumentExpressionOrThrow())],
        1,
        { origin: { kind: "ElementAccess", text: truncate(node.getText()) }, label: "super[]" },
      )[0] as ValueId;
    }
    if (Node.isPropertyAccessExpression(node)) {
      // The member name is structure: `o.a` and `o.b` are different reads.
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: "PropertyAccess", text: truncate(node.getText()) },
        label: `${this.optional(node) ? "?." : "."}${node.getName()}`,
      })[0] as ValueId;
    }
    if (Node.isElementAccessExpression(node)) {
      const inputs = [
        this.liftExpr(node.getExpression()),
        this.liftExpr(node.getArgumentExpressionOrThrow()),
      ];
      return this.emit("op", inputs, 1, {
        origin: { kind: "ElementAccess" },
        ...(this.optional(node) ? { label: "ElementAccess?." } : {}),
      })[0] as ValueId;
    }
    if (Node.isSpreadElement(node)) {
      return this.emit("op", [this.liftExpr(node.getExpression())], 1, {
        origin: { kind: "SpreadElement" },
        label: "...",
      })[0] as ValueId;
    }
    if (Node.isArrayLiteralExpression(node)) {
      const elements = node.getElements();
      const holes = elements.flatMap((el, i) => (Node.isOmittedExpression(el) ? [i] : []));
      const inputs = this.liftElements(elements.filter((el) => !Node.isOmittedExpression(el)));
      // A hole (`[, a]`) is no element at all, not `undefined`: its positions are structure (#1330).
      return this.emit("op", inputs, 1, {
        origin: { kind: "ArrayLiteral" },
        ...(holes.length > 0 ? { label: `array-with-holes:${JSON.stringify(holes)}` } : {}),
      })[0] as ValueId;
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
    // `#x in o`: whether o has the private name of the nearest class that declares it (#1330).
    if (op === SyntaxKind.InKeyword && Node.isPrivateIdentifier(left))
      return this.emit("op", [this.liftExpr(node.getRight())], 1, {
        origin: { kind: "Binary", text: truncate(node.getText()) },
        label: `in:${left.getText()}`,
        heap: true,
      })[0] as ValueId;
    if (op === SyntaxKind.EqualsToken) {
      const target = this.plainMember(left) ? this.memberTarget(left) : undefined;
      const value = this.liftExpr(node.getRight());
      this.assignTo(left, value, target);
      return value;
    }
    if (COMPOUND_ASSIGN.has(op)) {
      // `x += e` reads the old value and the rhs, then rebinds.
      const oldValue = this.liftExpr(left);
      const target = this.plainMember(left) ? this.targetOfRead(left, oldValue) : undefined;
      const rhs = this.liftExpr(node.getRight());
      const [out] = this.emit("op", [oldValue, rhs], 1, {
        origin: { kind: node.getKindName() },
        label: node.getOperatorToken().getText(),
      });
      this.assignTo(left, out as ValueId, target);
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

  /**
   * A member target's object, and its key for `o[k]`, lifted once and before the value written
   * (#1292): JavaScript evaluates `o` and `k` in `o[k] = v` before `v`, and in `o[k] += v` reads
   * `o[k]` with them, so a `v` that changes `k` (a cell a call rebinds) does not move the write.
   * Undefined for any other target.
   */
  private memberTarget(lhs: Node): ValueId[] | undefined {
    if (Node.isParenthesizedExpression(lhs)) return this.memberTarget(lhs.getExpression());
    if (Node.isPropertyAccessExpression(lhs)) return [this.liftExpr(lhs.getExpression())];
    if (Node.isElementAccessExpression(lhs))
      return [
        this.liftExpr(lhs.getExpression()),
        this.liftExpr(lhs.getArgumentExpressionOrThrow()),
      ];
    return undefined;
  }

  /**
   * A member target `memberTarget` takes: `o.a` or `o[k]` on an object, not through `super`, and
   * not a private name (`this.#x`), whose reads and writes are their own.
   */
  private plainMember(lhs: Node): boolean {
    const n = Node.isParenthesizedExpression(lhs) ? lhs.getExpression() : lhs;
    if (!(Node.isPropertyAccessExpression(n) || Node.isElementAccessExpression(n))) return false;
    if (Node.isSuperExpression(n.getExpression())) return false;
    return !(Node.isPropertyAccessExpression(n) && Node.isPrivateIdentifier(n.getNameNode()));
  }

  /**
   * The object and key a member read just made took (`o` and `k` of `o[k]`), when the read is the
   * plain one, so a write of the member uses them rather than lifting them again. Undefined when the
   * read was another form (a platform member, a binding's), which the write lifts as before.
   */
  private targetOfRead(lhs: Node, read: ValueId): ValueId[] | undefined {
    const n = Node.isParenthesizedExpression(lhs) ? lhs.getExpression() : lhs;
    let node: MutableNode | undefined;
    for (let i = this.nodes.length - 1; i >= 0 && node === undefined; i--)
      if (this.nodes[i]?.outputs[0] === read) node = this.nodes[i];
    if (node === undefined || node.kind !== "op") return undefined;
    // A heap operation's last input is the token it is ordered after, which `emit` adds.
    const given = node.order === 1 ? node.inputs.slice(0, -1) : [...node.inputs];
    if (Node.isPropertyAccessExpression(n))
      return node.label === `.${n.getName()}` && given.length === 1 ? given : undefined;
    return node.label === "ElementAccess" && given.length === 2 ? given : undefined;
  }

  /** Reassign an lvalue. Identifier -> rebind; member/element -> mutate base object. */
  private assignTo(lhs: Node, value: ValueId, target?: readonly ValueId[]): void {
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
      // For `arr[i] = v`, the index chooses which slot is written, so it
      // influences the mutated object; include it as an input.
      const inputs = [...(target ?? this.memberTarget(lhs) ?? [])];
      inputs.push(value);
      const label = Node.isPropertyAccessExpression(lhs) ? `.${lhs.getName()}=` : "[]=";
      const [mutated] = this.emit("op", inputs, 1, { origin: { kind: "Write" }, label });
      // The base name is the written object after the write, unless it is a cell, which holds it,
      // or a binding outside the atom, whose value is the binding itself (#1292): a later
      // `name = v` writes that binding.
      if (
        Node.isIdentifier(base) &&
        this.env.has(base.getText()) &&
        !this.cells.has(base.getText()) &&
        !this.isBinding(base.getText())
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
      this.assignTo(lhs.getExpression(), value, target);
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

  /**
   * The operation a call is, when it calls a member of the platform's `Math` that is an operation
   * reference with as many plain arguments as it takes (`Math.sin(x)`); undefined otherwise.
   */
  private operationCall(call: CallExpression): string | undefined {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || this.optional(callee)) return undefined;
    const object = callee.getExpression();
    if (!Node.isIdentifier(object) || object.getText() !== "Math") return undefined;
    const args = call.getArguments();
    if (args.some((a) => Node.isSpreadElement(a))) return undefined;
    if (mathOperation(callee.getName(), args.length) === undefined) return undefined;
    return this.isPlatformName("Math") ? `Math.${callee.getName()}` : undefined;
  }

  /** Whether a name, read here, is the platform's: nothing in or around the atom binds it. */
  private isPlatformName(name: string): boolean {
    return (
      !this.env.has(name) &&
      !this.imports.has(name) &&
      !this.bindings.has(name) &&
      !this.cells.has(name) &&
      name !== this.functionSelf &&
      name !== this.classSelf &&
      (this.ambient.has(name) || RUNTIME_PRIMITIVES.has(name))
    );
  }

  /**
   * Whether a link of a chain is written optional (`?.`) and is still one: a link whose chain has
   * already been tested by `liftOptionalChain` reads plainly.
   */
  private optional(n: Node): boolean {
    return (
      (Node.isPropertyAccessExpression(n) ||
        Node.isElementAccessExpression(n) ||
        Node.isCallExpression(n)) &&
      n.hasQuestionDotToken() &&
      !this.plainLinks.has(n.compilerNode)
    );
  }

  /**
   * For the outermost expression of an optional chain, its optional link nearest the base, when that
   * link is not the expression itself (`a?.b.c`, `a?.m(1)`, `a?.b?.c`); undefined otherwise. A chain
   * of one optional link (`a?.b`, `a?.[k]`, `f?.()`) is an operation of its own.
   */
  private innermostOptionalLink(node: Node): Node | undefined {
    const inChain = (n: Node): n is Node & { getExpression(): Node } =>
      (Node.isPropertyAccessExpression(n) ||
        Node.isElementAccessExpression(n) ||
        Node.isCallExpression(n) ||
        Node.isNonNullExpression(n)) &&
      (n.compilerNode.flags & ts.NodeFlags.OptionalChain) !== 0;
    if (!inChain(node)) return undefined;
    const parent = node.getParent();
    if (parent !== undefined && inChain(parent) && parent.getExpression() === node)
      return undefined;
    let innermost: Node | undefined;
    for (let at: Node = node; inChain(at); at = at.getExpression())
      if (this.optional(at)) innermost = at;
    return innermost === node ? undefined : innermost;
  }

  /**
   * An optional chain, as ECMAScript evaluates it (#1360): the base of its first optional link, then
   * a branch. When the base is null or undefined the chain is undefined and nothing after the base
   * runs; otherwise the rest of the chain reads the base plainly.
   */
  private liftOptionalChain(node: Node, link: Node): ValueId {
    const baseNode = (link as Node & { getExpression(): Node }).getExpression();
    const base = this.liftExpr(baseNode);
    const [nullValue] = this.emit("literal-source", [], 1, {
      origin: { kind: "NullKeyword", text: "null" },
      label: "null",
    });
    const [isNullish] = this.emit("op", [base, nullValue as ValueId], 1, {
      origin: { kind: "Binary", text: "==" },
      label: "==",
    });
    return this.liftLazy(
      isNullish as ValueId,
      () => this.undefinedValue(),
      () => {
        this.plainLinks.add(link.compilerNode);
        this.chainBases.set(baseNode.compilerNode, base);
        try {
          return this.liftExpr(node);
        } finally {
          this.plainLinks.delete(link.compilerNode);
          this.chainBases.delete(baseNode.compilerNode);
        }
      },
    );
  }

  /** Whether a call's callee is written as a member access (`o.m`, `o[k]`, `(o.m)`): a method call. */
  private isMemberCallee(callee: Node): boolean {
    let c = callee;
    while (Node.isParenthesizedExpression(c)) c = c.getExpression();
    return Node.isPropertyAccessExpression(c) || Node.isElementAccessExpression(c);
  }

  /** Whether a value is a member read's result (`.m`, `?.m`, `[k]`, `super.m`): a method if called. */
  private isMemberRead(v: ValueId): boolean {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i] as DucNode;
      if (!n.outputs.includes(v)) continue;
      const label = n.kind === "op" ? (n.label ?? "") : "";
      return (
        ((label.startsWith(".") || label.startsWith("?.")) &&
          label.length > 1 &&
          !label.endsWith("=")) ||
        label.startsWith("super.") ||
        label === "super[]" ||
        label === "ElementAccess" ||
        label === "ElementAccess?."
      );
    }
    return false;
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

/**
 * The scope whose binding of `name` a reference at `node` resolves to: the nearest enclosing scope
 * (above `node` itself) that declares it, or undefined for a name no scope here declares.
 */
function bindingScope(node: Node, name: string): object | undefined {
  for (let p: Node | undefined = node.getParent(); p !== undefined; p = p.getParent())
    if (scopeNames(p).has(name)) return p.compilerNode;
  return undefined;
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
  // A named class expression's name is bound inside it, as a named function expression's is
  // (#1292): it was checked only among function-like nodes, which a class is not.
  if (Node.isClassExpression(scope)) {
    const own = scope.getName();
    if (own !== undefined) names.add(own);
  }
  if (isFunctionLikeNode(scope)) {
    const f = scope as FunctionLike;
    for (const p of f.getParameters()) add(p.getNameNode());
    if (Node.isFunctionExpression(scope)) {
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
 * bound by a `for` header, or a `var` inside a loop, is left out: JavaScript copies the first from one
 * pass's binding to the next and gives the second one binding for all passes, and a cell made at the
 * declaration is neither. A `for-of` or `for-in` header's `let` is in: its binding is new each pass,
 * and so is its cell, made where the element is bound (#1330).
 */
function cellNames(scope: Node): Set<string> {
  // A try statement's blocks are closures once it is lowered (Lifter.lowerTry): they count as nested.
  // So does a class's static block: a closure run with the class as its receiver (#1368).
  const nested = scope
    .getDescendants()
    .filter(
      (d) =>
        isFunctionLikeNode(d) ||
        Node.isClassStaticBlockDeclaration(d) ||
        (Node.isBlock(d) && Node.isTryStatement(d.getParent())) ||
        Node.isCatchClause(d),
    );
  if (nested.length === 0) return new Set();
  const insideNested = (n: Node): boolean => {
    for (const a of n.getAncestors()) {
      if (a.compilerNode === scope.compilerNode) return false;
      if (isFunctionLikeNode(a) || Node.isClassStaticBlockDeclaration(a)) return true;
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
    // A for-of or for-in header's let is bound anew each pass, where bindPattern makes its cell
    // (#1330); a for header's is copied from pass to pass, and a var header's is one for all passes.
    if (header !== undefined && Node.isForStatement(header)) continue;
    if (
      header !== undefined &&
      (Node.isForOfStatement(header) || Node.isForInStatement(header)) &&
      Node.isVariableDeclarationList(list) &&
      list.getDeclarationKind() === "var"
    )
      continue;
    if (Node.isVariableDeclarationList(list) && list.getDeclarationKind() === "var" && inLoop(decl))
      continue;
    for (const name of patternNames(decl.getNameNode())) declared.add(name);
  }
  const out = new Set<string>();
  for (const fn of nested) {
    const locals = closureLocals(fn);
    if (!isFunctionLikeNode(fn) && !Node.isClassStaticBlockDeclaration(fn)) {
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
  // A name is free where it is written when no scope around the write, up to `file`, declares it: a
  // function or class expression's own name, or a parameter, binds only inside it (#1330).
  const written: string[] = [];
  for (const t of assignmentTargets(file)) {
    const names = assignedNames(t);
    const ids = Node.isIdentifier(t)
      ? [t]
      : t
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => names.includes(id.getText()) && !isPropertyKey(id));
    for (const id of ids) {
      const name = id.getText();
      if (!declaredWithin(id, file) && !written.includes(name)) written.push(name);
    }
  }
  return written;
}

/** Whether an identifier is the key of a property assignment (`k` in `{ k: v }`), not a name. */
function isPropertyKey(id: Node): boolean {
  const p = id.getParent();
  return Node.isPropertyAssignment(p) && p.getNameNode() === id;
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
/**
 * The names a statement declares in the scope it is in: those of a variable statement and of a
 * named function or class declaration.
 */
/** The names a block declares for its own scope: let, const, class and function, not var. */
function blockLexicalNames(block: import("ts-morph").Block): string[] {
  return block.getStatements().flatMap((st) => {
    if (Node.isVariableStatement(st))
      return st.getDeclarationKind() === "var"
        ? []
        : st.getDeclarations().flatMap((d) => patternNames(d.getNameNode()));
    if ((Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) && st.getName())
      return [st.getName() as string];
    return [];
  });
}

function topLevelDeclaredNames(stmt: Node): string[] {
  if (Node.isVariableStatement(stmt))
    return stmt.getDeclarations().flatMap((d) => patternNames(d.getNameNode()));
  if ((Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)) && stmt.getName())
    return [stmt.getName() as string];
  return [];
}

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
      member.getBody() !== undefined &&
      // A computed name that does work (`[(a = new WeakMap(), Symbol.iterator)]() {..}`, as the
      // TypeScript lowering writes a class's private state) runs where the class is defined: the
      // atom is the class with that member, not only the member's function (#1368).
      !(
        !Node.isConstructorDeclaration(member) &&
        Node.isComputedPropertyName(member.getNameNode()) &&
        !isInert((member.getNameNode() as import("ts-morph").ComputedPropertyName).getExpression())
      )
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

/**
 * Whether a switch lowers to one pass of a loop (see lowerSwitchAsPass), and the continues and
 * returns it leaves the pass by: those with no loop or switch between them and it, of its own
 * function. Undefined for a labelled break or continue of its own, a continue of a loop or switch
 * within it, and a name a clause declares and another clause reads (the clauses share one scope).
 */
function switchPassShape(sw: import("ts-morph").SwitchStatement):
  | {
      readonly continues: readonly Node[];
      readonly returns: readonly Node[];
    }
  | undefined {
  const clauses = sw.getCaseBlock().getClauses();
  const own = (n: Node): boolean => !isInsideNestedFunction(n, sw);
  const nearestBreakable = (n: Node): Node | undefined =>
    n
      .getAncestors()
      .find(
        (a) =>
          isLoopStatement(a) || Node.isSwitchStatement(a) || a.compilerNode === sw.compilerNode,
      );
  const loopInside = (c: Node): boolean => {
    for (const a of c.getAncestors()) {
      if (a.compilerNode === sw.compilerNode) return false;
      if (isLoopStatement(a)) return true;
    }
    return false;
  };
  const continues = sw
    .getDescendantsOfKind(SyntaxKind.ContinueStatement)
    .filter((c) => own(c) && !loopInside(c));
  if (
    continues.some(
      (c) => c.getLabel() !== undefined || nearestBreakable(c)?.compilerNode !== sw.compilerNode,
    )
  )
    return undefined;
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
    // A property's name (`declaration.type`) is not the name `type` (#1368).
    const elsewhere = clauses
      .filter((c) => c !== clause)
      .flatMap((c) =>
        c
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((id) => isValueRead(id))
          .map((id) => id.getText()),
      );
    if (declared.some((name) => elsewhere.includes(name))) return undefined;
  }
  const returns = sw
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => own(r) && nearestBreakable(r)?.compilerNode === sw.compilerNode);
  return { continues, returns };
}

const passShapeCache = new WeakMap<object, ReturnType<typeof switchPassShape> | null>();

/**
 * Whether a switch is lifted as one opaque region: neither a chain of ifs (switchArms) nor a pass
 * (switchPassShape). An exit inside one that lowers is an exit of the statement it is in (#1368).
 */
function opaqueSwitch(sw: import("ts-morph").SwitchStatement): boolean {
  if (switchArms(sw) !== undefined) return false;
  let shape = passShapeCache.get(sw.compilerNode);
  if (shape === undefined) {
    shape = switchPassShape(sw) ?? null;
    passShapeCache.set(sw.compilerNode, shape);
  }
  return shape === null;
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
    } else if (
      !(
        last !== undefined &&
        (alwaysReturns(last) || (Node.isContinueStatement(last) && last.getLabel() === undefined))
      ) &&
      i !== clauses.length - 1
    ) {
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
  // A throw is no jump of the guard's: the body is lifted with its exits, so it ends its path (#1292).
  const jumps = loopJumpsOf(loop).filter((j) => !Node.isThrowStatement(j));
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

/**
 * Whether an iterating loop has a form the lifter expresses: one declared variable; `for await`
 * only where it can be, in an async function (#1330).
 */
function iterateLiftable(
  node: import("ts-morph").ForOfStatement | import("ts-morph").ForInStatement,
): boolean {
  if (Node.isForOfStatement(node) && node.isAwaited()) {
    const fn = node.getAncestors().find(isFunctionLikeNode);
    if (fn === undefined || !(fn as import("ts-morph").FunctionDeclaration).isAsync?.())
      return false;
  }
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
  const inner = guardBreak(first);
  if (inner === undefined) return undefined;
  // The guard, and the same guard again after the pass (emit-ts writes both, so a break leaves
  // before the next element is pulled, #1330).
  const last = trailingIterateGuard(loop);
  // A throw is no jump of the guard's: the body is lifted with its exits, so it ends its path (#1292).
  const jumps = loopJumpsOf(loop).filter((j) => !Node.isThrowStatement(j));
  const expected = last !== undefined ? [inner, last] : [inner];
  if (
    jumps.length !== expected.length ||
    jumps.some((j) => !expected.some((e) => e.compilerNode === j.compilerNode))
  )
    return undefined;
  const test = (first as import("ts-morph").IfStatement).getExpression();
  if (
    !Node.isPrefixUnaryExpression(test) ||
    test.getOperatorToken() !== SyntaxKind.ExclamationToken
  )
    return undefined;
  let c: Node = test.getOperand();
  while (Node.isParenthesizedExpression(c)) c = c.getExpression();
  return c;
}

/**
 * The function a construct rewritten as source is re-parsed in (a switch's pass, a tested loop): a
 * generator, or async, as the construct's own `yield` and `await` need, so they parse as written.
 */
/** How many synthetic files each lift's project has. */
const syntheticFiles = new WeakMap<Project, number>();

/**
 * A rewrite's source, parsed as a new file of the lift's project under a name no other file of it
 * has. A closure is lifted by its own lifter, whose counters start again: a name taken from them
 * would overwrite its parent's rewrite, and ts-morph forgets the nodes the parent is still lifting.
 */
function syntheticFile(near: Node, prefix: string, source: string): SourceFile {
  const project = near.getSourceFile().getProject();
  const n = syntheticFiles.get(project) ?? 0;
  syntheticFiles.set(project, n + 1);
  return project.createSourceFile(`${prefix}${n}.ts`, source);
}

function syntheticFunction(node: Node): string {
  const own = (n: Node): boolean => !isInsideNestedFunction(n, node);
  const yields = node.getDescendantsOfKind(SyntaxKind.YieldExpression).some(own);
  const awaits =
    node.getDescendantsOfKind(SyntaxKind.AwaitExpression).some(own) ||
    node.getDescendantsOfKind(SyntaxKind.ForOfStatement).some((f) => own(f) && f.isAwaited());
  return `${awaits ? "async " : ""}function${yields ? "*" : ""}`;
}

/** Whether a constructor's `super(..)` call is in a try statement's block. */
function superInTry(ctor: Node): boolean {
  return ctor
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some(
      (c) =>
        Node.isSuperExpression(c.getExpression()) &&
        receiverOwner(c) === ctor &&
        c.getAncestors().some((a) => Node.isTryStatement(a) && !isInsideNestedFunction(a, ctor)),
    );
}

/** Whether a constructor makes an arrow that reads `this` before its first `super(..)` call. */
function arrowReadsThisBeforeSuper(ctor: Node): boolean {
  const superCall = ctor
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => Node.isSuperExpression(c.getExpression()) && receiverOwner(c) === ctor);
  if (superCall === undefined) return false;
  return ctor
    .getDescendantsOfKind(SyntaxKind.ArrowFunction)
    .some(
      (arrow) =>
        arrow.getStart() < superCall.getStart() &&
        receiverOwner(arrow) === ctor &&
        arrow.getDescendantsOfKind(SyntaxKind.ThisKeyword).some((t) => receiverOwner(t) === ctor),
    );
}

/** For `if (..) break;` (or with the break in a block), the break; undefined for anything else. */
function guardBreak(st: Node | undefined): Node | undefined {
  if (st === undefined || !Node.isIfStatement(st) || st.getElseStatement() !== undefined)
    return undefined;
  const then = st.getThenStatement();
  const inner =
    Node.isBlock(then) && then.getStatements().length === 1 ? then.getStatements()[0] : then;
  return inner !== undefined && Node.isBreakStatement(inner) && inner.getLabel() === undefined
    ? inner
    : undefined;
}

/**
 * An iterating loop's last statement when it is the same `if (!(c)) break;` as its first: the
 * written condition, tested again after the pass. Its break, or undefined.
 */
function trailingIterateGuard(loop: Node): Node | undefined {
  const body = (loop as import("ts-morph").ForOfStatement).getStatement();
  if (!Node.isBlock(body)) return undefined;
  const statements = body.getStatements();
  if (statements.length < 2) return undefined;
  const first = statements[0] as Node;
  const last = statements[statements.length - 1] as Node;
  if (guardBreak(first) === undefined) return undefined;
  const brk = guardBreak(last);
  if (brk === undefined) return undefined;
  const text = (st: Node): string =>
    (st as import("ts-morph").IfStatement).getExpression().getText();
  return text(first) === text(last) ? brk : undefined;
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
    // A throw ends its path; one inside an inner loop is that loop's, and one inside a try is inside
    // the closures the try lowers to (#1330).
    ...loop.getDescendantsOfKind(SyntaxKind.ThrowStatement).filter((t) => {
      if (isInsideNestedFunction(t, loop) || outermostTry(t, loop) !== undefined) return false;
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
 * A try statement's blocks, the function's own names they declare with `var`, and whether they await:
 * what Lifter.lowerTry needs. Undefined when it cannot be lowered: a var that is not a plain name, a
 * yield, or a break or continue that leaves the statement.
 */
function tryShape(t: import("ts-morph").TryStatement):
  | {
      parts: import("ts-morph").Block[];
      vars: string[];
      awaits: boolean;
      yields: boolean;
      leaves: Node[];
    }
  | undefined {
  const leaves: Node[] = [];
  // The function the try is in: a yield inside moves into a generator closure, delegated to.
  const owner = t.getAncestors().find((a) => isFunctionLikeNode(a));
  const generator =
    owner !== undefined &&
    (Node.isFunctionDeclaration(owner) ||
      Node.isFunctionExpression(owner) ||
      Node.isMethodDeclaration(owner)) &&
    owner.isGenerator();
  let yields = false;
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
    // A yield moves into a generator closure, delegated to with yield* (#1330); an await moves into
    // an async one. A generator closure is a function: it does not see the receiver or arguments.
    // The receiver is passed in by name (lowerTry); `super` and `arguments` are not.
    if (part.getDescendantsOfKind(SyntaxKind.YieldExpression).some(own)) {
      if (!generator) return undefined;
      const usesOwn = part
        .getDescendantsOfKind(SyntaxKind.SuperKeyword)
        .some((k) => receiverOwner(k) === owner);
      const readsArguments = part
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => id.getText() === "arguments" && receiverOwner(id) === owner);
      if (usesOwn || readsArguments) return undefined;
      yields = true;
    }
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
      if (inside(target)) continue;
      // One that leaves the statement for the loop around it is a completion of the closure, done
      // after the call (#1330); not from a finally, whose completion the primitive does not keep.
      if (target === undefined || !isLoopStatement(target) || part === finalizer) return undefined;
      leaves.push(j);
    }
  }
  return { parts, vars, awaits, yields, leaves };
}

/** Whether a loop statement is between a node and `boundary`. */
function insideLoop(node: Node, boundary: Node): boolean {
  for (
    let p = node.getParent();
    p !== undefined && p.compilerNode !== boundary.compilerNode;
    p = p.getParent()
  )
    if (isLoopStatement(p)) return true;
  return false;
}

/** The outermost try statement between a node and `boundary`, if any. */
function outermostTry(node: Node, boundary: Node): import("ts-morph").TryStatement | undefined {
  let found: import("ts-morph").TryStatement | undefined;
  for (
    let p = node.getParent();
    p !== undefined && p.compilerNode !== boundary.compilerNode;
    p = p.getParent()
  )
    if (Node.isTryStatement(p)) found = p;
  return found;
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
    // A jump inside a try is the one after the call the try lowers to (#1330): it is written where
    // the try is.
    const t = outermostTry(j, body);
    if (t !== undefined && tryShape(t) === undefined) return false;
    for (
      let p: Node | undefined = t !== undefined ? t.getParent() : j.getParent();
      p !== undefined && p.compilerNode !== body.compilerNode;
      p = p.getParent()
    ) {
      // A jump inside an inner loop, or a try or label of the body, is not one this lifts; nor
      // one inside a switch, unless it is a return and the switch is the chain of ifs it lowers to
      // (#1330): a return leaves the function wherever it is written.
      // A continue in a switch nearest to it is the flag the switch's pass sets (#1330); so is a
      // return, when the switch is a pass (#1368). A continue that ends an arm of the chain of ifs
      // is the loop's (#1368).
      const nearest = breakTarget(j)?.compilerNode === p.compilerNode;
      // A throw ends its path wherever it is: in a switch that lowers, either way, it stays a throw
      // (#1292).
      const switchLeaves =
        Node.isSwitchStatement(p) &&
        ((Node.isThrowStatement(j) && !opaqueSwitch(p)) ||
          ((Node.isContinueStatement(j) || Node.isReturnStatement(j)) &&
            (switchArms(p) !== undefined
              ? Node.isReturnStatement(j) || nearest
              : nearest && switchPassShape(p) !== undefined)));
      if (
        isLoopStatement(p) ||
        (Node.isSwitchStatement(p) && !switchLeaves) ||
        Node.isTryStatement(p) ||
        Node.isLabeledStatement(p)
      )
        return false;
    }
  }
  return true;
}

/** The env name of the receiver (not a valid source name). */
const THIS = "%this";
/** A function's `arguments`, as a name an arrow captures (#1330). */
const ARGUMENTS = "%arguments";
/** The heap token (#1285): the last heap operation on the path, or the start. */
const HEAP = "%heap";
/** The platform primitive a try statement is a call of (#1276); see runtime.ts. */
const TRY_PRIMITIVE = "__yakccTry";
const ASYNC_TRY_PRIMITIVE = "__yakccTryAsync";
const GEN_TRY_PRIMITIVE = "__yakccTryGen";
const ASYNC_GEN_TRY_PRIMITIVE = "__yakccTryAsyncGen";
const OBJECT_REST_PRIMITIVE = "__yakccObjectRest";
const RUNTIME_PRIMITIVES = new Set([
  OBJECT_REST_PRIMITIVE,
  TRY_PRIMITIVE,
  ASYNC_TRY_PRIMITIVE,
  GEN_TRY_PRIMITIVE,
  ASYNC_GEN_TRY_PRIMITIVE,
]);

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

/** Whether a statement's exits are all throws: no return of its own, and no loop in it that returns. */
function throwsOnly(node: Node): boolean {
  return (
    containsExitOrLoopReturn(node) &&
    !containsDirectReturn(node) &&
    ![...node.getDescendants()].some(
      (d) => isLoopStatement(d) && !insideOpaqueNonLoop(d, node) && loopReturns(d),
    )
  );
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
      (Node.isSwitchStatement(p) && opaqueSwitch(p)) ||
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
      // Any function: a method's or an accessor's return is its own (#1292), as a function's is.
      isFunctionLikeNode(p) ||
      Node.isClassStaticBlockDeclaration(p) ||
      Node.isForStatement(p) ||
      Node.isForOfStatement(p) ||
      Node.isForInStatement(p) ||
      Node.isWhileStatement(p) ||
      Node.isDoStatement(p) ||
      (Node.isSwitchStatement(p) && opaqueSwitch(p)) ||
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

/** A class member that is a type only: it computes nothing (#1330). */
function isTypeOnlyMember(m: Node): boolean {
  if (Node.isIndexSignatureDeclaration(m)) return true;
  if (Node.isPropertyDeclaration(m)) return m.hasDeclareKeyword() || m.isAbstract();
  if (Node.isMethodDeclaration(m)) return m.isAbstract() || m.getBody() === undefined;
  return m.getKind() === SyntaxKind.SemicolonClassElement;
}

/**
 * A field initializer as a method body: `{ return (e); }`, `{ return undefined; }` for none, and the
 * arrow's own body for `(() => { body })()` or `(() => e)()`, as the TypeScript lowering writes one.
 */
function initializerBody(init: Node | undefined): string {
  if (init === undefined) return "{ return undefined; }";
  let call: Node = init;
  while (Node.isParenthesizedExpression(call)) call = call.getExpression();
  if (Node.isCallExpression(call) && call.getArguments().length === 0) {
    let callee: Node = call.getExpression();
    while (Node.isParenthesizedExpression(callee)) callee = callee.getExpression();
    if (Node.isArrowFunction(callee) && callee.getParameters().length === 0 && !callee.isAsync()) {
      const body = callee.getBody();
      return Node.isBlock(body) ? body.getText() : `{ return (${body.getText()}); }`;
    }
  }
  return `{ return (${init.getText()}); }`;
}

/** A static block's body, and the arrow's own body when it is only `(() => { body })();`. */
function staticBody(m: import("ts-morph").ClassStaticBlockDeclaration): string {
  const body = m.getBody() as import("ts-morph").Block;
  const statements = body.getStatements();
  const only = statements.length === 1 ? statements[0] : undefined;
  if (only !== undefined && Node.isExpressionStatement(only)) {
    const inner = initializerBody(only.getExpression());
    if (!inner.startsWith("{ return (")) return inner;
  }
  return body.getText();
}
