// @decision DEC-STORAGE-LIBRARY-001: better-sqlite3 + sqlite-vec extension.
// Status: decided (WI-003)
// Rationale: better-sqlite3 is synchronous, has the best Node.js performance
// profile of any SQLite binding, and is widely used. sqlite-vec provides the
// vec0 virtual table that backs the vector index. Both are mature enough for
// the v0 local-only requirement. The sync API is fine for v0 (no concurrent
// writers; the registry is a CLI tool). Async wrappers are added at the
// Promise boundary to match the Registry interface.

// @decision DEC-STORAGE-FAIL-LOUD-001: No in-memory fallback on SQLite open
// failure. Status: decided (WI-003)
// Rationale: A silent fallback would mask DB errors and let callers believe
// they have a real registry when they don't. Fail loudly with a descriptive
// error so the operator knows immediately that the DB is unavailable.

// @decision DEC-STORAGE-IDEMPOTENT-001: store() uses INSERT OR IGNORE for
// contracts and implementations to ensure idempotency on re-store of the same
// content-addressed id. The vector table uses DELETE+INSERT for the same reason
// (vec0 does not support INSERT OR IGNORE / ON CONFLICT). Status: decided (WI-003)
// Rationale: Contract identity is content-addressed; the same id always means
// the same content. Idempotent store means callers never need to check for
// existence before storing.

import { blake3 } from "@noble/hashes/blake3.js";
import {
  type Contract,
  type ContractId,
  type ContractSpec,
  type EmbeddingProvider,
  canonicalize,
  contractId as deriveContractId,
  generateEmbedding,
} from "@yakcc/contracts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Candidate, Implementation, Match, Provenance, Registry } from "./index.js";
import { applyMigrations } from "./schema.js";
import { structuralMatch } from "./search.js";
import { type CandidateProvenance, type StrictnessEdge, select as selectImpl } from "./select.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to lowercase hex. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a content-address for an implementation's source text.
 * BLAKE3-256 over the UTF-8 bytes of the source.
 */
function implId(source: string): string {
  const bytes = new TextEncoder().encode(source);
  return bytesToHex(blake3(bytes));
}

/** Serialize a Float32Array to a Buffer for sqlite-vec storage. */
function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface ContractRow {
  id: string;
  canonical_bytes: Buffer;
  spec_json: string;
  created_at: number;
}

interface ImplRow {
  id: string;
  contract_id: string;
  source: string;
  created_at: number;
}

interface TestHistoryRow {
  suite_id: string;
  passed: number;
  at: number;
}

interface RuntimeExposureRow {
  requests_seen: number;
  last_seen: number | null;
}

interface StrictnessEdgeRow {
  stricter_id: string;
  looser_id: string;
}

// ---------------------------------------------------------------------------
// SQLite-backed Registry implementation
// ---------------------------------------------------------------------------

class SqliteRegistry implements Registry {
  private readonly db: Database.Database;
  private readonly embeddings: EmbeddingProvider;
  private closed = false;

  constructor(db: Database.Database, embeddings: EmbeddingProvider) {
    this.db = db;
    this.embeddings = embeddings;
  }

  // -------------------------------------------------------------------------
  // store
  // -------------------------------------------------------------------------

  async store(contract: Contract, impl: Implementation): Promise<void> {
    this.assertOpen();

    const canonicalBytes = canonicalize(contract.spec);
    const specJson = JSON.stringify(contract.spec);
    const now = Date.now();
    const embedding = await generateEmbedding(contract.spec, this.embeddings);

    // All three DB operations run in a single transaction for consistency.
    const insertContract = this.db.prepare<[string, Buffer, string, number]>(
      "INSERT OR IGNORE INTO contracts(id, canonical_bytes, spec_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertImpl = this.db.prepare<[string, string, string, number]>(
      "INSERT OR IGNORE INTO implementations(id, contract_id, source, created_at) VALUES (?, ?, ?, ?)",
    );
    // vec0 does not support INSERT OR IGNORE / ON CONFLICT, so we use
    // DELETE + INSERT to make this idempotent (DEC-STORAGE-IDEMPOTENT-001).
    const deleteEmbedding = this.db.prepare<[string]>(
      "DELETE FROM contract_embeddings WHERE contract_id = ?",
    );
    const insertEmbedding = this.db.prepare<[string, Buffer]>(
      "INSERT INTO contract_embeddings(contract_id, embedding) VALUES (?, ?)",
    );

    const implIdValue = impl.blockId !== "" ? impl.blockId : implId(impl.source);
    const embeddingBuf = serializeEmbedding(embedding);

    const txn = this.db.transaction(() => {
      insertContract.run(contract.id, Buffer.from(canonicalBytes), specJson, now);
      insertImpl.run(implIdValue, contract.id, impl.source, now);
      deleteEmbedding.run(contract.id);
      insertEmbedding.run(contract.id, embeddingBuf);
    });

    txn();
  }

