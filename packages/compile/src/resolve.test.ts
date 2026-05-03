/**
 * resolve.test.ts — composition-graph traversal tests (WI-T04 triplet substrate).
 *
 * Production sequence exercised:
 *   openRegistry(":memory:") → storeBlock(row) → resolveComposition(entry, registry, resolver)
 *
 * Tests use synthetic BlockTripletRow fixtures populated directly via storeBlock().
 * No dependency on @yakcc/seeds — T04's tests use synthetic fixtures per the
 * Evaluation Contract (EC item a: "synthetic triplet-populated registry").
 *
 * Tests cover:
 *   - Single-block resolution (no sub-blocks) — EC item a
 *   - Two-deep composition (leaf appears before parent) — EC item b (topological order)
 *   - Cycle detection (synthetic two-block cycle) — EC item c
 *   - Missing block (merkle root not in registry) — error path
 *   - resolveComposition walks by BlockMerkleRoot exclusively — EC forbidden shortcut
 */

import {
  type BlockMerkleRoot,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  canonicalAstHash,
  createOfflineEmbeddingProvider,
  specHash,
} from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResolutionError, resolveComposition } from "./resolve.js";
import type { SubBlockResolver } from "./resolve.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SpecYak for testing. Each unique behavior string produces
 * a distinct SpecHash (and thus a distinct BlockMerkleRoot when combined with
 * distinct impl sources).
 */
function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

/**
 * Minimal proof manifest JSON for L0 (one property_tests artifact).
 * Using a synthetic artifact path that has no corresponding bytes on disk —
 * this is fine because storeBlock() takes the artifact content directly via
 * proofManifestJson; the artifact bytes are not re-read from disk.
 */
const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

/**
 * Build a BlockTripletRow for a synthetic block.
 *
 * Computes a real blockMerkleRoot from (spec, implSource, manifest) so that
 * the row is content-addressable and deterministic. The proofManifestJson
 * artifact bytes are synthesized inline (the artifact "tests.fast-check.ts"
 * bytes are set to the implSource bytes for simplicity — we only need a
 * non-empty Uint8Array for blockMerkleRoot() to not throw).
 */
function makeBlockRow(
  name: string,
  behavior: string,
  implSource: string,
): { row: BlockTripletRow; merkleRoot: BlockMerkleRoot; specHashValue: SpecHash } {
  const spec = makeSpecYak(name, behavior);
  const specHashValue = specHash(spec);
  const canonBytes = new TextEncoder().encode(JSON.stringify(spec));

  // Parse the manifest so we can supply artifact bytes.
  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }

  const root = blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as Parameters<typeof blockMerkleRoot>[0]["manifest"],
    artifacts: artifactsMap,
  });

  const row: BlockTripletRow = {
    blockMerkleRoot: root,
    specHash: specHashValue,
    specCanonicalBytes: canonBytes,
    implSource,
    proofManifestJson: MINIMAL_MANIFEST_JSON,
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(implSource),
    artifacts: artifactsMap,
  };

  return { row, merkleRoot: root, specHashValue };
}

/** Resolver that never resolves any import path (used for single-block tests). */
const nullResolver: SubBlockResolver = async () => null;

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: createOfflineEmbeddingProvider() });
});

