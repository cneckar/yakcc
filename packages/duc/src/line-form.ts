// SPDX-License-Identifier: Apache-2.0
/**
 * The line form: the authoring format a model writes (#1275). One directive per line, in
 * single-assignment style, with names the author picks. Parsing validates the text and builds
 * the structural graph, which is then canonicalized, so the author's names never affect identity.
 *
 * Grammar:
 *
 *   param <name>                        the next parameter (index = order of param lines); top level only
 *   lit "<text>" -> <name>              a literal; the JSON string is its structural label
 *   op <label> [<name> ...] [-> <name>] an operation; the label is an operator or syntactic kind
 *   free <symbol> -> <name> [link <key>]     a name the graph does not define (free-identifier)
 *   ambient <symbol> -> <name> [link <key>]  a platform primitive (platform-primitive)
 *   unlinked <symbol> [from <module>] -> <name> [link <key>]
 *                                       a binding imported from outside (unlinked-reference)
 *                                       `link <key>` names the atom it is linked to
 *   if <name>                           open a branch on a condition; its then-side follows
 *   else                                open the else-side of the innermost branch
 *   end                                 close the innermost branch
 *   join <name> <cond> <then> <else>    the value of a branch after its end: <then> and <else> are
 *                                       the values on each side (a name from before the if, or one
 *                                       defined on that side). It must directly follow its end.
 *   select <name> <cond> <then> <else>  a value chosen by a condition, with no branch around it (a
 *                                       ternary). Both values are computed; the condition picks one.
 *   loop <name> ... [of|in <name>] [with <name> ...]
 *                                       open a loop. The names first start the carried variables;
 *                                       `of <x>` iterates the values of x, `in <x>` its keys; the
 *                                       names after `with` are the outer values the body reads.
 *   carry <name> ...                    the body's names for the carried variables, in order
 *   invariant <name> ...                the body's names for the invariants, in order
 *   element <name>                      an iterating loop's name for the current element
 *   while <name>                        the body's condition: the loop continues while it is true
 *                                       (not for an iterating loop, which runs once per element)
 *   next <name> ...                     the next value of each carried variable, in order
 *   end <name> ...                      close the loop; the names are its results, one per carry
 *   function <name> [with <name> ...]   a closure: the lines up to its `end` are a program of their
 *                                       own, whose first params are the captured names after `with`
 *   out <name>                          an observation, in order; top level only
 *   # ...                               a comment line
 *
 * Names are local to the text. A name must be defined once, before it is used. A name defined
 * inside a branch or a loop is not visible after its end: only a join or a loop's results carry a
 * value out. A free or ambient source is one per symbol, so it is top level wherever it is written.
 */
import { canonicalizeGraph } from "./canonical.js";
import type { DiamondLabel, DiamondReason, DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export class LineFormError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "LineFormError";
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LIT = /^lit\s+("(?:[^"\\]|\\.)*")\s*->\s*(\S+)\s*$/;
const LABEL = /^\S+$/;

/** An open `if`: its scope at the `if`, and the snapshots of each side once they close. */
interface IfFrame {
  readonly kind: "if";
  readonly id: string;
  readonly cond: ValueId;
  readonly within: string | undefined;
  readonly line: number;
  readonly before: ReadonlyMap<string, ValueId>;
  thenNames: ReadonlyMap<string, ValueId>;
  elseNames: ReadonlyMap<string, ValueId>;
  inElse: boolean;
}

/** An open `loop`: its scope at the loop line, and the parts of its body as they are written. */
interface LoopFrame {
  readonly kind: "loop";
  readonly id: string;
  readonly within: string | undefined;
  readonly line: number;
  readonly before: ReadonlyMap<string, ValueId>;
  readonly inits: readonly ValueId[];
  readonly invariantOuter: readonly ValueId[];
  /** An iterating loop: what it iterates, and whether over values (`of`) or keys (`in`). */
  readonly iterable: ValueId | undefined;
  readonly of: "values" | "keys" | undefined;
  /** The next directive that the loop accepts, in order. */
  stage: "carry" | "invariant" | "element" | "body" | "next" | "end";
  element: ValueId | undefined;
  carry: ValueId[];
  invariant: ValueId[];
  cond: ValueId | undefined;
  next: ValueId[];
}

type Frame = IfFrame | LoopFrame;

const RESERVED = new Set(["with", "of", "in"]);

