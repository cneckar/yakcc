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
//
// @decision DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001
// @title bootstrap/expected-roots.json is a monotonic accumulator — never shrinks
// @status accepted
// @rationale PR #280 deleted the in-house TS→WASM lowerer (~25,880 LoC). Atoms
//   from that source existed in the manifest on feature branches that never merged
//   to main. Re-running bootstrap against the current codebase would silently drop
//   them, violating the registry's monotonic invariant: atoms are never deleted.
//   Solution: `yakcc bootstrap` is now additive — prior entries absent from the
//   current shave are RETAINED; new entries are ADDED; the result is always the
//   superset sorted by blockMerkleRoot ASC. CI is the sole writer. Implementers
//   MUST NOT run `yakcc bootstrap` manually to update the manifest; CI handles it.
//   Three sub-decisions:
//   (a) expected-roots.json is a monotonic superset, never shrinks.
//   (b) --verify checks current_shave ⊆ committed_manifest (not byte-equality).
//       Archived atoms (in committed but not in current shave) are EXPECTED and
//       are NOT a failure. New atoms NOT in committed ARE a failure (named in output).
//   (c) CI is the sole writer of manifest updates going forward.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BootstrapManifestEntry, Registry, RegistryOptions } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { shave as shaveImpl } from "@yakcc/shave";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Expected-failures schema
//
// @decision DEC-V2-BOOT-EXPECTED-FAILURES-001
// @title expected-failures.json documents intentional LicenseRefusedError cases
// @status accepted
// @rationale Some fixture files are intentionally GPL-licensed to exercise the
//   license gate. These must not contribute to the bootstrap failure count.
//   The expected-failures.json file (bootstrap/expected-failures.json) documents
//   each such case with path + errorClass + rationale. Both path and errorClass
//   must match for the reclassification to apply (path alone is insufficient —
//   a file that fails for a different reason is a real failure). If an entry
//   is never triggered, a WARNING is emitted: that either means the file was
//   renamed/deleted or the underlying issue was fixed, both of which warrant
//   removing the entry. Untriggered entries do NOT fail the bootstrap.
// ---------------------------------------------------------------------------

/** One entry in expected-failures.json. */
interface ExpectedFailureEntry {
  readonly path: string; // repo-relative, matches outcomes[].path
  readonly errorClass: string; // constructor name, e.g. "LicenseRefusedError"
  readonly rationale: string; // human-readable explanation
}

/** Top-level shape of bootstrap/expected-failures.json (schemaVersion: 1). */
interface ExpectedFailuresFile {
  readonly schemaVersion: 1;
  readonly entries: readonly ExpectedFailureEntry[];
}

/**
 * Load and parse expected-failures.json from the given path.
 * Returns an empty entry list if the file does not exist.
 * Throws if the file exists but is malformed (fast-fail: bad config is worse
 * than a missed exemption).
 */
function loadExpectedFailures(filePath: string): readonly ExpectedFailureEntry[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as ExpectedFailuresFile;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `expected-failures.json: unsupported schemaVersion ${String(parsed.schemaVersion)} (expected 1)`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("expected-failures.json: 'entries' must be an array");
  }
  return parsed.entries;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOTSTRAP_PARSE_OPTIONS = {
  registry: { type: "string" as const },
  report: { type: "string" as const },
  manifest: { type: "string" as const },
  "expected-failures": { type: "string" as const },
  verify: { type: "boolean" as const, default: false },
  help: { type: "boolean" as const, short: "h", default: false },
} as const;

const DEFAULT_REGISTRY_PATH = join("bootstrap", "yakcc.registry.sqlite");
const DEFAULT_MANIFEST_PATH = join("bootstrap", "expected-roots.json");
const DEFAULT_REPORT_PATH = join("bootstrap", "report.json");
const DEFAULT_EXPECTED_FAILURES_PATH = join("bootstrap", "expected-failures.json");

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
  // *.props.ts are hand-authored property-test corpus files (WI-V2-07-L8).
  // They are consumed as corpus by the shave pipeline when processing the
  // sibling source file; they must not be shaved themselves.
  if (basename.endsWith(".props.ts")) return true;

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
// Bootstrap-mode embedding provider — deterministic zeros, no network access
//
// @decision DEC-V2-BOOTSTRAP-EMBEDDING-001
// @title Bootstrap uses a zero-vector EmbeddingProvider to avoid network deps
// @status accepted
// @rationale exportManifest() does not read the embeddings table — the manifest
//   only contains content-addressed fields (blockMerkleRoot, specHash, etc).
//   Using the real local embedding provider (Xenova/all-MiniLM-L6-v2) would
//   require a huggingface.co download that is unavailable in sandboxed CI and
//   offline environments, and would add non-determinism risk if the model
//   version ever changes. A deterministic zero vector is correct for bootstrap:
//   it satisfies the registry's embedding column constraint, cannot affect the
//   content-address invariant, and makes bootstrap fully reproducible everywhere.
// ---------------------------------------------------------------------------

