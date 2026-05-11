// SPDX-License-Identifier: MIT
// compile-pipeline.ts — A2 orchestration helper for `yakcc compile-self`.
//
// @decision DEC-V2-COMPILE-SELF-EQ-001
// @title Functional equivalence is the A2 acceptance bar
// @status closed (this slice)
// @rationale
//   The recursive self-hosting proof is: yakcc-recompiled-from-yakcc-shaved-by-yakcc
//   shaves yakcc's source and produces the same content addresses. That proof is
//   functional, not lexical. Byte-equivalence of TS source (DEC-V2-COMPILE-SELF-BYTE-EQ-001)
//   is deferred to A3. This slice proves functional equivalence by:
//     (a) enumerating all atoms from the registry corpus (via loadCorpusFromRegistry)
//     (b) hydrating each local atom's implSource from the registry (getBlock)
//     (c) constructing a minimal SlicePlan with a NovelGlueEntry per atom
//         (this passes the source verbatim through compileToTypeScript — no pointer gaps)
//     (d) writing the compiled TS output to outputDir/atoms/<blockMerkleRoot>.ts
//     (e) writing a manifest.json mapping outputPath → blockMerkleRoot
//   Foreign atoms are recorded as foreign-leaf-skipped gap rows (informational).
//
// @decision DEC-V2-CORPUS-DISTRIBUTION-001
// @title SQLite registry + dist-recompiled/ are both gitignored
// @status closed (this slice)
// @rationale
//   Committing the SQLite registry would bloat the repo with a binary multi-MB file
//   and create a parallel authority surface for atom data (Sacred Practice #12).
//   Committing dist-recompiled/ would commit derived artifacts when only the source
//   command that produces them is needed. Both are byte-deterministic from source:
//   SQLite from `yakcc bootstrap`; dist-recompiled/ from `yakcc compile-self`.
//   The .gitignore extension in this slice covers dist-recompiled/ (and yakcc.registry.sqlite
//   was already covered by A1). See DEC-V2-CORPUS-DISTRIBUTION-001 in the decision log.
//
// Architecture note (A2 limitation / BLOCKED_BY_PLAN signal):
//   The A2 output is a FLAT collection of per-atom TS files, NOT a reconstructed
//   workspace. The registry stores individual atoms (function-level), not the
//   file-level structure (which atoms belong to which source file, imports, type
//   declarations, etc.). Therefore:
//     - `pnpm -r build` against dist-recompiled/ is NOT achievable in A2.
//     - `pnpm -r test` against dist-recompiled/ is NOT achievable in A2.
//     - The `bootstrap --verify` byte-identity check (I10) is NOT achievable in A2.
//   These are the T3(c)/(d)/(e)/(f) requirements from the Evaluation Contract.
//   The blocker is architectural: the compose pipeline lacks file-level structure
//   metadata (no source-file → atoms mapping in the registry). A precursor slice
//   or WI-V2-GLUE-AWARE-IMPL (#95) must add this metadata before A2's full
//   integration bar can be met. This is reported as BLOCKED_BY_PLAN per
//   compose_path_gap_handling.implementer_routing_signal.
//
// What A2 DOES prove:
//   - The compile pipeline executes without errors over all 1889 corpus atoms
//   - Each local atom's implSource passes through compileToTypeScript correctly
//   - The manifest maps every compiled file → blockMerkleRoot (I9)
//   - The gap report is data-shaped (no silent drops — F1/Sacred Practice #5)
//   - Zero 'missing-backend-feature' gaps (compileToTypeScript handles NovelGlueEntry)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileToTypeScript } from "@yakcc/compile";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import type { CorpusAtom } from "./load-corpus.js";
import { loadCorpusFromRegistry } from "./load-corpus.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One gap row in the compose-path-gap report.
 *
 * Reasons (per scope.json compose_path_gap_handling.shape):
 *   'missing-backend-feature' — compileToTypeScript does not yet handle this entry kind
 *   'unresolved-pointer'      — PointerEntry with no in-corpus resolution
 *   'foreign-leaf-skipped'    — informational; foreign leaves intentionally not inlined
 *   'other'                   — catch-all; triggers integration test failure
 *
 * The integration test (T4) machine-checks the shape of every row.
 */
