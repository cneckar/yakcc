// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-GRAPH-MODEL-001 (well-formedness clauses)
// Well-formedness (DUC Definition 2.5) is exactly two clauses over the graph:
//   WF-C (conservation): every value occurring in any node input or in Obs has a
//     def — equivalently, since single-assignment gives each value exactly one
//     defining node, every use has a def. A use with no incoming def is an
//     uninitialized read and the graph is ill-formed.
//   WF-A (acyclicity):   the def-use edge relation has no cycle; equivalently an
//     injective ranking A : V ∪ N -> N exists with x -> y implying A(x) < A(y).
// The ranking is a *property* of the graph, not part of its structure (nothing is
// stored). Order, happens-before, and the descent measure are theorems of WF-A.

import type { DucGraph, NodeId, ValueId } from "./types.js";
import { defMap } from "./types.js";

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/**
 * A conservation violation (WF-C): a value is used (as a node input or an
 * observation) but no node defines it. This is the "uninitialized read" — the
 * *only* well-formed way to say "this value came from outside what I can see" is
 * to connect it to a diamond-source and let that source be counted. A dangling
 * use is therefore unrepresentable in a well-formed graph, which is exactly what
 * the conservation gate (S2) relies on.
 */
export interface ConservationViolation {
  readonly kind: "conservation";
  readonly value: ValueId;
  /** The node that uses the value, or `"obs"` if it is a dangling observation. */
  readonly usedBy: NodeId | "obs";
}

/** A single-assignment violation: a value is defined by more than one node. */
export interface SingleAssignmentViolation {
  readonly kind: "single-assignment";
  readonly value: ValueId;
  readonly definedBy: readonly NodeId[];
}

/** An acyclicity violation (WF-A): a def-use cycle exists. */
export interface AcyclicityViolation {
  readonly kind: "acyclicity";
  /** One witnessing cycle over values and nodes, in traversal order. */
  readonly cycle: readonly (ValueId | NodeId)[];
}

export type WellFormednessViolation =
  | ConservationViolation
  | SingleAssignmentViolation
  | AcyclicityViolation;

/**
 * The result of a well-formedness check. On success it carries the WF-A ranking
 * (an injective A : V ∪ N -> N respecting every edge), which is the induction
 * engine every later analysis uses; on failure it carries every violation found.
 */
export type WellFormednessResult =
  | { readonly wellFormed: true; readonly ranking: ReadonlyMap<ValueId | NodeId, number> }
  | { readonly wellFormed: false; readonly violations: readonly WellFormednessViolation[] };

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Decide well-formedness of a DUC graph in O(|V| + |N| + |edges|).
 *
 * Reports *all* single-assignment and conservation violations, and — only when
 * those two clauses pass — one acyclicity witness if a cycle exists. (A cycle
 * search over a graph that already fails conservation would chase dangling
 * values; the two structural clauses are checked first so the acyclicity witness
 * is meaningful.)
 */
export function isWellFormed(graph: DucGraph): WellFormednessResult {
  const violations: WellFormednessViolation[] = [];

  // --- single assignment: every value defined by exactly one node ---
  const definers = new Map<ValueId, NodeId[]>();
  for (const node of graph.nodes) {
    for (const out of node.outputs) {
      const list = definers.get(out);
      if (list === undefined) {
        definers.set(out, [node.id]);
      } else {
        list.push(node.id);
      }
    }
  }
  for (const [value, nodes] of definers) {
    if (nodes.length > 1) {
      violations.push({ kind: "single-assignment", value, definedBy: nodes });
    }
  }

  // --- conservation: every used value has a def ---
  const def = defMap(graph);
  for (const node of graph.nodes) {
    for (const input of node.inputs) {
      if (!def.has(input)) {
        violations.push({ kind: "conservation", value: input, usedBy: node.id });
      }
    }
  }
  for (const observed of graph.obs) {
    if (!def.has(observed)) {
      violations.push({ kind: "conservation", value: observed, usedBy: "obs" });
    }
  }

  // Structural clauses first: only look for a cycle when the def relation is sound.
  if (violations.length > 0) {
    return { wellFormed: false, violations };
  }

  // --- acyclicity: topological ranking over V ∪ N, or a cycle witness ---
  const ranking = rankOrCycle(graph, def);
  if (!ranking.ok) {
    return {
      wellFormed: false,
      violations: [{ kind: "acyclicity", cycle: ranking.cycle }],
    };
  }
  return { wellFormed: true, ranking: ranking.ranking };
}

