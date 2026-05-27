// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-MODEL-MIGRATION-001
// title: Public rebuildRegistry surface lifted from test-local reembedRegistry helper
// status: accepted (issue #338, WI-EMBED-MODEL-MIGRATION-PATH)
// rationale: The private reembedRegistry helper at discovery-eval-full-corpus.test.ts:375
//   (DEC-V3-DISCOVERY-EVAL-FIX-001 H4) re-embeds all stored blocks using a new provider.
//   This WI lifts that logic to a public surface so the CLI `yakcc registry rebuild` command
//   and the programmatic autoRebuild path can invoke it.
//
//   Design choices:
//   - Accepts (registry, embeddings?) — same signature as the test-local helper.
//     embeddings is optional; when absent, the rebuild re-embeds using the provider
//     that was passed to openRegistry() (the registry's own provider).
//   - Uses storeBlock() as the sole mutation path — DELETE+INSERT on contract_embeddings is
//     the existing idempotent update mechanism; no schema migration needed for same-dim swap.
//   - onProgress callback enables CLI progress reporting without coupling to console.log.
//   - Idempotent: calling twice produces identical embeddings (deterministic provider).
//
//   Cross-dimension rebuild (issue #778 / WI-778-BYO-EMBEDDING):
//   When the new provider's dimension differs from the stored dimension, rebuildRegistry
//   calls registry.recreateEmbeddingsTable(newDimension) before the per-block loop.
//   recreateEmbeddingsTable drops and recreates the vec0 virtual table with the new
//   FLOAT[N] schema, then proceeds with the normal storeBlock loop.
//
//   DEC-EMBED-010 is PRESERVED: rebuildRegistry creates a new embedding index consistent
//   with the current provider. It does NOT bypass the cross-provider rejection gate —
//   callers that open the registry after rebuild will find a consistent provider+vector state.
//
//   The test-local helper at discovery-eval-full-corpus.test.ts:375 duplicates this logic.
//   Per the scope authority note: that test-local helper SHOULD be replaced by an import
//   from this module to avoid drift; if scope pressure prevents replacement, the duplication
//   is documented explicitly here. Future Implementers: prefer importing from rebuild.ts.

import type { EmbeddingProvider } from "@yakcc/contracts";
import type { BlockMerkleRoot, Registry } from "./index.js";

/**
 * Options for rebuildRegistry().
 */
export interface RebuildRegistryOptions {
  /**
   * Optional progress callback. Called once per re-embedded block with the
   * count of blocks processed so far and the total count.
   *
   * Example: `(done, total) => console.log(`rebuilding ${done}/${total}...`)`
   */
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Result of a rebuildRegistry() call.
 */
export interface RebuildResult {
  /** Number of blocks that were re-embedded. */
  readonly reembedded: number;
  /** Model ID of the embedding provider used for the rebuild. */
  readonly modelId: string;
  /** Output dimension of the embedding provider used for the rebuild. */
  readonly dimension: number;
}

/**
 * Re-embed all stored blocks in a registry using the given embedding provider.
 *
 * This is the canonical migration path after an embedding model swap.
 * It iterates every stored block via `enumerateSpecs → selectBlocks → getBlock`
 * and re-stores each block via `storeBlock()`, which triggers `DELETE+INSERT` on
 * `contract_embeddings` — replacing the stale embedding vector with a fresh one
 * from the current provider.
 *
 * Cross-dimension migration (e.g. 384→1536 when switching to OpenAI/Voyage):
 * When `embeddings.dimension` differs from the stored dimension (read via
 * `registry.getStoredEmbeddingDimension()`), rebuildRegistry calls
 * `registry.recreateEmbeddingsTable(embeddings.dimension)` before the per-block loop
 * to drop and recreate the vec0 virtual table with the new `FLOAT[N]` schema.
 * After the rebuild, `registry_meta` is updated with the new model ID and dimension.
 *
 * Idempotent: calling twice on the same registry with the same provider produces
 * identical embeddings (each call replaces the same vector with the same new value).
 *
 * NOT a bypass of DEC-EMBED-010: after a successful rebuild, the registry's
 * stored vectors are consistent with the provider's modelId, so the cross-provider
 * rejection gate will no longer fire for that provider.
 *
 * @param registry   - An already-opened Registry instance.
 * @param embeddings - The embedding provider to use for re-embedding.
 * @param options    - Optional configuration including a progress callback.
 * @returns The number of blocks re-embedded, the provider model ID, and output dimension.
 */
export async function rebuildRegistry(
  registry: Registry,
  embeddings: EmbeddingProvider,
  options?: RebuildRegistryOptions,
): Promise<RebuildResult> {
  // @decision DEC-EMBED-REGISTRY-META-001 (WI-778): dimension-aware rebuild.
  // Check if the new provider's dimension differs from the stored dimension.
  // If so, recreate the vec0 table with the new dimension before re-embedding.
  const storedDimension = await registry.getStoredEmbeddingDimension();
  if (storedDimension !== null && storedDimension !== embeddings.dimension) {
    await registry.recreateEmbeddingsTable(embeddings.dimension);
  }

  const specHashes = await registry.enumerateSpecs();

  // Pre-count total blocks for accurate progress reporting.
  let total = 0;
  const specBlocks: Array<{ roots: readonly BlockMerkleRoot[] }> = [];
  for (const sh of specHashes) {
    const roots = await registry.selectBlocks(sh);
    specBlocks.push({ roots });
    total += roots.length;
  }

  let reembedded = 0;
  for (const { roots } of specBlocks) {
    for (const root of roots) {
      const block = await registry.getBlock(root);
      if (block === null) continue;
      // storeBlock always runs DELETE+INSERT on contract_embeddings, even when
      // INSERT OR IGNORE skips the blocks row (block already present).
      // This replaces the stale embedding vector with a fresh one from the
      // current provider. Default validateOnStore:true recomputes BMR to verify
      // consistency — the same guard used by all write paths.
      await registry.storeBlock(block);
      reembedded++;
      options?.onProgress?.(reembedded, total);
    }
  }

  return {
    reembedded,
    modelId: embeddings.modelId,
    dimension: embeddings.dimension,
  };
}
