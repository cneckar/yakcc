// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-INFLUENCE-FACET-I-AXIS-001 (may-influence, I0)
// May-influence over a DUC graph is the closure of flows-to through opaque nodes:
// at an opaque node every input may affect every output — the complete
// input->output relation is the only sound assumption opacity permits (DUC Def
// 4.2). The relation is (a) sound for *every* interpretation of the opaque nodes
// (DUC Thm 4.5), (b) realized by a term model where subterm-occurrence *is*
// influence (DUC Thm 4.6), and therefore (c) the least sound relation the graph
// alone supports (DUC Cor 4.7). It is not "dependency" — the graph shows only
// that a value crossed a node's interface, which is why we compute an upper
// bound and hand back a structural witness rather than a claim of necessity.
//
// Complexity: one linear backward reachability per query. `mayInfluencePairs`
// materializes the full relation (for leastness tests / compose summaries) and is
// O(|V| * |edges|) in the worst case.

import type { DiamondLabel, DucGraph, DucNode, NodeId, ValueId } from "./types.js";
import { defMap, nodeIndex } from "./types.js";

// ---------------------------------------------------------------------------
// One-step influence index
// ---------------------------------------------------------------------------

/** Forward and backward one-step influence adjacency over values. */
export interface InfluenceIndex {
  /** v -> values w such that some node has v as input and w as output. */
  readonly forward: ReadonlyMap<ValueId, readonly ValueId[]>;
  /** w -> values v such that some node has v as input and w as output. */
  readonly backward: ReadonlyMap<ValueId, readonly ValueId[]>;
}

/** Build the one-step influence adjacency (the `⤳` relation of DUC Def 4.2). */
export function influenceIndex(graph: DucGraph): InfluenceIndex {
  const forward = new Map<ValueId, ValueId[]>();
  const backward = new Map<ValueId, ValueId[]>();
  for (const node of graph.nodes) {
    for (const input of node.inputs) {
      for (const output of node.outputs) {
        (forward.get(input) ?? setDefault(forward, input)).push(output);
        (backward.get(output) ?? setDefault(backward, output)).push(input);
      }
    }
  }
  return { forward, backward };
}

