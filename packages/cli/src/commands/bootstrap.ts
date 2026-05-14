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
//   upstream tests + documented usage.
// Status: implemented (WI-V2-BOOTSTRAP-02)
//
// @decision DEC-BOOTSTRAP-CORPUS-OPT-001
// @title Inline offline/static-intent flags are sufficient; disableSourceC option not needed
// @status accepted
// @rationale A TODO anticipated adding ShaveOptions.corpusOptions.disableSourceC as a
//   more explicit mechanism to disable AI-derived corpus extraction. Option B (keep inline
//   flags, drop the TODO) was chosen: offline:true + intentStrategy:"static" already
//   provide the required determinism guarantee. The anticipated disableSourceC option adds
//   no safety beyond what the inline flags deliver, and introducing it would require
//   ShaveOptions API changes and consumer updates for zero practical benefit. The inline
//   mechanism is the permanent solution.
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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contractIdFromBytes } from "@yakcc/contracts";
import type {
  BootstrapManifestEntry,
  Registry,
  RegistryOptions,
  SourceFileGlueEntry,
} from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { shave as shaveImpl } from "@yakcc/shave";
import type { Logger } from "../index.js";
import { PLUMBING_INCLUDE_GLOBS, plumbingPathAllowed } from "./plumbing-globs.js";

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

// Module-level TextEncoder: reused across all per-file hash computations in
// the bootstrap loop (avoids constructing a new instance per file).
// contractIdFromBytes accepts Uint8Array; this encoder converts UTF-8 strings.
// @decision DEC-V2-SHAVE-CACHE-STORAGE-001
const TEXT_ENCODER = new TextEncoder();

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

/**
 * A file that was skipped because its content hash matched the stored value in
 * source_file_state — the file's bytes are identical to the last successful shave.
 *
 * @decision DEC-V2-SHAVE-CACHE-STORAGE-001 — source_file_state is the cache authority.
 * @decision DEC-V2-SHAVE-CACHE-VERIFY-FLAG-001 — cache hits only occur when !--verify.
 */
interface FileOutcomeCacheHit {
  readonly path: string;
  readonly outcome: "cache-hit";
  /** Number of atom occurrences already in block_occurrences for this file. */
  readonly atomCount: number;
}

type FileOutcome =
  | FileOutcomeSuccess
  | FileOutcomeFailure
  | FileOutcomeExpectedFailure
  | FileOutcomeCacheHit;

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
// captureWorkspacePlumbing — bootstrap plumbing capture pass (P2)
//
// @decision DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001
// @title Bootstrap captures plumbing files via a single named glob set
// @status decided (WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P2)
// @rationale The glob constant lives in plumbing-globs.ts (single authority).
//   This function performs the matching and calls registry.storeWorkspacePlumbing
//   for each matching file. Errors are reported loudly — never silently dropped
//   (Sacred Practice #5). Idempotent: re-running bootstrap on an existing registry
//   is a no-op for rows already present (INSERT OR IGNORE semantics).
// ---------------------------------------------------------------------------

/**
 * Expand a workspace-plumbing glob pattern to matching file paths.
 *
 * Uses simple manual expansion: splits the glob on '/' and matches
 * directory segments that contain '*' (single-segment wildcard only —
 * sufficient for the PLUMBING_INCLUDE_GLOBS patterns).
 *
 * Returns workspace-relative forward-slash paths.
 */
