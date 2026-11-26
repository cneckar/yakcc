// SPDX-License-Identifier: Apache-2.0
/** The contract shapes L2 reads (#1421). */

/** The part of a contract L2 reads: the typed signature and the conditions. */
export interface L2Contract {
  readonly inputs: readonly { readonly name: string; readonly type: string }[];
  readonly outputs: readonly { readonly type: string }[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  /**
   * Loop invariants (#1421 slice 3), one list per `while`/`for` loop of the atom, in the order the
   * loops appear in the graph's nodes (`loopsOf` lists them with their source text). An invariant is
   * an ECMAScript expression over the parameters and the loop's carried variables, by their source
   * names. A loop without invariants has the weakest one, `true`.
   */
  readonly loopInvariants?: readonly (readonly string[])[];
}

/**
 * A callee the atom calls through a link (#1421 slice 4): its contract, and whether that contract
 * is L2-proven for the implementation the link names. Its postconditions are assumed at a call only
 * when `proven` is true; its preconditions are always obligations at the call.
 */
export interface Callee {
  readonly contract: L2Contract;
  readonly proven: boolean;
  /** The root the proof is for. Recorded in the report; the registry checks it against the link. */
  readonly root?: string;
  /** The callee's source, to replay counterexamples. Without it, they are not replayed. */
  readonly source?: string;
}