/** The region path of a loop's body. */
export function bodyPathOf(node: DucNode): string {
  const loop = node.loop as DucLoop;
  return `${node.region !== undefined ? `${node.region}/` : ""}${loop.id}.b`;
}

/** Parse and validate the line form, and return the canonical graph it denotes. */
export function parseLineForm(text: string): DucGraph {
  let names = new Map<string, ValueId>();
  // One unknown, one source: a symbol that is referenced twice is the same diamond, as in the lifter.
  const diamondValues = new Map<string, ValueId>();
  const diamondSpecs = new Map<string, string | undefined>();
  const nodes: DucNode[] = [];
  const obs: ValueId[] = [];
  const branches: DucBranch[] = [];
  const open: Frame[] = [];
  // The if whose end was the previous directive: a join may follow only that.
  let pendingJoin: IfFrame | undefined;
  let valueCount = 0;
  let paramCount = 0;
  let branchCount = 0;
  let loopCount = 0;

  const currentRegion = (): string | undefined => {
    if (open.length === 0) return undefined;
    return open
      .map((f) => (f.kind === "if" ? `${f.id}.${f.inElse ? "e" : "t"}` : `${f.id}.b`))
      .join("/");
  };
  const define = (name: string, line: number): ValueId => {
    if (!NAME.test(name) || RESERVED.has(name)) throw new LineFormError(line, `"${name}" is not a valid name`);
    if (names.has(name)) throw new LineFormError(line, `"${name}" is already defined`);
    const v = `v${valueCount++}` as ValueId;
    names.set(name, v);
    return v;
  };
  const use = (name: string, line: number): ValueId => {
    const v = names.get(name);
    if (v === undefined) throw new LineFormError(line, `"${name}" is used before it is defined`);
    return v;
  };
  const add = (node: Omit<DucNode, "id">, region: string | undefined): void => {
    nodes.push({
      id: `n${nodes.length}` as DucNode["id"],
      ...node,
      ...(region !== undefined ? { region } : {}),
    });
  };

  const lines = text.split("\n");
  // A closure's lines are parsed as its own program, and skipped here.
  let skipUntil = 0;
  lines.forEach((raw, i) => {
    if (i < skipUntil) return;
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const follows = pendingJoin;
    pendingJoin = undefined;
    const [head = "", ...rest] = trimmed.split(/\s+/);

    // A loop takes its header parts in order, and nothing else until they are all written.
    const top = open[open.length - 1];
    if (top?.kind === "loop" && top.stage !== "body") {
      const expected: Record<string, string> = {
        carry: "carry <name> ...",
        invariant: "invariant <name> ...",
        element: "element <name>",
        next: "next <name> ...",
        end: "end <name> ...",
      };
      if (head !== top.stage) throw new LineFormError(line, `expected: ${expected[top.stage]}`);
    }

    if (trimmed.startsWith("lit")) {
      const m = LIT.exec(trimmed);
      if (m === null) throw new LineFormError(line, 'expected: lit "<text>" -> <name>');
      const label = JSON.parse(m[1] as string) as string;
      const out = define(m[2] as string, line);
      add({ kind: "literal-source", inputs: [], outputs: [out], label }, currentRegion());
      return;
    }

    if (head === "param") {
      if (open.length > 0) throw new LineFormError(line, "param must come before any if or loop");
      if (rest.length !== 1) throw new LineFormError(line, "expected: param <name>");
      const out = define(rest[0] as string, line);
      add({ kind: "param-source", inputs: [], outputs: [out], label: String(paramCount++) }, undefined);
      return;
    }

    if (head === "op") {
      const label = rest[0];
      if (label === undefined || !LABEL.test(label)) {
        throw new LineFormError(line, "expected: op <label> [<name> ...] [-> <name>]");
      }
      const arrow = rest.indexOf("->");
      const operands = arrow === -1 ? rest.slice(1) : rest.slice(1, arrow);
      const results = arrow === -1 ? [] : rest.slice(arrow + 1);
      if (arrow !== -1 && results.length !== 1) {
        throw new LineFormError(line, "an operation has at most one result: -> <name>");
      }
      const inputs = operands.map((n) => use(n, line));
      const outputs = results.map((n) => define(n, line));
      add({ kind: "op", inputs, outputs, label }, currentRegion());
      return;
    }

    if (head === "free" || head === "ambient" || head === "unlinked") {
      const arrow = rest.indexOf("->");
      const before = arrow === -1 ? rest : rest.slice(0, arrow);
      const after = arrow === -1 ? [] : rest.slice(arrow + 1);
      const usage = `expected: ${head} <symbol>${head === "unlinked" ? " [from <module>]" : ""} -> <name> [link <key>]`;
      if (arrow === -1 || after.length !== 1 && !(after.length === 3 && after[1] === "link")) {
        throw new LineFormError(line, usage);
      }
      let symbol: string | undefined = before[0];
      let module: string | undefined;
      if (head === "unlinked" && before.length === 3 && before[1] === "from") module = before[2];
      else if (before.length !== 1) throw new LineFormError(line, usage);
      if (symbol === undefined || !SYMBOL.test(symbol)) throw new LineFormError(line, `"${symbol ?? ""}" is not a valid symbol`);
      const reason: DiamondReason =
        head === "free" ? "free-identifier" : head === "ambient" ? "platform-primitive" : "unlinked-reference";
      const spec = after.length === 3 ? after[2] : undefined;
      const diamond: DiamondLabel = {
        reason,
        symbol,
        ...(module !== undefined ? { module } : {}),
        ...(spec !== undefined ? { spec } : {}),
      };
      const name = after[0] as string;
      const key = `${reason}:${symbol}:${module ?? ""}`;
      const known = diamondValues.get(key);
      if (known !== undefined) {
        // The same unknown again: the name refers to the existing source, with no new node. Its
        // link is the one it was first given.
        if (diamondSpecs.get(key) !== spec) throw new LineFormError(line, `"${symbol}" is linked to another key`);
        if (!NAME.test(name)) throw new LineFormError(line, `"${name}" is not a valid name`);
        if (names.has(name)) throw new LineFormError(line, `"${name}" is already defined`);
        names.set(name, known);
        return;
      }
      const out = define(name, line);
      diamondValues.set(key, out);
      diamondSpecs.set(key, spec);
      add({ kind: "diamond-source", inputs: [], outputs: [out], diamond }, undefined);
      return;
    }

    if (head === "if") {
      if (rest.length !== 1) throw new LineFormError(line, "expected: if <name>");
      const cond = use(rest[0] as string, line);
      const within = currentRegion();
      const frame: IfFrame = {
        kind: "if",
        id: `b${branchCount++}`,
        cond,
        within,
        line,
        before: new Map(names),
        thenNames: names,
        elseNames: names,
        inElse: false,
      };
      open.push(frame);
      branches.push({ id: frame.id, cond, ...(within !== undefined ? { within } : {}) });
      return;
    }

    if (head === "else") {
      if (rest.length !== 0) throw new LineFormError(line, "expected: else");
      const frame = open[open.length - 1];
      if (frame === undefined || frame.kind !== "if" || frame.inElse) {
        throw new LineFormError(line, "else must follow the then-side of an if");
      }
      frame.thenNames = new Map(names);
      frame.inElse = true;
      names = new Map(frame.before);
      return;
    }

    if (head === "loop") {
      const usage = "expected: loop <name> ... [of|in <name>] [with <name> ...]";
      const withAt = rest.indexOf("with");
      const head1 = withAt === -1 ? rest : rest.slice(0, withAt);
      const invNames = withAt === -1 ? [] : rest.slice(withAt + 1);
      if (rest.filter((n) => n === "with").length > 1 || invNames.some((n) => n === "of" || n === "in")) {
        throw new LineFormError(line, usage);
      }
      const iterAt = head1.findIndex((n) => n === "of" || n === "in");
      const initNames = iterAt === -1 ? head1 : head1.slice(0, iterAt);
      if (iterAt !== -1 && head1.length !== iterAt + 2) throw new LineFormError(line, usage);
      const of = iterAt === -1 ? undefined : head1[iterAt] === "of" ? ("values" as const) : ("keys" as const);
      const within = currentRegion();
      const frame: LoopFrame = {
        kind: "loop",
        id: `L${loopCount++}`,
        within,
        line,
        before: new Map(names),
        inits: initNames.map((n) => use(n, line)),
        invariantOuter: invNames.map((n) => use(n, line)),
        iterable: iterAt === -1 ? undefined : use(head1[iterAt + 1] as string, line),
        of,
        element: undefined,
        stage: "carry",
        carry: [],
        invariant: [],
        cond: undefined,
        next: [],
      };
      open.push(frame);
      return;
    }

    if (head === "carry" || head === "invariant") {
      if (top?.kind !== "loop" || top.stage !== head) {
        throw new LineFormError(line, `${head} must follow the loop header${head === "invariant" ? " and the carry line" : ""}`);
      }
      const frame = top;
      const want = head === "carry" ? frame.inits.length : frame.invariantOuter.length;
      if (rest.length !== want) {
        throw new LineFormError(line, `expected ${want} name(s): ${head} <name> ... (one per ${head === "carry" ? "carried variable" : "invariant"})`);
      }
      const values = rest.map((n) => define(n, line));
      values.forEach((v, j) => {
        add(
          { kind: "carry-source", inputs: [], outputs: [v], label: `${head === "carry" ? "carry" : "invariant"}:${j}` },
          currentRegion(),
        );
      });
      if (head === "carry") {
        frame.carry = values;
        frame.stage = "invariant";
      } else {
        frame.invariant = values;
        frame.stage = frame.of !== undefined ? "element" : "body";
      }
      return;
    }

    if (head === "element") {
      if (top?.kind !== "loop" || top.stage !== "element") throw new LineFormError(line, "element must follow the invariant line of an iterating loop");
      if (rest.length !== 1) throw new LineFormError(line, "expected: element <name>");
      const value = define(rest[0] as string, line);
      add({ kind: "carry-source", inputs: [], outputs: [value], label: "element" }, currentRegion());
      top.element = value;
      top.stage = "body";
      return;
    }

    if (head === "while") {
      const frame = top;
      if (frame === undefined || frame.kind !== "loop" || frame.stage !== "body") {
        throw new LineFormError(line, "while must follow the body of a loop, and come once");
      }
      if (frame.of !== undefined) throw new LineFormError(line, "an iterating loop has no while: it runs once per element");
      if (rest.length !== 1) throw new LineFormError(line, "expected: while <name>");
      frame.cond = use(rest[0] as string, line);
      frame.stage = "next";
      return;
    }

    if (head === "next") {
      const ready = top?.kind === "loop" && (top.stage === "next" || (top.stage === "body" && top.of !== undefined));
      if (!ready || top?.kind !== "loop") throw new LineFormError(line, "next must follow while, or the body of an iterating loop");
      const frame = top;
      if (rest.length !== frame.inits.length) {
        throw new LineFormError(line, `expected ${frame.inits.length} name(s): next <name> ... (one per carried variable)`);
      }
      frame.next = rest.map((n) => use(n, line));
      frame.stage = "end";
      return;
    }

    if (head === "end") {
      const frame = open[open.length - 1];
      if (frame !== undefined && frame.kind === "loop") {
        if (frame.stage !== "end") throw new LineFormError(line, "a loop needs while and next before its end");
        if (rest.length !== frame.inits.length) {
          throw new LineFormError(line, `expected ${frame.inits.length} result name(s): end <name> ...`);
        }
        open.pop();
        // The loop's names go out of scope; its results are defined in the scope of the loop line.
        names = new Map(frame.before);
        const outputs = rest.map((n) => define(n, line));
        add(
          {
            kind: "loop",
            inputs: [...frame.inits, ...(frame.iterable !== undefined ? [frame.iterable] : []), ...frame.invariantOuter],
            outputs,
            ...(frame.of !== undefined ? { label: frame.of === "values" ? "for-of" : "for-in" } : {}),
            loop: {
              id: frame.id,
              carry: frame.carry,
              invariant: frame.invariant,
              next: frame.next,
              ...(frame.of === undefined
                ? { cond: frame.cond as ValueId }
                : { iterate: { element: frame.element as ValueId, of: frame.of } }),
            },
          },
          currentRegion(),
        );
        return;
      }
      if (rest.length !== 0) throw new LineFormError(line, "expected: end");
      const block = open.pop();
      if (block === undefined || block.kind !== "if") throw new LineFormError(line, "end without an if or a loop");
      if (block.inElse) {
        block.elseNames = new Map(names);
      } else {
        // No else-side: the else-side is the scope before the if.
        block.thenNames = new Map(names);
        block.elseNames = new Map(block.before);
      }
      names = new Map(block.before);
      pendingJoin = block;
      return;
    }

    if (head === "join") {
      if (follows === undefined) throw new LineFormError(line, "a join must directly follow the end of its if");
      if (rest.length !== 4) throw new LineFormError(line, "expected: join <name> <cond> <then> <else>");
      const [outName, condName, thenName, elseName] = rest as [string, string, string, string];
      const cond = use(condName, line);
      if (cond !== follows.cond) throw new LineFormError(line, "a join uses the condition of its if");
      const thenValue = follows.thenNames.get(thenName);
      if (thenValue === undefined) throw new LineFormError(line, `"${thenName}" is not visible on the then-side`);
      const elseValue = follows.elseNames.get(elseName);
      if (elseValue === undefined) throw new LineFormError(line, `"${elseName}" is not visible on the else-side`);
      const out = define(outName, line);
      add({ kind: "sel", inputs: [cond, thenValue, elseValue], outputs: [out] }, currentRegion());
      pendingJoin = follows;
      return;
    }

    if (head === "select") {
      if (rest.length !== 4) throw new LineFormError(line, "expected: select <name> <cond> <then> <else>");
      const [outName, condName, thenName, elseName] = rest as [string, string, string, string];
      const inputs = [use(condName, line), use(thenName, line), use(elseName, line)];
      const out = define(outName, line);
      add({ kind: "sel", inputs, outputs: [out] }, currentRegion());
      return;
    }

    if (head === "function") {
      const usage = "expected: function <name> [with <name> ...]";
      const withAt = rest.indexOf("with");
      if (rest.length === 0 || (withAt !== -1 && withAt !== 1) || (withAt === -1 && rest.length !== 1)) {
        throw new LineFormError(line, usage);
      }
      const captures = withAt === -1 ? [] : rest.slice(2).map((n) => use(n, line));
      // The closure's program runs to its own end, past the ends of the blocks inside it.
      let depth = 0;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = (lines[j] as string).trim();
        if (t === "" || t.startsWith("#")) continue;
        const h = t.split(/\s+/)[0];
        if (h === "if" || h === "loop" || h === "function") depth++;
        else if (h === "end") {
          if (depth === 0) break;
          depth--;
        }
      }
      if (j >= lines.length) throw new LineFormError(line, "function is not closed by end");
      if ((lines[j] as string).trim() !== "end") throw new LineFormError(j + 1, "expected: end");
      let inner: DucGraph;
      try {
        inner = parseLineForm(lines.slice(i + 1, j).join("\n"));
      } catch (e) {
        if (e instanceof LineFormError) throw new LineFormError(line + e.line, e.message.replace(/^line \d+: /, ""));
        throw e;
      }
      const params = inner.nodes.filter((n) => n.kind === "param-source").length;
      if (params < captures.length) {
        throw new LineFormError(line, `a function that captures ${captures.length} value(s) takes them as its first params`);
      }
      const out = define(rest[0] as string, line);
      add({ kind: "op", inputs: captures, outputs: [out], label: "closure", closure: inner }, currentRegion());
      skipUntil = j + 1;
      return;
    }

    if (head === "out") {
      if (open.length > 0) throw new LineFormError(line, "an observation cannot be inside an if or a loop yet");
      if (rest.length !== 1) throw new LineFormError(line, "expected: out <name>");
      obs.push(use(rest[0] as string, line));
      return;
    }

    throw new LineFormError(line, `unknown directive "${head}"`);
  });

  const unclosed = open[open.length - 1];
  if (unclosed !== undefined) {
    throw new LineFormError(unclosed.line, unclosed.kind === "if" ? "if is not closed by end" : "loop is not closed by end");
  }
  return canonicalizeGraph(nodes, obs, branches);
}

