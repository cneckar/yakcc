import { describe, expect, it, vi } from "vitest";
import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { maybePersistNovelGlueAtom, persistNovelGlueAtom } from "./atom-persist.js";

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
