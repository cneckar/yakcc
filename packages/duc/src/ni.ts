// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-NI-REACHABILITY-001 (graph non-interference)
// Graph non-interference is decided as reachability over may-influence (DUC Thm
// 5.2): the labeling satisfies graph-NI iff no high-labelled source may-influence
// any low observation. This is an *iff* over the graph and all interpretations of
// its opaque nodes, not a one-way sufficient criterion — materially stronger than
// a type system or PDG condition that only *implies* NI relative to a fixed
// semantics. Implicit flows are covered for free because a branch condition flows
// into its `sel` gate as ordinary data (control-as-data; the lifter's Norm 2). A
// failed check hands back the term-model witness, localizing the leak (e.g. the
// secret occurring in the condition position of a `sel`).
//
// Decidable in linear time: one backward reachability from the low observations.

import { type BaseSet, nondeterministicObservations } from "./base-set.js";
import { influenceCone, influenceIndex, witness } from "./influence.js";
import type { WitnessTerm } from "./influence.js";
import type { DucGraph, NodeId, ValueId } from "./types.js";
import { defMap, nodeIndex } from "./types.js";

/** A security label on a source. */
export type Label = "high" | "low";

/**
 * A labeling of the graph's sources plus the set of low observations. Sources are
 * labelled by node id (only source nodes — 0-ary — may be labelled). Observations
 * not listed in `lowObs` are treated as not-low (out of the NI question).
 */
export interface Labeling {
  readonly sources: ReadonlyMap<NodeId, Label>;
  readonly lowObs: readonly ValueId[];
}

/** A witnessed leak: a high source whose output reaches a low observation. */
export interface NILeak {
  readonly source: NodeId;
  readonly sourceValue: ValueId;
  readonly obs: ValueId;
  /** The provenance term at the leaking observation; the source occurs within it. */
  readonly witness: WitnessTerm;
}

/** A low observation a nondeterministic primitive may reach (#1270). */
export interface NondeterministicRead {
  readonly obs: ValueId;
  /** The primitive, as `Date` or `Math.random`. */
  readonly source: string;
}

/**
 * The verdict of a graph-NI check. With a base set, `nondeterministic` lists the low observations a
 * nondeterministic primitive may reach: graph-NI treats every ambient read as one fixed unknown
 * value, so for those observations the verdict holds only under that assumption (#1270).
 */
export type NIResult =
  | { readonly holds: true; readonly nondeterministic?: readonly NondeterministicRead[] }
  | {
      readonly holds: false;
      readonly leaks: readonly NILeak[];
      readonly nondeterministic?: readonly NondeterministicRead[];
    };

/**
 * Decide graph non-interference. Returns `{ holds: true }` when no high source
 * may-influence any low observation under *any* interpretation, else every
 * witnessed leak. Given the target's base set, the verdict also names the low
 * observations a nondeterministic primitive reaches (#1270, DEC-DUC-NI-DETERMINISM-001).
 */
export function graphNI(graph: DucGraph, labeling: Labeling, base?: BaseSet): NIResult {
  const nodes = nodeIndex(graph);
  const def = defMap(graph);
  const index = influenceIndex(graph);

  // Outputs of high-labelled sources, mapped back to their source node.
  const highOutputs = new Map<ValueId, NodeId>();
  for (const [id, label] of labeling.sources) {
    if (label !== "high") continue;
    const node = nodes.get(id);
    if (node === undefined) continue;
    for (const out of node.outputs) highOutputs.set(out, id);
  }

  const leaks: NILeak[] = [];
  for (const observed of labeling.lowObs) {
    const cone = influenceCone(graph, observed, index);
    const reaching = new Set<ValueId>([observed, ...cone]);
    for (const [highValue, sourceNode] of highOutputs) {
      if (reaching.has(highValue)) {
        leaks.push({
          source: sourceNode,
          sourceValue: highValue,
          obs: observed,
          witness: witness(graph, observed),
        });
      }
    }
  }

  // Defensive: a low observation with no def is a conservation violation the
  // caller should have caught with isWellFormed; treat it as no leak here.
  void def;

  // @decision DEC-DUC-NI-DETERMINISM-001 (#1270): an ambient read is one unknown value per run in
  // graph-NI, but `Date.now()` or `Math.random()` can differ between two reads in one run. The verdict
  // is not weakened (the reachability answer is still exact over the graph); it is qualified: the low
  // observations such a read reaches are named, so a consumer can tell a verdict that rests on the
  // assumption from one that does not.
  const nondeterministic =
    base === undefined
      ? undefined
      : nondeterministicObservations(graph, base)
          .map((r) => ({ obs: graph.obs[r.obs] as ValueId, source: r.source }))
          .filter((r) => labeling.lowObs.includes(r.obs));
  const qualified = nondeterministic !== undefined ? { nondeterministic } : {};
  return leaks.length === 0 ? { holds: true, ...qualified } : { holds: false, leaks, ...qualified };
}

/**
 * Convenience builder: label a set of diamond-source symbols `high` (e.g. a
 * "secret" foreign input) and the rest of the sources `low`. Sources whose
 * diamond symbol is in `highSymbols` become high; all other sources become low.
 */
export function labelBySymbol(
  graph: DucGraph,
  highSymbols: ReadonlySet<string>,
  lowObs: readonly ValueId[],
): Labeling {
  const sources = new Map<NodeId, Label>();
  for (const node of graph.nodes) {
    if (node.inputs.length !== 0) continue; // only sources are labelled
    const symbol = node.diamond?.symbol;
    const label: Label = symbol !== undefined && highSymbols.has(symbol) ? "high" : "low";
    sources.set(node.id, label);
  }
  return { sources, lowObs };
}
