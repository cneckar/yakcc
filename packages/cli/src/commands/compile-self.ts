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
 *   'other'                — unexpected; triggers exit 1 (Sacred Practice #5)
 */
interface GapRow {
  readonly blockMerkleRoot: string;
  readonly packageName: string;
  readonly reason:
    | "null-provenance"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
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

    logger.log(
      `compile-self: ${manifestEntries.length} total atoms in registry`,
    );

    // Step 2: Group atoms by (sourcePkg, sourceFile).
    // Key: workspace-relative file path (sourceFile, e.g. 'packages/cli/src/commands/foo.ts').
    // @decision DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001
    type GroupKey = string; // `${sourcePkg}/${sourceFile}` — used only as Map key
    interface AtomGroup {
      sourcePkg: string;
      sourceFile: string;
      atoms: Array<{ block: BlockTripletRow; blockMerkleRoot: string }>;
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

      // Local atoms with NULL provenance: cannot place in workspace tree.
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

      // Collect into group.
      const key: GroupKey = block.sourceFile; // sourceFile is workspace-relative, unique per file
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

    // Step 3: Emit one TS file per group, sorted atoms by sourceOffset ASC.
    // @decision I7 resolution: NULLs sort to end (append as suffix); warn but do not fail.
    // @decision I8 resolution: overlapping offsets produce 'other' gap row (cannot arise
    //   in well-formed corpora because INSERT OR IGNORE is per blockMerkleRoot PK).
    const manifest: ManifestEntry[] = [];
    let sourceFilesEmitted = 0;

    mkdirSync(outputDir, { recursive: true });

    for (const [, group] of groupMap) {
      // Sort: non-null offsets ascending first, then null offsets appended.
      const sorted = [...group.atoms].sort((a, b) => {
        const ao = a.block.sourceOffset ?? null;
        const bo = b.block.sourceOffset ?? null;
        if (ao === null && bo === null) return 0;
        if (ao === null) return 1; // nulls to end
        if (bo === null) return -1;
        return ao - bo;
      });

      // Concatenate implSource blobs in sourceOffset order.
      // Each atom's implSource is its full TypeScript source text.
      const concatenated = sorted.map((a) => a.block.implSource).join("");

      // Emit to <outputDir>/<sourceFile>.
      const outputPath = join(outputDir, group.sourceFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, concatenated, "utf-8");
      sourceFilesEmitted++;

      // Add one manifest row per atom (per DEC-V2-COMPILE-SELF-WORKSPACE-RECONSTRUCTION-001).
      for (const atom of sorted) {
        manifest.push({
          outputPath: group.sourceFile, // workspace-relative path (same for all atoms in group)
          blockMerkleRoot: atom.blockMerkleRoot,
          sourcePkg: atom.block.sourcePkg ?? null,
          sourceFile: atom.block.sourceFile ?? null,
          sourceOffset: atom.block.sourceOffset ?? null,
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
