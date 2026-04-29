/**
 * storage.test.ts — SQLite-backed registry round-trip and integration tests.
 *
 * All tests use ":memory:" databases to avoid disk I/O. The mock embedding
 * provider returns deterministic 384-dim vectors without loading ONNX, making
 * the test suite fast and offline-capable.
 *
 * Production sequence exercised:
 *   openRegistry → store(contract, impl) → match(spec) → search(spec, k)
 *   → getProvenance(id) → close()
 *
 * This is the canonical call sequence used by the CLI's `yakcc registry init`
 * and `yakcc search` commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { contractId, canonicalize } from "@yakcc/contracts";
import type {
  Contract,
  ContractSpec,
  EmbeddingProvider,
} from "@yakcc/contracts";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { openRegistry } from "./storage.js";
import type { Registry, Implementation } from "./index.js";

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
      // Simple deterministic fill: spread chars of text across dimensions.
      for (let i = 0; i < 384; i++) {
        const charCode = text.charCodeAt(i % text.length) / 128;
        vec[i] = charCode + i * 0.001;
      }
      // Normalize to unit length for cosine-style distances.
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

function makeSpec(behavior = "Parse a JSON integer"): ContractSpec {
  return {
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    behavior,
    guarantees: [{ id: "total", description: "Always returns or throws." }],
    errorConditions: [
      { description: "Throws SyntaxError on malformed input", errorType: "SyntaxError" },
    ],
    nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(n)", space: "O(1)" },
    propertyTests: [],
  };
}

function makeContract(spec: ContractSpec): Contract {
  return {
    id: contractId(spec),
    spec,
    evidence: { testHistory: [] },
  };
}

function makeImpl(contract: Contract, source = "export function f(x: string): number { return parseInt(x, 10); }"): Implementation {
  const bytes = new TextEncoder().encode(source);
  const digest = blake3(bytes);
  return {
    source,
    blockId: bytesToHex(digest),
    contractId: contract.id,
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
// Round-trip: store → match
// ---------------------------------------------------------------------------

describe("store and match", () => {
  it("stores a contract and retrieves it by exact spec hash", async () => {
    const spec = makeSpec();
    const contract = makeContract(spec);
    const impl = makeImpl(contract);

    await registry.store(contract, impl);

    const match = await registry.match(spec);
    expect(match).not.toBeNull();
    expect(match?.contract.id).toBe(contract.id);
    expect(match?.score).toBe(1.0);
  });

  it("returns null for a spec not in the registry", async () => {
    const spec = makeSpec("A spec that was never stored");
    const result = await registry.match(spec);
    expect(result).toBeNull();
  });

  it("match is idempotent: storing twice returns the same contract", async () => {
    const spec = makeSpec();
    const contract = makeContract(spec);
    const impl = makeImpl(contract);

    await registry.store(contract, impl);
    await registry.store(contract, impl); // second store — must not throw

    const match = await registry.match(spec);
    expect(match?.contract.id).toBe(contract.id);
  });

  it("stores multiple distinct contracts and retrieves each independently", async () => {
    const specA = makeSpec("Parse integer");
    const specB = makeSpec("Match bracket character");
    const contractA = makeContract(specA);
    const contractB = makeContract(specB);

    await registry.store(contractA, makeImpl(contractA));
    await registry.store(contractB, makeImpl(contractB));

    const matchA = await registry.match(specA);
    const matchB = await registry.match(specB);

    expect(matchA?.contract.id).toBe(contractA.id);
    expect(matchB?.contract.id).toBe(contractB.id);
    expect(matchA?.contract.id).not.toBe(matchB?.contract.id);
  });
});

// ---------------------------------------------------------------------------
// search — vector k-NN
// ---------------------------------------------------------------------------

describe("search", () => {
  it("returns the stored contract in the top-k for the same spec", async () => {
    const spec = makeSpec("Parse JSON integer list");
    const contract = makeContract(spec);
    await registry.store(contract, makeImpl(contract));

    const candidates = await registry.search(spec, 5);
    expect(candidates.length).toBeGreaterThan(0);
    const ids = candidates.map((c) => c.match.contract.id);
    expect(ids).toContain(contract.id);
  });

  it("returns empty array when registry is empty", async () => {
    const spec = makeSpec();
    const results = await registry.search(spec, 5);
    expect(results).toEqual([]);
  });

  it("returns at most k results", async () => {
    // Store 5 contracts.
    for (let i = 0; i < 5; i++) {
      const spec = makeSpec(`behavior variant ${i}`);
      const contract = makeContract(spec);
      await registry.store(contract, makeImpl(contract));
    }
    const results = await registry.search(makeSpec("behavior variant 0"), 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("search results carry an implementation with source", async () => {
    const spec = makeSpec();
    const contract = makeContract(spec);
    const source = "export function parse(s: string): number { return Number(s); }";
    const impl = makeImpl(contract, source);
    await registry.store(contract, impl);

    const candidates = await registry.search(spec, 1);
    expect(candidates.length).toBeGreaterThan(0);
    const first = candidates[0];
    expect(first?.implementation.source).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// getProvenance
// ---------------------------------------------------------------------------

describe("getProvenance", () => {
  it("returns empty arrays for a fresh contract with no evidence", async () => {
    const spec = makeSpec();
    const contract = makeContract(spec);
    await registry.store(contract, makeImpl(contract));

    const prov = await registry.getProvenance(contract.id);
    expect(prov.testHistory).toEqual([]);
    expect(prov.runtimeExposure).toEqual([]);
  });

  it("returns empty provenance for an id not in the registry", async () => {
    // Use a syntactically valid but unregistered id.
    const fakeId = "a".repeat(64) as ReturnType<typeof contractId>;
    const prov = await registry.getProvenance(fakeId);
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

  it("throws after close on store", async () => {
    const spec = makeSpec();
    const contract = makeContract(spec);
    await registry.close();
    await expect(registry.store(contract, makeImpl(contract))).rejects.toThrow(
      "Registry has been closed",
    );
    registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  });
});

// ---------------------------------------------------------------------------
// Schema migrations are idempotent
// ---------------------------------------------------------------------------

describe("schema migrations", () => {
  it("applying migrations twice to the same DB is a no-op", async () => {
    // The second openRegistry call on ":memory:" would be a separate DB,
    // so we test idempotency by calling applyMigrations directly.
    const { applyMigrations } = await import("./schema.js");
    const Database = (await import("better-sqlite3")).default;
    const sqliteVec = await import("sqlite-vec");

    const db = new Database(":memory:");
    sqliteVec.load(db);
    applyMigrations(db); // first application
    applyMigrations(db); // second — must not throw

    // Verify schema_version was set correctly.
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(1);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence integration test
// ---------------------------------------------------------------------------

describe("production sequence: store → search → select → provenance", () => {
  it("full end-to-end: stores two contracts, searches, selects best", async () => {
    // Two structurally identical specs (same types) but different behaviors.
    // Only the exact-match spec should pass structural matching.
    const spec = makeSpec("Parse integer from string");
    const contractA = makeContract(spec);

    // A looser spec that structurally matches (same types).
    const looserSpec: ContractSpec = {
      ...spec,
      behavior: "Parse number from string, looser version",
    };
    const contractB = makeContract(looserSpec);

    await registry.store(contractA, makeImpl(contractA, "export function f(s: string): number { return parseInt(s, 10); }"));
    await registry.store(contractB, makeImpl(contractB, "export function g(s: string): number { return parseFloat(s); }"));

    // search returns candidates structurally matching spec.
    const candidates = await registry.search(spec, 10);
    expect(candidates.length).toBeGreaterThan(0);

    // select picks deterministically.
    const matches = candidates.map((c) => c.match);
    const selected = registry.select(matches);
    expect(selected).toBeDefined();
    expect(typeof selected.contract.id).toBe("string");
    expect(selected.contract.id).toHaveLength(64);

    // provenance returns empty for a fresh contract.
    const prov = await registry.getProvenance(selected.contract.id);
    expect(prov).toBeDefined();
    expect(Array.isArray(prov.testHistory)).toBe(true);

    // canonical_bytes round-trip: the stored contract spec must re-derive the
    // same id when canonicalized.
    const rederived = contractId(selected.contract.spec);
    expect(rederived).toBe(selected.contract.id);
  });
});

// ---------------------------------------------------------------------------
// contractId stability (content-address round-trip)
// ---------------------------------------------------------------------------

describe("content-address round-trip", () => {
  it("contract id is stable across store and retrieve", async () => {
    const spec = makeSpec("Deterministic spec");
    const expected = contractId(spec);
    const contract = makeContract(spec);

    await registry.store(contract, makeImpl(contract));
    const match = await registry.match(spec);

    expect(match?.contract.id).toBe(expected);
  });

  it("canonical_bytes are consistent: re-canonicalizing stored spec produces same id", async () => {
    const spec = makeSpec("Canonicalization round-trip check");
    const contract = makeContract(spec);
    await registry.store(contract, makeImpl(contract));

    const match = await registry.match(spec);
    expect(match).not.toBeNull();
    if (match === null) return;

    // Re-derive from the returned spec.
    const storedSpec = match.contract.spec;
    const reCanonical = canonicalize(storedSpec);
    const { contractIdFromBytes } = await import("@yakcc/contracts");
    const reId = contractIdFromBytes(reCanonical);
    expect(reId).toBe(contract.id);
  });
});
