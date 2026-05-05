// SPDX-License-Identifier: MIT
// corpus-loader.ts — Wave-3 closer corpus loader: shave-walk over packages/*/src/**/*.ts.
//
// @decision DEC-V1-WAVE-3-WASM-DEMO-CORPUS-LOADER-001
// @title Corpus is regenerated via shave() walk over packages/*/src/**/*.ts
// @status decided (WI-V1W3-WASM-LOWER-11, d-real path; CURATED_SUBSTRATES pivot rejected by user)
// @rationale
//   d-real path: regenerate the corpus in-test via shave() walk over production source.
//   This is the honest form of the graduation gate:
//
//   1. The corpus denominator IS the real production source atoms, not curated substrates.
//      The 80% gate reflects real lowering coverage over the real yakcc atom surface.
//
//   2. Prior implementer round pivoted to CURATED_SUBSTRATES (6 hand-crafted atoms) after
//      discovering that ~99/100 production atoms fail lowering (~1% coverage). User
//      adjudication rejected that pivot: the 80% gate is a FORCING FUNCTION, not a
//      metric to satisfy cheaply. The pending-atoms.json registry absorbs all failing
//      atoms with categorized LoweringError reasons, giving future WI-V1W4-LOWER-EXTEND-*
//      implementers actionable signals to grow the lowering surface toward 80%.
//
//   3. Performance: shave() with { offline: true, intentStrategy: "static" } does
//      NOT call the Anthropic API. It still parses ASTs and runs decompose/slice
//      over each file. The corpus regen pass is wrapped in a 30-minute beforeAll
//      budget — acceptable for a graduation harness, not for a hot-path test.
//      Future optimization (out of scope): source-file content-hash cache.
//      See WI-V1W4-LOWER-PARITY-CACHE-001 in the follow-up WIs.
//
//   4. The CURATED_SUBSTRATES pivot is permanently rejected. Do NOT restore it.
//      If a future implementer needs the curated atoms for a different purpose,
//      create a new file — do not resurface the curated table in THIS loader.
//
//   FUTURE IMPLEMENTERS: as WI-V1W4-LOWER-EXTEND-* items land and the lowering
//   surface grows, atoms in pending-atoms.json that are now lowerable should be
//   removed from pending. The 80% gate will naturally go green once enough atoms
//   are covered. At that point, remove `it.fails` from the gate in
//   closer-parity.test.ts (see the comment above that assertion).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRegistry } from "@yakcc/registry";
import type { RegistryOptions } from "@yakcc/registry";
import { shave } from "@yakcc/shave";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// @decision DEC-V1-WAVE-3-WASM-DEMO-PENDING-001
// @title Pending-atoms registry schema: canonicalAstHash + sourcePath + reason + category
// @status decided (WI-V1W3-WASM-LOWER-11)
// @rationale
//   Each pending atom must carry a human-readable reason (>=10 chars) and a
//   machine-readable category that classifies WHY it cannot be covered. This
//   makes the pending list auditable and gives future implementers actionable
//   signals (e.g. "add array-of-string support to unlock these 42 atoms").
//
//   Category semantics:
//   - 'lowering-error': wasmBackend().emit() throws LoweringError during emit.
//     The WASM backend cannot yet lower this atom's AST constructs.
//   - 'unsupported-host': atom requires a host import not in the WASM host contract.
//   - 'unsupported-runtime-closure': atom returns or captures a closure value at
//     runtime in a way that cannot be statically resolved at lowering time.
//   - 'no-input-arbitrary': atom source is recoverable and compiles but no
//     fast-check Arbitrary exists for the input types (e.g., complex callback params).
//   - 'no-export-found': atom source is recoverable but contains no exported function
//     that the WASM backend can target.
//   - 'other': catch-all. A new DEC is required before adding new categories.
export interface PendingAtom {
  readonly canonicalAstHash: string;
  /** Absolute path to the source file, or null when source was not recovered. */
  readonly sourcePath: string | null;
  /** Human-readable reason >=10 characters explaining why this atom is pending. */
  readonly reason: string;
  readonly category:
    | "lowering-error"
    | "unsupported-host"
    | "unsupported-runtime-closure"
    | "no-input-arbitrary"
    | "no-export-found"
    | "other";
}