function setDefault(map: Map<ValueId, ValueId[]>, key: ValueId): ValueId[] {
  const list: ValueId[] = [];
  map.set(key, list);
  return list;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * The influence cone of `target`: every value E ≠ target with E ⤳* target
 * (may-influence, transitive). This is the "observability face" of DUC Cor 4.10 —
 * exactly what a vantage at `target` can reflect of the rest of the computation.
 */
export function influenceCone(
  graph: DucGraph,
  target: ValueId,
  index: InfluenceIndex = influenceIndex(graph),
): ReadonlySet<ValueId> {
  const cone = new Set<ValueId>();
  const stack = [...(index.backward.get(target) ?? [])];
  while (stack.length > 0) {
    const value = stack.pop() as ValueId;
    if (cone.has(value) || value === target) continue;
    cone.add(value);
    for (const pred of index.backward.get(value) ?? []) stack.push(pred);
  }
  return cone;
}

/** Whether `a` may-influence `b` (a ⤳* b), a ≠ b. */
export function mayInfluence(graph: DucGraph, a: ValueId, b: ValueId): boolean {
  if (a === b) return false;
  return influenceCone(graph, b).has(a);
}

/** All ordered pairs (E, F), E ≠ F, with E ⤳* F. The materialized relation. */
export function mayInfluencePairs(graph: DucGraph): ReadonlyArray<readonly [ValueId, ValueId]> {
  const index = influenceIndex(graph);
  const pairs: Array<readonly [ValueId, ValueId]> = [];
  for (const target of graph.values) {
    for (const source of influenceCone(graph, target, index)) {
      pairs.push([source, target]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Unknown-support (usupp)
// ---------------------------------------------------------------------------

/** One diamond-source in a value's unknown-support. */
export interface DiamondSupport {
  readonly value: ValueId;
  readonly label: DiamondLabel;
}

/**
 * The unknown-support of `value` (DUC Cor 4.10, `usupp`): the diamond-sources
 * whose output may-influences `value` (or equals it). Every claim downstream of
 * `value` is conditioned on exactly these declared unknowns — this is the
 * computed fact that replaces shave's informal "candidate pending audit" status.
 * Computable by one reachability query.
 */
/** Pre-built lookups shared across many usupp queries over the same graph. */
export interface UsuppMaps {
  readonly nodes: ReadonlyMap<NodeId, DucNode>;
  readonly def: ReadonlyMap<ValueId, NodeId>;
}

export function usupp(
  graph: DucGraph,
  value: ValueId,
  index: InfluenceIndex = influenceIndex(graph),
  maps?: UsuppMaps,
): readonly DiamondSupport[] {
  const cone = influenceCone(graph, value, index);
  const nodes = maps?.nodes ?? nodeIndex(graph);
  const def = maps?.def ?? defMap(graph);
  const support: DiamondSupport[] = [];
  const consider = (candidate: ValueId): void => {
    const definer = def.get(candidate);
    if (definer === undefined) return;
    // `definer` is a node id drawn from the same graph, so it always indexes.
    const node = nodes.get(definer) as DucNode;
    if (node.diamond !== undefined) {
      support.push({ value: candidate, label: node.diamond });
    }
  };
  consider(value);
  for (const candidate of cone) consider(candidate);
  return support;
}

/** The unknown-support of every observation of the graph, keyed by obs value. */
export function usuppOfObservations(
  graph: DucGraph,
): ReadonlyMap<ValueId, readonly DiamondSupport[]> {
  const index = influenceIndex(graph);
  // Build the node/def indices once and thread them through every query.
  const maps: UsuppMaps = { nodes: nodeIndex(graph), def: defMap(graph) };
  const out = new Map<ValueId, readonly DiamondSupport[]>();
  for (const observed of graph.obs) out.set(observed, usupp(graph, observed, index, maps));
  return out;
}

// ---------------------------------------------------------------------------
// Term-model witness (DUC Thm 4.6)
// ---------------------------------------------------------------------------

/**
 * The symbolic provenance term of a value under the term interpretation. Every
 * influence claim comes with such a witness: an inspectable structural object in
 * which subterm-occurrence *is* influence. For a source it is a leaf; otherwise
 * it is `kind_outport(child terms...)`.
 */
export interface WitnessTerm {
  readonly value: ValueId;
  readonly kind: string;
  /** Present for source leaves (`param-source` / `literal-source` / `diamond-source`). */
  readonly source?: { readonly kind: string; readonly symbol?: string };
  readonly children: readonly WitnessTerm[];
}

/**
 * Build the witness term of `value`. The graph is acyclic (WF-A), so the
 * recursion terminates; equal sub-values share a memoized sub-term.
 */
export function witness(graph: DucGraph, value: ValueId): WitnessTerm {
  const def = defMap(graph);
  const nodes = nodeIndex(graph);
  const memo = new Map<ValueId, WitnessTerm>();

  const build = (current: ValueId): WitnessTerm => {
    const cached = memo.get(current);
    if (cached !== undefined) return cached;
    const definerId = def.get(current);
    const node = definerId !== undefined ? nodes.get(definerId) : undefined;
    if (node === undefined || node.inputs.length === 0) {
      // Source leaf (or, defensively, a dangling value: a leaf with no children).
      const term: WitnessTerm = {
        value: current,
        kind: node?.kind ?? "unknown",
        ...(node?.diamond !== undefined
          ? { source: { kind: "diamond-source", symbol: node.diamond.symbol } }
          : node !== undefined
            ? { source: { kind: node.kind } }
            : {}),
        children: [],
      };
      memo.set(current, term);
      return term;
    }
    const term: WitnessTerm = {
      value: current,
      kind: node.kind,
      children: node.inputs.map(build),
    };
    memo.set(current, term);
    return term;
  };

  return build(value);
}

/** Render a witness term as a compact S-expression, for logs and reports. */
export function renderWitness(term: WitnessTerm): string {
  if (term.children.length === 0) {
    if (term.source?.symbol !== undefined) return `♦${term.source.symbol}`;
    return term.source?.kind ?? term.kind;
  }
  return `${term.kind}(${term.children.map(renderWitness).join(", ")})`;
}
