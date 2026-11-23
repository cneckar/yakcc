// SPDX-License-Identifier: Apache-2.0
/**
 * Structural distance between graphs (#1280): the check that selects among the candidates a vector
 * search returns. Identity decides an exact match; for a near match, the distance is one minus the
 * weighted Jaccard similarity of two bags taken from each canonical graph:
 *
 * - its nodes, each as its kind and label (a diamond as its reason and symbol);
 * - its edges, each as the producer's and consumer's node and the input position.
 *
 * A rewrite that adds a node (`x + 0`) or swaps two operands changes a few entries of a large bag,
 * so the original stays the nearest graph. Names and origins never enter, as in identity.
 */
import { canonicalizeGraph } from "./canonical.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

const nodeKey = (n: DucNode): string => {
  if (n.kind === "diamond-source") return `diamond:${n.diamond?.reason}:${n.diamond?.symbol}`;
  if (n.kind === "carry-source") return `carry:${(n.label ?? "").replace(/\d+$/, "")}`;
  if (n.kind === "param-source") return "param";
  return `${n.kind}:${n.label ?? ""}`;
};

/** The bag of a graph's node and edge keys, with closures' bags folded in. */
export function structuralBag(g: DucGraph): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (k: string): void => {
    bag.set(k, (bag.get(k) ?? 0) + 1);
  };
  const walk = (graph: DucGraph, depth: number): void => {
    const canon = canonicalizeGraph(graph.nodes, graph.obs, graph.branches ?? []);
    const producer = new Map<ValueId, DucNode>();
    for (const n of canon.nodes) for (const v of n.outputs) producer.set(v, n);
    for (const n of canon.nodes) {
      add(`n${depth}|${nodeKey(n)}`);
      n.inputs.forEach((v, i) => {
        const p = producer.get(v);
        add(`e${depth}|${p !== undefined ? nodeKey(p) : "?"}>${nodeKey(n)}#${i}`);
      });
      if (n.closure !== undefined) walk(n.closure, depth + 1);
    }
    for (const v of canon.obs) {
      const p = producer.get(v);
      add(`o${depth}|${p !== undefined ? nodeKey(p) : "?"}`);
    }
  };
  walk(g, 0);
  return bag;
}

/** One minus the weighted Jaccard similarity of two bags: 0 for the same bag, 1 for disjoint ones. */
export function bagDistance(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  let inter = 0;
  let uni = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni === 0 ? 0 : 1 - inter / uni;
}

/** The structural distance between two graphs. */
export function structuralDistance(a: DucGraph, b: DucGraph): number {
  return bagDistance(structuralBag(a), structuralBag(b));
}

export interface Candidate<T> {
  readonly item: T;
  readonly identity: string;
  readonly bag: ReadonlyMap<string, number>;
  /** The vector search's score, which breaks ties. */
  readonly score: number;
}

/**
 * Select among candidates: those with the query's identity first, then by structural distance to
 * the query, then by the vector score.
 */
export function rankStructurally<T>(
  queryIdentity: string,
  queryBag: ReadonlyMap<string, number>,
  candidates: readonly Candidate<T>[],
): Candidate<T>[] {
  const scored = candidates.map((c) => ({
    c,
    d: c.identity === queryIdentity ? -1 : bagDistance(queryBag, c.bag),
  }));
  scored.sort((x, y) => (x.d !== y.d ? x.d - y.d : y.c.score - x.c.score));
  return scored.map((s) => s.c);
}
