// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical forms for DUC graphs (P1, #1275).
 *
 * A graph's identity must not depend on the order the lifter happened to visit the
 * source. The lifter numbers nodes, values, branches and loops with counters, so the raw numbering
 * reflects traversal order. `canonicalizeGraph` renumbers a graph by structure: each node gets a
 * signature from its kind, label, diamond label, the signatures of its inputs and the signatures of
 * the regions it lies in. Nodes are then numbered in signature order. Branches are numbered by the
 * signature of their condition and location. A loop is numbered by the position of its node. Origin
 * text is an annotation, not structure (D6), so it does not enter a signature. It is carried along,
 * and it breaks ties so the annotated output is deterministic.
 *
 * `graphIdentity` hashes the structure alone. Renaming a local or changing a comment changes
 * annotations only, so the identity does not change.
 */
import { createHash } from "node:crypto";
import type { DiamondLabel, DucBranch, DucGraph, DucLoop, DucNode, ValueId } from "./types.js";

/**
 * Operations whose two operands can be swapped for every type of operand (#1275, decision 4A). Not
 * `+` (string concatenation does not commute), nor `&&` / `||` (their value is an operand).
 */
const COMMUTATIVE = new Set(["===", "!=="]);

/** Where a loop's invariants start among its inputs: after the carries' initial values and the iterable. */
function invariantOffset(node: DucNode): number {
  const loop = node.loop as DucLoop;
  return loop.carry.length + (loop.iterate !== undefined ? 1 : 0);
}

/**
 * The structural part of a reference label. A link (`spec`) is not structure (#1275, 2B): the same
 * logic is the same atom whatever its dependencies are linked to. Links travel with the graph.
 */
