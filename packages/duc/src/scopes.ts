// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduling a graph's structured control for a lowering that writes statements in order (#1289,
 * #1292): each scope's items (nodes, branches, loops) in an order where every value is computed
 * before it is used. Shared by the WebAssembly and the native (LLVM) lowerings.
 */
import { bodyPathOf, isPrefix, sidePath } from "./line-form.js";
import type { DucBranch, DucGraph, DucNode, NodeId, ValueId } from "./types.js";

export type ScopeItem =
  | { readonly kind: "node"; readonly node: DucNode; readonly at: number }
  | { readonly kind: "branch"; readonly branch: DucBranch; readonly at: number }
  | { readonly kind: "loop"; readonly node: DucNode; readonly at: number };

export interface ScopePlanner {
  /** The items directly in a scope (undefined: the top level), in source order. */
  itemsOf(scope: string | undefined): ScopeItem[];
  /** Items in dependency order. */
  ordered(items: readonly ScopeItem[]): ScopeItem[];
  /** The values an item reads from outside itself. */
  needsOf(item: ScopeItem): ValueId[];
  /** The values an item defines for the scope it is in. */
  producesOf(item: ScopeItem): readonly ValueId[];
}

/**
 * A planner over a graph. `owners` maps a join node to the branch it joins (joinOwners); `resolve`
 * maps a loop invariant to the outer value it stands for; `fail` makes the lowering's own error.
 */
export function scopePlanner(
  g: DucGraph,
  owners: ReadonlyMap<NodeId, DucBranch>,
  resolve: (v: ValueId) => ValueId,
  fail: (message: string) => Error,
  after: ReadonlyMap<NodeId, readonly ValueId[]> = new Map(),
): ScopePlanner {
  const branches = g.branches ?? [];
  const indexOf = new Map(g.nodes.map((n, i) => [n.id, i]));
  const madeWithin = (path: string): Set<ValueId> =>
    new Set(g.nodes.filter((n) => isPrefix(path, n.region)).flatMap((n) => n.outputs));
  // The nodes an item holds: itself, or every node inside a branch's sides or a loop's body.
  const nodesOf = (item: ScopeItem): DucNode[] => {
    if (item.kind === "node") return [item.node];
    const paths =
      item.kind === "branch"
        ? [sidePath(item.branch, "t"), sidePath(item.branch, "e")]
        : [bodyPathOf(item.node)];
    const inside = g.nodes.filter((n) => paths.some((p) => isPrefix(p, n.region)));
    return item.kind === "loop" ? [item.node, ...inside] : inside;
  };
  // A heap operation comes after the operations its token names (loweringView's `after`), inside or
  // outside the item that holds it.
  const heapNeeds = (item: ScopeItem): ValueId[] => {
    const held = nodesOf(item);
    const madeHere = new Set(held.flatMap((n) => n.outputs));
    return held.flatMap((n) => (after.get(n.id) ?? []).filter((v) => !madeHere.has(v)));
  };
  const needsOf = (item: ScopeItem): ValueId[] => [...dataNeeds(item), ...heapNeeds(item)];
  const dataNeeds = (item: ScopeItem): ValueId[] => {
    if (item.kind === "node" || item.kind === "loop") return item.node.inputs.map(resolve);
    const b = item.branch;
    const paths = [sidePath(b, "t"), sidePath(b, "e")];
    const inside = new Set(paths.flatMap((p) => [...madeWithin(p)]));
    const inner = g.nodes
      .filter((n) => paths.some((p) => isPrefix(p, n.region)))
      .flatMap((n) => n.inputs.map(resolve))
      .filter((v) => !inside.has(v));
    const joins = g.nodes
      .filter((n) => owners.get(n.id)?.id === b.id)
      .flatMap((n) => n.inputs.slice(1).map(resolve));
    // A branch nested in a side tests its condition there: a value the item reads, like a node's
    // input (an if whose only exits are throws leaves its condition outside, #1292).
    const nestedConds = branches
      .filter((nb) => nb.within !== undefined && paths.some((p) => isPrefix(p, nb.within)))
      .map((nb) => resolve(nb.cond))
      .filter((v) => !inside.has(v));
    return [resolve(b.cond), ...inner, ...joins, ...nestedConds];
  };
  const producesOf = (item: ScopeItem): readonly ValueId[] =>
    item.kind === "branch"
      ? g.nodes.filter((n) => owners.get(n.id)?.id === item.branch.id).flatMap((n) => n.outputs)
      : item.node.outputs;
  const itemsOf = (scope: string | undefined): ScopeItem[] => {
    const items: ScopeItem[] = [];
    for (const n of g.nodes) {
      if (n.region !== scope || owners.has(n.id)) continue;
      const at = indexOf.get(n.id) as number;
      items.push(n.kind === "loop" ? { kind: "loop", node: n, at } : { kind: "node", node: n, at });
    }
    for (const b of branches) {
      if (b.within !== scope) continue;
      const firstInside = g.nodes.findIndex(
        (n) => isPrefix(sidePath(b, "t"), n.region) || isPrefix(sidePath(b, "e"), n.region),
      );
      items.push({
        kind: "branch",
        branch: b,
        at: firstInside === -1 ? g.nodes.length : firstInside,
      });
    }
    return items;
  };
  const ordered = (items: readonly ScopeItem[]): ScopeItem[] => {
    // Every value made within an item is the item's here (its joins, and every node inside it): a
    // later item needing it, as data or as heap order, waits for it.
    const producedHere = new Map<ValueId, ScopeItem>();
    for (const it of items) {
      for (const n of nodesOf(it)) for (const v of n.outputs) producedHere.set(v, it);
      for (const v of producesOf(it)) producedHere.set(v, it);
    }
    const done = new Set<ScopeItem>();
    const out: ScopeItem[] = [];
    const pending = [...items].sort((a, b) => a.at - b.at);
    while (pending.length > 0) {
      const at = pending.findIndex((it) =>
        needsOf(it).every((v) => {
          const p = producedHere.get(v);
          return p === undefined || p === it || done.has(p);
        }),
      );
      if (at === -1) throw fail("a scope's statements depend on each other");
      const [it] = pending.splice(at, 1) as [ScopeItem];
      done.add(it);
      out.push(it);
    }
    return out;
  };
  return { itemsOf, ordered, needsOf, producesOf };
}
