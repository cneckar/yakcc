// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-GRAPH-MODEL-001
// title: An atom lifts to a DUC graph (SSA values, opaque operation nodes,
//   def-use edges, diamond-sources for unresolved uses, Obs for observations).
// status: decided (wi-duc-influence-layer S1, GH #1162)
// rationale:
//   The Def-Use Calculus (DUC) takes as primitive only a finite single-assignment
//   dataflow graph: values, anonymous *opaque* operation nodes, and def-use edges.
//   There is no transition relation, control-flow graph, stored order, guard form,
//   or denotation for any node. Well-formedness is two clauses: conservation (every
//   use has a def) and acyclicity. Everything else — happens-before order, the
//   descent measure, may-influence, non-interference — is a *theorem of the graph*,
//   derived and never stored. This file fixes the substrate; the analyses in
//   influence.ts / ni.ts / compose.ts are what prove statements over it, quantified
//   over every interpretation of the opaque nodes.
//   Source paper: "Sound Influence under Opacity: A Def-Use Calculus for Computation
//   whose Semantics Were Never Given", §2.

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

/**
 * A value in a DUC graph: an immutable, single-assignment name. Every value is
 * the output of exactly one node (the single-assignment condition). Ids are
 * assigned deterministically by the lifter (`v0`, `v1`, ...) so a lift is
 * reproducible and content-addressable.
 */
export type ValueId = string & { readonly __brand: "DucValueId" };

/**
 * An operation node in a DUC graph. Nodes are *opaque*: the graph records only
 * their input and output ports, never what they compute. Ids are assigned
 * deterministically by the lifter (`n0`, `n1`, ...).
 */
export type NodeId = string & { readonly __brand: "DucNodeId" };

/** Construct a {@link ValueId} from a raw string. */
export function valueId(raw: string): ValueId {
  return raw as ValueId;
}

/** Construct a {@link NodeId} from a raw string. */
export function nodeId(raw: string): NodeId {
  return raw as NodeId;
}

// ---------------------------------------------------------------------------
// Node kinds and the diamond-source
// ---------------------------------------------------------------------------

/**
 * A reader annotation on a node. It carries **no semantics** — two `op` nodes
 * are interpreted independently even when a reader annotated them the same way
 * (DUC Def 4.3). The kind exists only to help humans read a graph and to let the
 * lifter mark the structurally-distinguished node classes:
 *
 * - `param-source`  — a 0-ary source for a parameter/input of the lifted atom.
 * - `literal-source`— a 0-ary source for a literal (a literal is a 0-ary source).
 * - `diamond-source`— a 0-ary source the conservative builder invents for an
 *   otherwise-dangling use (the distinguished diamond label; DUC §2, §3).
 * - `op`            — an ordinary opaque operation (call, operator, access, ...).
 * - `sel`           — a selection/gate whose condition is an ordinary input
 *   (control-as-data; DUC Example 2.6). Implicit flows are influence edges by
 *   construction because the condition value flows in as data.
 * - `loop`          — a single opaque node summarizing a bounded loop whose body
 *   is not further decomposed (DEC-DUC-SCOPE-001; mirrors shave's
 *   "loop-is-the-atom" bottoming-out).
 */
export type NodeKind =
  | "param-source"
  | "literal-source"
  | "diamond-source"
  | "op"
  | "sel"
  | "loop"
  | "carry-source";

/** Why a use could not be resolved to a def inside the lifted atom. */
export type DiamondReason =
  | "unlinked-reference" // a binding imported from outside the workspace
  | "free-identifier" // a free identifier with no in-atom binding
  | "unresolved-module" // a cross-module edge the resolver could not follow
  | "platform-primitive"; // a read of an ambient/global the atom does not own

/**
 * The distinguished label the conservative builder attaches to a source it
 * invents for an otherwise-dangling use. The symbol `♦` is a label, not a sort:
 * a diamond-source is an ordinary 0-ary node that is *counted* rather than
 * silently dropped. Its presence is first-class precisely so that its absence is
 * meaningful (DUC §2, WF-C).
 */
export interface DiamondLabel {
  readonly reason: DiamondReason;
  /** The unresolved name, e.g. `"FLAGS"` or `"readFileSync"`. */
  readonly symbol: string;
  /** For `unlinked-reference`: the module the symbol was imported from. */
  readonly module?: string;
  /**
   * The key of the atom this reference is linked to (#1275, P7). Absent until the reference is
   * resolved. An atom is submitted only when every reference is linked and every link is in the
   * submission or the store.
   */
  readonly spec?: string;
}

/**
 * Reader-facing provenance for a node. Carries **no semantics** — it exists so a
 * witness term (influence.ts) can point at a human-readable source position.
 */
export interface NodeOrigin {
  /** The ts SyntaxKind name of the construct, as a reader annotation only. */
  readonly kind: string;
  /** A short source excerpt, for witnesses. Truncated by the lifter. */
  readonly text?: string;
}

// ---------------------------------------------------------------------------
// Nodes and graphs
// ---------------------------------------------------------------------------

/**
 * An opaque operation node. `inputs` and `outputs` are ordered tuples of value
 * ports. The single-assignment condition holds across a well-formed graph: every
 * value occurs in the `outputs` of exactly one node.
 */
