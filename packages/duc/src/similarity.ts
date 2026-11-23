// SPDX-License-Identifier: Apache-2.0
/**
 * Structural distance between graphs (#1280): the check that selects among the candidates a vector
 * search returns. Identity decides an exact match; for a near match, the distance is one minus the
 * weighted Jaccard similarity of two bags taken from each canonical graph:
 *
 * - its nodes, each as its kind and label (a diamond as its reason and symbol, a parameter as its
 *   position);
 * - its edges, each as the producer's and consumer's node and the input position.
 *
 * A rewrite that adds a node (`x + 0`) or swaps two operands changes a few entries of a large bag,
 * so the original stays the nearest graph. Names and origins never enter, as in identity.
 *
 * A comparison written the other way round (`b > a` for `a < b`) is counted as the same entry:
 * `>` and `>=` enter as `<` and `<=` with their input positions swapped. This is for selection
 * only. Identity keeps the two distinct, because the order in which JavaScript converts the
 * operands to primitives differs between them.
 */
import { canonicalizeGraph } from "./canonical.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

/** A comparison's mirror: `b > a` selects like `a < b`. */
const MIRROR: Readonly<Record<string, string>> = { ">": "<", ">=": "<=" };
const mirrored = (n: DucNode): boolean =>
  n.kind === "op" && n.inputs.length === 2 && MIRROR[n.label ?? ""] !== undefined;

/** A node's key; a parameter is keyed by its position, so `a < b` and `a > b` stay apart. */
const nodeKey = (n: DucNode, params: ReadonlyMap<DucNode, number>): string => {
  if (mirrored(n)) return `op:${MIRROR[n.label ?? ""]}`;
  if (n.kind === "diamond-source") return `diamond:${n.diamond?.reason}:${n.diamond?.symbol}`;
  if (n.kind === "carry-source") return `carry:${(n.label ?? "").replace(/\d+$/, "")}`;
  if (n.kind === "param-source") return `param:${params.get(n) ?? "?"}`;
  return `${n.kind}:${n.label ?? ""}`;
};

/** Rounds of neighbourhood refinement in a bag (measured on the corpus, #1280). */
const WL_ROUNDS = 2;
/** Refined keys to short names, shared by every bag so equal keys get equal names. */
const INTERN = new Map<string, string>();

/** The bag of a graph's node and edge keys, with closures' bags folded in. */
export function structuralBag(g: DucGraph): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (k: string): void => {
    bag.set(k, (bag.get(k) ?? 0) + 1);
  };
  // Refined keys are interned to short names, so the bag's keys stay small.
  const interned = new Map<string, string>();
  const intern = (k: string): string => {
    let id = interned.get(k);
    if (id === undefined) {
      id = INTERN.get(k) ?? `#${INTERN.size}`;
      INTERN.set(k, id);
      interned.set(k, id);
    }
    return id;
  };
  const walk = (graph: DucGraph, depth: number): void => {
    const canon = canonicalizeGraph(graph.nodes, graph.obs, graph.branches ?? []);
    const producer = new Map<ValueId, DucNode>();
    for (const n of canon.nodes) for (const v of n.outputs) producer.set(v, n);
    const params = new Map<DucNode, number>();
    for (const n of canon.nodes) if (n.kind === "param-source") params.set(n, params.size);
    const key = (n: DucNode): string => nodeKey(n, params);
    for (const n of canon.nodes) {
      add(`n${depth}|${key(n)}`);
      const flip = mirrored(n);
      n.inputs.forEach((v, i) => {
        const p = producer.get(v);
        const at = flip ? 1 - i : i;
        add(`e${depth}|${p !== undefined ? key(p) : "?"}>${key(n)}#${at}`);
      });
      if (n.closure !== undefined) walk(n.closure, depth + 1);
    }
    for (const v of canon.obs) {
      const p = producer.get(v);
      add(`o${depth}|${p !== undefined ? key(p) : "?"}`);
    }
    // Two rounds of neighbourhood refinement: each node keyed with its inputs' keys, then with
    // theirs. An edge key sees one step; two equal producers feeding a comparison the other way
    // round (`f(a) < f(b)` against `f(b) < f(a)`) are told apart only further up.
    let labels = new Map<DucNode, string>(canon.nodes.map((n) => [n, key(n)]));
    for (let round = 1; round <= WL_ROUNDS; round++) {
      const next = new Map<DucNode, string>();
      for (const n of canon.nodes) {
        const ins = n.inputs.map((v) => {
          const p = producer.get(v);
          return p !== undefined ? (labels.get(p) ?? "?") : "?";
        });
        if (mirrored(n)) ins.reverse();
        next.set(n, intern(`${labels.get(n)}(${ins.join(",")})`));
      }
      labels = next;
    }
    if (WL_ROUNDS > 0) for (const n of canon.nodes) add(`w${depth}|${labels.get(n)}`);
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
