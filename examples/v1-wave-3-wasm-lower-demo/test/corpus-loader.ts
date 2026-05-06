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
//      A source-file content-hash cache (shave-cache.json) accelerates warm runs:
//      on a warm cache, previously-shaved files skip the shave() call entirely and
//      replay stored BlockTripletRows into the in-memory registry. See
//      WI-V1W4-LOWER-PARITY-CACHE-001 — implemented in this file.
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

// @decision DEC-V1-WAVE-4-WASM-PARITY-CACHE-001
// @title Content-hash-keyed shave cache for corpus regeneration warm runs
// @status decided (WI-V1W4-LOWER-PARITY-CACHE-001)
// @rationale
//   The corpus regeneration walk over all packages/*/src/**/*.ts runs shave()
//   on each file. shave() parses ASTs, runs decompose/slice, and (in offline
//   mode) still takes non-trivial CPU per file. A prior implementer reported
//   ~150s/file (unverified empirically by this WI — see the it.skip profile
//   test in cache.test.ts for an ad-hoc capture affordance).
//
//   Cache key: sourceHash(content) from @yakcc/shave — BLAKE3-256 of normalized
//   source. ONLY content changes bust the cache. mtime and absPath are
//   intentionally excluded: a file moved to a new location with identical
//   content is a cache hit; a file with the same mtime but different content
//   (unlikely but possible) is a miss (BLAKE3 collision probability < 2^-128).
//
//   shaveVersionHash: BLAKE3(STATIC_MODEL_TAG || "\x00" || STATIC_PROMPT_VERSION)
//   keyed via sourceHash() for uniformity. A shave algorithm upgrade that
//   changes these constants busts the entire cache deterministically — no
//   manual cache invalidation needed.
//
//   BlockTripletRow.createdAt is stripped to 0 on write so the committed cache
//   file is byte-stable across regenerations on different machines and times.
//
//   The cold/warm wall-clock speed improvement is deferred for empirical
//   measurement (see WI scope notes). Cache correctness is verifiable via the
//   unit tests in cache.test.ts without running the full corpus walk.

// @decision DEC-V1-WAVE-4-WASM-PARITY-CACHE-FORMAT-001
// @title shave-cache.json schema: formatVersion + shaveVersionHash + entries
// @status decided (WI-V1W4-LOWER-PARITY-CACHE-001)
// @rationale
//   Schema: { formatVersion: 1, shaveVersionHash: string, entries: Record<contentHash, CacheEntry[]> }
//   - formatVersion (integer): bumped when the schema changes incompatibly. Cache
//     files with an unknown formatVersion are treated as corrupt (warn + empty).
//   - shaveVersionHash (hex string): BLAKE3 of shave algorithm version tag. A
//     mismatch means the shave algorithm changed; the entire cache is stale and
//     must be rebuilt. Treated as corrupt/version-mismatch → warn + empty.
//   - entries: map from contentHash (sourceHash of raw file content) to array of
//     BlockTripletRows (createdAt=0, artifacts serialized as [[key, hexBytes]]
//     pairs for JSON round-trip safety since Map is not JSON-serializable).
//   Sorted keys in JSON output for byte-stable diffs in git.

// @decision DEC-V1-WAVE-4-WASM-PARITY-CACHE-PROFILE-001
// @title Profiling affordance only — wall-clock numbers unverified empirically
// @status decided (WI-V1W4-LOWER-PARITY-CACHE-001)
// @rationale
//   A prior implementer claimed ~150s/file for shave() on production source.
//   This figure was not verified empirically by WI-V1W4-LOWER-PARITY-CACHE-001:
//   running the full corpus walk takes hours in cold mode, which exceeds the
//   WI dispatch budget. An it.skip("profile: shave wall-clock per file") test
//   in cache.test.ts provides an ad-hoc profiling affordance — future implementers
//   can flip .skip to capture real numbers without rebuilding the test harness.
//   The cache architecture ships either way: content-hash caching is the correct
//   architecture regardless of the exact per-file wall-clock figure.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, RegistryOptions } from "@yakcc/registry";
import { STATIC_MODEL_TAG, STATIC_PROMPT_VERSION, shave, sourceHash } from "@yakcc/shave";

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
  /** How many files were served from the cache (warm hits). */
  readonly cacheHits: number;
  /** How many files required a live shave() call (cache misses). */
  readonly cacheMisses: number;
}

