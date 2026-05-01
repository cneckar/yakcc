/**
 * storage.test.ts — SQLite-backed registry round-trip and integration tests.
 *
 * All tests use ":memory:" databases to avoid disk I/O. The mock embedding
 * provider returns deterministic 384-dim vectors without loading ONNX, making
 * the test suite fast and offline-capable.
 *
 * Production sequence exercised:
 *   openRegistry → storeBlock(row) → selectBlocks(specHash) → getBlock(merkleRoot)
 *   → getProvenance(merkleRoot) → close()
 *
 * This is the canonical call sequence used by the CLI's `yakcc registry init`
 * and `yakcc search` commands under the v0.6 triplet schema.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  type BlockMerkleRoot,
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { openRegistry } from "./storage.js";
import type { BlockTripletRow, Registry } from "./index.js";

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic 384-dim Float32Array for any input text.
 * Uses a simple hash of the text to vary the vector so different specs
 * produce meaningfully different embeddings for search tests.
 */
function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        const charCode = text.charCodeAt(i % text.length) / 128;
        vec[i] = charCode + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixture factories
// ---------------------------------------------------------------------------

/**
 * Make a minimal SpecYak with all required fields for v0.6 (WI-T01 shape).
 * The `behavior` text is the v0 ContractSpec.behavior lift field, kept optional
 * in SpecYak but useful for search tests.
 */
function makeSpecYak(name = "parse-int", behavior = "Parse a JSON integer"): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: ["result is an integer"],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [{ id: "total", description: "Always returns or throws." }],
    errorConditions: [
      { description: "Throws SyntaxError on malformed input", errorType: "SyntaxError" },
    ],
    nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    propertyTests: [],
  };
}

/**
 * Make a minimal L0 ProofManifest with a single property_tests artifact.
 */
function makeManifest(path = "property_tests.ts"): ProofManifest {
  return {
    artifacts: [{ kind: "property_tests", path }],
  };
}

/**
 * Build a complete BlockTripletRow from a spec and impl source.
 * Computes blockMerkleRoot from the triplet, as storage callers must do.
 */
function makeBlockRow(
  spec: SpecYak,
  implSource = "export function f(x: string): number { return parseInt(x, 10); }",
  artifactContent = "// property tests",
): BlockTripletRow {
  const manifest = makeManifest();
  const artifactBytes = new TextEncoder().encode(artifactContent);
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);

  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", {
    embeddings: mockEmbeddingProvider(),
  });
});

