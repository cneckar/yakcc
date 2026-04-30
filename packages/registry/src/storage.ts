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

// @decision DEC-STORAGE-IDEMPOTENT-001: storeBlock() uses INSERT OR IGNORE for
// the blocks table to ensure idempotency on re-store of the same
// content-addressed block_merkle_root. The vector table uses DELETE+INSERT for
// the same reason (vec0 does not support INSERT OR IGNORE / ON CONFLICT).
// Status: decided (WI-T03, continuing DEC-STORAGE-IDEMPOTENT-001 from WI-003)
// Rationale: Block identity is content-addressed; the same block_merkle_root
// always means the same content. Idempotent store means callers never need to
// check for existence before storing.

// @decision DEC-SCHEMA-MIGRATION-002: WI-T03 clean re-create schema.
// Status: decided (MASTER_PLAN.md WI-T03 Evaluation Contract)
// Rationale: The v0 (contracts, implementations) two-table schema is replaced
// with a single `blocks` table keyed by block_merkle_root with a spec_hash
// index. No dual-table coexistence; no read-time fallback derivation of
// block_merkle_root (the column must be stored). See schema.ts for DDL.

import {
  type BlockMerkleRoot,
  type CanonicalAstHash,
  type EmbeddingProvider,
  type SpecHash,
  type SpecYak,
  canonicalAstHash,
  canonicalize,
  generateEmbedding,
} from "@yakcc/contracts";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { BlockTripletRow, Provenance, Registry } from "./index.js";
import { applyMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize a Float32Array to a Buffer for sqlite-vec storage. */
function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface BlockRow {
  block_merkle_root: string;
  spec_hash: string;
  spec_canonical_bytes: Buffer;
  impl_source: string;
  proof_manifest_json: string;
  level: string;
  created_at: number;
  canonical_ast_hash: string;
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
  stricter_root: string;
  looser_root: string;
}

// ---------------------------------------------------------------------------
// SQLite-backed Registry implementation (v0.6 triplet schema)
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
  // storeBlock
  // -------------------------------------------------------------------------

  async storeBlock(row: BlockTripletRow): Promise<void> {
    this.assertOpen();

    const now = row.createdAt > 0 ? row.createdAt : Date.now();

    // Parse the spec canonical bytes back to a SpecYak so we can generate an
    // embedding. The canonical bytes were produced by canonicalize(spec), so
    // we JSON-parse them (canonicalize produces UTF-8 JSON) to get the spec.
    // We need the spec text (its canonical JSON) for embedding generation.
    // The embedding provider accepts a text string derived from the spec.
    // We use the UTF-8 string of the canonical bytes as the embedding input,
    // consistent with the v0 approach (generateEmbedding expects a ContractSpec
    // but we pass the decoded canonical text as a surrogate spec string).
    const specText = Buffer.from(row.specCanonicalBytes).toString("utf-8");
    // Parse the canonical JSON to get the spec object for the embedding provider.
    const specObj = JSON.parse(specText) as SpecYak;
    const embedding = await generateEmbedding(
      specObj as unknown as Parameters<typeof generateEmbedding>[0],
      this.embeddings,
    );

    // Trust the canonicalAstHash already computed by the caller (e.g. makeBlockRow,
    // the seed package, and all future write paths). Callers are responsible for
    // computing canonicalAstHash once at row-construction time; the storage layer
    // accepts the value as-given rather than re-parsing implSource through ts-morph
    // on every write. The migration backfill path (see migrateAddCanonicalAstHash)
    // is the only code path that must compute the hash here because pre-WI-012-02
    // rows arrive without the field populated.
    const implAstHash = row.canonicalAstHash;

    const insertBlock = this.db.prepare<
      [string, string, Buffer, string, string, string, number, string]
    >(
      "INSERT OR IGNORE INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    // vec0 does not support INSERT OR IGNORE / ON CONFLICT, so use DELETE+INSERT
    // to make this idempotent (DEC-STORAGE-IDEMPOTENT-001).
    const deleteEmbedding = this.db.prepare<[string]>(
      "DELETE FROM contract_embeddings WHERE spec_hash = ?",
    );
    const insertEmbedding = this.db.prepare<[string, Buffer]>(
      "INSERT INTO contract_embeddings(spec_hash, embedding) VALUES (?, ?)",
    );

    const embeddingBuf = serializeEmbedding(embedding);

    const txn = this.db.transaction(() => {
      insertBlock.run(
        row.blockMerkleRoot,
        row.specHash,
        Buffer.from(row.specCanonicalBytes),
        row.implSource,
        row.proofManifestJson,
        row.level,
        now,
        implAstHash,
      );
      // Only write the embedding if the spec_hash doesn't already have one.
      // Check by attempting DELETE (no-op if absent) then INSERT.
      // This is safe for idempotent re-stores of the same spec_hash because
      // the embedding is deterministic for the same spec.
      deleteEmbedding.run(row.specHash);
      insertEmbedding.run(row.specHash, embeddingBuf);
    });

    txn();
  }

  // -------------------------------------------------------------------------
  // selectBlocks — return all BlockMerkleRoots for a given spec hash
  // -------------------------------------------------------------------------

  async selectBlocks(specHash: SpecHash): Promise<BlockMerkleRoot[]> {
    this.assertOpen();

    // Load all blocks for this spec_hash.
    const blockRows = this.db
      .prepare<[string], BlockRow>(
        "SELECT * FROM blocks WHERE spec_hash = ? ORDER BY created_at ASC",
      )
      .all(specHash);

    if (blockRows.length === 0) return [];

    // Load strictness edges for these blocks (by block_merkle_root).
    const roots = blockRows.map((r) => r.block_merkle_root);
    const placeholders = roots.map(() => "?").join(", ");
    const edgeRows = this.db
      .prepare<string[], StrictnessEdgeRow>(
        `SELECT stricter_root, looser_root FROM strictness_edges WHERE stricter_root IN (${placeholders}) OR looser_root IN (${placeholders})`,
      )
      .all(...roots, ...roots);

    // Load passing test counts for each block.
    const passingRunsMap = new Map<string, number>();
    for (const root of roots) {
      const row = this.db
        .prepare<[string], { passing: number }>(
          "SELECT COUNT(*) AS passing FROM test_history WHERE block_merkle_root = ? AND passed = 1",
        )
        .get(root);
      passingRunsMap.set(root, row?.passing ?? 0);
    }

    // Build edge set restricted to roots in the candidate set.
    const rootSet = new Set(roots);
    type EdgeKey = string;
    const edgeSet = new Set<EdgeKey>();
    for (const e of edgeRows) {
      if (
        rootSet.has(e.stricter_root) &&
        rootSet.has(e.looser_root) &&
        e.stricter_root !== e.looser_root
      ) {
        edgeSet.add(`${e.stricter_root}|${e.looser_root}`);
      }
    }

    // Sort by: (1) maximally-strict first, (2) non-functional quality of the
    // spec (parsed from canonical bytes), (3) passing test runs, (4) lex root.
    // For simplicity at v0.6 (all blocks for the same spec_hash share the same
    // spec, so NF tiebreak is the same for all siblings), we sort by:
    //   - strictness partial order (stricter first)
    //   - more passing test runs
    //   - lexicographically smaller block_merkle_root
    const sorted = [...blockRows].sort((a, b) => {
      // Strictness: if a is declared stricter than b, a comes first.
      const aStricterThanB = isStricterThan(
        a.block_merkle_root,
        b.block_merkle_root,
        edgeSet,
        roots,
      );
      const bStricterThanA = isStricterThan(
        b.block_merkle_root,
        a.block_merkle_root,
        edgeSet,
        roots,
      );
      if (aStricterThanB && !bStricterThanA) return -1;
      if (bStricterThanA && !aStricterThanB) return 1;

      // Passing test runs — more is better.
      const passingA = passingRunsMap.get(a.block_merkle_root) ?? 0;
      const passingB = passingRunsMap.get(b.block_merkle_root) ?? 0;
      if (passingA !== passingB) return passingB - passingA;

      // Lexicographic tiebreak — smaller root first.
      return a.block_merkle_root < b.block_merkle_root ? -1 : 1;
    });

    return sorted.map((r) => r.block_merkle_root as BlockMerkleRoot);
  }

  // -------------------------------------------------------------------------
  // getBlock — retrieve a full block row by BlockMerkleRoot
  // -------------------------------------------------------------------------

  async getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | null> {
    this.assertOpen();

    const row = this.db
      .prepare<[string], BlockRow>("SELECT * FROM blocks WHERE block_merkle_root = ?")
      .get(merkleRoot);

    if (row === undefined) return null;
    return hydrateBlock(row);
  }

  // -------------------------------------------------------------------------
  // findByCanonicalAstHash — look up blocks by impl canonical AST hash
  // -------------------------------------------------------------------------

  async findByCanonicalAstHash(hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    this.assertOpen();

    const rows = this.db
      .prepare<[string], { block_merkle_root: string }>(
        "SELECT block_merkle_root FROM blocks WHERE canonical_ast_hash = ? ORDER BY created_at ASC, block_merkle_root ASC",
      )
      .all(hash);

    return rows.map((r) => r.block_merkle_root as BlockMerkleRoot);
  }

  // -------------------------------------------------------------------------
  // getProvenance — test history + runtime exposure for a block
  // -------------------------------------------------------------------------

  async getProvenance(merkleRoot: BlockMerkleRoot): Promise<Provenance> {
    this.assertOpen();

    const testRows = this.db
      .prepare<[string], TestHistoryRow>(
        "SELECT suite_id, passed, at FROM test_history WHERE block_merkle_root = ? ORDER BY at ASC",
      )
      .all(merkleRoot);

    const exposureRow = this.db
      .prepare<[string], RuntimeExposureRow>(
        "SELECT requests_seen, last_seen FROM runtime_exposure WHERE block_merkle_root = ?",
      )
      .get(merkleRoot);

    const testHistory = testRows.map((r) => ({
      runAt: new Date(r.at).toISOString(),
      passed: r.passed === 1,
      caseCount: 0, // caseCount not persisted in v0.6 schema
    }));

    const runtimeExposure =
      exposureRow !== undefined && exposureRow.requests_seen > 0
        ? [
            {
              observedAt: new Date(exposureRow.last_seen ?? Date.now()).toISOString(),
              assembledInto: merkleRoot, // placeholder; real assembledInto tracked by compile
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
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level to avoid closure overhead in tight loops)
// ---------------------------------------------------------------------------

/**
 * Hydrate a DB row into a BlockTripletRow.
 */
function hydrateBlock(row: BlockRow): BlockTripletRow {
  return {
    blockMerkleRoot: row.block_merkle_root as BlockMerkleRoot,
    specHash: row.spec_hash as SpecHash,
    specCanonicalBytes: new Uint8Array(row.spec_canonical_bytes),
    implSource: row.impl_source,
    proofManifestJson: row.proof_manifest_json,
    level: row.level as "L0" | "L1" | "L2" | "L3",
    createdAt: row.created_at,
    canonicalAstHash: row.canonical_ast_hash as CanonicalAstHash,
  };
}

/**
 * Return true if `aRoot` is declared strictly stronger than `bRoot`
 * (directly or transitively) within the edge set.
 * Uses iterative BFS to avoid call-stack blowup on large graphs.
 */
function isStricterThan(
  aRoot: string,
  bRoot: string,
  edgeSet: ReadonlySet<string>,
  allRoots: readonly string[],
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [aRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const id of allRoots) {
      if (!visited.has(id) && edgeSet.has(`${current}|${id}`)) {
        if (id === bRoot) return true;
        queue.push(id);
      }
    }
  }
  return false;
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
  // applyMigrations handles DDL for all migrations including 2→3 (adds the
  // canonical_ast_hash column). The version-3 backfill and version bump are
  // performed here because this layer has access to canonicalAstHash() from
  // @yakcc/contracts (schema.ts is pure DDL and does not import it).
  applyMigrations(db);

  // Migration 2 → 3 backfill: compute and store canonical_ast_hash for any
  // existing rows that still have the empty-string sentinel value, then bump
  // schema_version to 3. On a fresh DB the SELECT returns no rows and the
  // version is bumped immediately. Idempotent: if already at version 3, skip.
  {
    const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    if ((vRow?.version ?? 0) < 3) {
      const rowsToBackfill = db
        .prepare<[], { block_merkle_root: string; impl_source: string }>(
          "SELECT block_merkle_root, impl_source FROM blocks WHERE canonical_ast_hash = ''",
        )
        .all();

      const updateHash = db.prepare<[string, string]>(
        "UPDATE blocks SET canonical_ast_hash = ? WHERE block_merkle_root = ?",
      );

      const backfillTxn = db.transaction(() => {
        for (const r of rowsToBackfill) {
          updateHash.run(canonicalAstHash(r.impl_source), r.block_merkle_root);
        }
        db.prepare("UPDATE schema_version SET version = ?").run(3);
      });
      backfillTxn();
    }
  }

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

// ---------------------------------------------------------------------------
// Internal re-export for schema inspection (tests only)
// ---------------------------------------------------------------------------

export { canonicalize };