// ---------------------------------------------------------------------------
// Cache types (DEC-V1-WAVE-4-WASM-PARITY-CACHE-FORMAT-001)
// ---------------------------------------------------------------------------

/**
 * Serialized representation of a BlockTripletRow for JSON storage.
 * artifacts (Map<string,Uint8Array>) is stored as [key, hexBytes][] pairs.
 * createdAt is always 0 to ensure byte-stable committed cache files.
 */
export interface CachedBlockRow {
  readonly blockMerkleRoot: string;
  readonly specHash: string;
  readonly specCanonicalBytes: string; // hex
  readonly implSource: string;
  readonly proofManifestJson: string;
  readonly level: "L0" | "L1" | "L2" | "L3";
  readonly createdAt: 0;
  readonly canonicalAstHash: string;
  readonly parentBlockRoot?: string | null;
  readonly artifacts: ReadonlyArray<readonly [string, string]>; // [path, hexBytes]
  readonly kind?: "local" | "foreign";
  readonly foreignPkg?: string | null;
  readonly foreignExport?: string | null;
  readonly foreignDtsHash?: string | null;
}

/** One cache entry: all blocks produced by shave()-ing a file with a given contentHash. */
export type CacheEntry = CachedBlockRow[];

/**
 * The full shave cache file schema (DEC-V1-WAVE-4-WASM-PARITY-CACHE-FORMAT-001).
 */
