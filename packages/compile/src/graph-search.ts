// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-GRAPH-SEARCH-001 (#1280): graph search over the registry. The vectors are an
// index over the stored graphs' retrieval signatures and only nominate candidates: the registry's
// k nearest graphs. Selection among them is structural: a graph with the query's identity first,
// then by structural distance (one minus the weighted Jaccard similarity of node and edge bags),
// then by vector distance. Each result carries its structure as line form, so a model can judge it
// against the contract; whether it meets the contract is never decided by a score.

import {
  type DucGraph,
  bagDistance,
  graphIdentity,
  parseLineForm,
  printLineForm,
  rankStructurally,
  retrievalSignature,
  structuralBag,
  unpackGraph,
} from "@yakcc/duc";
import type { Registry } from "@yakcc/registry";

export interface GraphSearchOptions {
  /** How many candidates the vector index nominates (default 10). */
  readonly k?: number;
}

export interface GraphSearchResult {
  readonly graphIdentity: string;
  /** The contracts this graph implements. */
  readonly specHashes: readonly string[];
  /** True when the graph has the query's identity: the same structure. */
  readonly exact: boolean;
  /** The structural distance to the query: 0 for the same bags, 1 for disjoint ones. */
  readonly structuralDistance: number;
  /** The cosine distance between the signature vectors. */
  readonly vectorDistance: number;
  /** The graph as line form, for a model to judge against the contract. */
  readonly lineForm: string;
}

/**
 * The stored graphs nearest a query, selected structurally (DEC-COMPILE-GRAPH-SEARCH-001), best
 * first. The query is a graph or its line form. A nominated graph that cannot be loaded is left out.
 */
export async function searchGraphs(
  registry: Registry,
  query: DucGraph | string,
  options: GraphSearchOptions = {},
): Promise<GraphSearchResult[]> {
  const q = typeof query === "string" ? parseLineForm(query) : query;
  const matches = await registry.findDucGraphsBySignature(retrievalSignature(q), options.k ?? 10);
  const loaded: {
    item: { graph: DucGraph; specHashes: readonly string[]; distance: number };
    identity: string;
    bag: ReadonlyMap<string, number>;
    score: number;
  }[] = [];
  for (const m of matches) {
    const spec = m.specHashes[0];
    if (spec === undefined) continue;
    const impl = await registry.getDucImplementation(spec, m.graphIdentity);
    if (impl === null) continue;
    let graph: DucGraph;
    try {
      // The structure alone: links and annotations do not enter selection.
      graph = unpackGraph({
        formatVersion: impl.formatVersion,
        structure: impl.structure,
        links: [],
      });
    } catch {
      continue;
    }
    loaded.push({
      item: { graph, specHashes: m.specHashes, distance: m.distance },
      identity: m.graphIdentity,
      bag: structuralBag(graph),
      score: -m.distance,
    });
  }
  const queryIdentity = graphIdentity(q);
  const queryBag = structuralBag(q);
  return rankStructurally(queryIdentity, queryBag, loaded).map((c) => {
    const exact = c.identity === queryIdentity;
    return {
      graphIdentity: c.identity,
      specHashes: c.item.specHashes,
      exact,
      structuralDistance: exact ? 0 : bagDistance(queryBag, c.bag),
      vectorDistance: c.item.distance,
      lineForm: printLineForm(c.item.graph),
    };
  });
}
