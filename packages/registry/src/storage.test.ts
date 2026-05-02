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
    artifacts,
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
  it("fresh DB is at SCHEMA_VERSION = 5 with blocks table and idx_blocks_spec_hash", async () => {
    const { applyMigrations, SCHEMA_VERSION } = await import("./schema.js");
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db);

    // Version check.
    expect(SCHEMA_VERSION).toBe(5);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    // On a fresh DB, applyMigrations runs migrations 0→1→2→3(DDL only, no bump)→4→5.
    // Migration 4 bumps schema_version to 4 (parent_block_root; NULL default is correct).
    // Migration 5 bumps schema_version to 5 (block_artifacts table).
    // The canonical_ast_hash backfill (migration 2→3 version bump) is done by openRegistry.
    expect(row?.version).toBe(5);

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
    // block_artifacts table (WI-022 / DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
    expect(tableNames).toContain("block_artifacts");

    // block_artifacts columns present.
    const artCols = db.prepare("PRAGMA table_info(block_artifacts)").all() as Array<{ name: string }>;
    const artColNames = artCols.map((c) => c.name);
    expect(artColNames).toContain("block_merkle_root");
    expect(artColNames).toContain("path");
    expect(artColNames).toContain("bytes");
    expect(artColNames).toContain("declaration_index");

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
    // Second application is a no-op; version stays at 5 (migrations 4 and 5 already ran).
    expect(row?.version).toBe(5);

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

    // Version is 5: migration 4 bumped to 4 (parent_block_root NULL default is correct);
    // migration 5 bumped to 5 (block_artifacts table created).
    const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(vRow?.version).toBe(5);

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

    // Verify schema_version is now 5: openRegistry ran the canonical_ast_hash backfill
    // (bumped to 3) then applyMigrations ran migration 4 DDL (bumped to 4) and
    // migration 5 DDL (bumped to 5, block_artifacts table).
    // The preMigrationVersion capture in openRegistry ensures the backfill still
    // ran even though later migrations would otherwise have bumped past 3.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const versionAfterBackfill = (db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(versionAfterBackfill).toBe(5);
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

    // openRegistry applies migrations 4→5: adds parent_block_root column,
    // then creates block_artifacts table, bumps to 5.
    const reg = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });

    // parent_block_root column must exist and have NULL for the pre-existing row.
    const fetched = await reg.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentBlockRoot).toBeNull();
    // Pre-WI-022 block hydrates with empty artifacts Map.
    expect(fetched!.artifacts.size).toBe(0);
    await reg.close();

    // schema_version is now 5 (migration 4 added parent_block_root; migration 5 added block_artifacts).
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const ver = (db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(ver).toBe(5);
    // parent_block_root column is present.
    const cols = db2.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("parent_block_root");
    // block_artifacts table is present (migration 5).
    const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables2.map((t) => t.name)).toContain("block_artifacts");
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

// ---------------------------------------------------------------------------
// WI-022 / DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: block_artifacts persistence
// ---------------------------------------------------------------------------