export interface ShaveCache {
  readonly formatVersion: 1;
  readonly shaveVersionHash: string;
  readonly entries: Record<string, CacheEntry>;
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

// @decision DEC-V1-WAVE-4-PENDING-ATOMS-PATH-NORMALIZE-001
// @title Normalize absolute sourcePaths to repo-relative forward-slash paths at emission
// @status accepted (WI-V1W4-LOWER-EXTEND-MISSING-EXPORT-FOLLOWUP-02 / yakcc #139)
// @rationale
//   The merkleRootToSourcePath map and the CorpusAtom.sourcePath field were
//   previously populated with absolute filesystem paths (e.g.
//   /home/claude/yakcc/packages/seeds/src/blocks/digit/impl.ts).
//   Absolute paths are machine-local: they differ between developer machines
//   and CI environments, breaking content-stable identifiers
//   (DEC-V2-BOOTSTRAP-MANIFEST-001) and making pending-atoms.json non-portable.
//   Fix: apply path.relative(repoRoot, absPath) at the emission site inside
//   regenerateCorpus() — the merkleRootToSourcePath.set() call — so every
//   sourcePath written to pending-atoms.json or carried in CorpusAtom is a
//   repo-relative forward-slash string such as
//   "packages/seeds/src/blocks/digit/impl.ts".
//   repoRoot is already computed at the top of regenerateCorpus() via
//   findRepoRoot() (the walk-up helper in this file), so no subprocess call
//   (git rev-parse) is needed.
//   Cross-reference:
//   - DEC-V2-BOOTSTRAP-MANIFEST-001: content-stable identifiers
//   - DEC-V1-WAVE-4-WASM-LOWER-EXTEND-CORPUS-PROVENANCE-001: introduced the
//     absolute-path emission that this helper corrects
/**
 * Convert an absolute source path to a repo-relative forward-slash path.
 *
 * Uses path.relative(repoRoot, absPath) then normalises OS path separators to
 * forward slashes so the result is identical on all platforms.
 *
 * Precondition: absPath must be an absolute path under repoRoot. Passing a
 * path that is already relative will produce a "../"-prefixed result — callers
 * must ensure only absolute paths are passed (the shave walk always provides
 * absolute paths via readdirSync + join).
 *
 * Examples:
 *   relativizeSourcePath("/repo/packages/seeds/src/blocks/digit/impl.ts", "/repo")
 *     → "packages/seeds/src/blocks/digit/impl.ts"
 *   relativizeSourcePath("/repo/foo/bar.ts", "/repo")
 *     → "foo/bar.ts"
 */
export function relativizeSourcePath(absPath: string, repoRoot: string): string {
  const rel = relative(repoRoot, absPath);
  // Normalise to forward slashes for cross-platform stability.
  return rel.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// shaveVersionHash: cache-busting key for the shave algorithm version
// (DEC-V1-WAVE-4-WASM-PARITY-CACHE-001)
//
// Uses BLAKE3 (via sourceHash) of the concatenation of the shave algorithm
// constants used for corpus walks: STATIC_MODEL_TAG and STATIC_PROMPT_VERSION.
// When either constant changes (algorithm upgrade), ALL cache entries are
// invalidated without any manual intervention.
// ---------------------------------------------------------------------------

/**
 * Compute a stable version hash from shave algorithm constants.
 * Changing STATIC_MODEL_TAG or STATIC_PROMPT_VERSION busts the cache.
 */
export function computeShaveVersionHash(): string {
  return sourceHash(`${STATIC_MODEL_TAG}\x00${STATIC_PROMPT_VERSION}`);
}

// ---------------------------------------------------------------------------
// Cache serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a lowercase hex string for JSON storage.
 */
function uint8ToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Convert a hex string back to a Uint8Array.
 */
function hexToUint8(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * Convert a BlockTripletRow to a JSON-safe CachedBlockRow.
 * createdAt is always set to 0 for byte-stable cache files.
 */
function serializeRow(row: BlockTripletRow): CachedBlockRow {
  const artifactsArr: Array<readonly [string, string]> = [];
  for (const [k, v] of row.artifacts) {
    artifactsArr.push([k, uint8ToHex(v)] as const);
  }
  // Sort artifact keys for deterministic output
  artifactsArr.sort((a, b) => a[0].localeCompare(b[0]));

  const result: CachedBlockRow = {
    blockMerkleRoot: row.blockMerkleRoot as string,
    specHash: row.specHash as string,
    specCanonicalBytes: uint8ToHex(row.specCanonicalBytes),
    implSource: row.implSource,
    proofManifestJson: row.proofManifestJson,
    level: row.level,
    createdAt: 0,
    canonicalAstHash: row.canonicalAstHash as string,
    parentBlockRoot: row.parentBlockRoot ?? null,
    artifacts: artifactsArr,
  };

  // Include optional migration-6 fields only when present
  if (row.kind !== undefined) {
    return {
      ...result,
      kind: row.kind,
      foreignPkg: row.foreignPkg ?? null,
      foreignExport: row.foreignExport ?? null,
      foreignDtsHash: row.foreignDtsHash ?? null,
    };
  }

  return result;
}

/**
 * Convert a CachedBlockRow back to a BlockTripletRow suitable for storeBlock().
 * createdAt is set to 0 (matching the stored value — no live timestamps on replay).
 */
export function deserializeRow(cached: CachedBlockRow): BlockTripletRow {
  const artifacts = new Map<string, Uint8Array>();
  for (const [k, v] of cached.artifacts) {
    artifacts.set(k, hexToUint8(v));
  }

  // Build the required fields of BlockTripletRow first, then spread in the
  // optional parentBlockRoot only when it's present in the cached row.
  // exactOptionalPropertyTypes forbids setting optional props to `undefined`.
  const baseRequired = {
    blockMerkleRoot: cached.blockMerkleRoot as BlockTripletRow["blockMerkleRoot"],
    specHash: cached.specHash as BlockTripletRow["specHash"],
    specCanonicalBytes: hexToUint8(cached.specCanonicalBytes),
    implSource: cached.implSource,
    proofManifestJson: cached.proofManifestJson,
    level: cached.level,
    createdAt: 0 as const,
    canonicalAstHash: cached.canonicalAstHash as BlockTripletRow["canonicalAstHash"],
    artifacts,
  };
  // Spread parentBlockRoot only when it's present (null or non-null) in the cache.
  const base: BlockTripletRow =
    cached.parentBlockRoot !== undefined
      ? {
          ...baseRequired,
          parentBlockRoot: cached.parentBlockRoot as BlockTripletRow["blockMerkleRoot"] | null,
        }
      : baseRequired;

  if (cached.kind !== undefined) {
    return {
      ...base,
      kind: cached.kind,
      foreignPkg: cached.foreignPkg ?? null,
      foreignExport: cached.foreignExport ?? null,
      foreignDtsHash: cached.foreignDtsHash ?? null,
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Cache I/O (DEC-V1-WAVE-4-WASM-PARITY-CACHE-FORMAT-001)
// ---------------------------------------------------------------------------

/**
 * Load the shave cache from disk.
 *
 * Returns null in three cases (all treated as "empty cache" by regenerateCorpus):
 *   - File does not exist (first run)
 *   - File is corrupt / unparseable JSON
 *   - formatVersion mismatch or shaveVersionHash mismatch (stale cache)
 *
 * Emits console.warn for corrupt/version-mismatch cases so future implementers
 * can tell the difference between "first run" and "stale cache".
 */
export function loadCache(cacheFilePath: string): ShaveCache | null {
  if (!existsSync(cacheFilePath)) {
    return null; // first run — silent
  }

  let raw: string;
  try {
    raw = readFileSync(cacheFilePath, "utf-8");
  } catch (err) {
    console.warn(`[corpus-loader] shave-cache.json read error (treating as empty): ${String(err)}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[corpus-loader] shave-cache.json is corrupt JSON — treating as empty cache");
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.warn(
      "[corpus-loader] shave-cache.json root is not an object — treating as empty cache",
    );
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.formatVersion !== 1) {
    console.warn(
      `[corpus-loader] shave-cache.json formatVersion mismatch (got ${String(obj.formatVersion)}, expected 1) — treating as empty cache`,
    );
    return null;
  }

  const expectedVersion = computeShaveVersionHash();
  if (obj.shaveVersionHash !== expectedVersion) {
    console.warn(
      "[corpus-loader] shave-cache.json shaveVersionHash mismatch — shave algorithm changed; rebuilding cache",
    );
    return null;
  }

  if (typeof obj.entries !== "object" || obj.entries === null) {
    console.warn(
      "[corpus-loader] shave-cache.json missing entries field — treating as empty cache",
    );
    return null;
  }

  return {
    formatVersion: 1,
    shaveVersionHash: String(obj.shaveVersionHash),
    entries: obj.entries as Record<string, CacheEntry>,
  };
}

/**
 * Save the shave cache to disk.
 *
 * Writes JSON with 2-space indent, sorted top-level keys (alphabetical), and sorted
 * entry sub-keys for byte-stable diffs in git at every level.
 *
 * Top-level key order: entries → formatVersion → shaveVersionHash (alphabetical).
 * This matches the committed shave-cache.json so that the first real corpus run
 * does not produce an unexpected dirty diff.
 *
 * A trailing newline is appended so the file ends correctly on POSIX systems
 * and git does not warn about "No newline at end of file".
 *
 * @decision DEC-V1-WAVE-4-WASM-PARITY-CACHE-SAVEFORMAT-001
 * @title saveCache() sorts ALL keys (top-level + entries) alphabetically
 * @status decided (WI-V1W4-LOWER-PARITY-CACHE-001 round-2 reviewer fix)
 * @rationale
 *   Round-1 saveCache() only sorted entries sub-keys; the top-level object was
 *   constructed with literal key order { formatVersion, shaveVersionHash, entries }.
 *   The committed shave-cache.json had the reverse order { entries, formatVersion,
 *   shaveVersionHash }. On first real corpus run, saveCache() would overwrite the
 *   committed file with a different key order, producing an unexpected dirty diff.
 *   Fix: sort top-level keys alphabetically via Object.keys().sort() reduce so the
 *   output is byte-identical to the committed file. The @decision claim "sorted keys
 *   for byte-stable diffs" now applies at all levels.
 */
export function saveCache(cacheFilePath: string, cache: ShaveCache): void {
  // Sort entry keys for determinism
  const sortedEntries: Record<string, CacheEntry> = {};
  for (const key of Object.keys(cache.entries).sort()) {
    const entry = cache.entries[key];
    if (entry !== undefined) {
      sortedEntries[key] = entry;
    }
  }

  // Build a plain object with ALL top-level keys sorted alphabetically.
  // Alphabetical order: entries < formatVersion < shaveVersionHash.
  // This ensures the committed shave-cache.json (which also uses alphabetical
  // order) is byte-identical to what saveCache() produces on a fresh run.
  const allKeys: (keyof ShaveCache)[] = ["entries", "formatVersion", "shaveVersionHash"];
  const sortedCache = allKeys.reduce((acc, k) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (acc as unknown as Record<string, unknown>)[k] = k === "entries" ? sortedEntries : cache[k];
    return acc;
  }, {} as ShaveCache);

  // Trailing newline: POSIX convention; prevents git "No newline at end of file" noise.
  writeFileSync(cacheFilePath, `${JSON.stringify(sortedCache, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Per-file cache try: replay from cache or call shave() (live miss path)
// ---------------------------------------------------------------------------

/**
 * ShaveRegistryView adapter: Registry.getBlock returns null; ShaveRegistryView
 * expects undefined. This adapter bridges the two interfaces.
 */
type ShaveRegistryView = Parameters<typeof shave>[1];

/**
 * Attempt to serve a file from cache or fall back to live shave().
 *
 * Returns the list of new BlockTripletRows produced by this file (empty if
 * shave produced nothing new), plus whether this was a cache hit or miss.
 *
 * On error (shave throws), returns an empty list and `wasError: true`.
 */
export async function tryHitOrShave(
  absPath: string,
  fileContent: string,
  contentHash: string,
  cacheEntries: Record<string, CacheEntry>,
  registry: Awaited<ReturnType<typeof openRegistry>>,
  shaveRegistry: ShaveRegistryView,
): Promise<{ rows: BlockTripletRow[]; fromCache: boolean; wasError: boolean }> {
  const existing = cacheEntries[contentHash];
  if (existing !== undefined) {
    // Cache hit: replay stored blocks into the in-memory registry
    const rows: BlockTripletRow[] = [];
    for (const cachedRow of existing) {
      const row = deserializeRow(cachedRow);
      try {
        await registry.storeBlock(row);
        rows.push(row);
      } catch (err) {
        // storeBlock failed for a cached row — this is a replay error
        // (e.g. hash integrity mismatch). Surface it so tests can detect it.
        throw new Error(`Cache replay error for contentHash=${contentHash}: ${String(err)}`);
      }
    }
    return { rows, fromCache: true, wasError: false };
  }

  // Cache miss: run live shave()
  // Capture the manifest before and after to identify new blocks produced.
  const manifestBefore = await registry.exportManifest();
  const rootsBefore = new Set(manifestBefore.map((e) => e.blockMerkleRoot));

  try {
    await shave(absPath, shaveRegistry, { offline: true, intentStrategy: "static" });
  } catch {
    return { rows: [], fromCache: false, wasError: true };
  }

  // Identify newly stored blocks by diffing manifest
  const manifestAfter = await registry.exportManifest();
  const newRoots = manifestAfter.map((e) => e.blockMerkleRoot).filter((r) => !rootsBefore.has(r));

  const rows: BlockTripletRow[] = [];
  for (const root of newRoots) {
    const block = await registry.getBlock(root);
    if (block !== null) {
      rows.push(block);
    }
  }

  return { rows, fromCache: false, wasError: false };
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
//
// Cache integration (DEC-V1-WAVE-4-WASM-PARITY-CACHE-001):
//   shave-cache.json (in the same test/ directory as this file) is loaded at
//   the start of regenerateCorpus(). For each source file, if a cache hit
//   exists, stored blocks are replayed into the in-memory registry. Otherwise
//   shave() is called live and new blocks are captured. At the end, the cache
//   is saved back to disk (with new entries appended, old hits preserved).
// ---------------------------------------------------------------------------

/**
 * Options bag for regenerateCorpus().
 *
 * @decision DEC-V1-WAVE-4-WASM-PARITY-CORPUS-SOURCEWALK-001
 * @title regenerateCorpus accepts optional sourceFiles override for test isolation
 * @status decided (WI-V1W4-LOWER-PARITY-CACHE-001 round-2 reviewer fix)
 * @rationale
 *   The integrated cold→warm determinism test needs to call regenerateCorpus() on a
 *   small, controlled file set instead of the full packages walk (which takes minutes).
 *   Adding sourceFiles?: string[] to the options bag is the minimal invasive change:
 *   when provided, it replaces the packages walk entirely; when omitted the existing
 *   packages/star/src walk runs unchanged. This avoids adding a separate exported
 *   helper (option b) and avoids hardcoding real file paths inside the test (option c
 *   from the reviewer brief) — instead, the test passes whatever small real files it
 *   chooses via this parameter.
 */
export interface RegenerateCorpusOptions {
  /**
   * Override the source file walk with an explicit list of absolute paths.
   * When provided, the packages/star/src walk is skipped entirely and only
   * these files are processed. Intended for test isolation — keeps the test
   * fast by shaving 2-3 tiny files instead of the full corpus.
   *
   * Default: undefined (run the full packages/star/src walk).
   */
  readonly sourceFiles?: string[];
}

/**
 * Regenerate the corpus from the current source tree via shave().
 *
 * Opens ONE in-memory registry, zero-embedding opts (no network).
 * Walks packages-star-src/**\/**.ts (same exclusions as bootstrap.ts),
 * or uses the explicit sourceFiles override when provided.
 * Shaves each file against the shared registry, opts: offline=true, intentStrategy=static.
 * After all files, enumerates blocks via exportManifest() + getBlock().
 * Returns a RegeneratedCorpus keyed by canonicalAstHash (first-occurrence dedup).
 *
 * Cache: reads shave-cache.json for warm-run acceleration. Files whose content
 * hash is already in the cache skip shave() entirely — stored blocks are
 * replayed into the in-memory registry. New results are written back at the end.
 *
 * Performance note: shave() using static strategy still parses ASTs and runs
 * decompose/slice. On the ~93-file production source, this takes several minutes
 * on a cold cache. On a warm cache, regeneration should complete in <30s.
 *
 * @param cacheFilePath - Optional path to the cache file. Defaults to
 *   shave-cache.json in the same directory as this module. Override in tests.
 * @param opts - Optional configuration (see RegenerateCorpusOptions).
 */
export async function regenerateCorpus(
  cacheFilePath?: string,
  opts?: RegenerateCorpusOptions,
): Promise<RegeneratedCorpus> {
  // Locate the repo root relative to this file's location at runtime.
  const repoRoot = findRepoRoot(process.cwd());

  // Resolve cache file path: default is shave-cache.json in test/
  const resolvedCachePath =
    cacheFilePath ??
    join(repoRoot, "examples", "v1-wave-3-wasm-lower-demo", "test", "shave-cache.json");

  // Load the cache (null = empty / stale)
  const loadedCache = loadCache(resolvedCachePath);
  const shaveVersionHash = computeShaveVersionHash();
  const cacheEntries: Record<string, CacheEntry> =
    loadedCache !== null ? { ...loadedCache.entries } : {};

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

  let filesWalked = 0;
  let shaveFailures = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  // @decision DEC-V1-WAVE-4-WASM-LOWER-EXTEND-CORPUS-PROVENANCE-001
  // @title corpus-loader captures EVERY merkleRoot per shave to fix sourcePath provenance
  // @status accepted (WI-V1W4-LOWER-EXTEND-CORPUS-PROVENANCE-001 / yakcc #127)
  // @rationale
  //   shave() produces sub-fragments at multiple levels (parent block + sub-blocks).
  //   The prior implementation labelled all corpus atoms with "registry:<hash>"
  //   because sourcePath was not stored in the registry, and the post-shave atom
  //   enumeration had no way to recover which source file produced each block.
  //   Fix: as each file is processed (cache hit or live shave), map every
  //   blockMerkleRoot returned by tryHitOrShave to the current absPath.
  //   tryHitOrShave already captures all newly-stored blocks via manifest diff
  //   (for live shave) and full cache entry replay (for cache hits), so this map
  //   covers parent blocks AND sub-blocks alike. First-seen wins for atoms
  //   dedup'd across multiple files. Any block that has no map entry (should not
  //   happen in a correct walk) falls back to "registry:<hash>" with console.warn
  //   so future implementers are alerted rather than silently mislabelled.
  //   No schema changes to @yakcc/registry or @yakcc/shave are required.
  const merkleRootToSourcePath = new Map<string, string>();

  // Resolve the file list: explicit override or full packages walk.
  let filesToProcess: string[];
  if (opts?.sourceFiles !== undefined) {
    // Test-isolation path: use the caller-supplied list directly (sorted for determinism).
    filesToProcess = [...opts.sourceFiles].sort();
  } else {
    // Production path: walk packages/*/src/**/*.ts
    const packagesDir = join(repoRoot, "packages");
    filesToProcess = [];
    if (existsSync(packagesDir)) {
      const pkgDirs = readdirSync(packagesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(packagesDir, e.name, "src"))
        .sort(); // lexicographic order for determinism (DEC-V2-BOOT-FILE-ORDER-001)
      for (const srcDir of pkgDirs) {
        const rawFiles: string[] = [];
        walkTs(srcDir, rawFiles);
        filesToProcess.push(...rawFiles.filter((f) => !shouldSkip(f)).sort());
      }
    }
  }

  for (const absPath of filesToProcess) {
    filesWalked++;

    // Compute content hash for cache lookup
    let fileContent: string;
    try {
      fileContent = readFileSync(absPath, "utf-8");
    } catch {
      shaveFailures++;
      continue;
    }
    const contentHash = sourceHash(fileContent);

    const result = await tryHitOrShave(
      absPath,
      fileContent,
      contentHash,
      cacheEntries,
      registry,
      shaveRegistry as ShaveRegistryView,
    );

    if (result.fromCache) {
      cacheHits++;
      // Cache hit: new rows may be empty (file produced no blocks on
      // original shave) — that's fine, we still count it as a hit.
    } else {
      cacheMisses++;
      if (result.wasError) {
        shaveFailures++;
      } else {
        // Store new rows in cache (createdAt=0 for byte-stability)
        cacheEntries[contentHash] = result.rows.map((r) => serializeRow({ ...r, createdAt: 0 }));
      }
    }

    // Map every blockMerkleRoot produced by this file to its source path.
    // First-seen wins: if two files produce the same block (dedup'd by registry),
    // the first file in the walk order is credited.
    // (DEC-V1-WAVE-4-WASM-LOWER-EXTEND-CORPUS-PROVENANCE-001)
    for (const row of result.rows) {
      if (!merkleRootToSourcePath.has(row.blockMerkleRoot)) {
        merkleRootToSourcePath.set(row.blockMerkleRoot, relativizeSourcePath(absPath, repoRoot));
      }
    }
  }

  // Save updated cache back to disk
  const newCache: ShaveCache = {
    formatVersion: 1,
    shaveVersionHash,
    entries: cacheEntries,
  };
  try {
    saveCache(resolvedCachePath, newCache);
  } catch (err) {
    console.warn(`[corpus-loader] Failed to write shave-cache.json: ${String(err)}`);
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

    // Resolve sourcePath from the merkleRoot→file map built during the shave walk.
    // First-seen wins for atoms dedup'd across multiple files.
    // Sacred Practice #5: warn loudly when a merkleRoot has no known source file
    // rather than silently mislabelling atoms. (DEC-V1-WAVE-4-WASM-LOWER-EXTEND-CORPUS-PROVENANCE-001)
    const resolvedSourcePath = merkleRootToSourcePath.get(entry.blockMerkleRoot);
    if (resolvedSourcePath === undefined) {
      console.warn(
        `[corpus-loader] No sourcePath found for blockMerkleRoot=${entry.blockMerkleRoot.slice(0, 16)} — falling back to registry label. This block was stored in the registry but not produced by any file in this walk (possible dedup across multiple files or a registry pre-populated from a prior run).`,
      );
    }

    atoms.set(entry.canonicalAstHash, {
      canonicalAstHash: entry.canonicalAstHash,
      implSource: block.implSource,
      sourcePath: resolvedSourcePath ?? `registry:${entry.blockMerkleRoot.slice(0, 16)}`,
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
    cacheHits,
    cacheMisses,
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