afterEach(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe("schema migrations", () => {
  it("fresh DB is at SCHEMA_VERSION = 4 with blocks table and idx_blocks_spec_hash", async () => {
    const { applyMigrations, SCHEMA_VERSION } = await import("./schema.js");
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db);

    // Version check.
    expect(SCHEMA_VERSION).toBe(4);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    // On a fresh DB, applyMigrations runs migrations 0→1→2→3(DDL only, no bump)→4
    // and migration 4 bumps schema_version to 4 directly (no backfill needed for
    // parent_block_root; NULL is the correct default). The canonical_ast_hash
    // backfill (migration 2→3 version bump) is done by openRegistry, not here.
    expect(row?.version).toBe(4);

    // blocks table exists with expected columns.
    const cols = db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("block_merkle_root");
    expect(colNames).toContain("spec_hash");
    expect(colNames).toContain("spec_canonical_bytes");
    expect(colNames).toContain("impl_source");
    expect(colNames).toContain("proof_manifest_json");
    expect(colNames).toContain("level");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("canonical_ast_hash");

    // No ownership columns — DEC-NO-OWNERSHIP-011.
    for (const banned of ["author", "author_email", "signature"]) {
      expect(colNames).not.toContain(banned);
    }

    // idx_blocks_spec_hash index exists.
    const indexes = db.prepare("PRAGMA index_list(blocks)").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_blocks_spec_hash");
    expect(indexNames).toContain("idx_blocks_canonical_ast_hash");

    // v0 tables must NOT exist.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain("contracts");
    expect(tableNames).not.toContain("implementations");

    // Only expected tables exist.
    expect(tableNames).toContain("blocks");
    expect(tableNames).toContain("test_history");
    expect(tableNames).toContain("runtime_exposure");
    expect(tableNames).toContain("strictness_edges");

    db.close();
  });

  it("applying migrations twice to the same DB is a no-op (idempotent)", async () => {
    const { applyMigrations } = await import("./schema.js");
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db); // first application
    applyMigrations(db); // second — must not throw

    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    // Second application is a no-op; version stays at 4 (migration 4 already ran).
    expect(row?.version).toBe(4);

    db.close();
  });

  it("migration from v0-shaped DB (has contracts/implementations) applies cleanly", async () => {
    // Simulate a v0 DB by applying only migration 1 and setting version to 1.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);

    // Bootstrap migration 1 manually (create v0 tables).
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    db.exec(`INSERT OR IGNORE INTO schema_version(version) VALUES (0)`);
    db.exec(`CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY, canonical_bytes BLOB NOT NULL,
      spec_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS implementations (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contracts(id),
      source TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
      contract_id TEXT PRIMARY KEY, embedding FLOAT[384]
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      suite_id TEXT NOT NULL, passed INTEGER NOT NULL, at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_exposure (
      contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
      requests_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS strictness_edges (
      stricter_id TEXT NOT NULL REFERENCES contracts(id),
      looser_id TEXT NOT NULL REFERENCES contracts(id),
      created_at INTEGER NOT NULL, PRIMARY KEY (stricter_id, looser_id)
    )`);
    db.prepare("UPDATE schema_version SET version = ?").run(1);

    // Now apply the full migration path.
    const { applyMigrations } = await import("./schema.js");
    applyMigrations(db);

    // v0 tables gone.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain("contracts");
    expect(tableNames).not.toContain("implementations");
    expect(tableNames).toContain("blocks");

    // Version is 4: migration 4 bumped it directly (NULL default is correct for
    // parent_block_root; no backfill needed).
    const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(vRow?.version).toBe(4);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// storeBlock → selectBlocks round-trip
// ---------------------------------------------------------------------------

describe("storeBlock and selectBlocks", () => {
  it("stores a block and retrieves its merkle root by spec hash", async () => {
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);

    await registry.storeBlock(row);

    const roots = await registry.selectBlocks(row.specHash);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(row.blockMerkleRoot);
  });

  it("returns empty array for a spec hash not in the registry", async () => {
    const fakeSpecHash = "a".repeat(64) as SpecHash;
    const roots = await registry.selectBlocks(fakeSpecHash);
    expect(roots).toEqual([]);
  });

  it("storeBlock is idempotent: storing the same block twice is a no-op", async () => {
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);

    await registry.storeBlock(row);
    await registry.storeBlock(row); // second store — must not throw

    const roots = await registry.selectBlocks(row.specHash);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(row.blockMerkleRoot);
  });

  it("stores two blocks for the same spec and returns both merkle roots", async () => {
    const spec = makeSpecYak();
    const rowA = makeBlockRow(spec, "export function f(x: string): number { return parseInt(x, 10); }", "// artifact A");
    const rowB = makeBlockRow(spec, "export function f(x: string): number { return Number(x); }", "// artifact B");

    // Both blocks share the same specHash but differ in impl/artifacts.
    expect(rowA.specHash).toBe(rowB.specHash);
    expect(rowA.blockMerkleRoot).not.toBe(rowB.blockMerkleRoot);

    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);

    const roots = await registry.selectBlocks(rowA.specHash);
    expect(roots).toHaveLength(2);
    expect(roots).toContain(rowA.blockMerkleRoot);
    expect(roots).toContain(rowB.blockMerkleRoot);
  });

  it("stores multiple distinct specs and retrieves each independently", async () => {
    const specA = makeSpecYak("parse-int", "Parse integer");
    const specB = makeSpecYak("match-bracket", "Match bracket character");
    const rowA = makeBlockRow(specA);
    const rowB = makeBlockRow(specB);

    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);

    const rootsA = await registry.selectBlocks(rowA.specHash);
    const rootsB = await registry.selectBlocks(rowB.specHash);

    expect(rootsA).toHaveLength(1);
    expect(rootsB).toHaveLength(1);
    expect(rootsA[0]).toBe(rowA.blockMerkleRoot);
    expect(rootsB[0]).toBe(rowB.blockMerkleRoot);
    expect(rowA.specHash).not.toBe(rowB.specHash);
  });
});