/** `prefix` is a region path or the top level; `region` is a node's region. */
export function isPrefix(prefix: string | undefined, region: string | undefined): boolean {
  if (prefix === undefined) return true;
  if (region === undefined) return false;
  return region === prefix || region.startsWith(`${prefix}/`);
}

/** The region path of one side of a branch, e.g. `b0.t` or `b0.t/b1.e`. */
export function sidePath(b: DucBranch, side: "t" | "e"): string {
  return `${b.within !== undefined ? `${b.within}/` : ""}${b.id}.${side}`;
}

/**
 * The if each join belongs to: the if whose side produces one of the join's inputs. Values are
 * single-assignment, so there is exactly one. A select with no such if is a plain node (a ternary,
 * or a branch that only takes existing values, which is the same graph).
 */
export function joinOwners(g: DucGraph): Map<NodeId, DucBranch> {
  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  for (const node of g.nodes) for (const v of node.outputs) producer.set(v, node);
  const regionOf = (v: ValueId): string | undefined => {
    const p = producer.get(v);
    if (p === undefined) throw new Error(`value ${v} has no producer`);
    return p.region;
  };
  const joinOwner = new Map<NodeId, DucBranch>();
  for (const node of g.nodes) {
    if (node.kind !== "sel") continue;
    if (node.inputs.length !== 3) throw new Error(`select ${node.id} needs a condition and two values`);
    const [cond, thenV, elseV] = node.inputs as [ValueId, ValueId, ValueId];
    const owners = branches.filter(
      (b) =>
        b.cond === cond &&
        b.within === node.region &&
        (isPrefix(sidePath(b, "t"), regionOf(thenV)) || isPrefix(sidePath(b, "e"), regionOf(elseV))),
    );
    if (owners.length > 1) throw new Error(`join ${node.id} does not belong to exactly one if`);
    const owner = owners[0];
    if (owner !== undefined) joinOwner.set(node.id, owner);
  }
  return joinOwner;
}

