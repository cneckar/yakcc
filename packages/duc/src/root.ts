// SPDX-License-Identifier: Apache-2.0
/**
 * A graph's root (#1306), and the links it commits to: what `packGraph` computes, without what the
 * store does besides (compressing the structure and annotations with `node:zlib`). A native build
 * computes roots from this module alone (#1370): canonicalization, the links, and BLAKE3.
 *
 * An operation that is a reference links to its atom's root, which only the atom library knows: the
 * library (`operations.ts`) gives it with `setOperationRoots` when it loads. A graph with no operation
 * references needs nothing more.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalizeGraph, graphIdentity } from "./canonical.js";
import { operationReference } from "./operation-refs.js";
import type { DiamondLabel, DucGraph } from "./types.js";

/**
 * The version of the graph format (DEC-DUC-FORMAT-001). Version 2 added the ordering flag (#1285);
 * version 3 is the locked format (#1292): the BLAKE3 identity and root, literals in normal form, the
 * completion record, operations by meaning, and the semantics of #1370 (parameter defaults in
 * labels, ordered conversions, array destructuring as the iterator protocol). A change to anything
 * DEC-DUC-FORMAT-001 lists is a new version with a migration.
 */
export const GRAPH_FORMAT_VERSION = 3;

/**
 * One reference's link: the reference, by reason, symbol and module, and what it links to: a
 * contract, or, for an operation (reason `operation`, #1362), the root of the atom implementing it.
 */
export interface StoredLink {
  readonly reason: DiamondLabel["reason"] | "operation";
  readonly symbol: string;
  readonly module?: string;
  readonly spec: string;
}

/**
 * What a block's root commits to for its implementation (#1306): the graph's structure (its
 * identity), the contracts its references link to, and the format the structure is written in.
 * None of them can change without the root changing, so a graph cannot be swapped under a root.
 *
 *     links_hash = BLAKE3(canonical JSON of the sorted links)
 *     graph_root = BLAKE3("yakcc-duc-graph" ‖ u32be format_version ‖ identity ‖ links_hash)
 */
export function graphRoot(
  identity: string,
  links: readonly StoredLink[],
  formatVersion: number = GRAPH_FORMAT_VERSION,
): string {
  const sorted = [...links].sort((a, b) => (linkKey(a) < linkKey(b) ? -1 : 1));
  const canonicalLinks = sorted.map((l) => [l.reason, l.symbol, l.module ?? "", l.spec]);
  const linksHash = blake3(new TextEncoder().encode(JSON.stringify(canonicalLinks)));
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, formatVersion);
  return bytesToHex(
    blake3(
      concat([
        new TextEncoder().encode("yakcc-duc-graph"),
        version,
        hexToBytes(identity),
        linksHash,
      ]),
    ),
  );
}

/**
 * A DUC block's root (#1306): its contract, its implementation's graph root, and its proof.
 *
 *     block_root = BLAKE3(spec_hash ‖ graph_root ‖ proof_root)
 *
 * The TypeScript text is a lowering of the graph, not part of the root.
 */
/** The root of a record outside a graph (a module record), as BLAKE3 hex of its canonical text. */
export function recordRoot(canonicalText: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(canonicalText)));
}

export function ducBlockRoot(specHash: string, root: string, proofRoot: string): string {
  return bytesToHex(
    blake3(concat([hexToBytes(specHash), hexToBytes(root), hexToBytes(proofRoot)])),
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const linkKey = (d: { reason: string; symbol: string; module?: string }): string =>
  `${d.reason}\u0000${d.symbol}\u0000${d.module ?? ""}`;

let operationRootOf: ((label: string) => string) | undefined;

/** Give the roots of the atoms operation references link to (the atom library does, as it loads). */
export function setOperationRoots(rootOf: (label: string) => string): void {
  operationRootOf = rootOf;
}

/** A graph's links, each under its key, with its closures' links. */
export function linksOf(g: DucGraph, out: Map<string, StoredLink>): void {
  for (const n of g.nodes) {
    const d = n.diamond;
    if (d?.spec !== undefined)
      out.set(linkKey(d), {
        reason: d.reason,
        symbol: d.symbol,
        ...(d.module !== undefined ? { module: d.module } : {}),
        spec: d.spec,
      });
    // An operation that is an atom is linked to the atom's root (DEC-DUC-OPERATIONS-AS-ATOMS-001).
    const op = n.kind === "op" ? operationReference(n.label) : undefined;
    if (op !== undefined) {
      const link = { reason: "operation" as const, symbol: op.label };
      if (operationRootOf === undefined)
        throw new Error(
          `${op.label} links to an atom's root: load the atom library (operations.ts)`,
        );
      out.set(linkKey(link), { ...link, spec: operationRootOf(op.label) });
    }
    if (n.closure !== undefined) linksOf(n.closure, out);
  }
}

/** A graph canonicalized, with its identity, its sorted links and its root. */
export interface RootedGraph {
  readonly canonical: DucGraph;
  readonly identity: string;
  readonly links: readonly StoredLink[];
  readonly root: string;
}

/** A graph's root, as `packGraph` gives it, and what it commits to. */
export function rootedGraph(graph: DucGraph): RootedGraph {
  const canonical = canonicalizeGraph(graph.nodes, graph.obs, graph.branches ?? []);
  const canon = graph.mode !== undefined ? { ...canonical, mode: graph.mode } : canonical;
  const links = new Map<string, StoredLink>();
  linksOf(canon, links);
  const identity = graphIdentity(canon);
  const sorted = [...links.values()].sort((a, b) => (linkKey(a) < linkKey(b) ? -1 : 1));
  return { canonical: canon, identity, links: sorted, root: graphRoot(identity, sorted) };
}
