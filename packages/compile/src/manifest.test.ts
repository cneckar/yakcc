/**
 * manifest.test.ts — Unit tests for buildManifest, focusing on:
 *   1. recursionParent is surfaced when the registry row has a non-null parentBlockRoot.
 *   2. recursionParent is absent (field not present) for root blocks.
 *   3. verificationStatus is derived correctly from provenance test history.
 *
 * Production sequence exercised:
 *   buildManifest(resolution, registry) → ProvenanceManifest
 *
 * The registry is mocked at the interface boundary because this test focuses on
 * manifest logic, not SQLite round-trips (those are covered by storage.test.ts).
 * Mocking is acceptable here: Registry is an external boundary to the compile package.
 */

import { describe, expect, it } from "vitest";
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { BlockTripletRow, Provenance, Registry } from "@yakcc/registry";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";
import { buildManifest } from "./manifest.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/** Make a fake BlockMerkleRoot (64 hex chars from a repeated char). */
function fakeRoot(char: string): BlockMerkleRoot {
  return char.repeat(64) as BlockMerkleRoot;
}

/** Make a fake SpecHash (64 hex chars from a repeated char). */
function fakeSpec(char: string): SpecHash {
  return char.repeat(64) as SpecHash;
}

/**
 * Build a minimal ResolutionResult from a list of (root, specHash, subBlocks) tuples.
 * The first entry in the list is treated as the entry root.
 * Order is the order of the list (caller controls topological order).
 */
function makeResolution(
  blocks: Array<{ root: BlockMerkleRoot; specHash: SpecHash; subBlocks: BlockMerkleRoot[] }>,
): ResolutionResult {
  const entry = blocks[0]?.root ?? fakeRoot("0");
  const blockMap = new Map<BlockMerkleRoot, ResolvedBlock>();
  for (const b of blocks) {
    blockMap.set(b.root, {
      merkleRoot: b.root,
      specHash: b.specHash,
      source: `// impl for ${b.root.slice(0, 4)}`,
      subBlocks: b.subBlocks,
    });
  }
  return {
    entry,
    blocks: blockMap,
    order: blocks.map((b) => b.root),
  };
}

/**
 * Build a minimal Registry mock. Accepts a map of root → { parentBlockRoot, hasPassing }.
 * getProvenance returns a testHistory entry with passed=hasPassing when provided.
 * getBlock returns a minimal BlockTripletRow with the given parentBlockRoot.
 */