// ---------------------------------------------------------------------------
// getBlock round-trip
// ---------------------------------------------------------------------------

describe("getBlock", () => {
  it("returns the stored block row by merkle root", async () => {
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);

    await registry.storeBlock(row);

    const retrieved = await registry.getBlock(row.blockMerkleRoot);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.blockMerkleRoot).toBe(row.blockMerkleRoot);
    expect(retrieved?.specHash).toBe(row.specHash);
    expect(retrieved?.implSource).toBe(row.implSource);
    expect(retrieved?.proofManifestJson).toBe(row.proofManifestJson);
    expect(retrieved?.level).toBe("L0");
  });

  it("returns null for a merkle root not in the registry", async () => {
    const fakeMerkleRoot = "b".repeat(64) as BlockMerkleRoot;
    const result = await registry.getBlock(fakeMerkleRoot);
    expect(result).toBeNull();
  });

  it("round-trips spec canonical bytes correctly", async () => {
    const spec = makeSpecYak("canonical-roundtrip");
    const row = makeBlockRow(spec);

    await registry.storeBlock(row);

    const retrieved = await registry.getBlock(row.blockMerkleRoot);
    expect(retrieved).not.toBeNull();
    if (retrieved === null) return;

    // The canonical bytes stored must match what we computed.
    const storedHex = Buffer.from(retrieved.specCanonicalBytes).toString("hex");
    const expectedHex = Buffer.from(row.specCanonicalBytes).toString("hex");
    expect(storedHex).toBe(expectedHex);
  });

  it("specHash stored in block is derivable from specCanonicalBytes", async () => {
    const spec = makeSpecYak("hash-derivation");
    const row = makeBlockRow(spec);

    await registry.storeBlock(row);

    const retrieved = await registry.getBlock(row.blockMerkleRoot);
    expect(retrieved).not.toBeNull();
    if (retrieved === null) return;

    // Re-derive spec hash from the stored canonical bytes.
    const reSpec = JSON.parse(
      Buffer.from(retrieved.specCanonicalBytes).toString("utf-8"),
    ) as SpecYak;
    const reHash = deriveSpecHash(reSpec);
    expect(reHash).toBe(retrieved.specHash);
  });
});

// ---------------------------------------------------------------------------
// getProvenance
// ---------------------------------------------------------------------------

