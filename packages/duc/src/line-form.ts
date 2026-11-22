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
 *   free <symbol> -> <name>             a name the graph does not define (free-identifier)
 *   ambient <symbol> -> <name>          a platform primitive (platform-primitive)
 *   if <name>                           open a branch on a condition; its then-side follows
 *   else                                open the else-side of the innermost branch
 *   end                                 close the innermost branch
 *   join <name> <cond> <then> <else>    the value of a branch after its end: <then> and <else> are
 *                                       the values on each side (a name from before the if, or one
 *                                       defined on that side). It must directly follow its end.
 *   out <name>                          an observation, in order; top level only
 *   # ...                               a comment line
 *
 * Names are local to the text. A name must be defined once, before it is used. A name defined
 * inside a branch is not visible after its end: only a join carries a value out of a branch. A
 * free or ambient source is one per symbol, so it is top level wherever it is written.
 */
import { canonicalizeGraph } from "./canonical.js";
import type { DiamondLabel, DucBranch, DucGraph, DucNode, NodeId, ValueId } from "./types.js";

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
interface Block {
  readonly id: string;
  readonly cond: ValueId;
  readonly within: string | undefined;
  readonly line: number;
  readonly before: ReadonlyMap<string, ValueId>;
  thenNames: ReadonlyMap<string, ValueId>;
  elseNames: ReadonlyMap<string, ValueId>;
  inElse: boolean;
}

