// SPDX-License-Identifier: Apache-2.0
/**
 * A compact, lossless encoding of a canonical DUC graph (#1274 M5, #1275).
 *
 * The canonical form (`canonicalizeGraph`) numbers nodes `n0, n1, ...` and values `v0, v1, ...`,
 * so ids need not be stored: a node's id is its position, and a value's id is its index. Strings
 * (kinds, origin texts, diamond symbols) are interned into one table. `decodeGraph` reverses
 * `encodeGraph` exactly, and `encodeGraph` refuses a graph that is not in canonical numbering.
 */
import type { DiamondLabel, DucGraph, DucNode, NodeOrigin, ValueId } from "./types.js";

export interface CompactGraph {
  /** Format version. */
  readonly v: 1;
  /** String table: kinds, origin kinds and texts, diamond reasons, symbols, modules. */
  readonly s: readonly string[];
  /** Nodes in canonical order. */
  readonly n: readonly CompactNode[];
  /** Observations, as value indices. */
  readonly o: readonly number[];
  /** Branches, as `[branchNumber, conditionValueIndex]`; branch ids are canonical `b<number>`. */
  readonly b: readonly (readonly [number, number])[];
}

/**
 * `[kind, inputs, outputs, origin, diamond, label]`. `origin` is `[kindIndex, textIndex]` (textIndex
 * is -1 when absent), or null. `diamond` is `[reasonIndex, symbolIndex, moduleIndex]` (moduleIndex
 * is -1 when absent), or null. `label` is the structural label's string index, or -1 when absent.
 */
export type CompactNode = readonly [
  number,
  readonly number[],
  readonly number[],
  readonly [number, number] | null,
  readonly [number, number, number] | null,
  number,
  number,
];

const NODE_ID = /^n(\d+)$/;
const VALUE_ID = /^v(\d+)$/;

function valueIndex(v: ValueId): number {
  const m = VALUE_ID.exec(v);
  if (m === null) throw new Error(`encodeGraph: value ${v} is not in canonical numbering`);
  return Number(m[1]);
}

export function encodeGraph(g: DucGraph): CompactGraph {
  const table: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string): number => {
    const known = index.get(s);
    if (known !== undefined) return known;
    const i = table.length;
    table.push(s);
    index.set(s, i);
    return i;
  };

  const nodes: CompactNode[] = g.nodes.map((node, i) => {
    const m = NODE_ID.exec(node.id);
    if (m === null || Number(m[1]) !== i) {
      throw new Error(`encodeGraph: node ${node.id} at position ${i} is not in canonical numbering`);
    }
    const origin: [number, number] | null = node.origin
      ? [intern(node.origin.kind), node.origin.text === undefined ? -1 : intern(node.origin.text)]
      : null;
    const diamond: [number, number, number] | null = node.diamond
      ? [
          intern(node.diamond.reason),
          intern(node.diamond.symbol),
          node.diamond.module === undefined ? -1 : intern(node.diamond.module),
        ]
      : null;
    const label = node.label === undefined ? -1 : intern(node.label);
    const region = node.region === undefined ? -1 : intern(node.region);
    return [
      intern(node.kind),
      node.inputs.map(valueIndex),
      node.outputs.map(valueIndex),
      origin,
      diamond,
      label,
      region,
    ];
  });
  const branches = (g.branches ?? []).map((br): [number, number] => {
    const m = /^b(\d+)$/.exec(br.id);
    if (m === null) throw new Error(`encodeGraph: branch ${br.id} is not in canonical numbering`);
    return [Number(m[1]), valueIndex(br.cond)];
  });
  return { v: 1, s: table, n: nodes, o: g.obs.map(valueIndex), b: branches };
}

export function decodeGraph(c: CompactGraph): DucGraph {
  if (c.v !== 1) throw new Error(`decodeGraph: unknown format version ${String(c.v)}`);
  const str = (i: number): string => {
    const s = c.s[i];
    if (s === undefined) throw new Error(`decodeGraph: string index ${i} out of range`);
    return s;
  };
  const value = (k: number): ValueId => `v${k}` as ValueId;
  const nodes: DucNode[] = c.n.map(([kind, inputs, outputs, origin, diamond, label, region], i) => {
    const node: {
      id: DucNode["id"];
      inputs: ValueId[];
      outputs: ValueId[];
      kind: DucNode["kind"];
      origin?: NodeOrigin;
      diamond?: DiamondLabel;
      label?: string;
      region?: string;
    } = {
      id: `n${i}` as DucNode["id"],
      inputs: inputs.map(value),
      outputs: outputs.map(value),
      kind: str(kind) as DucNode["kind"],
    };
    if (origin !== null) {
      node.origin = {
        kind: str(origin[0]),
        ...(origin[1] !== -1 ? { text: str(origin[1]) } : {}),
      };
    }
    if (label !== -1) node.label = str(label);
    if (region !== -1) node.region = str(region);
    if (diamond !== null) {
      node.diamond = {
        reason: str(diamond[0]) as DiamondLabel["reason"],
        symbol: str(diamond[1]),
        ...(diamond[2] !== -1 ? { module: str(diamond[2]) } : {}),
      };
    }
    return node;
  });
  const values: ValueId[] = [];
  for (const node of nodes) for (const out of node.outputs) values.push(out);
  const branches = c.b.map(([n, cond]) => ({ id: `b${n}`, cond: value(cond) }));
  return { nodes, values, obs: c.o.map(value), ...(branches.length > 0 ? { branches } : {}) };
}
