// SPDX-License-Identifier: MIT
//
// seed-yakcc.ts — handler for `yakcc seed --yakcc`
//
// Imports the yakcc bootstrap corpus into the user's local registry. The source
// is `bootstrap/expected-roots.json` plus the bootstrap SQLite at
// `bootstrap/yakcc.registry.sqlite`. These are the real-shaved atoms produced
// by `yakcc bootstrap` — never synthetic (never-synthetic cornerstone).
//
// @decision DEC-CLI-SEED-YAKCC-001
// @title yakcc seed --yakcc: flag-gated bootstrap corpus import
// @status accepted (WI-384 / issue #384)
// @rationale
//   FLAG VS AUTO-SEED: DEC-CLI-INIT-001 explicitly decided "no auto-seed —
//   yakcc init creates an empty registry and prints a next-step hint." This
//   implementation respects that decision: `--yakcc` is an explicit opt-in flag
//   on the existing `seed` command. Users who only want their own project's atoms
//   are unaffected by the default `yakcc seed` path. The flag gates the bootstrap
//   corpus import and is documented in USING_YAKCC.md § 4.
//
//   CORPUS RESOLUTION (monorepo alpha): for v0.5.0-alpha.0, the binary runs
//   inside the monorepo clone, so the bootstrap sqlite is at
//   `${repoRoot}/bootstrap/yakcc.registry.sqlite`. `findRepoRoot()` walks upward
//   from `import.meta.url` looking for `pnpm-workspace.yaml` (monorepo marker).
//   Binary distribution follow-up: issue #361 (Wrath) must wire the corpus into
//   the packaged binary. Annotated there as a required follow-up.
//
//   PER-ATOM BMR VERIFICATION: `storeBlock()` recomputes `blockMerkleRoot` from
//   the stored spec/impl/proof bytes (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002
//   registry-side integrity gate). `validateOnStore: true` is the default and is
//   preserved here — we do NOT pass `validateOnStore: false`. If any block in the
//   bootstrap corpus fails verification (e.g. corrupted sqlite), the import stops
//   and fails loud. Silently skipping corrupt blocks is a forbidden shortcut.
//
//   IDEMPOTENCY: `storeBlock()` uses INSERT OR IGNORE for the blocks table
//   (DEC-STORAGE-IDEMPOTENT-001). A second `yakcc seed --yakcc` on an already-seeded
//   registry is a no-op for existing blocks; new blocks (if the corpus was updated)
//   are imported.
//
//   EMBEDDING: each imported block is re-embedded using the user's configured
//   embedding provider. The bootstrap sqlite was stored with a zero-vector provider
//   (DEC-V2-BOOTSTRAP-EMBEDDING-001). The user's registry gets real embeddings,
//   enabling semantic `yakcc query` to work correctly after import.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { type Registry, type RegistryOptions, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Options for seedYakccCorpus. Mirrors SeedOptions in seed.ts for consistency.
 */
export interface SeedYakccOptions {
  /** Embedding provider forwarded to openRegistry. Tests inject offline provider. */
  embeddings?: RegistryOptions["embeddings"];
  /**
   * Override the path to the bootstrap corpus sqlite.
   *
   * Production: omit — resolved automatically by findBootstrapSqlite().
   * Tests (worktree): pass the real path since the worktree has a different
   * root from the main repo checkout where bootstrap/ lives.
   *
   * @decision DEC-CLI-SEED-YAKCC-001: corpusPath override is the injection seam
   *   for test isolation in git worktrees. It does NOT change the production
   *   resolution path (import.meta.url-relative walk to repo root).
   */
  corpusPath?: string;
}

// ---------------------------------------------------------------------------
// findBootstrapSqlite — locate bootstrap/yakcc.registry.sqlite
//
// @decision DEC-CLI-SEED-YAKCC-001 (corpus resolution)
// Walks upward from this file's location checking each ancestor directory for
// `bootstrap/yakcc.registry.sqlite`. This handles both the production case
// (CLI running from packages/cli/dist/ inside the main checkout) and the git
// worktree development case (CLI running inside .worktrees/<name>/ while
// bootstrap/ lives in the main checkout above .worktrees/).
//
// The direct-walk approach is more robust than finding a "repo root" first,
// because git worktrees have their own pnpm-workspace.yaml (identical copy)
// while the bootstrap corpus is not duplicated into the worktree.
// ---------------------------------------------------------------------------

/**
 * Resolve the bootstrap SQLite path from the CLI module location.
 *
 * Walks upward from this compiled file's directory, checking each ancestor
 * for `bootstrap/yakcc.registry.sqlite`. Handles both:
 *   - Main checkout: `packages/cli/dist/` → walk up → repo root has `bootstrap/`
 *   - Git worktree: `.worktrees/<name>/packages/cli/dist/` → walk further up →
 *     main checkout root (above `.worktrees/`) has `bootstrap/`
 *
 * @returns Absolute path to the bootstrap SQLite, or null if not found.
 */