describe("getProvenance", () => {
  it("returns empty arrays for a fresh block with no evidence", async () => {
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);
    await registry.storeBlock(row);

    const prov = await registry.getProvenance(row.blockMerkleRoot);
    expect(prov.testHistory).toEqual([]);
    expect(prov.runtimeExposure).toEqual([]);
  });

  it("returns empty provenance for a merkle root not in the registry", async () => {
    const fakeMerkleRoot = "c".repeat(64) as BlockMerkleRoot;
    const prov = await registry.getProvenance(fakeMerkleRoot);
    expect(prov.testHistory).toEqual([]);
    expect(prov.runtimeExposure).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe("close", () => {
  it("close() is idempotent: calling twice does not throw", async () => {
    await registry.close();
    await expect(registry.close()).resolves.toBeUndefined();
    // Reinitialize so afterEach doesn't fail.
    registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  });

  it("throws after close on storeBlock", async () => {
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);
    await registry.close();
    await expect(registry.storeBlock(row)).rejects.toThrow("Registry has been closed");
    registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  });
});

// ---------------------------------------------------------------------------
// DEC-NO-OWNERSHIP-011 invariant: no ownership columns in schema
// ---------------------------------------------------------------------------

describe("DEC-NO-OWNERSHIP-011: no ownership-shaped columns", () => {
  it("blocks table has no author, author_email, or signature columns", async () => {
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const { applyMigrations } = await import("./schema.js");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db);

    const cols = db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    for (const banned of ["author", "author_email", "signature", "owner", "signer"]) {
      expect(colNames).not.toContain(banned);
    }

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence integration test
// ---------------------------------------------------------------------------

describe("production sequence: storeBlock → selectBlocks → getBlock → getProvenance", () => {
  it("full end-to-end: stores two blocks for different specs, retrieves each", async () => {
    // Two structurally distinct specs.
    const specA = makeSpecYak("parse-int", "Parse integer from string");
    const specB = makeSpecYak("format-num", "Format number to string");
    const rowA = makeBlockRow(specA, "export function f(s: string): number { return parseInt(s, 10); }");
    const rowB = makeBlockRow(specB, "export function g(n: number): string { return String(n); }");

    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);

    // selectBlocks returns the right root for each spec.
    const rootsA = await registry.selectBlocks(rowA.specHash);
    const rootsB = await registry.selectBlocks(rowB.specHash);
    expect(rootsA).toContain(rowA.blockMerkleRoot);
    expect(rootsB).toContain(rowB.blockMerkleRoot);

    // getBlock resolves each root to its full row.
    const fetchedA = await registry.getBlock(rowA.blockMerkleRoot);
    const fetchedB = await registry.getBlock(rowB.blockMerkleRoot);
    expect(fetchedA?.specHash).toBe(rowA.specHash);
    expect(fetchedB?.specHash).toBe(rowB.specHash);
    expect(fetchedA?.implSource).toBe(rowA.implSource);
    expect(fetchedB?.implSource).toBe(rowB.implSource);

    // getProvenance returns empty for fresh blocks.
    const provA = await registry.getProvenance(rowA.blockMerkleRoot);
    expect(Array.isArray(provA.testHistory)).toBe(true);
    expect(provA.testHistory).toHaveLength(0);

    // BlockMerkleRoot is stable: re-derive from stored data, matches stored root.
    expect(fetchedA?.blockMerkleRoot).toBe(rowA.blockMerkleRoot);
    expect(fetchedB?.blockMerkleRoot).toBe(rowB.blockMerkleRoot);
  });

  it("two blocks for same spec share spec_hash, have distinct merkle roots", async () => {
    const spec = makeSpecYak("shared-spec", "Parse integer from string");

    const rowA = makeBlockRow(spec, "export function impl(x: string): number { return parseInt(x, 10); }", "// tests A");
    const rowB = makeBlockRow(spec, "export function impl(x: string): number { return +x; }", "// tests B");

    // Spec hashes must be equal (same spec).
    expect(rowA.specHash).toBe(rowB.specHash);
    // Merkle roots must differ (different impl/artifact).
    expect(rowA.blockMerkleRoot).not.toBe(rowB.blockMerkleRoot);

    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);

    const roots = await registry.selectBlocks(rowA.specHash);
    expect(roots).toHaveLength(2);
    expect(roots).toContain(rowA.blockMerkleRoot);
    expect(roots).toContain(rowB.blockMerkleRoot);

    // Both blocks retrievable individually.
    const fetchedA = await registry.getBlock(rowA.blockMerkleRoot);
    const fetchedB = await registry.getBlock(rowB.blockMerkleRoot);
    expect(fetchedA?.implSource).toBe(rowA.implSource);
    expect(fetchedB?.implSource).toBe(rowB.implSource);
  });
});

// ---------------------------------------------------------------------------
// BlockMerkleRoot determinism
// ---------------------------------------------------------------------------

describe("BlockMerkleRoot determinism", () => {
  it("the same triplet inputs always produce the same block_merkle_root", () => {
    const spec = makeSpecYak("determinism-check");
    const row1 = makeBlockRow(spec, "export function f(): void {}", "// artifact");
    const row2 = makeBlockRow(spec, "export function f(): void {}", "// artifact");
    expect(row1.blockMerkleRoot).toBe(row2.blockMerkleRoot);
  });

  it("changing impl source changes the block_merkle_root", () => {
    const spec = makeSpecYak("sensitivity-impl");
    const row1 = makeBlockRow(spec, "export function f(): void {}", "// artifact");
    const row2 = makeBlockRow(spec, "export function g(): void {}", "// artifact");
    expect(row1.blockMerkleRoot).not.toBe(row2.blockMerkleRoot);
  });

  it("changing artifact content changes the block_merkle_root", () => {
    const spec = makeSpecYak("sensitivity-artifact");
    const row1 = makeBlockRow(spec, "export function f(): void {}", "// artifact v1");
    const row2 = makeBlockRow(spec, "export function f(): void {}", "// artifact v2");
    expect(row1.blockMerkleRoot).not.toBe(row2.blockMerkleRoot);
  });
});

// ---------------------------------------------------------------------------
// findByCanonicalAstHash
// ---------------------------------------------------------------------------

describe("findByCanonicalAstHash", () => {
  it("returns [] for a hash with no stored block", async () => {
    const dummyHash = ("0".repeat(64)) as CanonicalAstHash;
    const result = await registry.findByCanonicalAstHash(dummyHash);
    expect(result).toEqual([]);
  });

  it("returns the merkleRoot for a single stored block matching the hash", async () => {
    const spec = makeSpecYak("p");
    const row = makeBlockRow(spec);
    await registry.storeBlock(row);
    const found = await registry.findByCanonicalAstHash(row.canonicalAstHash);
    expect(found).toEqual([row.blockMerkleRoot]);
  });

  it("returns multiple merkleRoots when multiple blocks share the same canonicalAstHash", async () => {
    // Two different specs but same impl source → same canonicalAstHash
    const implSource = "export function f(x: string): number { return parseInt(x, 10); }";
    const rowA = makeBlockRow(makeSpecYak("specA", "behavior A"), implSource);
    const rowB = makeBlockRow(makeSpecYak("specB", "behavior B"), implSource);
    expect(rowA.canonicalAstHash).toEqual(rowB.canonicalAstHash);  // sanity check
    expect(rowA.blockMerkleRoot).not.toEqual(rowB.blockMerkleRoot);  // sanity check (different specs → different merkle)
    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);
    const found = await registry.findByCanonicalAstHash(rowA.canonicalAstHash);
    expect(found).toContain(rowA.blockMerkleRoot);
    expect(found).toContain(rowB.blockMerkleRoot);
    expect(found.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// openRegistry backfill (v2 → v3 migration)
// ---------------------------------------------------------------------------

describe("openRegistry backfill (v2 → v3 migration)", () => {
  it("backfills empty canonical_ast_hash on existing rows when reopening a v2 DB", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-backfill-test-"));
    const dbPath = join(tmpDir, "registry.sqlite");

    // Phase 1: manually construct a DB at "schema_version=2" with the v3 column
    // added but not backfilled. This simulates the partial-migration state that
    // openRegistry's preMigrationVersion capture was designed to handle:
    //   - blocks table exists (post-migration-2 schema)
    //   - canonical_ast_hash column added (migration-3 DDL ran) but empty string
    //   - schema_version still = 2 (version bump deferred to openRegistry backfill)
    // We build this manually because applyMigrations now bumps all the way to 4,
    // so we cannot use it to obtain a v2-frozen DB.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db1 = new Database(dbPath);
    sqliteVec.load(db1);
    // Build the v2 schema directly: schema_version + blocks table (no canonical_ast_hash yet).
    db1.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    db1.exec("INSERT INTO schema_version(version) VALUES (2)");
    db1.exec(`CREATE VIRTUAL TABLE contract_embeddings USING vec0(
      spec_hash TEXT PRIMARY KEY, embedding FLOAT[384]
    )`);
    db1.exec(`CREATE TABLE blocks (
      block_merkle_root    TEXT    PRIMARY KEY,
      spec_hash            TEXT    NOT NULL,
      spec_canonical_bytes BLOB    NOT NULL,
      impl_source          TEXT    NOT NULL,
      proof_manifest_json  TEXT    NOT NULL,
      level                TEXT    NOT NULL CHECK(level IN ('L0','L1','L2','L3')),
      created_at           INTEGER NOT NULL
    )`);
    db1.exec("CREATE INDEX idx_blocks_spec_hash ON blocks(spec_hash)");
    db1.exec(`CREATE TABLE test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_merkle_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      suite_id TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), at INTEGER NOT NULL
    )`);
    db1.exec(`CREATE TABLE runtime_exposure (
      block_merkle_root TEXT PRIMARY KEY REFERENCES blocks(block_merkle_root),
      requests_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER
    )`);
    db1.exec(`CREATE TABLE strictness_edges (
      stricter_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      looser_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      created_at INTEGER NOT NULL, PRIMARY KEY (stricter_root, looser_root)
    )`);
    // Add the migration-3 column with empty-string sentinel (simulates the DDL-ran,
    // backfill-pending state that openRegistry is responsible for completing).
    db1.exec("ALTER TABLE blocks ADD COLUMN canonical_ast_hash TEXT NOT NULL DEFAULT ''");
    db1.exec("CREATE INDEX idx_blocks_canonical_ast_hash ON blocks(canonical_ast_hash)");
    // schema_version stays at 2: openRegistry.preMigrationVersion will see 2 and
    // trigger the backfill + bump to SCHEMA_VERSION.
    const versionBeforeBackfill = (db1.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(versionBeforeBackfill).toBe(2);

    // Insert a block row directly with empty canonical_ast_hash.
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);
    db1.prepare(
      "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.blockMerkleRoot, row.specHash, row.specCanonicalBytes, row.implSource, row.proofManifestJson, row.level, row.createdAt, "");
    db1.close();

    // Phase 2: openRegistry triggers the backfill + version bump.
    const reg = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched = await reg.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched!.canonicalAstHash).not.toBe("");
    // The backfilled hash should equal canonicalAstHash(impl_source).
    expect(fetched!.canonicalAstHash).toEqual(deriveCanonicalAstHash(row.implSource));
    await reg.close();

    // Verify schema_version is now 4: openRegistry ran the canonical_ast_hash backfill
    // (bumped to 3) and then applyMigrations ran migration 4 DDL (bumped to 4).
    // The preMigrationVersion capture in openRegistry ensures the backfill still
    // ran even though migration 4 would otherwise have bumped past 3.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const versionAfterBackfill = (db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(versionAfterBackfill).toBe(4);
    db2.close();

    // Phase 3: reopen idempotency — second openRegistry doesn't re-backfill or re-fail.
    const reg2 = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched2 = await reg2.getBlock(row.blockMerkleRoot);
    expect(fetched2!.canonicalAstHash).toEqual(deriveCanonicalAstHash(row.implSource));
    await reg2.close();

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Migration 3 → 4: parent_block_root column
// ---------------------------------------------------------------------------

describe("migration 3 → 4: parent_block_root column", () => {
  it("a v3-shaped DB gains parent_block_root column with NULL default after openRegistry", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-migration4-test-"));
    const dbPath = join(tmpDir, "registry.sqlite");

    // Build a v3-shaped DB manually: blocks table with canonical_ast_hash but
    // without parent_block_root, schema_version = 3.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db1 = new Database(dbPath);
    sqliteVec.load(db1);
    db1.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    db1.exec("INSERT INTO schema_version(version) VALUES (3)");
    db1.exec(`CREATE VIRTUAL TABLE contract_embeddings USING vec0(
      spec_hash TEXT PRIMARY KEY, embedding FLOAT[384]
    )`);
    db1.exec(`CREATE TABLE blocks (
      block_merkle_root    TEXT    PRIMARY KEY,
      spec_hash            TEXT    NOT NULL,
      spec_canonical_bytes BLOB    NOT NULL,
      impl_source          TEXT    NOT NULL,
      proof_manifest_json  TEXT    NOT NULL,
      level                TEXT    NOT NULL CHECK(level IN ('L0','L1','L2','L3')),
      created_at           INTEGER NOT NULL,
      canonical_ast_hash   TEXT    NOT NULL DEFAULT ''
    )`);
    db1.exec("CREATE INDEX idx_blocks_spec_hash ON blocks(spec_hash)");
    db1.exec("CREATE INDEX idx_blocks_canonical_ast_hash ON blocks(canonical_ast_hash)");
    db1.exec(`CREATE TABLE test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_merkle_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      suite_id TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), at INTEGER NOT NULL
    )`);
    db1.exec(`CREATE TABLE runtime_exposure (
      block_merkle_root TEXT PRIMARY KEY REFERENCES blocks(block_merkle_root),
      requests_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER
    )`);
    db1.exec(`CREATE TABLE strictness_edges (
      stricter_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      looser_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      created_at INTEGER NOT NULL, PRIMARY KEY (stricter_root, looser_root)
    )`);

    // Insert a block row at v3 (no parent_block_root column yet).
    const spec = makeSpecYak("v3-migration-test");
    const row = makeBlockRow(spec);
    db1.prepare(
      "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.blockMerkleRoot,
      row.specHash,
      row.specCanonicalBytes,
      row.implSource,
      row.proofManifestJson,
      row.level,
      row.createdAt,
      row.canonicalAstHash,
    );
    db1.close();

    // openRegistry applies migration 4: adds parent_block_root column and bumps to 4.
    const reg = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });

    // parent_block_root column must exist and have NULL for the pre-existing row.
    const fetched = await reg.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentBlockRoot).toBeNull();
    await reg.close();

    // schema_version is now 4.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const ver = (db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(ver).toBe(4);
    // parent_block_root column is present.
    const cols = db2.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("parent_block_root");
    db2.close();

    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// parent_block_root round-trip
// ---------------------------------------------------------------------------

describe("parent_block_root round-trip", () => {
  it("storeBlock + getBlock round-trips parent_block_root = null", async () => {
    const spec = makeSpecYak("parent-null-test");
    const row = makeBlockRow(spec);
    // makeBlockRow does not set parentBlockRoot; it should be absent/undefined.
    // storeBlock accepts undefined as null.
    await registry.storeBlock(row);
    const fetched = await registry.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentBlockRoot).toBeNull();
  });

  it("storeBlock + getBlock round-trips a non-null parent_block_root", async () => {
    // Store a "parent" block first.
    const parentSpec = makeSpecYak("parent-block");
    const parentRow = makeBlockRow(parentSpec, "export function parent(): void {}");
    await registry.storeBlock(parentRow);

    // Store a "child" block referencing the parent's root.
    const childSpec = makeSpecYak("child-block");
    const childRow = makeBlockRow(
      childSpec,
      "export function child(): void {}",
      "// child artifact",
    );
    // Inject the parentBlockRoot field (normally set by the shave persistence layer).
    const childRowWithParent = { ...childRow, parentBlockRoot: parentRow.blockMerkleRoot };
    await registry.storeBlock(childRowWithParent);

    const fetched = await registry.getBlock(childRow.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentBlockRoot).toBe(parentRow.blockMerkleRoot);
  });
});
