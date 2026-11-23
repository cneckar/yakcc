// SPDX-License-Identifier: Apache-2.0
/**
 * The stored form of an atom's graph (#1279). An implementation is keyed by the pair (the contract's
 * `specHash`, the graph's identity). What is stored is split three ways:
 *
 * - the structure: the canonical graph with no origin text and no links, in the compact encoding,
 *   brotli-compressed. This is what the identity hashes, so it is the same bytes for the same
 *   structure wherever it was lifted from.
 * - the links: each reference's link to a contract (`spec`), a separate record outside identity
 *   (#1275, 2B). The same structure can be linked differently.
 * - the annotations: origin text (the names and source fragments the lifter saw), also outside
 *   identity, and only useful for showing the atom to a person or a model.
 *
 * `unpackGraph` puts the three back together.
 */
import { constants, brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { canonicalizeGraph, graphIdentity } from "./canonical.js";
import { type CompactGraph, decodeGraph, encodeGraph } from "./compact.js";
import type { DiamondLabel, DucGraph, DucNode, NodeOrigin } from "./types.js";

/** The version of the stored structure's encoding. Version 2 adds the ordering flag (#1285). */
export const GRAPH_FORMAT_VERSION = 2;

/**
 * The version of the lifter whose graphs these are. A change to what the lifter produces for the
 * same source (a new construct lifted, a canonical rule) changes identities, so it bumps this: a
 * stored graph from an older lifter is still valid, but relifting its source may give another.
 */
export const LIFTER_VERSION = 36;

/** One reference's link: the reference, by reason, symbol and module, and the contract it links to. */
export interface StoredLink {
  readonly reason: DiamondLabel["reason"];
  readonly symbol: string;
  readonly module?: string;
  readonly spec: string;
}

export interface PackedGraph {
  /** The graph's identity: the key, with the contract's specHash, of the implementation. */
  readonly identity: string;
  readonly formatVersion: number;
  readonly lifterVersion: number;
  /** The structure, brotli-compressed. */
  readonly structure: Uint8Array;
  readonly links: readonly StoredLink[];
  /** The origin annotations, brotli-compressed, or undefined when the graph has none. */
  readonly annotations?: Uint8Array;
}

const compress = (text: string): Uint8Array =>
  new Uint8Array(
    brotliCompressSync(Buffer.from(text, "utf8"), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  );
const decompress = (bytes: Uint8Array): string => brotliDecompressSync(bytes).toString("utf8");

const linkKey = (d: { reason: string; symbol: string; module?: string }): string =>
  `${d.reason}\u0000${d.symbol}\u0000${d.module ?? ""}`;

/** The structure alone: no origins, no links, and the same for each closure inside. */
function structureOf(g: DucGraph): DucGraph {
  const nodes = g.nodes.map((n): DucNode => {
    const { origin: _origin, diamond, closure, ...rest } = n;
    const out: DucNode = { ...rest };
    if (diamond !== undefined) {
      const { spec: _spec, ...structural } = diamond;
      (out as { diamond?: DiamondLabel }).diamond = structural;
    }
    if (closure !== undefined) (out as { closure?: DucGraph }).closure = structureOf(closure);
    return out;
  });
  return { ...g, nodes };
}

/** The origins of a graph's nodes, by position, with its closures' nested. */
interface Annotations {
  readonly origins: (NodeOrigin | null)[];
  readonly closures: Record<number, Annotations>;
}

function annotationsOf(g: DucGraph): Annotations {
  const closures: Record<number, Annotations> = {};
  g.nodes.forEach((n, i) => {
    if (n.closure !== undefined) closures[i] = annotationsOf(n.closure);
  });
  return { origins: g.nodes.map((n) => n.origin ?? null), closures };
}

function linksOf(g: DucGraph, out: Map<string, StoredLink>): void {
  for (const n of g.nodes) {
    const d = n.diamond;
    if (d?.spec !== undefined)
      out.set(linkKey(d), {
        reason: d.reason,
        symbol: d.symbol,
        ...(d.module !== undefined ? { module: d.module } : {}),
        spec: d.spec,
      });
    if (n.closure !== undefined) linksOf(n.closure, out);
  }
}

/** Pack a graph for the store: its identity, its compressed structure, its links and annotations. */
export function packGraph(graph: DucGraph): PackedGraph {
  const canonical = canonicalizeGraph(graph.nodes, graph.obs, graph.branches ?? []);
  const canon = graph.mode !== undefined ? { ...canonical, mode: graph.mode } : canonical;
  const structure = structureOf(canon);
  const links = new Map<string, StoredLink>();
  linksOf(canon, links);
  const notes = annotationsOf(canon);
  const hasNotes = JSON.stringify(notes).includes('"kind"');
  return {
    identity: graphIdentity(canon),
    formatVersion: GRAPH_FORMAT_VERSION,
    lifterVersion: LIFTER_VERSION,
    structure: compress(JSON.stringify(encodeGraph(structure))),
    links: [...links.values()].sort((a, b) => (linkKey(a) < linkKey(b) ? -1 : 1)),
    ...(hasNotes ? { annotations: compress(JSON.stringify(notes)) } : {}),
  };
}

function attach(
  g: DucGraph,
  links: ReadonlyMap<string, string>,
  notes: Annotations | undefined,
): DucGraph {
  const nodes = g.nodes.map((n, i): DucNode => {
    let out: DucNode = n;
    const origin = notes?.origins[i];
    if (origin !== undefined && origin !== null) out = { ...out, origin };
    const d = out.diamond;
    const spec = d !== undefined ? links.get(linkKey(d)) : undefined;
    if (d !== undefined && spec !== undefined) out = { ...out, diamond: { ...d, spec } };
    if (out.closure !== undefined)
      out = { ...out, closure: attach(out.closure, links, notes?.closures[i]) };
    return out;
  });
  return { ...g, nodes };
}

/**
 * The graph a packed implementation stores: the structure, with its links and, when given, its
 * annotations put back. Throws for a format this does not read.
 */
export function unpackGraph(
  packed: Pick<PackedGraph, "formatVersion" | "structure" | "links" | "annotations">,
): DucGraph {
  if (packed.formatVersion !== GRAPH_FORMAT_VERSION && packed.formatVersion !== 1)
    throw new Error(
      `graph format ${packed.formatVersion} is not one this reads (${GRAPH_FORMAT_VERSION})`,
    );
  const structure = decodeGraph(JSON.parse(decompress(packed.structure)) as CompactGraph);
  const links = new Map(packed.links.map((l) => [linkKey(l), l.spec] as const));
  const notes =
    packed.annotations !== undefined
      ? (JSON.parse(decompress(packed.annotations)) as Annotations)
      : undefined;
  return attach(structure, links, notes);
}
