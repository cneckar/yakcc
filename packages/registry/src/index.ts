// SPDX-License-Identifier: MIT
// @decision DEC-STORAGE-009: SQLite + sqlite-vec for registry storage.
// Status: decided (MASTER_PLAN.md DEC-STORAGE-009); implemented by WI-003.
// Rationale: Single-file local store; vector index in the same DB; embeds
// cleanly into a CLI. Federation in v1 layers on top, not under.

// @decision DEC-NO-OWNERSHIP-011: No author identity, no signatures, no
// reserved columns for either in any type exported from this package.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)

// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: BlockTripletRow.artifacts
// threads artifact bytes from buildTriplet through registry storage and onto
// the federation wire. The field is required (NOT optional) — a missing-field
// default would silently treat "no artifacts" the same as "never threaded
// artifacts through" (Sacred Practice #5). Keyed by manifest-declared path;
// no ownership columns (DEC-NO-OWNERSHIP-011). Pre-WI-022 rows backfill with
// empty Map; their pre-existing blockMerkleRoot values are not recomputed.
// Status: decided (MASTER_PLAN.md WI-022)

// @decision DEC-SCHEMA-MIGRATION-002: WI-T03 replaces the v0 (contracts,
// implementations) two-table schema with a single `blocks` table keyed by
// BlockMerkleRoot with a spec_hash index. The public API surface changes:
//   - store(contract, impl) → storeBlock(row: BlockTripletRow)
//   - selectImplementation(contractId) → selectBlocks(specHash) + getBlock(merkleRoot)
// No dual-table coexistence; no fallback path (Sacred Practice #12).
// Status: decided (MASTER_PLAN.md WI-T03 Evaluation Contract)

import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/contracts";

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
  /**
   * BLAKE3 hash of the canonical AST of impl.ts.
   * Two impls that are semantically identical under AST canonicalization share
   * this hash even if their source text differs. Used for deduplication and
   * cross-spec reuse detection. Populated by `canonicalAstHash(implSource)`.
   */
  readonly canonicalAstHash: CanonicalAstHash;
  /**
   * BlockMerkleRoot of the recursion-tree parent from which this block was shaved.
   * NULL (or omitted) means this block is the root of its recursion tree — e.g.
   * a hand-authored seed block or shave's top-level proposal.
   * Non-null values record lineage for atoms produced during a shave recursion.
   * Population of this field is deferred to shave persistence (WI-014-04 follow-up);
   * callers should default to null when constructing rows today.
   */
  readonly parentBlockRoot?: BlockMerkleRoot | null;
  /**
   * Artifact bytes keyed by manifest-declared path (same paths as
   * `manifest.artifacts[*].path`). This Map is the single source of truth for
   * the artifact bytes that fed into `blockMerkleRoot()` — it MUST be the exact
   * Map passed to `blockMerkleRoot({..., artifacts})` at row-construction time.
   *
   * Required (NOT optional). Callers that have no artifact bytes supply
   * `new Map()`. A missing field is a compile-time error — Sacred Practice #5.
   *
   * Pre-WI-022 rows that were persisted before this field existed hydrate with
   * `new Map()` (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 migration note).
   *
   * No ownership-shaped keys or values — DEC-NO-OWNERSHIP-011.
   */
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
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
// WI-V2-BOOTSTRAP-01: BootstrapManifestEntry — export-manifest primitive
// ---------------------------------------------------------------------------

/**
 * One entry per stored block, suitable for committed-artifact comparison.
 * Excludes timestamps and other non-deterministic columns (createdAt, ROWID).
 *
 * Used by `yakcc bootstrap --verify` (WI-V2-BOOTSTRAP-03) for byte-identity
 * gating: the caller serialises a `readonly BootstrapManifestEntry[]` (sorted
 * ascending by blockMerkleRoot) to JSON, commits the result as
 * `bootstrap/expected-roots.json`, and re-derives it on every CI run.
 *
 * @decision DEC-V2-BOOTSTRAP-MANIFEST-001
 * @title BootstrapManifestEntry excludes non-deterministic columns
 * @status accepted
 * @rationale createdAt and ROWID vary per-environment and per-run. Including
 *   them would make the committed artifact non-reproducible. The six fields
 *   below are all content-addressed (derived from artifact bytes via BLAKE3) —
 *   the same block stored on any machine at any time produces the same entry.
 *   This is the load-bearing determinism contract for the bootstrap demo.
 */
export interface BootstrapManifestEntry {
  /** Content address of the block triplet (BLAKE3 of spec||impl||proof). */
  readonly blockMerkleRoot: BlockMerkleRoot;
  /** Content address of the spec.yak (BLAKE3 of canonicalized spec bytes). */
  readonly specHash: SpecHash;
  /** String form of the canonical AST hash of impl.ts. */
  readonly canonicalAstHash: string;
  /** BlockMerkleRoot of the recursion-tree parent, or null for root blocks. */
  readonly parentBlockRoot: BlockMerkleRoot | null;
  /**
   * Hex BLAKE3-256 of the impl.ts artifact bytes (the raw bytes stored in
   * block_artifacts WHERE path = 'impl.ts'). Sentinel (BLAKE3 of empty
   * string) when the artifact is absent — see exportManifest() fallback note.
   */
  readonly implSourceHash: string;
  /**
   * Hex BLAKE3-256 of the proof/manifest.json artifact bytes (stored in
   * block_artifacts WHERE path = 'proof/manifest.json'). Sentinel when absent.
   */
  readonly manifestJsonHash: string;
}

