// SPDX-License-Identifier: Apache-2.0
// Test-only graph builders. Excluded from coverage (see vitest.config.ts) — this
// file is imported by *.test.ts and is not part of the shipped surface.
import type { DiamondLabel, DucGraph, DucNode, NodeId, ValueId } from "./types.js";

/** A terse spec for one node in a hand-built graph. */
export interface NodeSpec {
  readonly id: string;
  readonly in?: readonly string[];
  readonly out: readonly string[];
  readonly kind?: DucNode["kind"];
  readonly diamond?: DiamondLabel;
  readonly origin?: DucNode["origin"];
}

/** Build a DUC graph from terse node specs; `values` is derived from outputs. */
export function mkGraph(specs: readonly NodeSpec[], obs: readonly string[]): DucGraph {
  const nodes: DucNode[] = specs.map((s) => ({
    id: s.id as NodeId,
    inputs: (s.in ?? []).map((v) => v as ValueId),
    outputs: s.out.map((v) => v as ValueId),
    kind: s.kind ?? (s.in === undefined || s.in.length === 0 ? "param-source" : "op"),
    ...(s.diamond !== undefined ? { diamond: s.diamond } : {}),
    ...(s.origin !== undefined ? { origin: s.origin } : {}),
  }));
  const values: ValueId[] = [];
  for (const n of nodes) for (const o of n.outputs) values.push(o);
  return { nodes, values, obs: obs.map((v) => v as ValueId) };
}

export const V = (raw: string): ValueId => raw as ValueId;
export const N = (raw: string): NodeId => raw as NodeId;
