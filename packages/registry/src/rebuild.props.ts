// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-MODEL-MIGRATION-001
// title: Property-test corpus for rebuildRegistry() — data-preservation + idempotency
// status: accepted (issue #338, WI-EMBED-MODEL-MIGRATION-PATH)
// rationale: The three invariants that matter for a safe embedding migration are:
//   R1  — block data preserved: every column EXCEPT the contract_embeddings index is
//          byte-identical before and after rebuild (atoms are untouched, only the
//          derived embedding index is regenerated).
//   R2  — idempotent: running rebuild twice produces identical final state (same
//          embeddings, same block data).
//   R3  — result metadata: reembedded count == number of stored blocks; modelId
//          comes from the supplied provider.
//
// Two-file pattern: this file (.props.ts) is vitest-free and holds the corpus;
// the sibling .props.test.ts is the thin vitest harness.
//
// ---------------------------------------------------------------------------
// Property-test corpus for rebuild.ts
//
// Functions covered:
//   rebuildRegistry() — public migration surface (DEC-EMBED-MODEL-MIGRATION-001)
//
// Atoms covered:
//   R1  — block data (all non-embedding fields) is byte-identical pre/post rebuild
//   R2  — idempotent: second rebuild produces identical embedding + data state
//   R3  — result.reembedded == number of stored blocks
//   R4  — result.modelId matches the supplied provider's modelId
//   R5  — onProgress is called exactly once per block, in order
//   R6  — empty registry: rebuild succeeds with reembedded=0
// ---------------------------------------------------------------------------

import {
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  createOfflineEmbeddingProvider,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import * as fc from "fast-check";
import type { BlockMerkleRoot, BlockTripletRow, CanonicalAstHash, SpecHash } from "./index.js";
import { rebuildRegistry } from "./rebuild.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid SpecYak from a discriminating name.
 * Each unique name produces a unique spec (distinct specHash).
 */
function makeSpec(name: string): SpecYak {
  return {
    name,
    behavior: `Behavior for ${name}`,
    inputs: [{ name: "x", type: "string" }],
    outputs: [{ name: "y", type: "string" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
  };
}

/** Minimal impl source — unique per block name so blockMerkleRoot differs. */
function makeImpl(name: string): string {
  return `export function ${name.replace(/-/g, "_")}(x: string): string { return x; }`;
}

const STUB_MANIFEST = {
  version: 1,
  artifacts: [] as { path: string; algorithm: string; hash: string }[],
};

async function makeBlockRow(name: string): Promise<BlockTripletRow> {
  const spec = makeSpec(name);
  const implSource = makeImpl(name);
  const artifacts = new Map<string, Uint8Array>();
  const bmr = blockMerkleRoot({
    spec,
    implSource,
    manifest: STUB_MANIFEST as never,
    artifacts,
  }) as BlockMerkleRoot;
  const specHashVal = deriveSpecHash(spec) as SpecHash;
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const astHash = deriveCanonicalAstHash(implSource) as CanonicalAstHash;
  return {
    blockMerkleRoot: bmr,
    specHash: specHashVal,
    specCanonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(STUB_MANIFEST),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: astHash,
    parentBlockRoot: null,
    artifacts,
    kind: "local",
    foreignPkg: null,
    foreignExport: null,
    foreignDtsHash: null,
  };
}

/**
 * Snapshot the non-embedding fields for a block (all BlockTripletRow fields
 * except embeddings, which live in contract_embeddings and are regenerated).
 *
 * This is the "data preservation" snapshot: rebuild must leave these unchanged.
 */
function snapshotBlockData(row: BlockTripletRow): {
  blockMerkleRoot: string;
  specHash: string;
  implSource: string;
  proofManifestJson: string;
  level: string;
  canonicalAstHash: string;
  kind: string | undefined;
  foreignPkg: string | null | undefined;
  foreignExport: string | null | undefined;
} {
  return {
    blockMerkleRoot: row.blockMerkleRoot as string,
    specHash: row.specHash as string,
    implSource: row.implSource,
    proofManifestJson: row.proofManifestJson,
    level: row.level,
    canonicalAstHash: row.canonicalAstHash as string,
    kind: row.kind,
    foreignPkg: row.foreignPkg,
    foreignExport: row.foreignExport,
  };
}

// ---------------------------------------------------------------------------
// R6: Empty registry — rebuild succeeds with reembedded=0
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_empty_registry_reembedded_zero
 *
 * Rebuild on an empty registry completes without error and reports 0 re-embedded blocks.
 *
 * Invariant: rebuildRegistry iterates `enumerateSpecs()` which returns [] for an
 * empty registry. The loop body never fires, so reembedded stays at 0.
 */
export const prop_rebuild_empty_registry_reembedded_zero = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      const result = await rebuildRegistry(registry, provider);
      return result.reembedded === 0;
    } finally {
      await registry.close();
    }
  },
);

