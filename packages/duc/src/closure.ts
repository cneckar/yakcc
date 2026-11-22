// SPDX-License-Identifier: Apache-2.0
/**
 * Closure (P7, #1275). An atom is closed when every reference it makes resolves to something in
 * the graph, to an atom linked by its spec id, or to a platform primitive of the target. Anything
 * else is an unlinked reference, a hole: the atom cannot be selected for output until the hole
 * is filled by shaving the dependency into the corpus.
 *
 * This is checked from the graph alone. It does not run the code.
 */
import type { BaseSet } from "./base-set.js";
import { graphIdentity } from "./canonical.js";
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
  /** The target's base set: a platform primitive it does not provide is a hole on that target. */
  readonly baseSet?: BaseSet;
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
    if (
      d.reason === "platform-primitive" &&
      (options.baseSet === undefined || d.symbol in options.baseSet.primitives)
    ) {
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

/**
 * An atom offered for submission (#1275, decision 1): its graph, and the contract it implements, as
 * the contract's `specHash` (@yakcc/contracts). The atom itself is keyed by its graph identity.
 */
export interface SubmittedAtom {
  readonly spec: string;
  readonly graph: DucGraph;
}

export interface AtomSubmission {
  /** The contract the atom implements. */
  readonly spec: string;
  /** The atom's key: the identity of its graph. */
  readonly identity: string;
  /** True when every reference is linked to a contract in the batch or the store. */
  readonly closed: boolean;
  /** Symbols that have no link: holes that must be filled by shaving the dependency. */
  readonly holes: readonly string[];
  /** Contracts the atom links to that are neither in the batch nor in the store. */
  readonly unresolved: readonly string[];
}

export interface SubmissionReport {
  /** True when every atom in the batch is closed. Atoms are submitted only as closed (#1275, P7). */
  readonly accepted: boolean;
  readonly atoms: readonly AtomSubmission[];
}

/**
 * Checks a batch of atoms for submission. A reference names the contract it needs (`spec`), not an
 * atom. An atom is closed when each of its references is a platform primitive, or is linked to a
 * contract that an atom in the batch implements or that the store already holds (`storedContracts`).
 * The batch closes its own references: atoms that depend on each other are submitted together.
 */
export function checkSubmission(
  batch: readonly SubmittedAtom[],
  storedContracts: ReadonlySet<string>,
  baseSet?: BaseSet,
): SubmissionReport {
  const present = new Set<string>([...storedContracts, ...batch.map((a) => a.spec)]);
  const atoms = batch.map(({ spec, graph }): AtomSubmission => {
    const holes = new Set<string>();
    const unresolved = new Set<string>();
    for (const node of graph.nodes) {
      const d = node.diamond;
      if (d === undefined) continue;
      if (d.reason === "platform-primitive") {
        if (baseSet !== undefined && !(d.symbol in baseSet.primitives)) holes.add(d.symbol);
        continue;
      }
      if (d.spec === undefined) holes.add(d.symbol);
      else if (!present.has(d.spec)) unresolved.add(d.spec);
    }
    return {
      spec,
      identity: graphIdentity(graph),
      closed: holes.size === 0 && unresolved.size === 0,
      holes: [...holes].sort(),
      unresolved: [...unresolved].sort(),
    };
  });
  return { accepted: atoms.every((a) => a.closed), atoms };
}

/**
 * Links a graph's references through a resolver: `resolve` gives the contract (`specHash`) a
 * reference needs, or undefined when there is none. Platform primitives are never linked.
 */
export function linkReferences(
  g: DucGraph,
  resolve: (label: DiamondLabel) => string | undefined,
): DucGraph {
  return {
    ...g,
    nodes: g.nodes.map((node) => {
      // A closure's own graph is linked too (its free names are usually captures, linked here).
      const inner =
        node.closure !== undefined
          ? { ...node, closure: linkReferences(node.closure, resolve) }
          : node;
      const d = inner.diamond;
      if (d === undefined || d.reason === "platform-primitive") return inner;
      const spec = resolve(d);
      return spec === undefined ? inner : { ...inner, diamond: { ...d, spec } };
    }),
  };
}
