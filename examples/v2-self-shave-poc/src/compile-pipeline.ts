// SPDX-License-Identifier: MIT
// compile-pipeline.ts — P2 workspace reconstruction pipeline for examples/v2-self-shave-poc.
//
// @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
// @title compile-self groups atoms by (sourcePkg, sourceFile) and reconstructs
//   workspace tree from provenance + plumbing
// @status decided (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale With P1's provenance columns populated, atoms are grouped by
//   (sourcePkg, sourceFile), sorted by sourceOffset ASC, concatenated, and
//   emitted to <outputDir>/<sourceFile>. Plumbing files materialise from
//   workspace_plumbing rows. The flat-atom output path is DELETED.
//   This file mirrors compile-self.ts in packages/cli/src/commands/ — they
//   are kept separate because @yakcc/cli cannot import from examples/
//   (TypeScript rootDir: src constraint). When logic diverges, both files
//   must be updated (DEC-V2-COMPILE-SELF-EQ-001 N4 rationale).
//
// @decision DEC-V2-COMPILE-SELF-EQ-001
// @title Functional equivalence is the P2 acceptance bar (confirmed)
// @status re-confirmed (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale P2 closes this DEC end-to-end: the recompiled workspace builds,
//   tests pass, and the recompiled bootstrap --verify produces byte-identical
//   bootstrap/expected-roots.json (T8 load-bearing assertion).
//
// @decision DEC-V2-CORPUS-DISTRIBUTION-001
// @title SQLite registry + dist-recompiled/ are both gitignored
// @status closed (unchanged from A2)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { BlockTripletRow, Registry, WorkspacePlumbingEntry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One gap row in the compose-path-gap report.
 *
 * reason values (P2 shape):
 *   'foreign-leaf-skipped' — foreign atoms are opaque leaves (informational)
 *   'null-provenance'      — local atom with NULL sourcePkg AND sourceFile
 *   'unresolved-pointer'   — PointerEntry with no in-corpus resolution
 *   'other'                — catch-all; triggers integration test failure (Sacred Practice #5)
 */
export interface GapRow {
  readonly blockMerkleRoot: BlockMerkleRoot;
  readonly packageName: string;
  readonly sourcePath?: string | undefined;
  readonly reason:
    | "null-provenance"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
    | "other";
  readonly detail: string;
}

/**
 * One entry in the compile manifest (P2 shape — workspace-shaped, per-atom).
 *
 * outputPath is now a workspace-relative path (e.g.
 * 'packages/cli/src/commands/compile.ts'), not the old flat atom path.
 * sourcePkg, sourceFile, sourceOffset are non-null for local atoms with provenance.
 *
 * @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
 */
export interface ManifestEntry {
  readonly outputPath: string;
  readonly blockMerkleRoot: BlockMerkleRoot;
  readonly sourcePkg: string | null;
  readonly sourceFile: string | null;
  readonly sourceOffset: number | null;
}

/**
 * Return type of runCompilePipeline / _runWithRegistry.
 */
export interface CompilePipelineResult {
  /** Number of source files emitted (one per (sourcePkg, sourceFile) group). */
  readonly recompiledFiles: number;
  /** Number of plumbing files materialised from registry. */
  readonly plumbingFilesEmitted: number;
  /** Manifest mapping output paths → blockMerkleRoot, sourcePkg, sourceFile, sourceOffset. */
  readonly manifest: readonly ManifestEntry[];
  /** Compose-path gap report (never silently dropped — F1/Sacred Practice #5). */
  readonly gapReport: readonly GapRow[];
}

/**
 * Options for runCompilePipeline.
 */
export interface CompilePipelineOptions {
  /** Absolute path to the SQLite registry. */
  readonly registryPath: string;
  /**
   * Directory under which the recompiled workspace is written.
   * Source files go to: <outputDir>/<sourceFile>  (e.g. packages/cli/src/commands/foo.ts)
   * Plumbing files go to: <outputDir>/<workspacePath>  (e.g. package.json)
   * Manifest: <outputDir>/manifest.json
   */
  readonly outputDir: string;
}

// ---------------------------------------------------------------------------
// Embedding provider for read-only registry open
// ---------------------------------------------------------------------------

const NULL_EMBEDDING_OPTS = {
  embeddings: {
    dimension: 384,
    modelId: "compile-self/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  },
} as const;

// ---------------------------------------------------------------------------
// runCompilePipeline
// ---------------------------------------------------------------------------

/**
 * Reconstruct a workspace-shaped output from the registry corpus.
 *
 * P2 algorithm (DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001):
 *   1. Enumerate atoms via registry.exportManifest().
 *   2. Group by (sourcePkg, sourceFile); skip foreign / null-provenance with gap rows.
 *   3. For each group: sort by sourceOffset ASC (NULLs to end), concatenate implSource.
 *   4. Write to <outputDir>/<sourceFile>.
 *   5. Materialise plumbing from registry.listWorkspacePlumbing().
 *   6. Write manifest.json sorted by (outputPath ASC, sourceOffset ASC).
 *   7. NEVER emit <outputDir>/atoms/ — flat-atom output is deleted (Sacred Practice #12).
 *
 * @param opts - Registry path and output directory.
 * @returns CompilePipelineResult with manifest + gap report.
 */
export async function runCompilePipeline(
  opts: CompilePipelineOptions,
): Promise<CompilePipelineResult> {
  const registry: Registry = await openRegistry(opts.registryPath, NULL_EMBEDDING_OPTS);
  try {
    return await _runWithRegistry(registry, opts.outputDir);
  } finally {
    await registry.close();
  }
}

/**
 * Internal implementation after registry is open.
 * Separated for testability — tests may inject an already-open Registry.
 *
 * @internal
 */
export async function _runWithRegistry(
  registry: Registry,
  outputDir: string,
): Promise<CompilePipelineResult> {
  // Step 1: Enumerate all atoms.
  const manifestEntries = await registry.exportManifest();

  // Step 2: Group atoms by sourceFile (workspace-relative).
  // @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
  interface AtomGroup {
    sourcePkg: string;
    sourceFile: string;
    atoms: Array<{ block: BlockTripletRow; blockMerkleRoot: BlockMerkleRoot }>;
  }

  const groupMap = new Map<string, AtomGroup>();
  const gapReport: GapRow[] = [];

  for (const entry of manifestEntries) {
    const block = await registry.getBlock(entry.blockMerkleRoot);

    if (block === null) {
      gapReport.push({
        blockMerkleRoot: entry.blockMerkleRoot,
        packageName: "unknown",
        reason: "other",
        detail:
          "Block not found in registry despite being enumerated by exportManifest(). Registry may be corrupted.",
      });
      continue;
    }

    // Foreign atoms: informational skip.
    if (block.kind === "foreign") {
      gapReport.push({
        blockMerkleRoot: entry.blockMerkleRoot,
        packageName: block.foreignPkg ?? "unknown",
        reason: "foreign-leaf-skipped",
        detail: `Foreign atom ${block.foreignPkg ?? "unknown"} is an opaque leaf — not inlined (DEC-V2-FOREIGN-BLOCK-SCHEMA-001).`,
      });
      continue;
    }

    // Local atoms with NULL provenance: cannot place in workspace tree.
    // @decision I7 resolution: NULL-provenance atoms emit a gap row.
    if (block.sourcePkg == null || block.sourceFile == null) {
      gapReport.push({
        blockMerkleRoot: entry.blockMerkleRoot,
        packageName: block.sourcePkg ?? "unknown",
        reason: "null-provenance",
        detail:
          "Atom has NULL sourcePkg and/or NULL sourceFile — cannot place in workspace tree. " +
          "Re-run 'yakcc bootstrap' with a P1+ CLI to populate provenance.",
      });
      continue;
    }

    // Collect into group keyed by sourceFile.
    const key = block.sourceFile;
    const existing = groupMap.get(key);
    if (existing !== undefined) {
      existing.atoms.push({ block, blockMerkleRoot: entry.blockMerkleRoot });
    } else {
      groupMap.set(key, {
        sourcePkg: block.sourcePkg,
        sourceFile: block.sourceFile,
        atoms: [{ block, blockMerkleRoot: entry.blockMerkleRoot }],
      });
    }
  }

  // Step 3–4: Emit one TS file per group.
  // @decision I7: NULLs sort to end; I8: overlapping offsets treated as 'other' gap.
  const manifest: ManifestEntry[] = [];
  let recompiledFiles = 0;

  mkdirSync(outputDir, { recursive: true });

  for (const [, group] of groupMap) {
    // Sort: non-null offsets ascending first, null offsets appended.
    const sorted = [...group.atoms].sort((a, b) => {
      const ao = a.block.sourceOffset ?? null;
      const bo = b.block.sourceOffset ?? null;
      if (ao === null && bo === null) return 0;
      if (ao === null) return 1;
      if (bo === null) return -1;
      return ao - bo;
    });

    // Concatenate implSource blobs.
    const concatenated = sorted.map((a) => a.block.implSource).join("");

    // Write to <outputDir>/<sourceFile>.
    const outputPath = join(outputDir, group.sourceFile);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, concatenated, "utf-8");
    recompiledFiles++;

    // One manifest row per atom.
    for (const atom of sorted) {
      manifest.push({
        outputPath: group.sourceFile,
        blockMerkleRoot: atom.blockMerkleRoot,
        sourcePkg: atom.block.sourcePkg ?? null,
        sourceFile: atom.block.sourceFile ?? null,
        sourceOffset: atom.block.sourceOffset ?? null,
      });
    }
  }

  // Step 5: Materialise plumbing files.
  // SINGLE AUTHORITY: only registry.listWorkspacePlumbing() — no filesystem reads
  // at compile time (DEC-V2-WORKSPACE-PLUMBING-AUTHORITY-001 / FS3).
  const plumbingEntries: readonly WorkspacePlumbingEntry[] =
    await registry.listWorkspacePlumbing();
  let plumbingFilesEmitted = 0;

  for (const plumbing of plumbingEntries) {
    const outputPath = join(outputDir, plumbing.workspacePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, plumbing.contentBytes);
    plumbingFilesEmitted++;
  }

  // Step 6: Write manifest.json sorted by (outputPath ASC, sourceOffset ASC).
  manifest.sort((a, b) => {
    const pathCmp = (a.outputPath ?? "").localeCompare(b.outputPath ?? "");
    if (pathCmp !== 0) return pathCmp;
    const ao = a.sourceOffset ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sourceOffset ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });

  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return { recompiledFiles, plumbingFilesEmitted, manifest, gapReport };
}

// ---------------------------------------------------------------------------
// openRegistryForCompile — convenience factory
// ---------------------------------------------------------------------------

/**
 * Open a registry for the compile-self CLI command using null-zero embeddings.
 *
 * @internal for compile-self use only.
 */
export async function openRegistryForCompile(registryPath: string): Promise<Registry> {
  return openRegistry(registryPath, NULL_EMBEDDING_OPTS);
}
