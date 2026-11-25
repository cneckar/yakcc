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
  // The nodes by region, so a path's nodes are those of the few regions under it, not every node.
  const byRegion = new Map<string, DucNode[]>();
  for (const n of g.nodes) {
    if (n.region === undefined) continue;
    const list = byRegion.get(n.region);
    if (list === undefined) byRegion.set(n.region, [n]);
    else list.push(n);
  }
  const regions = [...byRegion.keys()];
  const withinCache = new Map<string, DucNode[]>();
  const nodesWithin = (path: string): DucNode[] => {
    let hit = withinCache.get(path);
    if (hit === undefined) {
      const rs = new Set(regions.filter((r) => isPrefix(path, r)));
      hit = g.nodes.filter((n) => n.region !== undefined && rs.has(n.region));
      withinCache.set(path, hit);
    }
    return hit;
  };
  // Each item's facts, made once (an item is its node's or its branch's: itemsOf makes new objects).
  const keyOf = (item: ScopeItem): string =>
    item.kind === "branch" ? `b:${item.branch.id}` : `n:${item.node.id}`;
  const memo = <T>(cache: Map<string, T>, item: ScopeItem, make: () => T): T => {
    const k = keyOf(item);
    let v = cache.get(k);
    if (v === undefined) {
      v = make();
      cache.set(k, v);
    }
    return v;
  };
  // The nodes an item holds: itself, or every node inside a branch's sides or a loop's body.
  const nodesCache = new Map<string, DucNode[]>();
  const nodesOf = (item: ScopeItem): DucNode[] =>
    memo(nodesCache, item, () => {
      if (item.kind === "node") return [item.node];
      const paths =
        item.kind === "branch"
          ? [sidePath(item.branch, "t"), sidePath(item.branch, "e")]
          : [bodyPathOf(item.node)];
      const held = new Set(paths.flatMap((p) => nodesWithin(p)));
      const inside = g.nodes.filter((n) => held.has(n));
      return item.kind === "loop" ? [item.node, ...inside] : inside;
    });
  // A heap operation comes after the operations its token names (loweringView's `after`), inside or
  // outside the item that holds it.
  const heapNeeds = (item: ScopeItem): ValueId[] => {
    const held = nodesOf(item);
    const madeHere = new Set(held.flatMap((n) => n.outputs));
    return held.flatMap((n) => (after.get(n.id) ?? []).filter((v) => !madeHere.has(v)));
  };
  const needsCache = new Map<string, ValueId[]>();
  const needsOf = (item: ScopeItem): ValueId[] =>
    memo(needsCache, item, () => [...dataNeeds(item), ...heapNeeds(item)]);
  // The joins of each branch.
  const joinsOf = new Map<string, DucNode[]>();
  for (const n of g.nodes) {
    const b = owners.get(n.id);
    if (b === undefined) continue;
    const list = joinsOf.get(b.id);
    if (list === undefined) joinsOf.set(b.id, [n]);
    else list.push(n);
  }
  const dataNeeds = (item: ScopeItem): ValueId[] => {
    if (item.kind === "node" || item.kind === "loop") return item.node.inputs.map(resolve);
    const b = item.branch;
    const paths = [sidePath(b, "t"), sidePath(b, "e")];
    const held = nodesOf(item);
    const inside = new Set(held.flatMap((n) => n.outputs));
    const inner = held.flatMap((n) => n.inputs.map(resolve)).filter((v) => !inside.has(v));
    const joins = (joinsOf.get(b.id) ?? []).flatMap((n) => n.inputs.slice(1).map(resolve));
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
      ? (joinsOf.get(item.branch.id) ?? []).flatMap((n) => n.outputs)
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
    // Each item's needs made here by another item of the scope: it waits for those.
    const waits = new Map<ScopeItem, ScopeItem[]>();
    for (const it of pending) {
      const ws = new Set<ScopeItem>();
      for (const v of needsOf(it)) {
        const p = producedHere.get(v);
        if (p !== undefined && p !== it) ws.add(p);
      }
      waits.set(it, [...ws]);
    }
    while (pending.length > 0) {
      const at = pending.findIndex((it) =>
        (waits.get(it) as ScopeItem[]).every((p) => done.has(p)),
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
