// SPDX-License-Identifier: MIT
//
// @decision DEC-V2-BOOT-FILE-ORDER-001
// title: Lexicographic sort of source file paths before shaving
// status: accepted (WI-V2-BOOTSTRAP-02)
// rationale:
//   The bootstrap manifest is a committed artifact compared byte-for-byte across
//   runs. Any nondeterminism in file processing order would produce different
//   registry insertion sequences, which could produce different BlockMerkleRoots
//   when parentBlockRoot lineage differs. Sorting by absolute path string
//   (lexicographic, locale-independent via localeCompare(b, undefined, {sensitivity:"variant"}))
//   is the simplest determinism guarantee. Sister's WI-V2-BOOT-PREFLIGHT empirically
//   validated per-file determinism; this decision extends that guarantee across files.
//
// @decision DEC-V2-BOOT-NO-AI-CORPUS-001
// title: Bootstrap shave runs offline with no AI corpus (source C disabled)
// status: accepted (WI-V2-BOOTSTRAP-02)
// rationale:
//   AI-derived property-test corpus (source C in the three-source priority chain) is
//   non-deterministic: results depend on the model, the prompt version, and the
//   presence/absence of a pre-warmed cache. The bootstrap manifest must be
//   reproducible from a clean cache on any machine. Passing `offline: true` to
//   shave() disables live AI calls entirely; without a `cacheDir` the corpus
//   extraction path for source C is also unreachable. Sources (a) upstream-test
//   and (b) documented-usage are always deterministic and remain enabled.
//   The intent strategy defaults to "static" (DEC-INTENT-STRATEGY-001), which
//   produces deterministic IntentCards without any API calls.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { BootstrapManifestEntry } from "@yakcc/registry";
import { shave as shaveImpl } from "@yakcc/shave";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default registry path — gitignored artifact, not a source file. */
const DEFAULT_REGISTRY_PATH = "bootstrap/yakcc.registry.sqlite";
/** Default report path. */
const DEFAULT_REPORT_PATH = "bootstrap/report.json";
/** Default manifest output path — committed in WI-V2-BOOTSTRAP-03. */
const DEFAULT_MANIFEST_PATH = "bootstrap/expected-roots.json";

/**
 * Directory-name segments that cause a file to be skipped.
 * Checked against every path component of the file's relative path.
 */
const SKIP_DIR_SEGMENTS = new Set([
  "__tests__",
  "__fixtures__",
  "__snapshots__",
  "dist",
  "node_modules",
]);

/**
 * File-name patterns that cause a file to be skipped.
 * Checked against the file's basename.
 */
