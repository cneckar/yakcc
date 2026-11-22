// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering to TypeScript (#1275, decision 5A): a graph is emitted as a TypeScript function whose
 * lifted graph has the same identity. The graph is the authority; this is its TypeScript form.
 *
 * The code is generated, not written for people: one statement per node, in single-assignment
 * style. Values are named by their ids (`$v3`). An `if` is a block whose joins are variables
 * assigned on each side; a loop is a `while`, `for...of` or `for...in` block whose carried values
 * are variables. Member reads that are called, spreads and array holes are written inline, so a
 * method call keeps its receiver.
 *
 * The graph does not hold types, so the code is untyped. A graph the line form cannot express, or
 * that holds an opaque node (a closure, a class, a construct summarized by its text), or the return
 * state of returns on some paths, has no TypeScript form here: `emitTypeScript` throws EmitError.
 */
import { bodyPathOf, isPrefix, joinOwners, printLineForm, sidePath } from "./line-form.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmitError";
  }
}

const BINARY = new Set([
  "+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "==", "!=", "===", "!==",
  "&", "|", "^", "<<", ">>", ">>>", "&&", "||", "??", "in", "instanceof",
]);
const COMPOUND = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>=", "&&=", "||=", "??="]);
const PREFIX = new Set(["!", "-", "+", "~"]);
const CALLS = new Set(["CallExpression", "CallExpression?.", "NewExpression"]);

const isMemberRead = (label: string): boolean =>
  (label !== "..." && (label.startsWith(".") || label.startsWith("?.")) && !label.endsWith("=")) ||
  label === "ElementAccess" ||
  label === "ElementAccess?.";

