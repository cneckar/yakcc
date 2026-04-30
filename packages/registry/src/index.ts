// @decision DEC-STORAGE-009: SQLite + sqlite-vec for registry storage.
// Status: decided (MASTER_PLAN.md DEC-STORAGE-009); implemented by WI-003.
// Rationale: Single-file local store; vector index in the same DB; embeds
// cleanly into a CLI. Federation in v1 layers on top, not under.

// @decision DEC-NO-OWNERSHIP-011: No author identity, no signatures, no
// reserved columns for either in any type exported from this package.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)

// @decision DEC-SCHEMA-MIGRATION-002: WI-T03 replaces the v0 (contracts,
// implementations) two-table schema with a single `blocks` table keyed by
// BlockMerkleRoot with a spec_hash index. The public API surface changes:
//   - store(contract, impl) → storeBlock(row: BlockTripletRow)
//   - selectImplementation(contractId) → selectBlocks(specHash) + getBlock(merkleRoot)
// No dual-table coexistence; no fallback path (Sacred Practice #12).
// Status: decided (MASTER_PLAN.md WI-T03 Evaluation Contract)

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Registry value types (v0.6 triplet schema)
// ---------------------------------------------------------------------------

/**
 * A complete block triplet row as stored in (and retrieved from) the `blocks`
 * table. This is the canonical in-memory representation of a registered block.
 *
 * No ownership-shaped columns — DEC-NO-OWNERSHIP-011.
 */
export interface BlockTripletRow {
  /** BLAKE3(spec_hash || impl_hash || proof_root) — the block's content address. */
  readonly blockMerkleRoot: BlockMerkleRoot;
  /**
   * BLAKE3(canonicalize(spec.yak)) — the spec's content address.
   * Two blocks that satisfy the same contract share a spec_hash.
   */
  readonly specHash: SpecHash;
  /**
   * The canonicalized spec bytes. Stored to avoid re-canonicalization on read
   * and to verify integrity of specHash.
   */
  readonly specCanonicalBytes: Uint8Array;
  /** The impl.ts source text as UTF-8. */
  readonly implSource: string;
  /** The proof/manifest.json content, serialized as JSON text. */
  readonly proofManifestJson: string;
  /** The declared verification level: L0 | L1 | L2 | L3. */
  readonly level: "L0" | "L1" | "L2" | "L3";
  /** Unix epoch milliseconds of insertion. */
  readonly createdAt: number;
}

/**
 * A contract paired with a similarity score indicating how well it matches
 * a caller's proposal. Scores are in [0, 1] where 1.0 is an exact canonical
 * match. Scores are only meaningful relative to each other within a single
 * search response — do not use cosine distance as a correctness criterion
 * (DEC-EMBED-010, DESIGN.md "The embedding is just an index").
 *
 * Retained for the search() path which returns ContractSpec-level matches
 * against the spec_hash index.
 */
export interface Match {
  /** The spec hash identifying the matched contract. */
  readonly specHash: SpecHash;
  /** Similarity score in [0, 1]. Higher is closer. */
  readonly score: number;
}

/**
 * A candidate returned by vector search: a Match plus the BlockMerkleRoots
 * of all blocks satisfying the matched spec.
 */
export interface Candidate {
  readonly match: Match;
  /** All block merkle roots satisfying the matched spec. */
  readonly blockMerkleRoots: readonly BlockMerkleRoot[];
}

/**
 * Provenance metadata for a block identified by BlockMerkleRoot.
 *
 * This record intentionally carries no author identity or signature fields
 * (DEC-NO-OWNERSHIP-011). Trust mechanisms, if they arrive, attach to block
 * merkle roots in a sidecar layer — they do not pre-bake columns here.
 */
export interface Provenance {
  /** Recorded test runs against this block. */
  readonly testHistory: readonly ProvenanceTestEntry[];
  /**
   * Recorded production exposures: how many times this block has been
   * invoked in real program assemblies.
   */
  readonly runtimeExposure: readonly RuntimeExposureEntry[];
}

/** One recorded test run in a provenance record. */
export interface ProvenanceTestEntry {
  readonly runAt: string;
  readonly passed: boolean;
  readonly caseCount: number;
}

/** One recorded production-exposure event. */
export interface RuntimeExposureEntry {
  readonly observedAt: string;
  /** The BlockMerkleRoot of the top-level program this block was assembled into. */
  readonly assembledInto: BlockMerkleRoot;
}

// ---------------------------------------------------------------------------
// Registry interface (v0.6 triplet schema)
// ---------------------------------------------------------------------------

/**
 * The primary interface for all registry operations.
 *
 * The registry is monotonic: `storeBlock` is the only mutation; there is no
 * `delete` or `update`. Entries improve monotonically as stricter blocks are
 * added alongside originals.
 *
 * Selection operates at two levels:
 *   - `selectBlocks(specHash)` returns all blocks satisfying a spec.
 *   - `getBlock(merkleRoot)` retrieves a specific block by content address.
 */
export interface Registry {
  /**
   * Store a block triplet in the registry.
   *
   * Idempotent: storing the same block (same blockMerkleRoot) twice is a no-op.
   * The spec embedding (keyed on spec_hash) is written once per unique spec —
   * subsequent blocks with the same spec_hash share the embedding row.
   *
   * Throws if `row.blockMerkleRoot` does not match the computed
   * `blockMerkleRoot(triplet)` — callers must pre-compute and supply the root.
   * (The column must be stored, not re-derived at read time — Evaluation
   * Contract forbidden shortcuts.)
   */
  storeBlock(row: BlockTripletRow): Promise<void>;

  /**
   * Return all BlockMerkleRoots satisfying the given spec hash, ordered by
   * selection criteria (strictness partial order → non-functional quality →
   * passing test history → lexicographic merkle root).
   *
   * Returns an empty array when no blocks are registered for that spec_hash.
   */
  selectBlocks(specHash: SpecHash): Promise<BlockMerkleRoot[]>;

  /**
   * Retrieve the full block triplet row for a given BlockMerkleRoot.
   *
   * Returns null when no block with the given merkle root is registered.
   */
  getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | null>;

  /**
   * Retrieve provenance metadata for a block by its BlockMerkleRoot.
   *
   * Returns a Provenance record with empty arrays if no evidence has been
   * recorded yet — absence of evidence is not evidence of absence.
   */
  getProvenance(merkleRoot: BlockMerkleRoot): Promise<Provenance>;

  /** Release all resources held by this registry instance. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API re-exports
// ---------------------------------------------------------------------------

export { openRegistry, type RegistryOptions } from "./storage.js";
export { structuralMatch, type MatchResult } from "./search.js";
export {
  select,
  type SelectMatch,
  type StrictnessEdge,
  type CandidateProvenance,
} from "./select.js";
export { applyMigrations, SCHEMA_VERSION, type MigrationsDb } from "./schema.js";