const SKIP_FILE_SUFFIXES = [".test.ts", ".d.ts"] as const;
const SKIP_FILE_EXACT = new Set(["vitest.config.ts"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome record for one processed source file. */
export interface PerFileOutcome {
  readonly filePath: string;
  readonly status: "shaved" | "skipped" | "failed";
  readonly merkleRoots: BlockMerkleRoot[];
  readonly errorMessage?: string | undefined;
  readonly errorClass?: string | undefined;
}

/** Top-level structure of the bootstrap report. */
export interface BootstrapReport {
  readonly summary: {
    readonly totalFiles: number;
    readonly shaved: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly files: PerFileOutcome[];
}

// ---------------------------------------------------------------------------
// Argument options
// ---------------------------------------------------------------------------

const BOOTSTRAP_PARSE_OPTIONS = {
  registry: { type: "string" },
  report: { type: "string" },
  manifest: { type: "string" },
  root: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

/**
 * Walk `rootDir` collecting TypeScript source files under:
 *   - `<rootDir>/packages/*\/src\/**\/*.ts`
 *   - `<rootDir>/examples/*\/src\/**\/*.ts`
 *
 * Skip patterns (applied to every path component and basename):
 *   - directories: __tests__, __fixtures__, __snapshots__, dist, node_modules
 *   - filenames: *.test.ts, *.d.ts, vitest.config.ts
 *
 * Returns paths sorted lexicographically by absolute path string.
 * (DEC-V2-BOOT-FILE-ORDER-001)
 */
export async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walkDir(dir: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or can't be read — skip silently.
      return;
    }

    for (const entry of entries) {
      const absPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip blocked directory names anywhere in the tree.
        if (SKIP_DIR_SEGMENTS.has(entry.name)) continue;
        await walkDir(absPath);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith(".ts")) continue;
        // Skip blocked filenames.
        if (SKIP_FILE_EXACT.has(entry.name)) continue;
        if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        results.push(absPath);
      }
    }
  }

  // Walk packages/*/src/** and examples/*/src/**
  for (const topDir of ["packages", "examples"]) {
    const topPath = join(rootDir, topDir);
    let pkgEntries: Dirent<string>[];
    try {
      pkgEntries = await readdir(topPath, { withFileTypes: true });
    } catch {
      // Top-level directory doesn't exist — skip.
      continue;
    }
    for (const pkgEntry of pkgEntries) {
      if (!pkgEntry.isDirectory()) continue;
      const srcPath = join(topPath, pkgEntry.name, "src");
      // Verify src/ exists before descending.
      try {
        const s = await stat(srcPath);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      await walkDir(srcPath);
    }
  }

  // Deterministic order — lex sort by absolute path (DEC-V2-BOOT-FILE-ORDER-001).
  results.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "variant" }));
  return results;
}

// ---------------------------------------------------------------------------
// Registry adapter
// ---------------------------------------------------------------------------

/**
 * Adapt the full Registry interface to the narrower ShaveRegistryView that
 * shaveImpl() accepts. The Registry interface returns `null` for missing
 * blocks; ShaveRegistryView expects `undefined`.
 */
function makeShaveRegistryView(registry: Registry) {
  return {
    selectBlocks: (specHash: Parameters<typeof registry.selectBlocks>[0]) =>
      registry.selectBlocks(specHash),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
    storeBlock: registry.storeBlock.bind(registry),
  };
}

// ---------------------------------------------------------------------------
// Core bootstrap logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Run the full bootstrap shave pass over `sourceFiles`.
 *
 * For each file, calls shaveImpl with `offline: true` (DEC-V2-BOOT-NO-AI-CORPUS-001).
 * Returns per-file outcomes without writing any files.
 *
 * @param sourceFiles - Absolute paths in deterministic order (DEC-V2-BOOT-FILE-ORDER-001).
 * @param registry    - Open registry to store shaved atoms into.
 */
