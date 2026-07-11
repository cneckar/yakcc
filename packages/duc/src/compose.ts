// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-COMPOSITION-MONOTONE-001 (composition = opacity)
// An opaque node is the coarsest sound summary of any DUC graph that might
// replace it: its assumed influence is the complete input->output relation, the
// top of the summary lattice (DUC §6). Substituting a real callee (a subgraph)
// for the node can only *lower* it — refinement removes influence, never adds it
// (DUC Thm 6.2(3)). Two consequences yakcc uses:
//   (1) a program's influence graph is assembled interprocedurally from atom
//       summaries without re-traversing sub-bodies; and
//   (2) a *strictness falsifier*: a block claimed stricter than an incumbent
//       whose param->obs influence *adds* an edge is provably not a refinement
//       (DEC-DUC-COMPOSITION-MONOTONE-001), catching a class of bogus strictness
//       claims that today are only contributor-declared.
//
// This module is path-insensitive and treats the boundary as (parameters, ♦
// internal-unknowns, observations). Refinement identifies a replacement graph's
// parameter-sources with the host node's inputs and its observations with the
// host node's outputs; the replacement's own ♦-sources are revealed as new
// sources of the host graph.

import { influenceCone, influenceIndex } from "./influence.js";
import type { DucGraph, DucNode, NodeId, ValueId } from "./types.js";
import { defMap } from "./types.js";

/** Thrown when a refinement is structurally impossible (arity or pass-through). */
export class RefineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineError";
  }
}

/** The boundary shape of a graph: parameter sources, ♦ sources, observations. */
export interface BoundaryType {
  readonly params: number;
  readonly diamonds: number;
  readonly obs: number;
}

/** Parameter-source nodes in emission order (the graph's declared inputs). */
export function paramSources(graph: DucGraph): readonly DucNode[] {
  return graph.nodes.filter((n) => n.kind === "param-source");
}

/** The boundary type of a graph (DUC Def 6.1, extended with a ♦ count). */
export function boundaryType(graph: DucGraph): BoundaryType {
  let params = 0;
  let diamonds = 0;
  for (const node of graph.nodes) {
    if (node.kind === "param-source") params++;
    else if (node.kind === "diamond-source") diamonds++;
  }
  return { params, diamonds, obs: graph.obs.length };
}

/**
 * The parameter influence summary: a `params × obs` boolean matrix where
 * `[i][j]` is true iff parameter-source i's output may-influence observation j
 * (or equals it). This is the block's externally-visible influence contract.
 */
export function paramSummaryMatrix(graph: DucGraph): readonly (readonly boolean[])[] {
  const params = paramSources(graph);
  const index = influenceIndex(graph);
  return params.map((param) => {
    // A parameter-source has exactly one output port by construction.
    const source = param.outputs[0] as ValueId;
    return graph.obs.map((observed) => {
      if (source === observed) return true;
      return influenceCone(graph, observed, index).has(source);
    });
  });
}

/** A single param->obs influence edge by index, used to report additions. */
export interface InfluenceEdge {
  readonly paramIndex: number;
  readonly obsIndex: number;
}

/** The result of comparing two blocks' influence for a strictness claim. */
export type RefinesInfluenceResult =
  | { readonly refines: true }
  | {
      readonly refines: false;
      readonly reason: "boundary-mismatch" | "added-influence";
      readonly added: readonly InfluenceEdge[];
    };

/**
 * Whether `stricter` refines `looser` in influence: same boundary arity, and
 * every param->obs influence edge of `stricter` is also present in `looser`
 * (refinement only removes influence). A stricter claim that *adds* an edge is
 * rejected with the offending edges — the strictness falsifier of W5.
 */
export function refinesInfluence(stricter: DucGraph, looser: DucGraph): RefinesInfluenceResult {
  const a = boundaryType(stricter);
  const b = boundaryType(looser);
  if (a.params !== b.params || a.obs !== b.obs) {
    return { refines: false, reason: "boundary-mismatch", added: [] };
  }
  const sMatrix = paramSummaryMatrix(stricter);
  const lMatrix = paramSummaryMatrix(looser);
  const added: InfluenceEdge[] = [];
  for (let i = 0; i < a.params; i++) {
    for (let j = 0; j < a.obs; j++) {
      if (sMatrix[i]?.[j] === true && lMatrix[i]?.[j] !== true) {
        added.push({ paramIndex: i, obsIndex: j });
      }
    }
  }
  return added.length === 0
    ? { refines: true }
    : { refines: false, reason: "added-influence", added };
}

