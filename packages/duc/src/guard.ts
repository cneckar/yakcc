// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-GUARD-LABELS-001 (wi-guard A2, GH #1255)
// Guard labels on influence paths (GFP §4, adapted). A `sel` gate encodes control as
// data: `sel(cond, then, else)`. A flow that enters through a branch input happens only
// under the condition, so that branch edge carries `cond` as its guard. A flow through
// the condition input itself is an implicit flow and is unguarded. This module answers
// per observation: is there an unguarded path from the source (a flow that needs no
// branch), and which guard predicates lie on the guarded paths. It annotates. It never
// prunes, so the path-insensitive over-approximation is preserved (DEC-DUC-SCOPE-001),
// and reachability agrees exactly with mayInfluence.
//
// The guard set is a union over paths: it reports every predicate some path depends
// on, not the conjunction of each path. That is the answer a reviewer needs ("this
// flow happens only under these conditions"). It is computed by a monotone fixpoint,
// so it is linear-time in practice and does not enumerate paths.

import type { DucGraph, DucNode, ValueId } from "./types.js";

/** How a source reaches an observation, once guards are taken into account. */
export interface GuardedFlow {
  /** True iff some path from the source reaches the observation with no branch edge. */
  readonly unguarded: boolean;
  /** Predicates (condition values of `sel` gates) that lie on some guarded path. */
  readonly guards: readonly ValueId[];
}

interface State {
  reached: boolean;
  unguarded: boolean;
  guards: Set<ValueId>;
}

/**
 * Guarded flows from `source` to every value it reaches (the source itself included,
 * unguarded). A node for which `blocked` returns true is a barrier: its outputs are not
 * reached through it. Barriers are how declared sanitizers cut a flow, so they are
 * never inferred. Reachability without barriers is exactly `mayInfluence`.
 */
export function guardedFlows(
  graph: DucGraph,
  source: ValueId,
  blocked: (node: DucNode) => boolean = () => false,
): ReadonlyMap<ValueId, GuardedFlow> {
  const state = new Map<ValueId, State>();
  const get = (v: ValueId): State => {
    let s = state.get(v);
    if (s === undefined) {
      s = { reached: false, unguarded: false, guards: new Set() };
      state.set(v, s);
    }
    return s;
  };
  get(source).reached = true;
  get(source).unguarded = true;

  // Each opaque node is all-to-all: every output depends on every input. A branch
  // input of a `sel` is guarded by the condition, which is input 0.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (blocked(node)) continue;
      const isSel = node.kind === "sel";
      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i] as ValueId;
        const from = state.get(input);
        if (from === undefined || !from.reached) continue;
        const guardedEdge = isSel && i > 0;
        const guard = guardedEdge ? (node.inputs[0] as ValueId) : undefined;
        for (const out of node.outputs) {
          const to = get(out);
          if (!to.reached) {
            to.reached = true;
            changed = true;
          }
          // An unguarded path reaches `out` through this edge only if the edge is
          // unguarded and the input itself is reached without a branch.
          if (from.unguarded && !guardedEdge && !to.unguarded) {
            to.unguarded = true;
            changed = true;
          }
          for (const g of from.guards) {
            if (!to.guards.has(g)) {
              to.guards.add(g);
              changed = true;
            }
          }
          if (guard !== undefined && !to.guards.has(guard)) {
            to.guards.add(guard);
            changed = true;
          }
        }
      }
    }
  }

  const result = new Map<ValueId, GuardedFlow>();
  for (const [value, s] of state) {
    if (!s.reached) continue;
    result.set(value, { unguarded: s.unguarded, guards: [...s.guards] });
  }
  return result;
}

/**
 * For every observation reachable from `source`, its guarded flow. Observations not
 * reachable from `source` are absent from the map. Reachability is exactly
 * `mayInfluence(graph, source, obs)`.
 */
export function guardedInfluence(
  graph: DucGraph,
  source: ValueId,
): ReadonlyMap<ValueId, GuardedFlow> {
  const flows = guardedFlows(graph, source);
  const result = new Map<ValueId, GuardedFlow>();
  for (const obs of graph.obs) {
    const flow = flows.get(obs);
    if (flow === undefined || obs === source) continue;
    result.set(obs, flow);
  }
  return result;
}

/**
 * Control dependence (#1269, DEC-DUC-CONTROL-DEPENDENCE-001): a node inside a branch runs only when
 * the branch's condition holds, so it depends on whatever reaches that condition, even when none of
 * its own inputs does (`if (secret) sink("x")`). For every node under a branch whose condition
 * `source` reaches, the conditions on its way down, outermost first. Like the guard labels, this
 * annotates: it adds no edge to may-influence and removes none.
 */
export function controlInfluence(
  graph: DucGraph,
  source: ValueId,
  blocked: (node: DucNode) => boolean = () => false,
): ReadonlyMap<string, readonly ValueId[]> {
  const flows = guardedFlows(graph, source, blocked);
  const condOf = new Map((graph.branches ?? []).map((b) => [b.id, b.cond] as const));
  const result = new Map<string, ValueId[]>();
  for (const node of graph.nodes) {
    if (node.region === undefined) continue;
    const conds: ValueId[] = [];
    for (const segment of node.region.split("/")) {
      const cond = condOf.get(segment.replace(/\.[^.]*$/, ""));
      if (cond !== undefined && flows.has(cond)) conds.push(cond);
    }
    if (conds.length > 0) result.set(node.id, conds);
  }
  return result;
}
