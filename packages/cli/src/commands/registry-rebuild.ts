// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-MODEL-MIGRATION-001
// title: `yakcc registry rebuild` command — embedding model migration path
// status: accepted (issue #338, WI-EMBED-MODEL-MIGRATION-PATH)
// rationale: After the bge-small-en-v1.5 swap (DEC-EMBED-MODEL-DEFAULT-002, PR #336),
//   existing registries contain embeddings from the old model (all-MiniLM-L6-v2).
//   This command re-embeds all stored blocks using the current provider, restoring
//   consistency without data loss.
//
//   Issue #778 (WI-778-BYO-EMBEDDING): added --embedding-provider, --embedding-model,
//   --embedding-base-url, --embedding-dimensions, and --embedding-dimension flags so
//   callers can swap to a hosted provider in one command. Cross-dimension migration
//   (e.g. 384→1536 for Voyage) is handled automatically by rebuildRegistry via
//   recreateEmbeddingsTable(). Uses autoRebuild:true to bypass the openRegistry
//   model-mismatch check (DEC-EMBED-REGISTRY-META-001).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  type Registry,
  type RegistryOptions,
  acquireWriteLock,
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
 * Handler for `yakcc registry rebuild [--path <p>]
 *   [--embedding-provider <local|openai|voyage|openai-compatible>]
 *   [--embedding-model <model>]
 *   [--embedding-base-url <url>]
 *   [--embedding-dimensions <N>]
 *   [--embedding-dimension <N>]`.
 *
 * Re-embeds all blocks in an existing registry using the specified provider.
 * Useful after a model swap to migrate existing registries to a new model.
 *
 * CLI flag precedence (highest to lowest):
 *   --embedding-provider  > YAKCC_EMBEDDING_PROVIDER env var > local default
 *   --embedding-model     > YAKCC_EMBEDDING_MODEL env var
 *   --embedding-base-url  > YAKCC_EMBEDDING_BASE_URL env var
 *   --embedding-dimensions > YAKCC_EMBEDDING_DIMENSIONS env var (OpenAI only)
 *   --embedding-dimension  > YAKCC_EMBEDDING_DIMENSION env var (openai-compatible only)
 *
 * Cross-dimension migration (e.g. 384→1536 for Voyage/OpenAI):
 *   rebuildRegistry automatically detects the dimension change and calls
 *   recreateEmbeddingsTable() before re-embedding all blocks. Atom data is preserved.
 *
 * - Preserves all BlockTripletRow data byte-for-byte.
 * - Regenerates contract_embeddings vectors using the current provider.
 * - Reports block count and progress to the logger.
 * - Idempotent: safe to run multiple times.
 *
 * Exit codes:
 * - 0: success (registry rebuilt)
 * - 1: usage or runtime error
 */
