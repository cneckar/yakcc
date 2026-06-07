// SPDX-License-Identifier: MIT
//
// export-atom-index.ts — handler for `yakcc export-atom-index`
//
// Emits two static JSON files from the bootstrap corpus:
//   atoms.json    — one card per distinct spec_hash (4829 for the bootstrap corpus)
//   embeddings.json — one 384-dim vector per spec_hash, index-aligned to atoms.json
//
// Both files carry a model stamp (Xenova/bge-small-en-v1.5, dimension 384) so
// the browser-side consumer can verify it uses the same model for query embedding.
//
// The output is consumable by @yakcc/discovery-search's rankCandidates():
//   rankCandidates(queryVec, vectors.map(v => Float32Array.from(v.vector)))
//   → RankedResult.index → atoms[index]
//
// @decision DEC-1117-S2-EXPORTER-001
// @title CLI command (not .mjs) for vitest-testability + corpus-path reuse
// @status decided (WI-1117 Slice 2)
// @rationale
//   A CLI command is vitest-testable via runCli() / the command handler directly,
//   consistent with seed-yakcc.ts, and reuses the proven corpus-resolution +
//   registry-open path. A standalone .mjs script cannot be imported by vitest's
//   module resolver in the same way and would require a separate test harness.
//   The command shares findBootstrapSqlite() (copied here for isolation —
//   acceptable for the first cut per the plan) and openRegistry with the
//   local embedding provider (DEC-1123-SEED-BGE-NATIVE-001).

// @decision DEC-1117-S2-EXPORTER-002
// @title Two output files: atoms.json + embeddings.json with shared specHash ordering
// @status decided (WI-1117 Slice 2)
// @rationale
//   Card metadata (small, human-diffable, frontend renders eagerly) and the vector
//   index (large, ~4829×384 floats, frontend may lazy-load) have different size and
//   lifecycle profiles. Splitting lets the explorer fetch cards first and vectors on
//   demand. Both share the same ASC specHash ordering so the explorer can zip by index:
//   atoms[i].specHash === vectors[i].specHash for all i (index-aligned invariant).

// @decision DEC-1117-S2-CARD-001
// @title MUST card fields from SpecYak+row; derived counts deferred behind --with-counts
// @status decided (WI-1117 Slice 2)
// @rationale
//   First cut: MUST fields only — specHash, blockMerkleRoot, name, signature,
//   behavior, level, nonFunctional, source. All are directly corpus-backed and
//   verified. Derived counts (reuseCount, passingTestRuns, runtime exposure) require
//   extra per-spec aggregation queries; gated behind --with-counts in a follow-up
//   to keep the first cut tight and the exporter read-only without complex joins.

// @decision DEC-1117-S2-CARD-002
// @title license/root excluded — absent from registry schema; do not synthesize
// @status decided (WI-1117 Slice 2)
// @rationale
//   Verification of the bootstrap corpus confirms: the blocks table has no
//   license/root column; proof_manifest_json carries only artifacts. Including
//   fabricated values would be a lie; omitting is the correct first cut.
//   Recorded here as a NICE follow-up if a license/root authority is added.

// @decision DEC-1117-S2-IDENTITY-001
// @title Atom identity = spec_hash; representative block = lowest blockMerkleRoot
// @status decided (WI-1117 Slice 2)
// @rationale
//   The corpus has 4904 blocks but only 4829 distinct spec_hashes — multiple
//   implementations share one contract. The KNN read path (vec0 PK = spec_hash)
//   already collapses to one embedding per spec. One card per spec_hash is the
//   natural identity. For a spec with N blocks the lexicographically-lowest
//   blockMerkleRoot is the representative (stable, content-addressed, deterministic).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLocalEmbeddingProvider } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { type RegistryOptions, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Default output directory (repo tmp — Sacred Practice #3, never /tmp)
// ---------------------------------------------------------------------------

const DEFAULT_OUT_DIR = "tmp/atom-index";

// ---------------------------------------------------------------------------
// findBootstrapSqlite — locate bootstrap/yakcc.registry.sqlite
//
// Copied from seed-yakcc.ts (acceptable for the first cut per plan §2 rationale).
// Both walk from import.meta.url upward looking for bootstrap/yakcc.registry.sqlite.
// This handles main checkout and git worktree layouts.
// ---------------------------------------------------------------------------