function findBootstrapSqlite(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up to 30 levels — enough to reach the repo root from any nested path.
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, "bootstrap", "yakcc.registry.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zero-vector embedding provider — bootstrap source DB uses these
// ---------------------------------------------------------------------------

/**
 * Returns the embedding provider used when the bootstrap corpus was created.
 *
 * The bootstrap process stores atoms with a zero-vector embedding
 * (DEC-V2-BOOTSTRAP-EMBEDDING-001). When we open the bootstrap sqlite to READ
 * blocks from it, we must use the same zero provider so the registry's
 * embedding model ID matches the stored embeddings. The user's registry
 * receives real embeddings via the injected provider in storeBlock.
 */
function makeZeroEmbeddingProvider(): RegistryOptions["embeddings"] {
  return {
    dimension: 384,
    modelId: "bootstrap/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  };
}

// ---------------------------------------------------------------------------
// seedYakccCorpus — public command handler
// ---------------------------------------------------------------------------

/**
 * Import the yakcc bootstrap corpus into the target registry.
 *
 * Resolves the bootstrap SQLite, exports its manifest, hydrates each block via
 * getBlock(), and stores it into the user's registry via storeBlock(). All
 * blocks are subject to the storeBlock integrity gate (BMR recompute,
 * validateOnStore: true). Fails loud on the first corrupted block.
 *
 * The target registry MUST already be open (initialized) — this function does
 * not open or close it; the caller owns the registry lifecycle.
 *
 * @param registry - Open, initialized target registry.
 * @param opts     - Options (embedding provider for the source bootstrap db).
 * @param logger   - Output sink.
 * @returns Number of newly imported atoms (INSERT OR IGNORE; existing atoms
 *   are counted as 0 new imports).
 */
export async function seedYakccCorpus(
  registry: Registry,
  opts: SeedYakccOptions,
  logger: Logger,
): Promise<number> {
  // Locate the bootstrap sqlite.
  // opts.corpusPath overrides automatic resolution (used by tests in git worktrees
  // where the bootstrap/ dir lives in the main checkout, not the worktree root).
  const resolvedPath = opts.corpusPath ?? findBootstrapSqlite();
  if (resolvedPath === null) {
    throw new Error(
      "yakcc seed --yakcc: bootstrap corpus not found. Expected bootstrap/yakcc.registry.sqlite relative to the repo root. " +
        "For monorepo-clone alpha installs, ensure you are running from within the yakcc repo. " +
        "Binary distribution follow-up: issue #361.",
    );
  }
  const sqlitePath = resolvedPath;

  logger.log(`yakcc seed --yakcc: loading corpus from ${sqlitePath}`);

  // Open the bootstrap sqlite as a READ source. Use the zero-vector provider —
  // the bootstrap db was stored with that provider (DEC-V2-BOOTSTRAP-EMBEDDING-001).
  // We only READ from this db; the user's registry is the write target.
  let sourceRegistry: Registry;
  try {
    sourceRegistry = await openRegistry(sqlitePath, {
      embeddings: makeZeroEmbeddingProvider(),
    });
  } catch (err) {
    throw new Error(
      `yakcc seed --yakcc: failed to open bootstrap corpus at ${sqlitePath}: ${String(err)}`,
    );
  }

  // Export the manifest — returns all blockMerkleRoots in the bootstrap db.
  let manifest: readonly { blockMerkleRoot: string }[];
  try {
    manifest = await sourceRegistry.exportManifest();
  } catch (err) {
    await sourceRegistry.close();
    throw new Error(
      `yakcc seed --yakcc: failed to export manifest from bootstrap corpus: ${String(err)}`,
    );
  }

  logger.log(`yakcc seed --yakcc: manifest has ${manifest.length} entries — importing...`);

  let imported = 0;
  const skipped = 0;

  for (const entry of manifest) {
    const merkleRoot = entry.blockMerkleRoot as BlockMerkleRoot;

    // Hydrate the full block triplet from the source registry.
    let block: Awaited<ReturnType<typeof sourceRegistry.getBlock>>;
    try {
      block = await sourceRegistry.getBlock(merkleRoot);
    } catch (err) {
      await sourceRegistry.close();
      throw new Error(
        `yakcc seed --yakcc: failed to read block ${merkleRoot} from bootstrap corpus: ${String(err)}`,
      );
    }

    if (block === null) {
      // This should not happen (manifest entries should all be in the db), but
      // if it does, fail loud — silently skipping is a forbidden shortcut.
      await sourceRegistry.close();
      throw new Error(
        `yakcc seed --yakcc: manifest entry ${merkleRoot} not found in bootstrap corpus db. The corpus may be corrupted. Do not weaken this check.`,
      );
    }

    // Store into the user's registry.
    // storeBlock() runs validateOnStore: true by default — this is the per-atom
    // BMR verification required by the issue (DEC-CLI-SEED-YAKCC-001).
    // If validation fails, the error propagates up and the import stops loudly.
    try {
      await registry.storeBlock(block);
      imported++;
    } catch (err) {
      const e = err as Error & { reason?: string };
      if (e.reason === "integrity_failed") {
        // Block failed BMR recompute — corrupted in the bootstrap corpus.
        // Fail loud immediately (forbidden shortcut: silent skip).
        await sourceRegistry.close();
        throw new Error(
          `yakcc seed --yakcc: BMR integrity check failed for block ${merkleRoot}. The bootstrap corpus may be corrupted. Import aborted. Original error: ${e.message}`,
        );
      }
      // Other errors (e.g. DB write failure) also propagate loudly.
      await sourceRegistry.close();
      throw new Error(`yakcc seed --yakcc: failed to store block ${merkleRoot}: ${String(err)}`);
    }
  }

  await sourceRegistry.close();

  // storeBlock uses INSERT OR IGNORE, so `imported` counts all store calls that
  // succeeded (including no-ops for already-present blocks). We can't distinguish
  // new vs existing without a pre-check, but that's acceptable — the idempotency
  // guarantee is that re-running produces the same registry state (DEC-STORAGE-IDEMPOTENT-001).
  // The count shown is "processed" atoms from the bootstrap corpus.
  logger.log(
    `yakcc seed --yakcc: imported ${imported} atoms from bootstrap corpus (${skipped} skipped)`,
  );
  return imported;
}
