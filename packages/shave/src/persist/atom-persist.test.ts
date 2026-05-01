import { describe, expect, it, vi } from "vitest";
import type { BlockMerkleRoot, CanonicalAstHash, EmbeddingProvider } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { extractCorpus } from "../corpus/index.js";
import type { CorpusAtomSpec } from "../corpus/index.js";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { maybePersistNovelGlueAtom, persistNovelGlueAtom } from "./atom-persist.js";
import { buildTriplet } from "./triplet.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 64-hex-char canonical AST hash (arbitrary content address, fixed for determinism).
const FAKE_HASH =
  "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as CanonicalAstHash;

function makeIntentCard(overrides: Partial<IntentCard> = {}): IntentCard {
  return {
    schemaVersion: 1,
    behavior: "Parse a comma-separated list of integers and return them as an array",
    inputs: [{ name: "raw", typeHint: "string", description: "The raw CSV string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: ["raw is a non-empty string"],
    postconditions: ["result.length >= 0"],
    notes: ["Trailing commas are ignored"],
    modelVersion: "claude-3-5-haiku-20241022",
    promptVersion: "v1.0",
    sourceHash: "deadbeef",
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const SAMPLE_SOURCE = `function parseIntList(raw: string): number[] {
  return raw.split(",").map(Number).filter(Number.isFinite);
}`;

function makeEntry(overrides: Partial<NovelGlueEntry> = {}): NovelGlueEntry {
  return {
    kind: "novel-glue",
    sourceRange: { start: 0, end: SAMPLE_SOURCE.length },
    source: SAMPLE_SOURCE,
    canonicalAstHash: FAKE_HASH,
    intentCard: makeIntentCard(),
    ...overrides,
  };
}

/**
 * Build a minimal in-memory Registry stub that records storeBlock calls.
 * storeBlock is the only method exercised by persistNovelGlueAtom.
 */
function makeRegistryStub(): {
  registry: Registry;
  calls: BlockTripletRow[];
} {
  const calls: BlockTripletRow[] = [];
  const registry = {
    storeBlock: async (row: BlockTripletRow): Promise<void> => {
      calls.push(row);
    },
  } as unknown as Registry;
  return { registry, calls };
}

// ---------------------------------------------------------------------------
// Tests: persistNovelGlueAtom (full Registry interface)
// ---------------------------------------------------------------------------

describe("persistNovelGlueAtom()", () => {
  it("happy path: stores a row and returns the merkleRoot", async () => {
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    const result = await persistNovelGlueAtom(entry, registry);

    // A merkleRoot must be returned.
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);

    // storeBlock must have been called exactly once.
    expect(calls).toHaveLength(1);

    const row = calls[0]!;

    // Row fields match the expected BlockTripletRow shape.
    expect(row.blockMerkleRoot).toBe(result);
    expect(typeof row.specHash).toBe("string");
    expect(row.specHash.length).toBeGreaterThan(0);
    expect(row.implSource).toBe(SAMPLE_SOURCE);
    expect(row.level).toBe("L0");
    expect(row.canonicalAstHash).toBe(FAKE_HASH);
    expect(typeof row.proofManifestJson).toBe("string");
    expect(typeof row.createdAt).toBe("number");

    // proofManifestJson must be valid JSON and contain the L0 artifact.
    const manifest = JSON.parse(row.proofManifestJson) as { artifacts: Array<{ kind: string }> };
    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(manifest.artifacts[0]!.kind).toBe("property_tests");
  });

  it("returned merkleRoot matches the row's blockMerkleRoot (no divergence)", async () => {
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    const result = await persistNovelGlueAtom(entry, registry);
    expect(result).toBe(calls[0]!.blockMerkleRoot);
  });

  it("skips and returns undefined when entry has no intentCard", async () => {
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry({ intentCard: undefined });

    const result = await persistNovelGlueAtom(entry, registry);

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("is deterministic: two calls with same entry produce the same merkleRoot", async () => {
    const { registry: r1 } = makeRegistryStub();
    const { registry: r2 } = makeRegistryStub();
    const entry = makeEntry();

    const root1 = await persistNovelGlueAtom(entry, r1);
    const root2 = await persistNovelGlueAtom(entry, r2);

    expect(root1).toBe(root2);
  });
});

// ---------------------------------------------------------------------------
// Tests: maybePersistNovelGlueAtom (opt-in / ShaveRegistryView path)
// ---------------------------------------------------------------------------

describe("maybePersistNovelGlueAtom()", () => {
  it("happy path: delegates to persistNovelGlueAtom when storeBlock is present", async () => {
    const calls: BlockTripletRow[] = [];
    const registryView = {
      storeBlock: async (row: BlockTripletRow): Promise<void> => {
        calls.push(row);
      },
    };
    const entry = makeEntry();

    const result = await maybePersistNovelGlueAtom(entry, registryView);

    expect(typeof result).toBe("string");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.blockMerkleRoot).toBe(result);
  });

  it("returns undefined and does not throw when storeBlock is absent", async () => {
    // Registry view without storeBlock — e.g. a read-only mock.
    const registryView: { findByCanonicalAstHash?: (hash: CanonicalAstHash) => Promise<readonly BlockMerkleRoot[]> } = {};
    const entry = makeEntry();

    const result = await maybePersistNovelGlueAtom(entry, registryView);

    expect(result).toBeUndefined();
  });

  it("returns undefined when entry has no intentCard, even if storeBlock is present", async () => {
    const calls: BlockTripletRow[] = [];
    const registryView = {
      storeBlock: async (row: BlockTripletRow): Promise<void> => {
        calls.push(row);
      },
    };
    const entry = makeEntry({ intentCard: undefined });

    const result = await maybePersistNovelGlueAtom(entry, registryView);

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("production sequence: NovelGlueEntry with intentCard flows through buildTriplet to storeBlock", async () => {
    // This test covers the real production path end-to-end:
    // maybePersistNovelGlueAtom → persistNovelGlueAtom → buildTriplet → registry.storeBlock
    // The spy verifies both that the row was produced from the correct components and
    // that the returned merkleRoot equals the row's blockMerkleRoot.
    const storedRows: BlockTripletRow[] = [];
    const storeBlock = vi.fn(async (row: BlockTripletRow) => {
      storedRows.push(row);
    });
    const registryView = { storeBlock };

    const intentCard = makeIntentCard({
      behavior: "Add two numbers",
      inputs: [
        { name: "a", typeHint: "number", description: "First operand" },
        { name: "b", typeHint: "number", description: "Second operand" },
      ],
      outputs: [{ name: "sum", typeHint: "number", description: "a + b" }],
    });

    const entry: NovelGlueEntry = {
      kind: "novel-glue",
      sourceRange: { start: 0, end: 30 },
      source: "function add(a: number, b: number): number { return a + b; }",
      canonicalAstHash: FAKE_HASH,
      intentCard,
    };

    const merkleRoot = await maybePersistNovelGlueAtom(entry, registryView);

    // Verify storeBlock was called once.
    expect(storeBlock).toHaveBeenCalledTimes(1);

    // merkleRoot is non-empty and equals the row's blockMerkleRoot.
    expect(typeof merkleRoot).toBe("string");
    expect(merkleRoot).toBe(storedRows[0]!.blockMerkleRoot);

    // Row carries the expected structural properties from the full pipeline.
    const row = storedRows[0]!;
    expect(row.level).toBe("L0");
    expect(row.implSource).toBe(entry.source);
    expect(row.canonicalAstHash).toBe(FAKE_HASH);

    // Spec name should incorporate the last 6 chars of FAKE_HASH.
    const storedSpec = JSON.parse(row.proofManifestJson) as { artifacts: Array<{ kind: string }> };
    expect(storedSpec.artifacts[0]!.kind).toBe("property_tests");
  });
});

// ---------------------------------------------------------------------------
// Tests: WI-017 parent_block_root lineage (DEC-REGISTRY-PARENT-BLOCK-004)
// ---------------------------------------------------------------------------

describe("WI-017 parentBlockRoot lineage", () => {
  // Synthetic parent root — 64-char hex string, representing the merkle root of
  // an outer (parent) atom that was persisted before the current (child) atom.
  const PARENT_ROOT =
    "1111111111111111111111111111111111111111111111111111111111111111" as BlockMerkleRoot;

  it("parent_block_root is set when PersistOptions.parentBlockRoot is supplied; row read-back matches byte-identically", async () => {
    // @decision DEC-REGISTRY-PARENT-BLOCK-004: parentBlockRoot enters via
    // PersistOptions and is written directly to BlockTripletRow.parentBlockRoot.
    // The value must be the literal BlockMerkleRoot supplied — no re-derivation.
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    const result = await persistNovelGlueAtom(entry, registry, {
      parentBlockRoot: PARENT_ROOT,
    });

    // A merkle root is returned.
    expect(typeof result).toBe("string");

    // storeBlock was called exactly once.
    expect(calls).toHaveLength(1);
    const row = calls[0]!;

    // The parentBlockRoot on the stored row must exactly equal the value supplied.
    expect(row.parentBlockRoot).toBe(PARENT_ROOT);

    // The returned merkle root equals the row's blockMerkleRoot (no divergence).
    expect(row.blockMerkleRoot).toBe(result);
  });

  it("parent_block_root is null when no parentBlockRoot is supplied (preserve WI-014-04 default)", async () => {
    // Callers that do not supply parentBlockRoot must produce a row with
    // parentBlockRoot === null (not undefined, not a stale value).
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    await persistNovelGlueAtom(entry, registry);

    expect(calls).toHaveLength(1);
    const row = calls[0]!;

    // parentBlockRoot must be null (explicit null, not the sentinel undefined).
    expect(row.parentBlockRoot).toBeNull();
  });

  it("maybePersistNovelGlueAtom forwards options.parentBlockRoot unchanged to the stored row", async () => {
    // Verify that the opt-in shave() path (maybePersistNovelGlueAtom) does not
    // drop or transform the parentBlockRoot value before it reaches storeBlock.
    const calls: BlockTripletRow[] = [];
    const registryView = {
      storeBlock: async (row: BlockTripletRow): Promise<void> => {
        calls.push(row);
      },
    };
    const entry = makeEntry();

    const result = await maybePersistNovelGlueAtom(entry, registryView, {
      parentBlockRoot: PARENT_ROOT,
    });

    expect(typeof result).toBe("string");
    expect(calls).toHaveLength(1);

    // The parent is forwarded byte-identically.
    expect(calls[0]!.parentBlockRoot).toBe(PARENT_ROOT);

    // Returned merkle root is consistent with the stored row.
    expect(calls[0]!.blockMerkleRoot).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// Tests: WI-016 corpus integration
// ---------------------------------------------------------------------------

describe("WI-016 corpus integration", () => {
  // @decision DEC-ATOM-PERSIST-001 (WI-016):
  //   These tests validate the production path where extractCorpus() produces a
  //   real artifact (not the bootstrap placeholder). Source (a) — extractFromUpstreamTest
  //   — is always available (pure, deterministic, no I/O), so the default call to
  //   persistNovelGlueAtom with no corpusOptions always succeeds and produces a
  //   non-empty fast-check artifact at a non-placeholder path.
  //
  //   Test 1 verifies the non-placeholder path: the artifact path is NOT the
  //   bootstrap sentinel ("property-tests.ts") and the bytes contain "fast-check".
  //
  //   Test 2 verifies that the bootstrap-empty path is NOT a silent fallback:
  //   disabling all three corpus sources causes persistNovelGlueAtom to reject with
  //   a descriptive error and leaves the registry unwritten.

  it("default path produces a non-placeholder artifact with fast-check content", async () => {
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    // Call with no options — source (a) extractFromUpstreamTest is always available.
    await persistNovelGlueAtom(entry, registry);

    // Registry must have been written exactly once.
    expect(calls).toHaveLength(1);
    const row = calls[0]!;

    // (i) proofManifestJson parses and has exactly one artifact with kind === "property_tests".
    const manifest = JSON.parse(row.proofManifestJson) as {
      artifacts: Array<{ kind: string; path: string }>;
    };
    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.kind).toBe("property_tests");

    // (ii) The artifact path is NOT the bootstrap sentinel "property-tests.ts".
    const artifactPath = manifest.artifacts[0]!.path;
    expect(artifactPath).not.toBe("property-tests.ts");

    // (iii–iv) Re-extract corpus using the same atom spec to obtain the artifact bytes
    //   (extractFromUpstreamTest is deterministic, so the bytes match what persist used).
    //   Then verify the bytes are non-empty and contain the "fast-check" import.
    const atomSpec: CorpusAtomSpec = {
      source: entry.source,
      intentCard: entry.intentCard!,
    };
    const corpusResult = await extractCorpus(atomSpec);

    // The artifact path from the manifest matches the corpus result's canonical path.
    expect(corpusResult.path).toBe(artifactPath);

    // (iii) Bytes are non-empty.
    expect(corpusResult.bytes.length).toBeGreaterThan(0);

    // (iv) Bytes decode as UTF-8 and contain the substring "fast-check".
    const decoded = new TextDecoder().decode(corpusResult.bytes);
    expect(decoded).toContain("fast-check");
  });

  it("all-sources-disabled fails persist and does not write to registry", async () => {
    const { registry, calls } = makeRegistryStub();
    const entry = makeEntry();

    // Disable all three corpus extraction sources — extractCorpus() must throw,
    // and persistNovelGlueAtom() must propagate that error without writing a row.
    const promise = persistNovelGlueAtom(entry, registry, {
      corpusOptions: {
        enableUpstreamTest: false,
        enableDocumentedUsage: false,
        enableAiDerived: false,
      },
    });

    // The call must reject.
    await expect(promise).rejects.toThrow();

    // The error message must identify that all enabled sources were exhausted.
    await expect(
      persistNovelGlueAtom(entry, registry, {
        corpusOptions: {
          enableUpstreamTest: false,
          enableDocumentedUsage: false,
          enableAiDerived: false,
        },
      }),
    ).rejects.toThrow("all enabled sources failed or were disabled");

    // The registry must NOT have been written to (no row committed).
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WI-022 Required Tests: artifact bytes threading through persist layer
// ---------------------------------------------------------------------------

// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002
// title: persistNovelGlueAtom threads artifacts from buildTriplet to storeBlock
// status: decided (WI-022 slice b)
// rationale:
//   Three tests exercise the full artifact-threading invariant:
//   (1) Stub-capture: the row passed to storeBlock carries artifacts byte-identical
//       to what buildTriplet computed (same Map from blockMerkleRoot() call).
//   (2) Real-registry round-trip: storeBlock → getBlock returns artifacts
//       byte-identical to what was passed in.
//   No second Map, no copy, no re-derivation (Sacred Practice #12).

/**
 * Deterministic mock embedding provider for registry round-trip tests.
 * Returns a normalized 384-dim vector without loading ONNX/transformers.js.
 */
function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider-shave",
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

describe("WI-022 artifact threading — stub-capture test", () => {
  // WI-022 Required Test (atom-persist.test.ts #1):
  //   Stub registry captures storeBlock argument; assert capturedRow.artifacts
  //   byte-identical to buildTriplet's computed Map.
  //
  // Production sequence: extractCorpus() → buildTriplet() → row construction
  //   → registry.storeBlock(row). The row.artifacts field must carry the same
  //   bytes as what buildTriplet would produce for the same corpus.

  it("storeBlock receives a row whose artifacts are byte-identical to buildTriplet's computed Map", async () => {
    const capturedRows: BlockTripletRow[] = [];
    const stubRegistry = {
      storeBlock: vi.fn(async (row: BlockTripletRow) => { capturedRows.push(row); }),
    } as unknown as Registry;

    const entry = makeEntry();

    // Run the real production persist path.
    const root = await persistNovelGlueAtom(entry, stubRegistry);
    expect(root).toBeDefined();
    expect(capturedRows).toHaveLength(1);

    const capturedRow = capturedRows[0]!;

    // Re-run extractCorpus + buildTriplet with the same inputs to obtain the
    // reference Map — this mirrors exactly what persistNovelGlueAtom does internally.
    const atomSpec: CorpusAtomSpec = {
      source: entry.source,
      intentCard: entry.intentCard!,
    };
    const corpusResult = await extractCorpus(atomSpec);
    const refTriplet = buildTriplet(
      entry.intentCard!,
      entry.source,
      entry.canonicalAstHash,
      corpusResult,
    );

    // The captured row must carry the artifacts field (not missing, not empty).
    expect(capturedRow.artifacts).toBeDefined();
    expect(capturedRow.artifacts.size).toBeGreaterThan(0);

    // Every entry in the reference triplet's artifacts must be byte-identical
    // to the corresponding entry in the captured row.
    expect(capturedRow.artifacts.size).toBe(refTriplet.artifacts.size);
    for (const [path, refBytes] of refTriplet.artifacts) {
      expect(capturedRow.artifacts.has(path)).toBe(true);
      const capturedBytes = capturedRow.artifacts.get(path)!;
      expect(capturedBytes.length).toBe(refBytes.length);
      expect(Array.from(capturedBytes)).toEqual(Array.from(refBytes));
    }
  });
});

describe("WI-022 artifact threading — real-registry round-trip", () => {
  // WI-022 Required Test (atom-persist.test.ts #2):
  //   End-to-end real-registry round-trip:
  //   persistNovelGlueAtom → registry.getBlock → artifacts Map byte-identical to input.
  //
  // Production sequence:
  //   openRegistry(":memory:") → persistNovelGlueAtom(entry, registry)
  //   → registry.getBlock(merkleRoot) → hydrated.artifacts byte-identical to what
  //   was stored.
  //
  // This crosses the storage boundary (SQLite block_artifacts table write + read)
  // to prove that artifact bytes survive the full persist-and-retrieve cycle.

  it("artifacts survive registry.storeBlock → registry.getBlock round-trip byte-identically", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: mockEmbeddingProvider(),
    });

    try {
      const entry = makeEntry();

      // Persist via the production path.
      const merkleRoot = await persistNovelGlueAtom(entry, registry);
      expect(merkleRoot).toBeDefined();

      // Retrieve the block.
      const hydrated = await registry.getBlock(merkleRoot!);
      expect(hydrated).not.toBeNull();
      const hydratedRow = hydrated!;

      // Obtain the reference artifacts from a parallel buildTriplet call.
      const atomSpec: CorpusAtomSpec = {
        source: entry.source,
        intentCard: entry.intentCard!,
      };
      const corpusResult = await extractCorpus(atomSpec);
      const refTriplet = buildTriplet(
        entry.intentCard!,
        entry.source,
        entry.canonicalAstHash,
        corpusResult,
      );

      // Hydrated artifacts must be non-empty and byte-identical to the reference.
      expect(hydratedRow.artifacts.size).toBeGreaterThan(0);
      expect(hydratedRow.artifacts.size).toBe(refTriplet.artifacts.size);

      for (const [path, refBytes] of refTriplet.artifacts) {
        expect(hydratedRow.artifacts.has(path)).toBe(true);
        const hydratedBytes = hydratedRow.artifacts.get(path)!;
        expect(hydratedBytes.length).toBe(refBytes.length);
        expect(Array.from(hydratedBytes)).toEqual(Array.from(refBytes));
      }
    } finally {
      await registry.close();
    }
  });
});