/** Parse and validate the line form, and return the canonical graph it denotes. */
export function parseLineForm(text: string): DucGraph {
  let names = new Map<string, ValueId>();
  // One unknown, one source: a symbol that is referenced twice is the same diamond, as in the lifter.
  const diamondValues = new Map<string, ValueId>();
  const nodes: DucNode[] = [];
  const obs: ValueId[] = [];
  const branches: DucBranch[] = [];
  const open: Block[] = [];
  // The block whose end was the previous directive: a join may follow only that.
  let pendingJoin: Block | undefined;
  let valueCount = 0;
  let paramCount = 0;
  let branchCount = 0;

  const currentRegion = (): string | undefined =>
    open.length > 0 ? open.map((b) => `${b.id}.${b.inElse ? "e" : "t"}`).join("/") : undefined;
  const define = (name: string, line: number): ValueId => {
    if (!NAME.test(name)) throw new LineFormError(line, `"${name}" is not a valid name`);
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

  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const follows = pendingJoin;
    pendingJoin = undefined;
    const [head = "", ...rest] = trimmed.split(/\s+/);

    if (trimmed.startsWith("lit")) {
      const m = LIT.exec(trimmed);
      if (m === null) throw new LineFormError(line, 'expected: lit "<text>" -> <name>');
      const label = JSON.parse(m[1] as string) as string;
      const out = define(m[2] as string, line);
      add({ kind: "literal-source", inputs: [], outputs: [out], label }, currentRegion());
      return;
    }

    if (head === "param") {
      if (open.length > 0) throw new LineFormError(line, "param must come before any if");
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

    if (head === "free" || head === "ambient") {
      if (rest.length !== 3 || rest[1] !== "->") {
        throw new LineFormError(line, `expected: ${head} <symbol> -> <name>`);
      }
      const symbol = rest[0] as string;
      if (!SYMBOL.test(symbol)) throw new LineFormError(line, `"${symbol}" is not a valid symbol`);
      const diamond: DiamondLabel = {
        reason: head === "free" ? "free-identifier" : "platform-primitive",
        symbol,
      };
      const key = `${diamond.reason}:${symbol}`;
      const known = diamondValues.get(key);
      if (known !== undefined) {
        // The same unknown again: the name refers to the existing source, with no new node.
        const name = rest[2] as string;
        if (!NAME.test(name)) throw new LineFormError(line, `"${name}" is not a valid name`);
        if (names.has(name)) throw new LineFormError(line, `"${name}" is already defined`);
        names.set(name, known);
        return;
      }
      const out = define(rest[2] as string, line);
      diamondValues.set(key, out);
      add({ kind: "diamond-source", inputs: [], outputs: [out], diamond }, undefined);
      return;
    }

    if (head === "if") {
      if (rest.length !== 1) throw new LineFormError(line, "expected: if <name>");
      const cond = use(rest[0] as string, line);
      const within = currentRegion();
      const block: Block = {
        id: `b${branchCount++}`,
        cond,
        within,
        line,
        before: new Map(names),
        thenNames: names,
        elseNames: names,
        inElse: false,
      };
      open.push(block);
      branches.push({ id: block.id, cond, ...(within !== undefined ? { within } : {}) });
      return;
    }

    if (head === "else") {
      if (rest.length !== 0) throw new LineFormError(line, "expected: else");
      const block = open[open.length - 1];
      if (block === undefined || block.inElse) throw new LineFormError(line, "else must follow the then-side of an if");
      block.thenNames = new Map(names);
      block.inElse = true;
      names = new Map(block.before);
      return;
    }

    if (head === "end") {
      if (rest.length !== 0) throw new LineFormError(line, "expected: end");
      const block = open.pop();
      if (block === undefined) throw new LineFormError(line, "end without an if");
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

    if (head === "out") {
      if (open.length > 0) throw new LineFormError(line, "an observation cannot be inside an if yet");
      if (rest.length !== 1) throw new LineFormError(line, "expected: out <name>");
      obs.push(use(rest[0] as string, line));
      return;
    }

    throw new LineFormError(line, `unknown directive "${head}"`);
  });

  const unclosed = open[open.length - 1];
  if (unclosed !== undefined) throw new LineFormError(unclosed.line, "if is not closed by end");
  return canonicalizeGraph(nodes, obs, branches);
}

/** `prefix` is a region path or the top level; `region` is a node's region. */
function isPrefix(prefix: string | undefined, region: string | undefined): boolean {
  if (prefix === undefined) return true;
  if (region === undefined) return false;
  return region === prefix || region.startsWith(`${prefix}/`);
}

/** The region path of one side of a branch, e.g. `b0.t` or `b0.t/b1.e`. */
function sidePath(b: DucBranch, side: "t" | "e"): string {
  return `${b.within !== undefined ? `${b.within}/` : ""}${b.id}.${side}`;
}

/**
 * Print a canonical graph as the line form. Refuses constructs the line form does not express,
 * so a printed text always parses back to the same structure. Each branch prints as an `if`
 * block at its own level, and each join prints directly after the end of its branch.
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

  // Each join belongs to the one branch at its level whose condition it selects on, and whose
  // side produces one of its inputs. Values are single-assignment, so there is exactly one.
  const joinOwner = new Map<NodeId, DucBranch>();
  for (const node of g.nodes) {
    if (node.kind !== "sel") continue;
    if (node.inputs.length !== 3) throw new Error(`join ${node.id} needs a condition and two values`);
    const [cond, thenV, elseV] = node.inputs as [ValueId, ValueId, ValueId];
    const owners = branches.filter(
      (b) =>
        b.cond === cond &&
        b.within === node.region &&
        (isPrefix(sidePath(b, "t"), producerOf(thenV).region) || isPrefix(sidePath(b, "e"), producerOf(elseV).region)),
    );
    if (owners.length !== 1) throw new Error(`join ${node.id} does not belong to exactly one if`);
    joinOwner.set(node.id, owners[0] as DucBranch);
  }

  // Visibility: a value is used only where its producer's scope encloses the use (D5 scope rules).
  for (const node of g.nodes) {
    if (node.kind === "param-source" && node.region !== undefined) {
      throw new Error("a parameter inside an if has no line form");
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
  }
  for (const v of g.obs) {
    if (producerOf(v).region !== undefined) throw new Error("an observation inside an if has no line form yet");
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
        const head = node.diamond.reason === "free-identifier" ? "free" : node.diamond.reason === "platform-primitive" ? "ambient" : null;
        if (head === null) {
          throw new Error(`reason "${node.diamond.reason}" is not expressible in the line form (D5)`);
        }
        return `${head} ${node.diamond.symbol} -> ${out}`;
      }
      case "sel":
        throw new Error(`join ${node.id} has no branch`);
      default:
        throw new Error(`"${node.kind}" is a loop, which the line form does not express yet`);
    }
  };

  /** The lines of one scope: its nodes and branches, each after the values it needs. */
  const printScope = (scope: string | undefined): string[] => {
    interface Item {
      readonly first: number;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (joinOwner.has(node.id) || node.region !== scope) continue;
      items.push({
        first: nodeIndex.get(node.id) as number,
        produces: node.outputs,
        requires: node.inputs,
        lines: () => {
          printed.add(node.id);
          return [printNode(node)];
        },
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
  };

  const lines = printScope(undefined);
  if (printed.size !== g.nodes.length || printedBranches.size !== branches.length) {
    throw new Error("some node or branch is not reachable from the top level");
  }
  for (const v of g.obs) lines.push(`out ${v}`);
  return `${lines.join("\n")}\n`;
}
