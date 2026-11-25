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
import { type CompactGraph, decodeGraph, encodeGraph } from "./compact.js";
// The atom library gives operation references their roots (root.ts) as it loads.
import "./operations.js";
import { GRAPH_FORMAT_VERSION, type StoredLink, linkKey, rootedGraph } from "./root.js";
import type { DiamondLabel, DucGraph, DucNode, NodeOrigin } from "./types.js";

export {
  ducBlockRoot,
  GRAPH_FORMAT_VERSION,
  graphRoot,
  recordRoot,
  type RootedGraph,
  rootedGraph,
  type StoredLink,
} from "./root.js";

/**
 * The version of the lifter whose graphs these are. A change to what the lifter produces for the
 * same source (a new construct lifted, a canonical rule) changes identities, so it bumps this: a
 * stored graph from an older lifter is still valid, but relifting its source may give another.
 */
export const LIFTER_VERSION = 72;

export interface PackedGraph {
  /** The graph's root (#1306): its identity, its links and its format version, committed to. */
  readonly root: string;
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

/** Pack a graph for the store: its identity, its compressed structure, its links and annotations. */
export function packGraph(graph: DucGraph): PackedGraph {
  const { canonical, identity, links, root } = rootedGraph(graph);
  const notes = annotationsOf(canonical);
  const hasNotes = JSON.stringify(notes).includes('"kind"');
  return {
    root,
    identity,
    formatVersion: GRAPH_FORMAT_VERSION,
    lifterVersion: LIFTER_VERSION,
    structure: compress(JSON.stringify(encodeGraph(structureOf(canonical)))),
    links,
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
