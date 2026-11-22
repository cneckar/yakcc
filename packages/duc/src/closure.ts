// SPDX-License-Identifier: Apache-2.0
/**
 * Closure (P7, #1275). An atom is closed when every reference it makes resolves to something in
 * the graph, to an atom linked by its spec id, or to a platform primitive of the target. Anything
 * else is an unlinked reference, a hole: the atom cannot be selected for output until the hole
 * is filled by shaving the dependency into the corpus.
 *
 * This is checked from the graph alone. It does not run the code.
 */
import type { DiamondLabel, DucGraph } from "./types.js";

export interface ClosureReport {
  /** True when there are no unlinked references. */
  readonly closed: boolean;
  /** Names the graph references that are neither linked nor platform primitives. */
  readonly unlinked: readonly string[];
  /** Names the graph references that are platform primitives (ambient reads). */
  readonly primitives: readonly string[];
  /** Names the graph references that are linked to atoms by spec id. */
  readonly linked: readonly string[];
}

export interface ClosureOptions {
  /** Symbols linked to atoms in the corpus (composition references). */
  readonly linked?: ReadonlySet<string>;
}

/** The closure of a graph, given the symbols linked to corpus atoms. */
export function closureOf(g: DucGraph, options: ClosureOptions = {}): ClosureReport {
  const linked = options.linked ?? new Set<string>();
  const unlinked = new Set<string>();
  const primitives = new Set<string>();
  const linkedUsed = new Set<string>();
  for (const node of g.nodes) {
    const d = node.diamond;
    if (d === undefined) continue;
    if (d.reason === "platform-primitive") {
      primitives.add(d.symbol);
    } else if (linked.has(d.symbol)) {
      linkedUsed.add(d.symbol);
    } else {
      unlinked.add(d.symbol);
    }
  }
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return {
    closed: unlinked.size === 0,
    unlinked: sorted(unlinked),
    primitives: sorted(primitives),
    linked: sorted(linkedUsed),
  };
}

/** An atom offered for submission: its key (its spec id, or its identity) and its graph. */
export interface SubmittedAtom {
  readonly key: string;
  readonly graph: DucGraph;
}

export interface AtomSubmission {
  readonly key: string;
  /** True when every reference is linked to an atom in the batch or the store. */
  readonly closed: boolean;
  /** Symbols that have no link: holes that must be filled by shaving the dependency. */
  readonly holes: readonly string[];
  /** Keys the atom links to that are neither in the batch nor in the store. */
  readonly unresolved: readonly string[];
}

export interface SubmissionReport {
  /** True when every atom in the batch is closed. Atoms are submitted only as closed (#1275, P7). */
  readonly accepted: boolean;
  readonly atoms: readonly AtomSubmission[];
}

/**
 * Checks a batch of atoms for submission. An atom is closed when each of its references is a
 * platform primitive, or is linked (`spec`) to a key that is in the batch, in the store, or both.
 * The batch closes its own references: atoms that depend on each other are submitted together.
 */
export function checkSubmission(
  batch: readonly SubmittedAtom[],
  store: ReadonlySet<string>,
): SubmissionReport {
  const present = new Set<string>([...store, ...batch.map((a) => a.key)]);
  const atoms = batch.map(({ key, graph }): AtomSubmission => {
    const holes = new Set<string>();
    const unresolved = new Set<string>();
    for (const node of graph.nodes) {
      const d = node.diamond;
      if (d === undefined || d.reason === "platform-primitive") continue;
      if (d.spec === undefined) holes.add(d.symbol);
      else if (!present.has(d.spec)) unresolved.add(d.spec);
    }
    return {
      key,
      closed: holes.size === 0 && unresolved.size === 0,
      holes: [...holes].sort(),
      unresolved: [...unresolved].sort(),
    };
  });
  return { accepted: atoms.every((a) => a.closed), atoms };
}

/**
 * Links a graph's references through a resolver: `resolve` gives the key of the atom a reference
 * names, or undefined when there is none. Platform primitives are never linked.
 */
export function linkReferences(
  g: DucGraph,
  resolve: (label: DiamondLabel) => string | undefined,
): DucGraph {
  return {
    ...g,
    nodes: g.nodes.map((node) => {
      const d = node.diamond;
      if (d === undefined || d.reason === "platform-primitive") return node;
      const spec = resolve(d);
      return spec === undefined ? node : { ...node, diamond: { ...d, spec } };
    }),
  };
}
