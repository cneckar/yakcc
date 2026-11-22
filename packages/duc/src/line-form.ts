// SPDX-License-Identifier: Apache-2.0
/**
 * The line form: the authoring format a model writes (#1275). One directive per line, in
 * single-assignment style, with names the author picks. Parsing validates the text and builds
 * the structural graph, which is then canonicalized, so the author's names never affect identity.
 *
 * Grammar (straight-line code; control flow is refused until tier 1 lands):
 *
 *   param <name>                        the next parameter (index = order of param lines)
 *   lit "<text>" -> <name>              a literal; the JSON string is its structural label
 *   op <label> [<name> ...] [-> <name>] an operation; the label is an operator or syntactic kind
 *   free <symbol> -> <name>             a name the graph does not define (free-identifier)
 *   ambient <symbol> -> <name>          a platform primitive (ambient-read)
 *   out <name>                          an observation, in order
 *   # ...                               a comment line
 *
 * Names are local to the text. A name must be defined once, before it is used.
 */
import { canonicalizeGraph } from "./canonical.js";
import type { DiamondLabel, DucGraph, DucNode, ValueId } from "./types.js";

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

/** Parse and validate the line form, and return the canonical graph it denotes. */
export function parseLineForm(text: string): DucGraph {
  const names = new Map<string, ValueId>();
  // One unknown, one source: a symbol that is referenced twice is the same diamond, as in the lifter.
  const diamondValues = new Map<string, ValueId>();
  const nodes: DucNode[] = [];
  const obs: ValueId[] = [];
  let valueCount = 0;
  let paramCount = 0;

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
  const add = (node: Omit<DucNode, "id">): void => {
    nodes.push({ id: `n${nodes.length}` as DucNode["id"], ...node });
  };

  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const [head = "", ...rest] = trimmed.split(/\s+/);

    if (trimmed.startsWith("lit")) {
      const m = LIT.exec(trimmed);
      if (m === null) throw new LineFormError(line, 'expected: lit "<text>" -> <name>');
      const label = JSON.parse(m[1] as string) as string;
      const out = define(m[2] as string, line);
      add({ kind: "literal-source", inputs: [], outputs: [out], label });
      return;
    }

    if (head === "param") {
      if (rest.length !== 1) throw new LineFormError(line, "expected: param <name>");
      const out = define(rest[0] as string, line);
      add({ kind: "param-source", inputs: [], outputs: [out], label: String(paramCount++) });
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
      add({ kind: "op", inputs, outputs, label });
      return;
    }

    if (head === "free" || head === "ambient") {
      if (rest.length !== 3 || rest[1] !== "->") {
        throw new LineFormError(line, `expected: ${head} <symbol> -> <name>`);
      }
      const symbol = rest[0] as string;
      if (!SYMBOL.test(symbol)) throw new LineFormError(line, `"${symbol}" is not a valid symbol`);
      const diamond: DiamondLabel = {
        reason: head === "free" ? "free-identifier" : "ambient-read",
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
      add({ kind: "diamond-source", inputs: [], outputs: [out], diamond });
      return;
    }

    if (head === "out") {
      if (rest.length !== 1) throw new LineFormError(line, "expected: out <name>");
      obs.push(use(rest[0] as string, line));
      return;
    }

    throw new LineFormError(line, `unknown directive "${head}"`);
  });

  return canonicalizeGraph(nodes, obs);
}

/**
 * Print a canonical graph as the line form. Refuses control flow and any construct the line
 * form does not express, so a printed text always parses back to the same structure.
 */
export function printLineForm(g: DucGraph): string {
  const lines: string[] = [];
  for (const node of dependencyOrder(g.nodes)) {
    const out = node.outputs[0];
    switch (node.kind) {
      case "param-source": {
        if (out === undefined) throw new Error("param-source without an output");
        lines.push(`param ${out}`);
        break;
      }
      case "literal-source": {
        if (out === undefined || node.label === undefined) throw new Error("literal without a value");
        lines.push(`lit ${JSON.stringify(node.label)} -> ${out}`);
        break;
      }
      case "op": {
        if (node.label === undefined || !LABEL.test(node.label)) {
          throw new Error(`operation ${node.id} has no structural label`);
        }
        if (node.outputs.length > 1) throw new Error(`operation ${node.id} has more than one result`);
        const operands = node.inputs.join(" ");
        const result = node.outputs.length === 1 ? ` -> ${node.outputs[0]}` : "";
        lines.push(`op ${node.label}${operands ? ` ${operands}` : ""}${result}`);
        break;
      }
      case "diamond-source": {
        if (out === undefined || node.diamond === undefined) throw new Error("unresolved name without a label");
        const head = node.diamond.reason === "free-identifier" ? "free" : node.diamond.reason === "ambient-read" ? "ambient" : null;
        if (head === null) {
          throw new Error(`reason "${node.diamond.reason}" is not expressible in the line form (D5)`);
        }
        lines.push(`${head} ${node.diamond.symbol} -> ${out}`);
        break;
      }
      default:
        throw new Error(`"${node.kind}" is control flow, which the line form does not express yet`);
    }
  }
  for (const v of g.obs) lines.push(`out ${v}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The nodes in dependency order: every node after the nodes that define its inputs. Ties go to
 * the smallest canonical index, so parameters keep their order and the text is deterministic.
 */
function dependencyOrder(nodes: readonly DucNode[]): DucNode[] {
  const producer = new Map<ValueId, number>();
  nodes.forEach((node, i) => node.outputs.forEach((v) => producer.set(v, i)));
  const emitted = new Set<number>();
  const order: DucNode[] = [];
  while (order.length < nodes.length) {
    let progressed = false;
    for (let i = 0; i < nodes.length; i++) {
      if (emitted.has(i)) continue;
      const node = nodes[i] as DucNode;
      const ready = node.inputs.every((v) => {
        const p = producer.get(v);
        return p === undefined || emitted.has(p);
      });
      if (!ready) continue;
      emitted.add(i);
      order.push(node);
      progressed = true;
      break;
    }
    if (!progressed) throw new Error("the graph has a cycle; it has no line form");
  }
  return order;
}
