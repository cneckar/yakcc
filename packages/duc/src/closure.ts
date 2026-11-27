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
import { isLeafFunction } from "./leaves.js";
import { operationReference } from "./operations.js";
import type { DiamondLabel, DucGraph } from "./types.js";

export interface ClosureReport {
  /** True when there are no unlinked references. */
  readonly closed: boolean;
  /** Names the graph references that are neither linked nor platform primitives. */
  readonly unlinked: readonly string[];
  /** Names the graph references that are platform primitives (ambient reads). */
  readonly primitives: readonly string[];
  /**
   * Names the graph references that are linked: to atoms by spec id, and the operations that are
   * references to atoms (`Math.sin`, #1362), which the operation library always links.
   */
  readonly linked: readonly string[];
  /** Leaf functions the graph calls by their reserved names (`__ykF64Bits`, `leaves.ts`). */
  readonly leaves: readonly string[];
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
  const leaves = new Set<string>();
  const visit = (graph: DucGraph): void => {
    for (const node of graph.nodes) {
      const op = node.kind === "op" ? operationReference(node.label) : undefined;
      if (op !== undefined) linkedUsed.add(op.label);
      if (node.closure !== undefined) visit(node.closure);
    }
  };
  visit(g);
  for (const node of g.nodes) {
    const d = node.diamond;
    if (d === undefined) continue;
    if (d.reason === "free-identifier" && isLeafFunction(d.symbol)) {
      leaves.add(d.symbol);
      continue;
    }
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
    leaves: sorted(leaves),
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

/**
 * The specifiers a graph passes to CommonJS `require` (#1290), closures included: a literal string, or null for one
 * that is not a literal.
 */
export function requireSpecifiers(g: DucGraph, into: (string | null)[] = []): (string | null)[] {
  const requireValues = new Set<string>();
  const literal = new Map<string, string>();
  for (const n of g.nodes) {
    if (n.kind === "diamond-source" && n.diamond?.symbol === "require")
      requireValues.add(n.outputs[0] as string);
    if (n.kind === "literal-source") {
      try {
        const v = JSON.parse(n.label ?? "") as unknown;
        if (typeof v === "string") literal.set(n.outputs[0] as string, v);
      } catch {
        // not a string literal
      }
    }
  }
  // In the order the calls run: each is a heap operation, ordered after the one before it by the
  // token (#1285); the canonical order of the nodes is structure, not that order.
  const producer = new Map<string, (typeof g.nodes)[number]>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const depth = new Map<string, number>();
  const depthOf = (n: (typeof g.nodes)[number]): number => {
    const known = depth.get(n.id);
    if (known !== undefined) return known;
    depth.set(n.id, 0);
    const tokens =
      n.order === 1
        ? [n.inputs[n.inputs.length - 1]]
        : n.kind === "sel" && n.label === "heap"
          ? n.inputs.slice(1)
          : [];
    let d = 0;
    for (const t of tokens) {
      const p = t !== undefined ? producer.get(t) : undefined;
      if (p !== undefined) d = Math.max(d, depthOf(p) + 1);
    }
    depth.set(n.id, d);
    return d;
  };
  const calls = g.nodes
    .filter(
      (n) =>
        n.kind === "op" && n.label === "CallExpression" && requireValues.has(n.inputs[0] as string),
    )
    .map((n, i) => ({ n, i, d: depthOf(n) }))
    .sort((a, b) => a.d - b.d || a.i - b.i);
  for (const n of g.nodes) if (n.closure !== undefined) requireSpecifiers(n.closure, into);
  for (const { n } of calls) into.push(literal.get(n.inputs[1] as string) ?? null);
  return into;
}
