// SPDX-License-Identifier: MIT
// @decision DEC-CLI-SEED-001: seed opens the registry and delegates to seedRegistry()
// from @yakcc/seeds. seedRegistry() is idempotent (INSERT OR IGNORE), so running seed
// on an already-seeded registry is safe. Prints the stored count and a truncated list
// of block merkle roots, then exits 0.
// Status: updated (WI-T05, WI-384)
// Rationale: WI-T05 migrated SeedResult from contractIds: ContractId[] to
// merkleRoots: BlockMerkleRoot[] (T03/T04 API). Display updated accordingly.
// WI-384 adds --yakcc flag: when present, delegates to seedYakccCorpus() which
// imports the in-tree bootstrap corpus (~3k+ atoms) instead of the 20-block seed corpus.
// No author/ownership fields touched — DEC-NO-OWNERSHIP-011.

import { parseArgs } from "node:util";
import { type Registry, type RegistryOptions, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";
import { seedYakccCorpus } from "./seed-yakcc.js";

/** Maximum number of merkle roots to print in the summary line. */
const MAX_ROOTS_SHOWN = 3;

/** Internal options for seed — not exposed in CLI args. */
export interface SeedOptions {
  /** Embedding provider forwarded to openRegistry. Tests inject createOfflineEmbeddingProvider(). */
  embeddings?: RegistryOptions["embeddings"];
  /**
   * Override path to the bootstrap corpus sqlite for --yakcc mode.
   *
   * Production: omit — resolved automatically by findBootstrapSqlite() in seed-yakcc.ts.
   * Tests (git worktree): pass the real path since the worktree root differs
   * from the main checkout where bootstrap/ lives.
   * Forwarded directly to seedYakccCorpus() (DEC-CLI-SEED-YAKCC-001).
   */
  corpusPath?: string;
}

/**
 * Handler for `yakcc seed [--yakcc] [--registry <p>]`.
 *
 * Without --yakcc: opens the registry and calls seedRegistry() to ingest all
 * seed corpus blocks (the original 20-block parse-int-list seed).
 *
 * With --yakcc: imports the in-tree bootstrap corpus (~3k+ real-shaved atoms)
 * via seedYakccCorpus(). See DEC-CLI-SEED-YAKCC-001 in seed-yakcc.ts.
 *
 * Both paths are idempotent (INSERT OR IGNORE; DEC-STORAGE-IDEMPOTENT-001).
 *
 * @param argv - Remaining argv after `seed` has been consumed.
 * @param logger - Output sink; defaults to console via the caller.
 * @param opts  - Internal options (embeddings for test injection).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function seed(
  argv: readonly string[],
  logger: Logger,
  opts?: SeedOptions,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      yakcc: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const useYakccCorpus = values.yakcc === true;

  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, { embeddings: opts?.embeddings });
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    if (useYakccCorpus) {
      // --yakcc flag: import the bootstrap corpus (DEC-CLI-SEED-YAKCC-001).
      const yakccOpts: import("./seed-yakcc.js").SeedYakccOptions = {};
      if (opts?.embeddings !== undefined) yakccOpts.embeddings = opts.embeddings;
      if (opts?.corpusPath !== undefined) yakccOpts.corpusPath = opts.corpusPath;
      const imported = await seedYakccCorpus(registry, yakccOpts, logger);
      logger.log(`yakcc seed --yakcc: done — ${imported} atoms processed from bootstrap corpus`);
      return 0;
    }

    // Default path: ingest the 20-block seed corpus from @yakcc/seeds.
    const result = await seedRegistry(registry);

    // Show abbreviated roots (first 8 hex chars each) for readability.
    const shown = result.merkleRoots.slice(0, MAX_ROOTS_SHOWN).map((r) => r.slice(0, 8));
    const rest = result.merkleRoots.length - shown.length;
    const rootList = rest > 0 ? `${shown.join(", ")}, … (+${rest} more)` : shown.join(", ");

    logger.log(`seeded ${result.stored} contracts; ids: ${rootList}`);
    return 0;
  } catch (err) {
    logger.error(`error: seed failed: ${String(err)}`);
    return 1;
  } finally {
    await registry.close();
  }
}