/** One atom entry in the regenerated corpus. */
export interface CorpusAtom {
  /** Canonical AST hash — the stable identity for this atom. */
  readonly canonicalAstHash: string;
  /** The impl.ts source text for this atom. */
  readonly implSource: string;
  /** Absolute path to the source file that produced this atom. */
  readonly sourcePath: string;
  /** BlockMerkleRoot as stored in the in-memory registry. */
  readonly blockMerkleRoot: string;
  /** P-bucket classification: all shave-walk atoms are P-OTHER (dynamic classification
   *  deferred — see WI-V1W4-LOWER-CLASSIFY-001). */
  readonly pBucket: "P1a" | "P1b" | "P1c" | "P2" | "P3" | "P4" | "P5" | "P-OTHER";
}

/** The full regenerated corpus: one entry per unique canonicalAstHash. */
export interface RegeneratedCorpus {
  /** Map from canonicalAstHash to CorpusAtom. Only unique hashes are present. */
  readonly atoms: ReadonlyMap<string, CorpusAtom>;
  /** Total unique atoms in the corpus. */
  readonly size: number;
  /** How many source files were walked. */
  readonly filesWalked: number;
  /** How many files failed to shave (shave() threw or returned zero atoms). */
  readonly shaveFailures: number;
}

// ---------------------------------------------------------------------------
// Bootstrap-mode embedding provider — deterministic zeros, no network access
//
// Mirrors DEC-V2-BOOTSTRAP-EMBEDDING-001 from bootstrap.ts:
//   exportManifest() and getBlock() do not read the embeddings table.
//   Zero vectors satisfy the registry column constraint without network deps.
// ---------------------------------------------------------------------------

const BOOTSTRAP_EMBEDDING_OPTS: RegistryOptions = {
  embeddings: {
    dimension: 384,
    modelId: "bootstrap/null-zero",
    embed: (_text: string): Promise<Float32Array> => Promise.resolve(new Float32Array(384)),
  },
};

// ---------------------------------------------------------------------------
// File-walking helpers (mirrors bootstrap.ts shouldSkip / walkTs)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts files under dir.
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
 * Determine if a file should be excluded from the corpus walk.
 * Exclusion rules mirror bootstrap.ts (DEC-V2-BOOT-CLI-001):
 *   - *.test.ts, *.props.test.ts, *.bench.ts, *.d.ts, vitest.config.ts
 *   - __tests__/, __fixtures__/, __snapshots__/, node_modules/, dist/ directories
 */
function shouldSkip(absPath: string): boolean {
  const basename = absPath.split(/[\\/]/).pop() ?? "";

  // Skip by filename
  if (basename.endsWith(".test.ts")) return true;
  if (basename.endsWith(".bench.ts")) return true;
  if (basename.endsWith(".d.ts")) return true;
  if (basename === "vitest.config.ts") return true;

  // Skip by directory segment — normalize to forward slashes
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized.includes("/__tests__/")) return true;
  if (normalized.includes("/__fixtures__/")) return true;
  if (normalized.includes("/__snapshots__/")) return true;
  if (normalized.includes("/node_modules/")) return true;
  if (normalized.includes("/dist/")) return true;

  return false;
}

/**
 * Resolve the monorepo root from a known path (walk up to find pnpm-workspace.yaml).
 * Starts from thisFilePath's directory and walks up.
 */
function findRepoRoot(startPath: string): string {
  let dir = startPath;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return startPath;
}

// ---------------------------------------------------------------------------
// Corpus regeneration via shave-walk
// @decision DEC-V1-WAVE-3-WASM-DEMO-CORPUS-LOADER-001 (see file header)
//
// Design choice: we persist pending-atoms.json on EVERY run (simpler, file
// churn is acceptable for a graduation harness). The test reads back the
// on-disk list and validates partition completeness against the runtime-built
// set. If the test runner and the harness diverge (e.g. a new source file was
// added), the test will catch it on the next run and regenerate the file.
//
// Alternative (compare runtime vs on-disk and fail on divergence) was
// considered but adds complexity without meaningful benefit — the simpler
// "always update on disk" approach is correct for a graduation harness that
// is explicitly expected to run slowly and write files.
// ---------------------------------------------------------------------------

