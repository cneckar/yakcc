// SPDX-License-Identifier: Apache-2.0
/**
 * The heap token for lowerings (#1285). In the graph, a heap operation's last input orders it (its
 * `order` flag), and the token's selects and carries join and carry it through branches and loops.
 * A lowering writes none of that: its statements run in order, so the order is that of the statements
 * it writes. `loweringView` gives the graph a lowering reads, the same graph without the token, and
 * for each heap operation the values it must come after.
 */
import type { DucGraph, DucLoop, DucNode, NodeId, ValueId } from "./types.js";

/** Whether a node is the heap token's: a select or a carry that computes nothing. */
export function isHeapToken(n: DucNode): boolean {
  return (
    (n.kind === "sel" && n.label === "heap") ||
    (n.kind === "carry-source" && n.label?.endsWith(":heap") === true)
  );
}

export interface LoweringView {
  /** The graph without heap tokens: no ordering inputs, token selects or token carries. */
  readonly graph: DucGraph;
  /**
   * For each heap operation, the operations (their values) it comes after. Such a value may lie inside
   * a branch or a loop body: the operation then comes after that branch or loop.
   */
  readonly after: ReadonlyMap<NodeId, readonly ValueId[]>;
}

export function loweringView(g: DucGraph): LoweringView {
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const heapCarries = new Map<NodeId, Set<number>>();
  for (const n of g.nodes) {
    if (n.loop === undefined) continue;
    const idx = new Set<number>();
    n.loop.carry.forEach((v, i) => {
      const p = producer.get(v);
      if (p !== undefined && isHeapToken(p)) idx.add(i);
    });
    if (idx.size > 0) heapCarries.set(n.id, idx);
  }

  // The real operations a token stands for: a select's two sides, a loop's last token in its body.
  const resolve = (v: ValueId, seen: Set<ValueId>): ValueId[] => {
    if (seen.has(v)) return [];
    seen.add(v);
    const p = producer.get(v);
    if (p === undefined || p.kind === "literal-source") return [];
    if (p.kind === "sel" && p.label === "heap")
      return [...resolve(p.inputs[1] as ValueId, seen), ...resolve(p.inputs[2] as ValueId, seen)];
    if (p.kind === "carry-source" && isHeapToken(p)) return [];
    if (p.kind === "loop" && p.loop !== undefined) {
      const i = p.outputs.indexOf(v);
      const carries = heapCarries.get(p.id);
      if (carries?.has(i) === true) {
        const inside = resolve(p.loop.next[i] as ValueId, seen);
        if (inside.length > 0) return inside;
        // A body with no heap operation of its own: the loop is one (an iteration reads its iterable
        // at each step), so what is ordered after it comes after the loop (#1292), by a value it
        // makes, or a value of its body (an element, a condition): after a value inside a loop body
        // is after the loop. A loop with neither is ordered by where it starts.
        const kept = p.outputs.filter((_, j) => !carries.has(j));
        const within = kept[0] ?? p.loop.iterate?.element ?? p.loop.cond;
        if (within !== undefined) return [within];
        return [...carries].flatMap((j) => resolve(p.inputs[j] as ValueId, seen));
      }
    }
    return [v];
  };

  const after = new Map<NodeId, ValueId[]>();
  const nodes: DucNode[] = [];
  for (const n of g.nodes) {
    if (isHeapToken(n)) continue;
    let node: DucNode = n;
    if (n.order === 1) {
      const token = n.inputs[n.inputs.length - 1] as ValueId;
      const deps = [...new Set(resolve(token, new Set()))];
      if (deps.length > 0) after.set(n.id, deps);
      const { order: _order, ...rest } = n;
      node = { ...rest, inputs: n.inputs.slice(0, -1) };
    }
    const drop = heapCarries.get(n.id);
    if (drop !== undefined && n.loop !== undefined) {
      const keep = (_: unknown, i: number): boolean => !drop.has(i);
      const count = n.loop.carry.length;
      // The token the loop starts from orders the loop after the operation that made it.
      const starts = [...drop].flatMap((i) => resolve(n.inputs[i] as ValueId, new Set()));
      if (starts.length > 0) after.set(n.id, [...new Set(starts)]);
      const loop: DucLoop = {
        ...n.loop,
        carry: n.loop.carry.filter(keep),
        next: n.loop.next.filter(keep),
      };
      node = {
        ...node,
        inputs: [...node.inputs.slice(0, count).filter(keep), ...node.inputs.slice(count)],
        outputs: node.outputs.filter(keep),
        loop,
      };
    }
    nodes.push(node);
  }
  return { graph: { ...g, nodes }, after };
}
