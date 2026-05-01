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
export const SCHEMA_VERSION = 5;

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
// Migration 2 → 3: add canonical_ast_hash column + index
// ---------------------------------------------------------------------------

// @decision DEC-REGISTRY-AST-HASH-002: Add canonical_ast_hash to blocks table.
// Status: decided (WI-012-02)
// Rationale: The canonical AST hash allows deduplication and cross-spec reuse
// detection: two impls that are semantically equivalent under AST
// canonicalization share this hash even if their source text differs. Stored
// as a TEXT column (64 hex chars) with a non-unique index to support
// findByCanonicalAstHash lookups. Default '' on ADD COLUMN is required by
// SQLite (not null columns added via ALTER TABLE must have a default); the
// backfill walk then fills in the real values before bumping the version.
// The migration is idempotent: re-running on a v3 DB is a no-op.

/**
 * SQL statements for migration 3.
 *
 * Adds `canonical_ast_hash TEXT NOT NULL DEFAULT ''` to the `blocks` table
 * and creates a non-unique index on it.
 *
 * SQLite requires a default value for NOT NULL columns added via ALTER TABLE.
 * The empty string default is a sentinel; the backfill in `applyMigrations`
 * immediately walks every existing row and updates it with the real hash
 * before bumping schema_version to 3.
 *
 * On a fresh DB (no existing rows) the backfill walk is a no-op.
 */
const MIGRATION_3_DDL: readonly string[] = [
  `ALTER TABLE blocks ADD COLUMN canonical_ast_hash TEXT NOT NULL DEFAULT ''`,
  "CREATE INDEX IF NOT EXISTS idx_blocks_canonical_ast_hash ON blocks(canonical_ast_hash)",
];

// ---------------------------------------------------------------------------
// Migration 3 → 4: add parent_block_root column + index
// ---------------------------------------------------------------------------

// @decision DEC-REGISTRY-PARENT-BLOCK-004: Add parent_block_root to blocks table.
// Status: decided (WI-014-04)
// Rationale: Provenance manifest must surface parent-block lineage for atoms shaved
// from a recursion tree (v0.7 acceptance item (e)). The column is NULL for root
// blocks (hand-authored seeds, shave's top-level proposals) and non-NULL for
// atoms that were shaved from a parent block. Population (passing parent-block
// hashes through shave persistence) is a follow-up; for now the column always
// stores NULL. Indexed for O(log n) lineage walks.
// The migration is idempotent: a try/catch on the duplicate-column error handles
// partial-migration recovery (crash between ADD COLUMN and the version bump).

/**
 * SQL statements for migration 4.
 *
 * Adds `parent_block_root TEXT NULL` to the `blocks` table and creates a
 * non-unique index on it to support lineage walks.
 *
 * NULL means "this block is the root of its recursion tree" (e.g. hand-authored
 * seed blocks, or shave's top-level proposal). A non-NULL value is the
 * BlockMerkleRoot of the recursion-tree parent from which this atom was shaved.
 *
 * Unlike migration 3 (which requires a backfill via a business-logic function),
 * migration 4 is purely DDL — the column defaults to NULL for all existing rows,
 * which is the correct sentinel value. No backfill is needed, so `applyMigrations`
 * bumps `schema_version` to 4 directly (no two-phase split like migration 3).
 */
const MIGRATION_4_DDL: readonly string[] = [
  // parent_block_root: BlockMerkleRoot of the recursion-tree parent for shaved atoms.
  // NULL means "this is the root of its recursion tree" (e.g. hand-authored seed
  // blocks, or shave's top-level proposal). Indexed for quick lineage walks.
  "ALTER TABLE blocks ADD COLUMN parent_block_root TEXT NULL",
  "CREATE INDEX IF NOT EXISTS idx_blocks_parent_block_root ON blocks(parent_block_root)",
];

// ---------------------------------------------------------------------------
// Migration 4 → 5: add block_artifacts table (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002)
// ---------------------------------------------------------------------------

// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: Add block_artifacts table.
// Status: decided (MASTER_PLAN.md WI-022)
// Rationale: BlockTripletRow.artifacts closes the gap between the contracts
// blockMerkleRoot() formula (which has folded artifact bytes since v0.6) and
// the storage/shave persist path (which computed the formula with bytes but
// then dropped them). The table is keyed by (block_merkle_root, path) with a
// composite PRIMARY KEY, matching the manifest's declared path set.
// declaration_index preserves manifest order for deterministic Map hydration.
//
// Migration note: pre-WI-022 rows had their merkle root computed against
// whatever artifact bytes the persister had at write time. Back-deriving bytes
// for those rows risks producing a different Map and invalidating the stored
// root. The migration therefore backfills zero rows per pre-existing block
// (empty Map at hydrate time). Pre-WI-022 rows are NOT federation-eligible
// by construction (wire integrity gate will reject them); they are NOT
// corrupted in the local registry.
//
// Idempotency note: CREATE TABLE IF NOT EXISTS is used, so the migration is
// naturally idempotent — no try/catch needed for the CREATE TABLE statement
// itself. The version bump to 5 is the only state change that needs recovery
// semantics (a crash between the CREATE TABLE and the version bump leaves
// table present at version=4; re-entry runs CREATE TABLE IF NOT EXISTS as a
// no-op and bumps to 5 normally).

/**
 * SQL statements for migration 5.
 *
 * Creates the `block_artifacts` table that stores one row per artifact
 * entry of a block's proof manifest. Each row holds:
 *   - block_merkle_root: FK → blocks.block_merkle_root
 *   - path: the manifest-declared artifact path (e.g. "property_tests.ts")
 *   - bytes: the raw artifact bytes (BLOB)
 *   - declaration_index: position in manifest.artifacts array (0-based),
 *     used to reconstruct the Map in declaration order on hydration.
 *
 * Composite PRIMARY KEY (block_merkle_root, path) enforces uniqueness per
 * block+path combination and provides the idempotency guarantee for re-stores.
 *
 * No ownership-shaped columns — DEC-NO-OWNERSHIP-011.
 */
