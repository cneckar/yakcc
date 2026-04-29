// @decision DEC-STORAGE-009: SQLite + sqlite-vec for registry storage.
// Status: decided (MASTER_PLAN.md DEC-STORAGE-009); implemented by WI-003.
// Rationale: Single-file local store; vector index in the same DB; embeds
// cleanly into a CLI. Federation in v1 layers on top, not under.

// @decision DEC-NO-OWNERSHIP-011: No author identity, no signatures, no
// reserved columns for either in any type exported from this package.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)

import type { Contract, ContractId, ContractSpec } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Registry value types
// ---------------------------------------------------------------------------

/**
 * A contract paired with a similarity score indicating how well it matches
 * a caller's proposal. Scores are in [0, 1] where 1.0 is an exact canonical
 * match. Scores are only meaningful relative to each other within a single
 * search response — do not use cosine distance as a correctness criterion
 * (DEC-EMBED-010, DESIGN.md "The embedding is just an index").
 */
export interface Match {
  readonly contract: Contract;
  /** Similarity score in [0, 1]. Higher is closer. */
  readonly score: number;
}

/**
 * A candidate returned by vector search: a Match plus the Implementation that
 * satisfies the matched contract.
 */
export interface Candidate {
  readonly match: Match;
  readonly implementation: Implementation;
}

/**
 * Provenance metadata for implementations registered under a given contract id.
 *
 * This record intentionally carries no author identity or signature fields
 * (DEC-NO-OWNERSHIP-011). Trust mechanisms, if they arrive, attach to contract
 * ids in a sidecar layer — they do not pre-bake columns here.
 */
export interface Provenance {
  /** Recorded test runs against implementations under this contract. */
  readonly testHistory: readonly ProvenanceTestEntry[];
  /**
   * Recorded production exposures: how many times this contract's
   * implementations have been invoked in real program assemblies.
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
  /** The ContractId of the top-level program this block was assembled into. */
  readonly assembledInto: ContractId;
}

/**
 * A basic block: the source text of one implementation plus its content-address
 * and the ContractId it satisfies.
 */
export interface Implementation {
  /** The strict-TS source text of the block. */
  readonly source: string;
  /**
   * Content-address of the implementation source. Distinct from ContractId:
   * two implementations can satisfy the same contract with different source,
   * producing the same contractId but different blockIds.
   *
   * Derived from BLAKE3-256 over the source bytes (DEC-HASH-WI002).
   */
  readonly blockId: string;
  /** The ContractId this implementation claims to satisfy. */
  readonly contractId: ContractId;
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

/**
 * The primary interface for all registry operations.
 *
 * Implementations of this interface are monotonic: `store` is the only
 * mutation; there is no `delete` or `update`. Entries improve monotonically
 * as stricter contracts or faster implementations are added alongside originals.
 */
export interface Registry {
  /**
   * Vector search: return up to `k` candidates whose contract embeddings are
   * nearest to the embedding of the given spec, filtered by structural match.
   *
   * The returned candidates are ordered by descending similarity score.
   * Callers must not treat similarity scores as correctness — they are an
   * associative-memory index, not a contract-match gate.
   */
  search(spec: ContractSpec, k: number): Promise<Candidate[]>;

  /**
   * Exact content-address lookup: return the contract whose id matches the
   * canonical hash of `spec`, or null if no such contract is stored.
   *
   * The match is determined by content-addressed identity (DEC-IDENTITY-005),
   * not by embedding similarity.
   */
  match(spec: ContractSpec): Promise<Match | null>;

  /**
   * Store a contract and its implementation.
   *
   * The registry is monotonic. Calling `store` with a contractId that already
   * exists registers a second implementation under the same contract (allowed),
   * but does not modify or remove existing entries.
   *
   * Idempotent: storing the same (contract, impl) pair twice is a no-op.
   */
  store(contract: Contract, impl: Implementation): Promise<void>;

  /**
   * Select the best match from a set of candidates.
   *
   * Selection prefers: (1) stricter contracts over looser ones per declared
   * strictness_edges, (2) better non-functional properties when strictness is
   * equal, (3) more passing test history, (4) lexicographically smaller id.
   * The total ordering is deterministic given the same input set.
   *
   * Precondition: `matches` must be non-empty.
   */
  select(matches: readonly Match[]): Match;

  /**
   * Retrieve provenance metadata for a contract id.
   *
   * Returns a Provenance record with empty arrays if no evidence has been
   * recorded yet — absence of evidence is not evidence of absence.
   */
  getProvenance(id: ContractId): Promise<Provenance>;

  /**
   * Direct lookup of a stored contract by its content-addressed id.
   *
   * Returns null when no contract with the given id is registered.
   * Added in WI-005 to support compile-engine composition-graph traversal,
   * which receives ContractIds from sub-block references and must resolve them
   * to their full Contract records (including ContractSpec) to traverse further.
   */
  getContract(id: ContractId): Promise<Contract | null>;

  /**
   * Retrieve the best implementation stored under a given contract id.
   *
   * When multiple implementations are registered for the same contract, returns
   * the one stored earliest (lowest created_at). Returns null when no
   * implementation is found.
   *
   * Added in WI-005 to support compile-engine composition-graph traversal:
   * the compiler resolves each block in topological order and needs the source
   * text for each block to compose the assembled module.
   */
  getImplementation(id: ContractId): Promise<Implementation | null>;

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
