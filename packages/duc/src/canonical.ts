// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical forms for DUC graphs (P1, #1275).
 *
 * A graph's identity must not depend on the order the lifter happened to visit the
 * source. The lifter numbers nodes, values and branches with counters, so the raw numbering
 * reflects traversal order. `canonicalizeGraph` renumbers a graph by structure: each node gets a
 * signature from its kind, label, diamond label, the signatures of its inputs and the signatures of
 * the branches it lies in. Nodes are then numbered in signature order. Branches are numbered by the
 * signature of their condition. Origin text is an annotation, not structure (D6), so it does not
 * enter a signature. It is carried along, and it breaks ties so the annotated output is deterministic.
 *
 * `graphIdentity` hashes the structure alone. Renaming a local or changing a comment changes
 * annotations only, so the identity does not change.
 */
import { createHash } from "node:crypto";
import type { DucBranch, DucGraph, DucNode, ValueId } from "./types.js";

/** Stable JSON: object keys sorted, and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Renumber a graph into canonical form. Node ids become `n0, n1, ...` in signature order,
 * value ids become `v0, v1, ...` in the same order, and branch ids become `b0, b1, ...` in the
 * order of their condition signatures. Parameters keep their original order, and observations
 * keep their order. A cyclic graph has no canonical numbering; the lifter never produces one, and
 * for such a graph this returns the input numbering unchanged.
 */
export function canonicalizeGraph(
  nodes: readonly DucNode[],
  obs: readonly ValueId[],
  branches: readonly DucBranch[] = [],
): DucGraph {
  const producer = new Map<ValueId, { node: DucNode; index: number }>();
  for (const node of nodes) node.outputs.forEach((v, index) => producer.set(v, { node, index }));

  const memo = new Map<DucNode, string>();
  const onPath = new Set<DucNode>();
  let cyclic = false;
  const sigOfValue = (v: ValueId): string => {
    const p = producer.get(v);
    if (p === undefined) return "undefined-value";
    return `${sigOfNode(p.node)}#${p.index}`;
  };

  // A branch is identified by the structure of its condition, not by its lifting id.
  const condOf = new Map<string, ValueId>(branches.map((b) => [b.id, b.cond] as const));
  const branchSigOf = (id: string): string | undefined => {
    const cond = condOf.get(id);
    return cond === undefined ? undefined : sigOfValue(cond);
  };
  const regionSig = (region: string | undefined): string | null => {
    if (region === undefined) return null;
    return region
      .split("/")
      .map((seg) => {
        const [id = "", side = ""] = seg.split(".");
        return `${branchSigOf(id) ?? id}.${side}`;
      })
      .join("/");
  };

  const sigOfNode = (node: DucNode): string => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (onPath.has(node)) {
      cyclic = true;
      return "cycle";
    }
    onPath.add(node);
    const inputSigs = node.inputs.map(sigOfValue);
    onPath.delete(node);
    const sig = createHash("sha256")
      .update(
        canonicalJson([
          node.kind,
          node.label ?? null,
          node.diamond ?? null,
          node.outputs.length,
          inputSigs,
          regionSig(node.region),
        ]),
      )
      .digest("hex");
    memo.set(node, sig);
    return sig;
  };

  // Parameters keep their original order: parameter index is part of the interface.
  // Every other node is numbered by signature.
  const originalIndex = new Map(nodes.map((node, i) => [node, i] as const));
  const ordered = nodes
    .map((node) => ({ node, sig: sigOfNode(node) }))
    .sort((a, b) => {
      const aParam = a.node.kind === "param-source";
      const bParam = b.node.kind === "param-source";
      if (aParam !== bParam) return aParam ? -1 : 1;
      if (aParam && bParam) return (originalIndex.get(a.node) ?? 0) - (originalIndex.get(b.node) ?? 0);
      if (a.sig !== b.sig) return a.sig < b.sig ? -1 : 1;
      // Structurally equal nodes are interchangeable for identity; break the tie by annotation.
      const aa = canonicalJson(a.node.origin ?? null);
      const bb = canonicalJson(b.node.origin ?? null);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });
  if (cyclic) {
    return { nodes: [...nodes], values: nodes.flatMap((n) => n.outputs), obs: [...obs], branches: [...branches] };
  }

  // Branches: numbered by condition signature, ties broken by lifting id (equal conditions are
  // the same structure, so the tie does not affect identity).
  const branchRank = new Map<string, string>();
  [...branches]
    .sort((a, b) => {
      const sa = branchSigOf(a.id) ?? "";
      const sb = branchSigOf(b.id) ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .forEach((b, i) => branchRank.set(b.id, `b${i}`));
  const canonicalRegion = (region: string | undefined): string | undefined =>
    region === undefined
      ? undefined
      : region
          .split("/")
          .map((seg) => {
            const [id = "", side = ""] = seg.split(".");
            return `${branchRank.get(id) ?? id}.${side}`;
          })
          .join("/");

  // Two passes: assign every output a canonical id first, since an input may be produced
  // by a node that sorts later.
  const renamed = new Map<ValueId, ValueId>();
  let valueCount = 0;
  const outputsOf = ordered.map(({ node }) =>
    node.outputs.map((v) => {
      const nv = `v${valueCount++}` as ValueId;
      renamed.set(v, nv);
      return nv;
    }),
  );
  const canonicalNodes: DucNode[] = ordered.map(({ node }, i) => {
    const region = canonicalRegion(node.region);
    return {
      id: `n${i}` as DucNode["id"],
      inputs: node.inputs.map((v) => renamed.get(v) ?? v),
      outputs: outputsOf[i] ?? [],
      kind: node.kind,
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(node.diamond !== undefined ? { diamond: node.diamond } : {}),
      ...(node.origin !== undefined ? { origin: node.origin } : {}),
      ...(region !== undefined ? { region } : {}),
    };
  });

  // Observations keep their order: it follows the return statements, which is semantic.
  const canonicalObs = [...new Set(obs)].map((v) => renamed.get(v) ?? v);
  const canonicalBranches: DucBranch[] = [...branches]
    .map((b) => ({ id: branchRank.get(b.id) ?? b.id, cond: renamed.get(b.cond) ?? b.cond }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes: canonicalNodes,
    values: canonicalNodes.flatMap((n) => n.outputs),
    obs: canonicalObs,
    ...(canonicalBranches.length > 0 ? { branches: canonicalBranches } : {}),
  };
}

/**
 * The identity of a graph: a hash of its structure alone (D6, #1275). The graph is first
 * canonicalized, then node kinds, labels, inputs, outputs, diamond labels, branch membership,
 * branches and observations are hashed. Origin annotations are excluded.
 */
export function graphIdentity(g: DucGraph): string {
  const canon = canonicalizeGraph(g.nodes, g.obs, g.branches ?? []);
  const structure = {
    nodes: canon.nodes.map((n) => ({
      kind: n.kind,
      ...(n.label !== undefined ? { label: n.label } : {}),
      inputs: n.inputs,
      outputs: n.outputs,
      ...(n.diamond !== undefined ? { diamond: n.diamond } : {}),
      ...(n.region !== undefined ? { region: n.region } : {}),
    })),
    obs: canon.obs,
    ...(canon.branches !== undefined ? { branches: canon.branches } : {}),
  };
  return createHash("sha256").update(canonicalJson(structure)).digest("hex");
}
