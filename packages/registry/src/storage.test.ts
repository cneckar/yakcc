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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockTripletRow, Registry } from "./index.js";
import { openRegistry } from "./storage.js";

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
    expect(SCHEMA_VERSION).toBe(6);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    // On a fresh DB, applyMigrations runs migrations 0→1→2→3(DDL only, no bump)→4→5→6.
    // Migration 4 bumps schema_version to 4 (parent_block_root; NULL default is correct).
    // Migration 5 bumps schema_version to 5 (block_artifacts table).
    // Migration 6 bumps schema_version to 6 (foreign-block columns + block_foreign_refs).
    // The canonical_ast_hash backfill (migration 2→3 version bump) is done by openRegistry.
    expect(row?.version).toBe(6);

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
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
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
    const artCols = db.prepare("PRAGMA table_info(block_artifacts)").all() as Array<{
      name: string;
    }>;
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
    // Second application is a no-op; version stays at 6 (all migrations already ran).
    expect(row?.version).toBe(6);

    db.close();
  });

  it("migration from v0-shaped DB (has contracts/implementations) applies cleanly", async () => {
    // Simulate a v0 DB by applying only migration 1 and setting version to 1.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);

    // Bootstrap migration 1 manually (create v0 tables).
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    db.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (0)");
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
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain("contracts");
    expect(tableNames).not.toContain("implementations");
    expect(tableNames).toContain("blocks");

    // Version is 6: migration 4 bumped to 4 (parent_block_root NULL default is correct);
    // migration 5 bumped to 5 (block_artifacts table created);
    // migration 6 bumped to 6 (kind/foreign_* columns + block_foreign_refs table).
    const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(vRow?.version).toBe(6);

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
    const rowA = makeBlockRow(
      spec,
      "export function f(x: string): number { return parseInt(x, 10); }",
      "// artifact A",
    );
    const rowB = makeBlockRow(
      spec,
      "export function f(x: string): number { return Number(x); }",
      "// artifact B",
    );

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
    const rowA = makeBlockRow(
      specA,
      "export function f(s: string): number { return parseInt(s, 10); }",
    );
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

    const rowA = makeBlockRow(
      spec,
      "export function impl(x: string): number { return parseInt(x, 10); }",
      "// tests A",
    );
    const rowB = makeBlockRow(
      spec,
      "export function impl(x: string): number { return +x; }",
      "// tests B",
    );

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
    const dummyHash = "0".repeat(64) as CanonicalAstHash;
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
    expect(rowA.canonicalAstHash).toEqual(rowB.canonicalAstHash); // sanity check
    expect(rowA.blockMerkleRoot).not.toEqual(rowB.blockMerkleRoot); // sanity check (different specs → different merkle)
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
    const versionBeforeBackfill = (
      db1.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(versionBeforeBackfill).toBe(2);

    // Insert a block row directly with empty canonical_ast_hash.
    const spec = makeSpecYak();
    const row = makeBlockRow(spec);
    db1
      .prepare(
        "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.blockMerkleRoot,
        row.specHash,
        row.specCanonicalBytes,
        row.implSource,
        row.proofManifestJson,
        row.level,
        row.createdAt,
        "",
      );
    db1.close();

    // Phase 2: openRegistry triggers the backfill + version bump.
    const reg = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched = await reg.getBlock(row.blockMerkleRoot);
    expect(fetched).not.toBeNull();
    expect(fetched?.canonicalAstHash).not.toBe("");
    // The backfilled hash should equal canonicalAstHash(impl_source).
    expect(fetched?.canonicalAstHash).toEqual(deriveCanonicalAstHash(row.implSource));
    await reg.close();

    // Verify schema_version is now 6: openRegistry ran the canonical_ast_hash backfill
    // (bumped to 3) then applyMigrations ran migration 4 DDL (bumped to 4),
    // migration 5 DDL (bumped to 5, block_artifacts table), and
    // migration 6 DDL (bumped to 6, kind/foreign_* columns + block_foreign_refs).
    // The preMigrationVersion capture in openRegistry ensures the backfill still
    // ran even though later migrations would otherwise have bumped past 3.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const versionAfterBackfill = (
      db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(versionAfterBackfill).toBe(6);
    db2.close();

    // Phase 3: reopen idempotency — second openRegistry doesn't re-backfill or re-fail.
    const reg2 = await openRegistry(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched2 = await reg2.getBlock(row.blockMerkleRoot);
    expect(fetched2?.canonicalAstHash).toEqual(deriveCanonicalAstHash(row.implSource));
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
    db1
      .prepare(
        "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
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
    expect(fetched?.parentBlockRoot).toBeNull();
    // Pre-WI-022 block hydrates with empty artifacts Map.
    expect(fetched?.artifacts.size).toBe(0);
    await reg.close();

    // schema_version is now 6 (migration 4 added parent_block_root; migration 5 added
    // block_artifacts; migration 6 added kind/foreign_* columns + block_foreign_refs).
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const ver = (
      db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(ver).toBe(6);
    // parent_block_root column is present.
    const cols = db2.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("parent_block_root");
    // block_artifacts table is present (migration 5).
    const tables2 = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
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
    expect(fetched?.parentBlockRoot).toBeNull();
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
    expect(fetched?.parentBlockRoot).toBe(parentRow.blockMerkleRoot);
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
    const artRows = db2
      .prepare(
        "SELECT path, bytes, declaration_index FROM block_artifacts WHERE block_merkle_root = ? ORDER BY declaration_index ASC",
      )
      .all(row.blockMerkleRoot) as Array<{
      path: string;
      bytes: Buffer;
      declaration_index: number;
    }>;

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
    expect(fetched?.artifacts.size).toBe(1);
    expect(fetched?.artifacts.has("property_tests.ts")).toBe(true);
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
    await expect(registry.storeBlock(tamperedRow)).rejects.toThrow(/integrity check failed/);

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
    const artCount = (
      db2
        .prepare("SELECT COUNT(*) AS cnt FROM block_artifacts WHERE block_merkle_root = ?")
        .get(row.blockMerkleRoot) as { cnt: number }
    ).cnt;
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
    // biome-ignore lint/style/noNonNullAssertion: fetched asserted not-null above
    const fetchedBytes = fetched!.artifacts.get("property_tests.ts");
    expect(fetchedBytes).not.toBeUndefined();
    // Byte-identical: every byte must match.
    // biome-ignore lint/style/noNonNullAssertion: Map.get known non-null (same key used in storeBlock)
    expect(fetchedBytes!.length).toBe(originalBytes!.length);
    // biome-ignore lint/style/noNonNullAssertion: loop bound and index access on Uint8Array known non-null
    for (let i = 0; i < originalBytes!.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: both arrays verified non-null above
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
    await expect(registry.storeBlock(badRow)).rejects.toThrow(/integrity check failed/);
  });

  it("empty artifacts Map: stores and retrieves empty Map cleanly", async () => {
    // Build a row with an empty manifest and empty artifacts map.
    const spec = makeSpecYak("empty-artifacts");
    const manifest: ReturnType<typeof makeManifest> = { artifacts: [] };
    const artifacts = new Map<string, Uint8Array>();
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");
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
    expect(fetched?.artifacts.size).toBe(0);
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
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");
    const implSource = "export function legacy(): void {}";
    const manifest = { artifacts: [] as Array<{ kind: string; path: string }> };
    const artifacts = new Map<string, Uint8Array>();
    const root = bRoot({ spec, implSource, manifest: manifest as ProofManifest, artifacts });
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
    ).run(
      root,
      sh(spec),
      Buffer.from(specCanonicalBytes),
      implSource,
      JSON.stringify(manifest),
      "L0",
      Date.now(),
      cah(implSource),
    );
    // No corresponding block_artifacts rows inserted — simulates pre-WI-022 state.
    db.close();

    // Reopen and retrieve: must return empty artifacts Map.
    const reg2 = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched = await reg2.getBlock(root);
    await reg2.close();

    expect(fetched).not.toBeNull();
    expect(fetched?.artifacts).toBeInstanceOf(Map);
    expect(fetched?.artifacts.size).toBe(0);

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
    const rowA1 = makeBlockRow(
      specA,
      "export function f(x: string): number { return parseInt(x, 10); }",
      "// compound a1",
    );
    const rowA2 = makeBlockRow(
      specA,
      "export function f(x: string): number { return +x; }",
      "// compound a2",
    );
    // One block under specB.
    const rowB = makeBlockRow(
      specB,
      "export function f(n: number): string { return String(n); }",
      "// compound b",
    );

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

// ---------------------------------------------------------------------------
// WI-V2-BOOTSTRAP-01: exportManifest() — DEC-V2-BOOTSTRAP-MANIFEST-001
//
// exportManifest() is the primitive that WI-V2-BOOTSTRAP-03's `--verify` mode
// will compare against a committed `bootstrap/expected-roots.json`.
//
// Production sequence exercised:
//   openRegistry → storeBlock(rowWithImplAndManifest) → exportManifest()
//   → assert BootstrapManifestEntry[] sorted ASC by blockMerkleRoot
// ---------------------------------------------------------------------------

/**
 * Build a BlockTripletRow that includes 'impl.ts' and 'proof/manifest.json'
 * artifacts — the two paths that exportManifest() hashes for implSourceHash
 * and manifestJsonHash respectively.
 *
 * The artifact map includes BOTH paths so the exportManifest query hits each
 * of them in block_artifacts (WHERE path IN ('impl.ts', 'proof/manifest.json')).
 */
function makeBlockRowWithImplArtifacts(
  spec: SpecYak,
  implSource: string,
  implArtifactBytes: Uint8Array,
  manifestArtifactBytes: Uint8Array,
): BlockTripletRow {
  // Use property_tests kind for both — storeBlock does not call
  // validateProofManifestL0, so the L0 "exactly one property_tests" gate
  // is not enforced here. The key for exportManifest() is the artifact path.
  const manifest: ProofManifest = {
    artifacts: [
      { kind: "property_tests", path: "impl.ts" },
      { kind: "property_tests", path: "proof/manifest.json" },
    ],
  };
  const artifacts = new Map<string, Uint8Array>([
    ["impl.ts", implArtifactBytes],
    ["proof/manifest.json", manifestArtifactBytes],
  ]);
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

describe("exportManifest (WI-V2-BOOTSTRAP-01)", () => {
  it("returns empty array for empty registry", async () => {
    // No blocks stored — exportManifest must return [] without throwing.
    const entries = await registry.exportManifest();
    expect(entries).toEqual([]);
  });

  it("returns entries sorted by blockMerkleRoot ASC even when inserted out of order", async () => {
    // Construct three blocks whose merkle roots are NOT in insert order
    // when sorted lexicographically. We vary the impl source to control the root.
    // The sort is determined by BLAKE3 of the triplet content, which we can't
    // directly control, but we can insert in a known order and then assert the
    // returned array is the sorted version.
    const specA = makeSpecYak("sort-test-a", "sort test a");
    const specB = makeSpecYak("sort-test-b", "sort test b");
    const specC = makeSpecYak("sort-test-c", "sort test c");
    const rowA = makeBlockRow(specA, "export function a(): number { return 1; }", "// a");
    const rowB = makeBlockRow(specB, "export function b(): number { return 2; }", "// b");
    const rowC = makeBlockRow(specC, "export function c(): number { return 3; }", "// c");

    // Insert in B, C, A order — if exportManifest uses ORDER BY block_merkle_root
    // the result must be sorted regardless of insert order.
    await registry.storeBlock(rowB);
    await registry.storeBlock(rowC);
    await registry.storeBlock(rowA);

    const entries = await registry.exportManifest();
    expect(entries).toHaveLength(3);

    // Assert sorted ascending by blockMerkleRoot.
    const roots = entries.map((e) => e.blockMerkleRoot);
    const sortedRoots = [...roots].sort();
    expect(roots).toEqual(sortedRoots);

    // All three inserted roots must appear.
    expect(roots).toContain(rowA.blockMerkleRoot);
    expect(roots).toContain(rowB.blockMerkleRoot);
    expect(roots).toContain(rowC.blockMerkleRoot);
  });

  it("is deterministic across calls — two calls produce identical JSON", async () => {
    const specA = makeSpecYak("determ-a", "determinism a");
    const specB = makeSpecYak("determ-b", "determinism b");
    const specC = makeSpecYak("determ-c", "determinism c");
    const rowA = makeBlockRow(specA, "export function da(): void {}", "// da");
    const rowB = makeBlockRow(specB, "export function db(): void {}", "// db");
    const rowC = makeBlockRow(specC, "export function dc(): void {}", "// dc");

    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);
    await registry.storeBlock(rowC);

    const first = await registry.exportManifest();
    const second = await registry.exportManifest();

    // Byte-identical JSON serialisation proves determinism.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("entries carry valid implSourceHash and manifestJsonHash matching direct BLAKE3 of artifact bytes", async () => {
    // Build a block with known impl.ts and proof/manifest.json artifact bytes.
    const enc = new TextEncoder();
    const implBytes = enc.encode("export function hashTest(): string { return 'ok'; }");
    const manifestBytes = enc.encode(
      '{"artifacts":[{"kind":"source","path":"impl.ts"},{"kind":"property_tests","path":"proof/manifest.json"}]}',
    );

    const spec = makeSpecYak("hash-correctness", "hash correctness test");
    const implSource = "export function hashTest(): string { return 'ok'; }";
    const row = makeBlockRowWithImplArtifacts(spec, implSource, implBytes, manifestBytes);

    await registry.storeBlock(row);

    const entries = await registry.exportManifest();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();

    // Compute expected hashes via @noble/hashes blake3 directly.
    const { blake3 } = await import("@noble/hashes/blake3.js");
    function toHex(bytes: Uint8Array): string {
      let h = "";
      for (let i = 0; i < bytes.length; i++) {
        h += bytes[i]?.toString(16).padStart(2, "0");
      }
      return h;
    }

    const expectedImplHash = toHex(blake3(implBytes));
    const expectedManifestHash = toHex(blake3(manifestBytes));

    expect(entry?.implSourceHash).toBe(expectedImplHash);
    expect(entry?.manifestJsonHash).toBe(expectedManifestHash);
  });
});

// ---------------------------------------------------------------------------
// WI-V2-04 L2: Foreign-block schema v5 → v6 migration tests
// (DEC-V2-FOREIGN-BLOCK-SCHEMA-001 / WI-V2-04 L2)
//
// All tests below exercise the v5 → v6 migration path and the storage-layer
// primitives introduced in round 1 (kind/foreign_* columns, invariant guard,
// block_foreign_refs table, getForeignRefs reader).
//
// Required-path test list (evaluation contract):
//   L2-T1: Migration v5 → v6 applies cleanly on a real v5 fixture DB.
//   L2-T2: Re-running migration on an already-v6 DB is a no-op (idempotent).
//   L2-T3: Inserting kind='foreign' with NULL foreign_pkg is rejected by invariant guard.
//   L2-T4: Inserting kind='foreign' with well-formed foreign_pkg/foreign_export succeeds.
//   L2-T5: block_foreign_refs FK enforcement (valid ref accepted; orphan ref rejected).
//   L2-T6: getForeignRefs returns rows in declaration_index ASC; [] for no-ref blocks.
//   L2-T7: Pre-migration rows hydrate with kind='local' (backwards compat).
// ---------------------------------------------------------------------------

describe("WI-V2-04 L2: migration v5 → v6 and foreign-block primitives", () => {
  /**
   * L2-T1: Migration v5 → v6 applies cleanly on a real v5 fixture DB.
   *
   * Production sequence:
   *   1. Open a fresh better-sqlite3 in-memory DB.
   *   2. Apply all migrations UP TO v5 (applyMigrations up to and including
   *      MIGRATION_5_DDL) by building the DB state manually with the same
   *      SQL as the real migration driver, then fixing version at 5.
   *   3. Insert a few representative rows so we can verify row-count preservation
   *      and that existing block_artifacts rows are intact after v5 → v6.
   *   4. Run the v5 → v6 migration (applyMigrations on the same DB).
   *   5. Assert: row count preserved; existing rows have kind='local'; existing
   *      block_artifacts rows intact; schema_version = 6.
   *
   * This test satisfies the "real DB, no mocks" requirement from the dispatch.
   * The DB instance is a genuine better-sqlite3 Database — not a mock.
   */
  it("L2-T1: migration v5→v6 applies on real v5 fixture DB; rows preserved; kind='local'; artifacts intact", async () => {
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    // Build a v5-shaped DB directly (mirrors what applyMigrations does for
    // migrations 0–5 but freezes schema_version at 5 so the v6 migration
    // hasn't run yet). We use a real in-memory DB — no mocks.
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Minimal v5 bootstrap: schema_version + blocks + block_artifacts tables.
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    db.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (0)");
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS contract_embeddings USING vec0(
      spec_hash TEXT PRIMARY KEY, embedding FLOAT[384]
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS blocks (
      block_merkle_root    TEXT    PRIMARY KEY,
      spec_hash            TEXT    NOT NULL,
      spec_canonical_bytes BLOB    NOT NULL,
      impl_source          TEXT    NOT NULL,
      proof_manifest_json  TEXT    NOT NULL,
      level                TEXT    NOT NULL CHECK(level IN ('L0','L1','L2','L3')),
      created_at           INTEGER NOT NULL,
      canonical_ast_hash   TEXT    NOT NULL DEFAULT '',
      parent_block_root    TEXT    NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_spec_hash ON blocks(spec_hash)");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_blocks_canonical_ast_hash ON blocks(canonical_ast_hash)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_parent_block_root ON blocks(parent_block_root)");
    db.exec(`CREATE TABLE IF NOT EXISTS test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_merkle_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      suite_id TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_exposure (
      block_merkle_root TEXT PRIMARY KEY REFERENCES blocks(block_merkle_root),
      requests_seen INTEGER NOT NULL DEFAULT 0, last_seen INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS strictness_edges (
      stricter_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      looser_root TEXT NOT NULL REFERENCES blocks(block_merkle_root),
      created_at INTEGER NOT NULL, PRIMARY KEY (stricter_root, looser_root)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS block_artifacts (
      block_merkle_root TEXT    NOT NULL REFERENCES blocks(block_merkle_root),
      path              TEXT    NOT NULL,
      bytes             BLOB    NOT NULL,
      declaration_index INTEGER NOT NULL,
      PRIMARY KEY (block_merkle_root, path)
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_block_artifacts_block_merkle_root ON block_artifacts(block_merkle_root)",
    );
    // Freeze at v5.
    db.prepare("UPDATE schema_version SET version = ?").run(5);

    // Insert two representative v5 rows.
    const specA = makeSpecYak("l2-v5-block-a");
    const rowA = makeBlockRow(specA);
    const specB = makeSpecYak("l2-v5-block-b");
    const rowB = makeBlockRow(specB, "export function b(): void {}");

    for (const row of [rowA, rowB]) {
      db.prepare(
        "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash, parent_block_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(
        row.blockMerkleRoot,
        row.specHash,
        Buffer.from(row.specCanonicalBytes),
        row.implSource,
        row.proofManifestJson,
        row.level,
        row.createdAt,
        row.canonicalAstHash,
      );
      // Insert one block_artifacts row per block (simulates WI-022 v5 state).
      db.prepare(
        "INSERT INTO block_artifacts(block_merkle_root, path, bytes, declaration_index) VALUES (?, ?, ?, ?)",
      ).run(row.blockMerkleRoot, "property_tests.ts", Buffer.from("// tests"), 0);
    }

    // Verify pre-migration state: version=5, no kind column, 2 blocks, 2 artifact rows.
    const vPre = (
      db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(vPre).toBe(5);
    const colsPre = (db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(colsPre).not.toContain("kind");

    const blockCountPre = (
      db.prepare("SELECT COUNT(*) AS cnt FROM blocks").get() as { cnt: number }
    ).cnt;
    expect(blockCountPre).toBe(2);
    const artCountPre = (
      db.prepare("SELECT COUNT(*) AS cnt FROM block_artifacts").get() as { cnt: number }
    ).cnt;
    expect(artCountPre).toBe(2);

    // Apply the migration — applyMigrations on a v5 DB runs only the v5 → v6 step.
    const { applyMigrations } = await import("./schema.js");
    applyMigrations(db);

    // Post-migration assertions.
    const vPost = (
      db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(vPost).toBe(6);

    // kind column now present.
    const colsPost = (db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(colsPost).toContain("kind");
    expect(colsPost).toContain("foreign_pkg");
    expect(colsPost).toContain("foreign_export");
    expect(colsPost).toContain("foreign_dts_hash");

    // block_foreign_refs table present.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toContain("block_foreign_refs");

    // Row count preserved (no rows dropped).
    const blockCountPost = (
      db.prepare("SELECT COUNT(*) AS cnt FROM blocks").get() as { cnt: number }
    ).cnt;
    expect(blockCountPost).toBe(2);

    // Existing rows have kind='local' (DEFAULT 'local' applied at migration time).
    const kinds = (
      db.prepare("SELECT kind FROM blocks ORDER BY block_merkle_root").all() as Array<{
        kind: string;
      }>
    ).map((r) => r.kind);
    expect(kinds).toEqual(["local", "local"]);

    // Existing block_artifacts rows from v5 are intact (WI-022 rows preserved).
    const artCountPost = (
      db.prepare("SELECT COUNT(*) AS cnt FROM block_artifacts").get() as { cnt: number }
    ).cnt;
    expect(artCountPost).toBe(2);

    db.close();
  });

  /**
   * L2-T2: Re-running migration on an already-v6 DB is a no-op.
   *
   * Ensures applyMigrations is idempotent on a fully-migrated v6 DB. No errors;
   * schema_version stays at 6. Matches the MIGRATION_3/4 idempotency pattern.
   */
  it("L2-T2: re-running applyMigrations on a v6 DB is a no-op (idempotent)", async () => {
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const { applyMigrations, SCHEMA_VERSION } = await import("./schema.js");

    const db = new Database(":memory:");
    sqliteVec.load(db);

    // First run — migrates from 0 to 6.
    applyMigrations(db);
    const vAfterFirst = (
      db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(vAfterFirst).toBe(6);
    expect(SCHEMA_VERSION).toBe(6);

    // Second run — must be a complete no-op; no throws; version stays at 6.
    expect(() => applyMigrations(db)).not.toThrow();
    const vAfterSecond = (
      db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }
    ).version;
    expect(vAfterSecond).toBe(6);

    // Verify column count is stable (no duplicate columns created).
    const cols = (db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // kind column appears exactly once.
    expect(cols.filter((c) => c === "kind")).toHaveLength(1);
    // foreign_pkg appears exactly once.
    expect(cols.filter((c) => c === "foreign_pkg")).toHaveLength(1);

    db.close();
  });

  /**
   * L2-T3: Inserting a foreign row with NULL foreign_pkg is rejected.
   *
   * The L2-I3 invariant guard in storeBlock() must throw when
   * kind='foreign' and foreignPkg is null/undefined. This is the single
   * enforcement path (storage-layer guard, not SQL CHECK constraint).
   */
  it("L2-T3: storeBlock rejects kind='foreign' row with null foreignPkg (L2-I3 guard)", async () => {
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");

    // Build a foreign-shaped row where foreignPkg is null (invariant violation).
    const spec = makeSpecYak("l2-foreign-null-pkg");
    const specCanonicalBytes = canon(spec as unknown as Parameters<typeof canon>[0]);
    // For a foreign block, the merkle root is computed from (kind, pkg, export).
    // We must compute a valid root to avoid the integrity check running first.
    // Supply a placeholder that would produce a valid foreign root computation.
    const foreignPkg = "ts-morph"; // non-null for root computation
    const foreignExport = "Project";
    const root = bRoot({ kind: "foreign", pkg: foreignPkg, export: foreignExport });

    const rowWithNullPkg: BlockTripletRow = {
      blockMerkleRoot: root,
      specHash: sh(spec),
      specCanonicalBytes,
      implSource: "",
      proofManifestJson: "{}",
      level: "L0",
      createdAt: Date.now(),
      canonicalAstHash: cah("") as ReturnType<typeof cah>,
      artifacts: new Map(),
      kind: "foreign",
      foreignPkg: null, // ← invariant violation: must be non-null for kind='foreign'
      foreignExport,
    };

    await expect(registry.storeBlock(rowWithNullPkg)).rejects.toThrow(
      /L2-I3|foreign_invariant_failed|foreign.*requires/i,
    );
  });

  /**
   * L2-T4: Inserting a well-formed foreign row succeeds.
   *
   * Verifies that a foreign block with non-null foreignPkg and foreignExport
   * stores successfully and hydrates back with kind='foreign'.
   */
  it("L2-T4: storeBlock accepts kind='foreign' row with non-null foreignPkg and foreignExport", async () => {
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");

    const spec = makeSpecYak("l2-foreign-valid-row");
    const specCanonicalBytes = canon(spec as unknown as Parameters<typeof canon>[0]);
    const foreignPkg = "ts-morph";
    const foreignExport = "Project";

    // Compute the correct foreign merkle root.
    const root = bRoot({ kind: "foreign", pkg: foreignPkg, export: foreignExport });

    const foreignRow: BlockTripletRow = {
      blockMerkleRoot: root,
      specHash: sh(spec),
      specCanonicalBytes,
      implSource: "",
      proofManifestJson: "{}",
      level: "L0",
      createdAt: Date.now(),
      canonicalAstHash: cah("") as ReturnType<typeof cah>,
      artifacts: new Map(),
      kind: "foreign",
      foreignPkg,
      foreignExport,
      foreignDtsHash: null,
    };

    // Must not throw.
    await expect(registry.storeBlock(foreignRow)).resolves.toBeUndefined();

    // Hydrated row must have kind='foreign' and correct foreign fields.
    const fetched = await registry.getBlock(root);
    expect(fetched).not.toBeNull();
    expect(fetched?.kind).toBe("foreign");
    expect(fetched?.foreignPkg).toBe(foreignPkg);
    expect(fetched?.foreignExport).toBe(foreignExport);
    expect(fetched?.foreignDtsHash).toBeNull();
  });

  /**
   * L2-T5: block_foreign_refs FK enforcement.
   *
   * Inserts a parent block, then:
   *   a) Inserts a valid block_foreign_refs row referencing the parent root → success.
   *   b) Inserts a block_foreign_refs row referencing a non-existent root → FOREIGN KEY
   *      violation (better-sqlite3 surfaces this as SqliteError with message containing
   *      "FOREIGN KEY constraint failed").
   *
   * Both operations use raw SQL to exercise the table constraint directly, bypassing
   * the storage-layer API (which does not yet have a writeForeignRef() method in L2).
   */
  it("L2-T5: block_foreign_refs accepts valid FK refs; rejects refs to non-existent roots", async () => {
    // We need direct DB access to insert into block_foreign_refs.
    // Open a fresh file-backed DB so we can test FK constraints with
    // foreign_keys = ON (which openRegistry enables).
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-fk-test-"));
    const dbPath = join(tmpDir, "fk.sqlite");

    const { openRegistry: openReg } = await import("./storage.js");
    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });

    // Store a parent block (local) — this creates the FK target for block_foreign_refs.
    const parentSpec = makeSpecYak("l2-fk-parent");
    const parentRow = makeBlockRow(parentSpec);
    await reg.storeBlock(parentRow);

    // Store a foreign block — this is the FK target in foreign_block_root.
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");
    const foreignSpec = makeSpecYak("l2-fk-foreign");
    const foreignSpecBytes = canon(foreignSpec as unknown as Parameters<typeof canon>[0]);
    const foreignPkg = "node:fs";
    const foreignExport = "readFileSync";
    const foreignRoot = bRoot({ kind: "foreign", pkg: foreignPkg, export: foreignExport });
    const foreignRow: BlockTripletRow = {
      blockMerkleRoot: foreignRoot,
      specHash: sh(foreignSpec),
      specCanonicalBytes: foreignSpecBytes,
      implSource: "",
      proofManifestJson: "{}",
      level: "L0",
      createdAt: Date.now(),
      canonicalAstHash: cah("") as ReturnType<typeof cah>,
      artifacts: new Map(),
      kind: "foreign",
      foreignPkg,
      foreignExport,
    };
    await reg.storeBlock(foreignRow);
    await reg.close();

    // Now open a direct DB handle (foreign_keys = ON is the openRegistry default).
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.pragma("foreign_keys = ON");

    // Case A: valid insert — both parent and foreign roots exist in blocks.
    expect(() => {
      db.prepare(
        "INSERT INTO block_foreign_refs(parent_block_root, foreign_block_root, declaration_index) VALUES (?, ?, ?)",
      ).run(parentRow.blockMerkleRoot, foreignRoot, 0);
    }).not.toThrow();

    // Verify the row was inserted.
    const inserted = db
      .prepare("SELECT * FROM block_foreign_refs WHERE parent_block_root = ?")
      .all(parentRow.blockMerkleRoot) as Array<{ declaration_index: number }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.declaration_index).toBe(0);

    // Case B: invalid insert — foreign_block_root references a non-existent block.
    const ghostRoot = "a".repeat(64);
    expect(() => {
      db.prepare(
        "INSERT INTO block_foreign_refs(parent_block_root, foreign_block_root, declaration_index) VALUES (?, ?, ?)",
      ).run(parentRow.blockMerkleRoot, ghostRoot, 1);
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * L2-T6: getForeignRefs returns rows in declaration_index ASC; [] for no-ref blocks.
   *
   * Inserts 3 block_foreign_refs rows for a parent block in non-sequential
   * declaration_index order (2, 0, 1), calls getForeignRefs(), and asserts
   * the returned rows are sorted 0, 1, 2.
   *
   * Also verifies that getForeignRefs on a block with no refs returns [].
   */
  it("L2-T6: getForeignRefs returns rows in declaration_index ASC; [] for blocks with no refs", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-getforeign-test-"));
    const dbPath = join(tmpDir, "getforeign.sqlite");

    const { openRegistry: openReg } = await import("./storage.js");
    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });

    // Store a parent block (local).
    const parentSpec = makeSpecYak("l2-getforeign-parent");
    const parentRow = makeBlockRow(parentSpec);
    await reg.storeBlock(parentRow);

    // Store 3 foreign blocks with distinct (pkg, export) pairs.
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");

    type ForeignMeta = { pkg: string; export: string };
    const foreignMetas: ForeignMeta[] = [
      { pkg: "node:fs", export: "readFileSync" },
      { pkg: "node:path", export: "join" },
      { pkg: "ts-morph", export: "Project" },
    ];
    const foreignRoots: string[] = [];

    for (const meta of foreignMetas) {
      const fSpec = makeSpecYak(`l2-getforeign-foreign-${meta.export}`);
      const fRoot = bRoot({ kind: "foreign", pkg: meta.pkg, export: meta.export });
      foreignRoots.push(fRoot);
      await reg.storeBlock({
        blockMerkleRoot: fRoot,
        specHash: sh(fSpec),
        specCanonicalBytes: canon(fSpec as unknown as Parameters<typeof canon>[0]),
        implSource: "",
        proofManifestJson: "{}",
        level: "L0",
        createdAt: Date.now(),
        canonicalAstHash: cah("") as ReturnType<typeof cah>,
        artifacts: new Map(),
        kind: "foreign",
        foreignPkg: meta.pkg,
        foreignExport: meta.export,
      });
    }

    await reg.close();

    // Open a direct handle to insert block_foreign_refs in non-sequential order.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.pragma("foreign_keys = ON");

    // Insert in declaration_index order: 2, 0, 1 (deliberately out of order).
    const insertRef = db.prepare(
      "INSERT INTO block_foreign_refs(parent_block_root, foreign_block_root, declaration_index) VALUES (?, ?, ?)",
    );
    insertRef.run(parentRow.blockMerkleRoot, foreignRoots[2], 2);
    insertRef.run(parentRow.blockMerkleRoot, foreignRoots[0], 0);
    insertRef.run(parentRow.blockMerkleRoot, foreignRoots[1], 1);
    db.close();

    // Reopen via registry API and call getForeignRefs.
    const reg2 = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });

    // getForeignRefs must return rows ordered by declaration_index ASC.
    const refs = await reg2.getForeignRefs(parentRow.blockMerkleRoot);
    expect(refs).toHaveLength(3);
    expect(refs[0]?.declarationIndex).toBe(0);
    expect(refs[1]?.declarationIndex).toBe(1);
    expect(refs[2]?.declarationIndex).toBe(2);

    // Verify FK integrity: each returned foreignBlockRoot matches the inserted root
    // at that declaration_index.
    expect(refs[0]?.foreignBlockRoot).toBe(foreignRoots[0]);
    expect(refs[1]?.foreignBlockRoot).toBe(foreignRoots[1]);
    expect(refs[2]?.foreignBlockRoot).toBe(foreignRoots[2]);

    // A block with no foreign refs returns [].
    const noRefBlock = makeBlockRow(makeSpecYak("l2-no-refs-block"));
    await reg2.storeBlock(noRefBlock);
    const emptyRefs = await reg2.getForeignRefs(noRefBlock.blockMerkleRoot);
    expect(emptyRefs).toEqual([]);

    await reg2.close();
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  /**
   * L2-T7: Backwards compatibility — pre-migration rows hydrate with kind='local'.
   *
   * Inserts a row using raw SQL with only the legacy column set (no kind column;
   * the DEFAULT 'local' covers it). Reads it back via getBlock / BlockTripletRow
   * and asserts that kind === 'local'.
   *
   * This proves that the DEFAULT 'local' contract holds at the storage hydration
   * layer — no pre-v6 row will be incorrectly marked 'foreign'.
   */
  it("L2-T7: pre-v6 rows (legacy column set) hydrate with kind='local' (backwards compat)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "yakcc-backcompat-test-"));
    const dbPath = join(tmpDir, "backcompat.sqlite");

    const { openRegistry: openReg } = await import("./storage.js");
    // Open registry (applies migrations 0→6).
    const reg = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    await reg.close();

    // Insert a block via raw SQL, omitting the kind/foreign_* columns to simulate
    // a row written by a v5 (pre-migration-6) writer that had no knowledge of the
    // kind column. The DEFAULT 'local' in the column definition must backfill this.
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(dbPath);
    sqliteVec.load(db);

    const spec = makeSpecYak("l2-backcompat-block");
    const {
      blockMerkleRoot: bRoot,
      canonicalize: canon,
      canonicalAstHash: cah,
      specHash: sh,
    } = await import("@yakcc/contracts");
    const implSource = "export function backcompat(): void {}";
    const manifest = { artifacts: [] as Array<{ kind: string; path: string }> };
    const artifacts = new Map<string, Uint8Array>();
    const root = bRoot({
      spec,
      implSource,
      manifest: manifest as import("@yakcc/contracts").ProofManifest,
      artifacts,
    });
    const specCanonicalBytes = canon(spec as unknown as Parameters<typeof canon>[0]);

    // Raw SQL insert without kind/foreign_* columns — they default to 'local'/NULL.
    db.prepare(
      "INSERT INTO blocks(block_merkle_root, spec_hash, spec_canonical_bytes, impl_source, proof_manifest_json, level, created_at, canonical_ast_hash, parent_block_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      root,
      sh(spec),
      Buffer.from(specCanonicalBytes),
      implSource,
      JSON.stringify(manifest),
      "L0",
      Date.now(),
      cah(implSource),
    );
    db.close();

    // Reopen via registry API; getBlock must return kind='local' for the raw-inserted row.
    const reg2 = await openReg(dbPath, { embeddings: mockEmbeddingProvider() });
    const fetched = await reg2.getBlock(root);
    await reg2.close();

    expect(fetched).not.toBeNull();
    // kind must be 'local' — the DEFAULT ensures pre-v6 rows are correctly labelled.
    expect(fetched?.kind).toBe("local");
    // foreign fields must be null — no foreign identity for a local block.
    expect(fetched?.foreignPkg).toBeNull();
    expect(fetched?.foreignExport).toBeNull();
    expect(fetched?.foreignDtsHash).toBeNull();

    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);
});