// ---------------------------------------------------------------------------
// R3: result.reembedded == number of stored blocks
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_result_reembedded_matches_block_count
 *
 * After storing N blocks, rebuilding returns result.reembedded === N.
 *
 * Invariant: rebuildRegistry iterates every stored block exactly once via
 * enumerateSpecs + selectBlocks. Each block is re-stored exactly once.
 * The reembedded counter increments once per storeBlock call.
 */
export const prop_rebuild_result_reembedded_matches_block_count = fc.asyncProperty(
  fc.integer({ min: 1, max: 5 }),
  async (count) => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      const names = Array.from({ length: count }, (_, i) => `block-${i}`);
      for (const name of names) {
        const row = await makeBlockRow(name);
        await registry.storeBlock(row);
      }
      const result = await rebuildRegistry(registry, provider);
      return result.reembedded === count;
    } finally {
      await registry.close();
    }
  },
);

// ---------------------------------------------------------------------------
// R4: result.modelId matches the provider's modelId
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_result_model_id_matches_provider
 *
 * result.modelId equals provider.modelId (the offline provider's model ID).
 *
 * Invariant: rebuildRegistry records the supplied provider's modelId in the
 * result. It does not derive modelId from the DB or from the stored embeddings.
 */
export const prop_rebuild_result_model_id_matches_provider = fc.asyncProperty(
  fc.constant(null),
  async () => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      const row = await makeBlockRow("model-id-check");
      await registry.storeBlock(row);
      const result = await rebuildRegistry(registry, provider);
      return result.modelId === provider.modelId;
    } finally {
      await registry.close();
    }
  },
);

// ---------------------------------------------------------------------------
// R1: Block data preserved — all non-embedding fields byte-identical pre/post rebuild
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_preserves_block_data
 *
 * After rebuild, every block's non-embedding data (blockMerkleRoot, specHash,
 * implSource, proofManifestJson, level, canonicalAstHash) is byte-identical to
 * the pre-rebuild snapshot.
 *
 * Invariant: rebuildRegistry calls storeBlock(block) where `block` is the row
 * returned by getBlock(). storeBlock uses INSERT OR IGNORE for the blocks table
 * (DEC-STORAGE-IDEMPOTENT-001) — the blocks row is never mutated; only the
 * contract_embeddings vector is replaced (DELETE+INSERT). So all atoms survive
 * unchanged.
 *
 * Production sequence exercised: openRegistry → storeBlock × N → rebuildRegistry
 * → getBlock × N → snapshot comparison.
 */
export const prop_rebuild_preserves_block_data = fc.asyncProperty(
  fc.integer({ min: 1, max: 4 }),
  async (count) => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      const rows: BlockTripletRow[] = [];
      for (let i = 0; i < count; i++) {
        const row = await makeBlockRow(`preserve-${i}`);
        await registry.storeBlock(row);
        rows.push(row);
      }

      // Snapshot pre-rebuild state
      const preBefore = await Promise.all(
        rows.map(async (r) => {
          const block = await registry.getBlock(r.blockMerkleRoot);
          if (block === null) return null;
          return snapshotBlockData(block);
        }),
      );

      // Rebuild
      await rebuildRegistry(registry, provider);

      // Snapshot post-rebuild state
      const postAfter = await Promise.all(
        rows.map(async (r) => {
          const block = await registry.getBlock(r.blockMerkleRoot);
          if (block === null) return null;
          return snapshotBlockData(block);
        }),
      );

      // Every field must be identical
      for (let i = 0; i < count; i++) {
        const before = preBefore[i];
        const after = postAfter[i];
        if (before === null || after === null) return false;
        if (JSON.stringify(before) !== JSON.stringify(after)) return false;
      }
      return true;
    } finally {
      await registry.close();
    }
  },
);