const MIGRATION_5_DDL: readonly string[] = [
  // block_artifacts: one row per artifact entry per block.
  // block_merkle_root: FK → blocks(block_merkle_root).
  // path: manifest-declared artifact path (e.g. "property_tests.ts").
  // bytes: raw artifact bytes, BLOB.
  // declaration_index: manifest.artifacts array position (0-based).
  // Composite PK enforces uniqueness; declaration_index enables ordered hydration.
  // No ownership columns — DEC-NO-OWNERSHIP-011.
  `CREATE TABLE IF NOT EXISTS block_artifacts (
    block_merkle_root TEXT    NOT NULL REFERENCES blocks(block_merkle_root),
    path              TEXT    NOT NULL,
    bytes             BLOB    NOT NULL,
    declaration_index INTEGER NOT NULL,
    PRIMARY KEY (block_merkle_root, path)
  )`,
  // Non-unique index on block_merkle_root for efficient artifact hydration
  // (ORDER BY declaration_index) when loading all artifacts for a given block.
  "CREATE INDEX IF NOT EXISTS idx_block_artifacts_block_merkle_root ON block_artifacts(block_merkle_root)",
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
 *   2 → 3: add canonical_ast_hash column + non-unique index (DEC-REGISTRY-AST-HASH-002).
 *   3 → 4: add parent_block_root column + non-unique index (DEC-REGISTRY-PARENT-BLOCK-004).
 *   4 → 5: add block_artifacts table + index (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
 *
 * TWO-PHASE INVARIANT FOR MIGRATION 2 → 3:
 *   `applyMigrations` (this function, in schema.ts) owns the DDL phase only:
 *   it adds the `canonical_ast_hash` column with default '' and creates the
 *   index. It does NOT bump `schema_version` to 3.
 *
 *   `openRegistry` in storage.ts owns the backfill + version-bump phase: after
 *   calling `applyMigrations`, it walks every row with `canonical_ast_hash = ''`
 *   and fills in the real hash via `canonicalAstHash(impl_source)` from
 *   `@yakcc/contracts`, then bumps `schema_version` to 3.
 *
 *   This split exists because schema.ts is pure DDL — it has no dependency on
 *   `@yakcc/contracts` and must remain free of business logic. Callers that
 *   invoke `applyMigrations` directly (without going through `openRegistry`)
 *   will therefore leave `schema_version` at 2, because the version bump
 *   requires `canonicalAstHash` which schema.ts does not import.
 *
 *   The try/catch on the duplicate-column error makes DDL re-entry safe
 *   regardless of caller path: if a crash occurs between the ADD COLUMN and the
 *   caller's version bump, the next open will see version=2 but the column
 *   already present. The catch absorbs that case and the backfill + bump
 *   complete normally.
 *
 *   Future migrations should follow the same two-phase pattern (DDL here,
 *   backfill + bump in storage.ts) OR import their backfill helpers into
 *   schema.ts to keep the invariant single-phase, whichever is appropriate for
 *   the migration's dependency footprint.
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

  // Migration 2 → 3: add canonical_ast_hash column + index (DEC-REGISTRY-AST-HASH-002).
  // The backfill of existing rows is performed by the caller (storage.ts openRegistry)
  // because it requires the canonicalAstHash function from @yakcc/contracts, which
  // this schema module does not import (schema.ts is pure DDL — no business logic).
  //
  // Idempotency note: SQLite has no ADD COLUMN IF NOT EXISTS. If a crash occurs
  // between the ADD COLUMN and the caller's schema_version bump (which happens
  // after the backfill), re-entry would see version=2 but the column already
  // present. We catch the "duplicate column name" error specifically to handle
  // this partial-migration recovery path. Any other DDL error is re-thrown.
  // MIGRATION_3_DDL[1] (CREATE INDEX IF NOT EXISTS) is already idempotent and
  // runs unconditionally within the if block.
  if (currentVersion < 3) {
    // Wrap the ALTER TABLE in a try/catch: ADD COLUMN is not idempotent in
    // SQLite, but a crash between this DDL and the version bump leaves us with
    // the column present at version=2. On re-entry we must not throw.
    try {
      db.exec(MIGRATION_3_DDL[0] as string); // ALTER TABLE ... ADD COLUMN canonical_ast_hash
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: canonical_ast_hash/i.test(msg)) {
        throw err;
      }
      // Column already exists (partial migration recovery) — continue normally.
    }
    // CREATE INDEX IF NOT EXISTS is already idempotent; always safe to re-run.
    db.exec(MIGRATION_3_DDL[1] as string);
    // NOTE: schema_version is bumped to 3 by the caller AFTER it performs the
    // backfill, not here. This lets openRegistry detect a partial migration
    // (version still 2, column now added) and complete the backfill safely.
    // On a fresh DB (version 0 → 3 path), currentVersion will be 0 here after
    // migrations 1 and 2 ran above, so we run the DDL but the caller still does
    // the backfill (which is a no-op on an empty table) and bumps to 3.
  }
  // Migration 3 → 4: add parent_block_root column + index (DEC-REGISTRY-PARENT-BLOCK-004).
  // Unlike migration 3, no backfill is needed: NULL is the correct default for all
  // existing rows (every pre-existing block is the root of its own recursion tree).
  // applyMigrations therefore bumps schema_version to 4 directly.
  //
  // Idempotency note: SQLite has no ADD COLUMN IF NOT EXISTS. If a crash occurs
  // between the ADD COLUMN and the version bump, re-entry sees version=3 but the
  // column already present. We catch the "duplicate column name" error specifically
  // to handle this partial-migration recovery path. Any other DDL error is re-thrown.
  // MIGRATION_4_DDL[1] (CREATE INDEX IF NOT EXISTS) is already idempotent.
  if (currentVersion < 4) {
    try {
      db.exec(MIGRATION_4_DDL[0] as string); // ALTER TABLE ... ADD COLUMN parent_block_root
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: parent_block_root/i.test(msg)) {
        throw err;
      }
      // Column already exists (partial migration recovery) — continue normally.
    }
    // CREATE INDEX IF NOT EXISTS is already idempotent; always safe to re-run.
    db.exec(MIGRATION_4_DDL[1] as string);
    // Bump version: no backfill required (NULL is the correct default).
    db.prepare("UPDATE schema_version SET version = ?").run(4);
  }

  // Migration 4 → 5: add block_artifacts table + index (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
  // CREATE TABLE IF NOT EXISTS is naturally idempotent — no try/catch needed for the DDL.
  // A crash between CREATE TABLE and the version bump leaves the table present at version=4;
  // re-entry runs CREATE TABLE IF NOT EXISTS as a no-op and bumps to 5 normally.
  // CREATE INDEX IF NOT EXISTS is always idempotent.
  //
  // No backfill: pre-WI-022 blocks get zero rows in block_artifacts (empty Map at hydrate
  // time). Back-deriving artifact bytes would invalidate pre-existing blockMerkleRoot values
  // (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 migration note — forbidden shortcut).
  if (currentVersion < 5) {
    db.exec(MIGRATION_5_DDL[0] as string); // CREATE TABLE IF NOT EXISTS block_artifacts
    db.exec(MIGRATION_5_DDL[1] as string); // CREATE INDEX IF NOT EXISTS idx_block_artifacts_*
    db.prepare("UPDATE schema_version SET version = ?").run(5);
  }
  // Future migrations: add `if (currentVersion < 6) { ... }` blocks here.
}