/** The loop whose body a node lies in, innermost, or undefined at the top level. */
function innermostLoopOf(region: string | undefined): string | undefined {
  if (region === undefined) return undefined;
  const segs = region.split("/");
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i] as string;
    if (seg.endsWith(".b")) return seg.slice(0, -2);
  }
  return undefined;
}

/**
 * Print a canonical graph as the line form. Refuses constructs the line form does not express,
 * so a printed text always parses back to the same structure. Each branch prints as an `if`
 * block at its own level, and each join prints directly after the end of its branch. Each loop
 * prints as a `loop` block, whose body reads the outside only through its invariants.
 */
export function printLineForm(g: DucGraph): string {
  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  for (const node of g.nodes) for (const v of node.outputs) producer.set(v, node);
  const producerOf = (v: ValueId): DucNode => {
    const p = producer.get(v);
    if (p === undefined) throw new Error(`value ${v} has no producer`);
    return p;
  };

  const joinOwner = joinOwners(g);

  // Loops: a loop's carried and invariant values are sources of its own body, and nothing else.
  const loopNodes = g.nodes.filter((n) => n.kind === "loop");
  const headerOf = new Map<NodeId, DucNode>();
  for (const loop of loopNodes) {
    const rec = loop.loop;
    if (rec === undefined) {
      throw new Error(
        `loop ${loop.id} is a do loop, or has a break, continue or return, which the line form does not express yet`,
      );
    }
    const body = bodyPathOf(loop);
    const iterating = rec.iterate !== undefined ? 1 : 0;
    if (
      loop.inputs.length !== rec.carry.length + iterating + rec.invariant.length ||
      loop.outputs.length !== rec.carry.length ||
      (rec.cond === undefined) === (rec.iterate === undefined)
    ) {
      throw new Error(`loop ${loop.id} does not match its carried and invariant values, or its condition or iteration`);
    }
    if (rec.iterate !== undefined) {
      const p = producerOf(rec.iterate.element);
      if (p.kind !== "carry-source" || p.region !== body || p.label !== "element") {
        throw new Error(`loop ${loop.id} has an element that is not its body's source`);
      }
      headerOf.set(p.id, loop);
    }
    for (const [i, v] of rec.carry.entries()) {
      const p = producerOf(v);
      if (p.kind !== "carry-source" || p.region !== body || p.label !== `carry:${i}`) {
        throw new Error(`loop ${loop.id} has a carried value that is not its body's source`);
      }
      headerOf.set(p.id, loop);
    }
    for (const [j, v] of rec.invariant.entries()) {
      const p = producerOf(v);
      if (p.kind !== "carry-source" || p.region !== body || p.label !== `invariant:${j}`) {
        throw new Error(`loop ${loop.id} has an invariant that is not its body's source`);
      }
      headerOf.set(p.id, loop);
    }
    for (const v of [...rec.next, ...(rec.cond !== undefined ? [rec.cond] : [])]) {
      const p = producerOf(v);
      if (p.region === undefined || !isPrefix(body, p.region)) {
        throw new Error(`loop ${loop.id} takes its next value or condition from outside its body`);
      }
    }
  }

  // Visibility: a value is used only where its producer's scope encloses the use (D5 scope rules).
  for (const node of g.nodes) {
    if (node.kind === "param-source" && node.region !== undefined) {
      throw new Error("a parameter inside an if or loop has no line form");
    }
    if (node.kind === "carry-source" && !headerOf.has(node.id)) {
      throw new Error(`source ${node.id} is not a carried or invariant value of a loop`);
    }
    const owner = joinOwner.get(node.id);
    if (owner !== undefined) {
      const [cond, thenV, elseV] = node.inputs as [ValueId, ValueId, ValueId];
      const ok =
        isPrefix(producerOf(cond).region, node.region) &&
        isPrefix(producerOf(thenV).region, sidePath(owner, "t")) &&
        isPrefix(producerOf(elseV).region, sidePath(owner, "e"));
      if (!ok) throw new Error(`join ${node.id} uses a value from outside its if`);
      continue;
    }
    for (const v of node.inputs) {
      if (!isPrefix(producerOf(v).region, node.region)) {
        throw new Error(`node ${node.id} uses a value from another branch; only a join carries it out`);
      }
    }
    // A node in a loop body reads only values of that body: outside values arrive as invariants.
    const inner = innermostLoopOf(node.region);
    if (inner !== undefined) {
      const loop = loopNodes.find((l) => l.loop?.id === inner);
      if (loop !== undefined) {
        const body = bodyPathOf(loop);
        for (const v of node.inputs) {
          if (!isPrefix(body, producerOf(v).region)) {
            throw new Error(`node ${node.id} reads a value from outside its loop; it must come in as an invariant`);
          }
        }
      }
    }
  }
  for (const v of g.obs) {
    if (producerOf(v).region !== undefined) throw new Error("an observation inside an if or loop has no line form yet");
  }

  const nodeIndex = new Map(g.nodes.map((n, i) => [n.id, i] as const));
  const printed = new Set<NodeId>();
  const printedBranches = new Set<string>();

  const printNode = (node: DucNode): string => {
    const out = node.outputs[0];
    switch (node.kind) {
      case "param-source": {
        if (out === undefined) throw new Error("param-source without an output");
        return `param ${out}`;
      }
      case "literal-source": {
        if (out === undefined || node.label === undefined) throw new Error("literal without a value");
        return `lit ${JSON.stringify(node.label)} -> ${out}`;
      }
      case "op": {
        if (node.label === undefined || !LABEL.test(node.label)) {
          throw new Error(`operation ${node.id} has no structural label`);
        }
        if (node.outputs.length > 1) throw new Error(`operation ${node.id} has more than one result`);
        const operands = node.inputs.join(" ");
        const result = node.outputs.length === 1 ? ` -> ${node.outputs[0]}` : "";
        return `op ${node.label}${operands ? ` ${operands}` : ""}${result}`;
      }
      case "diamond-source": {
        if (out === undefined || node.diamond === undefined) throw new Error("unresolved name without a label");
        const d = node.diamond;
        const head =
          d.reason === "free-identifier" ? "free" : d.reason === "platform-primitive" ? "ambient" : d.reason === "unlinked-reference" ? "unlinked" : null;
        if (head === null) throw new Error(`reason "${d.reason}" is not expressible in the line form (D5)`);
        const from = head === "unlinked" && d.module !== undefined ? ` from ${d.module}` : "";
        const link = d.spec !== undefined ? ` link ${d.spec}` : "";
        return `${head} ${d.symbol}${from} -> ${out}${link}`;
      }
      case "sel": {
        if (out === undefined || node.inputs.length !== 3) throw new Error(`select ${node.id} needs a value and two inputs`);
        const [cond, thenV, elseV] = node.inputs;
        return `select ${out} ${cond} ${thenV} ${elseV}`;
      }
      default:
        throw new Error(`"${node.kind}" has no line form on its own`);
    }
  };

  /** The lines of a closure: its header, its own program, and its end. */
  const printClosure = (node: DucNode): string[] => {
    printed.add(node.id);
    const header = ["function", node.outputs[0] as string, ...(node.inputs.length > 0 ? ["with", ...node.inputs] : [])];
    const inner = printLineForm(node.closure as DucGraph).trimEnd().split("\n").map((l) => `  ${l}`);
    return [header.join(" "), ...inner, "end"];
  };

  /** The lines of one loop: its header, its sources, its body, its condition and next values, and its end. */
  const printLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    const count = rec.carry.length;
    const offset = count + (rec.iterate !== undefined ? 1 : 0);
    printed.add(loop.id);
    for (const v of [...rec.carry, ...rec.invariant]) printed.add(producerOf(v).id);
    if (rec.iterate !== undefined) printed.add(producerOf(rec.iterate.element).id);
    const header = ["loop", ...loop.inputs.slice(0, count)];
    if (rec.iterate !== undefined) header.push(rec.iterate.of === "values" ? "of" : "in", loop.inputs[count] as ValueId);
    if (rec.invariant.length > 0) header.push("with", ...loop.inputs.slice(offset));
    const body = printScope(bodyPathOf(loop));
    return [
      header.join(" "),
      ["carry", ...rec.carry].join(" "),
      ["invariant", ...rec.invariant].join(" "),
      ...(rec.iterate !== undefined ? [`element ${rec.iterate.element}`] : []),
      ...body,
      ...(rec.cond !== undefined ? [`while ${rec.cond}`] : []),
      ["next", ...rec.next].join(" "),
      ["end", ...loop.outputs].join(" "),
    ];
  };

  /** The lines of one scope: its nodes, branches and loops, each after the values it needs. */
  function printScope(scope: string | undefined): string[] {
    interface Item {
      readonly first: number;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (joinOwner.has(node.id) || node.region !== scope) continue;
      if (node.kind === "carry-source" || node.kind === "loop") continue;
      items.push({
        first: nodeIndex.get(node.id) as number,
        produces: node.outputs,
        requires: node.inputs,
        lines: () => {
          if (node.closure !== undefined) return printClosure(node);
          printed.add(node.id);
          return [printNode(node)];
        },
      });
    }
    for (const loop of loopNodes) {
      if (loop.region !== scope) continue;
      items.push({
        first: nodeIndex.get(loop.id) as number,
        produces: loop.outputs,
        requires: loop.inputs,
        lines: () => printLoop(loop),
      });
    }
    for (const b of branches) {
      if (b.within !== scope) continue;
      const thenPath = sidePath(b, "t");
      const elsePath = sidePath(b, "e");
      const subtree = g.nodes.filter((n) => isPrefix(thenPath, n.region) || isPrefix(elsePath, n.region));
      const joins = g.nodes.filter((n) => joinOwner.get(n.id)?.id === b.id);
      const inner = new Set(subtree.flatMap((n) => n.outputs));
      const requires = [b.cond, ...subtree.flatMap((n) => n.inputs), ...joins.flatMap((n) => n.inputs)];
      items.push({
        first: Math.min(g.nodes.length, ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number)),
        produces: joins.flatMap((n) => n.outputs),
        requires: [...new Set(requires)].filter((v) => !inner.has(v)),
        lines: () => {
          printedBranches.add(b.id);
          const hasElse = subtree.some((n) => isPrefix(elsePath, n.region));
          const out = [`if ${b.cond}`, ...printScope(thenPath)];
          if (hasElse) out.push("else", ...printScope(elsePath));
          out.push("end");
          for (const j of joins) {
            printed.add(j.id);
            const [cond, thenV, elseV] = j.inputs;
            out.push(`join ${j.outputs[0]} ${cond} ${thenV} ${elseV}`);
          }
          return out;
        },
      });
    }

    items.sort((a, b) => a.first - b.first);
    const producedBy = new Map<ValueId, number>();
    items.forEach((item, i) => item.produces.forEach((v) => producedBy.set(v, i)));
    const done = new Set<number>();
    const lines: string[] = [];
    while (done.size < items.length) {
      const next = items.findIndex(
        (item, i) =>
          !done.has(i) &&
          item.requires.every((v) => {
            const p = producedBy.get(v);
            return p === undefined || done.has(p);
          }),
      );
      if (next === -1) throw new Error("the graph has a cycle; it has no line form");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  const lines = printScope(undefined);
  if (printed.size !== g.nodes.length || printedBranches.size !== branches.length) {
    throw new Error("some node or branch is not reachable from the top level");
  }
  for (const v of g.obs) lines.push(`out ${v}`);
  return `${lines.join("\n")}\n`;
}