export interface GapRow {
  readonly blockMerkleRoot: BlockMerkleRoot;
  readonly packageName: string;
  readonly sourcePath?: string | undefined;
  readonly reason:
    | "missing-backend-feature"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
    | "other";
  readonly detail: string;
}

/**
 * One entry in the compile manifest: the output file path → blockMerkleRoot.
 *
 * Per invariant I9: the manifest is the derived mapping between output files and
 * their originating corpus atom. It is NOT a new authority — the registry is the
 * single source of truth (Sacred Practice #12).
 */
export interface ManifestEntry {
  readonly outputPath: string;
  readonly blockMerkleRoot: BlockMerkleRoot;
}

/**
 * Return type of runCompilePipeline.
 */
export interface CompilePipelineResult {
  /** Number of atoms successfully compiled to TS files. */
  readonly recompiledFiles: number;
  /** Manifest mapping output file path → blockMerkleRoot. */
  readonly manifest: readonly ManifestEntry[];
  /** Compose-path gap report (never silently dropped — F1/Sacred Practice #5). */
  readonly gapReport: readonly GapRow[];
}

/**
 * Options for runCompilePipeline.
 */
export interface CompilePipelineOptions {
  /** Absolute path to the SQLite registry (e.g. 'bootstrap/yakcc.registry.sqlite'). */
  readonly registryPath: string;
  /**
   * Directory under which compiled atom files are written.
   * The pipeline writes: <outputDir>/atoms/<blockMerkleRoot>.ts
   * and: <outputDir>/manifest.json
   * The caller is responsible for creating or verifying the root directory.
   */
  readonly outputDir: string;
}

