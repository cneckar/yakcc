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

/**
 * Current schema version. Increment by 1 whenever a migration is added.
 * The `schema_version` table stores the applied version; `applyMigrations`
 * no-ops when `currentVersion >= SCHEMA_VERSION`.
 */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Migration 0 → 1: initial schema
// ---------------------------------------------------------------------------

/**
 * SQL statements that constitute migration 1 (the initial schema).
 *
 * Execution order matters: vec0 virtual table must be created after the
 * extension is loaded, and `strictness_edges` has FK references to `contracts`
 * so `contracts` must exist first.
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
  // contracts — content-addressed contract storage
  // ---------------------------------------------------------------------------
  // id:              BLAKE3-256 hex of canonicalized spec bytes (64 chars).
  // canonical_bytes: the canonicalized spec bytes — stored to avoid re-canonicalization.
  // spec_json:       structured spec as JSON text — stored for query convenience.
  // created_at:      Unix epoch milliseconds.
  `CREATE TABLE IF NOT EXISTS contracts (
    id              TEXT    PRIMARY KEY,
    canonical_bytes BLOB    NOT NULL,
    spec_json       TEXT    NOT NULL,
    created_at      INTEGER NOT NULL
  )`,

  // ---------------------------------------------------------------------------
  // implementations — basic blocks linked to a contract
  // ---------------------------------------------------------------------------
  // id:          content-address of the implementation source (BLAKE3 over source bytes).
  // contract_id: FK → contracts.id.
  // source:      the strict-TS-subset source text.
  // created_at:  Unix epoch milliseconds.
  `CREATE TABLE IF NOT EXISTS implementations (
    id          TEXT    PRIMARY KEY,
    contract_id TEXT    NOT NULL REFERENCES contracts(id),
    source      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_implementations_contract_id
    ON implementations(contract_id)`,

  // ---------------------------------------------------------------------------
  // contract_embeddings — sqlite-vec virtual table (vec0)
  // ---------------------------------------------------------------------------
  // Dimensionality is 384 to match Xenova/all-MiniLM-L6-v2 (DEC-EMBED-010).
  // contract_id: TEXT PRIMARY KEY links back to contracts.id.
  // embedding:   384-dim Float32 vector stored as sqlite-vec FLOAT[384].
  `CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
    contract_id TEXT PRIMARY KEY,
    embedding   FLOAT[384]
  )`,

  // ---------------------------------------------------------------------------
  // test_history — verification evidence per contract
  // ---------------------------------------------------------------------------
  // contract_id: FK → contracts.id.
  // suite_id:    opaque identifier for the test suite (e.g. property-test run id).
  // passed:      1 = all tests in the suite passed, 0 = at least one failed.
  // at:          Unix epoch milliseconds of the run.
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
  // runtime_exposure — provenance for runtime/production exposure
  // ---------------------------------------------------------------------------
  // contract_id:    FK → contracts.id.
  // requests_seen:  cumulative count of times this contract was resolved in assembly.
  // last_seen:      Unix epoch milliseconds of the most recent assembly request.
  `CREATE TABLE IF NOT EXISTS runtime_exposure (
    contract_id   TEXT    PRIMARY KEY REFERENCES contracts(id),
    requests_seen INTEGER NOT NULL DEFAULT 0,
    last_seen     INTEGER
  )`,

  // ---------------------------------------------------------------------------
  // strictness_edges — declared partial ordering
  // ---------------------------------------------------------------------------
  // stricter_id: FK → contracts.id. This contract is stricter than looser_id.
  // looser_id:   FK → contracts.id. This contract is less strict than stricter_id.
  // Structural sanity check (no self-edges) enforced at insert time in storage.ts.
  // created_at:  Unix epoch milliseconds.
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
 * is a no-op. Each migration checks the current `schema_version` row before
 * applying, so partial re-runs from a crash are safe.
 *
 * @param db - An open SQLite database with the sqlite-vec extension loaded.
 */
export function applyMigrations(db: MigrationsDb): void {
  // Apply statements from migration 1 unconditionally — all use IF NOT EXISTS.
  // Then stamp the version.
  for (const sql of MIGRATION_1) {
    db.exec(sql);
  }

  // Read the current version after applying the base DDL (schema_version now exists).
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }
  // Future migrations: add `if (currentVersion < 2) { ... }` blocks here.
}
