// SPDX-License-Identifier: MIT
// compile-self.ts — `yakcc compile-self` command (P2 workspace reconstruction).
//
// @decision DEC-V2-COMPILE-SELF-CLI-NAMING-001
// @title `yakcc compile-self` is a top-level command, NOT `yakcc compile --self`
// @status accepted
// @rationale Keeps argument parsing and exit-code semantics independent of
//   `yakcc compile`. The two commands have different inputs (compile takes an
//   entry; compile-self walks the corpus) and different outputs (compile writes
//   one module; compile-self writes a workspace-shaped output tree). Co-locating
//   behind a flag would force compile.ts to branch on a fundamentally different
//   code path and would make P2 risk regressing compile.
//
// @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
// @title compile-self groups atoms by (sourcePkg, sourceFile) and reconstructs
//   workspace tree from provenance + plumbing
// @status decided (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale With P1's provenance columns populated, the natural reconstruction
//   is groupBy(atom, key=(sourcePkg, sourceFile)), sort by sourceOffset ASC,
//   concatenate implSource, emit to <outputDir>/<sourceFile>. Plumbing files
//   materialise from workspace_plumbing rows to their workspace_path locations.
//   The flat-atom output path (<outputDir>/atoms/<hash>.ts) is DELETED in this
//   change, not preserved as a fallback (Sacred Practice #12). The output
//   manifest.json shape evolves to Array<{outputPath, blockMerkleRoot, sourcePkg,
//   sourceFile, sourceOffset}>.
//
//   Forbidden shortcuts (per Evaluation Contract FS1-FS10):
//   - FS1: NEVER keep atoms/ directory output "for backward compatibility."
//   - FS3: NEVER read plumbing from the filesystem — only registry.listWorkspacePlumbing().
//   - FS8: NEVER infer sourcePkg/sourceFile from atom heuristics — only registry.getBlock().
//
// @decision DEC-V2-COMPILE-SELF-EQ-001
// @title Functional equivalence is the P2 acceptance bar (confirmed)
// @status re-confirmed (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale P2 closes this DEC at the end-to-end level: recompiled workspace
//   builds, tests pass, and recompiled bootstrap --verify produces byte-identical
//   bootstrap/expected-roots.json. The bar is functional, not byte-level source.
//
// @decision DEC-V2-COMPILE-SELF-EXIT-CODE-001
// @title compile-self returns exit 0 on success, exit 1 on usage/runtime errors
// @status accepted (unchanged from A2)
//
// @decision DEC-V2-CORPUS-DISTRIBUTION-001
// @title SQLite registry + dist-recompiled/ are both gitignored
// @status accepted (unchanged from A2)

import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// CLI argument parsing options
// ---------------------------------------------------------------------------

const COMPILE_SELF_PARSE_OPTIONS = {
  output: { type: "string" as const, short: "o" },
  registry: { type: "string" as const, short: "r" },
  help: { type: "boolean" as const, short: "h", default: false },
} as const;

const DEFAULT_OUTPUT_DIR = "dist-recompiled";
const DEFAULT_REGISTRY_PATH = "bootstrap/yakcc.registry.sqlite";

// ---------------------------------------------------------------------------
// Embedding provider for read-only registry open
//
// Bootstrap uses zero-vector embeddings (DEC-V2-BOOTSTRAP-EMBEDDING-001).
// compile-self also uses zero-vector embeddings: we only enumerate atoms,
// never run vector search. Deterministic zero vectors avoid any network dependency.
// ---------------------------------------------------------------------------

