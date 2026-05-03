// SPDX-License-Identifier: MIT
// bootstrap.ts — `yakcc bootstrap` command.
//
// Walks the yakcc source tree (packages/*/src and examples/*/src), shaves
// each .ts file through the offline static-intent pipeline, and dumps the
// deterministic registry manifest via Registry.exportManifest() (WI-V2-BOOTSTRAP-01).
//
// Outputs:
//   bootstrap/expected-roots.json   - sorted deterministic manifest
//   bootstrap/report.json           - per-file shave outcomes
//   bootstrap/yakcc.registry.sqlite - SQLite registry (gitignored)
//
// @decision DEC-V2-BOOT-CLI-001
// @title yakcc bootstrap is a CLI orchestrator over per-file shave
// @status accepted
// @rationale The bootstrap verb is intentionally a thin orchestrator — it walks
//   files, calls shave() per-file, and dumps the registry manifest. All pipeline
//   logic stays in @yakcc/shave. This matches the (argv, logger) => Promise<number>
//   contract shared by all yakcc commands.
//
// @decision DEC-V2-BOOT-FILE-ORDER-001
// @title Lexicographic file ordering is the canonical iteration order
// @status accepted
// @rationale Glob results are not order-stable across OSes (e.g. node:fs readdir
//   on Windows vs Linux). Sorting lexicographically before iteration ensures the
//   per-file processing order is identical across platforms, which preserves
//   deterministic registry insert order. The merkle root is order-independent
//   (content-addressed), but the report JSON and log output need stable order
//   for diff-friendliness.
//
// @decision DEC-V2-BOOT-NO-AI-CORPUS-001
// @title Force-disable AI-derived corpus extraction in bootstrap mode
// @status accepted
// @rationale The corpus extractor has a source-C path that hits an AI cache.
//   Cache cold/warm transitions would make the bootstrap output non-deterministic
//   across runs (the load-bearing content-address invariant). Bootstrap mode forces
//   offline:true + intentStrategy:"static" so the extracted corpus comes only from
//   upstream tests + documented usage. TODO: when ShaveOptions gains
//   corpusOptions.disableSourceC, switch to that for a stronger guarantee.
// Status: implemented (WI-V2-BOOTSTRAP-02)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { shave as shaveImpl } from "@yakcc/shave";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOTSTRAP_PARSE_OPTIONS = {
  registry: { type: "string" as const },
  report: { type: "string" as const },
  manifest: { type: "string" as const },
  help: { type: "boolean" as const, short: "h", default: false },
} as const;

const DEFAULT_REGISTRY_PATH = join("bootstrap", "yakcc.registry.sqlite");
const DEFAULT_MANIFEST_PATH = join("bootstrap", "expected-roots.json");
const DEFAULT_REPORT_PATH = join("bootstrap", "report.json");

// ---------------------------------------------------------------------------
// File-walking helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts files under a directory.
 * Does not follow symlinks.
 */
function walkTs(dir: string, results: string[]): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(fullPath);
    }
  }
}

/**
 * Determine if a file path should be excluded from the bootstrap walk.
 *
 * Filter rules (match WI-037 SPDX sweep logic):
 *   - Skip *.test.ts
 *   - Skip *.d.ts
 *   - Skip vitest.config.ts
 *   - Skip anything under __tests__/, __fixtures__/, __snapshots__/, node_modules/, dist/
 */
function shouldSkip(absPath: string): boolean {
  const basename = absPath.split(/[\\/]/).pop() ?? "";

  // Skip by filename
  if (basename.endsWith(".test.ts")) return true;
  if (basename.endsWith(".d.ts")) return true;
  if (basename === "vitest.config.ts") return true;

  // Skip by directory segment — normalize to forward slashes for cross-platform matching
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.includes("/__tests__/")) return true;
  if (normalized.includes("/__fixtures__/")) return true;
  if (normalized.includes("/__snapshots__/")) return true;
  if (normalized.includes("/node_modules/")) return true;
  if (normalized.includes("/dist/")) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Search upward from startDir for a directory containing:
 *   - pnpm-workspace.yaml (primary indicator for a monorepo root), OR
 *   - package.json with "name": "yakcc" (fallback for single-package repos)
 *
 * Falls back to startDir if nothing is found at or above.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    try {
      const pkgJson = readFileSync(join(dir, "package.json"), "utf-8");
      const parsed = JSON.parse(pkgJson) as { name?: string };
      if (parsed.name === "yakcc") return dir;
    } catch {
      // package.json missing or unparseable — continue upward
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return startDir;
}

// ---------------------------------------------------------------------------
// Per-file outcome types
// ---------------------------------------------------------------------------

interface FileOutcomeSuccess {
  readonly path: string;
  readonly outcome: "success";
  readonly atomCount: number;
  readonly intentCardCount: number;
}

interface FileOutcomeFailure {
  readonly path: string;
  readonly outcome: "failure";
  readonly errorClass: string;
  readonly errorMessage: string;
}

type FileOutcome = FileOutcomeSuccess | FileOutcomeFailure;

// ---------------------------------------------------------------------------
// bootstrap() — public command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc bootstrap [--registry <p>] [--manifest <p>] [--report <p>]`.
 *
 * Walks source files in the repo, shaves each through the offline
 * static-intent pipeline, and writes:
 *   - A per-file outcome report (--report)
 *   - The deterministic registry manifest (--manifest)
 *
 * Exits 0 only if all files shave successfully. Any failure → exit 1.
 *
 * @param argv   - Subcommand args after "bootstrap" has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — 0 on success, 1 on error.
 */
