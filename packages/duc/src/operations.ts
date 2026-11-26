// SPDX-License-Identifier: Apache-2.0
/**
 * Operations as references (DEC-DUC-OPERATIONS-AS-ATOMS-001, step 2, #1362).
 *
 * An operation that is not a leaf (`leaves.ts`) is an atom. In a graph it keeps a readable label,
 * `Math.sin`, and the label is a reference: the graph's links bind it to the root of the atom that
 * implements it, with the link reason `operation`. The root of a graph commits to its links, so it
 * says which implementation the graph uses.
 *
 * `Math`'s atoms are shaved from V8 12.4's `ieee754.cc` and musl's `scalbn.c` (`atoms/math.ts`). An
 * atom calls other atoms by name (`__kernel_sin`, `scalbn`): those are references too, linked to the
 * callee's root; and it calls leaf functions (`__ykF64Bits`), which are not linked.
 *
 * The label means what ECMAScript's function means, ToNumber of its arguments included, as `js.add`
 * means `+`; the atom implements it on numbers.
 */
import { MATH_ATOM_SOURCES } from "./atoms/math.js";
import { isLeafFunction } from "./leaves.js";
import { liftAtom } from "./lift.js";
import { OPERATION_REFERENCES } from "./operation-refs.js";
import { setOperationRoots } from "./root.js";
import { packGraph } from "./store.js";
import type { DucGraph, DucNode } from "./types.js";

export {
  mathOperation,
  OPERATION_REFERENCES,
  type OperationReference,
  operationReference,
} from "./operation-refs.js";

/** The names of every atom in the library. */
export function atomNames(): readonly string[] {
  return Object.keys(MATH_ATOM_SOURCES);
}

/** An atom's source, as shaved: the TypeScript the lifter reads. */
export function atomSource(atom: string): string {
  const a = MATH_ATOM_SOURCES[atom];
  if (a === undefined) throw new Error(`no atom named ${atom}`);
  return a.source;
}

const lifted = new Map<string, DucGraph>();
const linkedGraphs = new Map<string, DucGraph>();
const roots = new Map<string, string>();
const rooting = new Set<string>();

/** An atom's graph, as lifted from its source, with no links. */
export function atomGraph(atom: string): DucGraph {
  let g = lifted.get(atom);
  if (g === undefined) {
    g = liftAtom(atomSource(atom));
    lifted.set(atom, g);
  }
  return g;
}

/** The atoms an atom references by name: the free names that are atoms of the library. */
export function atomCallees(atom: string): readonly string[] {
  const out = new Set<string>();
  const visit = (g: DucGraph): void => {
    for (const n of g.nodes) {
      const d = n.diamond;
      if (d !== undefined && d.reason === "free-identifier" && d.symbol in MATH_ATOM_SOURCES)
        out.add(d.symbol);
      if (n.closure !== undefined) visit(n.closure);
    }
  };
  visit(atomGraph(atom));
  return [...out].sort();
}

/**
 * An atom's graph with every reference linked: a callee atom to its root (in the reference's `spec`,
 * as a link to any atom is), so that packing it gives the atom's root.
 */
export function linkedAtomGraph(atom: string): DucGraph {
  let g = linkedGraphs.get(atom);
  if (g !== undefined) return g;
  const link = (graph: DucGraph): DucGraph => ({
    ...graph,
    nodes: graph.nodes.map((n): DucNode => {
      let out = n;
      const d = n.diamond;
      if (d !== undefined && d.reason === "free-identifier" && d.symbol in MATH_ATOM_SOURCES)
        out = { ...out, diamond: { ...d, spec: atomRoot(d.symbol) } };
      if (out.closure !== undefined) out = { ...out, closure: link(out.closure) };
      return out;
    }),
  });
  g = link(atomGraph(atom));
  linkedGraphs.set(atom, g);
  return g;
}

/**
 * An atom's root: its graph's identity and its links (to its callees' roots), committed to as any
 * graph's root is (DEC-DUC-GRAPH-ROOT-001). A change to an atom changes its root, and the root of
 * every atom and graph that references it.
 */
export function atomRoot(atom: string): string {
  const known = roots.get(atom);
  if (known !== undefined) return known;
  if (rooting.has(atom)) throw new Error(`the atom ${atom} references itself through its callees`);
  rooting.add(atom);
  try {
    const root = packGraph(linkedAtomGraph(atom)).root;
    roots.set(atom, root);
    return root;
  } finally {
    rooting.delete(atom);
  }
}

/** The root of the atom an operation label references. */
export function operationRoot(label: string): string {
  const ref = OPERATION_REFERENCES.get(label);
  if (ref === undefined) throw new Error(`${label} is not an operation reference`);
  return atomRoot(ref.atom);
}

/** True when a free name read by an atom is a leaf function or another atom of the library. */
export function resolvesInLibrary(name: string): boolean {
  return isLeafFunction(name) || name in MATH_ATOM_SOURCES;
}

// A graph's root links each operation reference to its atom's root: the atoms are here.
setOperationRoots(operationRoot);