export async function runBootstrapPass(
  sourceFiles: readonly string[],
  registry: Registry,
): Promise<PerFileOutcome[]> {
  const shaveRegistryView = makeShaveRegistryView(registry);
  const outcomes: PerFileOutcome[] = [];

  for (const filePath of sourceFiles) {
    try {
      const result = await shaveImpl(filePath, shaveRegistryView, {
        offline: true,
        // DEC-V2-BOOT-NO-AI-CORPUS-001: intentStrategy "static" is the default
        // (DEC-INTENT-STRATEGY-001) — no API calls, fully deterministic.
        // No cacheDir is passed, so AI-derived corpus source C is unreachable.
        intentStrategy: "static",
      });

      const merkleRoots = result.atoms
        .map((a) => a.merkleRoot)
        .filter((r): r is BlockMerkleRoot => r !== undefined);

      outcomes.push({ filePath, status: "shaved", merkleRoots });
    } catch (err) {
      const e = err as Error;
      outcomes.push({
        filePath,
        status: "failed",
        merkleRoots: [],
        errorMessage: e.message,
        errorClass: e.constructor?.name,
      });
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Public command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc bootstrap [options]`.
 *
 * Walks the project source tree, shaves each file into the registry, exports
 * a deterministic manifest, and writes a structured report.
 *
 * Exit 0 when failed === 0; exit 1 otherwise (emits per-file errors to stderr).
 *
 * @param argv   - Remaining argv after "bootstrap" has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — 0 on success, 1 on partial failure.
 */
export async function bootstrap(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Parse arguments — parseArgs throws on unknown flags.
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
      "Usage: yakcc bootstrap [options]\n" +
        "\n" +
        "  Walk packages/*/src/**/*.ts and examples/*/src/**/*.ts, shave each file\n" +
        "  into the registry, and write a deterministic manifest.\n" +
        "\n" +
        "  --registry <path>   Registry path          (default: bootstrap/yakcc.registry.sqlite)\n" +
        "  --report <path>     Report output path     (default: bootstrap/report.json)\n" +
        "  --manifest <path>   Manifest output path   (default: bootstrap/expected-roots.json)\n" +
        "  --root <path>       Project root to walk   (default: cwd)\n" +
        "  --help, -h          Print this help\n",
    );
    return 0;
  }

  const rootDir = resolve(parsed.values.root ?? process.cwd());
  const registryPath = resolve(rootDir, parsed.values.registry ?? DEFAULT_REGISTRY_PATH);
  const reportPath = resolve(rootDir, parsed.values.report ?? DEFAULT_REPORT_PATH);
  const manifestPath = resolve(rootDir, parsed.values.manifest ?? DEFAULT_MANIFEST_PATH);

  // Open (or create) the registry.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${(err as Error).message}`);
    return 1;
  }

  try {
    // Collect source files.
    logger.log(`bootstrap: walking source tree under ${rootDir}`);
    const sourceFiles = await collectSourceFiles(rootDir);
    logger.log(`bootstrap: found ${sourceFiles.length} source files`);

    // Shave all files.
    const outcomes = await runBootstrapPass(sourceFiles, registry);

    // Tally results.
    const shaved = outcomes.filter((o) => o.status === "shaved").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    const totalFiles = outcomes.length;

    logger.log(
      `bootstrap: complete — ${shaved} shaved, ${skipped} skipped, ${failed} failed (total: ${totalFiles})`,
    );

    // Build report.
    const report: BootstrapReport = {
      summary: { totalFiles, shaved, skipped, failed },
      files: outcomes,
    };

    // Export manifest from registry.
    const manifestEntries: readonly BootstrapManifestEntry[] = await registry.exportManifest();

    // Ensure output directories exist.
    await mkdir(resolve(reportPath, ".."), { recursive: true });
    await mkdir(resolve(manifestPath, ".."), { recursive: true });

    // Write report (pretty JSON, not sorted — it's a human-readable debug artifact).
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
    logger.log(`bootstrap: report written to ${reportPath}`);

    // Write manifest (sorted-pretty JSON, keys sorted at entry level).
    // The array is already sorted by blockMerkleRoot per exportManifest() contract.
    const manifestJson = JSON.stringify(
      manifestEntries,
      // Replacer: sort object keys for byte-identity across serializers.
      (_, value: unknown) => {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const sorted: Record<string, unknown> = {};
          for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = (value as Record<string, unknown>)[key];
          }
          return sorted;
        }
        return value;
      },
      2,
    );
    await writeFile(manifestPath, manifestJson, "utf-8");
    logger.log(
      `bootstrap: manifest written to ${manifestPath} (${manifestEntries.length} entries)`,
    );

    // Emit per-file failures to stderr.
    if (failed > 0) {
      logger.error(`bootstrap: ${failed} file(s) failed to shave:`);
      for (const outcome of outcomes) {
        if (outcome.status === "failed") {
          logger.error(
            `  [FAILED] ${outcome.filePath}: ${outcome.errorMessage ?? "(unknown error)"}`,
          );
        }
      }
      return 1;
    }

    return 0;
  } finally {
    await registry.close();
  }
}
