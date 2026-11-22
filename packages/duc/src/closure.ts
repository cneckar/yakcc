// SPDX-License-Identifier: Apache-2.0
/**
 * Closure (P7, #1275). An atom is closed when every reference it makes resolves to something in
 * the graph, to an atom linked by its spec id, or to a platform primitive of the target. Anything
 * else is an unlinked reference, a hole: the atom cannot be selected for output until the hole
 * is filled by shaving the dependency into the corpus.
 *
 * This is checked from the graph alone. It does not run the code.
 */
import type { DucGraph } from "./types.js";

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
    if (d.reason === "ambient-read") {
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
