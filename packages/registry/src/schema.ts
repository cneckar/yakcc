// @decision DEC-STORAGE-009: SQLite + sqlite-vec for registry storage.
// Status: decided (MASTER_PLAN.md DEC-STORAGE-009)
// Rationale: Single-file local store; vector index (vec0 virtual table) in the
// same DB; embeds cleanly into a CLI. Federation in v1 layers on top, not under.

// @decision DEC-NO-OWNERSHIP-011: No author, author_email, signature, or any
// ownership-shaped column in any table. This is a hard project invariant.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)

// @decision DEC-SCHEMA-VEC0-001: Use sqlite-vec vec0 virtual table for the
// vector index. Status: decided (WI-003)
// Rationale: vec0 supports arbitrary-length FLOAT vectors and KNN queries
// via "WHERE embedding MATCH ? AND k = N ORDER BY distance". It co-locates the
// vector index with the relational tables in one file, which is the v0 goal.

// @decision DEC-SCHEMA-MIGRATION-002: Migration 1→2 is a clean re-create.
// Status: decided (WI-T03, MASTER_PLAN.md DEC-TRIPLET-IDENTITY-020)
// Rationale: The seed corpus has not been published externally, so re-deriving
// BlockMerkleRoot is acceptable. The v0 `contracts` and `implementations` tables
// are dropped entirely; no transition view or dual-table coexistence is allowed
// (Sacred Practice #12, Evaluation Contract forbidden shortcuts).

/**
 * Current schema version. Increment by 1 whenever a migration is added.
 * The `schema_version` table stores the applied version; `applyMigrations`
 * no-ops when `currentVersion >= SCHEMA_VERSION`.
 */
export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Migration 0 → 1: initial schema (v0)
// ---------------------------------------------------------------------------

/**
 * SQL statements that constitute migration 1 (the initial v0 schema).
 * Applied on fresh DBs to bring them from version 0 to version 1.
 * On a DB that was already at v1, the `IF NOT EXISTS` guards are no-ops;
 * migration 2 then drops the v0 tables and replaces them.
 *
 * No ownership-shaped columns anywhere — DEC-NO-OWNERSHIP-011.
 */
const MIGRATION_1: readonly string[] = [
  // Version tracking table
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  )`,

  "INSERT OR IGNORE INTO schema_version(version) VALUES (0)",

  // ---------------------------------------------------------------------------
  // contracts — content-addressed contract storage (v0; dropped in migration 2)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS contracts (
    id              TEXT    PRIMARY KEY,
    canonical_bytes BLOB    NOT NULL,
    spec_json       TEXT    NOT NULL,
    created_at      INTEGER NOT NULL
  )`,

  // ---------------------------------------------------------------------------
  // implementations — basic blocks linked to a contract (v0; dropped in migration 2)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS implementations (
    id          TEXT    PRIMARY KEY,
    contract_id TEXT    NOT NULL REFERENCES contracts(id),
    source      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_implementations_contract_id
    ON implementations(contract_id)`,

  // ---------------------------------------------------------------------------
  // contract_embeddings — sqlite-vec virtual table (vec0) keyed on contract_id
  // Dropped and re-created in migration 2 keyed on spec_hash.
  // ---------------------------------------------------------------------------
  `CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
    contract_id TEXT PRIMARY KEY,
    embedding   FLOAT[384]
  )`,

  // ---------------------------------------------------------------------------
  // test_history — verification evidence per contract (v0 shape; updated in migration 2)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS test_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT    NOT NULL REFERENCES contracts(id),
    suite_id    TEXT    NOT NULL,
    passed      INTEGER NOT NULL CHECK(passed IN (0, 1)),
    at          INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_test_history_contract_id
    ON test_history(contract_id)`,

  // ---------------------------------------------------------------------------
  // runtime_exposure — provenance for runtime/production exposure (v0 shape)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS runtime_exposure (
    contract_id   TEXT    PRIMARY KEY REFERENCES contracts(id),
    requests_seen INTEGER NOT NULL DEFAULT 0,
    last_seen     INTEGER
  )`,

  // ---------------------------------------------------------------------------
  // strictness_edges — declared partial ordering (v0 shape; updated in migration 2)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS strictness_edges (
    stricter_id TEXT    NOT NULL REFERENCES contracts(id),
    looser_id   TEXT    NOT NULL REFERENCES contracts(id),
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (stricter_id, looser_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_strictness_edges_looser_id
    ON strictness_edges(looser_id)`,
];

