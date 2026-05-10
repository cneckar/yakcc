# DEC-V3-DISCOVERY-D6-001 — Migration and index-population strategy for v3 discovery

**Status:** Accepted (D6 design phase; implementation deferred to follow-up WIs)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/156
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D6 of 6)

---

## Context

D1 (`docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
multi-dimensional storage schema: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0` virtual table
(`contract_embeddings`), one per SpecYak semantic axis. D1 also established the migration
shape constraint: because `vec0` does NOT support `ALTER TABLE ADD COLUMN`, migration 7 must be a
clean re-create — drop + recreate + lazy-repopulate, mirroring migration 2's pattern. D6 is the
ADR that operationalizes that constraint into a concrete migration strategy.

**Current state of `contract_embeddings` (schema version 6):**

```sql
-- Declared in packages/registry/src/schema.ts MIGRATION_2, step 7 (~line 218):
CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
  spec_hash TEXT PRIMARY KEY,
  embedding FLOAT[384]
)
```

This single-vector representation is what D6 migrates to the 5-column v7 shape D1 specifies.

**Real-path anchors under HEAD `a3639a0`:**

- `SCHEMA_VERSION = 6` at `packages/registry/src/schema.ts` line 49 — the constant D6 bumps to 7.
- `applyMigrations(db: MigrationsDb)` at `packages/registry/src/schema.ts` line 550 — the
  function D6 extends with a `MIGRATION_7_DDL` const + `if (currentVersion < 7)` block.
- `storeBlock` embedding write at `packages/registry/src/storage.ts` lines 267–324: the
  `generateEmbedding` call appears at line 233, `DELETE FROM contract_embeddings` + `INSERT INTO
  contract_embeddings` at lines 269–273, wrapped in `db.transaction(...)` starting at line 289.
  Comment at line 267: "vec0 does not support INSERT OR IGNORE / ON CONFLICT, so use
  DELETE+INSERT to make this idempotent (DEC-STORAGE-IDEMPOTENT-001)."
- `EmbeddingProvider.embed(text: string): Promise<Float32Array>` at
  `packages/contracts/src/embeddings.ts` line 34 — single-string interface; no batch API.
- `createLocalEmbeddingProvider()` lazy singleton (closure pattern, `DEC-EMBED-SINGLETON-CLOSURE-001`)
  at `packages/contracts/src/embeddings.ts` lines 54–71: pipeline loaded once on first `embed()`
  call.
- `createOfflineEmbeddingProvider()` at `packages/contracts/src/embeddings.ts` line 151
  (`DEC-CI-OFFLINE-001`): deterministic BLAKE3-derived 384-dim vectors; no network I/O; used by CI.

**Architecture framing:** yakcc registries are embedded SQLite files owned by a single Node
process per developer. "Migration downtime" means: the first `openRegistry()` call after upgrading
runs `applyMigrations` synchronously before returning. There is no live-query interruption, no
network service to coordinate, and no concurrent multi-process upgrade to manage (SQLite file-level
locking serializes any edge-case concurrent opens).

---

## Boundary with sister ADRs (D1, D5)

| Concern | Owner | ADR |
|---|---|---|
| Target multi-dim schema shape (5 `FLOAT[384]` columns, absent-dimension zero-vector rule) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Migration shape constraint (`vec0` lacks `ALTER TABLE` → clean re-create only) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Schema-versioning *mechanism* (extend existing `SCHEMA_VERSION` / `schema_version` table) | **D6 (this ADR)** | — |
| Atomic vs incremental for v3.0 | **D6 (this ADR)** | — |
| Compute cost model + parallelism trigger | **D6 (this ADR)** | — |
| Idempotency contract (per-`spec_hash` skip, transaction wrap, crash recovery) | **D6 (this ADR)** | — |
| Migration verification gates (G1/G2/G3) | **D6 (this ADR)** | — |
| Future-migration protocol (codify existing `MIGRATION_N_DDL` pattern) | **D6 (this ADR)** | — |
| Post-migration measurement (hit-rate, recall, MRR, calibration) | D5 | `docs/adr/discovery-quality-measurement.md` |

**D1 → D6 handoff:** D1's pseudocode says "clean re-create: drop + recreate + lazy-repopulate."
D6 translates that into an operational protocol: the idempotency gates, the crash-recovery
introspection, the verification gates that run before the version bump, and the normative checklist
future migration authors follow. D6 elaborates D1's pseudocode into production-grade detail; D6
does NOT reopen the target schema shape (D1's authority).

**D6 → D5 handoff:** D6's G2 cardinality gate and G3 KNN reachability gate confirm the
post-migration registry is structurally queryable. D5's M1 hit-rate metric (`DEC-V3-DISCOVERY-D5-001`)
then measures whether the queryable registry actually returns the right atoms. D6's gates are
pass/fail inside the migration transaction; D5's harness is a separate test suite run on a
fully-migrated registry.

---

## Boundary with existing migration framework

`applyMigrations` in `packages/registry/src/schema.ts` (line 550) is the canonical and only
migration authority. It reads `schema_version.version` once, applies every pending `if
(currentVersion < N)` block in sequence, and is called by `openRegistry` in `storage.ts` before
the registry is returned to callers. Migration 3 established the two-phase pattern for migrations
that need a backfill touching business-logic packages: `schema.ts` does the pure DDL; `storage.ts
openRegistry` does the backfill + version bump after `applyMigrations` returns. Migration 7 follows
this exact pattern because repopulating `contract_embeddings` requires `generateMultiDimEmbedding`
from `@yakcc/contracts`, and `schema.ts` deliberately does not import any business-logic package.

**No parallel migration mechanism exists or will be created.** The directory
`packages/registry/migrations/` does not exist and will not be created by this ADR or its
implementation WIs (see "Alternatives considered" for the rationale).

---

## Decision

### Q1: Atomic vs incremental migration

**Decision:** Atomic clean re-create at v3.0 (the option the issue labels "(a)"). Re-evaluation
trigger is named explicitly.

**Why atomic is correct at v3.0:**

The "dual-write coexistence" and "discriminated-row incremental" options both fail at the
architectural level:

- Incremental dual-write keeps the old `embedding FLOAT[384]` path alive alongside the new 5-column
  path. Architecture Preservation explicitly forbids "keep the old path just in case." Dual-write
  across migrations is exactly that pattern — Sacred Practice #12 violation.
- Discriminated rows (atoms with `schema_version=1` use old queries; atoms with `schema_version=2`
  use new queries) break D3's combined-score ranking (`DEC-V3-DISCOVERY-D3-001`): the combined-
  score formula is not defined for a mix of single-vector and multi-vector row shapes. D1 chose
  clean re-create precisely to eliminate this schema-heterogeneity failure mode.
- D1 already chose clean re-create at the schema level. Choosing incremental at the data level
  would re-introduce a mismatch D1 already eliminated.

**Single-developer impact:** At current scale (~20 bundled seed atoms; 1,773 atoms reported in
the issue), the migration blocks one `openRegistry` call. Amortized over all subsequent opens
in the same process, the per-open cost is zero.

**Concrete cost table:**

| Corpus size | Per-atom cost (5 dims × ~10ms warm singleton) | Total wall-clock |
|---|---|---|
| 20 (bundled seeds) | ~50 ms | ~1 s |
| 1,773 (issue claim) | ~50 ms | ~90 s |
| 10,000 | ~50 ms | ~8.3 min |
| 100,000 | ~50 ms | ~83 min |

**Re-evaluation trigger (named):** When the production corpus exceeds **10,000 atoms** AND a
measured single-registry-open latency exceeds **5 seconds** for a fresh upgrade, file
`WI-V3-DISCOVERY-IMPL-INCREMENTAL-MIGRATION` to evaluate option (b) with concrete data. Do not
file it earlier.

---

### Q2: Schema versioning mechanism

**Decision:** Bump the existing `SCHEMA_VERSION` constant from `6` to `7`. Add `MIGRATION_7_DDL`
and an `if (currentVersion < 7)` block in `applyMigrations`. Use the existing `schema_version`
SQLite table. **No new column on `contract_embeddings`. No new `schema_metadata` table.**

**Why no per-embedding-row version column:**

The issue's hint about adding a `schema_version: int` column on `contract_embeddings` confuses
registry schema version (a global fact) with per-row dimension count (a data-presence fact).

- The registry-wide schema version is already canonical at `packages/registry/src/schema.ts`
  `SCHEMA_VERSION` (line 49) + the `schema_version` SQLite table. `SELECT version FROM
  schema_version LIMIT 1` answers "what version is this DB?" without any new surface.
- A per-row version column would be tautological at v3.0: every row is v7. It would also invite
  the mixed-version data model that D1's clean-re-create explicitly rejected.
- If a future v3.x migration needs to discriminate per-row (e.g. atoms with DEC-VERIFY-010
  behavioral embeddings vs not), the discriminant is a data-presence check (`NULL` vs non-`NULL`
  `behavioral_embedding` column), not a separate version stamp.

**Naming convention:** `MIGRATION_7_DDL` follows the existing naming, matching `MIGRATION_5_DDL`
and `MIGRATION_6_DDL`. The migration block follows the migration-3 two-phase pattern: DDL in
`applyMigrations` (without the version bump), backfill + `UPDATE schema_version SET version = 7`
in `storage.ts openRegistry`.

---

### Q3: Re-embedding compute cost (current + projected scale)

**Decision:** Serial re-embedding via the warm `transformers.js` singleton for v3.0. No
parallelism. Concrete trigger for introducing parallelism is named.

**Why no parallelism in v3.0:**

`EmbeddingProvider.embed()` at `packages/contracts/src/embeddings.ts` line 34 accepts a single
string. There is no `embedBatch()` API. The underlying `transformers.js` `pipeline()` callable
(loaded by `getPipeline()` closure at lines 54–71) is per-string forward-pass. Node worker pools
would require IPC for SQLite write coordination and double the model memory footprint (~25 MB per
worker). Neither is justified at current corpus scale.

**Cold-start note:** The first `embed()` call loads the ~25 MB ONNX model (~500 ms–1 s overhead,
one-time per process). Migration 7's repopulation walk pays this once and then runs all subsequent
embeddings into the warm singleton — the ~10 ms/embedding figure is the warm-singleton cost.

**CI behavior:** `createOfflineEmbeddingProvider()` (line 151, `DEC-CI-OFFLINE-001`) produces
deterministic BLAKE3-derived 384-dim vectors with no network I/O. CI migration tests run with the
offline provider, so they will not surface real wall-clock cost. Production wall-clock measurement
must come from a developer-machine dry run with the local provider.

**v3.x parallelism trigger:** When the production corpus exceeds **10,000 atoms** AND the
migration-time wall-clock exceeds **10 minutes** measured on a 4-core developer laptop, file
`WI-V3-DISCOVERY-IMPL-EMBED-BATCH` to:
1. Extend `EmbeddingProvider` with an optional `embedBatch(texts: string[]): Promise<Float32Array[]>`
   method.
2. Thread the batch API through migration 7's repopulation walk.
3. Measure wall-clock speedup against the serial baseline before landing.

Do not file it earlier.

---

### Q4: Idempotency contract

**Decision:** Pre-condition gate + per-`spec_hash` skip + atomic version bump. No
`migration_progress` table. Wrapping transaction. Crash-safe via `sqlite_master` introspection.

**Idempotency rules (operational):**

1. **Pre-condition gate:** `applyMigrations` enters the `if (currentVersion < 7)` block only when
   `schema_version.version < 7`. After the version bump completes, re-running is a no-op for the
   migration block.

2. **Per-`spec_hash` skip during repopulation:** The repopulation walk (in `storage.ts openRegistry`
   after `applyMigrations`) iterates `SELECT spec_hash, spec_canonical_bytes FROM blocks` and for
   each `spec_hash` checks whether `SELECT 1 FROM contract_embeddings WHERE spec_hash = ? AND
   embedding_behavior IS NOT NULL` returns a row. If present with a non-NULL primary dimension,
   skip — the `spec_hash` has already been migrated. Otherwise compute the 5 multi-dim embeddings
   and write via DELETE+INSERT, mirroring `DEC-STORAGE-IDEMPOTENT-001`.

3. **Crash-safety contract:** If the process crashes after the DDL (`DROP TABLE IF EXISTS` +
   `CREATE VIRTUAL TABLE`) but before the version bump, the next `openRegistry` call re-enters the
   `if (currentVersion < 7)` block. Re-executing `DROP TABLE IF EXISTS contract_embeddings` would
   destroy any partially-repopulated v7 data. To prevent this, the DDL section MUST first
   introspect `sqlite_master`:

   ```sql
   SELECT sql FROM sqlite_master
   WHERE type = 'table' AND name = 'contract_embeddings'
   ```

   If the returned DDL contains `embedding_behavior` (the primary v7 column), the table is
   already at the v7 shape — skip the drop+recreate and proceed directly to the repopulation walk
   (which the per-`spec_hash` skip makes safe to resume). If the DDL does not contain
   `embedding_behavior`, the table is still at the v6 shape — proceed with the clean drop+recreate.
   This mirrors migration 3's explicit partial-migration recovery pattern
   (`packages/registry/src/schema.ts` lines 592–613).

4. **Atomic version bump:** `UPDATE schema_version SET version = 7` runs after the repopulation
   walk completes and after G1/G2/G3 verification gates pass (see Q5), in `storage.ts openRegistry`.
   A crash between repopulation and the version bump is recoverable: next open finds `version = 6`
   but a v7-shaped table; the schema-shape check in rule 3 lets the walk-and-skip resume cleanly
   from where it left off.

5. **Wrapping transaction:** The repopulation walk runs inside a single `db.transaction(...)` block
   (mirroring `storeBlock`'s pattern at `storage.ts` line 289). This ensures that either all atoms
   are repopulated and the version bumps, or the transaction rolls back entirely and the v6 → v7
   transition is retried on the next open.

**Why no `migration_progress` table:**

Per-row state (a non-NULL `embedding_behavior` value in the v7-shaped `contract_embeddings`)
already answers "has this `spec_hash` been migrated?" A separate `migration_progress` table would
duplicate state already encoded in the data — Sacred Practice #12 violation. A separate table
would itself require migration 8 to add and remove; migrations should not need migrations.

---

### Q5: Data integrity verification gates

**Decision:** Block-on-failure verification, three explicit gates, run inside the migration
transaction after the repopulation walk and before `UPDATE schema_version SET version = 7`. The
old single-vector `embedding FLOAT[384]` column is NOT preserved. Deprecation/keep-for-N-releases
fallback is REJECTED.

**Verification gates:**

| Gate | Assertion | Failure mode |
|---|---|---|
| **G1: Schema shape** | `SELECT sql FROM sqlite_master WHERE name = 'contract_embeddings'` contains all 5 column names: `embedding_behavior`, `embedding_guarantees`, `embedding_error_conditions`, `embedding_non_functional`, `embedding_property_tests`. | Throw `MigrationVerificationError` — DDL did not produce the expected v7 shape. Transaction rolls back. Operator must investigate `sqlite_master` before retrying. |
| **G2: Cardinality** | `SELECT COUNT(DISTINCT spec_hash) FROM blocks` equals `SELECT COUNT(*) FROM contract_embeddings`. (Distinct because two blocks can share a `spec_hash` → share embeddings; each unique `spec_hash` must have exactly one embedding row.) | Throw `MigrationVerificationError` — repopulation walk skipped or duplicated rows. Transaction rolls back. |
| **G3: Reachability** | For one canary `spec_hash` (the lex-smallest `block_merkle_root`'s `spec_hash`), run a `vec0` KNN query against the `embedding_behavior` column with the same atom's behavior text and assert the canary appears in the top-K (K = 5). | Throw `MigrationVerificationError` — `vec0` index did not absorb the writes. Transaction rolls back. |

**Why block-on-failure (not warn-and-continue):**

The migration is short (~90 s at current scale). A silently-corrupted post-migration registry
produces wrong query results permanently until the user manually re-runs the migration — far worse
than a noisy abort the operator notices immediately. Architecture Preservation: "loud failure over
silent fallback."

**When operator intervention is required:** If G1 fires, the `contract_embeddings` DDL did not
match the expected v7 shape. This can happen if an operator manually altered the table or if a
custom migration ran out of order. The operator must restore from a backup or accept running the
full repopulation again (the source data in `blocks.spec_canonical_bytes` is always preserved).
If G2 fires, examine the `blocks` table for rows with `spec_hash` values that have no corresponding
embedding row; the repopulation walk likely hit an unhandled error mid-stride. If G3 fires, check
whether the installed `sqlite-vec` extension version supports multi-column `FLOAT[384]`
declarations (per D1's requirement that `WI-V3-DISCOVERY-IMPL-INDEX` verify this before
finalizing the DDL).

**Why no preserved old single-vector column:**

D1's Q4 chose clean drop+recreate. Preserving `embedding FLOAT[384]` would require the v7 DDL to
read `vec0(spec_hash TEXT PRIMARY KEY, embedding FLOAT[384], embedding_behavior FLOAT[384], ...)`,
contradicting D1. Keeping the old column means D2/D3's query path must decide which column is "the
embedding" — exactly the parallel-mechanism failure mode Architecture Preservation forbids. Rollback
from v7 to v6 is a separate operation (a hypothetical migration 7-to-6, not in scope) that would
re-create the single-column shape and repopulate with the v6 `generateEmbedding` function. This
rollback path is NOT shipped with v3.0; there is no projected operational reason to need it given
that the source data in `blocks.spec_canonical_bytes` is always preserved.

**Feed to D5:** G2 and G3 confirm the registry is structurally queryable. D5's M1 hit-rate
(`DEC-V3-DISCOVERY-D5-001`) measures whether a queryable registry returns the right atoms. D5's
harness should add a sanity pre-check that each seed-block `spec_hash` is present in
`contract_embeddings` after migration; this is separate from D6's gates (which run inside the
migration transaction) but depends on D6's design enabling the expected shape.

---

### Q6: Future-migration protocol

**Decision:** The existing `MIGRATION_N_DDL` + `if (currentVersion < N)` pattern is the protocol.
Codify it explicitly. No file-per-migration directory. No auto-discovery glob. A normative
checklist for future migration authors follows.

**Normative checklist for migration N (where N > 7):**

1. **Bump `SCHEMA_VERSION`** at `packages/registry/src/schema.ts` line 49 by exactly 1 (from
   `N-1` to `N`). The comment on this constant states "L2-I2 invariant: this constant must equal
   the highest `MIGRATION_N_DDL` number."

2. **Add `MIGRATION_N_DDL: readonly string[]`** const above `applyMigrations`. Include a comment
   block above the const that cites the `DEC-` ID and the rationale for this migration. Follow
   the established naming: `MIGRATION_7_DDL`, `MIGRATION_8_DDL`, etc.

3. **Add an `if (currentVersion < N)` block** in `applyMigrations` in sequence after the
   `if (currentVersion < N-1)` block. The block executes the DDL statements.

4. **For migrations with no backfill or business-logic dependency** (e.g. `CREATE TABLE IF NOT
   EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with `NULL` default):
   `applyMigrations` bumps `schema_version` to `N` within the block itself. Natural idempotency
   applies for `CREATE ... IF NOT EXISTS`. Use the `try/catch` duplicate-column-name pattern
   (established by migrations 3, 4, 6) for `ALTER TABLE ADD COLUMN` statements.

5. **For migrations needing a backfill that depends on `@yakcc/contracts` or any other
   business-logic package:** use the two-phase pattern established by migration 3 (documented at
   `packages/registry/src/schema.ts` lines 580–613). Put pure DDL in `applyMigrations` (without the
   version bump); put the backfill + `UPDATE schema_version SET version = ?` in the appropriate
   `storage.ts` function (typically `openRegistry`). This preserves `schema.ts`'s invariant: pure
   DDL, no business logic, no `@yakcc/contracts` import.

6. **For vec0 virtual table shape changes** (the migration-7 case and any future case):
   introspect the existing DDL via `sqlite_master` before dropping. Drop only if the existing DDL
   does not already contain the new shape's distinguishing column. This is the crash-safe pattern
   defined in Q4 rule 3.

7. **Idempotency strategy (decision tree):**
   - DDL with `IF NOT EXISTS` clauses → naturally idempotent; no special handling.
   - `ALTER TABLE ADD COLUMN` → try/catch on "duplicate column name"; re-throw all other errors.
   - `DROP TABLE` or `DROP VIRTUAL TABLE` + recreate → introspect `sqlite_master` upfront; skip
     drop+recreate if already at the new shape.

8. **Migration unit-test coverage requirement:** Each migration block MUST be covered by a vitest
   test that:
   - Opens an empty SQLite DB.
   - Manually inserts state representing the `(N-1)` version (inserts into `schema_version` and
     into any tables the migration modifies).
   - Calls `applyMigrations`.
   - Asserts the resulting schema shape AND the data present.

   Tests live colocated with `schema.ts` (e.g. `packages/registry/src/schema.test.ts` or a new
   `packages/registry/src/migration-N.test.ts`). This requirement applies to migration 7 onward;
   D6 does not retrofit tests for migrations 3–6, but every migration from 7 onward includes
   the test as part of its Evaluation Contract.

9. **Decision-log requirement:** Each migration's `DEC-` ID must be appended to `MASTER_PLAN.md`
   Decision Log with the migration number, the schema delta, and the rationale. D6 sets the
   precedent: `DEC-V3-DISCOVERY-D6-001` names migration 7.

**When to revisit the file-per-migration pattern:**

When the migration count exceeds **15** AND `applyMigrations` becomes hard to read (subjective:
> 1,000 lines or > 10 distinct two-phase patterns), file `WI-REGISTRY-MIGRATION-FRAMEWORK-EXTRACT`
to evaluate a file-per-migration shape with a deterministic ordered loader. Not before.

---

## Migration 7 pseudocode

This pseudocode is prescriptive but not source. The actual TypeScript lands in the
`WI-V3-DISCOVERY-IMPL-INDEX` implementer worktree under that WI's scope manifest.

### schema.ts — add `MIGRATION_7_DDL` and extend `applyMigrations`

```typescript
// packages/registry/src/schema.ts
// (before applyMigrations)

// @decision DEC-V3-DISCOVERY-D6-001: Migration 6 → 7: clean re-create of
// contract_embeddings as a 5-column vec0 virtual table.
// Status: decided (docs/adr/discovery-migration.md)
// Rationale: vec0 lacks ALTER TABLE ADD COLUMN; clean re-create is the only
// safe path (per DEC-V3-DISCOVERY-D1-001 Q4). Backfill runs in openRegistry
// (storage.ts) because it requires @yakcc/contracts generateMultiDimEmbedding.
// SCHEMA_VERSION bump (6→7) happens in storage.ts after repopulation + gates pass.
const MIGRATION_7_DDL: readonly string[] = [
  "PRAGMA foreign_keys = OFF",
  "DROP TABLE IF EXISTS contract_embeddings",
  `CREATE VIRTUAL TABLE contract_embeddings USING vec0(
    spec_hash TEXT PRIMARY KEY,
    embedding_behavior         FLOAT[384],
    embedding_guarantees       FLOAT[384],
    embedding_error_conditions FLOAT[384],
    embedding_non_functional   FLOAT[384],
    embedding_property_tests   FLOAT[384]
  )`,
  "PRAGMA foreign_keys = ON",
];

// In applyMigrations, after the if (currentVersion < 6) block:

// Migration 6 → 7: clean re-create of contract_embeddings as 5-column vec0.
// Two-phase: DDL here (pure schema); backfill + version bump in storage.ts openRegistry.
// Crash safety: introspect sqlite_master before dropping to handle the case where
// a prior run completed the DDL but crashed before the version bump.
if (currentVersion < 7) {
  const existingDDL = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contract_embeddings'")
    .get() as { sql: string } | undefined;

  if (existingDDL?.sql?.includes("embedding_behavior")) {
    // Table is already at v7 shape (crash recovery path). Skip drop+recreate.
    // The backfill walk in openRegistry will resume from where it left off,
    // using the per-spec_hash skip to avoid reprocessing completed rows.
  } else {
    // Table is at v6 shape (or absent). Proceed with clean drop+recreate.
    for (const sql of MIGRATION_7_DDL) {
      db.exec(sql);
    }
  }
  // NOTE: schema_version is NOT bumped to 7 here. That happens in storage.ts
  // openRegistry after the repopulation walk and G1/G2/G3 gates pass.
}
```

### storage.ts — add repopulation walk + verification gates in `openRegistry`

```typescript
// packages/registry/src/storage.ts  (in openRegistry, after applyMigrations(db))

const version = (
  db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined
)?.version ?? 0;

if (version < 7) {
  // Migration 7 repopulation walk.
  // Uses the warm singleton embedder (DEC-EMBED-SINGLETON-CLOSURE-001).
  const allBlocks = db
    .prepare("SELECT spec_hash, spec_canonical_bytes FROM blocks")
    .all() as Array<{ spec_hash: string; spec_canonical_bytes: Buffer }>;

  const repopulate = db.transaction(() => {
    for (const block of allBlocks) {
      // Per-spec_hash idempotency skip: if embedding_behavior is already non-NULL,
      // this spec_hash was already migrated (possibly in a prior interrupted run).
      const alreadyMigrated = db
        .prepare(
          "SELECT 1 FROM contract_embeddings WHERE spec_hash = ? AND embedding_behavior IS NOT NULL"
        )
        .get(block.spec_hash);
      if (alreadyMigrated) continue;

      // Compute 5 multi-dim embeddings via @yakcc/contracts generateMultiDimEmbedding.
      const spec = JSON.parse(block.spec_canonical_bytes.toString("utf-8")) as SpecYak;
      const embeddings = await generateMultiDimEmbedding(spec, embeddingProvider);

      // DELETE+INSERT mirrors DEC-STORAGE-IDEMPOTENT-001 (vec0 no-ON-CONFLICT).
      db.prepare("DELETE FROM contract_embeddings WHERE spec_hash = ?").run(block.spec_hash);
      db.prepare(
        "INSERT INTO contract_embeddings(spec_hash, embedding_behavior, embedding_guarantees, embedding_error_conditions, embedding_non_functional, embedding_property_tests) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        block.spec_hash,
        serializeEmbedding(embeddings.behavior),
        serializeEmbedding(embeddings.guarantees),
        serializeEmbedding(embeddings.errorConditions),
        serializeEmbedding(embeddings.nonFunctional),
        serializeEmbedding(embeddings.propertyTests),
      );
    }

    // --- G1: Schema shape gate ---
    const ddlRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'contract_embeddings'")
      .get() as { sql: string } | undefined;
    const requiredColumns = [
      "embedding_behavior", "embedding_guarantees", "embedding_error_conditions",
      "embedding_non_functional", "embedding_property_tests"
    ];
    for (const col of requiredColumns) {
      if (!ddlRow?.sql?.includes(col)) {
        throw new MigrationVerificationError(
          `G1 schema shape: contract_embeddings DDL missing column '${col}'`
        );
      }
    }

    // --- G2: Cardinality gate ---
    const blockCount = (
      db.prepare("SELECT COUNT(DISTINCT spec_hash) AS n FROM blocks").get() as { n: number }
    ).n;
    const embeddingCount = (
      db.prepare("SELECT COUNT(*) AS n FROM contract_embeddings").get() as { n: number }
    ).n;
    if (blockCount !== embeddingCount) {
      throw new MigrationVerificationError(
        `G2 cardinality: blocks has ${blockCount} distinct spec_hash values but contract_embeddings has ${embeddingCount} rows`
      );
    }

    // --- G3: KNN reachability gate ---
    // Use the lex-smallest block_merkle_root as canary.
    const canary = db
      .prepare("SELECT spec_hash FROM blocks ORDER BY block_merkle_root ASC LIMIT 1")
      .get() as { spec_hash: string } | undefined;
    if (canary) {
      const canaryBlock = db
        .prepare("SELECT spec_canonical_bytes FROM blocks WHERE spec_hash = ? LIMIT 1")
        .get(canary.spec_hash) as { spec_canonical_bytes: Buffer } | undefined;
      if (canaryBlock) {
        const canarySpec = JSON.parse(canaryBlock.spec_canonical_bytes.toString("utf-8")) as SpecYak;
        const behaviorText = canarySpec.intentCard?.behavior ?? "";
        if (behaviorText) {
          const canaryVec = await embeddingProvider.embed(behaviorText);
          const knnResults = db
            .prepare(
              "SELECT spec_hash FROM contract_embeddings WHERE embedding_behavior MATCH ? AND k = 5 ORDER BY distance"
            )
            .all(Buffer.from(canaryVec.buffer)) as Array<{ spec_hash: string }>;
          const found = knnResults.some((r) => r.spec_hash === canary.spec_hash);
          if (!found) {
            throw new MigrationVerificationError(
              `G3 reachability: canary spec_hash '${canary.spec_hash}' not in top-5 KNN results for embedding_behavior`
            );
          }
        }
      }
    }

    // All gates passed. Bump schema version.
    db.prepare("UPDATE schema_version SET version = ?").run(7);
  });

  repopulate();
}
```

---

## Alternatives considered

| Alternative | Status | Rejection rationale |
|---|---|---|
| Incremental dual-write (option (b)) | Rejected | Architecture Preservation explicitly forbids "keep the old path just in case." Dual-write across migrations is exactly that pattern — Sacred Practice #12. D1 chose clean re-create at the schema level; choosing incremental at the data level would re-introduce the mismatch D1 eliminated. |
| Discriminated rows by `schema_version` column on `contract_embeddings` | Rejected | D3's combined-score formula (`DEC-V3-DISCOVERY-D3-001`) is not defined for a mix of single-vector and multi-vector row shapes. D1 eliminated this failure mode by choosing clean re-create. |
| `packages/registry/migrations/<from>-to-<to>.ts` file-per-migration directory | Rejected | No such directory exists in the codebase. The existing `applyMigrations` + `MIGRATION_N_DDL` in-file pattern is the migration authority. Introducing a file-per-migration directory now would require: (a) splitting the existing 6 migrations into 6 files, (b) building an auto-discovery loader, (c) updating CI assumptions — none of which D6 owns. It would create a parallel migration mechanism, violating Architecture Preservation. The "when to revisit" trigger is migration count > 15 with the function growing unreadably. |
| `migration_progress` table for crash recovery | Rejected | Per-row state (non-NULL `embedding_behavior` in the v7-shaped table) already encodes "has this `spec_hash` been migrated?" A separate table duplicates that state (Sacred Practice #12). A `migration_progress` table would itself need a migration (8?) to add and clean up; migrations should not need migrations. |
| Preserve the old `embedding FLOAT[384]` column for one release cycle | Rejected | D1's Q4 chose clean drop+recreate. Preserving the old column requires the v7 DDL to carry `embedding FLOAT[384]` alongside the 5 new columns, contradicting D1. The old column would be a parallel authority for the v6 query path while the new columns serve the v7 path — exactly the two-active-authorities failure mode Architecture Preservation forbids. Source data is preserved in `blocks.spec_canonical_bytes`, making re-derivation always possible if needed. |
| Warn-and-continue verification gates | Rejected | Architecture Preservation: "loud failure over silent fallback." A silently-corrupted post-migration registry produces wrong query results permanently. The migration is short enough that aborting and re-running is preferable to silent corruption. |
| Node worker pools for parallel embedding | Rejected for v3.0 | The `EmbeddingProvider.embed()` interface accepts one string. No `embedBatch()` API exists. Worker pools would double the model memory footprint (~25 MB per worker) and require IPC for SQLite write coordination. Not justified at current corpus scale; named trigger is 10,000 atoms + > 10 min wall-clock. |

---

## When to revisit

| Trigger | Action |
|---|---|
| Production corpus > 10,000 atoms AND single `openRegistry` upgrade latency > 5 s | File `WI-V3-DISCOVERY-IMPL-INCREMENTAL-MIGRATION` to evaluate incremental (option (b)) with concrete data. |
| Production corpus > 10,000 atoms AND migration wall-clock > 10 min on a 4-core laptop | File `WI-V3-DISCOVERY-IMPL-EMBED-BATCH` to add `embedBatch()` to `EmbeddingProvider` and thread it through the repopulation walk. |
| Migration count exceeds 15 AND `applyMigrations` exceeds ~1,000 lines or > 10 two-phase patterns | File `WI-REGISTRY-MIGRATION-FRAMEWORK-EXTRACT` to evaluate file-per-migration with deterministic loader. |
| G3 KNN gate fires in production (not test) after a successful `sqlite-vec` upgrade | Check whether a `sqlite-vec` version bump changed the `FLOAT[N]` multi-column encoding; re-verify per D1's requirement. |
| Any G1/G2/G3 gate fires in CI (offline provider) | Investigate immediately — gates are provider-agnostic (G1 is DDL shape, G2 is cardinality, G3 uses the offline provider's deterministic vectors). |

---

## Implementation phase boundary

D6 commits the design only. No source files are modified by this ADR. All TypeScript lands in
the named implementation WIs under their own scope manifests.

**Follow-up WIs (all deferred; D6 ADR is their shared specification):**

1. **`WI-V3-DISCOVERY-IMPL-INDEX`** — Author migration 7 in `packages/registry/src/schema.ts`
   (`MIGRATION_7_DDL` + `if (currentVersion < 7)` block in `applyMigrations`). Must first verify
   multi-column `FLOAT[384]` support in the installed `sqlite-vec` version (per D1). Owner of
   D6's pseudocode → real TypeScript. Migration vitest coverage required per Q6 checklist step 8.

2. **`WI-V3-DISCOVERY-IMPL-EMBEDDINGS`** — Extend `packages/contracts/src/embeddings.ts` with
   `generateMultiDimEmbedding(spec: SpecYak, provider: EmbeddingProvider): Promise<MultiDimEmbedding>`
   (5 named dimension slots, each `Float32Array | null`).

3. **`WI-V3-DISCOVERY-IMPL-STORAGE`** — Update `storeBlock` in `packages/registry/src/storage.ts`
   to call `generateMultiDimEmbedding` and write all 5 embedding columns; update
   `generateEmbedding` call (line 233) and the DELETE+INSERT embedding path (lines 269–273 within
   the `db.transaction` starting at line 289).

4. **`WI-V3-DISCOVERY-IMPL-MIGRATION-VERIFY`** (new, proposed by this ADR) — Implement the
   `MigrationVerificationError` exception type; implement G1/G2/G3 verification gates as
   standalone functions testable without running a full migration; add unit tests for each gate's
   failure path (G1 missing column, G2 cardinality mismatch, G3 KNN not found).

---

## References

- Issue #156 (D6 — V3-DISCOVERY-D6, this work item)
- Issue #155 (D5 — V3-DISCOVERY-D5), `docs/adr/discovery-quality-measurement.md`, `DEC-V3-DISCOVERY-D5-001`
- Issue #154 (D4 — V3-DISCOVERY-D4), `docs/adr/discovery-llm-interaction.md`, `DEC-V3-DISCOVERY-D4-001`
- Issue #153 (D3 — V3-DISCOVERY-D3), `docs/adr/discovery-ranking.md`, `DEC-V3-DISCOVERY-D3-001`
- Issue #152 (D2 — V3-DISCOVERY-D2), `docs/adr/discovery-query-language.md`, `DEC-V3-DISCOVERY-D2-001`
- Issue #151 (D1 — V3-DISCOVERY-D1), `docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D6-001` (`MASTER_PLAN.md`) — This decision log entry
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js`, provider interface
- `DEC-EMBED-SINGLETON-CLOSURE-001` (`packages/contracts/src/embeddings.ts` line 46) — Pipeline singleton via closure
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Single canonical offline-embedding-provider authority; `createOfflineEmbeddingProvider()` at `packages/contracts/src/embeddings.ts` line 151
- `DEC-SCHEMA-MIGRATION-002` (`packages/registry/src/schema.ts` line 18) — Migration 1→2 is a clean re-create; precedent for the migration-7 drop+recreate pattern
- `DEC-STORAGE-IDEMPOTENT-001` (`packages/registry/src/storage.ts` line 267) — vec0 DELETE+INSERT idempotency contract; migration 7 repopulation walk uses the same pattern
- `DEC-SCHEMA-VEC0-001` (`packages/registry/src/schema.ts` line 12) — sqlite-vec `vec0` virtual table authority
- `DEC-NO-OWNERSHIP-011` (`packages/registry/src/schema.ts` line 8) — No ownership-shaped columns in any table, including the v7 `contract_embeddings`
- `packages/registry/src/schema.ts` — Migration framework authority (`SCHEMA_VERSION` line 49, `applyMigrations` line 550, current `contract_embeddings` DDL at migration 2 step 7 lines ~218–221)
- `packages/registry/src/storage.ts` — `storeBlock` embedding write path (`generateEmbedding` call line 233, DELETE+INSERT lines 267–273, `db.transaction` line 289)
- `packages/contracts/src/embeddings.ts` — `EmbeddingProvider.embed(text: string)` line 34, `getPipeline` closure lines 54–71, `createOfflineEmbeddingProvider` line 151