const BOOTSTRAP_EMBEDDING_OPTS: Pick<RegistryOptions, "embeddings"> = {
  embeddings: {
    dimension: 384,
    modelId: "bootstrap/null-zero",
    embed: async (_text: string): Promise<Float32Array> => new Float32Array(384),
  },
};

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

/**
 * A failure that was reclassified as an expected-failure because it matches an
 * entry in expected-failures.json (path + errorClass both match).
 * These are surfaced in the summary but do NOT count toward the failure total
 * and do NOT cause a non-zero exit code.
 */
interface FileOutcomeExpectedFailure {
  readonly path: string;
  readonly outcome: "expected-failure";
  readonly errorClass: string;
  readonly errorMessage: string;
  /** The rationale string from the matching expected-failures.json entry. */
  readonly rationale: string;
}

type FileOutcome = FileOutcomeSuccess | FileOutcomeFailure | FileOutcomeExpectedFailure;

// ---------------------------------------------------------------------------
// VerifyDiff — structured diff result for --verify mode
// ---------------------------------------------------------------------------

interface VerifyDiff {
  readonly addedRoots: ReadonlyArray<{ merkleRoot: string; sourcePath: string | null }>;
  readonly removedRoots: ReadonlyArray<{ merkleRoot: string }>;
}

// ---------------------------------------------------------------------------
// mergeManifestEntries() — additive merge of prior + shaved entries
//
// @decision DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 (see file header)
// @title Additive manifest merge — union keyed on blockMerkleRoot, sorted ASC
// @status accepted
// @rationale Prior entries absent from the current shave are retained (archived
//   atoms from deleted branches/PRs must not be lost). New entries are added.
//   The superset is sorted by blockMerkleRoot ASC for diff-stability.
// ---------------------------------------------------------------------------

/**
 * Merge prior manifest entries with fresh shave entries into a monotonic superset.
 *
 * - Entries from `prior` absent in `shaved` are RETAINED (archived atoms).
 * - Entries from `shaved` absent in `prior` are ADDED.
 * - Duplicate roots (same blockMerkleRoot) → prior entry wins (stable identity).
 * - Result is sorted by blockMerkleRoot ASC.
 *
 * @param prior  - Entries already committed to the manifest (may be empty).
 * @param shaved - Entries produced by the current shave run (may be empty).
 * @returns The merged superset sorted by blockMerkleRoot ASC.
 */
export function mergeManifestEntries(
  prior: ReadonlyArray<BootstrapManifestEntry>,
  shaved: ReadonlyArray<BootstrapManifestEntry>,
): Array<BootstrapManifestEntry> {
  // Build a map keyed by blockMerkleRoot. Prior wins on collision (stable identity).
  const merged = new Map<string, BootstrapManifestEntry>();
  for (const entry of prior) {
    merged.set(entry.blockMerkleRoot, entry);
  }
  for (const entry of shaved) {
    if (!merged.has(entry.blockMerkleRoot)) {
      merged.set(entry.blockMerkleRoot, entry);
    }
  }
  // Sort by blockMerkleRoot ASC for deterministic, diff-stable output.
  return [...merged.values()].sort((a, b) => a.blockMerkleRoot.localeCompare(b.blockMerkleRoot));
}

// ---------------------------------------------------------------------------
// collectSourceFiles() — shared file-walk used by both modes
// ---------------------------------------------------------------------------

function collectSourceFiles(repoRoot: string): string[] {
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
  return rawFiles.filter((f) => !shouldSkip(f)).sort();
}