function findBootstrapSqlite(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, "bootstrap", "yakcc.registry.sqlite");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output schema types (internal; serialized to JSON)
// ---------------------------------------------------------------------------

/** One card in atoms.json.atoms. */
interface AtomCard {
  readonly specHash: string;
  readonly blockMerkleRoot: string;
  readonly name: string;
  readonly signature: {
    readonly inputs: ReadonlyArray<{ readonly name: string; readonly type: string }>;
    readonly outputs: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  };
  readonly behavior: string | null;
  readonly level: "L0" | "L1" | "L2" | "L3";
  readonly nonFunctional: {
    readonly purity: string;
    readonly threadSafety: string;
    readonly time: string | null;
    readonly space: string | null;
  };
  readonly source: {
    readonly pkg: string | null;
    readonly file: string | null;
  };
}

/** atoms.json root shape. */
interface AtomsJson {
  readonly schemaVersion: 1;
  readonly model: { readonly id: string; readonly dimension: number };
  readonly corpus: { readonly atomCount: number; readonly source: string };
  readonly atoms: readonly AtomCard[];
}

/** One entry in embeddings.json.vectors. */
interface VectorEntry {
  readonly specHash: string;
  readonly vector: readonly number[];
}

/** embeddings.json root shape. */
interface EmbeddingsJson {
  readonly schemaVersion: 1;
  readonly model: { readonly id: string; readonly dimension: number };
  readonly count: number;
  readonly vectors: readonly VectorEntry[];
}

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface ExportAtomIndexOptions {
  /**
   * Embedding provider override.
   * Production: omit (uses createLocalEmbeddingProvider).
   * Tests: pass bgeStubEmbeddings (matches stored modelId without loading ONNX).
   */
  embeddings?: RegistryOptions["embeddings"];
  /**
   * Override the corpus sqlite path.
   * Production: omit (resolved by findBootstrapSqlite()).
   * Tests (worktrees): pass the real path.
   */
  corpusPath?: string;
}

// ---------------------------------------------------------------------------
// exportAtomIndex — main command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc export-atom-index [--out <dir>] [--corpus <path>]`.
 *
 * Opens the bootstrap corpus (read-only), reads all cards and embedding vectors,
 * and emits atoms.json + embeddings.json to the output directory.
 *
 * Fail-loud contract:
 *   - Missing corpus → non-zero exit, clear error message.
 *   - Any vector dimension mismatch → throw (registry.exportAllEmbeddings tripwire).
 *   - specHash set mismatch (orphan on either side) → throw (forbidden shortcut).
 *   - No silent empty output.
 *
 * @param argv   - Remaining argv after `export-atom-index` has been consumed.
 * @param logger - Output sink.
 * @param opts   - Injection seams for tests (embeddings provider, corpus path).
 * @returns Process exit code (0 success, 1 error).
 */
