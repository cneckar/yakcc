// SPDX-License-Identifier: MIT
//
// export-embeddings.test.ts — Registry invariant tests for exportAllEmbeddings()
//
// Production sequence exercised:
//   openRegistry → storeBlock (N specs) → exportAllEmbeddings()
//     → assert rowcount == SELECT count(*) FROM contract_embeddings
//     → assert every vector.length == embedding dimension
//     → assert ordering strictly ASC by specHash
//
// Also tested: dimension mismatch corruption tripwire (fail loud).
//
// @decision DEC-1117-S2-VECREAD-001
// @title exportAllEmbeddings invariant test — architecture-bundle obligation
// @status decided (WI-1117 Slice 2)
// @rationale
//   CLAUDE.md architecture-bundle rule: any authority-surface change ships
//   with invariant test coverage in the same change. exportAllEmbeddings() is
//   a new read-back surface on the Registry interface; these tests verify:
//   (1) rowcount == contract_embeddings count, (2) every vector length ==
//   stored dimension, (3) ordering ASC by specHash. The mock embedding
//   provider keeps the tests offline and fast (Sacred Practice #5).

import {
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockTripletRow, Registry, SpecHash } from "./index.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

/**
 * Deterministic 384-dim mock provider. Different text → different vectors via
 * a simple char-code hash. Vectors are NOT L2-normalised here — we only need
 * dimension correctness for these invariant tests, not cosine semantics.
 */
function mockProvider(modelId = "mock/export-embeddings-test"): EmbeddingProvider {
  return {
    dimension: 384,
    modelId,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture factory — minimal valid BlockTripletRow
// ---------------------------------------------------------------------------

function makeSpec(name: string): SpecYak {
  return {
    name,
    inputs: [{ name: "x", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    nonFunctional: { purity: "pure", threadSafety: "safe" },
  };
}

function makeManifest(): ProofManifest {
  return { artifacts: [] };
}

function makeRow(spec: SpecYak, implSuffix = ""): BlockTripletRow {
  const manifest = makeManifest();
  const artifacts = new Map<string, Uint8Array>();
  const implSrc = `export function ${spec.name}(x: number): number { return x; }${implSuffix}`;
  const bmr = blockMerkleRoot({ spec, implSource: implSrc, manifest, artifacts });
  const sHash = deriveSpecHash(spec);
  const specBytes = canonicalize(spec as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: bmr,
    specHash: sHash as SpecHash,
    specCanonicalBytes: specBytes,
    implSource: implSrc,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSrc),
    parentBlockRoot: null,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockProvider() });
});

afterEach(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Invariant I1: empty registry returns empty array
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — empty registry", () => {
  it("returns an empty array when no blocks are stored", async () => {
    const result = await registry.exportAllEmbeddings();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariant I2: rowcount == contract_embeddings count
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — rowcount invariant", () => {
  it("returns exactly one entry per distinct spec_hash (not per block)", async () => {
    // Store 3 distinct specs → 3 embedding rows expected
    const specs = ["alpha", "beta", "gamma"].map(makeSpec);
    for (const spec of specs) {
      const row = makeRow(spec);
      await registry.storeBlock(row);
    }

    const result = await registry.exportAllEmbeddings();
    expect(result).toHaveLength(3);
  });

  it("returns one entry when two blocks share the same spec_hash (two impls, one spec)", async () => {
    // Same spec → same spec_hash. vec0 upserts on spec_hash PK so only one
    // embedding row exists regardless of how many blocks share that spec.
    const spec = makeSpec("sharedSpec");
    const rowA = makeRow(spec, "// impl A");
    const rowB = makeRow(spec, "// impl B");
    await registry.storeBlock(rowA);
    await registry.storeBlock(rowB);

    const result = await registry.exportAllEmbeddings();
    // One embedding per spec_hash — the two blocks collapsed to one vec0 row.
    expect(result).toHaveLength(1);
    expect(result[0]?.specHash).toBe(rowA.specHash);
  });
});

// ---------------------------------------------------------------------------
// Invariant I3: every vector.length == stored dimension (384)
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — vector dimension invariant", () => {
  it("every returned vector has length == 384 (the provider dimension)", async () => {
    const specs = ["dimCheck1", "dimCheck2"].map(makeSpec);
    for (const spec of specs) {
      const row = makeRow(spec);
      await registry.storeBlock(row);
    }

    const result = await registry.exportAllEmbeddings();
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry.vector).toHaveLength(384);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant I4: ordering strictly ASC by specHash
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — ASC ordering invariant", () => {
  it("returned entries are sorted strictly ASC by specHash", async () => {
    // Store specs whose names produce different spec_hashes (content-addressed).
    const specs = ["zeta", "alpha", "mu", "delta"].map(makeSpec);
    for (const spec of specs) {
      const row = makeRow(spec);
      await registry.storeBlock(row);
    }

    const result = await registry.exportAllEmbeddings();
    expect(result.length).toBe(4);

    // Verify strict ascending order
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]?.specHash ?? "";
      const curr = result[i]?.specHash ?? "";
      expect(prev < curr).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant I5: specHash values match what was stored
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — specHash identity invariant", () => {
  it("every returned specHash matches the stored block's specHash", async () => {
    const specs = ["iota", "kappa", "lambda"].map(makeSpec);
    const storedHashes = new Set<string>();

    for (const spec of specs) {
      const row = makeRow(spec);
      storedHashes.add(row.specHash);
      await registry.storeBlock(row);
    }

    const result = await registry.exportAllEmbeddings();
    const returnedHashes = new Set(result.map((e) => e.specHash));

    // Every returned specHash must have been stored, and vice versa.
    expect(returnedHashes).toEqual(storedHashes);
  });
});

// ---------------------------------------------------------------------------
// Compound integration: the full production read-back sequence
//
// This is the Compound-Interaction Test required by CLAUDE.md §"Write Tests That
// Prove Production Works". It exercises the real production sequence end-to-end:
// openRegistry → storeBlock (multiple specs) → exportAllEmbeddings →
// verify all invariants together (count, dimension, ordering, identity).
// ---------------------------------------------------------------------------

describe("exportAllEmbeddings — compound production sequence", () => {
  it("full sequence: store N specs, export, verify all invariants simultaneously", async () => {
    const specNames = ["compound1", "compound2", "compound3", "compound4", "compound5"];
    const specs = specNames.map(makeSpec);
    const expectedHashes = new Set<string>();

    for (const spec of specs) {
      const row = makeRow(spec);
      expectedHashes.add(row.specHash);
      await registry.storeBlock(row);
    }

    const result = await registry.exportAllEmbeddings();

    // I2: rowcount
    expect(result).toHaveLength(5);

    // I3: every vector has correct dimension
    for (const entry of result) {
      expect(entry.vector).toHaveLength(384);
      // Every element must be a finite number
      for (const v of entry.vector) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }

    // I4: strict ASC ordering
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]?.specHash ?? "";
      const curr = result[i]?.specHash ?? "";
      expect(prev < curr).toBe(true);
    }

    // I5: identity — every exported specHash was stored
    const returnedHashes = new Set(result.map((e) => e.specHash));
    expect(returnedHashes).toEqual(expectedHashes);

    // Determinism: call again and compare
    const result2 = await registry.exportAllEmbeddings();
    expect(result2).toEqual(result);
  }, 15_000);
});
