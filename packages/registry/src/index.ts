// @decision DEC-STORAGE-009: SQLite + sqlite-vec for registry storage.
// Status: decided (MASTER_PLAN.md); v0 facade uses in-memory map.
// Rationale: Single-file local store; vector index in the same DB; embeds
// cleanly into a CLI. Federation in v1 layers on top, not under.

// @decision DEC-NO-OWNERSHIP-011: No author identity, no signatures, no
// reserved columns for either in any type exported from this package.
// Status: decided (MASTER_PLAN.md)

import type {
  ContractId,
  ContractSpec,
  Contract,
} from "@yakcc/contracts";

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
   * v0 derives this from an FNV-1a hash of the source; WI-002 aligns this
   * with BLAKE3 alongside the contract hash upgrade.
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
   * nearest to the embedding of the given spec.
   *
   * The returned candidates are ordered by descending similarity score.
   * Callers must not treat similarity scores as correctness — they are an
   * associative-memory index, not a contract-match gate.
   *
   * WI-003: wired to sqlite-vec. v0 facade returns [].
   */
  search(spec: ContractSpec, k: number): Promise<Candidate[]>;

  /**
   * Structured contract match: return the best Match for the given spec,
   * or null if no conforming implementation exists.
   *
   * The match is determined by structured contract comparison (input/output
   * types, behavioral guarantees, error conditions, non-functional properties),
   * not by embedding similarity.
   *
   * WI-003: implemented. v0 facade returns null.
   */
  match(spec: ContractSpec): Promise<Match | null>;

  /**
   * Store a contract and its implementation.
   *
   * The registry is monotonic. Calling `store` with a contractId that already
   * exists registers a second implementation under the same contract (allowed),
   * but does not modify or remove existing entries.
   *
   * WI-003: persists to SQLite. v0 facade stores in memory.
   */
  store(contract: Contract, impl: Implementation): Promise<void>;

  /**
   * Select the best match from a set of candidates.
   *
   * Selection prefers: (1) stricter contracts over looser ones, (2) better
   * non-functional properties when strictness is equal. The total ordering is
   * deterministic given the same input set.
   *
   * WI-003: implements strictness-aware selection. v0 facade returns the first
   * element of the input array.
   *
   * Precondition: `matches` must be non-empty.
   */
  select(matches: readonly Match[]): Match;

  /**
   * Retrieve provenance metadata for a contract id.
   *
   * Returns a Provenance record with empty arrays if no evidence has been
   * recorded yet — absence of evidence is not evidence of absence.
   *
   * WI-003: reads from SQLite. v0 facade returns an empty provenance record.
   */
  getProvenance(id: ContractId): Promise<Provenance>;

  /** Release all resources held by this registry instance. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory facade implementation
// ---------------------------------------------------------------------------

// @decision DEC-REGISTRY-FACADE-V0: The v0 registry is an in-memory map that
// satisfies the Registry interface with stub returns for search/match/select.
// Status: provisional (WI-003 supersedes with SQLite backend)
// Rationale: Allows all packages that depend on Registry to be wired and
// typechecked before the SQLite dependency is locked. The interface contract
// is the deliverable; the backend is a WI-003 concern.

class InMemoryRegistry implements Registry {
  private readonly contracts = new Map<ContractId, Contract>();
  private readonly implementations = new Map<ContractId, Implementation[]>();
  private readonly provenance = new Map<ContractId, Provenance>();

  async search(_spec: ContractSpec, _k: number): Promise<Candidate[]> {
    // Facade: no vector index in v0. WI-003 wires sqlite-vec.
    return [];
  }

  async match(_spec: ContractSpec): Promise<Match | null> {
    // Facade: no structural matching in v0. WI-003 implements this.
    return null;
  }

  async store(contract: Contract, impl: Implementation): Promise<void> {
    this.contracts.set(contract.id, contract);
    const existing = this.implementations.get(contract.id) ?? [];
    existing.push(impl);
    this.implementations.set(contract.id, existing);
  }

  select(matches: readonly Match[]): Match {
    // Facade: return first element. WI-003 implements strictness-aware selection.
    // Precondition enforced: caller must not pass an empty array.
    const first = matches[0];
    if (first === undefined) {
      throw new Error(
        "Registry.select: matches array must be non-empty",
      );
    }
    return first;
  }

  async getProvenance(id: ContractId): Promise<Provenance> {
    return (
      this.provenance.get(id) ?? {
        testHistory: [],
        runtimeExposure: [],
      }
    );
  }

  async close(): Promise<void> {
    // In-memory; nothing to release.
  }
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/**
 * Open (or create) a Yakcc registry at the given filesystem path.
 *
 * v0: the path parameter is accepted but ignored; an in-memory registry is
 * returned. WI-003 opens or creates a SQLite database at the given path and
 * initializes the sqlite-vec extension.
 *
 * @param path - Filesystem path to the registry database file.
 */
export async function openRegistry(_path: string): Promise<Registry> {
  // Facade: ignore path, return in-memory instance.
  // WI-003 replaces this with a real SQLite + sqlite-vec open.
  return new InMemoryRegistry();
}