function expandPlumbingGlob(pattern: string, repoRoot: string): string[] {
  const segments = pattern.split("/");
  const results: string[] = [];

  function walk(segIdx: number, currentDir: string, currentRel: string): void {
    if (segIdx === segments.length) {
      // Base case: check the file exists.
      if (existsSync(currentDir) && statSync(currentDir).isFile()) {
        results.push(currentRel);
      }
      return;
    }

    const seg = segments[segIdx];
    if (seg === undefined) return;

    if (seg.includes("*")) {
      // Wildcard segment: enumerate the current directory.
      if (!existsSync(currentDir)) return;
      let entries: import("node:fs").Dirent[];
      try {
        // @decision DEC-V2-PLUMBING-WALK-DETERMINISM-001
        // @title expandPlumbingGlob sorts readdir results before walking
        // @status accepted (WI-FIX-494-TWOPASS-NONDETERM)
        // @rationale Aligns with the "sort before iterate" convention at
        //   seeds/src/seed.ts:75 and bootstrap.ts:387.  Eliminates latent
        //   platform-readdir-order risk even though registry SELECTs are
        //   ORDER BY workspace_path ASC and currently make order non-load-bearing.
        entries = (
          readdirSync(currentDir, { withFileTypes: true }) as import("node:fs").Dirent[]
        ).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      // Build a simple regex from the glob segment (* = any non-slash chars).
      const regexSrc = `^${seg.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`;
      const re = new RegExp(regexSrc);
      for (const entry of entries) {
        if (re.test(entry.name)) {
          const childAbs = join(currentDir, entry.name);
          const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
          walk(segIdx + 1, childAbs, childRel);
        }
      }
    } else {
      // Literal segment.
      const childAbs = join(currentDir, seg);
      const childRel = currentRel ? `${currentRel}/${seg}` : seg;
      walk(segIdx + 1, childAbs, childRel);
    }
  }

  walk(0, repoRoot, "");
  return results;
}

/**
 * Capture workspace plumbing files into the registry.
 *
 * Uses PLUMBING_INCLUDE_GLOBS from plumbing-globs.ts as the single authority
 * for which files constitute "workspace plumbing". Each matched file is
 * content-hashed (BLAKE3-256) and stored via registry.storeWorkspacePlumbing.
 *
 * Idempotent: INSERT OR IGNORE semantics in the registry mean re-running
 * bootstrap against an existing registry is a no-op for already-captured rows.
 *
 * @decision DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001
 *
 * @param registry  - Open registry instance (storeWorkspacePlumbing will be called).
 * @param repoRoot  - Absolute path to the workspace root.
 * @param logger    - Output sink.
 * @returns Number of plumbing files captured (new rows inserted, not no-ops).
 */
async function captureWorkspacePlumbing(
  registry: Registry,
  repoRoot: string,
  logger: Logger,
): Promise<number> {
  // Expand all inclusion globs to concrete file paths.
  const seen = new Set<string>(); // deduplicate across globs
  const candidates: string[] = [];
  for (const glob of PLUMBING_INCLUDE_GLOBS) {
    const expanded = expandPlumbingGlob(glob, repoRoot);
    for (const relPath of expanded) {
      if (!seen.has(relPath)) {
        seen.add(relPath);
        candidates.push(relPath);
      }
    }
  }

  // Filter by exclusion rules (single authority in plumbing-globs.ts).
  const toCapture = candidates.filter((p) => plumbingPathAllowed(p));

  let capturedCount = 0;
  for (const relPath of toCapture) {
    const absPath = join(repoRoot, relPath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath);
    } catch (err) {
      // File exists (was expanded) but cannot be read — loud failure.
      logger.error(
        `warning: bootstrap plumbing: cannot read ${relPath}: ${(err as Error).message}`,
      );
      continue;
    }

    const contentBytes = new Uint8Array(bytes);
    // contractIdFromBytes(bytes) = BLAKE3-256(bytes) → hex, same hash used by
    // storage.ts to verify contentHash. No direct @noble/hashes dep in @yakcc/cli
    // (sacred-practice #12: single dependency path via @yakcc/contracts).
    const contentHash: string = contractIdFromBytes(contentBytes);

    try {
      await registry.storeWorkspacePlumbing({
        workspacePath: relPath,
        contentBytes,
        contentHash,
        createdAt: Date.now(),
      });
      capturedCount++;
    } catch (err) {
      // storeWorkspacePlumbing only throws on integrity failure — loud failure.
      logger.error(
        `error: bootstrap plumbing: failed to store ${relPath}: ${(err as Error).message}`,
      );
    }
  }

  logger.log(
    `bootstrap: workspace plumbing captured — ${toCapture.length} candidates, ${capturedCount} stored`,
  );
  return capturedCount;
}