function structuralDiamond(d: DiamondLabel | undefined): Omit<DiamondLabel, "spec"> | undefined {
  if (d === undefined) return undefined;
  const { spec: _link, ...structure } = d;
  return structure;
}

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
 * value ids become `v0, v1, ...` in the same order, branch ids become `b0, b1, ...` in the
 * order of their condition signatures, and loop ids become `L<i>`, where `i` is the loop node's
 * canonical index. Parameters keep their original order, and observations keep their order.
 * A cyclic graph has no canonical numbering; the lifter never produces one, and for such a graph
 * this returns the input numbering unchanged.
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

  // A loop is identified by its node. That node depends on what the loop reads from outside, never
  // on its body, which depends on the loop; the body is summarized by the kinds and labels inside.
  const loopNodeOf = new Map<string, DucNode>();
  for (const node of nodes) if (node.loop !== undefined) loopNodeOf.set(node.loop.id, node);
  // An invariant source stands for an outer value. Its identity is that value's, not its position
  // among the loop's invariants, so the order the body happened to read them in does not matter.
  const invariantOuterOf = new Map<DucNode, ValueId>();
  for (const node of nodes) {
    if (node.loop === undefined) continue;
    const offset = invariantOffset(node);
    node.loop.invariant.forEach((v, j) => {
      const p = producer.get(v);
      const outer = node.inputs[offset + j];
      if (p !== undefined && outer !== undefined) invariantOuterOf.set(p.node, outer);
    });
  }
  const bodySummaries = new Map<string, string>();
  const bodySummaryOf = (id: string): string => {
    const cached = bodySummaries.get(id);
    if (cached !== undefined) return cached;
    const body = nodes
      .filter((n) => n.region !== undefined && n.region.split("/").includes(`${id}.b`))
      .map((n) => `${n.kind}:${invariantOuterOf.has(n) ? "invariant" : (n.label ?? "")}:${n.diamond?.symbol ?? ""}`)
      .sort();
    const summary = canonicalJson(body);
    bodySummaries.set(id, summary);
    return summary;
  };
  const segmentSig = (id: string, side: string): string => {
    if (id.startsWith("L")) {
      const loopNode = loopNodeOf.get(id);
      return `${loopNode === undefined ? "missing-loop" : sigOfNode(loopNode)}.${side}`;
    }
    return `${branchSigOf(id) ?? id}.${side}`;
  };
  const regionSig = (region: string | undefined): string | null => {
    if (region === undefined) return null;
    return region
      .split("/")
      .map((seg) => {
        const [id = "", side = ""] = seg.split(".");
        return segmentSig(id, side);
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
    let inputSigs = node.inputs.map(sigOfValue);
    if (node.kind === "op" && COMMUTATIVE.has(node.label ?? "") && inputSigs.length === 2) {
      inputSigs = [...inputSigs].sort();
    }
    if (node.loop !== undefined) {
      const offset = invariantOffset(node);
      inputSigs = [...inputSigs.slice(0, offset), ...inputSigs.slice(offset).sort()];
    }
    const outer = invariantOuterOf.get(node);
    const label = outer !== undefined ? `invariant@${sigOfValue(outer)}` : (node.label ?? null);
    onPath.delete(node);
    const fields: unknown[] = [
      node.kind,
      label,
      structuralDiamond(node.diamond) ?? null,
      node.outputs.length,
      inputSigs,
      regionSig(node.region),
    ];
    if (node.loop !== undefined) fields.push(bodySummaryOf(node.loop.id));
    const sig = createHash("sha256").update(canonicalJson(fields)).digest("hex");
    memo.set(node, sig);
    return sig;
  };

  // A signature looks behind a node, at its inputs. Two nodes with the same structure behind them
  // can still be used differently (two reads of `Buffer.from`, each called on different arrays), and
  // then numbering them by lifting order would wire their users differently for the same program.
  // So the key also looks ahead, at how a node is used, and is refined until it stops splitting.
  const uses = new Map<DucNode, { by: DucNode | string; tag: string }[]>();
  const addUse = (v: ValueId, by: DucNode | string, tag: string): void => {
    const p = producer.get(v);
    if (p === undefined) return;
    const list = uses.get(p.node) ?? [];
    list.push({ by, tag: `${tag}#${p.index}` });
    uses.set(p.node, list);
  };
  for (const node of nodes) {
    // A position that canonical form reorders (commutative operands, invariants) is one position.
    const commutative = node.kind === "op" && COMMUTATIVE.has(node.label ?? "") && node.inputs.length === 2;
    const invariantsFrom = node.loop !== undefined ? invariantOffset(node) : Number.POSITIVE_INFINITY;
    node.inputs.forEach((v, i) => addUse(v, node, commutative ? "in*" : i >= invariantsFrom ? "inv" : `in${i}`));
    const loop = node.loop;
    if (loop !== undefined) {
      loop.next.forEach((v, i) => addUse(v, node, `next${i}`));
      if (loop.cond !== undefined) addUse(loop.cond, node, "cond");
    }
  }
  obs.forEach((v, k) => addUse(v, "obs", `obs${k}`));
  for (const b of branches) addUse(b.cond, "branch", `cond:${branchSigOf(b.id) ?? ""}|${regionSig(b.within) ?? ""}`);
  let key = new Map(nodes.map((node) => [node, sigOfNode(node)] as const));
  let classes = new Set(key.values()).size;
  for (let round = 0; round < nodes.length; round++) {
    const refined = new Map<DucNode, string>();
    for (const node of nodes) {
      const used = (uses.get(node) ?? [])
        .map(({ by, tag }) => `${typeof by === "string" ? by : key.get(by)}:${tag}`)
        .sort();
      refined.set(node, createHash("sha256").update(canonicalJson([key.get(node), used])).digest("hex"));
    }
    const count = new Set(refined.values()).size;
    key = refined;
    if (count === classes) break;
    classes = count;
  }

  // Parameters keep their original order: parameter index is part of the interface.
  // Every other node is numbered by its key.
  const originalIndex = new Map(nodes.map((node, i) => [node, i] as const));
  const ordered = nodes
    .map((node) => ({ node, sig: key.get(node) as string }))
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

  // Branches: numbered by condition signature and location, ties broken by lifting id (equal
  // conditions in the same place are the same structure, so the tie does not affect identity).
  const branchKey = (b: DucBranch): string => `${branchSigOf(b.id) ?? ""}|${regionSig(b.within) ?? ""}`;
  const branchRank = new Map<string, string>();
  [...branches]
    .sort((a, b) => {
      const ka = branchKey(a);
      const kb = branchKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .forEach((b, i) => branchRank.set(b.id, `b${i}`));

  // Loops: numbered by the position of their node.
  const loopRank = new Map<string, string>();
  ordered.forEach(({ node }, i) => {
    if (node.loop !== undefined) loopRank.set(node.loop.id, `L${i}`);
  });

  const canonicalRegion = (region: string | undefined): string | undefined =>
    region === undefined
      ? undefined
      : region
          .split("/")
          .map((seg) => {
            const [id = "", side = ""] = seg.split(".");
            const rank = id.startsWith("L") ? loopRank.get(id) : branchRank.get(id);
            return `${rank ?? id}.${side}`;
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
  const renameValue = (v: ValueId): ValueId => renamed.get(v) ?? v;

  // Invariants in canonical order, by the signature of the outer value each stands for; the
  // sources are renumbered to match.
  const invariantOrder = new Map<DucNode, number[]>();
  const relabel = new Map<DucNode, string>();
  for (const node of nodes) {
    if (node.loop === undefined) continue;
    const offset = invariantOffset(node);
    const order = node.loop.invariant
      .map((_, j) => j)
      .sort((a, b) => {
        const sa = sigOfValue(node.inputs[offset + a] as ValueId);
        const sb = sigOfValue(node.inputs[offset + b] as ValueId);
        return sa < sb ? -1 : sa > sb ? 1 : a - b;
      });
    invariantOrder.set(node, order);
    order.forEach((j, k) => {
      const p = producer.get(node.loop?.invariant[j] as ValueId);
      if (p !== undefined) relabel.set(p.node, `invariant:${k}`);
    });
  }

  const canonicalNodes: DucNode[] = ordered.map(({ node }, i) => {
    const region = canonicalRegion(node.region);
    let inputs = node.inputs;
    if (node.kind === "op" && COMMUTATIVE.has(node.label ?? "") && inputs.length === 2) {
      const [a, b] = inputs as [ValueId, ValueId];
      if (sigOfValue(b) < sigOfValue(a)) inputs = [b, a];
    }
    const order = invariantOrder.get(node);
    if (order !== undefined) {
      const offset = invariantOffset(node);
      inputs = [...inputs.slice(0, offset), ...order.map((j) => inputs[offset + j] as ValueId)];
    }
    const loop: DucLoop | undefined =
      node.loop === undefined
        ? undefined
        : {
            id: loopRank.get(node.loop.id) ?? node.loop.id,
            carry: node.loop.carry.map(renameValue),
            invariant: (order ?? node.loop.invariant.map((_, j) => j)).map((j) =>
              renameValue(node.loop?.invariant[j] as ValueId),
            ),
            next: node.loop.next.map(renameValue),
            ...(node.loop.cond !== undefined ? { cond: renameValue(node.loop.cond) } : {}),
            ...(node.loop.iterate !== undefined
              ? { iterate: { element: renameValue(node.loop.iterate.element), of: node.loop.iterate.of } }
              : {}),
          };
    const label = relabel.get(node) ?? node.label;
    return {
      id: `n${i}` as DucNode["id"],
      inputs: inputs.map(renameValue),
      outputs: outputsOf[i] ?? [],
      kind: node.kind,
      ...(label !== undefined ? { label } : {}),
      ...(node.diamond !== undefined ? { diamond: node.diamond } : {}),
      ...(node.origin !== undefined ? { origin: node.origin } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(loop !== undefined ? { loop } : {}),
    };
  });

  // Observations keep their order: it follows the return statements, which is semantic.
  const canonicalObs = [...new Set(obs)].map(renameValue);
  const canonicalBranches: DucBranch[] = [...branches]
    .map((b) => {
      const within = canonicalRegion(b.within);
      return {
        id: branchRank.get(b.id) ?? b.id,
        cond: renameValue(b.cond),
        ...(within !== undefined ? { within } : {}),
      };
    })
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
 * canonicalized, then node kinds, labels, inputs, outputs, diamond labels, regions, loop bodies,
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
      ...(n.diamond !== undefined ? { diamond: structuralDiamond(n.diamond) } : {}),
      ...(n.region !== undefined ? { region: n.region } : {}),
      ...(n.loop !== undefined ? { loop: n.loop } : {}),
    })),
    obs: canon.obs,
    ...(canon.branches !== undefined ? { branches: canon.branches } : {}),
  };
  return createHash("sha256").update(canonicalJson(structure)).digest("hex");
}