  // -------------------------------------------------------------------------
  // match — exact content-address lookup
  // -------------------------------------------------------------------------

  async match(spec: ContractSpec): Promise<Match | null> {
    this.assertOpen();

    const id = deriveContractId(spec);
    const row = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE id = ?")
      .get(id);

    if (row === undefined) return null;

    const contract = this.hydrateContract(row);
    return { contract, score: 1.0 };
  }

  // -------------------------------------------------------------------------
  // search — vector k-NN followed by structural filter
  // -------------------------------------------------------------------------

  async search(spec: ContractSpec, k: number): Promise<Candidate[]> {
    this.assertOpen();

    if (k <= 0) return [];

    const embedding = await generateEmbedding(spec, this.embeddings);
    const embeddingBuf = serializeEmbedding(embedding);

    // vec0 KNN query: returns rows ordered by ascending distance.
    const vecRows = this.db
      .prepare<[Buffer, number], { contract_id: string; distance: number }>(
        "SELECT contract_id, distance FROM contract_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(embeddingBuf, k);

    if (vecRows.length === 0) return [];

    // Hydrate each candidate's contract row.
    const candidates: Candidate[] = [];
    for (const vecRow of vecRows) {
      const contractRow = this.db
        .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE id = ?")
        .get(vecRow.contract_id);

      if (contractRow === undefined) continue;

      const contract = this.hydrateContract(contractRow);

      // Structural filter: skip candidates that don't satisfy the spec.
      const result = structuralMatch(spec, contract.spec);
      if (!result.matches) continue;

      // score: convert distance to similarity in [0,1].
      // vec0 returns L2 distance; we convert to similarity = 1 / (1 + distance).
      const score = 1 / (1 + vecRow.distance);

      // Fetch one implementation for this contract.
      const implRow = this.db
        .prepare<[string], ImplRow>("SELECT * FROM implementations WHERE contract_id = ? LIMIT 1")
        .get(vecRow.contract_id);

      if (implRow === undefined) continue;

      const impl: Implementation = {
        source: implRow.source,
        blockId: implRow.id,
        contractId: implRow.contract_id as ContractId,
      };

      candidates.push({ match: { contract, score }, implementation: impl });
    }

    return candidates;
  }

  // -------------------------------------------------------------------------
  // select — delegates to the pure select() function in select.ts
  // -------------------------------------------------------------------------

  select(matches: readonly Match[]): Match {
    this.assertOpen();

    if (matches.length === 0) {
      throw new Error("Registry.select: matches array must be non-empty");
    }
    if (matches.length === 1) {
      const first = matches[0];
      if (first === undefined) throw new Error("Registry.select: undefined match");
      return first;
    }

    // Load strictness edges for the candidate set.
    const ids = matches.map((m) => m.contract.id);
    const placeholders = ids.map(() => "?").join(", ");
    const edgeRows = this.db
      .prepare<string[], StrictnessEdgeRow>(
        `SELECT stricter_id, looser_id FROM strictness_edges WHERE stricter_id IN (${placeholders}) OR looser_id IN (${placeholders})`,
      )
      .all(...ids, ...ids);

    const strictnessEdges: StrictnessEdge[] = edgeRows.map((r) => ({
      stricterId: r.stricter_id as ContractId,
      looserId: r.looser_id as ContractId,
    }));

    // Load passing test counts for each candidate.
    const provenance: CandidateProvenance[] = ids.map((id) => {
      const row = this.db
        .prepare<[string], { passing: number }>(
          "SELECT COUNT(*) AS passing FROM test_history WHERE contract_id = ? AND passed = 1",
        )
        .get(id);
      return {
        contractId: id,
        passingRuns: row?.passing ?? 0,
      };
    });

    const result = selectImpl(matches, strictnessEdges, provenance);
    if (result === null) {
      const first = matches[0];
      if (first === undefined) throw new Error("Registry.select: no result");
      return first;
    }
    // selectImpl returns SelectMatch (a structural subset of Match) but the
    // actual runtime value is one of the Match objects that were passed in —
    // it carries `evidence` at runtime even though SelectMatch doesn't declare it.
    // Cast through unknown to satisfy the narrower return type declaration.
    return result as unknown as Match;
  }

  // -------------------------------------------------------------------------
  // getContract — direct id lookup (added WI-005)
  // -------------------------------------------------------------------------

  async getContract(id: ContractId): Promise<Contract | null> {
    this.assertOpen();
    const row = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE id = ?")
      .get(id);
    if (row === undefined) return null;
    return this.hydrateContract(row);
  }

  // -------------------------------------------------------------------------
  // getImplementation — fetch source by contract id (added WI-005)
  // -------------------------------------------------------------------------

  async getImplementation(id: ContractId): Promise<Implementation | null> {
    this.assertOpen();
    const row = this.db
      .prepare<[string], ImplRow>(
        "SELECT * FROM implementations WHERE contract_id = ? ORDER BY created_at ASC LIMIT 1",
      )
      .get(id);
    if (row === undefined) return null;
    return {
      source: row.source,
      blockId: row.id,
      contractId: row.contract_id as ContractId,
    };
  }

  // -------------------------------------------------------------------------
  // getProvenance
  // -------------------------------------------------------------------------

  async getProvenance(id: ContractId): Promise<Provenance> {
    this.assertOpen();

    const testRows = this.db
      .prepare<[string], TestHistoryRow>(
        "SELECT suite_id, passed, at FROM test_history WHERE contract_id = ? ORDER BY at ASC",
      )
      .all(id);

    const exposureRow = this.db
      .prepare<[string], RuntimeExposureRow>(
        "SELECT requests_seen, last_seen FROM runtime_exposure WHERE contract_id = ?",
      )
      .get(id);

    const testHistory = testRows.map((r) => ({
      runAt: new Date(r.at).toISOString(),
      passed: r.passed === 1,
      caseCount: 0, // test_history schema stores suite_id/passed/at; caseCount not persisted in v0
    }));

    const runtimeExposure =
      exposureRow !== undefined && exposureRow.requests_seen > 0
        ? [
            {
              observedAt: new Date(exposureRow.last_seen ?? Date.now()).toISOString(),
              assembledInto: id, // placeholder: real assembledInto tracked by compile in WI-005
            },
          ]
        : [];

    return { testHistory, runtimeExposure };
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Registry has been closed");
    }
  }

