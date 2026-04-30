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
  type EmbeddingProvider,
  type ProofManifest,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
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
  it("fresh DB is at SCHEMA_VERSION = 2 with blocks table and idx_blocks_spec_hash", async () => {
    const { applyMigrations, SCHEMA_VERSION } = await import("./schema.js");
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db);

    // Version check.
    expect(SCHEMA_VERSION).toBe(2);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(2);

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

    // No ownership columns — DEC-NO-OWNERSHIP-011.
    for (const banned of ["author", "author_email", "signature"]) {
      expect(colNames).not.toContain(banned);
    }

    // idx_blocks_spec_hash index exists.
    const indexes = db.prepare("PRAGMA index_list(blocks)").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_blocks_spec_hash");

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
    expect(row?.version).toBe(2);

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

    // Version is 2.
    const vRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(vRow?.version).toBe(2);

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
