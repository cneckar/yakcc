// @decision DEC-COMPILE-MANIFEST-001: buildManifest derives verificationStatus from
// registry.getProvenance() — "passing" if at least one ProvenanceTestEntry has
// passed === true, otherwise "unverified".
// Status: implemented (WI-005)
// Rationale: The manifest is a read-only audit trail that names every block used
// in an assembly by its ContractId, records its source for inspection, and captures
// the verification state at assembly time. No author/signature/ownership fields
// are present (DEC-NO-OWNERSHIP-011).

import type { ContractId } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Whether this block's implementation has been verified against its contract. */
export type VerificationStatus = "passing" | "unverified";

/**
 * One entry in a provenance manifest, describing one block used in an assembly.
 *
 * No author, signature, or ownership fields — DEC-NO-OWNERSHIP-011.
 */
export interface ProvenanceEntry {
  readonly contractId: ContractId;
  /** The block source text at assembly time. */
  readonly source: string;
  /** Direct sub-block dependencies (ContractIds). */
  readonly subBlocks: ReadonlyArray<ContractId>;
  readonly verificationStatus: VerificationStatus;
}

/**
 * The complete provenance manifest for one assembly.
 *
 * `entries` is ordered topologically (leaves first, entry last), matching
 * ResolutionResult.order. Every block in the transitive closure appears exactly once.
 *
 * No author, signature, or ownership fields — DEC-NO-OWNERSHIP-011.
 */
export interface ProvenanceManifest {
  readonly entry: ContractId;
  readonly entries: ReadonlyArray<ProvenanceEntry>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a ProvenanceManifest from a ResolutionResult.
 *
 * For each resolved block, calls registry.getProvenance() to determine whether
 * at least one test run has passed. If so, verificationStatus is "passing";
 * otherwise "unverified".
 *
 * The entries are ordered topologically (leaves first) following ResolutionResult.order.
 */
export async function buildManifest(
  resolution: ResolutionResult,
  registry: Registry,
): Promise<ProvenanceManifest> {
  const entries: ProvenanceEntry[] = [];

  for (const contractId of resolution.order) {
    const block = resolution.blocks.get(contractId);
    if (block === undefined) {
      // Should never happen: order is derived from blocks.
      throw new Error(`buildManifest: contractId ${contractId} in order but not in blocks map`);
    }

    const provenance = await registry.getProvenance(contractId);
    const hasPassing = provenance.testHistory.some((entry) => entry.passed);
    const verificationStatus: VerificationStatus = hasPassing ? "passing" : "unverified";

    entries.push({
      contractId,
      source: block.source,
      subBlocks: block.subBlocks,
      verificationStatus,
    });
  }

  return {
    entry: resolution.entry,
    entries,
  };
}
