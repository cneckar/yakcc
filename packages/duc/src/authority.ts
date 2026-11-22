// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-AUTHORITY-DELTA-001 (wi-guard A1, GH #1254)
// Differential authority (GFP §5, adapted). Given a candidate implementation and a
// reference implementation of the same boundary, the authority delta is the set of
// parameter->observation influence edges the candidate has and the reference lacks,
// each with a witness path. A candidate with a non-empty delta is NOT a refinement of
// the reference (DUC Thm 6.2: refinement only removes influence), so choosing it over
// the reference exposes authority the reference did not. The check is pure and
// reports, never decides. Policy (demote, warn, reject) belongs to the caller.
//
// Non-comparable results are returned explicitly. A boundary mismatch, or a source
// that does not lift, is not evidence of safety, so it is never reported as a
// clean delta.

import { refinesInfluence } from "./compose.js";
import { renderWitness, witness } from "./influence.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

/** One authority edge the candidate adds over the reference. */
export interface AuthorityEdge {
  readonly paramIndex: number;
  readonly obsIndex: number;
  /** Rendered provenance of the observation in the candidate: where the parameter enters. */
  readonly witness: string;
}

/** The differential authority of a candidate against a reference. */
export type AuthorityDelta =
  | { readonly comparable: false; readonly reason: "boundary-mismatch" | "unliftable" }
  | {
      readonly comparable: true;
      readonly addsAuthority: boolean;
      readonly added: readonly AuthorityEdge[];
    };

/**
 * The authority delta of `candidateSource` relative to `referenceSource`.
 * `addsAuthority` is true iff the candidate adds at least one param->obs edge.
 */
export function authorityDelta(candidateSource: string, referenceSource: string): AuthorityDelta {
  let candidate: DucGraph;
  let reference: DucGraph;
  try {
    candidate = liftAtom(candidateSource);
    reference = liftAtom(referenceSource);
  } catch {
    return { comparable: false, reason: "unliftable" };
  }
  const result = refinesInfluence(candidate, reference);
  if (result.refines) return { comparable: true, addsAuthority: false, added: [] };
  if (result.reason === "boundary-mismatch")
    return { comparable: false, reason: "boundary-mismatch" };
  const added = result.added.map((edge) => {
    const obs = candidate.obs[edge.obsIndex];
    return {
      paramIndex: edge.paramIndex,
      obsIndex: edge.obsIndex,
      witness: obs === undefined ? "" : renderWitness(witness(candidate, obs)),
    };
  });
  return { comparable: true, addsAuthority: added.length > 0, added };
}
