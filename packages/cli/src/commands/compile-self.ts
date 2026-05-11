// SPDX-License-Identifier: MIT
// compile-self.ts — `yakcc compile-self` command (A2 real implementation).
//
// @decision DEC-V2-COMPILE-SELF-CLI-NAMING-001
// @title `yakcc compile-self` is a top-level command, NOT `yakcc compile --self`
// @status accepted
// @rationale Keeps argument parsing and exit-code semantics independent of
//   `yakcc compile`. The two commands have different inputs (compile takes an
//   entry; compile-self walks the corpus) and different outputs (compile writes
//   one module; compile-self writes per-atom TS files in a dist tree). Co-locating
//   behind a flag would force compile.ts to branch on a fundamentally different
//   code path and would make A2 risk regressing compile.
//
// @decision DEC-V2-COMPILE-SELF-EQ-001
// @title Functional equivalence is the A2 acceptance bar
// @status closed (A2)
// @rationale
//   The functional-equivalence bar for A2 is: the compile pipeline executes over
//   all corpus atoms without silent drops. Each local atom's implSource is retrieved
//   from the registry and compiled via compileToTypeScript (NovelGlueEntry path),
//   producing a per-atom TS file under the output directory. A structured gap report
//   records any atoms that cannot be compiled (never silently dropped — Sacred
//   Practice #5). Byte-equivalence of the TS output is deferred to A3.
//   The pipeline logic mirrors compile-pipeline.ts in examples/v2-self-shave-poc/src/;
//   both modules use the same pattern. They are kept separate because @yakcc/cli
//   cannot import from examples/ (rootDir: src constraint in cli/tsconfig.json).
//
// @decision DEC-V2-CORPUS-DISTRIBUTION-001
// @title SQLite registry + dist-recompiled/ are both gitignored (never committed)
// @status closed (A2)
// @rationale
//   The SQLite registry (bootstrap/yakcc.registry.sqlite) is reproducible from
//   `yakcc bootstrap` and must not be committed (binary bloat + parallel authority
//   surface violation, Sacred Practice #12). The compiled output tree (dist-recompiled/)
//   is likewise reproducible from `yakcc compile-self` and must not be committed.
//   Both artifacts are byte-deterministic from source; the gitignore extension in
//   this slice makes the rule explicit and enforced.
//
// @decision DEC-V2-COMPILE-SELF-EXIT-CODE-001
// @title compile-self returns exit 0 on success, exit 1 on usage/runtime errors
// @status updated (A2 — A1's exit-code-2 stub semantics no longer apply)
// @rationale
//   A1 returned exit code 2 to signal "recognized command, not yet implemented".
//   A2 replaces the stub with the real implementation. The exit code semantics
//   follow standard CLI conventions: 0 = success, 1 = usage or runtime error.
//   Exit code 2 ("not yet implemented") no longer applies because the command
//   IS now implemented. This DEC is kept as a historical record of the A1→A2
//   transition; the A1 exit-code-2 semantics are permanently retired.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compileToTypeScript } from "@yakcc/compile";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
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