export async function registryRebuild(
  argv: readonly string[],
  logger: Logger,
  opts?: RegistryRebuildOptions,
): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        path: { type: "string"; short: "p" };
        "embedding-provider": { type: "string" };
        "embedding-model": { type: "string" };
        "embedding-base-url": { type: "string" };
        "embedding-dimensions": { type: "string" };
        "embedding-dimension": { type: "string" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        path: { type: "string", short: "p" },
        "embedding-provider": { type: "string" },
        "embedding-model": { type: "string" },
        "embedding-base-url": { type: "string" },
        "embedding-dimensions": { type: "string" },
        "embedding-dimension": { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc registry rebuild [--path <p>] [--embedding-provider <local|openai|voyage|openai-compatible>]",
    );
    logger.error(
      "                               [--embedding-model <model>] [--embedding-base-url <url>]",
    );
    logger.error(
      "                               [--embedding-dimensions <N>] [--embedding-dimension <N>]",
    );
    return 1;
  }

  const registryPath = parsed.values.path ?? DEFAULT_REGISTRY_PATH;

  // Ensure parent directory exists (mirrors registry-init pattern).
  const parent = dirname(registryPath);
  mkdirSync(parent, { recursive: true });

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = await acquireWriteLock(registryPath);
  } catch (err) {
    logger.error(`error: failed to acquire registry write lock: ${String(err)}`);
    return 1;
  }

  // Resolve the embedding provider to use for rebuilding.
  // Priority: opts.embeddings (test injection) > CLI flags > env vars > local default.
  let embeddingProvider = opts?.embeddings;

  if (embeddingProvider === undefined) {
    const providerFlag = parsed.values["embedding-provider"];
    const modelFlag = parsed.values["embedding-model"];
    const baseUrlFlag = parsed.values["embedding-base-url"];
    const dimensionsFlag = parsed.values["embedding-dimensions"];
    const dimensionFlag = parsed.values["embedding-dimension"];

    const contracts = await import("@yakcc/contracts");

    if (providerFlag !== undefined) {
      // CLI flags override env vars: temporarily set env vars from flags, then resolve.
      // Captures original env vars to restore after resolution (no lasting side-effects).
      const saved = {
        YAKCC_EMBEDDING_PROVIDER: process.env.YAKCC_EMBEDDING_PROVIDER,
        YAKCC_EMBEDDING_MODEL: process.env.YAKCC_EMBEDDING_MODEL,
        YAKCC_EMBEDDING_BASE_URL: process.env.YAKCC_EMBEDDING_BASE_URL,
        YAKCC_EMBEDDING_DIMENSIONS: process.env.YAKCC_EMBEDDING_DIMENSIONS,
        YAKCC_EMBEDDING_DIMENSION: process.env.YAKCC_EMBEDDING_DIMENSION,
      };
      process.env.YAKCC_EMBEDDING_PROVIDER = providerFlag;
      if (modelFlag !== undefined) process.env.YAKCC_EMBEDDING_MODEL = modelFlag;
      if (baseUrlFlag !== undefined) process.env.YAKCC_EMBEDDING_BASE_URL = baseUrlFlag;
      if (dimensionsFlag !== undefined) process.env.YAKCC_EMBEDDING_DIMENSIONS = dimensionsFlag;
      if (dimensionFlag !== undefined) process.env.YAKCC_EMBEDDING_DIMENSION = dimensionFlag;
      try {
        embeddingProvider =
          contracts.resolveEmbeddingProviderFromEnv() ?? contracts.createLocalEmbeddingProvider();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v !== undefined) process.env[k] = v;
          else delete process.env[k];
        }
      }
    } else {
      embeddingProvider =
        contracts.resolveEmbeddingProviderFromEnv() ?? contracts.createLocalEmbeddingProvider();
    }
  }

  let registry: Registry;
  try {
    // autoRebuild: true suppresses the model-mismatch throw in openRegistry
    // (DEC-EMBED-REGISTRY-META-001) since we're about to rebuild anyway.
    registry = await openRegistry(registryPath, {
      embeddings: embeddingProvider,
      autoRebuild: true,
    });
  } catch (err) {
    releaseLock();
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  let lastReported = -1;
  try {
    logger.log(
      `rebuilding registry at ${registryPath} with model "${embeddingProvider.modelId}" (dim=${embeddingProvider.dimension})…`,
    );

    const result = await rebuildRegistry(registry, embeddingProvider, {
      onProgress(done, total) {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastReported && pct % 10 === 0) {
          lastReported = pct;
          logger.log(`  ${done}/${total} blocks re-embedded (${pct}%)`);
        }
      },
    });

    logger.log(
      `registry rebuilt: ${result.reembedded} blocks re-embedded with model "${result.modelId}" ` +
        `(dim=${result.dimension}) at ${registryPath}`,
    );
    return 0;
  } catch (err) {
    logger.error(`error: registry rebuild failed: ${String(err)}`);
    return 1;
  } finally {
    await registry.close();
    releaseLock?.();
  }
}