/** Emits a graph as a TypeScript function. Throws EmitError for a graph it cannot express. */
export function emitTypeScript(g: DucGraph): string {
  // The structure must be expressible: the line form's checks hold here too.
  try {
    printLineForm(g);
  } catch (e) {
    throw new EmitError(e instanceof Error ? e.message : String(e));
  }
  if (g.obs.length > 1) throw new EmitError("more than one observation");

  const branches = g.branches ?? [];
  const producer = new Map<ValueId, DucNode>();
  const consumers = new Map<ValueId, DucNode[]>();
  for (const node of g.nodes) {
    for (const v of node.outputs) producer.set(v, node);
    for (const v of node.inputs) consumers.set(v, [...(consumers.get(v) ?? []), node]);
  }
  const owners = joinOwners(g);
  const loops = g.nodes.filter((n) => n.kind === "loop");

  // Invariant sources stand for outer values, and are written as those values.
  const invariantOuter = new Map<ValueId, ValueId>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => invariantOuter.set(v, loop.inputs[offset + j] as ValueId));
  }

  const imports = new Map<string, Set<string>>();
  const nameOf = (v: ValueId): string => {
    const outer = invariantOuter.get(v);
    if (outer !== undefined) return nameOf(outer);
    const p = producer.get(v);
    if (p?.kind === "diamond-source" && p.diamond !== undefined) {
      if (p.diamond.reason === "unlinked-reference") {
        const module = p.diamond.module;
        if (module === undefined) throw new EmitError(`imported binding ${p.diamond.symbol} has no module`);
        imports.set(module, new Set([...(imports.get(module) ?? []), p.diamond.symbol]));
      }
      return p.diamond.symbol;
    }
    return `$${v}`;
  };

  // Nodes written inline, inside the expression that uses them, not as statements of their own.
  const inline = new Set<NodeId>();
  for (const node of g.nodes) {
    if (node.kind !== "op") continue;
    const label = node.label ?? "";
    if (label === "..." || label.startsWith("OmittedExpression#")) inline.add(node.id);
    if (isMemberRead(label)) {
      const out = node.outputs[0] as ValueId;
      const users = consumers.get(out) ?? [];
      const only = users[0];
      if (users.length === 1 && only !== undefined && CALLS.has(only.label ?? "") && only.inputs[0] === out && only.inputs.indexOf(out, 1) === -1) {
        inline.add(node.id);
      }
    }
  }
  // A while condition is written in the loop's header, so its nodes are inline.
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.cond === undefined) continue;
    const body = bodyPathOf(loop);
    const mark = (v: ValueId): void => {
      const p = producer.get(v);
      if (p === undefined || p.kind === "carry-source" || p.kind === "diamond-source") return;
      if (p.region !== body) throw new EmitError(`the condition of loop ${loop.id} is not computed at the top of its body`);
      // The condition itself is used only by the loop; a value inside it only by the condition.
      if ((consumers.get(v) ?? []).length > (v === rec.cond ? 0 : 1)) {
        throw new EmitError(`the condition of loop ${loop.id} shares a value with the body`);
      }
      inline.add(p.id);
      for (const input of p.inputs) mark(input);
    };
    mark(rec.cond);
  }

  /** A value as an expression: its name, or its inline expression. */
  const ref = (v: ValueId): string => {
    const p = producer.get(v);
    if (p === undefined || !inline.has(p.id)) return nameOf(v);
    const label = p.label ?? "";
    const expr = render(p);
    return label === "..." || label.startsWith("OmittedExpression#") || isMemberRead(label) ? expr : `(${expr})`;
  };

  /** An operation, literal or select, as an expression. */
  const render = (node: DucNode): string => {
    if (node.kind === "literal-source") {
      if (node.label === "undefined") throw new EmitError("the return state of returns on some paths has no TypeScript form yet");
      return node.label ?? "";
    }
    if (node.kind === "sel") {
      const [c, a, b] = node.inputs as [ValueId, ValueId, ValueId];
      return `${ref(c)} ? ${ref(a)} : ${ref(b)}`;
    }
    if (node.kind !== "op") throw new EmitError(`a ${node.kind} is not an expression`);
    const label = node.label ?? "";
    const ins = node.inputs;
    const arg = (i: number): string => ref(ins[i] as ValueId);
    if (BINARY.has(label) && ins.length === 2) return `${arg(0)} ${label} ${arg(1)}`;
    if (label === "," && ins.length === 2) return `(${arg(0)}, ${arg(1)})`;
    if (PREFIX.has(label) && ins.length === 1) return `${label}${arg(0)}`;
    if (label === "TypeOfExpression") return `typeof ${arg(0)}`;
    if (label === "VoidExpression") return `void ${arg(0)}`;
    if (isMemberRead(label)) {
      if (label === "ElementAccess") return `${arg(0)}[${arg(1)}]`;
      if (label === "ElementAccess?.") return `${arg(0)}?.[${arg(1)}]`;
      return `${arg(0)}${label}`;
    }
    if (CALLS.has(label)) {
      const callee = arg(0);
      const args = ins.slice(1).map((v) => ref(v)).join(", ");
      if (label === "NewExpression") return `new ${callee}(${args})`;
      return label === "CallExpression?." ? `${callee}?.(${args})` : `${callee}(${args})`;
    }
    if (label === "ArrayLiteral") return `[${ins.map((v) => ref(v)).join(", ")}]`;
    if (label === "...") return `...${arg(0)}`;
    if (label.startsWith("OmittedExpression#")) return "";
    if (label.startsWith("ThisKeyword#")) return "this";
    if (label.startsWith("object:")) {
      const entries = JSON.parse(label.slice("object:".length)) as unknown[];
      let at = 0;
      const next = (): string => ref(ins[at++] as ValueId);
      const parts = entries.map((entry) => {
        if (entry === null) return `...${next()}`;
        if (entry === 1) {
          const key = next();
          return `[${key}]: ${next()}`;
        }
        if (typeof entry === "string") return `${JSON.stringify(entry)}: ${next()}`;
        throw new EmitError("an object method or accessor has no TypeScript form here");
      });
      return `{ ${parts.join(", ")} }`;
    }
    if (label.startsWith("template:") || label.startsWith("tagged:")) {
      const tagged = label.startsWith("tagged:");
      const parts = JSON.parse(label.slice(tagged ? "tagged:".length : "template:".length)) as string[];
      const exprs = tagged ? ins.slice(1) : ins;
      let text = `\`${parts[0] ?? ""}`;
      exprs.forEach((v, i) => {
        text += `\${${ref(v)}}${parts[i + 1] ?? ""}`;
      });
      text += "`";
      return tagged ? `${arg(0)}${text}` : text;
    }
    throw new EmitError(`the operation "${label}" has no TypeScript form`);
  };

  /** The statements of one node. */
  const statementsOf = (node: DucNode): string[] => {
    const out = node.outputs[0];
    const label = node.label ?? "";
    if (node.kind === "literal-source") {
      if (label === "Uninitialized") return [`let ${nameOf(out as ValueId)};`];
      return [`const ${nameOf(out as ValueId)} = ${render(node)};`];
    }
    if (node.kind === "sel") return [`const ${nameOf(out as ValueId)} = ${render(node)};`];
    if (node.kind !== "op") throw new EmitError(`a ${node.kind} is not a statement`);
    const arg = (i: number): string => ref(node.inputs[i] as ValueId);
    if (label === "throw") return [`throw ${arg(0)};`];
    if (out === undefined) throw new EmitError(`the statement "${label}" has no TypeScript form`);
    const name = nameOf(out);
    if (COMPOUND.has(label)) return [`let ${name} = ${arg(0)};`, `${name} ${label} ${arg(1)};`];
    if (label === "++" || label === "--") return [`let ${name} = ${arg(0)};`, `${label}${name};`];
    if (label === "post++" || label === "post--") return [`let ${name} = ${arg(0)};`, `${name}${label.slice(4)};`];
    if (label.startsWith(".") && label.endsWith("=")) {
      return [`let ${name} = ${arg(0)};`, `${name}${label.slice(0, -1)} = ${arg(1)};`];
    }
    if (label === "[]=") return [`let ${name} = ${arg(0)};`, `${name}[${arg(1)}] = ${arg(2)};`];
    return [`const ${name} = ${render(node)};`];
  };

  const indent = (lines: string[]): string[] => lines.map((l) => `  ${l}`);
  const nodeIndex = new Map(g.nodes.map((n, i) => [n.id, i] as const));

  /** The values a node needs, through the inline nodes it writes. */
  const needs = (node: DucNode): ValueId[] =>
    node.inputs.flatMap((v) => {
      const p = producer.get(v);
      return p !== undefined && inline.has(p.id) ? needs(p) : [v];
    });

  const emitBranch = (b: DucBranch): string[] => {
    const thenPath = sidePath(b, "t");
    const elsePath = sidePath(b, "e");
    const inside = (v: ValueId): boolean => {
      const region = producer.get(v)?.region;
      return isPrefix(thenPath, region) || isPrefix(elsePath, region);
    };
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    const before: string[] = [];
    const thenAssign: string[] = [];
    const elseAssign: string[] = [];
    for (const j of joins) {
      const [cond, t, e] = j.inputs as [ValueId, ValueId, ValueId];
      // The join's variable starts from a value from before the if, so the binding adds no node.
      const start = !inside(e) ? e : !inside(t) ? t : cond;
      const name = nameOf(j.outputs[0] as ValueId);
      before.push(`let ${name} = ${ref(start)};`);
      if (t !== start) thenAssign.push(`${name} = ${ref(t)};`);
      if (e !== start) elseAssign.push(`${name} = ${ref(e)};`);
    }
    const thenLines = [...emitScope(thenPath), ...thenAssign];
    const elseLines = [...emitScope(elsePath), ...elseAssign];
    return [
      ...before,
      `if (${ref(b.cond)}) {`,
      ...indent(thenLines),
      ...(elseLines.length > 0 ? ["} else {", ...indent(elseLines)] : []),
      "}",
    ];
  };

  const emitLoop = (loop: DucNode): string[] => {
    const rec = loop.loop as DucLoop;
    const count = rec.carry.length;
    const carried = rec.carry.map((v) => nameOf(v));
    const before = carried.map((name, i) => `let ${name} = ${ref(loop.inputs[i] as ValueId)};`);
    const header =
      rec.iterate !== undefined
        ? `for (const ${nameOf(rec.iterate.element)} ${rec.iterate.of === "values" ? "of" : "in"} ${ref(loop.inputs[count] as ValueId)}) {`
        : `while (${ref(rec.cond as ValueId)}) {`;
    const body = emitScope(bodyPathOf(loop));
    const next = rec.next.map((v, i) => `${carried[i]} = ${ref(v)};`);
    const after = loop.outputs.map((v, i) => `const ${nameOf(v)} = ${carried[i]};`);
    return [...before, header, ...indent([...body, ...next]), "}", ...after];
  };

  /** The statements of one scope, each after the values it needs. */
  function emitScope(scope: string | undefined): string[] {
    interface Item {
      readonly first: number;
      readonly last: boolean;
      readonly produces: readonly ValueId[];
      readonly requires: readonly ValueId[];
      readonly lines: () => string[];
    }
    const items: Item[] = [];
    for (const node of g.nodes) {
      if (node.region !== scope || owners.has(node.id) || inline.has(node.id)) continue;
      if (node.kind === "param-source" || node.kind === "diamond-source" || node.kind === "carry-source" || node.kind === "loop") continue;
      items.push({
        first: nodeIndex.get(node.id) as number,
        last: node.label === "throw",
        produces: node.outputs,
        requires: needs(node),
        lines: () => statementsOf(node),
      });
    }
    for (const loop of loops) {
      if (loop.region !== scope) continue;
      items.push({
        first: nodeIndex.get(loop.id) as number,
        last: false,
        produces: loop.outputs,
        requires: loop.inputs,
        lines: () => emitLoop(loop),
      });
    }
    for (const b of branches) {
      if (b.within !== scope) continue;
      const thenPath = sidePath(b, "t");
      const elsePath = sidePath(b, "e");
      const subtree = g.nodes.filter((n) => isPrefix(thenPath, n.region) || isPrefix(elsePath, n.region));
      const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
      const innerValues = new Set(subtree.flatMap((n) => n.outputs));
      const requires = [b.cond, ...subtree.flatMap((n) => n.inputs), ...joins.flatMap((n) => n.inputs)];
      items.push({
        first: Math.min(g.nodes.length, ...[...subtree, ...joins].map((n) => nodeIndex.get(n.id) as number)),
        last: false,
        produces: joins.flatMap((n) => n.outputs),
        requires: [...new Set(requires)].filter((v) => !innerValues.has(v)),
        lines: () => emitBranch(b),
      });
    }
    // A throw ends its scope, so it comes after everything else there.
    items.sort((a, b) => (a.last === b.last ? a.first - b.first : a.last ? 1 : -1));
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
      if (next === -1) throw new EmitError("the graph has a cycle");
      done.add(next);
      lines.push(...(items[next] as Item).lines());
    }
    return lines;
  }

  // A free or ambient name that nothing uses is still part of the atom: it is read on its own.
  const used = new Set<ValueId>([...g.obs, ...branches.map((b) => b.cond)]);
  for (const node of g.nodes) for (const v of node.inputs) used.add(v);
  const unread = g.nodes
    .filter((n) => n.kind === "diamond-source" && !used.has(n.outputs[0] as ValueId))
    .map((n) => `${nameOf(n.outputs[0] as ValueId)};`);

  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => Number(a.label) - Number(b.label))
    .map((n) => nameOf(n.outputs[0] as ValueId));
  const body = [...unread, ...emitScope(undefined)];
  const obs = g.obs[0];
  if (obs !== undefined) body.push(`return ${ref(obs)};`);
  const importLines = [...imports.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([module, symbols]) => `import { ${[...symbols].sort().join(", ")} } from ${JSON.stringify(module)};`);
  return [...importLines, `export function f(${params.join(", ")}) {`, ...indent(body), "}", ""].join("\n");
}
