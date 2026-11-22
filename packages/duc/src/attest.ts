// SPDX-License-Identifier: Apache-2.0
//
// @decision DEC-DUC-ATTESTATION-SIDECAR-001 (wi-duc-influence-layer S3/S4, GH #1164 #1165)
// The DUC analyses are issued as attestation documents (`duc_influence`,
// `duc_ni`), not as entries in the block's proof manifest. The manifest is
// canonicalized into the BlockMerkleRoot (see @yakcc/contracts proof-manifest),
// so a manifest entry would change the identity of every block that carried an
// analysis. An analysis is a *derived fact about* a block, not part of its
// content address, so it is stored as sidecar provenance next to `ducUsupp`
// (DEC-DUC-ARTIFACT-KINDS-001 as revised here).
//
// Both documents are pure data, versioned, and self-checking: `validateDucAttestation`
// re-derives the structural invariants (matrix shape, observation indices, NI verdict
// consistent with its leaks) so a stored attestation can be checked without re-lifting.

import { boundaryType, paramSummaryMatrix } from "./compose.js";
import { renderWitness } from "./influence.js";
import { graphNI, labelBySymbol } from "./ni.js";
import { nodeIndex } from "./types.js";
import type { DucGraph } from "./types.js";

/** Attestation schema version. Bump on any change to the document shape. */
export const DUC_ATTESTATION_VERSION = 1 as const;

/**
 * The influence contract of a block: which parameters may influence which
 * observations, under every interpretation of the opaque operations (DUC Thm 4.5a /
 * may-influence). `matrix[i][j]` is true iff parameter i may-influence observation j.
 */
export interface DucInfluenceAttestation {
  readonly kind: "duc_influence";
  readonly version: typeof DUC_ATTESTATION_VERSION;
  readonly params: number;
  readonly obs: number;
  readonly matrix: readonly (readonly boolean[])[];
}

/** One witnessed high-to-low leak found by graph non-interference. */
export interface DucNiLeak {
  /** The ♦-symbol of the high source (or the source value name if unlabelled). */
  readonly highSource: string;
  /** Index into the graph's observations. */
  readonly obsIndex: number;
  /** Rendered provenance term at the leaking observation (human-readable). */
  readonly witness: string;
}

/**
 * Graph non-interference for a declared labeling. `holds` is true iff no high
 * source may-influence any low observation under every interpretation.
 */
export interface DucNiAttestation {
  readonly kind: "duc_ni";
  readonly version: typeof DUC_ATTESTATION_VERSION;
  readonly holds: boolean;
  readonly highSymbols: readonly string[];
  readonly leaks: readonly DucNiLeak[];
}

export type DucAttestation = DucInfluenceAttestation | DucNiAttestation;

/** The `duc_influence` attestation of a lifted graph (no labeling needed). */
export function influenceAttestation(graph: DucGraph): DucInfluenceAttestation {
  const boundary = boundaryType(graph);
  return {
    kind: "duc_influence",
    version: DUC_ATTESTATION_VERSION,
    params: boundary.params,
    obs: boundary.obs,
    matrix: paramSummaryMatrix(graph).map((row) => [...row]),
  };
}

/**
 * The `duc_ni` attestation of a lifted graph under a declared high-symbol set.
 * Every observation is treated as low. A source is high iff its ♦-symbol is in
 * `highSymbols`; every other source is low.
 */
export function niAttestation(graph: DucGraph, highSymbols: ReadonlySet<string>): DucNiAttestation {
  const lowObs = graph.obs;
  const labeling = labelBySymbol(graph, highSymbols, lowObs);
  const verdict = graphNI(graph, labeling);
  const nodes = nodeIndex(graph);
  const leaks: DucNiLeak[] = [];
  if (!verdict.holds) {
    for (const leak of verdict.leaks) {
      const node = nodes.get(leak.source);
      leaks.push({
        highSource: node?.diamond?.symbol ?? String(leak.sourceValue),
        obsIndex: graph.obs.indexOf(leak.obs),
        witness: renderWitness(leak.witness),
      });
    }
  }
  return {
    kind: "duc_ni",
    version: DUC_ATTESTATION_VERSION,
    holds: verdict.holds,
    highSymbols: [...highSymbols].sort(),
    leaks,
  };
}

/** Re-derive the structural invariants of an attestation. Returns the first violation, or null. */
export function validateDucAttestation(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const a = value as Record<string, unknown>;
  if (a.version !== DUC_ATTESTATION_VERSION) return `unsupported version ${String(a.version)}`;
  if (a.kind === "duc_influence") {
    const { params, obs, matrix } = a as Partial<DucInfluenceAttestation>;
    if (!Number.isInteger(params) || !Number.isInteger(obs)) return "params/obs must be integers";
    if (!Array.isArray(matrix) || matrix.length !== params) return "matrix row count != params";
    for (const row of matrix) {
      if (!Array.isArray(row) || row.length !== obs) return "matrix column count != obs";
      if (!row.every((x) => typeof x === "boolean")) return "matrix entries must be booleans";
    }
    return null;
  }
  if (a.kind === "duc_ni") {
    const { holds, leaks, highSymbols } = a as Partial<DucNiAttestation>;
    if (typeof holds !== "boolean") return "holds must be a boolean";
    if (!Array.isArray(leaks) || !Array.isArray(highSymbols))
      return "leaks/highSymbols must be arrays";
    if (holds && leaks.length > 0) return "holds=true but leaks is non-empty";
    if (!holds && leaks.length === 0) return "holds=false but no leak is witnessed";
    for (const leak of leaks) {
      if (!Number.isInteger(leak.obsIndex) || leak.obsIndex < 0)
        return "leak obsIndex out of range";
      if (typeof leak.witness !== "string" || leak.witness.length === 0)
        return "leak has no witness";
    }
    return null;
  }
  return `unknown attestation kind ${String(a.kind)}`;
}