// ---------------------------------------------------------------------------
// Refinement (substitution of an opaque node by a subgraph)
// ---------------------------------------------------------------------------

/**
 * Refine `host` by replacing opaque node `nodeId` with the subgraph `sub`
 * (`host[nodeId ↦ sub]`). `sub`'s parameter-sources are identified positionally
 * with the node's inputs and `sub`'s observations with the node's outputs; `sub`'s
 * own ♦-sources are kept as new sources of the result. The result is well-formed
 * when both inputs are (WF is preserved by interface matching, DUC Thm 6.2(1)).
 *
 * @throws {RefineError} if the node is not present, arities mismatch, or `sub`
 *   passes a parameter straight through to an observation (unsupported in v1).
 */
export function refine(host: DucGraph, nodeId: NodeId, sub: DucGraph): DucGraph {
  const target = host.nodes.find((n) => n.id === nodeId);
  if (target === undefined) throw new RefineError(`node ${nodeId} not in host graph`);

  const subParams = paramSources(sub);
  if (subParams.length !== target.inputs.length) {
    throw new RefineError(
      `arity mismatch: node has ${target.inputs.length} inputs, sub has ${subParams.length} parameter-sources`,
    );
  }
  if (sub.obs.length !== target.outputs.length) {
    throw new RefineError(
      `arity mismatch: node has ${target.outputs.length} outputs, sub has ${sub.obs.length} observations`,
    );
  }

  // Build the value-rename map for sub values.
  // Arities were checked above, so every positional lookup below is total.
  const paramOutputToInput = new Map<ValueId, ValueId>();
  subParams.forEach((param, i) => {
    paramOutputToInput.set(param.outputs[0] as ValueId, target.inputs[i] as ValueId);
  });
  const obsToOutput = new Map<ValueId, ValueId>();
  sub.obs.forEach((observed, j) => {
    obsToOutput.set(observed, target.outputs[j] as ValueId);
  });

  const prefix = `${nodeId}::`;
  const renameValue = (v: ValueId): ValueId => {
    const asObs = obsToOutput.get(v);
    if (asObs !== undefined) {
      if (paramOutputToInput.has(v)) {
        throw new RefineError("pass-through parameter->observation is unsupported in v1");
      }
      return asObs;
    }
    const asParam = paramOutputToInput.get(v);
    if (asParam !== undefined) return asParam;
    return `${prefix}${v}` as ValueId;
  };

  const droppedNodes = new Set(subParams.map((p) => p.id));
  const splicedSubNodes: DucNode[] = sub.nodes
    .filter((n) => !droppedNodes.has(n.id))
    .map((n) => ({
      id: `${prefix}${n.id}` as NodeId,
      inputs: n.inputs.map(renameValue),
      outputs: n.outputs.map(renameValue),
      kind: n.kind,
      ...(n.diamond !== undefined ? { diamond: n.diamond } : {}),
      ...(n.origin !== undefined ? { origin: n.origin } : {}),
    }));

  const nodes: DucNode[] = [...host.nodes.filter((n) => n.id !== nodeId), ...splicedSubNodes];
  const values: ValueId[] = [];
  for (const node of nodes) for (const out of node.outputs) values.push(out);

  return { nodes, values, obs: host.obs };
}

/**
 * Check that refining `host` at `nodeId` with `sub` was monotone: the host's
 * param->obs influence summary after refinement is contained in the summary
 * before (refinement only removes influence). Returns the added edges if not
 * (which, for a sound lift and a real subgraph, should always be empty).
 */
export function refinementIsMonotone(
  host: DucGraph,
  nodeId: NodeId,
  sub: DucGraph,
): RefinesInfluenceResult {
  const refined = refine(host, nodeId, sub);
  // `refined` refines `host`: its influence must be contained in host's.
  void defMap; // (referenced for readers; refinement preserves single-assignment)
  return refinesInfluence(refined, host);
}