afterEach(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Single-block resolution — EC item a (BlockMerkleRoot traversal)
// ---------------------------------------------------------------------------

describe("resolveComposition — single block", () => {
  it("resolves a single block with no sub-blocks", async () => {
    const implSource = `export function answer(): number { return 42; }\n`;
    const { row, merkleRoot } = makeBlockRow("answer", "Return the integer 42", implSource);
    await registry.storeBlock(row);

    const result = await resolveComposition(merkleRoot, registry, nullResolver);

    expect(result.entry).toBe(merkleRoot);
    expect(result.blocks.size).toBe(1);
    expect(result.order).toHaveLength(1);
    expect(result.order[0]).toBe(merkleRoot);
    expect(result.blocks.get(merkleRoot)?.source).toBe(implSource);
    expect(result.blocks.get(merkleRoot)?.subBlocks).toHaveLength(0);
    // EC: entry includes specHash
    expect(result.blocks.get(merkleRoot)?.specHash).toBe(row.specHash);
  });

  it("ResolvedBlock carries both merkleRoot and specHash", async () => {
    const implSource = `export function identity(x: string): string { return x; }\n`;
    const { row, merkleRoot, specHashValue } = makeBlockRow(
      "identity",
      "Return input unchanged",
      implSource,
    );
    await registry.storeBlock(row);

    const result = await resolveComposition(merkleRoot, registry, nullResolver);
    const resolved = result.blocks.get(merkleRoot);

    expect(resolved?.merkleRoot).toBe(merkleRoot);
    expect(resolved?.specHash).toBe(specHashValue);
  });
});

// ---------------------------------------------------------------------------
// Two-deep composition — EC item b (topological order preserved)
// ---------------------------------------------------------------------------

describe("resolveComposition — two-deep composition", () => {
  it("resolves leaf first, parent last (topological order)", async () => {
    // Leaf block: no sub-block imports.
    const leafImpl = `export function charAt(s: string, i: number): string { return s[i] ?? ""; }\n`;
    const { row: leafRow, merkleRoot: leafRoot } = makeBlockRow(
      "charAt",
      "Return character at position",
      leafImpl,
    );
    await registry.storeBlock(leafRow);

    // Parent block: imports leaf via "@yakcc/blocks/char-at".
    const parentImpl = `import type { charAt } from "@yakcc/blocks/char-at";
export function checkBracket(s: string, i: number): boolean { return s[i] === "["; }
`;
    const { row: parentRow, merkleRoot: parentRoot } = makeBlockRow(
      "checkBracket",
      "Check bracket character",
      parentImpl,
    );
    await registry.storeBlock(parentRow);

    // Resolver: "@yakcc/blocks/char-at" → leafRoot.
    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/blocks/char-at") return leafRoot;
      return null;
    };

    const result = await resolveComposition(parentRoot, registry, resolver);

    expect(result.entry).toBe(parentRoot);
    expect(result.blocks.size).toBe(2);
    expect(result.order).toHaveLength(2);
    // Topological order: leaf first, parent last.
    expect(result.order[0]).toBe(leafRoot);
    expect(result.order[1]).toBe(parentRoot);
    // Both blocks are in the map.
    expect(result.blocks.has(leafRoot)).toBe(true);
    expect(result.blocks.has(parentRoot)).toBe(true);
    // Parent's subBlocks references the leaf.
    expect(result.blocks.get(parentRoot)?.subBlocks).toContain(leafRoot);
  });

  it("three-deep composition preserves topological order (A→B→C, C first)", async () => {
    const implC = `export function leafC(): string { return "C"; }\n`;
    const { row: rowC, merkleRoot: rootC } = makeBlockRow("leafC", "Return C", implC);
    await registry.storeBlock(rowC);

    const implB = `import type { leafC } from "@yakcc/seeds/blocks/leaf-c";
export function midB(): string { return "B"; }
`;
    const { row: rowB, merkleRoot: rootB } = makeBlockRow("midB", "Return B", implB);
    await registry.storeBlock(rowB);

    const implA = `import type { midB } from "@yakcc/seeds/blocks/mid-b";
export function topA(): string { return "A"; }
`;
    const { row: rowA, merkleRoot: rootA } = makeBlockRow("topA", "Return A", implA);
    await registry.storeBlock(rowA);

    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/seeds/blocks/leaf-c") return rootC;
      if (importedFrom === "@yakcc/seeds/blocks/mid-b") return rootB;
      return null;
    };

    const result = await resolveComposition(rootA, registry, resolver);

    expect(result.order).toHaveLength(3);
    // C is leaf, B depends on C, A depends on B → order: C, B, A.
    expect(result.order[0]).toBe(rootC);
    expect(result.order[1]).toBe(rootB);
    expect(result.order[2]).toBe(rootA);
    expect(result.entry).toBe(rootA);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection — EC item c
// ---------------------------------------------------------------------------

describe("resolveComposition — cycle detection", () => {
  it("throws ResolutionError with kind 'cycle' on a two-block cycle", async () => {
    // Block A imports B.
    const implA = `import type { blockB } from "@yakcc/blocks/block-b";
export function blockA(): string { return "A"; }
`;
    const { row: rowA, merkleRoot: rootA } = makeBlockRow("blockA", "Block A composes B", implA);
    await registry.storeBlock(rowA);

    // Block B imports A — creates a cycle.
    const implB = `import type { blockA } from "@yakcc/blocks/block-a";
export function blockB(): string { return "B"; }
`;
    const { row: rowB, merkleRoot: rootB } = makeBlockRow("blockB", "Block B composes A", implB);
    await registry.storeBlock(rowB);

    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/blocks/block-b") return rootB;
      if (importedFrom === "@yakcc/blocks/block-a") return rootA;
      return null;
    };

    await expect(resolveComposition(rootA, registry, resolver)).rejects.toThrow(ResolutionError);

    try {
      await resolveComposition(rootA, registry, resolver);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("cycle");
      // Error carries the merkleRoot that triggered the cycle detection.
      expect(typeof (err as ResolutionError).merkleRoot).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Missing block
// ---------------------------------------------------------------------------

describe("resolveComposition — missing block", () => {
  it("throws ResolutionError with kind 'missing-block' for unknown merkle root", async () => {
    // A 64-char hex string that was never stored.
    const fakeRoot = "a".repeat(64) as BlockMerkleRoot;

    await expect(resolveComposition(fakeRoot, registry, nullResolver)).rejects.toThrow(
      ResolutionError,
    );

    try {
      await resolveComposition(fakeRoot, registry, nullResolver);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("missing-block");
      expect((err as ResolutionError).merkleRoot).toBe(fakeRoot);
    }
  });

  it("throws 'missing-block' when a sub-block resolver returns a root not in registry", async () => {
    // Parent is stored; its sub-block resolver returns a root that doesn't exist.
    const implParent = `import type { ghost } from "@yakcc/blocks/ghost";
export function parent(): string { return "parent"; }
`;
    const { row: parentRow, merkleRoot: parentRoot } = makeBlockRow(
      "parent",
      "Parent with missing sub-block",
      implParent,
    );
    await registry.storeBlock(parentRow);

    const ghostRoot = "b".repeat(64) as BlockMerkleRoot;
    const resolver: SubBlockResolver = async (importedFrom) => {
      if (importedFrom === "@yakcc/blocks/ghost") return ghostRoot;
      return null;
    };

    await expect(resolveComposition(parentRoot, registry, resolver)).rejects.toThrow(
      ResolutionError,
    );

    try {
      await resolveComposition(parentRoot, registry, resolver);
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).kind).toBe("missing-block");
    }
  });
});