describe("artifacts persistence (WI-022)", () => {
  it("storeBlock writes artifact rows to block_artifacts table", async () => {
    // Access the internal DB to verify the raw table rows.
    // We re-open a fresh :memory: DB with direct SQL introspection.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const { applyMigrations } = await import("./schema.js");
    const { openRegistry: openReg } = await import("./storage.js");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    // Use the named file-path form so we can inspect the DB directly.
    // We open via openRegistry which applies migrations, then introspect
    // the block_artifacts table using a second connection on the same :memory:.
    // Instead, open a temp file so two handles can share data.
    db.close();

    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-art-test-"));
    const dbPath = join(tmpDir, "art.sqlite");

    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    const spec = makeSpecYak("artifact-persist");
    const row = makeBlockRow(spec);
    await reg.storeBlock(row);
    await reg.close();

    // Verify via a second DB handle.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const artRows = db2.prepare(
      "SELECT path, bytes, declaration_index FROM block_artifacts WHERE block_merkle_root = ? ORDER BY declaration_index ASC",
    ).all(row.blockMerkleRoot) as Array<{ path: string; bytes: Buffer; declaration_index: number }>;

    // makeBlockRow creates one artifact: "property_tests.ts"
    expect(artRows).toHaveLength(1);
    expect(artRows[0]?.path).toBe("property_tests.ts");
    expect(artRows[0]?.declaration_index).toBe(0);

    db2.close();
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getBlock reconstructs artifacts Map from block_artifacts ORDER BY declaration_index", async () => {
    const spec = makeSpecYak("artifact-hydration");
    const row = makeBlockRow(spec);
    await registry.storeBlock(row);

    const fetched = await registry.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    // artifacts Map has the single entry "property_tests.ts".
    expect(fetched!.artifacts.size).toBe(1);
    expect(fetched!.artifacts.has("property_tests.ts")).toBe(true);
  });

  it("storeBlock failure rolls back artifacts (atomicity)", async () => {
    // Construct a row whose blockMerkleRoot doesn't match its content.
    // storeBlock's integrity check will throw, aborting the transaction.
    const spec = makeSpecYak("atomicity-test");
    const row = makeBlockRow(spec);
    // Tamper with implSource to invalidate the stored root without changing
    // any other identifying field.
    const tamperedRow = { ...row, implSource: "tampered source" };

    // storeBlock must throw due to integrity check.
    await expect(registry.storeBlock(tamperedRow)).rejects.toThrow(
      /integrity check failed/,
    );

    // Neither the blocks row nor any artifact rows should exist.
    const fetchedBlock = await registry.getBlock(row.blockMerkleRoot);
    expect(fetchedBlock).toBeNull();
  });

  it("idempotency with artifacts: re-store same row produces no duplicate artifact rows", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-idem-test-"));
    const dbPath = join(tmpDir, "idem.sqlite");

    const { openRegistry: openReg } = await import("./storage.js");
    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    const spec = makeSpecYak("idem-artifact");
    const row = makeBlockRow(spec);
    await reg.storeBlock(row);
    await reg.storeBlock(row); // second store — must be no-op
    await reg.close();

    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const artCount = (db2.prepare(
      "SELECT COUNT(*) AS cnt FROM block_artifacts WHERE block_merkle_root = ?",
    ).get(row.blockMerkleRoot) as { cnt: number }).cnt;
    // Each artifact path appears exactly once per block.
    expect(artCount).toBe(row.artifacts.size);
    db2.close();

    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("byte-identical round-trip: storeBlock → getBlock returns byte-identical artifacts", async () => {
    const spec = makeSpecYak("byte-roundtrip");
    const artifactContent = "// property tests byte-identical check";
    const row = makeBlockRow(spec, undefined, artifactContent);
    await registry.storeBlock(row);

    const fetched = await registry.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    const originalBytes = row.artifacts.get("property_tests.ts");
    const fetchedBytes = fetched!.artifacts.get("property_tests.ts");
    expect(fetchedBytes).not.toBeUndefined();
    // Byte-identical: every byte must match.
    expect(fetchedBytes!.length).toBe(originalBytes!.length);
    for (let i = 0; i < originalBytes!.length; i++) {
      expect(fetchedBytes![i]).toBe(originalBytes![i]);
    }
  });

  it("integrity recompute: storeBlock throws when stored root doesn't match formula", async () => {
    const spec = makeSpecYak("integrity-check");
    const row = makeBlockRow(spec);
    // Produce a row with a bad blockMerkleRoot (swap impl source, keep root from original).
    const badRow = { ...row, implSource: "completely different impl source" };
    // The stored root was computed with the original implSource, so recomputing
    // from badRow's implSource will produce a different root → integrity failure.
    await expect(registry.storeBlock(badRow)).rejects.toThrow(
      /integrity check failed/,
    );
  });

  it("empty artifacts Map: stores and retrieves empty Map cleanly", async () => {
    // Build a row with an empty manifest and empty artifacts map.
    const spec = makeSpecYak("empty-artifacts");
    const manifest: ReturnType<typeof makeManifest> = { artifacts: [] };
    const artifacts = new Map<string, Uint8Array>();
    const { blockMerkleRoot: bRoot, canonicalize: canon, canonicalAstHash: cah, specHash: sh } =
      await import("@yakcc/contracts");
    const implSource = "export function emptyArtifact(): void {}";
    const specCanonicalBytes = canon(spec as unknown as Parameters<typeof canon>[0]);
    const root = bRoot({ spec, implSource, manifest, artifacts });
    const row = {
      blockMerkleRoot: root,
      specHash: sh(spec),
      specCanonicalBytes,
      implSource,
      proofManifestJson: JSON.stringify(manifest),
      level: "L0" as const,
      createdAt: Date.now(),
      canonicalAstHash: cah(implSource),
      artifacts,
    };
    await registry.storeBlock(row);

    const fetched = await registry.getBlock(root);
    expect(fetched).not.toBeNull();
    expect(fetched!.artifacts.size).toBe(0);
  });

  it("pre-WI-022 backfill: raw-SQL inserted block (no block_artifacts entry) hydrates to empty Map", async () => {
    // Simulate a pre-WI-022 block: insert directly into blocks table, skip block_artifacts.
    // getBlock must return an empty artifacts Map (not null, not undefined).
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-prewi022-test-"));
    const dbPath = join(tmpDir, "prewi022.sqlite");

    const { openRegistry: openReg } = await import("./storage.js");
    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });

    // Build a normal row but insert directly into blocks (bypassing block_artifacts).
    const spec = makeSpecYak("pre-wi022-block");
    // We need an empty-artifacts root for the raw insert to be self-consistent.
    const { blockMerkleRoot: bRoot, canonicalize: canon, canonicalAstHash: cah, specHash: sh } =
      await import("@yakcc/contracts");
    const implSource = "export function legacy(): void {}";
    const manifest = { artifacts: [] as Array<{ kind: string; path: string }> };
    const artifacts = new Map<string, Uint8Array>();
    const root = bRoot({ spec, implSource, manifest: manifest as Parameters<typeof bRoot>[0]["manifest"], artifacts });
    const specCanonicalBytes = canon(spec as unknown as Parameters<typeof canon>[0]);

    // Use validateOnStore: false to bypass integrity check (pre-WI-022 simulation).
    // Actually we can't call storeBlock with bypass here. Instead, close reg and
    // do a raw SQL insert, then reopen.
    await reg.close();

    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.prepare(
      "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash, parent_block_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(root, sh(spec), Buffer.from(specCanonicalBytes), implSource, JSON.stringify(manifest), "L0", Date.now(), cah(implSource));
    // No corresponding block_artifacts rows inserted — simulates pre-WI-022 state.
    db.close();

    // Reopen and retrieve: must return empty artifacts Map.
    const reg2 = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched = await reg2.getBlock(root);
    await reg2.close();

    expect(fetched).not.toBeNull();
    expect(fetched!.artifacts).toBeInstanceOf(Map);
    expect(fetched!.artifacts.size).toBe(0);

    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// enumerateSpecs — DEC-SERVE-SPECS-ENUMERATION-020 (closed by WI-026)
//
// These tests verify the new Registry.enumerateSpecs() primitive that replaces
// the old optional callback on ServeOptions. The implementation is a single
// SELECT DISTINCT spec_hash FROM blocks ORDER BY spec_hash.
//
// Production sequence exercised by the compound-interaction test below:
//   openRegistry → storeBlock(rowA) → storeBlock(rowB with same spec as rowA)
//   → storeBlock(rowC with new spec) → enumerateSpecs()
//   → assert sorted distinct [specA, specC]
// ---------------------------------------------------------------------------

describe("enumerateSpecs", () => {
  it("returns empty array on an empty registry", async () => {
    // No blocks stored — SELECT DISTINCT returns zero rows, not undefined/null.
    const specs = await registry.enumerateSpecs();
    expect(specs).toEqual([]);
  });

  it("returns a single spec hash after storing one block", async () => {
    const spec = makeSpecYak("single-spec-fn");
    const row = makeBlockRow(spec);
    await registry.storeBlock(row);

    const specs = await registry.enumerateSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toBe(row.specHash);
  });

  it("returns distinct spec hashes in sorted ascending order for multiple specs", async () => {
    // Store two blocks under specA (same spec, different impls) and one under specB.
    // enumerateSpecs must return [specA, specB] with no duplicate for specA.
    const specA = makeSpecYak("spec-alpha");
    const specB = makeSpecYak("spec-beta");

    const rowA1 = makeBlockRow(specA, "export function f(): number { return 1; }", "// a1");
    const rowA2 = makeBlockRow(specA, "export function f(): number { return 2; }", "// a2");
    const rowB = makeBlockRow(specB, "export function f(): string { return 'x'; }", "// b");

    await registry.storeBlock(rowA1);
    await registry.storeBlock(rowA2);
    await registry.storeBlock(rowB);

    const specs = await registry.enumerateSpecs();

    // Exactly two distinct spec hashes — one for specA, one for specB.
    expect(specs).toHaveLength(2);
    expect(specs).toContain(rowA1.specHash);
    expect(specs).toContain(rowB.specHash);

    // Sorted ascending.
    const sorted = [...specs].sort();
    expect([...specs]).toEqual(sorted);
  });

  it("is idempotent across repeated calls with no intervening writes", async () => {
    const spec = makeSpecYak("idempotent-spec");
    const row = makeBlockRow(spec);
    await registry.storeBlock(row);

    const first = await registry.enumerateSpecs();
    const second = await registry.enumerateSpecs();

    // Both calls return the same byte-identical sorted array.
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it("reflects subsequent storeBlock writes — no stale caching", async () => {
    const specA = makeSpecYak("reflect-spec-a");
    const specB = makeSpecYak("reflect-spec-b");

    const rowA = makeBlockRow(specA);
    await registry.storeBlock(rowA);

    const before = await registry.enumerateSpecs();
    expect(before).toHaveLength(1);
    expect(before[0]).toBe(rowA.specHash);

    // Store a new block under a new spec.
    const rowB = makeBlockRow(specB);
    await registry.storeBlock(rowB);

    const after = await registry.enumerateSpecs();
    expect(after).toHaveLength(2);
    expect(after).toContain(rowA.specHash);
    expect(after).toContain(rowB.specHash);

    // Confirm sorted ascending.
    const sorted = [...after].sort();
    expect([...after]).toEqual(sorted);
  });

  // Compound-interaction: real production sequence for spec enumeration.
  //
  // This test exercises the path that serveRegistry's /v1/specs handler takes
  // after WI-026: storeBlock writes come in via the normal storage path, then
  // enumerateSpecs() is called directly on the registry with no intermediary
  // callback or caching layer. The spec hashes returned are the exact values
  // the federation transport will serve to mirror clients.
  it("compound: store 3 blocks under 2 specs, enumerate, assert sorted distinct pair", async () => {
    const specA = makeSpecYak("compound-spec-a", "Parse integer from string");
    const specB = makeSpecYak("compound-spec-b", "Format number as string");

    // Two blocks under specA (different impl text → different merkle roots).
    const rowA1 = makeBlockRow(specA, "export function f(x: string): number { return parseInt(x, 10); }", "// compound a1");
    const rowA2 = makeBlockRow(specA, "export function f(x: string): number { return +x; }", "// compound a2");
    // One block under specB.
    const rowB = makeBlockRow(specB, "export function f(n: number): string { return String(n); }", "// compound b");

    await registry.storeBlock(rowA1);
    await registry.storeBlock(rowA2);
    await registry.storeBlock(rowB);

    const specs = await registry.enumerateSpecs();

    // Exactly two distinct spec hashes despite three blocks.
    expect(specs).toHaveLength(2);
    expect(specs).toContain(rowA1.specHash);
    expect(specs).toContain(rowB.specHash);

    // rowA1 and rowA2 share the same specHash.
    expect(rowA1.specHash).toBe(rowA2.specHash);

    // Sorted ascending (same order as ORDER BY spec_hash in SQL).
    const sorted = [...specs].sort();
    expect([...specs]).toEqual(sorted);
  });
});