/**
 * Regenerate the corpus from the current source tree via shave().
 *
 * Opens ONE in-memory registry, zero-embedding opts (no network).
 * Walks packages-star-src/**\/**.ts (same exclusions as bootstrap.ts).
 * Shaves each file against the shared registry, opts: offline=true, intentStrategy=static.
 * After all files, enumerates blocks via exportManifest() + getBlock().
 * Returns a RegeneratedCorpus keyed by canonicalAstHash (first-occurrence dedup).
 *
 * Performance note: shave() using static strategy still parses ASTs and runs
 * decompose/slice. On the ~93-file production source, this takes several minutes.
 * The beforeAll budget in closer-parity.test.ts is 30 minutes.
 * Future optimization: source-file content-hash cache (WI-V1W4-LOWER-PARITY-CACHE-001).
 */
export async function regenerateCorpus(): Promise<RegeneratedCorpus> {
  // Locate the repo root relative to this file's location at runtime.
  // __dirname equivalent via import.meta.url is handled by the caller (test file uses fileURLToPath).
  // Here we resolve from process.cwd() which in vitest is the package root.
  const repoRoot = findRepoRoot(process.cwd());

  // Open ONE in-memory registry shared across all shave() calls.
  const registry = await openRegistry(":memory:", BOOTSTRAP_EMBEDDING_OPTS);

  // Build ShaveRegistryView adapter (Registry.getBlock returns null; ShaveRegistryView expects undefined).
  const shaveRegistry = {
    selectBlocks: registry.selectBlocks.bind(registry),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
    storeBlock: registry.storeBlock?.bind(registry),
  };

  // Walk packages/*/src/**/*.ts
  const packagesDir = join(repoRoot, "packages");
  let filesWalked = 0;
  let shaveFailures = 0;

  if (existsSync(packagesDir)) {
    const pkgDirs = readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(packagesDir, e.name, "src"))
      .sort(); // lexicographic order for determinism (DEC-V2-BOOT-FILE-ORDER-001)

    for (const srcDir of pkgDirs) {
      const rawFiles: string[] = [];
      walkTs(srcDir, rawFiles);
      const files = rawFiles.filter((f) => !shouldSkip(f)).sort();

      for (const absPath of files) {
        filesWalked++;
        try {
          await shave(absPath, shaveRegistry, { offline: true, intentStrategy: "static" });
        } catch {
          // Shave failures (LicenseRefusedError, OfflineCacheMissError, etc.) are
          // counted but do not abort the walk — partial corpus is better than no corpus.
          shaveFailures++;
        }
      }
    }
  }

  // Enumerate all stored blocks via exportManifest() + getBlock() for implSource.
  const manifestEntries = await registry.exportManifest();

  // Build the corpus map keyed by canonicalAstHash (first occurrence wins for dedup).
  // BootstrapManifestEntry does NOT include implSource — we must fetch each block.
  const atoms = new Map<string, CorpusAtom>();

  for (const entry of manifestEntries) {
    // Deduplicate by canonicalAstHash: skip if we've already seen this canonical AST.
    if (atoms.has(entry.canonicalAstHash)) continue;

    // Fetch the full block row to get implSource and sourcePath.
    const block = await registry.getBlock(entry.blockMerkleRoot);
    if (block === null) continue; // should not happen; guard anyway

    atoms.set(entry.canonicalAstHash, {
      canonicalAstHash: entry.canonicalAstHash,
      implSource: block.implSource,
      // sourcePath is not stored in the registry — we label it with the block merkle root
      // so error messages are traceable. Future: thread sourcePath through shave() atoms
      // and store it in the registry (WI-V1W4-LOWER-CORPUS-PROVENANCE-001).
      sourcePath: `registry:${entry.blockMerkleRoot.slice(0, 16)}`,
      blockMerkleRoot: entry.blockMerkleRoot,
      pBucket: "P-OTHER",
    });
  }

  await registry.close();

  return {
    atoms,
    size: atoms.size,
    filesWalked,
    shaveFailures,
  };
}

// ---------------------------------------------------------------------------
// Pending-atoms I/O
// ---------------------------------------------------------------------------

/**
 * Read the pending-atoms.json registry.
 * Returns an empty array if the file does not exist (first run).
 */
export function loadPendingAtoms(pendingPath: string): PendingAtom[] {
  try {
    const raw = readFileSync(pendingPath, "utf-8");
    return JSON.parse(raw) as PendingAtom[];
  } catch {
    return [];
  }
}

/**
 * Write the pending-atoms.json registry (replaces the file in-place).
 */
export function writePendingAtoms(pendingPath: string, pendingAtoms: PendingAtom[]): void {
  writeFileSync(pendingPath, JSON.stringify(pendingAtoms, null, 2));
}
