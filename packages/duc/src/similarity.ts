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
import { ecmaScriptLabel } from "./ops.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

/** A comparison's mirror: `b > a` selects like `a < b`. */
const MIRROR: Readonly<Record<string, string>> = { ">": "<", ">=": "<=" };
const COMPARISONS = new Set(["<", "<=", ">", ">="]);
/** An operation's label as the ECMAScript operator it is a case of: one key across the vocabulary. */
const opLabel = (n: DucNode): string =>
  n.kind === "op" ? ecmaScriptLabel(n.label ?? "") : (n.label ?? "");
/** An operation's operands: its inputs but the heap token that orders it (#1285, #1370). */
const operandsOf = (n: DucNode): readonly ValueId[] =>
  n.order === 1 ? n.inputs.slice(0, -1) : n.inputs;
const mirrored = (n: DucNode): boolean =>
  n.kind === "op" && operandsOf(n).length === 2 && MIRROR[opLabel(n)] !== undefined;

/** A node's key; a parameter is keyed by its position, so `a < b` and `a > b` stay apart. */
const nodeKey = (n: DucNode, params: ReadonlyMap<DucNode, number>): string => {
  if (mirrored(n)) return `op:${MIRROR[opLabel(n)]}`;
  if (n.kind === "diamond-source") return `diamond:${n.diamond?.reason}:${n.diamond?.symbol}`;
  if (n.kind === "carry-source") return `carry:${(n.label ?? "").replace(/\d+$/, "")}`;
  if (n.kind === "param-source") return `param:${params.get(n) ?? "?"}`;
  return `${n.kind}:${opLabel(n)}`;
};

/** Rounds of neighbourhood refinement in a bag (measured on the corpus, #1280). */
const WL_ROUNDS = 2;
/** Refined keys to short names, shared by every bag so equal keys get equal names. */
const INTERN = new Map<string, string>();

/** The bag of a graph's node and edge keys, with closures' bags folded in. */
export function structuralBag(g: DucGraph): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (k: string, weight = 1): void => {
    bag.set(k, (bag.get(k) ?? 0) + weight);
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
      // The comparison as written, at half weight: a weak signal beside the mirrored entries, which
      // breaks a tie toward the operator the query used.
      if (n.kind === "op" && operandsOf(n).length === 2 && COMPARISONS.has(opLabel(n)))
        add(`r${depth}|${opLabel(n)}`, 0.5);
      const flip = mirrored(n);
      const operands = operandsOf(n);
      n.inputs.forEach((v, i) => {
        const p = producer.get(v);
        // The token is an edge of its own kind: what the node is ordered after.
        const at = i >= operands.length ? "t" : flip ? 1 - i : i;
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
        const label = (v: ValueId): string => {
          const p = producer.get(v);
          return p !== undefined ? (labels.get(p) ?? "?") : "?";
        };
        const ins = operandsOf(n).map(label);
        if (mirrored(n)) ins.reverse();
        if (n.order === 1) ins.push(`^${label(n.inputs[n.inputs.length - 1] as ValueId)}`);
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
