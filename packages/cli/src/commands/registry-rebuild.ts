// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-MODEL-MIGRATION-001
// title: `yakcc registry rebuild` command — embedding model migration path
// status: accepted (issue #338, WI-EMBED-MODEL-MIGRATION-PATH)
// rationale: After the bge-small-en-v1.5 swap (DEC-EMBED-MODEL-DEFAULT-002, PR #336),
//   existing registries contain embeddings from the old model (all-MiniLM-L6-v2).
//   This command re-embeds all stored blocks using the current provider, restoring
//   consistency without data loss. Atoms (BlockTripletRow data) are preserved byte-for-byte;
//   only the contract_embeddings rows (derived index) are regenerated.
//
//   Implementation: opens the registry with the current default provider, calls
//   rebuildRegistry() from @yakcc/registry, and reports progress + final count.
//
//   Design constraints:
//   - Idempotent: safe to run twice.
//   - Same-dimension only (384→384): no schema changes; DDL for contract_embeddings
//     is unchanged. Cross-dimension migration is out of scope for this WI.
//   - DEC-EMBED-010 preserved: after rebuild, the registry's vectors are consistent
//     with the provider; the cross-provider rejection gate will pass for this provider.
//   - NOT silent: reports progress and final count. Fail loudly on error.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  type Registry,
  type RegistryOptions,
  openRegistry,
  rebuildRegistry,
} from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/**
 * Internal options for registryRebuild — not exposed as CLI flags.
 */
export interface RegistryRebuildOptions {
  /** Embedding provider forwarded to openRegistry. Tests inject createOfflineEmbeddingProvider(). */
  embeddings?: RegistryOptions["embeddings"];
}

/**
 * Handler for `yakcc registry rebuild [--path <p>]`.
 *
 * Re-embeds all blocks in an existing registry using the current default embedding
 * provider. Useful after a model swap (DEC-EMBED-MODEL-DEFAULT-002) to migrate
 * existing registries to the new model without data loss.
 *
 * - Preserves all BlockTripletRow data byte-for-byte.
 * - Regenerates contract_embeddings vectors using the current provider.
 * - Reports block count and progress to the logger.
 * - Idempotent: safe to run multiple times.
 *
 * Exit codes:
 * - 0: success (registry rebuilt)
 * - 1: usage or runtime error
 *
 * @param argv   - Remaining argv after `registry rebuild` has been consumed.
 * @param logger - Output sink; defaults to console via the caller.
 * @param opts   - Internal options (embeddings for test injection).
 */
export async function registryRebuild(
  argv: readonly string[],
  logger: Logger,
  opts?: RegistryRebuildOptions,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      path: { type: "string", short: "p" },
    },
    allowPositionals: false,
    strict: true,
  });

  const registryPath = values.path ?? DEFAULT_REGISTRY_PATH;

  // Ensure parent directory exists (mirrors registry-init pattern).
  const parent = dirname(registryPath);
  mkdirSync(parent, { recursive: true });

  // Resolve the embedding provider to use for rebuilding.
  // If tests inject a provider, use it; otherwise the default (bge-small-en-v1.5)
  // is loaded lazily inside openRegistry.
  let embeddingProvider = opts?.embeddings;
  if (embeddingProvider === undefined) {
    // Load the default provider so we can pass it to rebuildRegistry() for modelId reporting.
    const { createLocalEmbeddingProvider } = await import("@yakcc/contracts");
    embeddingProvider = createLocalEmbeddingProvider();
  }

  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, { embeddings: embeddingProvider });
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  let lastReported = -1;
  try {
    logger.log(`rebuilding registry at ${registryPath}…`);

    const result = await rebuildRegistry(registry, embeddingProvider, {
      onProgress(done, total) {
        // Report every 100 blocks to avoid log spam on large registries.
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastReported && pct % 10 === 0) {
          lastReported = pct;
          logger.log(`  ${done}/${total} blocks re-embedded (${pct}%)`);
        }
      },
    });

    logger.log(
      `registry rebuilt: ${result.reembedded} blocks re-embedded with model ${result.modelId} at ${registryPath}`,
    );
    return 0;
  } catch (err) {
    logger.error(`error: registry rebuild failed: ${String(err)}`);
    return 1;
  } finally {
    await registry.close();
  }
}