// ---------------------------------------------------------------------------
// captureSourceFileGlue — per-file glue capture pass (#333)
//
// @decision DEC-V2-GLUE-CAPTURE-AUTHORITY-001
// @title Per-file glue stored as single concatenated blob; boundaries derived
//   from DB-resident atoms for this sourceFile (not live shave stubs)
// @status decided (WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333)
// @rationale
//   Glue = all non-atom byte regions of the source file as seen by the
//   reconstruction algorithm. The reconstruction algorithm queries atoms by
//   (source_pkg, source_file) from the registry. Therefore the glue blob must
//   be the complement of those DB atoms — NOT the complement of all live shave
//   atoms.
//
//   Root cause of the original bug: live shave stubs include PointerEntry atoms
//   (already in DB from another file's first-observed-wins INSERT OR IGNORE).
//   PointerEntry stubs have merkleRoot=undefined — the slicer never propagates
//   the existing DB merkleRoot to ShavedAtomStub for pointer entries. There is
//   also no way to distinguish a PointerEntry that belongs to THIS file vs one
//   that belongs to ANOTHER file using only the stub (both have merkleRoot=undefined).
//
//   Attempting to filter stubs by merkleRoot!==undefined (novel atoms only) also
//   fails: when re-bootstrapping a file whose atoms are already in the DB, ALL
//   atoms are PointerEntries, so storedAtoms = [] and the entire file is treated
//   as glue (storing the full 14k-char source as a blob).
//
//   FIX: query registry.getAtomRangesBySourceFile(sourceFile) AFTER Pass A
//   completes (so all novel atoms for this file are in the DB). This returns
//   exactly the ranges that reconstruction will use. Glue = complement of those
//   ranges. INSERT OR IGNORE on storeBlock means each atom retains the sourceFile
//   from the first bootstrap run that stored it, which is consistent with what
//   getAtomRangesBySourceFile returns for this file.
//
//   The file is read as UTF-8 text (matching shave/src/index.ts which reads
//   with readFile(path, "utf-8")). Atom ranges are JS string character offsets
//   (not byte offsets). The glue blob is encoded as UTF-8 bytes for storage.
// ---------------------------------------------------------------------------

/**
 * Compute the concatenated glue blob for a single source file.
 *
 * Glue = regions of the file NOT covered by any atom range, concatenated in
 * source order:
 *   glue_blob = F[0..A1.start) ++ F[A1.end..A2.start) ++ ... ++ F[An.end..fileLen)
 *
 * Input ranges must be pre-sorted ascending by start (caller's responsibility).
 * Overlapping/adjacent ranges are merged before computing gaps.
 *
 * Returns null when there are no glue regions (all bytes are covered by atoms,
 * or the source string is empty). A null result means the caller should skip
 * the storeSourceFileGlue call for this file.
 *
 * @param source  - Source file content as a JS string (read with utf-8 encoding).
 * @param atomRanges - Sorted atom intervals: [{start, end}], where end = start + implSourceLength.
 *                     These must be the DB-resident ranges for this sourceFile
 *                     (from getAtomRangesBySourceFile), NOT live shave stubs.
 * @returns UTF-8-encoded glue blob, or null if there are no glue bytes.
 */
export function computeGlueBlob(
  source: string,
  atomRanges: readonly { readonly start: number; readonly end: number }[],
): Uint8Array | null {
  const encoder = new TextEncoder();

  if (atomRanges.length === 0) {
    // No atoms stored for this file — entire file is glue.
    const blob = encoder.encode(source);
    return blob.byteLength > 0 ? blob : null;
  }

  // Merge overlapping or adjacent intervals to avoid double-counting.
  // Input is pre-sorted by start (getAtomRangesBySourceFile ORDER BY source_offset ASC).
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of atomRanges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      // Extend the last interval if this one reaches further.
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }

  // Build glue spans: gaps before, between, and after atom intervals.
  const glueParts: string[] = [];

  let cursor = 0;
  for (const { start, end } of merged) {
    if (cursor < start) {
      glueParts.push(source.slice(cursor, start));
    }
    cursor = end;
  }
  // Trailing span: [lastAtom.end .. fileLen)
  if (cursor < source.length) {
    glueParts.push(source.slice(cursor));
  }

  if (glueParts.length === 0) return null;

  const glueText = glueParts.join("");
  if (glueText.length === 0) return null;

  return encoder.encode(glueText);
}