  private hydrateContract(row: ContractRow): Contract {
    const spec = JSON.parse(row.spec_json) as ContractSpec;
    return {
      id: row.id as ContractId,
      spec,
      evidence: { testHistory: [] },
    };
  }
}

// ---------------------------------------------------------------------------
// Public constructor
// ---------------------------------------------------------------------------

/**
 * Options for opening a registry.
 */
export interface RegistryOptions {
  /**
   * Embedding provider to use. Defaults to the local transformers.js provider
   * (Xenova/all-MiniLM-L6-v2, 384 dimensions).
   */
  embeddings?: EmbeddingProvider | undefined;
}

/**
 * Open (or create) a Yakcc registry at the given filesystem path.
 *
 * Opens the SQLite database at `path`, loads the sqlite-vec extension, and
 * applies schema migrations. If the file does not exist, it is created.
 *
 * Pass `":memory:"` as `path` for an in-process database with no disk I/O
 * (useful for tests).
 *
 * Fails loudly if the database cannot be opened or the vec extension cannot
 * be loaded — no silent in-memory fallback (DEC-STORAGE-FAIL-LOUD-001).
 *
 * @param path    - Filesystem path to the registry database file, or ":memory:".
 * @param options - Optional configuration including embedding provider.
 */
export async function openRegistry(path: string, options?: RegistryOptions): Promise<Registry> {
  // Open the SQLite database. better-sqlite3 throws synchronously on failure.
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance.
  db.pragma("journal_mode = WAL");
  // Enable foreign key enforcement.
  db.pragma("foreign_keys = ON");

  // Load the sqlite-vec extension (throws if unavailable).
  sqliteVec.load(db);

  // Apply schema migrations (idempotent).
  applyMigrations(db);

  // Resolve the embedding provider: use provided, or import the local default.
  let embeddingProvider: EmbeddingProvider;
  if (options?.embeddings !== undefined) {
    embeddingProvider = options.embeddings;
  } else {
    const { createLocalEmbeddingProvider } = await import("@yakcc/contracts");
    embeddingProvider = createLocalEmbeddingProvider();
  }

  return new SqliteRegistry(db, embeddingProvider);
}