export async function bootstrap(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Parse arguments.
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: false,
        options: BOOTSTRAP_PARSE_OPTIONS,
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  if (parsed.values.help) {
    logger.log(
      [
        "Usage: yakcc bootstrap [--registry <path>] [--manifest <path>] [--report <path>]",
        "",
        "  Walk packages/*/src/**/*.ts and examples/*/src/**/*.ts, shave each file",
        "  offline, and dump the deterministic block manifest.",
        "",
        "  --registry <path>   Registry SQLite path (default: bootstrap/yakcc.registry.sqlite)",
        "  --manifest <path>   Output manifest path (default: bootstrap/expected-roots.json)",
        "  --report   <path>   Per-file outcome report (default: bootstrap/report.json)",
        "  -h, --help          Print this help and exit",
      ].join("\n"),
    );
    return 0;
  }

  const registryPath = resolve(parsed.values.registry ?? DEFAULT_REGISTRY_PATH);
  const manifestPath = resolve(parsed.values.manifest ?? DEFAULT_MANIFEST_PATH);
  const reportPath = resolve(parsed.values.report ?? DEFAULT_REPORT_PATH);

  // Resolve the repo root.
  const repoRoot = findRepoRoot(process.cwd());

  // Collect source files from packages/*/src/ and examples/*/src/.
  const rawFiles: string[] = [];
  for (const topDir of ["packages", "examples"]) {
    const topAbs = join(repoRoot, topDir);
    if (!existsSync(topAbs)) continue;

    const pkgDirs = readdirSync(topAbs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(topAbs, e.name, "src"));

    for (const srcDir of pkgDirs) {
      walkTs(srcDir, rawFiles);
    }
  }

  // Filter out test/generated files and sort lexicographically (DEC-V2-BOOT-FILE-ORDER-001).
  const sourceFiles = rawFiles.filter((f) => !shouldSkip(f)).sort();

  if (sourceFiles.length === 0) {
    logger.error(
      `error: no source files found under ${repoRoot}. Expected packages/*/src/**/*.ts or examples/*/src/**/*.ts.`,
    );
    return 1;
  }

  // Ensure output parent directories exist.
  for (const outputPath of [registryPath, manifestPath, reportPath]) {
    mkdirSync(dirname(outputPath), { recursive: true });
  }

  // Open registry. Bootstrap is contractually offline (DEC-V2-BOOT-NO-AI-CORPUS-001),
  // so the deterministic BLAKE3 embedding provider is used instead of the default
  // transformers.js provider which would download a model from HuggingFace on first
  // storeBlock call. The exported manifest excludes embeddings entirely
  // (DEC-V2-BOOTSTRAP-MANIFEST-001), so vector quality is irrelevant here.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, { embeddings: createOfflineEmbeddingProvider() });
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${(err as Error).message}`);
    return 1;
  }

  // Adapt Registry → ShaveRegistryView (same pattern as shave.ts lines ~79-87).
  // storeBlock is forwarded from the full Registry so that atoms are persisted
  // during the bootstrap shave run.
  const shaveRegistry = {
    selectBlocks: (specHash: Parameters<typeof registry.selectBlocks>[0]) =>
      registry.selectBlocks(specHash),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
    storeBlock: registry.storeBlock?.bind(registry),
  };

  // Process each file.
  const outcomes: FileOutcome[] = [];

  for (const absPath of sourceFiles) {
    const relPath = relative(repoRoot, absPath);
    try {
      // Force offline: true to disable AI-corpus extraction (DEC-V2-BOOT-NO-AI-CORPUS-001).
      // TODO: when ShaveOptions gains corpusOptions.disableSourceC, use that instead.
      const result = await shaveImpl(absPath, shaveRegistry, {
        offline: true,
        intentStrategy: "static",
      });
      outcomes.push({
        path: relPath,
        outcome: "success",
        atomCount: result.atoms.length,
        intentCardCount: result.intentCards.length,
      });
    } catch (err) {
      const e = err as Error;
      outcomes.push({
        path: relPath,
        outcome: "failure",
        errorClass: e.constructor.name,
        errorMessage: e.message,
      });
    }
  }

  // Export the deterministic manifest.
  let manifest: readonly object[];
  try {
    manifest = await registry.exportManifest();
  } catch (err) {
    logger.error(`error: failed to export manifest: ${(err as Error).message}`);
    await registry.close();
    return 1;
  }

  // Write outputs.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  writeFileSync(reportPath, `${JSON.stringify(outcomes, null, 2)}\n`, "utf-8");

  // Close registry.
  await registry.close();

  // Summarise.
  const successCount = outcomes.filter((o) => o.outcome === "success").length;
  const failureCount = outcomes.filter((o) => o.outcome === "failure").length;

  logger.log("Bootstrap complete:");
  logger.log(`  files processed: ${outcomes.length}`);
  logger.log(`  successful:      ${successCount}`);
  logger.log(`  failed:          ${failureCount}`);
  logger.log(`  manifest:        ${manifestPath} (${manifest.length} entries)`);
  logger.log(`  report:          ${reportPath}`);

  if (failureCount > 0) {
    logger.error(`error: ${failureCount} file(s) failed to shave:`);
    for (const o of outcomes) {
      if (o.outcome === "failure") {
        logger.error(`  ${o.path}: ${o.errorClass} — ${o.errorMessage}`);
      }
    }
    return 1;
  }

  return 0;
}