// ---------------------------------------------------------------------------
// runVerify() — --verify mode implementation
//
// @decision DEC-V2-BOOTSTRAP-VERIFY-001
// @title verify mode uses :memory: registry and superset gate
// @status accepted (amended by DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001)
// @rationale Original: byte-identity gate. Amended: superset gate.
//   The committed manifest is a monotonic accumulator (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001).
//   Archived atoms (in committed, not in current shave) are EXPECTED — they came
//   from branches/PRs that were deleted after their atoms were recorded. They must
//   NOT cause a verify failure. Only atoms in the current shave that are ABSENT
//   from the committed manifest are a failure (unrecorded new atoms).
//
//   Semantics:
//     PASS  — current_shave ⊆ committed_manifest
//     PASS  — committed_manifest has strictly MORE entries (archived atoms OK)
//     FAIL  — current_shave has atom(s) NOT in committed_manifest
//             → error message names each missing root
// ---------------------------------------------------------------------------

async function runVerify(
  committedManifestPath: string,
  repoRoot: string,
  logger: Logger,
): Promise<number> {
  // Read committed manifest.
  if (!existsSync(committedManifestPath)) {
    logger.error(
      `error: committed manifest not found at ${committedManifestPath}. Run 'yakcc bootstrap' first to generate it.`,
    );
    return 1;
  }
  const committedText = readFileSync(committedManifestPath, "utf-8");

  // Collect source files (same walk as normal mode).
  const sourceFiles = collectSourceFiles(repoRoot);
  if (sourceFiles.length === 0) {
    logger.error(
      `error: no source files found under ${repoRoot}. Expected packages/*/src/**/*.ts or examples/*/src/**/*.ts.`,
    );
    return 1;
  }

  // Open a fresh :memory: registry with zero-embedding provider (DEC-V2-BOOTSTRAP-EMBEDDING-001).
  let registry: Registry;
  try {
    registry = await openRegistry(":memory:", BOOTSTRAP_EMBEDDING_OPTS);
  } catch (err) {
    logger.error(`error: failed to open in-memory registry: ${(err as Error).message}`);
    return 1;
  }

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

  // Shave all files, tracking which source path produced each merkle root.
  const rootToSource = new Map<string, string>();

  for (const absPath of sourceFiles) {
    const relPath = relative(repoRoot, absPath);
    try {
      const result = await shaveImpl(absPath, shaveRegistry, {
        offline: true,
        intentStrategy: "static",
      });
      for (const atom of result.atoms) {
        if (atom.merkleRoot !== undefined) {
          rootToSource.set(atom.merkleRoot, relPath);
        }
      }
    } catch {
      // Shave errors mean that source file produced no atoms. Do not abort.
    }
  }

  // Export the deterministic manifest from :memory: registry.
  let freshManifest: readonly BootstrapManifestEntry[];
  try {
    freshManifest = await registry.exportManifest();
  } catch (err) {
    logger.error(`error: failed to export fresh manifest: ${(err as Error).message}`);
    await registry.close();
    return 1;
  }
  await registry.close();

  // Parse the committed manifest.
  const committedManifest = JSON.parse(committedText) as BootstrapManifestEntry[];
  const committedRoots = new Set(committedManifest.map((e) => e.blockMerkleRoot));
  const freshRoots = new Set(freshManifest.map((e) => e.blockMerkleRoot));

  // Superset gate (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 part (b)):
  //   PASS  — every fresh root is already in committed (current_shave ⊆ committed)
  //   FAIL  — any fresh root is NOT in committed (unrecorded new atoms)
  //
  // Archived atoms (in committed, not in fresh) are expected and not reported.
  const unrecordedRoots: Array<{ merkleRoot: string; sourcePath: string | null }> = [...freshRoots]
    .filter((r) => !committedRoots.has(r))
    .map((r) => ({ merkleRoot: r, sourcePath: rootToSource.get(r) ?? null }));

  if (unrecordedRoots.length === 0) {
    // All current atoms are in the committed manifest — PASS.
    const archivedCount = [...committedRoots].filter((r) => !freshRoots.has(r)).length;
    if (archivedCount > 0) {
      logger.log(
        `bootstrap --verify: OK (${freshManifest.length} shaved ⊆ ${committedManifest.length} committed; ${archivedCount} archived atoms retained)`,
      );
    } else {
      logger.log(`bootstrap --verify: OK (${committedManifest.length} entries)`);
    }
    return 0;
  }

  // FAIL — current shave produced atoms not recorded in the committed manifest.
  // Name every missing root explicitly (Sacred Practice #5: loud failure).
  logger.error("bootstrap --verify: FAILED");
  logger.error(`  committed: ${committedManifestPath} (${committedManifest.length} entries)`);
  logger.error(`  shaved:    ${freshManifest.length} entries`);
  logger.error(
    `\nUnrecorded atoms (${unrecordedRoots.length} — in current shave, NOT in committed manifest):`,
  );
  logger.error("  Fix: run 'yakcc bootstrap' to record these atoms, then commit the manifest.");

  // Group by source path for readability.
  const bySource = new Map<string, string[]>();
  for (const { merkleRoot, sourcePath } of unrecordedRoots) {
    const key = sourcePath ?? "(unknown source)";
    const list = bySource.get(key) ?? [];
    list.push(merkleRoot);
    bySource.set(key, list);
  }
  for (const [sourcePath, roots] of bySource) {
    logger.error(`  ${sourcePath}:`);
    for (const root of roots) {
      logger.error(`    + ${root}`);
    }
  }

  return 1;
}

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
        "Usage: yakcc bootstrap [--registry <path>] [--manifest <path>] [--report <path>] [--verify]",
        "",
        "  Walk packages/*/src/**/*.ts and examples/*/src/**/*.ts, shave each file",
        "  offline, and additively merge results into the committed manifest.",
        "",
        "  The manifest (bootstrap/expected-roots.json) is a monotonic accumulator:",
        "  atoms from prior runs are RETAINED even if deleted from source.",
        "  CI is the sole writer — do not run 'yakcc bootstrap' manually.",
        "",
        "  --registry           <path>  Registry SQLite path (default: bootstrap/yakcc.registry.sqlite)",
        "  --manifest           <path>  Manifest path: read+write in normal mode, committed reference in --verify",
        "                               (default: bootstrap/expected-roots.json)",
        "  --report             <path>  Per-file outcome report (default: bootstrap/report.json)",
        "  --expected-failures  <path>  Expected-failures exemption list (default: bootstrap/expected-failures.json)",
        "                               Entries with matching path+errorClass are reclassified as expected-failures",
        "                               and do NOT count toward the failure total.",
        "  --verify                     Shave into :memory: registry and check current_shave ⊆ committed manifest.",
        "                               PASS if all shaved atoms are in committed (archived atoms OK).",
        "                               FAIL if any shaved atom is absent from committed (names missing roots).",
        "  -h, --help                   Print this help and exit",
      ].join("\n"),
    );
    return 0;
  }

  const manifestPath = resolve(parsed.values.manifest ?? DEFAULT_MANIFEST_PATH);

  // Resolve the repo root.
  const repoRoot = findRepoRoot(process.cwd());

  // --verify mode: delegate to runVerify() which uses :memory: and byte-compares.
  if (parsed.values.verify) {
    return runVerify(manifestPath, repoRoot, logger);
  }

  const registryPath = resolve(parsed.values.registry ?? DEFAULT_REGISTRY_PATH);
  const reportPath = resolve(parsed.values.report ?? DEFAULT_REPORT_PATH);

  // Load expected-failures exemption list (DEC-V2-BOOT-EXPECTED-FAILURES-001).
  // Resolve relative to repoRoot so the default path works regardless of cwd.
  const expectedFailuresPath = resolve(
    repoRoot,
    parsed.values["expected-failures"] ?? DEFAULT_EXPECTED_FAILURES_PATH,
  );
  let expectedFailures: readonly ExpectedFailureEntry[];
  try {
    expectedFailures = loadExpectedFailures(expectedFailuresPath);
  } catch (err) {
    logger.error(
      `error: failed to load expected-failures file at ${expectedFailuresPath}: ${(err as Error).message}`,
    );
    return 1;
  }

  // Build a lookup set keyed by "path\0errorClass" for O(1) matching.
  const expectedFailureKeys = new Map<string, ExpectedFailureEntry>();
  for (const entry of expectedFailures) {
    expectedFailureKeys.set(`${entry.path}\0${entry.errorClass}`, entry);
  }

  // Collect source files (lexicographic, DEC-V2-BOOT-FILE-ORDER-001).
  const sourceFiles = collectSourceFiles(repoRoot);

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

  // Open registry with zero-embedding provider (DEC-V2-BOOTSTRAP-EMBEDDING-001).
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, BOOTSTRAP_EMBEDDING_OPTS);
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
  const rawOutcomes: FileOutcome[] = [];

  for (const absPath of sourceFiles) {
    const relPath = relative(repoRoot, absPath);
    try {
      // Force offline: true to disable AI-corpus extraction (DEC-V2-BOOT-NO-AI-CORPUS-001).
      // TODO: when ShaveOptions gains corpusOptions.disableSourceC, use that instead.
      const result = await shaveImpl(absPath, shaveRegistry, {
        offline: true,
        intentStrategy: "static",
      });
      rawOutcomes.push({
        path: relPath,
        outcome: "success",
        atomCount: result.atoms.length,
        intentCardCount: result.intentCards.length,
      });
    } catch (err) {
      const e = err as Error;
      rawOutcomes.push({
        path: relPath,
        outcome: "failure",
        errorClass: e.constructor.name,
        errorMessage: e.message,
      });
    }
  }

  // Reclassify failures that match an expected-failures entry (DEC-V2-BOOT-EXPECTED-FAILURES-001).
  // Track which expected-failure keys were actually triggered so we can warn about untriggered ones.
  const triggeredKeys = new Set<string>();
  const outcomes: FileOutcome[] = rawOutcomes.map((o) => {
    if (o.outcome !== "failure") return o;
    const key = `${o.path}\0${o.errorClass}`;
    const entry = expectedFailureKeys.get(key);
    if (entry === undefined) return o;
    triggeredKeys.add(key);
    return {
      path: o.path,
      outcome: "expected-failure" as const,
      errorClass: o.errorClass,
      errorMessage: o.errorMessage,
      rationale: entry.rationale,
    };
  });

  // Warn about untriggered expected-failure entries (they may have been fixed or renamed).
  for (const [key, entry] of expectedFailureKeys) {
    if (!triggeredKeys.has(key)) {
      logger.log(
        `warning: expected-failure entry was not triggered — either the file was fixed, renamed, or deleted. Remove or update this entry in expected-failures.json: ${entry.path} (${entry.errorClass})`,
      );
    }
  }

  // Export the deterministic manifest from the :memory: shave run.
  let shavedManifest: readonly BootstrapManifestEntry[];
  try {
    shavedManifest = await registry.exportManifest();
  } catch (err) {
    logger.error(`error: failed to export manifest: ${(err as Error).message}`);
    await registry.close();
    return 1;
  }

  // Close registry — done with the shave-run DB.
  await registry.close();

  // --- Additive merge (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001 part (a)) ---
  // Load prior entries from the committed manifest (if it exists) and merge
  // with the shaved entries. Prior entries absent from this shave are RETAINED.
  let priorEntries: ReadonlyArray<BootstrapManifestEntry> = [];
  if (existsSync(manifestPath)) {
    try {
      const priorText = readFileSync(manifestPath, "utf-8");
      priorEntries = JSON.parse(priorText) as Array<BootstrapManifestEntry>;
    } catch (err) {
      logger.error(
        `error: failed to read prior manifest at ${manifestPath}: ${(err as Error).message}`,
      );
      return 1;
    }
  }

  const shavedEntries = shavedManifest as unknown as Array<BootstrapManifestEntry>;
  const mergedManifest = mergeManifestEntries(priorEntries, shavedEntries);

  const priorCount = priorEntries.length;
  const shavedCount = shavedEntries.length;
  const addedCount = mergedManifest.length - priorCount;
  const totalCount = mergedManifest.length;

  // Write outputs.
  writeFileSync(manifestPath, `${JSON.stringify(mergedManifest, null, 2)}\n`, "utf-8");
  writeFileSync(reportPath, `${JSON.stringify(outcomes, null, 2)}\n`, "utf-8");

  // Summarise.
  const successCount = outcomes.filter((o) => o.outcome === "success").length;
  const expectedFailureCount = outcomes.filter((o) => o.outcome === "expected-failure").length;
  const failureCount = outcomes.filter((o) => o.outcome === "failure").length;

  logger.log("Bootstrap complete:");
  logger.log(`  files processed:   ${outcomes.length}`);
  logger.log(`  successful:        ${successCount}`);
  if (expectedFailureCount > 0) {
    logger.log(`  expected-failures: ${expectedFailureCount} (license-refused, documented)`);
  }
  logger.log(`  failed:            ${failureCount}`);
  // Additive summary line (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001).
  logger.log(
    `bootstrap: prior=${priorCount}, shaved=${shavedCount}, added=${addedCount}, total=${totalCount}`,
  );
  logger.log(`  manifest:          ${manifestPath} (${totalCount} entries)`);
  logger.log(`  report:            ${reportPath}`);

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
