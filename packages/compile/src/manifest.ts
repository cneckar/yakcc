// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-MANIFEST-002: buildManifest derives verificationStatus from
// registry.getProvenance(merkleRoot) — "passing" if at least one ProvenanceTestEntry
// has passed === true, otherwise "unverified". Each ProvenanceEntry now records both
// block_merkle_root and spec_hash (required by WI-T04 EC item d).
// Status: implemented (WI-T04); supersedes DEC-COMPILE-MANIFEST-001 (ContractId-based,
// WI-005). The old ContractId-keyed manifest is deleted; no dual-authority coexistence
// (Sacred Practice #12).
// Rationale: The manifest is a read-only audit trail that names every block used
// in an assembly by its BlockMerkleRoot + SpecHash, records its impl source for
// inspection, and captures the verification state at assembly time. No author/
// signature/ownership fields are present (DEC-NO-OWNERSHIP-011).
//
// @decision DEC-COMPILE-MANIFEST-003 (WI-V2-04 L4): ProvenanceEntry.referencedForeign
// Status: decided (WI-V2-04 L4)
// Rationale: Each non-foreign block in the manifest records the foreign-dependency tree
// declared in block_foreign_refs via getForeignRefs(). Foreign blocks are opaque leaves
// and carry referencedForeign:[] (they do not nest). The field is required (not optional)
// so consumers can rely on structural completeness without null-checks. The format is
// "pkg#export" per the ForeignRefRow.foreignBlockRoot → BlockTripletRow lookup chain.
// Authority invariant L4-I1: ProvenanceEntry shape is owned by this file only.
// No other package re-declares ProvenanceEntry.

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
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
  /** The block's content address (BLAKE3(spec_hash || impl_hash || proof_root)). */
  readonly blockMerkleRoot: BlockMerkleRoot;
  /** The spec's content address (BLAKE3(canonicalize(spec.yak))). */
  readonly specHash: SpecHash;
  /** The block impl source text at assembly time. */
  readonly source: string;
  /** Direct sub-block dependencies (BlockMerkleRoots). */
  readonly subBlocks: ReadonlyArray<BlockMerkleRoot>;
  readonly verificationStatus: VerificationStatus;
  /**
   * The BlockMerkleRoot of the recursion-tree parent from which this block was
   * shaved. Present only when the registry row has a non-null parent_block_root.
   * Omitted (field absent) for root blocks — hand-authored seeds and shave's
   * top-level proposals. Population awaits WI-014-04 shave-persistence follow-up;
   * all current rows leave this field absent.
   */
  readonly recursionParent?: BlockMerkleRoot;
  /**
   * Foreign-dependency tree for this block. Each entry is "pkg#export" identifying
   * one foreign atom referenced by this block's impl/spec, in registry declaration_index
   * ASC order. Required field (never optional): [] for blocks with no foreign deps,
   * and for foreign blocks themselves (which are opaque leaves that do not nest).
   *
   * Authority invariant L4-I3: this field is required (not optional). [] is the
   * empty case. Legacy manifests written before L4 default to [] at read time.
   *
   * @decision DEC-COMPILE-MANIFEST-003
   */
  readonly referencedForeign: ReadonlyArray<string>;
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
  readonly entry: BlockMerkleRoot;
  readonly entries: ReadonlyArray<ProvenanceEntry>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a ProvenanceManifest from a ResolutionResult.
 *
 * For each resolved block, calls registry.getProvenance(merkleRoot) to determine
 * whether at least one test run has passed. If so, verificationStatus is "passing";
 * otherwise "unverified".
 *
 * Each entry records both blockMerkleRoot and specHash as required by the
 * WI-T04 Evaluation Contract (EC item d).
 *
 * The entries are ordered topologically (leaves first) following ResolutionResult.order.
 */
export async function buildManifest(
  resolution: ResolutionResult,
  registry: Registry,
): Promise<ProvenanceManifest> {
  const entries: ProvenanceEntry[] = [];

  for (const merkleRoot of resolution.order) {
    const block = resolution.blocks.get(merkleRoot);
    if (block === undefined) {
      // Should never happen: order is derived from blocks.
      throw new Error(`buildManifest: merkleRoot ${merkleRoot} in order but not in blocks map`);
    }

    const provenance = await registry.getProvenance(merkleRoot);
    const hasPassing = provenance.testHistory.some((entry) => entry.passed);
    const verificationStatus: VerificationStatus = hasPassing ? "passing" : "unverified";

    // Fetch the full block row to read parent_block_root and kind. The registry may
    // return null if the block has been evicted (should not happen in normal operation,
    // but we guard defensively). parentBlockRoot is omitted when null (field absent on
    // ProvenanceEntry) — only set when the registry row carries a non-null value.
    const blockRow = await registry.getBlock(merkleRoot);

    // Populate referencedForeign: foreign blocks are opaque leaves (referencedForeign:[]).
    // Non-foreign blocks look up block_foreign_refs via getForeignRefs() and format each
    // row as "pkg#export" by fetching the foreign block row for its foreignPkg/foreignExport.
    // Required field (L4-I3): [] is the empty case; never undefined.
    const referencedForeign: string[] = [];
    const isForeign = blockRow?.kind === "foreign";
    if (!isForeign) {
      const foreignRefs = await registry.getForeignRefs(merkleRoot);
      for (const ref of foreignRefs) {
        const foreignRow = await registry.getBlock(ref.foreignBlockRoot);
        if (foreignRow?.foreignPkg != null && foreignRow.foreignExport != null) {
          referencedForeign.push(`${foreignRow.foreignPkg}#${foreignRow.foreignExport}`);
        }
      }
    }

    const entry: ProvenanceEntry = {
      blockMerkleRoot: merkleRoot,
      specHash: block.specHash,
      source: block.source,
      subBlocks: block.subBlocks,
      verificationStatus,
      referencedForeign,
      ...(blockRow?.parentBlockRoot != null ? { recursionParent: blockRow.parentBlockRoot } : {}),
    };
    entries.push(entry);
  }

  return {
    entry: resolution.entry,
    entries,
  };
}