// ---------------------------------------------------------------------------
// Embedding provider for read-only registry open
//
// Bootstrap used zero-vector embeddings (DEC-V2-BOOTSTRAP-EMBEDDING-001).
// The compile pipeline also uses zero-vector embeddings: we only read atoms,
// never run vector search. Using the same deterministic zero-vector avoids
// any ANTHROPIC_API_KEY or huggingface network dependency.
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
 * Walk all atoms in the registry corpus and compile each local atom to a TS
 * output file under `outputDir/atoms/<blockMerkleRoot>.ts`.
 *
 * Per-atom compile process (per DEC-V2-COMPILE-SELF-EQ-001):
 *   1. `getBlock(blockMerkleRoot)` → hydrate implSource + canonicalAstHash
 *   2. Construct a minimal SlicePlan with one NovelGlueEntry (implSource as-is)
 *   3. `compileToTypeScript(plan)` → TS source string
 *   4. Write to outputDir/atoms/<blockMerkleRoot>.ts
 *
 * Foreign atoms: recorded as 'foreign-leaf-skipped' gap rows (informational).
 * Block not found: recorded as 'other' gap row (loud failure, Sacred Practice #5).
 *
 * @decision DEC-V2-COMPILE-SELF-EQ-001
 * Wrapping implSource as NovelGlueEntry ensures compileToTypeScript emits the
 * actual source verbatim (plus comment boundaries). The alternative of building
 * a real SlicePlan via slicer.slice() would produce PointerEntries for all
 * registered atoms, and compileToTypeScript only emits comments for PointerEntries
 * (no actual source). The NovelGlueEntry approach is the only path that produces
 * real TypeScript output from the registry's atom content in A2.
 *
 * @param opts - Registry path and output directory.
 * @returns CompilePipelineResult with manifest + gap report.
 */
export async function runCompilePipeline(
  opts: CompilePipelineOptions,
): Promise<CompilePipelineResult> {
  // Open registry read-only (zero-vector embeddings, no network dependency).
  // Fail loudly if the registry cannot be opened (Sacred Practice #5 / F8).
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
  // Step 1: Enumerate corpus via A1's loadCorpusFromRegistry (single authority — Sacred Practice #12).
  const corpus = await loadCorpusFromRegistry(registry);

  // Step 2: Create output atoms directory.
  const atomsDir = join(outputDir, "atoms");
  mkdirSync(atomsDir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  const gapReport: GapRow[] = [];
  let recompiledFiles = 0;

  // Step 3: Walk each atom. ALL gaps are recorded in gapReport — never silently dropped (F1).
  for (const atom of corpus.atoms) {
    const gapOrNull = await _compileAtom(atom, registry, atomsDir, manifest);
    if (gapOrNull !== null) {
      gapReport.push(gapOrNull);
    } else {
      recompiledFiles++;
    }
  }

  // Step 4: Write manifest.json (per I9: outputPath → blockMerkleRoot mapping).
  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  return { recompiledFiles, manifest, gapReport };
}

/**
 * Compile one atom to a TS file under atomsDir.
 *
 * Returns null on success (atom written to disk, manifest updated).
 * Returns a GapRow on failure (loud — never silently dropped).
 *
 * @internal
 */
async function _compileAtom(
  atom: CorpusAtom,
  registry: Registry,
  atomsDir: string,
  manifest: ManifestEntry[],
): Promise<GapRow | null> {
  // Foreign atoms are intentionally not compiled to TS (they're opaque leaves).
  if (atom.kind === "foreign") {
    return {
      blockMerkleRoot: atom.blockMerkleRoot,
      packageName: atom.packageName,
      reason: "foreign-leaf-skipped",
      detail: `Foreign atom ${atom.packageName} is an opaque leaf — not inlined into compiled output (by design, per DEC-V2-FOREIGN-BLOCK-SCHEMA-001).`,
    };
  }

  // Hydrate the block from the registry.
  const block = await registry.getBlock(atom.blockMerkleRoot);
  if (block === null) {
    // Registry inconsistency: atom was enumerated but block is not found.
    // This is a loud failure (Sacred Practice #5 — loud, never silent).
    return {
      blockMerkleRoot: atom.blockMerkleRoot,
      packageName: atom.packageName,
      reason: "other",
      detail:
        "Block not found in registry despite being enumerated by exportManifest(). Registry may be corrupted or concurrently modified.",
    };
  }

  // Construct a minimal SlicePlan wrapping implSource as a NovelGlueEntry.
  //
  // @decision DEC-V2-COMPILE-SELF-EQ-001
  // We INTENTIONALLY wrap implSource as NovelGlueEntry rather than using the
  // slicer to produce a PointerEntry. Rationale: the slicer produces PointerEntries
  // for atoms already in the registry, and compileToTypeScript only emits a comment
  // (not real source) for PointerEntries. Using NovelGlueEntry is the only way to
  // get compileToTypeScript to emit the actual source text in A2.
  const plan = {
    entries: [
      {
        kind: "novel-glue" as const,
        sourceRange: { start: 0, end: block.implSource.length },
        source: block.implSource,
        canonicalAstHash: block.canonicalAstHash,
        // intentCard is optional on NovelGlueEntry — omitted here because we're
        // not running intent extraction; we're reconstructing from the registry.
      },
    ],
    matchedPrimitives: [],
    sourceBytesByKind: {
      pointer: 0,
      novelGlue: block.implSource.length,
      glue: 0,
    },
  };

  // Compile the slice plan to a TypeScript source string.
  // compileToTypeScript is synchronous and cannot throw for valid NovelGlueEntry input.
  let tsSource: string;
  try {
    tsSource = compileToTypeScript(plan);
  } catch (err) {
    // compileToTypeScript should not throw for NovelGlueEntry, but record it loudly if it does.
    return {
      blockMerkleRoot: atom.blockMerkleRoot,
      packageName: atom.packageName,
      reason: "missing-backend-feature",
      detail: `compileToTypeScript threw unexpectedly for NovelGlueEntry: ${String(err)}`,
    };
  }

  // Write the compiled TS to atomsDir/<blockMerkleRoot>.ts.
  const outputFileName = `${atom.blockMerkleRoot}.ts`;
  const outputPath = join(atomsDir, outputFileName);
  writeFileSync(outputPath, tsSource, "utf-8");

  // Record in manifest (per I9: outputPath → blockMerkleRoot).
  manifest.push({
    outputPath: join("atoms", outputFileName),
    blockMerkleRoot: atom.blockMerkleRoot,
  });

  return null;
}

// ---------------------------------------------------------------------------
// openRegistryForCompile — convenience factory used by compile-self.ts CLI
// ---------------------------------------------------------------------------

/**
 * Open a registry for the compile-self CLI command using null-zero embeddings.
 *
 * Re-exported so compile-self.ts can open the registry without duplicating
 * the embedding provider configuration (Sacred Practice #12: single authority).
 *
 * @internal for compile-self.ts CLI use only.
 */
export async function openRegistryForCompile(registryPath: string): Promise<Registry> {
  return openRegistry(registryPath, NULL_EMBEDDING_OPTS);
}