// ---------------------------------------------------------------------------
// Migration 1 → 2: replace (contracts, implementations) with blocks
// ---------------------------------------------------------------------------

/**
 * SQL statements for migration 2.
 *
 * This is a clean re-create (DEC-SCHEMA-MIGRATION-002 / Sacred Practice #12):
 * - Drop the v0 `contracts`, `implementations`, and the v0-shaped tables that
 *   referenced them (`test_history`, `runtime_exposure`, `strictness_edges`).
 * - Drop and re-create `contract_embeddings` keyed on `spec_hash` instead of
 *   `contract_id` (two blocks sharing a spec share an embedding).
 * - Create the new `blocks` table keyed by `block_merkle_root`.
 * - Re-create the ancillary tables referencing `block_merkle_root`.
 *
 * Foreign-key enforcement is assumed to be enabled before this migration runs
 * (storage.ts enables it via `PRAGMA foreign_keys = ON`). HOWEVER: we must
 * disable FKs temporarily to drop tables in the correct order, because
 * `strictness_edges`, `test_history`, and `runtime_exposure` reference
 * `contracts` which we want to drop. We use `PRAGMA foreign_keys = OFF` and
 * restore it after so that the drop sequence is order-independent.
 *
 * Execution order:
 *   1. Disable FKs (for drop safety)
 *   2. Drop dependent v0 tables: strictness_edges, test_history, runtime_exposure
 *   3. Drop v0 embeddings virtual table
 *   4. Drop v0 implementations table + index
 *   5. Drop v0 contracts table
 *   6. Create new blocks table + spec_hash index
 *   7. Re-create contract_embeddings keyed on spec_hash
 *   8. Re-create test_history, runtime_exposure, strictness_edges on block_merkle_root
 *   9. Re-enable FKs
 */
const MIGRATION_2: readonly string[] = [
  // Step 1: disable FK enforcement for the drop sequence.
  "PRAGMA foreign_keys = OFF",

  // Step 2: drop ancillary v0 tables that reference contracts.
  "DROP TABLE IF EXISTS strictness_edges",
  "DROP INDEX IF EXISTS idx_strictness_edges_looser_id",
  "DROP TABLE IF EXISTS runtime_exposure",
  "DROP TABLE IF EXISTS test_history",
  "DROP INDEX IF EXISTS idx_test_history_contract_id",

  // Step 3: drop v0 embeddings virtual table.
  "DROP TABLE IF EXISTS contract_embeddings",

  // Step 4: drop v0 implementations table.
  "DROP INDEX IF EXISTS idx_implementations_contract_id",
  "DROP TABLE IF EXISTS implementations",

  // Step 5: drop v0 contracts table.
  "DROP TABLE IF EXISTS contracts",

  // Step 6: create new blocks table.
  // block_merkle_root: BLAKE3(spec_hash || impl_hash || proof_root) — hex, 64 chars.
  // spec_hash:         BLAKE3(canonicalize(spec.yak)) — hex, 64 chars, not unique.
  // spec_canonical_bytes: stored to avoid re-canonicalization on read.
  // impl_source:       impl.ts text.
  // proof_manifest_json: manifest.json serialized.
  // level:             L0/L1/L2/L3 per the block's declared verification level.
  // created_at:        Unix epoch milliseconds.
  // No ownership-shaped columns — DEC-NO-OWNERSHIP-011.
  `CREATE TABLE IF NOT EXISTS blocks (
    block_merkle_root    TEXT    PRIMARY KEY,
    spec_hash            TEXT    NOT NULL,
    spec_canonical_bytes BLOB    NOT NULL,
    impl_source          TEXT    NOT NULL,
    proof_manifest_json  TEXT    NOT NULL,
    level                TEXT    NOT NULL CHECK(level IN ('L0','L1','L2','L3')),
    created_at           INTEGER NOT NULL
  )`,

  "CREATE INDEX IF NOT EXISTS idx_blocks_spec_hash ON blocks(spec_hash)",

  // Step 7: re-create contract_embeddings keyed on spec_hash.
  // Two blocks with the same spec_hash share a spec, so they share an embedding.
  // Embedding dimensionality 384 matches Xenova/all-MiniLM-L6-v2 (DEC-EMBED-010).
  `CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
    spec_hash TEXT PRIMARY KEY,
    embedding FLOAT[384]
  )`,

  // Step 8: re-create ancillary tables referencing block_merkle_root.

  // test_history — verification evidence per block.
  // block_merkle_root: FK → blocks.block_merkle_root.
  `CREATE TABLE IF NOT EXISTS test_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    block_merkle_root TEXT    NOT NULL REFERENCES blocks(block_merkle_root),
    suite_id          TEXT    NOT NULL,
    passed            INTEGER NOT NULL CHECK(passed IN (0, 1)),
    at                INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_test_history_block_merkle_root
    ON test_history(block_merkle_root)`,

  // runtime_exposure — production usage counts per block.
  // block_merkle_root: FK → blocks.block_merkle_root.
  `CREATE TABLE IF NOT EXISTS runtime_exposure (
    block_merkle_root TEXT    PRIMARY KEY REFERENCES blocks(block_merkle_root),
    requests_seen     INTEGER NOT NULL DEFAULT 0,
    last_seen         INTEGER
  )`,

  // strictness_edges — declared partial ordering between block specs.
  // stricter/looser reference block_merkle_root values; the edge means
  // the block at stricter_root satisfies a strictly stronger spec than the
  // block at looser_root.
  `CREATE TABLE IF NOT EXISTS strictness_edges (
    stricter_root TEXT    NOT NULL REFERENCES blocks(block_merkle_root),
    looser_root   TEXT    NOT NULL REFERENCES blocks(block_merkle_root),
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (stricter_root, looser_root)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_strictness_edges_looser_root
    ON strictness_edges(looser_root)`,

  // Step 9: re-enable FK enforcement.
  "PRAGMA foreign_keys = ON",
];