// ---------------------------------------------------------------------------
// WI-025: Intent query shape + vector-search types (findCandidatesByIntent)
// ---------------------------------------------------------------------------

// @decision DEC-VECTOR-RETRIEVAL-004
// title: IntentQuery is a local structural type, not an import from @yakcc/shave
// status: accepted
// rationale: @yakcc/shave depends on @yakcc/registry, so importing IntentCard
//   from @yakcc/shave into @yakcc/registry would create a circular dependency.
//   IntentQuery is a structural subset of IntentCard (same field names and types
//   for the fields used by findCandidatesByIntent). Any IntentCard value is
//   assignable to IntentQuery without casting. The query method only needs
//   behavior, inputs[].{name,typeHint}, and outputs[].{name,typeHint} — the
//   remaining IntentCard fields (modelVersion, promptVersion, etc.) are
//   irrelevant to the KNN query. TypeScript's structural typing ensures
//   IntentCard values pass to findCandidatesByIntent without explicit conversion.

/** A named typed parameter used in an intent query (structural subset of IntentCard). */
export interface IntentQueryParam {
  readonly name: string;
  readonly typeHint: string;
}

/**
 * A minimal intent query shape for findCandidatesByIntent().
 *
 * Structurally compatible with @yakcc/shave's IntentCard — any IntentCard
 * is assignable here. @yakcc/registry intentionally does not import IntentCard
 * to avoid a circular dependency (DEC-VECTOR-RETRIEVAL-004).
 */
export interface IntentQuery {
  readonly behavior: string;
  readonly inputs: readonly IntentQueryParam[];
  readonly outputs: readonly IntentQueryParam[];
}

// ---------------------------------------------------------------------------
// WI-025: Vector-search result types
// ---------------------------------------------------------------------------

// @decision DEC-VECTOR-RETRIEVAL-002
// title: Query-text derivation rule for findCandidatesByIntent
// status: accepted
// rationale: The query text is constructed by joining the card's behavior string
//   with each input's "name: typeHint" and each output's "name: typeHint",
//   separated by newlines. This produces a text that captures the full functional
//   signature and behavioral intent in a format the embedding model understands.
//   The join mirrors what is embedded at write time (storeBlock generates embeddings
//   from the spec's behavior+parameter text), so query and document vectors are in
//   the same semantic space. Empty inputs/outputs are handled gracefully (the
//   behavior string alone is a valid query).

/**
 * A candidate block returned by findCandidatesByIntent().
 *
 * cosineDistance is the raw KNN distance from sqlite-vec (lower = more similar).
 * structuralScore is present only when rerank: "structural" was requested;
 * it is the structural match score used in the combined ranking formula.
 *
 * Do not use cosineDistance as a correctness criterion — it is a retrieval
 * index, not a behavioral proof (DEC-EMBED-010, DESIGN.md cornerstone #4).
 */
export interface CandidateMatch {
  /** The full block triplet row. */
  readonly block: BlockTripletRow;
  /**
   * Cosine distance from the query embedding to this block's spec embedding.
   * Lower values indicate greater semantic similarity.
   * Results are ordered ascending in cosineDistance by default.
   */
  readonly cosineDistance: number;
  /**
   * Combined structural match score. Present only when rerank: "structural"
   * was requested. Derived from structuralMatch(querySpec, candidateSpec).
   * 1.0 = exact structural match; 0.0 = no structural match.
   *
   * @decision DEC-VECTOR-RETRIEVAL-003
   * @title Structural rerank scoring formula
   * @status accepted
   * @rationale The combined ranking score is (1 - cosineDistance) + structuralScore,
   *   sorted descending. This additive formula gives equal weight to cosine similarity
   *   and structural match quality. structuralScore from structuralMatch is 0 or 1 at
   *   v0 (binary: matches or not). A multiplicative formula was rejected because it
   *   would zero-out structurally-unmatched results, collapsing them all to the same
   *   rank and making cosine order meaningless among mismatches.
   */
  readonly structuralScore?: number | undefined;
}

/**
 * Options for findCandidatesByIntent().
 */