/**
 * Kahn-style topological ranking over the bipartite edge relation
 * (use edge: value -> node when the value is a node input; def edge: node ->
 * value when the value is a node output). Returns an injective ranking that
 * respects every edge, or one witnessing cycle.
 */
function rankOrCycle(
  graph: DucGraph,
  def: Map<ValueId, NodeId>,
):
  | { readonly ok: true; readonly ranking: Map<ValueId | NodeId, number> }
  | { readonly ok: false; readonly cycle: readonly (ValueId | NodeId)[] } {
  // Successor lists and in-degrees over the union V ∪ N. Every vertex is seeded
  // up front (all output values are in `graph.values`; every used value has a def
  // there because conservation already passed; every node id is a vertex), so all
  // lookups below are total — no defensive fallbacks needed.
  const succ = new Map<ValueId | NodeId, (ValueId | NodeId)[]>();
  const indeg = new Map<ValueId | NodeId, number>();
  for (const value of graph.values) {
    succ.set(value, []);
    indeg.set(value, 0);
  }
  for (const node of graph.nodes) {
    succ.set(node.id, []);
    indeg.set(node.id, 0);
  }
  for (const node of graph.nodes) {
    for (const out of node.outputs) {
      // def edge: node -> output value
      (succ.get(node.id) as (ValueId | NodeId)[]).push(out);
      indeg.set(out, (indeg.get(out) as number) + 1);
    }
    for (const input of node.inputs) {
      // use edge: input value -> node
      (succ.get(input) as (ValueId | NodeId)[]).push(node.id);
      indeg.set(node.id, (indeg.get(node.id) as number) + 1);
    }
  }

  // Kahn: repeatedly emit zero-in-degree vertices.
  const queue: (ValueId | NodeId)[] = [];
  for (const [vertex, degree] of indeg) {
    if (degree === 0) queue.push(vertex);
  }
  const ranking = new Map<ValueId | NodeId, number>();
  let rank = 0;
  while (queue.length > 0) {
    // Shift preserves a stable, deterministic order given deterministic ids.
    const vertex = queue.shift() as ValueId | NodeId;
    ranking.set(vertex, rank++);
    for (const next of succ.get(vertex) as (ValueId | NodeId)[]) {
      const d = (indeg.get(next) as number) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (ranking.size === indeg.size) {
    return { ok: true, ranking };
  }

  // A cycle remains among the un-ranked vertices; extract one witness.
  const cycle = extractCycle(succ, ranking);
  return { ok: false, cycle };
}

/**
 * Extract one cycle from the sub-graph of vertices that never reached rank 0
 * (i.e. those not present in `ranked`). Follows successors staying inside the
 * un-ranked set until a vertex repeats.
 */
function extractCycle(
  succ: Map<ValueId | NodeId, (ValueId | NodeId)[]>,
  ranked: Map<ValueId | NodeId, number>,
): readonly (ValueId | NodeId)[] {
  const inCycleSet = (x: ValueId | NodeId): boolean => !ranked.has(x);
  let start: ValueId | NodeId | undefined;
  for (const vertex of succ.keys()) {
    if (inCycleSet(vertex)) {
      start = vertex;
      break;
    }
  }
  // start is defined: ranking.size < indeg.size guarantees an un-ranked vertex.
  const path: (ValueId | NodeId)[] = [];
  const seen = new Map<ValueId | NodeId, number>();
  let cursor = start as ValueId | NodeId;
  while (!seen.has(cursor)) {
    seen.set(cursor, path.length);
    path.push(cursor);
    // A vertex in the residual set always has an un-ranked successor (else Kahn
    // would have drained it), so `find` returns a defined vertex.
    cursor = (succ.get(cursor) as (ValueId | NodeId)[]).find(inCycleSet) as ValueId | NodeId;
  }
  return [...path.slice(seen.get(cursor) as number), cursor];
}