// ---------------------------------------------------------------------------
// Migration driver
// ---------------------------------------------------------------------------

/**
 * Minimal interface for what applyMigrations needs from the DB.
 * Avoids importing better-sqlite3 types in this module; the storage layer
 * passes a concrete Database instance.
 */
export interface MigrationsDb {
  exec(sql: string): void;
  prepare(sql: string): {
    // better-sqlite3 Statement.get() always takes binding parameters
    // (zero or more), so the signature must accept rest args to remain
    // compatible with the concrete Statement<P, R> types the library returns.
    get(...params: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
}

/**
 * Apply all pending schema migrations up to `SCHEMA_VERSION`.
 *
 * Idempotent: calling this function on a DB that is already at `SCHEMA_VERSION`
 * is a no-op. Each migration is guarded by checking `currentVersion` before
 * applying, so partial re-runs from a crash are safe.
 *
 * Migration sequence:
 *   0 → 1: initial v0 schema (contracts, implementations, v0 ancillaries).
 *   1 → 2: clean re-create as blocks table (DEC-SCHEMA-MIGRATION-002).
 *
 * Idempotency design:
 *   Bootstrap step creates schema_version with no-op semantics if absent.
 *   Version is read once after bootstrap. Migrations are only applied when
 *   currentVersion < their target version. On a fully-migrated DB this means
 *   neither MIGRATION_1 nor MIGRATION_2 is re-run, so there is no risk of
 *   re-executing DDL that references tables already dropped by a later migration.
 *
 * @param db - An open SQLite database with the sqlite-vec extension loaded.
 */
export function applyMigrations(db: MigrationsDb): void {
  // Bootstrap: ensure schema_version table and initial row exist.
  // These two statements are safe to run on any DB state and are the only
  // unconditional DDL. We do NOT run the rest of MIGRATION_1 here.
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  db.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (0)");

  // Read the current version. If the DB is fresh, this returns 0.
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  // Migration 0 → 1: install the v0 schema (contracts, implementations, v0 ancillaries).
  // Only applied on a genuinely fresh DB (version 0).
  if (currentVersion < 1) {
    for (const sql of MIGRATION_1) {
      db.exec(sql);
    }
    db.prepare("UPDATE schema_version SET version = ?").run(1);
  }

  // Migration 1 → 2: drop v0 tables, create blocks table and new ancillaries.
  if (currentVersion < 2) {
    for (const sql of MIGRATION_2) {
      db.exec(sql);
    }
    db.prepare("UPDATE schema_version SET version = ?").run(2);
  }
  // Future migrations: add `if (currentVersion < 3) { ... }` blocks here.
}