export interface FindCandidatesOptions {
  /**
   * Maximum number of candidates to retrieve from the KNN index.
   * Defaults to 10.
   */
  readonly k?: number | undefined;
  /**
   * Reranking strategy. Defaults to "none" (cosine distance order only).
   * - "none": return KNN results ordered by ascending cosineDistance.
   * - "structural": reorder by combined (1 - cosineDistance) + structuralScore descending.
   */
  readonly rerank?: "structural" | "none" | undefined;
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
   * Return all BlockMerkleRoots whose impl source has the given canonical AST
   * hash, ordered by insertion order then lexicographic merkle root
   * (`ORDER BY created_at ASC, block_merkle_root ASC`).
   *
   * This is a structural-equivalence query, not a candidate-ranking query.
   * It returns every block that was compiled from a semantically identical
   * impl, regardless of which spec it satisfies. Because canonical-ast-hash
   * lookup crosses spec boundaries, the strictness partial order and
   * test-history ranking used by `selectBlocks` do not apply here — those
   * criteria are only meaningful within a single spec. Results are sorted by
   * insertion order then merkle root for stable, deterministic iteration;
   * callers seeking a ranked candidate for a specific spec should use
   * `selectBlocks` instead.
   *
   * Returns an empty array when no blocks match.
   */
  findByCanonicalAstHash(hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]>;

  /**
   * Retrieve provenance metadata for a block by its BlockMerkleRoot.
   *
   * Returns a Provenance record with empty arrays if no evidence has been
   * recorded yet — absence of evidence is not evidence of absence.
   */
  getProvenance(merkleRoot: BlockMerkleRoot): Promise<Provenance>;

  // @decision DEC-VECTOR-RETRIEVAL-001
  // title: Public vector-search surface on the Registry interface
  // status: accepted
  // rationale: WI-025 adds findCandidatesByIntent() as the first semantic
  //   (embedding-based) retrieval method. Prior retrieval was structural-only
  //   (selectBlocks by specHash). This new path derives a query text from an
  //   IntentCard, runs a sqlite-vec KNN query against contract_embeddings, and
  //   optionally reranks by combined cosine+structural score. The method lives
  //   on the Registry interface (not a standalone function) so it shares the
  //   same DB connection, embedding provider, and lifecycle as the rest of the
  //   registry. WI-026 (Claude Code hook interception) is the primary consumer.
  /**
   * Find candidate blocks semantically close to an intent card.
   *
   * Derives query text from the card (behavior + "name: typeHint" for each
   * input and output), generates an embedding, and runs a KNN query against
   * the contract_embeddings vec0 table. Optionally reranks by combined
   * cosine + structural score.
   *
   * Returns an empty array when the registry has no blocks.
   * Results are ordered by ascending cosineDistance by default.
   * When rerank: "structural" is requested, results are reordered by
   * (1 - cosineDistance) + structuralScore descending.
   *
   * @param intentCard - The caller's intent card (e.g. from staticExtract).
   * @param options    - Optional: k (default 10), rerank ("none" | "structural").
   */
  findCandidatesByIntent(
    intentCard: IntentQuery,
    options?: FindCandidatesOptions,
  ): Promise<readonly CandidateMatch[]>;

  /**
   * Return all distinct spec hashes present in the registry, sorted ascending
   * by spec_hash value.
   *
   * This is the server-side primitive for GET /v1/specs in the federation
   * serve path (FEDERATION_PROTOCOL.md §3, DEC-TRANSPORT-LIST-METHODS-020).
   *
   * Implemented as a single `SELECT DISTINCT spec_hash FROM blocks ORDER BY
   * spec_hash` query — O(n blocks) read, no mutations.
   *
   * Returns an empty array for an empty registry.
   *
   * @decision DEC-SERVE-SPECS-ENUMERATION-020 (closure note):
   * WI-026 adds this method to replace the optional `enumerateSpecs` callback
   * that serveRegistry previously accepted in ServeOptions. The callback was a
   * workaround because Registry had no enumerate-distinct-specs primitive.
   * Post-WI-026, serveRegistry consumes `registry.enumerateSpecs()` directly
   * and the ServeOptions.enumerateSpecs field is removed.
   *
   * No ownership-shaped fields — DEC-NO-OWNERSHIP-011. The query touches
   * `spec_hash` only; no JOIN against any owner-shaped column.
   */
  enumerateSpecs(): Promise<readonly SpecHash[]>;

  /**
   * Export a deterministic manifest of every stored block, sorted ascending by
   * `blockMerkleRoot` string value. The sort order is the load-bearing
   * determinism contract: two calls on the same DB state — on any machine at
   * any time — must produce byte-identical JSON when the result is serialized.
   *
   * Excludes `createdAt` and ROWID — both are non-deterministic across
   * environments and irrelevant to content identity (DEC-V2-BOOTSTRAP-MANIFEST-001).
   *
   * `implSourceHash` is BLAKE3-256(hex) of the bytes stored in `block_artifacts`
   * at path `impl.ts`. `manifestJsonHash` is BLAKE3-256(hex) of the bytes stored
   * at path `proof/manifest.json`. When either artifact path is absent (pre-WI-022
   * blocks, or blocks with no matching path), the sentinel value
   * (BLAKE3 of empty Uint8Array, hex-encoded) is used so the schema is uniform.
   *
   * Primary consumer: `yakcc bootstrap --verify` (WI-V2-BOOTSTRAP-03), which
   * re-derives this manifest and compares it byte-for-byte against the committed
   * `bootstrap/expected-roots.json` artifact.
   *
   * Returns an empty array for an empty registry.
   */
  exportManifest(): Promise<readonly BootstrapManifestEntry[]>;

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