export interface DucNode {
  readonly id: NodeId;
  readonly inputs: readonly ValueId[];
  readonly outputs: readonly ValueId[];
  readonly kind: NodeKind;
  /**
   * The branch path this node lies in, outermost first, for example `b0.t/b1.e`: branch id, then `t`
   * (then-side) or `e` (else-side). Absent for a node outside every branch.
   */
  readonly region?: string;
  /**
   * Present on a `loop` node (#1275, loops). The loop's body is the region `<id>.b`. Inside the body,
   * `carry` are the values of the carried variables at the start of an iteration (one per output), and
   * `invariant` the values of the outer values the body reads (one per input after the carries). `cond`
   * says whether to continue, and `next` gives the carried values for the next iteration.
   */
  readonly loop?: DucLoop;
  /**
   * Present on a `closure` node (#1275, closures): the closure's own graph. Its first parameters are
   * the values it captures, which are this node's inputs, in order; then its own parameters. The
   * closure is an atom of its own; this node makes it from the values it captures.
   */
  readonly closure?: DucGraph;
  /** Present iff `kind === "diamond-source"`. */
  readonly diamond?: DiamondLabel;
  readonly origin?: NodeOrigin;
  /**
   * The structural label of the node, part of identity (D6, #1275). For a parameter, its
   * index. For a literal, its value text. For a binary or compound operator, its symbol. For any
   * other node, its syntactic kind. Origin text is never a label.
   */
  readonly label?: string;
  /**
   * 1 when the node's last input orders it rather than feeding it (#1285): the heap token, the value
   * of the heap operation before it (a call, `new`, a member read or write, an opaque operation).
   * Heap operations are totally ordered by these edges, so their order is structure, as every
   * happens-before relation of the graph is. A select or a carry of the token is labelled `heap`
   * (`carry:<i>:heap`); it computes nothing, and a lowering writes nothing for it.
   */
  readonly order?: 1;
}

/**
 * A DUC graph: values, the opaque operation nodes that define them, and the
 * def-use edges between them, plus the set of boundary observations. The graph is
 * the primitive; it is not a semantics. It is what remains when semantics are
 * withheld (DUC Remark 2.4).
 *
 * `values` is the full value set (derivable from the nodes, but materialized for
 * convenience and stable serialization). `obs ⊆ values`.
 */
export interface DucGraph {
  readonly nodes: readonly DucNode[];
  readonly values: readonly ValueId[];
  readonly obs: readonly ValueId[];
  /**
   * The `if` branches of the atom (structured control, option B of #1275). Each branch has an id and
   * the condition value. A node that lies inside a branch carries its region path in `region`. Absent
   * or empty when the atom has no branches.
   */
  readonly branches?: readonly DucBranch[];
  /**
   * How the atom's function runs, when it is not an ordinary function (#1276): an `async` function
   * returns a promise and may `await`, a generator returns an iterator and may `yield`. Part of the
   * identity. A closure's mode is in its node's label instead (`async closure`, `function*`).
   */
  readonly mode?: FunctionMode;
}

/** An async function, a generator, or both. */
export type FunctionMode = "async" | "generator" | "async generator";

/** The body of a `loop` node. See `DucNode.loop`. */
export interface DucLoop {
  readonly id: string;
  readonly carry: readonly ValueId[];
  readonly invariant: readonly ValueId[];
  readonly next: readonly ValueId[];
  /** A `while` or `for` loop: the body's condition to continue. Absent for an iteration. */
  readonly cond?: ValueId;
  /**
   * An iteration (`for...of` over values, `for...in` over keys): the body's source for the current
   * element. The iterable is the loop's input right after the carries' initial values. Iterating is
   * a platform primitive, so this holds for any iterable.
   */
  readonly iterate?: { readonly element: ValueId; readonly of: "values" | "keys" };
}

/**
 * One `if` in the atom: its id, the value of its condition, and the region it sits in (absent at
 * the top level). The region is recorded even when a branch holds no nodes, for example an `if`
 * whose only effect is a join, so the structure round-trips.
 */
export interface DucBranch {
  readonly id: string;
  readonly cond: ValueId;
  readonly within?: string;
}

// ---------------------------------------------------------------------------
// Derived indices (helpers — nothing here is stored in the graph)
// ---------------------------------------------------------------------------

/**
 * Map each value to its defining node (single-assignment). If the graph is not
 * single-assignment, the *last* definer wins in the returned map; use
 * {@link isWellFormed} to detect multiple-definer violations.
 */
export function defMap(graph: DucGraph): Map<ValueId, NodeId> {
  const def = new Map<ValueId, NodeId>();
  for (const node of graph.nodes) {
    for (const out of node.outputs) {
      def.set(out, node.id);
    }
  }
  return def;
}

/** Index nodes by id. */
export function nodeIndex(graph: DucGraph): Map<NodeId, DucNode> {
  const idx = new Map<NodeId, DucNode>();
  for (const node of graph.nodes) {
    idx.set(node.id, node);
  }
  return idx;
}

/** The sources of a graph: nodes with no inputs (DUC `Src`, derived not declared). */
export function sources(graph: DucGraph): readonly DucNode[] {
  return graph.nodes.filter((n) => n.inputs.length === 0);
}

/** The diamond-labelled sources of a graph (`Src_♦`). */
export function diamondSources(graph: DucGraph): readonly DucNode[] {
  return graph.nodes.filter((n) => n.diamond !== undefined);
}