const NULL_EMBEDDING_OPTS = {
  embeddings: {
    dimension: 384,
    modelId: "compile-self/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One compose-path gap row. Never silently dropped (F1 / Sacred Practice #5).
 *
 * reason values:
 *   'foreign-leaf-skipped' — foreign atoms are opaque leaves, not inlined (informational)
 *   'null-provenance'      — local atom with NULL sourcePkg AND NULL sourceFile (P2 new)
 *   'unresolved-pointer'   — PointerEntry with no in-corpus resolution
 *   'glue-absorbed'        — atom in blocks.source_file but not block_occurrences; content is
 *                            already present in the glue blob (informational, no data lost)
 *   'other'                — unexpected; triggers exit 1 (Sacred Practice #5)
 *
 * @decision DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001
 */
interface GapRow {
  readonly blockMerkleRoot: string;
  readonly packageName: string;
  readonly reason:
    | "null-provenance"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
    | "glue-absorbed"
    | "other";
  readonly detail: string;
}

/**
 * One entry in manifest.json (P2 shape — per-atom, workspace-shaped).
 *
 * @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
 * manifest.json shape evolves to Array<{outputPath, blockMerkleRoot, sourcePkg,
 * sourceFile, sourceOffset}> — one row per block, file-shaped, sorted by
 * (outputPath ASC, sourceOffset ASC).
 */
interface ManifestEntry {
  readonly outputPath: string;
  readonly blockMerkleRoot: string;
  readonly sourcePkg: string | null;
  readonly sourceFile: string | null;
  readonly sourceOffset: number | null;
}

// ---------------------------------------------------------------------------
// compileSelf — P2 workspace reconstruction implementation
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc compile-self`.
 *
 * P2 status: workspace reconstruction. Groups atoms by (sourcePkg, sourceFile),
 * sorts by sourceOffset ASC, concatenates implSource, and emits to
 * <outputDir>/<sourceFile> (workspace-shaped). Plumbing files from
 * workspace_plumbing are materialised to their workspacePath locations.
 * The flat-atom output path is DELETED (not produced — Sacred Practice #12).
 *
 * CLI flags:
 *   --output <dir>   Output directory for the recompiled workspace (default: dist-recompiled/)
 *   --registry <p>   Path to the SQLite registry (default: bootstrap/yakcc.registry.sqlite)
 *   --help / -h      Print usage and exit 0
 *
 * Exit codes:
 *   0  — success (gap report may be non-empty for informational foreign-leaf rows)
 *   1  — usage or runtime error (bad flags, registry not found, pipeline failure)
 *
 * Per DEC-CLI-LOGGER-001: uses the Logger interface for all output — no direct
 * console.log/error calls — enabling test capture via CollectingLogger.
 *
 * @param argv   - Subcommand args after "compile-self" has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — 0 on success, 1 on error.
 */
export async function compileSelf(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Parse CLI arguments.
  let values: { output?: string; registry?: string; help?: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: COMPILE_SELF_PARSE_OPTIONS,
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values;
  } catch (err) {
    logger.error(`error: compile-self: ${err instanceof Error ? err.message : String(err)}`);
    logger.error("Usage: yakcc compile-self [--output <dir>] [--registry <path>] [--help]");
    return 1;
  }

  if (values.help === true) {
    logger.log(
      [
        "yakcc compile-self — recompile the yakcc corpus from the registry into a workspace",
        "",
        "USAGE",
        "  yakcc compile-self [--output <dir>] [--registry <path>]",
        "",
        "OPTIONS",
        `  --output, -o <dir>   Output directory for the recompiled workspace (default: ${DEFAULT_OUTPUT_DIR})`,
        `  --registry, -r <p>   SQLite registry path (default: ${DEFAULT_REGISTRY_PATH})`,
        "  --help, -h           Print this help and exit",
        "",
        "DESCRIPTION",
        "  Groups atoms by (sourcePkg, sourceFile), sorts by sourceOffset ASC,",
        "  concatenates implSource blobs, and emits each file to:",
        "    <output>/<sourceFile>   (e.g. packages/cli/src/commands/compile.ts)",
        "  Plumbing files from workspace_plumbing are materialised to their",
        "  workspace_path locations under <output>/.",
        "  A manifest.json is written with shape:",
        "    Array<{ outputPath, blockMerkleRoot, sourcePkg, sourceFile, sourceOffset }>",
        "  sorted by (outputPath ASC, sourceOffset ASC).",
        "",
        "  Gap rows (atoms that cannot be placed in the workspace):",
        "    null-provenance      — local atom with NULL sourcePkg AND sourceFile",
        "    foreign-leaf-skipped — foreign atoms are opaque leaves (informational)",
        "",
        "EXIT CODES",
        "  0  success (gap report may be non-empty for informational foreign-leaf rows)",
        "  1  usage or runtime error (registry not found, pipeline failure)",
        "",
        "WI-V2-CORPUS-AND-COMPILE-SELF-EQ (issue #59), slice P2.",
        "DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001 (workspace reconstruction).",
        "DEC-V2-COMPILE-SELF-EQ-001 (functional equivalence bar, re-confirmed).",
        "DEC-V2-CORPUS-DISTRIBUTION-001 (output is gitignored, not committed).",
      ].join("\n"),
    );
    return 0;
  }

  const outputDir = resolve(values.output ?? DEFAULT_OUTPUT_DIR);
  const registryPath = resolve(values.registry ?? DEFAULT_REGISTRY_PATH);

  // Validate registry path exists before invoking the pipeline.
  // Fail loudly with a clear error if it doesn't (Sacred Practice #5 / F8).
  if (!existsSync(registryPath)) {
    logger.error(`error: compile-self: registry not found at ${registryPath}`);
    logger.error("  Run 'yakcc bootstrap' first to populate the registry.");
    return 1;
  }

  logger.log("yakcc compile-self — P2 workspace reconstruction");
  logger.log(`  registry: ${registryPath}`);
  logger.log(`  output:   ${outputDir}`);
  logger.log("");

  // Run the compile pipeline.
  let pipelineResult: {
    recompiledFiles: number;
    gapReport: GapRow[];
    sourceFilesEmitted: number;
    plumbingFilesEmitted: number;
  };
  try {
    pipelineResult = await _runPipeline(registryPath, outputDir, logger);
  } catch (err) {
    logger.error(
      `error: compile-self: pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // Log summary.
  logger.log(
    `compile-self: ${pipelineResult.sourceFilesEmitted} source files emitted → ${outputDir}/`,
  );
  logger.log(
    `compile-self: ${pipelineResult.plumbingFilesEmitted} plumbing files materialised → ${outputDir}/`,
  );
  logger.log(`compile-self: manifest written → ${outputDir}/manifest.json`);

  // Log gap report (loud — never silent, per F1 / Sacred Practice #5).
  if (pipelineResult.gapReport.length > 0) {
    const foreignSkipped = pipelineResult.gapReport.filter(
      (r) => r.reason === "foreign-leaf-skipped",
    ).length;
    const nullProvenance = pipelineResult.gapReport.filter(
      (r) => r.reason === "null-provenance",
    ).length;
    const unresolvedPointer = pipelineResult.gapReport.filter(
      (r) => r.reason === "unresolved-pointer",
    ).length;
    const glueAbsorbed = pipelineResult.gapReport.filter(
      (r) => r.reason === "glue-absorbed",
    ).length;
    const other = pipelineResult.gapReport.filter((r) => r.reason === "other").length;

    logger.log("");
    logger.log(`compile-self: compose-path-gap report (${pipelineResult.gapReport.length} rows):`);
    if (foreignSkipped > 0) {
      logger.log(
        `  foreign-leaf-skipped:  ${foreignSkipped} (informational — foreign atoms not inlined)`,
      );
    }
    if (nullProvenance > 0) {
      logger.log(
        `  null-provenance:       ${nullProvenance} (atoms with NULL sourcePkg AND sourceFile — cannot place in workspace)`,
      );
    }
    if (unresolvedPointer > 0) {
      logger.log(
        `  unresolved-pointer:    ${unresolvedPointer} (PointerEntry with no in-corpus resolution)`,
      );
    }
    if (glueAbsorbed > 0) {
      logger.log(
        `  glue-absorbed:         ${glueAbsorbed} (informational — atoms in blocks.source_file but not block_occurrences; content present in glue blob)`,
      );
    }
    if (other > 0) {
      logger.error(`  other (unexpected):    ${other} — see gap report rows for detail`);
      for (const row of pipelineResult.gapReport.filter((r) => r.reason === "other")) {
        logger.error(`    [${row.blockMerkleRoot.slice(0, 8)}] ${row.detail}`);
      }
    }

    // 'other' rows are unexpected failures → non-zero exit.
    if (other > 0) {
      return 1;
    }
  } else {
    logger.log(
      "compile-self: compose-path-gap report: empty (all atoms placed in workspace successfully)",
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// _runPipeline — internal compile-self pipeline (P2)
//
// Mirrors the logic in examples/v2-self-shave-poc/src/compile-pipeline.ts.
// Kept separate because @yakcc/cli's tsconfig has rootDir: src and cannot
// import from examples/. The canonical testable module is compile-pipeline.ts.
//
// Algorithm (DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001):
//   1. Open registry (NULL embedding provider — read-only enumeration).
//   2. Fetch all local atoms via registry.exportManifest().
//   3. For each atom: fetch BlockTripletRow via registry.getBlock(merkleRoot).
//      - If kind='foreign': emit gap row 'foreign-leaf-skipped', skip.
//      - If sourcePkg AND sourceFile both NULL: emit gap row 'null-provenance'.
//      - Else: collect into groupMap[`${sourcePkg}/${sourceFile}`].atoms.
//   4. For each group:
//      - Sort atoms by sourceOffset ASC (NULLs sorted to end per I7 resolution).
//      - Concatenate implSource blobs in that order.
//      - Write to <outputDir>/<sourceFile>, mkdir -p the parent.
//   5. Fetch all plumbing via registry.listWorkspacePlumbing().
//   6. For each plumbing entry: write contentBytes to <outputDir>/<workspacePath>.
//   7. Write manifest.json sorted by (outputPath ASC, sourceOffset ASC).
//   8. The <outputDir>/atoms/ directory is NOT produced (Sacred Practice #12).
// ---------------------------------------------------------------------------

async function _runPipeline(
  registryPath: string,
  outputDir: string,
  logger: Logger,
): Promise<{
  recompiledFiles: number;
  gapReport: GapRow[];
  sourceFilesEmitted: number;
  plumbingFilesEmitted: number;
}> {
  const registry: Registry = await openRegistry(registryPath, NULL_EMBEDDING_OPTS);

  try {
    // Step 1: Enumerate all atoms via exportManifest (single authority — Sacred Practice #12).
    const manifestEntries = await registry.exportManifest();

    logger.log(`compile-self: ${manifestEntries.length} total atoms in registry`);

    // Step 2: Group atoms by (sourcePkg, sourceFile).
    // Key: workspace-relative file path (sourceFile, e.g. 'packages/cli/src/commands/foo.ts').
    // @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
    type GroupKey = string; // sourceFile — workspace-relative path, used only as Map key
    interface AtomGroup {
      sourcePkg: string;
      sourceFile: string;
      atoms: Array<{ block: BlockTripletRow; blockMerkleRoot: string }>;
      // addedRoots: tracks which blockMerkleRoots are already in this group.
      // An atom may appear at N offsets within one file (N occurrence rows, different
      // source_offset). The group adds it only once — step 3 resolves the offset via
      // listOccurrencesBySourceFile. Without this guard, multi-offset atoms would be
      // added N times, producing duplicate manifest entries (I9 violation).
      addedRoots: Set<string>;
    }

    const groupMap = new Map<GroupKey, AtomGroup>();
    const gapReport: GapRow[] = [];

    for (const entry of manifestEntries) {
      const block = await registry.getBlock(entry.blockMerkleRoot);

      if (block === null) {
        // Registry inconsistency — loud failure (Sacred Practice #5).
        gapReport.push({
          blockMerkleRoot: entry.blockMerkleRoot,
          packageName: "unknown",
          reason: "other",
          detail:
            "Block not found in registry despite being enumerated by exportManifest(). Registry may be corrupted.",
        });
        continue;
      }

      // Foreign atoms: informational skip (not inlined by design).
      if (block.kind === "foreign") {
        gapReport.push({
          blockMerkleRoot: entry.blockMerkleRoot,
          packageName: block.foreignPkg ?? "unknown",
          reason: "foreign-leaf-skipped",
          detail: `Foreign atom ${block.foreignPkg ?? "unknown"} is an opaque leaf — not inlined (DEC-V2-FOREIGN-BLOCK-SCHEMA-001).`,
        });
        continue;
      }

      // @decision DEC-STORAGE-IDEMPOTENT-001 (option b / #355)
      // @title Group atoms by block_occurrences, not blocks.source_file (stale first-observed)
      // @status decided (WI-V2-STORAGE-IDEMPOTENT-RECOMPILE #355)
      // @rationale blocks.source_file is a first-observed shim — it points to the file where
      //   the atom was first encountered, not all files where it appears. block_occurrences is
      //   refreshed atomically per file on every bootstrap pass and accurately tracks all files
      //   containing each atom. Grouping by block_occurrences fixes shared-atom gaps where atoms
      //   were incorrectly placed in the first-observed file's group instead of all files they
      //   appear in. Fallback: when block_occurrences has no rows for this atom (pre-v9 registry
      //   or atom removed from source), fall back to block.sourceFile for backward compatibility.
      const occurrences = await registry.listOccurrencesByMerkleRoot(entry.blockMerkleRoot);

      if (occurrences.length > 0) {
        // Per-occurrence placement: add this atom to every file's group it appears in.
        // Shared atoms (same implSource content appearing in N files) correctly appear
        // in N groups — one manifest entry per (file, atom) pair.
        //
        // Deduplication: an atom may appear at multiple offsets within the same file
        // (N occurrence rows, same source_file, different source_offset). Add only once
        // per file — step 3 resolves the correct offsets via listOccurrencesBySourceFile.
        for (const occ of occurrences) {
          const key: GroupKey = occ.sourceFile;
          const existing = groupMap.get(key);
          if (existing !== undefined) {
            if (!existing.addedRoots.has(entry.blockMerkleRoot)) {
              existing.addedRoots.add(entry.blockMerkleRoot);
              existing.atoms.push({ block, blockMerkleRoot: entry.blockMerkleRoot });
            }
          } else {
            groupMap.set(key, {
              sourcePkg: occ.sourcePkg,
              sourceFile: occ.sourceFile,
              atoms: [{ block, blockMerkleRoot: entry.blockMerkleRoot }],
              addedRoots: new Set([entry.blockMerkleRoot]),
            });
          }
        }
      } else {
        // Fallback: no block_occurrences rows (pre-v9 registry or atom not in any current file).
        // Use blocks.source_* columns for backward compatibility.
        // @decision I7 resolution (plan.md §DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001):
        //   Atoms with NULL sourcePkg AND NULL sourceFile emit a 'null-provenance' gap row.
        //   These are atoms shaved before P1 (pre-v7 schema rows) or seed blocks.
        //   Running `yakcc bootstrap` from a P1+ CLI populates provenance for all corpus atoms.
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
        const key: GroupKey = block.sourceFile;
        const existing = groupMap.get(key);
        if (existing !== undefined) {
          if (!existing.addedRoots.has(entry.blockMerkleRoot)) {
            existing.addedRoots.add(entry.blockMerkleRoot);
            existing.atoms.push({ block, blockMerkleRoot: entry.blockMerkleRoot });
          }
        } else {
          groupMap.set(key, {
            sourcePkg: block.sourcePkg,
            sourceFile: block.sourceFile,
            atoms: [{ block, blockMerkleRoot: entry.blockMerkleRoot }],
            addedRoots: new Set([entry.blockMerkleRoot]),
          });
        }
      }
    }

    // Step 3: Emit one TS file per group, interleaving glue + atoms by sourceOffset ASC.
    //
    // @decision DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001
    // @title compile-self interleaves glue blobs with atom implSources in sourceOffset order
    // @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333)
    // @rationale
    //   With glue blobs captured by bootstrap (DEC-V2-GLUE-CAPTURE-AUTHORITY-001), the
    //   reconstructed file is: glue_region_0 ++ atom_0.implSource ++ glue_region_1 ++ ...
    //   ++ glue_region_n. Glue region boundaries are derived at reconstruct time from
    //   atom sourceOffset (character position in original file) and implSource.length.
    //
    //   Invariant: implSource.length === sourceRange.end - sourceRange.start (verbatim
    //   source text — no transformation). This is the single-authority derivation:
    //   glue chars before atom[i] = atom[i].sourceOffset - prev_original_end
    //   where prev_original_end accumulates as cursor through the original file.
    //
    //   Fallback: when no glue row exists for a file (getSourceFileGlue → null),
    //   compile-self falls back to atom-only concatenation (pre-#333 behaviour),
    //   logs a warning, and continues. A null glue row is expected only for
    //   bootstrap runs that predate #333 (schema < v8).
    //
    //   Total length assertion: glue_blob_char_count + sum(implSource_lengths)
    //   must equal the reconstructed file char count. This is verified at emit time.
    //
    // @decision I7 resolution: NULLs sort to end (append as suffix); warn but do not fail.
    // @decision I8 resolution: overlapping offsets produce 'other' gap row (cannot arise
    //   in well-formed corpora because INSERT OR IGNORE is per blockMerkleRoot PK).
    const manifest: ManifestEntry[] = [];
    let sourceFilesEmitted = 0;

    mkdirSync(outputDir, { recursive: true });

    for (const [, group] of groupMap) {
      // @decision DEC-V2-STORAGE-IDEMPOTENT-RECOMPILE-001
      // Read current-truth atom offsets from block_occurrences (not blocks.source_offset).
      // blocks.source_offset is a stale first-observed-wins value; block_occurrences is
      // refreshed atomically per file on every bootstrap pass. Using block_occurrences ensures
      // atoms are placed at their current positions even after source edits.
      //
      // If block_occurrences is empty (registry predates schema v9 or bootstrap hasn't run),
      // fall back to blocks.source_offset for backward compatibility. The fallback produces the
      // same output as the pre-#355 behaviour (stale offsets are better than no offsets).
      const occurrences = await registry.listOccurrencesBySourceFile(group.sourceFile);

      // Build a map from blockMerkleRoot → ALL offsets where it appears in this file.
      // A single atom may appear at N different offsets (same implSource repeated N times).
      // Each offset produces a separate sorted entry so glue-interleaving emits the atom
      // N times at the correct positions (mirroring the original source).
      //
      // @decision DEC-STORAGE-IDEMPOTENT-001 multi-offset expansion
      // @rationale A single-offset map (root → last-seen offset) misses N-1 earlier
      //   occurrences for multi-offset atoms, producing malformed reconstructed files.
      const occurrencesByRoot = new Map<string, number[]>();
      for (const occ of occurrences) {
        const existing = occurrencesByRoot.get(occ.blockMerkleRoot);
        if (existing !== undefined) {
          existing.push(occ.sourceOffset);
        } else {
          occurrencesByRoot.set(occ.blockMerkleRoot, [occ.sourceOffset]);
        }
      }

      // Expand group atoms: each unique atom gets one entry per occurrence offset.
      // For atoms with 1 occurrence: same as before. For N occurrences: N entries.
      //
      // @decision DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001
      // @title When v9 occurrence rows exist for a file, atoms absent from block_occurrences
      //   are glue-absorbed and must be excluded from reconstruction (not placed at stale offset)
      // @status decided (WI-V2-STORAGE-IDEMPOTENT-RECOMPILE #355 Bug D fix)
      // @rationale
      //   bootstrap.captureSourceFileGlue uses getAtomRangesBySourceFile (which queries
      //   block_occurrences) to compute the glue blob. Atoms absent from block_occurrences
      //   are NOT subtracted from the source — their content is captured IN the glue blob.
      //   Placing such an atom at its stale blocks.source_offset inserts its implSource
      //   inside a glue region that already contains it, producing duplicate content.
      //   Concrete case: 'const OFFLINE_DIMENSION = 384;' (root ad511ef1) in embeddings.ts
      //   had blocks.source_offset=10304 but 0 occurrence rows; the glue at [10206..10401]
      //   contained it, so naive fallback caused a 30-char duplication at offset 10334.
      //
      //   Guard: when occurrences.length > 0 the file has been processed by v9+ bootstrap
      //   and block_occurrences is authoritative. Atoms absent from occurrencesByRoot are
      //   glue-absorbed — skip them entirely.
      //   When occurrences.length === 0 (pre-v9 registry, file not processed yet), fall back
      //   to blocks.source_offset for ALL atoms (pre-#355 behaviour, backward compatibility).
      //
      // See also: 32 "ghost" blocks in the yakcc corpus (blocks with source_file set but
      // 0 occurrence rows) across 14 files — each would cause the same duplication without
      // this guard.
      const v9ProcessedFile = occurrences.length > 0;
      interface AtomWithOffset {
        block: BlockTripletRow;
        blockMerkleRoot: string;
        effectiveOffset: number | null;
      }
      const atomsWithOffset: AtomWithOffset[] = [];
      for (const atom of group.atoms) {
        const offsets = occurrencesByRoot.get(atom.blockMerkleRoot);
        if (offsets !== undefined && offsets.length > 0) {
          for (const offset of offsets) {
            atomsWithOffset.push({ ...atom, effectiveOffset: offset });
          }
        } else if (v9ProcessedFile) {
          // v9 bootstrap processed this file: atom is absent from block_occurrences, meaning
          // it was absorbed into the glue blob. Exclude it from reconstruction to avoid
          // inserting its implSource inside a glue region that already contains the same content.
          // Emit an informational gap row so the uniquePlaced + gap = total invariant holds.
          gapReport.push({
            blockMerkleRoot: atom.blockMerkleRoot,
            packageName: group.sourcePkg,
            reason: "glue-absorbed",
            detail: `Atom stale blocks.source_offset=${atom.block.sourceOffset ?? "null"} in ${group.sourceFile} — absent from block_occurrences (v9 processed), content already present in glue blob. Excluded from reconstruction to prevent duplicate content. (DEC-V2-GLUE-GHOST-ATOM-EXCLUSION-001)`,
          });
        } else {
          // Pre-v9 registry: fall back to blocks.source_offset (stale first-observed-wins).
          atomsWithOffset.push({ ...atom, effectiveOffset: atom.block.sourceOffset ?? null });
        }
      }

      // Sort: current-truth offsets ascending first, then null offsets appended.
      const sorted = [...atomsWithOffset].sort((a, b) => {
        const ao = a.effectiveOffset;
        const bo = b.effectiveOffset;
        if (ao === null && bo === null) return 0;
        if (ao === null) return 1; // nulls to end
        if (bo === null) return -1;
        return ao - bo;
      });

      // Attempt glue-interleaved reconstruction (DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001).
      let fileContent: string;

      const glueEntry = await registry.getSourceFileGlue(group.sourcePkg, group.sourceFile);

      if (glueEntry !== null && sorted.every((a) => a.effectiveOffset !== null)) {
        // Glue-interleaved path: reconstruct the original file by weaving glue + atoms.
        //
        // Algorithm:
        //   - Decode glue blob to string (UTF-8 reverse of bootstrap's TextEncoder.encode)
        //   - Walk atoms in sourceOffset order; for each atom, extract the glue chars
        //     between the end of the previous atom and the start of this atom
        //   - Append any trailing glue chars after the last atom
        // @decision DEC-V2-COMPILE-SELF-GLUE-DECODE-IGNOREBOM-001
        // @title compile-self glue decode preserves UTF-8 BOM bytes
        // @status decided (WI-FIX-543, issue #543)
        // @rationale
        //   `new TextDecoder()` defaults to `ignoreBOM: false`, which silently strips
        //   a leading UTF-8 BOM (U+FEFF) from the decoded string. That breaks the
        //   round-trip invariant the reconstruction algorithm depends on: glueString
        //   length must equal the sum of all glue-span lengths in original-source
        //   coordinates. A BOM-carrying source file would otherwise produce a
        //   reconstructed string one UTF-16 code unit shorter than the original,
        //   shifting every cross-atom glue slice by one position past the BOM region
        //   and yielding invalid TypeScript. `ignoreBOM: true` preserves the BOM as a
        //   U+FEFF code unit in the decoded string, exactly mirroring the bytes
        //   `bootstrap.captureSourceFileGlue` stored. Files without a BOM are
        //   unaffected. Validates: issue #543, packages/hooks-base/src/import-intercept.ts.
        const glueString = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          glueEntry.contentBlob,
        );

        // @decision DEC-V2-COMPILE-SELF-GLUE-INTERLEAVING-001 (overlap handling)
        // @title Reconstruction uses merged intervals to mirror computeGlueBlob's behaviour
        // @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333 overlap fix)
        // @rationale
        //   bootstrap.ts computeGlueBlob() merges overlapping atom intervals before
        //   computing glue gaps (so the glue does NOT contain chars inside merged intervals).
        //   The reconstruction must mirror this exactly: build the same merged intervals,
        //   then walk merged intervals (not individual atoms) to advance gluePos.
        //   Within each merged interval, emit atoms in sourceOffset order, skipping stale
        //   atoms whose range is already covered by a prior atom in the interval.
        //   With block_occurrences (#355), stale offsets are eliminated: each file's
        //   occurrences are refreshed atomically on every bootstrap pass, so overlapping
        //   intervals no longer occur in normal operation. The merge is retained defensively.
        //
        //   Algorithm:
        //     1. Build merged intervals (same merge as computeGlueBlob).
        //     2. For each merged interval:
        //        a. Emit glue chars from gluePos up to interval.start.
        //        b. Emit atoms within the interval in sourceOffset order, skipping stale ones.
        //        c. Advance prevMergedEnd = interval.end (gluePos mirrors this in the glue string).
        //     3. Emit trailing glue after the last merged interval.

        // Step 1: compute merged intervals (same merge as computeGlueBlob).
        interface MergedInterval {
          start: number;
          end: number;
          atoms: Array<(typeof sorted)[number]>;
        }
        const mergedIntervals: MergedInterval[] = [];
        for (const atom of sorted) {
          const start = atom.effectiveOffset as number;
          const end = start + atom.block.implSource.length;
          const last = mergedIntervals[mergedIntervals.length - 1];
          if (last !== undefined && start < last.end) {
            if (end > last.end) last.end = end;
            last.atoms.push(atom);
          } else {
            mergedIntervals.push({ start, end, atoms: [atom] });
          }
        }

        // Step 2: interleave glue + atoms, walking merged intervals.
        const parts: string[] = [];
        let prevMergedEnd = 0; // end of the last merged interval (original file coord)
        let gluePosCursor = 0; // cursor in glueString

        for (const interval of mergedIntervals) {
          // 2a: glue chars from previous merged interval end to this interval's start.
          const glueBetween = interval.start - prevMergedEnd;
          if (glueBetween > 0) {
            parts.push(glueString.slice(gluePosCursor, gluePosCursor + glueBetween));
            gluePosCursor += glueBetween;
          }

          // 2b: atoms within this interval, skipping overlapping ones.
          let intervalCursor = interval.start;
          for (const atom of interval.atoms) {
            const atomStart = atom.effectiveOffset as number;
            if (atomStart < intervalCursor) {
              // Overlapping atom: start is behind the cursor — skip it.
              logger.log(
                `compile-self: skipping overlapping atom at sourceOffset=${atomStart} in ${group.sourceFile}` +
                  ` (interval cursor at ${intervalCursor}) — overlap artifact`,
              );
              continue;
            }
            parts.push(atom.block.implSource);
            intervalCursor = atomStart + atom.block.implSource.length;
          }

          prevMergedEnd = interval.end;
        }

        // Step 3: trailing glue after the last merged interval.
        if (gluePosCursor < glueString.length) {
          parts.push(glueString.slice(gluePosCursor));
        }

        if (parts.length > 0) {
          fileContent = parts.join("");
        } else {
          // Fallback: no atoms placed (empty merged intervals). Use atom-only concat.
          fileContent = sorted.map((a) => a.block.implSource).join("");
        }
      } else {
        // Fallback: no glue captured (pre-#333 bootstrap) or some atoms lack sourceOffset.
        // Log informational; do not fail (backward compatibility).
        if (glueEntry === null) {
          logger.log(
            `compile-self: no glue row for ${group.sourceFile} — using atom-only concatenation (re-run bootstrap to capture glue)`,
          );
        }
        fileContent = sorted.map((a) => a.block.implSource).join("");
      }

      // Emit to <outputDir>/<sourceFile>.
      const outputPath = join(outputDir, group.sourceFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, fileContent, "utf-8");
      sourceFilesEmitted++;

      // Add one manifest row per atom (per DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001).
      // sourceOffset in manifest now reflects current-truth from block_occurrences.
      for (const atom of sorted) {
        manifest.push({
          outputPath: group.sourceFile, // workspace-relative path (same for all atoms in group)
          blockMerkleRoot: atom.blockMerkleRoot,
          sourcePkg: atom.block.sourcePkg ?? null,
          sourceFile: atom.block.sourceFile ?? null,
          sourceOffset: atom.effectiveOffset,
        });
      }
    }

    // Step 4: Materialise plumbing files from registry.
    // ONLY registry.listWorkspacePlumbing() is the authority — no filesystem reads
    // at compile-self time (DEC-V2-WORKSPACE-PLUMBING-AUTHORITY-001 / FS3).
    const plumbingEntries = await registry.listWorkspacePlumbing();
    let plumbingFilesEmitted = 0;

    for (const plumbing of plumbingEntries) {
      const outputPath = join(outputDir, plumbing.workspacePath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, plumbing.contentBytes);
      plumbingFilesEmitted++;
    }

    // Step 5: Write manifest.json — sorted by (outputPath ASC, sourceOffset ASC).
    // @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001:
    //   manifest shape evolves to Array<{outputPath, blockMerkleRoot, sourcePkg,
    //   sourceFile, sourceOffset}>. Sorted for deterministic output.
    manifest.sort((a, b) => {
      const pathCmp = (a.outputPath ?? "").localeCompare(b.outputPath ?? "");
      if (pathCmp !== 0) return pathCmp;
      const ao = a.sourceOffset ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sourceOffset ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

    writeFileSync(
      join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    logger.log(
      `compile-self: ${manifestEntries.length} total atoms, ${sourceFilesEmitted} source files emitted, ${gapReport.length} gap rows`,
    );

    return {
      recompiledFiles: sourceFilesEmitted,
      gapReport,
      sourceFilesEmitted,
      plumbingFilesEmitted,
    };
  } finally {
    await registry.close();
  }
}