function makeRegistryMock(
  rows: Map<
    BlockMerkleRoot,
    { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
  >,
): Registry {
  return {
    async storeBlock(_row: BlockTripletRow): Promise<void> {
      throw new Error("not implemented in mock");
    },
    async selectBlocks(_specHash: SpecHash): Promise<BlockMerkleRoot[]> {
      return [];
    },
    async getBlock(merkleRoot: BlockMerkleRoot): Promise<BlockTripletRow | null> {
      const rowMeta = rows.get(merkleRoot);
      if (rowMeta === undefined) return null;
      return {
        blockMerkleRoot: merkleRoot,
        specHash: fakeSpec("a"),
        specCanonicalBytes: new Uint8Array(0),
        implSource: "// mock",
        proofManifestJson: "{}",
        level: "L0",
        createdAt: 0,
        canonicalAstHash: ("0".repeat(64)) as import("@yakcc/contracts").CanonicalAstHash,
        parentBlockRoot: rowMeta.parentBlockRoot,
      };
    },
    async findByCanonicalAstHash(
      _hash: import("@yakcc/contracts").CanonicalAstHash,
    ): Promise<readonly BlockMerkleRoot[]> {
      return [];
    },
    async getProvenance(merkleRoot: BlockMerkleRoot): Promise<Provenance> {
      const rowMeta = rows.get(merkleRoot);
      const testHistory = rowMeta?.hasPassing
        ? [{ runAt: "2024-01-01T00:00:00.000Z", passed: true, caseCount: 1 }]
        : [];
      return { testHistory, runtimeExposure: [] };
    },
    async close(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Tests: recursionParent field
// ---------------------------------------------------------------------------

describe("buildManifest: recursionParent field", () => {
  it("sets recursionParent when the registry row has a non-null parentBlockRoot", async () => {
    const rootA = fakeRoot("a");
    const rootB = fakeRoot("b");
    const resolution = makeResolution([
      { root: rootA, specHash: fakeSpec("1"), subBlocks: [] },
    ]);

    const registryRows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([[rootA, { parentBlockRoot: rootB, hasPassing: false }]]);

    const manifest = await buildManifest(resolution, makeRegistryMock(registryRows));

    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    expect(entry?.recursionParent).toBe(rootB);
  });

  it("omits recursionParent when the registry row has a null parentBlockRoot", async () => {
    const rootA = fakeRoot("a");
    const resolution = makeResolution([
      { root: rootA, specHash: fakeSpec("1"), subBlocks: [] },
    ]);

    const registryRows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([[rootA, { parentBlockRoot: null, hasPassing: false }]]);

    const manifest = await buildManifest(resolution, makeRegistryMock(registryRows));

    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    // Field must be absent (not just undefined via property access — check hasOwnProperty).
    expect(Object.prototype.hasOwnProperty.call(entry, "recursionParent")).toBe(false);
  });

  it("omits recursionParent when getBlock returns null (missing row)", async () => {
    const rootA = fakeRoot("a");
    const resolution = makeResolution([
      { root: rootA, specHash: fakeSpec("1"), subBlocks: [] },
    ]);

    // Registry returns null from getBlock for this root.
    const registryRows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map();

    const manifest = await buildManifest(resolution, makeRegistryMock(registryRows));

    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "recursionParent")).toBe(false);
  });

  it("mixed: two blocks, one with parent and one without", async () => {
    const rootLeaf = fakeRoot("c");
    const rootParent = fakeRoot("d");
    const resolution = makeResolution([
      { root: rootLeaf, specHash: fakeSpec("1"), subBlocks: [] },
      { root: rootParent, specHash: fakeSpec("2"), subBlocks: [rootLeaf] },
    ]);

    const registryRows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([
      [rootLeaf, { parentBlockRoot: rootParent, hasPassing: false }],
      [rootParent, { parentBlockRoot: null, hasPassing: true }],
    ]);

    const manifest = await buildManifest(resolution, makeRegistryMock(registryRows));

    expect(manifest.entries).toHaveLength(2);

    const leafEntry = manifest.entries.find((e) => e.blockMerkleRoot === rootLeaf);
    const parentEntry = manifest.entries.find((e) => e.blockMerkleRoot === rootParent);

    expect(leafEntry?.recursionParent).toBe(rootParent);
    expect(Object.prototype.hasOwnProperty.call(parentEntry, "recursionParent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: verificationStatus (regression check)
// ---------------------------------------------------------------------------

describe("buildManifest: verificationStatus", () => {
  it('is "passing" when at least one test run has passed === true', async () => {
    const root = fakeRoot("e");
    const resolution = makeResolution([{ root, specHash: fakeSpec("1"), subBlocks: [] }]);
    const rows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([[root, { parentBlockRoot: null, hasPassing: true }]]);

    const manifest = await buildManifest(resolution, makeRegistryMock(rows));
    expect(manifest.entries[0]?.verificationStatus).toBe("passing");
  });

  it('is "unverified" when no test run has passed', async () => {
    const root = fakeRoot("f");
    const resolution = makeResolution([{ root, specHash: fakeSpec("1"), subBlocks: [] }]);
    const rows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([[root, { parentBlockRoot: null, hasPassing: false }]]);

    const manifest = await buildManifest(resolution, makeRegistryMock(rows));
    expect(manifest.entries[0]?.verificationStatus).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence test: shave→compile parent_block_root chain
// ---------------------------------------------------------------------------

describe("buildManifest: compound shave→compile recursionParent chain", () => {
  it(
    "manifest recursionParent chain matches the parent_block_root chain set by shave() persistence",
    async () => {
      // @decision DEC-REGISTRY-PARENT-BLOCK-004
      // This test simulates the full shave→compile lineage chain:
      //   1. shave() persists outer atom with parentBlockRoot=null → outerRoot
      //   2. shave() persists inner atom with parentBlockRoot=outerRoot → innerRoot
      //   3. compile's buildManifest reads each row's parentBlockRoot via getBlock
      //   4. The resulting manifest.entries carry recursionParent matching the chain
      //
      // In production, steps 1–2 are done by shave() in index.ts, and steps 3–4
      // are done by buildManifest() in compile/manifest.ts. This test verifies
      // the interface contract between the two packages at the registry boundary.
      //
      // The registry mock returns the parentBlockRoot values that shave() would have
      // written via persistNovelGlueAtom — byte-identical BlockMerkleRoot values.

      const outerRoot = fakeRoot("A");
      const innerRoot = fakeRoot("B");

      // Resolution: inner block is the entry point, outer is a sub-block.
      // (Using a simple two-block resolution — order mimics compile's topological walk.)
      const resolution = makeResolution([
        { root: innerRoot, specHash: fakeSpec("x"), subBlocks: [] },
        { root: outerRoot, specHash: fakeSpec("y"), subBlocks: [innerRoot] },
      ]);

      // Registry mock reflecting what shave() would have written:
      //   - outerRoot → parentBlockRoot=null (it was the first persist, the root atom)
      //   - innerRoot → parentBlockRoot=outerRoot (persisted after outer, outer is its parent)
      const registryRows: Map<
        BlockMerkleRoot,
        { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
      > = new Map([
        [outerRoot, { parentBlockRoot: null, hasPassing: true }],
        [innerRoot, { parentBlockRoot: outerRoot, hasPassing: false }],
      ]);

      const manifest = await buildManifest(resolution, makeRegistryMock(registryRows));

      // Two entries in the manifest (one per block).
      expect(manifest.entries).toHaveLength(2);

      const outerEntry = manifest.entries.find((e) => e.blockMerkleRoot === outerRoot);
      const innerEntry = manifest.entries.find((e) => e.blockMerkleRoot === innerRoot);

      expect(outerEntry).toBeDefined();
      expect(innerEntry).toBeDefined();

      // Outer atom: parentBlockRoot=null → recursionParent field must be absent.
      expect(Object.prototype.hasOwnProperty.call(outerEntry, "recursionParent")).toBe(false);
      expect(outerEntry?.verificationStatus).toBe("passing");

      // Inner atom: parentBlockRoot=outerRoot → recursionParent must equal outerRoot.
      // This is the lineage chain: inner was shaved from outer, and the manifest
      // exposes that lineage as recursionParent on the inner entry.
      expect(innerEntry?.recursionParent).toBe(outerRoot);
      expect(innerEntry?.verificationStatus).toBe("unverified");
    },
  );
});

// ---------------------------------------------------------------------------
// Compound production-sequence test: end-to-end manifest shape
// ---------------------------------------------------------------------------

describe("buildManifest: compound production-sequence", () => {
  it("builds a full manifest with correct entry, entries order, and all fields", async () => {
    // Simulate a two-block assembly: leaf (shaved atom with parent) → entry (root block).
    const leafRoot = fakeRoot("1");
    const entryRoot = fakeRoot("2");
    const parentRoot = fakeRoot("3"); // the parent from which leaf was shaved

    const resolution = makeResolution([
      { root: leafRoot, specHash: fakeSpec("a"), subBlocks: [] },
      { root: entryRoot, specHash: fakeSpec("b"), subBlocks: [leafRoot] },
    ]);

    const rows: Map<
      BlockMerkleRoot,
      { parentBlockRoot: BlockMerkleRoot | null; hasPassing: boolean }
    > = new Map([
      [leafRoot, { parentBlockRoot: parentRoot, hasPassing: true }],
      [entryRoot, { parentBlockRoot: null, hasPassing: false }],
    ]);

    const manifest = await buildManifest(resolution, makeRegistryMock(rows));

    // entry is the first block in resolution.order (leafRoot, because makeResolution
    // sets entry = blocks[0].root and leafRoot is first in the array).
    expect(manifest.entry).toBe(leafRoot);

    // entries preserves topological order (leaf first, entry last).
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.blockMerkleRoot).toBe(leafRoot);
    expect(manifest.entries[1]?.blockMerkleRoot).toBe(entryRoot);

    // Leaf: passing, has recursionParent.
    expect(manifest.entries[0]?.verificationStatus).toBe("passing");
    expect(manifest.entries[0]?.recursionParent).toBe(parentRoot);

    // Entry: unverified, no recursionParent.
    expect(manifest.entries[1]?.verificationStatus).toBe("unverified");
    expect(Object.prototype.hasOwnProperty.call(manifest.entries[1], "recursionParent")).toBe(
      false,
    );

    // specHash and subBlocks are carried through.
    expect(manifest.entries[0]?.specHash).toBe(fakeSpec("a"));
    expect(manifest.entries[1]?.subBlocks).toContain(leafRoot);
  });
});