/** One compose-path gap row. Never silently dropped (F1 / Sacred Practice #5). */
interface GapRow {
  readonly blockMerkleRoot: string;
  readonly packageName: string;
  readonly reason:
    | "missing-backend-feature"
    | "unresolved-pointer"
    | "foreign-leaf-skipped"
    | "other";
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// compileSelf — A2 real implementation
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc compile-self`.
 *
 * A2 status: implemented. Walks every local atom in the corpus registry,
 * compiles each atom's implSource via @yakcc/compile.compileToTypeScript
 * (NovelGlueEntry path), and writes per-atom TS files to the output directory.
 * A structured compose-path-gap report is written to the logger for any atoms
 * that cannot be compiled (loud failure, never silent drop — Sacred Practice #5).
 *
 * The pipeline logic mirrors examples/v2-self-shave-poc/src/compile-pipeline.ts;
 * both are separate because @yakcc/cli cannot import from examples/ (TypeScript
 * rootDir: src constraint). The canonical testable module is compile-pipeline.ts.
 *
 * CLI flags:
 *   --output <dir>   Output directory for compiled TS files (default: dist-recompiled/)
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
        "yakcc compile-self — recompile the yakcc corpus from the registry",
        "",
        "USAGE",
        "  yakcc compile-self [--output <dir>] [--registry <path>]",
        "",
        "OPTIONS",
        `  --output, -o <dir>   Output directory for compiled atoms (default: ${DEFAULT_OUTPUT_DIR})`,
        `  --registry, -r <p>   SQLite registry path (default: ${DEFAULT_REGISTRY_PATH})`,
        "  --help, -h           Print this help and exit",
        "",
        "DESCRIPTION",
        "  Walks every local atom in the corpus registry, retrieves each atom's",
        "  TypeScript implementation source, compiles it via compileToTypeScript,",
        "  and writes per-atom TS files to <output>/atoms/<blockMerkleRoot>.ts.",
        "  A manifest.json is written under <output>/ mapping each output file to",
        "  its blockMerkleRoot. Any atoms that cannot be compiled are recorded in",
        "  the compose-path-gap report (never silently dropped).",
        "",
        "EXIT CODES",
        "  0  success (gap report may be non-empty for informational foreign-leaf rows)",
        "  1  usage or runtime error (registry not found, pipeline failure)",
        "",
        "WI-V2-CORPUS-AND-COMPILE-SELF-EQ (issue #59), slice A2.",
        "DEC-V2-COMPILE-SELF-EQ-001 (functional equivalence bar).",
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

  logger.log("yakcc compile-self — A2 compile pipeline");
  logger.log(`  registry: ${registryPath}`);
  logger.log(`  output:   ${outputDir}`);
  logger.log("");

  // Run the compile pipeline.
  let pipelineResult: { recompiledFiles: number; gapReport: GapRow[] };
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
    `compile-self: ${pipelineResult.recompiledFiles} atoms compiled → ${outputDir}/atoms/`,
  );
  logger.log(`compile-self: manifest written → ${outputDir}/manifest.json`);

  // Log gap report (loud — never silent, per F1 / Sacred Practice #5).
  if (pipelineResult.gapReport.length > 0) {
    const foreignSkipped = pipelineResult.gapReport.filter(
      (r) => r.reason === "foreign-leaf-skipped",
    ).length;
    const missingFeature = pipelineResult.gapReport.filter(
      (r) => r.reason === "missing-backend-feature",
    ).length;
    const unresolvedPointer = pipelineResult.gapReport.filter(
      (r) => r.reason === "unresolved-pointer",
    ).length;
    const other = pipelineResult.gapReport.filter((r) => r.reason === "other").length;

    logger.log("");
    logger.log(`compile-self: compose-path-gap report (${pipelineResult.gapReport.length} rows):`);
    if (foreignSkipped > 0) {
      logger.log(
        `  foreign-leaf-skipped:     ${foreignSkipped} (informational — foreign atoms not inlined)`,
      );
    }
    if (missingFeature > 0) {
      logger.log(
        `  missing-backend-feature:  ${missingFeature} (compileToTypeScript cannot handle these)`,
      );
    }
    if (unresolvedPointer > 0) {
      logger.log(
        `  unresolved-pointer:       ${unresolvedPointer} (PointerEntry with no in-corpus resolution)`,
      );
    }
    if (other > 0) {
      logger.error(`  other (unexpected):       ${other} — see gap report rows for detail`);
      for (const row of pipelineResult.gapReport.filter((r) => r.reason === "other")) {
        logger.error(`    [${row.blockMerkleRoot.slice(0, 8)}] ${row.detail}`);
      }
    }

    // 'other' rows are unexpected failures → non-zero exit.
    if (other > 0) {
      return 1;
    }
  } else {
    logger.log("compile-self: compose-path-gap report: empty (all atoms compiled successfully)");
  }

  return 0;
}

// ---------------------------------------------------------------------------
// _runPipeline — internal compile-self pipeline
//
// Mirrors the logic in examples/v2-self-shave-poc/src/compile-pipeline.ts.
// Kept separate because @yakcc/cli's tsconfig has rootDir: src and cannot
// import from examples/. The canonical testable module is compile-pipeline.ts.
// ---------------------------------------------------------------------------

async function _runPipeline(
  registryPath: string,
  outputDir: string,
  logger: Logger,
): Promise<{ recompiledFiles: number; gapReport: GapRow[] }> {
  const registry: Registry = await openRegistry(registryPath, NULL_EMBEDDING_OPTS);

  try {
    // Enumerate all atoms via exportManifest (single authority — Sacred Practice #12).
    const manifestEntries = await registry.exportManifest();

    // Create output atoms directory.
    const atomsDir = join(outputDir, "atoms");
    mkdirSync(atomsDir, { recursive: true });

    const manifest: Array<{ outputPath: string; blockMerkleRoot: string }> = [];
    const gapReport: GapRow[] = [];
    let recompiledFiles = 0;

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

      // Compile local atom: wrap implSource as NovelGlueEntry.
      // @decision DEC-V2-COMPILE-SELF-EQ-001: Using NovelGlueEntry (not PointerEntry)
      // is the only way to get compileToTypeScript to emit actual source text.
      const plan = {
        entries: [
          {
            kind: "novel-glue" as const,
            sourceRange: { start: 0, end: block.implSource.length },
            source: block.implSource,
            canonicalAstHash: block.canonicalAstHash,
          },
        ],
        matchedPrimitives: [],
        sourceBytesByKind: { pointer: 0, novelGlue: block.implSource.length, glue: 0 },
      };

      let tsSource: string;
      try {
        tsSource = compileToTypeScript(plan);
      } catch (err) {
        gapReport.push({
          blockMerkleRoot: entry.blockMerkleRoot,
          packageName: "unknown",
          reason: "missing-backend-feature",
          detail: `compileToTypeScript threw unexpectedly: ${String(err)}`,
        });
        continue;
      }

      const outputFileName = `${entry.blockMerkleRoot}.ts`;
      const outputPath = join(atomsDir, outputFileName);
      writeFileSync(outputPath, tsSource, "utf-8");

      manifest.push({
        outputPath: join("atoms", outputFileName),
        blockMerkleRoot: entry.blockMerkleRoot,
      });
      recompiledFiles++;
    }

    // Write manifest.json (per I9: outputPath → blockMerkleRoot).
    writeFileSync(
      join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    logger.log(
      `compile-self: ${manifestEntries.length} total atoms, ${recompiledFiles} compiled, ${gapReport.length} gap rows`,
    );

    return { recompiledFiles, gapReport };
  } finally {
    await registry.close();
  }
}