export async function exportAtomIndex(
  argv: readonly string[],
  logger: Logger,
  opts?: ExportAtomIndexOptions,
): Promise<number> {
  // Parse arguments.
  let parsedValues: {
    out: string | undefined;
    corpus: string | undefined;
  };
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        out: { type: "string" },
        corpus: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    parsedValues = values as typeof parsedValues;
  } catch (err) {
    logger.error(`error: ${String(err)}`);
    logger.error("Usage: yakcc export-atom-index [--out <dir>] [--corpus <path>]");
    return 1;
  }

  const outDir = resolve(parsedValues.out ?? DEFAULT_OUT_DIR);

  // Resolve corpus path. Fail loud if missing.
  // opts.corpusPath is the injection seam for tests; production resolves automatically.
  const corpusPath = opts?.corpusPath ?? parsedValues.corpus ?? findBootstrapSqlite();
  if (corpusPath === null || !existsSync(corpusPath)) {
    logger.error(
      `error: bootstrap corpus not found at ${corpusPath ?? "(no path resolved)"}. Expected bootstrap/yakcc.registry.sqlite relative to the repo root. Use --corpus <path> to specify an alternative.`,
    );
    return 1;
  }
  const resolvedCorpus = resolve(corpusPath);

  logger.log(`export-atom-index: opening corpus at ${resolvedCorpus}`);

  // Open the corpus registry (read-only intent; openRegistry is always R/W but we don't mutate).
  // Use the provided embeddings override or createLocalEmbeddingProvider() so the stored
  // model ID matches (DEC-1123-SEED-BGE-NATIVE-001).
  const embeddingsProvider = opts?.embeddings ?? createLocalEmbeddingProvider();

  let registry: Awaited<ReturnType<typeof openRegistry>>;
  try {
    registry = await openRegistry(resolvedCorpus, { embeddings: embeddingsProvider });
  } catch (err) {
    logger.error(`error: failed to open corpus at ${resolvedCorpus}: ${String(err)}`);
    return 1;
  }

  try {
    // Read the model stamp from registry_meta — single authority (DEC-EMBED-REGISTRY-META-001).
    const modelId = await registry.getStoredEmbeddingModelId();
    const modelDimension = await registry.getStoredEmbeddingDimension();

    if (modelId === null || modelDimension === null) {
      logger.error(
        "error: registry_meta has no embedding_model_id or embedding_dimension. The corpus may not have been embedded yet. Run `yakcc bootstrap` first.",
      );
      return 1;
    }

    logger.log(`export-atom-index: model=${modelId} dimension=${modelDimension}`);

    // Read all embedding vectors via the registry authority (DEC-1117-S2-VECREAD-001).
    // exportAllEmbeddings() returns ASC-by-spec_hash, length-validated entries.
    logger.log("export-atom-index: reading embedding vectors...");
    const embeddingRows = await registry.exportAllEmbeddings();
    logger.log(`export-atom-index: ${embeddingRows.length} embedding vectors read`);

    // Read all blocks via exportManifest → getBlock, collapsed to one card per spec_hash.
    // Representative block = lexicographically-lowest blockMerkleRoot (DEC-1117-S2-IDENTITY-001).
    logger.log("export-atom-index: reading block manifest...");
    const manifest = await registry.exportManifest();
    logger.log(`export-atom-index: ${manifest.length} block manifest entries`);

    // Collapse blocks to one representative per spec_hash (lowest BMR).
    // Map: specHash → { blockMerkleRoot, level, sourcePkg, sourceFile }
    interface RepresentativeInfo {
      blockMerkleRoot: string;
      level: "L0" | "L1" | "L2" | "L3";
      sourcePkg: string | null;
      sourceFile: string | null;
      specCanonicalBytes: Uint8Array;
    }
    const repBySpec = new Map<string, RepresentativeInfo>();

    for (const entry of manifest) {
      const existing = repBySpec.get(entry.specHash);
      if (existing === undefined || entry.blockMerkleRoot < existing.blockMerkleRoot) {
        // Hydrate the block to read level and source provenance.
        const block = await registry.getBlock(
          entry.blockMerkleRoot as import("@yakcc/contracts").BlockMerkleRoot,
        );
        if (block === null) {
          // Fail loud — manifest entry without a corresponding block is corruption.
          logger.error(
            `error: manifest entry ${entry.blockMerkleRoot} not found in block table. The corpus may be corrupted.`,
          );
          return 1;
        }
        repBySpec.set(entry.specHash, {
          blockMerkleRoot: entry.blockMerkleRoot,
          level: block.level,
          sourcePkg: block.sourcePkg ?? null,
          sourceFile: block.sourceFile ?? null,
          specCanonicalBytes: block.specCanonicalBytes,
        });
      }
    }

    logger.log(
      `export-atom-index: collapsed to ${repBySpec.size} distinct spec_hashes (from ${manifest.length} blocks)`,
    );

    // Build the cards array — one per spec_hash, ASC by spec_hash.
    // Sort the representative keys to guarantee deterministic ordering.
    const sortedSpecHashes = Array.from(repBySpec.keys()).sort();

    // Fail-loud join: assert every spec_hash in cards has an embedding and vice versa.
    const embeddingSpecHashes = new Set(embeddingRows.map((e) => e.specHash));
    const cardSpecHashes = new Set(sortedSpecHashes);

    for (const sh of cardSpecHashes) {
      if (!embeddingSpecHashes.has(sh as import("@yakcc/contracts").SpecHash)) {
        logger.error(
          `error: spec_hash ${sh} has a card but no embedding vector. The corpus is inconsistent. Run \`yakcc registry rebuild\` or \`yakcc bootstrap\`.`,
        );
        return 1;
      }
    }
    for (const sh of embeddingSpecHashes) {
      if (!cardSpecHashes.has(sh)) {
        logger.error(
          `error: spec_hash ${sh} has an embedding vector but no block. The corpus is inconsistent.`,
        );
        return 1;
      }
    }

    // Verify counts are identical (belt-and-suspenders after the set checks above).
    if (embeddingRows.length !== sortedSpecHashes.length) {
      logger.error(
        `error: embedding count (${embeddingRows.length}) !== card count (${sortedSpecHashes.length}). The corpus is inconsistent.`,
      );
      return 1;
    }

    // Build cards in ASC spec_hash order.
    const cards: AtomCard[] = [];
    for (const specHash of sortedSpecHashes) {
      const rep = repBySpec.get(specHash);
      if (rep === undefined) {
        // Should never happen after the join above.
        logger.error(`error: internal inconsistency: no representative for specHash=${specHash}`);
        return 1;
      }

      // Parse the spec from stored canonical bytes.
      // Precedent: storage.ts ~302 uses the same JSON.parse pattern.
      const spec = JSON.parse(Buffer.from(rep.specCanonicalBytes).toString("utf-8")) as SpecYak;

      cards.push({
        specHash,
        blockMerkleRoot: rep.blockMerkleRoot,
        name: spec.name,
        signature: {
          inputs: (spec.inputs ?? []).map((p) => ({ name: p.name, type: p.type })),
          outputs: (spec.outputs ?? []).map((p) => ({ name: p.name, type: p.type })),
        },
        behavior: spec.behavior ?? null,
        level: rep.level,
        nonFunctional: {
          purity: spec.nonFunctional?.purity ?? "pure",
          threadSafety: spec.nonFunctional?.threadSafety ?? "safe",
          time: spec.nonFunctional?.time ?? null,
          space: spec.nonFunctional?.space ?? null,
        },
        source: {
          pkg: rep.sourcePkg,
          file: rep.sourceFile,
        },
      });
    }

    // Build vectors array — ASC by spec_hash (embeddingRows is already sorted ASC
    // by spec_hash via exportAllEmbeddings ORDER BY spec_hash ASC).
    // We must emit them in the same sorted order as cards for index-alignment.
    const vectorMap = new Map(embeddingRows.map((e) => [e.specHash, e.vector]));
    const vectors: VectorEntry[] = sortedSpecHashes.map((specHash) => ({
      specHash,
      vector: vectorMap.get(specHash as import("@yakcc/contracts").SpecHash) ?? [],
    }));

    // Assemble output objects with fixed key order for deterministic JSON.stringify.
    const model = { id: modelId, dimension: modelDimension };
    const corpusRelative = resolvedCorpus.includes("bootstrap")
      ? "bootstrap/yakcc.registry.sqlite"
      : resolvedCorpus;

    const atomsJson: AtomsJson = {
      schemaVersion: 1,
      model,
      corpus: { atomCount: cards.length, source: corpusRelative },
      atoms: cards,
    };

    const embeddingsJson: EmbeddingsJson = {
      schemaVersion: 1,
      model,
      count: vectors.length,
      vectors,
    };

    // Write output files.
    mkdirSync(outDir, { recursive: true });

    const atomsPath = join(outDir, "atoms.json");
    const embeddingsPath = join(outDir, "embeddings.json");

    writeFileSync(atomsPath, `${JSON.stringify(atomsJson, null, 2)}\n`, "utf-8");
    writeFileSync(embeddingsPath, `${JSON.stringify(embeddingsJson, null, 2)}\n`, "utf-8");

    logger.log(`export-atom-index: wrote ${cards.length} atoms → ${atomsPath}`);
    logger.log(`export-atom-index: wrote ${vectors.length} vectors → ${embeddingsPath}`);
    logger.log("export-atom-index: done");

    return 0;
  } finally {
    await registry.close();
  }
}