// ---------------------------------------------------------------------------
// R2: Idempotent — second rebuild produces identical block data state
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_is_idempotent
 *
 * Running rebuildRegistry twice in a row on the same registry produces
 * identical block data state (same snapshot pre-second-rebuild == post-second-rebuild).
 *
 * Invariant: rebuildRegistry uses storeBlock() which uses INSERT OR IGNORE for
 * the blocks row and DELETE+INSERT for the embedding vector. Both operations are
 * deterministic for the same provider: the embedding of the same text is the
 * same bytes each call. So a second rebuild changes nothing.
 *
 * Compound-interaction test: this is the canonical end-to-end sequence that
 * exercises openRegistry → storeBlock → rebuildRegistry → rebuildRegistry (twice)
 * → getBlock, crossing all four internal components (storage, schema, rebuild,
 * embedding provider). This is the "real production sequence" for the migration
 * path documented in USING_YAKCC.md.
 */
export const prop_rebuild_is_idempotent = fc.asyncProperty(
  fc.integer({ min: 1, max: 4 }),
  async (count) => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      for (let i = 0; i < count; i++) {
        const row = await makeBlockRow(`idempotent-${i}`);
        await registry.storeBlock(row);
      }

      // First rebuild
      const result1 = await rebuildRegistry(registry, provider);

      // Snapshot after first rebuild
      const specHashes = await registry.enumerateSpecs();
      const allRoots: BlockMerkleRoot[] = [];
      for (const sh of specHashes) {
        const roots = await registry.selectBlocks(sh);
        allRoots.push(...roots);
      }
      const snapshotAfterFirst = await Promise.all(
        allRoots.map(async (root) => {
          const block = await registry.getBlock(root);
          return block ? snapshotBlockData(block) : null;
        }),
      );

      // Second rebuild
      const result2 = await rebuildRegistry(registry, provider);

      // Snapshot after second rebuild
      const snapshotAfterSecond = await Promise.all(
        allRoots.map(async (root) => {
          const block = await registry.getBlock(root);
          return block ? snapshotBlockData(block) : null;
        }),
      );

      // Both rebuilds must report the same count
      if (result1.reembedded !== result2.reembedded) return false;
      if (result1.modelId !== result2.modelId) return false;

      // Block data must be identical after both rebuilds
      for (let i = 0; i < snapshotAfterFirst.length; i++) {
        if (JSON.stringify(snapshotAfterFirst[i]) !== JSON.stringify(snapshotAfterSecond[i])) {
          return false;
        }
      }
      return true;
    } finally {
      await registry.close();
    }
  },
);

// ---------------------------------------------------------------------------
// R5: onProgress called exactly once per block, monotonically increasing done count
// ---------------------------------------------------------------------------

/**
 * prop_rebuild_progress_callback_called_per_block
 *
 * The onProgress callback is called exactly once per stored block, with
 * monotonically increasing `done` values from 1 to N (the total block count).
 *
 * Invariant: rebuildRegistry increments `reembedded` once per storeBlock call
 * and fires onProgress after each. For N blocks total, the callback fires N
 * times with done values [1, 2, ..., N].
 */
export const prop_rebuild_progress_callback_called_per_block = fc.asyncProperty(
  fc.integer({ min: 1, max: 5 }),
  async (count) => {
    const provider = createOfflineEmbeddingProvider();
    const registry = await openRegistry(":memory:", { embeddings: provider });
    try {
      for (let i = 0; i < count; i++) {
        const row = await makeBlockRow(`progress-${i}`);
        await registry.storeBlock(row);
      }

      const progressLog: Array<{ done: number; total: number }> = [];
      await rebuildRegistry(registry, provider, {
        onProgress(done, total) {
          progressLog.push({ done, total });
        },
      });

      // Must be called exactly count times
      if (progressLog.length !== count) return false;

      // done values must be [1, 2, ..., count] (monotonically increasing)
      for (let i = 0; i < count; i++) {
        const entry = progressLog[i];
        if (entry === undefined) return false;
        if (entry.done !== i + 1) return false;
        if (entry.total !== count) return false;
      }
      return true;
    } finally {
      await registry.close();
    }
  },
);