/**
 * Capture source-file glue (non-atom regions) for a single source file.
 *
 * Reads the file, computes the glue blob from DB-resident atom ranges for this
 * sourceFile, and stores it via registry.storeSourceFileGlue. No-ops when the
 * file has no glue bytes (all content is covered by atoms for this file).
 *
 * Must be called AFTER Pass A (atom persistence) so getAtomRangesBySourceFile
 * reflects all atoms stored with sourceFile = this file.
 *
 * @decision DEC-V2-GLUE-CAPTURE-AUTHORITY-001
 *
 * @param registry  - Open registry instance.
 * @param absPath   - Absolute path to the source file (for fs.readFileSync).
 * @param sourcePkg - Workspace package dir (e.g. 'packages/cli').
 * @param sourceFile - Workspace-relative path (e.g. 'packages/cli/src/commands/foo.ts').
 * @param logger    - Output sink.
 * @returns true if a glue row was stored, false if skipped (no glue bytes).
 */
async function captureSourceFileGlue(
  registry: Registry,
  absPath: string,
  sourcePkg: string,
  sourceFile: string,
  logger: Logger,
): Promise<boolean> {
  // Read the source file content (UTF-8 string, matching shave pipeline).
  let source: string;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    logger.error(
      `warning: bootstrap glue: cannot read ${sourceFile} for glue capture: ${(err as Error).message}`,
    );
    return false;
  }

  // Query DB for atom ranges stored with this sourceFile.
  // This is the authoritative source — it matches what reconstruction will use.
  let atomRanges: readonly { readonly sourceOffset: number; readonly implSourceLength: number }[];
  try {
    atomRanges = await registry.getAtomRangesBySourceFile(sourceFile);
  } catch (err) {
    logger.error(
      `warning: bootstrap glue: cannot query atom ranges for ${sourceFile}: ${(err as Error).message}`,
    );
    return false;
  }

  // Convert to {start, end} format for computeGlueBlob.
  // Already sorted ascending by sourceOffset (getAtomRangesBySourceFile ORDER BY source_offset ASC).
  const ranges = atomRanges.map((r) => ({
    start: r.sourceOffset,
    end: r.sourceOffset + r.implSourceLength,
  }));

  const glueBlob = computeGlueBlob(source, ranges);
  if (glueBlob === null) {
    // No glue bytes — all content is atoms. Skip silently.
    return false;
  }

  const contentHash: string = contractIdFromBytes(glueBlob);

  const entry: SourceFileGlueEntry = {
    sourcePkg,
    sourceFile,
    contentHash,
    contentBlob: glueBlob,
    createdAt: Date.now(),
  };

  try {
    await registry.storeSourceFileGlue(entry);
    return true;
  } catch (err) {
    logger.error(
      `error: bootstrap glue: failed to store glue for ${sourceFile}: ${(err as Error).message}`,
    );
    return false;
  }
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
  //
  // @decision DEC-V2-OCCURRENCE-DELETE-INSERT-001
  // storeBlock is wrapped (not bound) so the bootstrap can intercept each novel
  // atom's (blockMerkleRoot, sourceOffset, length) for block_occurrences storage.
  // The wrapper captures occurrences into a per-file mutable array that is drained
  // after shave() returns and before captureSourceFileGlue() runs.
  //
  // Novel atoms are captured here. PointerEntry atoms (already in the DB) are
  // resolved after shave by reading stub.merkleRoot directly — shave() now
  // propagates PointerEntry.merkleRoot to ShavedAtomStub (DEC-SHAVE-POINTER-MERKLROOT-PROPAGATION-001).
  // This ensures block_occurrences reflects the current-truth offsets for ALL atoms
  // in the file, regardless of whether they are novel or pre-existing in the DB.
  //
  // @decision DEC-V2-STORAGE-IDEMPOTENT-RECOMPILE-001

  // Per-file occurrence accumulator. Populated by the storeBlock wrapper below
  // and by the PointerEntry resolution pass after shave. Drained per file.
  type OccurrenceRecord = {
    sourcePkg: string;
    sourceFile: string;
    sourceOffset: number;
    length: number;
    blockMerkleRoot: string;
  };
  let perFileOccurrences: OccurrenceRecord[] = [];

  const shaveRegistry = {
    selectBlocks: (specHash: Parameters<typeof registry.selectBlocks>[0]) =>
      registry.selectBlocks(specHash),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
    storeBlock: async (row: Parameters<typeof registry.storeBlock>[0]): Promise<void> => {
      // Forward the store to the real registry first.
      await registry.storeBlock(row);
      // Capture the occurrence if sourceContext provenance is present.
      // sourceOffset is set per-atom inside shave() from entry.sourceRange.start.
      // Both sourceOffset and length are JS string character counts (not byte counts) —
      // the glue/reconstruct algorithms use source.slice() which is character-based.
      if (row.sourceFile != null && row.sourcePkg != null && row.sourceOffset != null) {
        perFileOccurrences.push({
          sourcePkg: row.sourcePkg,
          sourceFile: row.sourceFile,
          sourceOffset: row.sourceOffset,
          length: row.implSource.length, // character count, not byte count
          blockMerkleRoot: row.blockMerkleRoot,
        });
      }
    },
  };

  // Process each file.
  const rawOutcomes: FileOutcome[] = [];

  for (const absPath of sourceFiles) {
    const relPath = relative(repoRoot, absPath);
    try {
      // Compute source provenance context for registry storage.
      // sourcePkg: the package directory (e.g. 'packages/cli'), derived from the
      //   workspace-relative path by taking the first two segments (topDir/pkgName).
      // sourceFile: the full workspace-relative path (e.g. 'packages/cli/src/commands/foo.ts').
      // sourceOffset: computed per-atom from entry.sourceRange.start in shave() internals.
      // @decision DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001
      const relSegments = relPath.replace(/\\/g, "/").split("/");
      // relPath format: "packages/<pkg>/src/..." or "examples/<pkg>/src/..."
      // sourcePkg is the first two segments (e.g. "packages/cli").
      const sourcePkg =
        relSegments.length >= 2 ? `${relSegments[0]}/${relSegments[1]}` : (relSegments[0] ?? "");

      // Reset per-file occurrence accumulator before shave.
      perFileOccurrences = [];

      // Force offline: true to disable AI-corpus extraction (DEC-V2-BOOT-NO-AI-CORPUS-001).
      // @decision DEC-BOOTSTRAP-CORPUS-OPT-001 — inline flags are the permanent solution.
      const sourceFileNorm = relPath.replace(/\\/g, "/");
      // Read source text for exact-match comparison in the pointer stub pass below.
      // Canonical-AST matching can unify atoms from different files whose textual
      // representations differ (e.g. variable names). When recording pointer
      // occurrences, we skip atoms whose stored impl_source doesn't match the
      // actual source text at that position — those spans are better captured as
      // glue so that reconstruction emits the correct verbatim text.
      // DEC-V2-POINTER-OCCURRENCE-LENGTH-001
      const sourceText = readFileSync(absPath, "utf-8");

      // ---------------------------------------------------------------------------
      // Cache-check (issue #363 / DEC-V2-SHAVE-CACHE-STORAGE-001)
      //
      // Compute BLAKE3-256 of the source file's UTF-8 bytes.  The hash is computed
      // AFTER readFileSync above — both the cache check and the subsequent shave
      // operate on the same in-memory string, so there is no TOCTOU race.
      //
      // fileContentHash is hoisted outside the if-block so it is available after
      // a successful shave to write back to source_file_state (cache miss write).
      //
      // @decision DEC-V2-SHAVE-CACHE-VERIFY-FLAG-001
      //   --verify bypasses the cache entirely; the guard is here so that future
      //   refactors cannot accidentally cache under --verify.  Today --verify uses
      //   a :memory: registry and never reaches this path; the guard is forward-safety.
      //
      // @decision DEC-V2-SHAVE-CACHE-STORAGE-001
      //   Cache key = BLAKE3-256 hex of UTF-8 bytes.  NOT mtime/size/ctime.
      //   The single call site contract: exactly one getSourceFileContentHash() call
      //   per source file per bootstrap run (evaluation contract RP-3 / forbidden shortcut).
      // ---------------------------------------------------------------------------
      const fileContentHash = contractIdFromBytes(TEXT_ENCODER.encode(sourceText));
      if (!parsed.values.verify) {
        const storedHash = await registry.getSourceFileContentHash(sourcePkg, sourceFileNorm);

        if (storedHash === fileContentHash) {
          // Cache hit: byte-identical to last shave — skip full shave.
          // Atoms are already in blocks + block_occurrences from the prior run.
          const occurrences = await registry.listOccurrencesBySourceFile(sourceFileNorm);
          rawOutcomes.push({
            path: relPath,
            outcome: "cache-hit",
            atomCount: occurrences.length,
          });
          continue;
        }
        // Cache miss: fall through to full shave below.
        // After a successful shave, storeSourceFileContentHash is called to record
        // the current hash so the next run can cache-hit this file.
      }

      const result = await shaveImpl(absPath, shaveRegistry, {
        offline: true,
        intentStrategy: "static",
        sourceContext: {
          sourcePkg,
          sourceFile: sourceFileNorm,
          // sourceOffset is null at the ShaveOptions level — per-atom offsets are
          // derived from entry.sourceRange.start inside shave() and forwarded into
          // PersistOptions.sourceContext.sourceOffset per novel-glue entry.
          sourceOffset: null,
        },
      });

      // Pass A (occurrence resolution): after shave, resolve PointerEntry atom
      // occurrences that were not captured by the storeBlock interceptor.
      //
      // @decision DEC-V2-OCCURRENCE-DELETE-INSERT-001
      // Novel atoms are already in perFileOccurrences (captured by storeBlock wrapper above).
      // PointerEntry atoms (result.atoms entries with stub.merkleRoot !== undefined, set
      // by shave/src/index.ts DEC-SHAVE-POINTER-MERKLROOT-PROPAGATION-001) were matched
      // from the DB and NOT passed through storeBlock — their new sourceOffset is
      // known (stub.sourceRange.start) and their blockMerkleRoot is now directly
      // available via stub.merkleRoot.
      //
      // Previous approach: re-derive blockMerkleRoot via canonicalAstHash(source, range)
      // → findByCanonicalAstHash(). This failed for type-only declarations and export
      // statements because canonicalAstHash throws CanonicalAstParseError when the
      // source range spans multiple AST nodes (e.g. `export type { A, B, C }`). Files
      // like universalize/types.ts (100% type-only) had 0/N occurrences stored.
      //
      // Current approach: read stub.merkleRoot directly. shave() now propagates
      // entry.merkleRoot from PointerEntry to ShavedAtomStub, so no re-derivation
      // is needed. The block's implSource.length is still fetched from the registry
      // to record the correct occurrence length (character count).
      //
      // Deduplication: storeBlock (novel atoms) and this pointer pass must not
      // both record an occurrence for the same source offset. Build a set of
      // already-captured offsets from perFileOccurrences before iterating stubs.
      // A stub whose offset is already captured is a novel atom — skip it here.
      const capturedOffsets = new Set(perFileOccurrences.map((o) => o.sourceOffset));
      const pointerStubs = result.atoms.filter(
        (stub) => stub.merkleRoot !== undefined && !capturedOffsets.has(stub.sourceRange.start),
      );
      for (const stub of pointerStubs) {
        const merkleRoot = stub.merkleRoot;
        // merkleRoot is guaranteed non-undefined by the filter above, but the
        // TypeScript type is BlockMerkleRoot|undefined, so we guard explicitly.
        if (merkleRoot === undefined) continue;
        // @decision DEC-V2-POINTER-OCCURRENCE-LENGTH-001
        // @title Pointer stub occurrence: skip when impl_source text doesn't match actual source
        // @status active
        // @rationale
        //   Canonical-AST matching can unify atoms from different files whose textual
        //   representation differs (e.g. `const encoder = new TextEncoder()` in one file
        //   vs `const TEXT_ENCODER = new TextEncoder()` in another). These atoms share
        //   the same blockMerkleRoot because they normalize to the same canonical AST.
        //
        //   Problem: if we record an occurrence for the `TEXT_ENCODER` span using
        //   the shared block (impl_source = "const encoder = ..."), reconstruction
        //   will emit "const encoder = ..." instead of "const TEXT_ENCODER = ...",
        //   breaking byte-identity. Worse, the glue computation excludes the atom span,
        //   so the original "TEXT_ENCODER" text is lost from both the atom block AND
        //   the glue blob — reconstruction cannot recover it.
        //
        //   Fix: compare the actual source text at the stub's span with the block's
        //   impl_source. When they differ, skip the occurrence record. The span then
        //   falls entirely into glue (computeGlueBlob includes it), and reconstruction
        //   emits the correct verbatim text from the glue blob.
        //
        //   When they match (most pointer atoms), record the occurrence using the
        //   actual span length (stub.sourceRange.end - stub.sourceRange.start) so the
        //   glue cursor advances by the correct character count.
        {
          const block = await registry.getBlock(merkleRoot);
          if (block === null) {
            logger.error(
              `warning: bootstrap occurrence: block not found for pointer stub in ${sourceFileNorm} range=[${stub.sourceRange.start},${stub.sourceRange.end}] merkleRoot=${merkleRoot} — occurrence skipped`,
            );
            continue;
          }
          const actualSpan = sourceText.slice(stub.sourceRange.start, stub.sourceRange.end);
          if (actualSpan !== block.implSource) {
            // Text mismatch: the canonical-AST match unified two structurally equivalent
            // but textually different atoms. Skip the occurrence; the span falls into glue
            // and the verbatim original text is preserved for reconstruction.
            continue;
          }
          perFileOccurrences.push({
            sourcePkg,
            sourceFile: sourceFileNorm,
            sourceOffset: stub.sourceRange.start,
            // Actual character span in THIS file.
            length: stub.sourceRange.end - stub.sourceRange.start,
            blockMerkleRoot: merkleRoot,
          });
        }
      }

      // Deduplicate perFileOccurrences by sourceOffset before storing.
      //
      // The slicer can produce multiple stubs at the same sourceRange.start when
      // overlapping slice plan entries share a start position (e.g. nested blocks or
      // adjacent atoms with identical starts). Inserting two rows at the same
      // (source_pkg, source_file, source_offset) violates the block_occurrences PK.
      // Strategy: keep the LAST entry for each offset (stub order from result.atoms
      // is stable, so "last wins" is deterministic). Using a Map preserves insertion
      // order and overwrites earlier duplicates.
      {
        const deduped = new Map<number, (typeof perFileOccurrences)[number]>();
        for (const occ of perFileOccurrences) {
          deduped.set(occ.sourceOffset, occ);
        }
        perFileOccurrences = [...deduped.values()];
      }

      // Pass A (occurrence store): atomically replace per-file occurrences in block_occurrences.
      //
      // @decision DEC-V2-OCCURRENCE-DELETE-INSERT-001
      // @decision DEC-V2-STORAGE-IDEMPOTENT-RECOMPILE-001
      // All atom occurrences for this file (both novel and pointer-resolved) are now
      // in perFileOccurrences. replaceSourceFileOccurrences atomically deletes the
      // prior set and inserts the fresh set inside one SQLite transaction.
      // On failure: prior occurrences remain intact (transaction rollback).
      try {
        await registry.replaceSourceFileOccurrences(sourcePkg, sourceFileNorm, perFileOccurrences);
      } catch (err) {
        logger.error(
          `error: bootstrap occurrence: replaceSourceFileOccurrences failed for ${sourceFileNorm}: ${(err as Error).message}`,
        );
        // Non-fatal: log and continue. getAtomRangesBySourceFile will return an
        // empty set for this file (no occurrences stored), and glue capture will
        // store the full file as glue — reconstruction will be degraded but safe.
      }

      // Pass B: capture per-file glue (non-atom regions) into source_file_glue.
      // Queries DB for atoms stored with sourceFile = sourceFileNorm via
      // getAtomRangesBySourceFile — which now reads from block_occurrences
      // (DEC-V2-STORAGE-IDEMPOTENT-RECOMPILE-001 / DEC-V2-GLUE-CAPTURE-AUTHORITY-001).
      // Must run after Pass A so novel atoms and occurrences are committed first.
      // Errors are logged but do not fail the file outcome.
      await captureSourceFileGlue(registry, absPath, sourcePkg, sourceFileNorm, logger);

      // Pass C: cache-miss write — record the file's content hash in source_file_state
      // so the next bootstrap run can cache-hit this file if its bytes are unchanged.
      //
      // Only written on the on-disk (non-verify) path. --verify uses :memory: and
      // the guard below is the explicit forward-safety check.
      //
      // Non-fatal: a write failure means the cache row is missing and the next run
      // will re-shave this file (correct, just slightly slower). F1 failure mode per plan.
      //
      // @decision DEC-V2-SHAVE-CACHE-STORAGE-001
      // @decision DEC-V2-SHAVE-CACHE-VERIFY-FLAG-001
      if (!parsed.values.verify) {
        try {
          await registry.storeSourceFileContentHash(sourcePkg, sourceFileNorm, fileContentHash);
        } catch (cacheWriteErr) {
          logger.error(
            `warning: failed to write source_file_state for ${sourceFileNorm} (next run will re-shave): ${(cacheWriteErr as Error).message}`,
          );
        }
      }

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

  // Capture workspace plumbing files into the registry (P2).
  // Runs after the shave loop so all atoms are already persisted.
  // Ordering is not required by the schema FK, but mirrors logical dependency.
  //
  // @decision DEC-V2-WORKSPACE-PLUMBING-CAPTURE-001
  try {
    await captureWorkspacePlumbing(registry, repoRoot, logger);
  } catch (err) {
    logger.error(`error: workspace plumbing capture failed: ${(err as Error).message}`);
    await registry.close();
    return 1;
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
  const cacheHitCount = outcomes.filter((o) => o.outcome === "cache-hit").length;
  const expectedFailureCount = outcomes.filter((o) => o.outcome === "expected-failure").length;
  const failureCount = outcomes.filter((o) => o.outcome === "failure").length;

  logger.log("Bootstrap complete:");
  logger.log(`  files processed:   ${outcomes.length}`);
  logger.log(`  cache hits:        ${cacheHitCount}`);
  logger.log(`  shaved:            ${successCount}`);
  if (expectedFailureCount > 0) {
    logger.log(`  expected-failures: ${expectedFailureCount} (license-refused, documented)`);
  }
  logger.log(`  failed:            ${failureCount}`);
  // Additive summary line (DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001).
  logger.log(
    `bootstrap: prior=${priorCount}, shaved=${shavedCount}, added=${addedCount}, total=${totalCount}`,
  );
  // Cache summary line (issue #363 / DEC-V2-SHAVE-CACHE-STORAGE-001).
  logger.log(`bootstrap: cache_hits=${cacheHitCount}, shaved=${successCount}`);
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
