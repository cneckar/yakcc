// SPDX-License-Identifier: MIT
// cache.test.ts — Unit tests for the shave-cache content-hash layer.
//
// Tests verify: hit, miss, corrupted-fallback, missing-cache-first-run,
// mtime-drift, determinism, version-mismatch-fallback, replay-error-throws.
// Plus one it.skip profile affordance for ad-hoc wall-clock capture.
//
// Production sequence exercised:
//   loadCache() → tryHitOrShave() → saveCache()  [warm-run sequence]
//   loadCache() → shave() live → saveCache()      [cold-run / miss sequence]
//
// All tests use os.tmpdir() cache paths and synthetic in-memory registries
// so they complete in seconds without touching the real corpus.

// @decision DEC-CI-NIGHTLY-001
// title: Derive repoRoot at runtime via import.meta.url
// status: accepted
// rationale: The original test hardcoded an absolute worktree path
//   (/home/claude/yakcc/.worktrees/feature-wi-v1w4-lower-parity-cache-001) that
//   only existed on the original author's machine.  On CI and every other
//   developer machine those paths are missing, so regenerateCorpus received
//   zero source files and returned zero atoms, causing the cacheMisses ≥ 1
//   assertion to fail for 30+ consecutive CI runs.  Using
//   fileURLToPath(new URL("../../..", import.meta.url)) pins the root to the
//   actual location of this test file in whatever checkout is running, making
//   the test portable across machines, worktrees, and CI environments.
//   existsSync guards are added so a missing seed file fails loudly rather than
//   silently producing an empty corpus that masks the real problem.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BlockMerkleRoot,
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { STATIC_MODEL_TAG, STATIC_PROMPT_VERSION, shave, sourceHash } from "@yakcc/shave";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CachedBlockRow,
  type ShaveCache,
  computeShaveVersionHash,
  deserializeRow,
  loadCache,
  regenerateCorpus,
  relativizeSourcePath,
  saveCache,
  tryHitOrShave,
} from "./corpus-loader.js";

// ---------------------------------------------------------------------------
// Test fixture factory helpers (mirrors storage.test.ts pattern)
// ---------------------------------------------------------------------------

function mockEmbedProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-cache",
    async embed(_text: string): Promise<Float32Array> {
      return new Float32Array(384);
    },
  };
}

function makeSpecYak(name = "test-fn", behavior = "A test function"): SpecYak {
  return {
    name,
    inputs: [{ name: "x", type: "number" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: ["result is defined"],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [{ id: "total", description: "Always returns." }],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(1)", space: "O(1)" },
    propertyTests: [],
  };
}

function makeManifest(): ProofManifest {
  return { artifacts: [{ kind: "property_tests", path: "property_tests.ts" }] };
}

/**
 * Build a real BlockTripletRow using the same contracts/merkle functions as
 * production code. createdAt is always 0 for test determinism.
 */
function makeBlockRow(
  name: string,
  implSource = "export function f(x: number): number { return x + 1; }",
): BlockTripletRow {
  const spec = makeSpecYak(name);
  const manifest = makeManifest();
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);
  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: 0,
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
    parentBlockRoot: null,
  };
}

// ---------------------------------------------------------------------------
// Serialized-row helpers for building synthetic cache files
// ---------------------------------------------------------------------------

function makeCachedBlockRow(name: string): CachedBlockRow {
  const row = makeBlockRow(name);
  const artifactsArr: Array<readonly [string, string]> = [];
  for (const [k, v] of row.artifacts) {
    artifactsArr.push([k, Buffer.from(v).toString("hex")]);
  }
  return {
    blockMerkleRoot: row.blockMerkleRoot as string,
    specHash: row.specHash as string,
    specCanonicalBytes: Buffer.from(row.specCanonicalBytes).toString("hex"),
    implSource: row.implSource,
    proofManifestJson: row.proofManifestJson,
    level: row.level,
    createdAt: 0,
    canonicalAstHash: row.canonicalAstHash as string,
    parentBlockRoot: null,
    artifacts: artifactsArr,
  };
}

function makeValidCache(entries: Record<string, CachedBlockRow[]> = {}): ShaveCache {
  return {
    formatVersion: 1,
    shaveVersionHash: computeShaveVersionHash(),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Unique tmp path for each test (avoids cross-test interference)
// ---------------------------------------------------------------------------

let tmpCacheDir: string;
let cacheCounter = 0;

beforeEach(() => {
  const id = `cache-test-${process.pid}-${Date.now()}-${cacheCounter++}`;
  tmpCacheDir = join(tmpdir(), id);
  mkdirSync(tmpCacheDir, { recursive: true });
});

afterEach(() => {
  // Leave tmpdir cleanup to OS — no persistent state from these tests
});

function tmpCachePath(): string {
  return join(tmpCacheDir, "shave-cache.json");
}

// ---------------------------------------------------------------------------
// loadCache tests
// ---------------------------------------------------------------------------

describe("loadCache", () => {
  it("missing-cache-first-run: returns null when file does not exist", () => {
    const result = loadCache(join(tmpCacheDir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("corrupted-fallback: returns null and does not throw on corrupt JSON", () => {
    const path = tmpCachePath();
    writeFileSync(path, "{ this is not json }", "utf-8");
    expect(() => loadCache(path)).not.toThrow();
    expect(loadCache(path)).toBeNull();
  });

  it("corrupted-fallback: returns null on non-object root", () => {
    const path = tmpCachePath();
    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf-8");
    expect(loadCache(path)).toBeNull();
  });

  it("version-mismatch-fallback: returns null when formatVersion !== 1", () => {
    const path = tmpCachePath();
    const stale = { formatVersion: 2, shaveVersionHash: computeShaveVersionHash(), entries: {} };
    writeFileSync(path, JSON.stringify(stale), "utf-8");
    expect(loadCache(path)).toBeNull();
  });

  it("version-mismatch-fallback: returns null when shaveVersionHash is stale", () => {
    const path = tmpCachePath();
    const stale: ShaveCache = {
      formatVersion: 1,
      shaveVersionHash: "deadbeef".repeat(8), // wrong hash
      entries: {},
    };
    writeFileSync(path, JSON.stringify(stale), "utf-8");
    expect(loadCache(path)).toBeNull();
  });

  it("returns valid ShaveCache on a well-formed file", () => {
    const path = tmpCachePath();
    const cache = makeValidCache({});
    writeFileSync(path, JSON.stringify(cache), "utf-8");
    const result = loadCache(path);
    expect(result).not.toBeNull();
    expect(result?.formatVersion).toBe(1);
    expect(result?.shaveVersionHash).toBe(computeShaveVersionHash());
  });
});

// ---------------------------------------------------------------------------
// saveCache tests
// ---------------------------------------------------------------------------

describe("saveCache", () => {
  it("determinism: writing the same cache twice produces identical bytes", () => {
    const cachedRow = makeCachedBlockRow("fn-a");
    const cache = makeValidCache({ abc123: [cachedRow] });

    const path1 = join(tmpCacheDir, "a.json");
    const path2 = join(tmpCacheDir, "b.json");
    saveCache(path1, cache);
    saveCache(path2, cache);

    expect(readFileSync(path1, "utf-8")).toBe(readFileSync(path2, "utf-8"));
  });

  it("determinism: entry keys are sorted in JSON output", () => {
    const cachedRow = makeCachedBlockRow("fn-b");
    const cache: ShaveCache = {
      formatVersion: 1,
      shaveVersionHash: computeShaveVersionHash(),
      entries: {
        zzz: [cachedRow],
        aaa: [cachedRow],
        mmm: [cachedRow],
      },
    };
    const path = tmpCachePath();
    saveCache(path, cache);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ShaveCache;
    const keys = Object.keys(parsed.entries);
    expect(keys).toEqual([...keys].sort());
  });

  it("round-trip: saved cache can be loaded back with identical entries", () => {
    const cachedRow = makeCachedBlockRow("fn-c");
    const cache = makeValidCache({ myHash: [cachedRow] });
    const path = tmpCachePath();
    saveCache(path, cache);
    const loaded = loadCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded?.entries.myHash).toHaveLength(1);
    expect(loaded?.entries.myHash?.[0]?.implSource).toBe(cachedRow.implSource);
  });
});

// ---------------------------------------------------------------------------
// deserializeRow tests
// ---------------------------------------------------------------------------

describe("deserializeRow", () => {
  it("round-trips a BlockTripletRow through serialize/deserialize", () => {
    const original = makeBlockRow("fn-roundtrip");
    const cached = makeCachedBlockRow("fn-roundtrip");
    const restored = deserializeRow(cached);

    // Compare the content-addressable fields
    expect(restored.blockMerkleRoot).toBe(original.blockMerkleRoot);
    expect(restored.specHash).toBe(original.specHash);
    expect(restored.implSource).toBe(original.implSource);
    expect(restored.canonicalAstHash).toBe(original.canonicalAstHash);
    expect(restored.createdAt).toBe(0);
    // artifacts round-trip
    expect(restored.artifacts.size).toBe(original.artifacts.size);
  });
});

// ---------------------------------------------------------------------------
// tryHitOrShave — cache hit path
// ---------------------------------------------------------------------------

describe("tryHitOrShave — cache hit", () => {
  it("hit: replays cached rows into registry without calling shave()", async () => {
    const reg = await openRegistry(":memory:", { embeddings: mockEmbedProvider() });

    const cachedRow = makeCachedBlockRow("fn-hit");
    const fakeContent = "export function fn_hit(x: number): number { return x; }";
    const contentHash = sourceHash(fakeContent);
    const entries: Record<string, CachedBlockRow[]> = { [contentHash]: [cachedRow] };

    const shaveRegistry = {
      selectBlocks: reg.selectBlocks.bind(reg),
      getBlock: async (root: BlockMerkleRoot) => {
        const r = await reg.getBlock(root);
        return r ?? undefined;
      },
      findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
      storeBlock: reg.storeBlock.bind(reg),
    };

    const result = await tryHitOrShave(
      "/fake/path.ts",
      fakeContent,
      contentHash,
      entries,
      reg,
      shaveRegistry,
    );

    expect(result.fromCache).toBe(true);
    expect(result.wasError).toBe(false);
    // The block should now be in the registry
    const block = await reg.getBlock(cachedRow.blockMerkleRoot as BlockMerkleRoot);
    expect(block).not.toBeNull();
    expect(block?.implSource).toBe(cachedRow.implSource);

    await reg.close();
  });

  it("hit: empty cached entry (file produced no atoms) returns empty rows without error", async () => {
    const reg = await openRegistry(":memory:", { embeddings: mockEmbedProvider() });

    const fakeContent = "// no atoms here";
    const contentHash = sourceHash(fakeContent);
    const entries: Record<string, CachedBlockRow[]> = { [contentHash]: [] };

    const shaveRegistry = {
      selectBlocks: reg.selectBlocks.bind(reg),
      getBlock: async (root: BlockMerkleRoot) => {
        const r = await reg.getBlock(root);
        return r ?? undefined;
      },
      findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
      storeBlock: reg.storeBlock.bind(reg),
    };

    const result = await tryHitOrShave(
      "/fake/empty.ts",
      fakeContent,
      contentHash,
      entries,
      reg,
      shaveRegistry,
    );

    expect(result.fromCache).toBe(true);
    expect(result.wasError).toBe(false);
    expect(result.rows).toHaveLength(0);

    await reg.close();
  });
});

// ---------------------------------------------------------------------------
// tryHitOrShave — cache miss path
// ---------------------------------------------------------------------------

describe("tryHitOrShave — cache miss", () => {
  it("miss: returns fromCache=false when contentHash is not in entries", async () => {
    const reg = await openRegistry(":memory:", { embeddings: mockEmbedProvider() });

    const fakeContent = "// definitely not in cache";
    const contentHash = sourceHash(fakeContent);
    const entries: Record<string, CachedBlockRow[]> = {}; // empty entries

    const shaveRegistry = {
      selectBlocks: reg.selectBlocks.bind(reg),
      getBlock: async (root: BlockMerkleRoot) => {
        const r = await reg.getBlock(root);
        return r ?? undefined;
      },
      findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
      storeBlock: reg.storeBlock.bind(reg),
    };

    // /fake/path.ts doesn't exist, so shave() will error — wasError=true, fromCache=false
    const result = await tryHitOrShave(
      "/nonexistent/path.ts",
      fakeContent,
      contentHash,
      entries,
      reg,
      shaveRegistry,
    );

    expect(result.fromCache).toBe(false);
    // shave() on a nonexistent file is either a shave error or produces 0 blocks
    // Either way wasError=true or rows=[] — the key is fromCache=false
    expect(result.wasError === true || result.rows.length === 0).toBe(true);

    await reg.close();
  });

  it("mtime-drift: same contentHash => cache hit regardless of path/mtime", async () => {
    // Two different "files" with the same content should both be cache hits
    const reg = await openRegistry(":memory:", { embeddings: mockEmbedProvider() });

    const sharedContent = "export function fn_shared(x: number): number { return x * 2; }";
    const contentHash = sourceHash(sharedContent);
    const cachedRow = makeCachedBlockRow("fn-shared");
    const entries: Record<string, CachedBlockRow[]> = { [contentHash]: [cachedRow] };

    const shaveRegistry = {
      selectBlocks: reg.selectBlocks.bind(reg),
      getBlock: async (root: BlockMerkleRoot) => {
        const r = await reg.getBlock(root);
        return r ?? undefined;
      },
      findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
      storeBlock: reg.storeBlock.bind(reg),
    };

    // First "file" at path A
    const r1 = await tryHitOrShave(
      "/path/A.ts",
      sharedContent,
      contentHash,
      entries,
      reg,
      shaveRegistry,
    );
    // Second "file" at path B (different path, same content)
    const r2 = await tryHitOrShave(
      "/path/B.ts",
      sharedContent,
      contentHash,
      entries,
      reg,
      shaveRegistry,
    );

    expect(r1.fromCache).toBe(true);
    expect(r2.fromCache).toBe(true); // mtime/path don't matter; content hash wins

    await reg.close();
  });
});

// ---------------------------------------------------------------------------
// replay-error-throws
// ---------------------------------------------------------------------------

describe("tryHitOrShave — replay error", () => {
  it("replay-error-throws: storeBlock failure for a corrupt cached row throws", async () => {
    const reg = await openRegistry(":memory:", { embeddings: mockEmbedProvider() });

    const fakeContent = "export function bad(x: number): number { return x; }";
    const contentHash = sourceHash(fakeContent);

    // Build a cached row with a tampered blockMerkleRoot (integrity mismatch)
    const realRow = makeCachedBlockRow("fn-replay-err");
    const tamperedRow: CachedBlockRow = {
      ...realRow,
      blockMerkleRoot: "deadbeef".repeat(8), // wrong merkle root — storeBlock will reject it
    };
    const entries: Record<string, CachedBlockRow[]> = { [contentHash]: [tamperedRow] };

    const shaveRegistry = {
      selectBlocks: reg.selectBlocks.bind(reg),
      getBlock: async (root: BlockMerkleRoot) => {
        const r = await reg.getBlock(root);
        return r ?? undefined;
      },
      findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
      storeBlock: reg.storeBlock.bind(reg),
    };

    await expect(
      tryHitOrShave("/fake/path.ts", fakeContent, contentHash, entries, reg, shaveRegistry),
    ).rejects.toThrow(/Cache replay error/);

    await reg.close();
  });
});

// ---------------------------------------------------------------------------
// computeShaveVersionHash
// ---------------------------------------------------------------------------

describe("computeShaveVersionHash", () => {
  it("is deterministic across multiple calls", () => {
    const a = computeShaveVersionHash();
    const b = computeShaveVersionHash();
    expect(a).toBe(b);
  });

  it("is a 64-char hex string (BLAKE3-256)", () => {
    const h = computeShaveVersionHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("encodes STATIC_MODEL_TAG and STATIC_PROMPT_VERSION", () => {
    // Changing either constant should produce a different hash.
    // We verify the hash is tied to the current exported constants.
    const expected = sourceHash(`${STATIC_MODEL_TAG}\x00${STATIC_PROMPT_VERSION}`);
    expect(computeShaveVersionHash()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Integrated determinism: regenerateCorpus cold-then-warm produces byte-identical atoms
//
// Production sequence exercised:
//   regenerateCorpus(cacheFilePath, { sourceFiles: [...] })  — cold run (cache miss)
//   regenerateCorpus(cacheFilePath, { sourceFiles: [...] })  — warm run (cache hit)
//
// This is the compound-interaction test required by the implementer contract:
// it crosses corpus-loader → tryHitOrShave → saveCache / loadCache and verifies
// that the full round-trip (shave → cache persist → cache replay) is byte-identical.
// ---------------------------------------------------------------------------

describe("regenerateCorpus — integrated determinism", () => {
  it(
    "cold-then-warm produces byte-identical atoms",
    async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: pathJoin } = await import("node:path");

      // Two real seed impl files (tiny source; shave completes in seconds).
      // Using digit and comma blocks — both exist in the monorepo and are ≤20 lines.
      //
      // repoRoot is derived from import.meta.url so the path is correct in any
      // checkout or CI environment (see @decision DEC-CI-NIGHTLY-001 at the top
      // of this file).  This file lives at
      //   examples/v1-wave-3-wasm-lower-demo/test/cache.test.ts
      // so three levels up ("../../..") reaches the monorepo root.
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const sourceFiles = [
        pathJoin(repoRoot, "packages/seeds/src/blocks/digit/impl.ts"),
        pathJoin(repoRoot, "packages/seeds/src/blocks/comma/impl.ts"),
      ];

      // Guard: fail loudly if the seed files are missing rather than letting a
      // silent zero-atom run hide the problem (see DEC-CI-NIGHTLY-001).
      for (const sf of sourceFiles) {
        if (!existsSync(sf)) {
          throw new Error(
            `[DEC-CI-NIGHTLY-001] Seed source file not found: ${sf}\n` +
              `repoRoot resolved to: ${repoRoot}\n` +
              `Ensure the monorepo checkout is complete and packages/seeds exists.`,
          );
        }
      }

      const tempDir = mkdtempSync(pathJoin(tmpdir(), "wi119-determinism-"));
      const cacheFilePath = pathJoin(tempDir, "shave-cache.json");

      try {
        // Cold pass: cache file does not exist; regenerateCorpus shaves both
        // files and persists the cache.
        const result1 = await regenerateCorpus(cacheFilePath, { sourceFiles });
        const cold = JSON.stringify(
          [...result1.atoms.entries()].sort(([a], [b]) => a.localeCompare(b)),
        );
        expect(result1.cacheMisses).toBeGreaterThanOrEqual(1);
        expect(result1.cacheHits).toBe(0);

        // Warm pass: cache file is populated; regenerateCorpus replays from cache.
        const result2 = await regenerateCorpus(cacheFilePath, { sourceFiles });
        const warm = JSON.stringify(
          [...result2.atoms.entries()].sort(([a], [b]) => a.localeCompare(b)),
        );
        expect(result2.cacheHits).toBeGreaterThanOrEqual(1);
        expect(result2.cacheMisses).toBe(0);

        // Byte-identical assertion (the integrated determinism contract).
        expect(warm).toBe(cold);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    60_000, // 60s timeout — real shave on tiny files should complete in seconds
  );
});

// ---------------------------------------------------------------------------
// relativizeSourcePath — unit tests (DEC-V1-WAVE-4-PENDING-ATOMS-PATH-NORMALIZE-001)
//
// Verifies that the helper converts absolute paths to repo-relative forward-slash
// strings, matching the contract documented in corpus-loader.ts.
// ---------------------------------------------------------------------------

describe("relativizeSourcePath", () => {
  it("converts an absolute path under repoRoot to a repo-relative forward-slash path", () => {
    const result = relativizeSourcePath(
      "/repo/packages/seeds/src/blocks/digit/impl.ts",
      "/repo",
    );
    expect(result).toBe("packages/seeds/src/blocks/digit/impl.ts");
  });

  it("sanity: shallow absolute path under repoRoot", () => {
    const result = relativizeSourcePath("/repo/foo/bar.ts", "/repo");
    expect(result).toBe("foo/bar.ts");
  });

  it("precondition doc: already-relative input produces leading '../' (documents the boundary)", () => {
    // relativizeSourcePath expects absolute input. If called with a relative path
    // the result starts with ".." — callers must ensure only absolute paths are passed.
    // This test documents the precondition rather than asserting a guard.
    const result = relativizeSourcePath("packages/seeds/src/blocks/digit/impl.ts", "/repo");
    // path.relative("/repo", "packages/...") produces a ../... result — not a valid
    // repo-relative path. We assert it is NOT a clean forward-slash relative path.
    expect(result.startsWith("..")).toBe(true);
  });

  it("forward-slash normalization: result contains no backslashes", () => {
    // On Linux path.sep is '/' so this is a no-op, but the test documents the
    // cross-platform contract: any platform-native separators are normalised.
    const result = relativizeSourcePath(
      "/repo/packages/seeds/src/blocks/digit/impl.ts",
      "/repo",
    );
    expect(result).not.toContain("\\");
    expect(result).toBe("packages/seeds/src/blocks/digit/impl.ts");
  });
});

// ---------------------------------------------------------------------------
// it.skip profile affordance (DEC-V1-WAVE-4-WASM-PARITY-CACHE-PROFILE-001)
//
// Run manually with:
//   pnpm --filter v1-wave-3-wasm-lower-demo exec vitest run --reporter=verbose \
//     cache.test.ts --run -t "profile"
// ---------------------------------------------------------------------------

it.skip("profile: shave wall-clock per file (manual run)", async () => {
  // This test is intentionally skipped in CI. Flip to it() and run manually
  // to capture real wall-clock numbers for the corpus shave cost.
  //
  // Prior implementer claimed ~150s/file (unverified; see
  // DEC-V1-WAVE-4-WASM-PARITY-CACHE-PROFILE-001 in corpus-loader.ts).
  const { openRegistry: openReg } = await import("@yakcc/registry");
  const reg = await openReg(":memory:", { embeddings: mockEmbedProvider() });

  const shaveRegistry = {
    selectBlocks: reg.selectBlocks.bind(reg),
    getBlock: async (root: BlockMerkleRoot) => {
      const r = await reg.getBlock(root);
      return r ?? undefined;
    },
    findByCanonicalAstHash: reg.findByCanonicalAstHash.bind(reg),
    storeBlock: reg.storeBlock.bind(reg),
  };

  // Three representative production source files.
  // Adjust these paths as the monorepo evolves.
  const { join: pathJoin } = await import("node:path");
  const { existsSync, readFileSync: readFs } = await import("node:fs");
  const cwd = process.cwd();
  const candidates = [
    pathJoin(cwd, "../../packages/shave/src/index.ts"),
    pathJoin(cwd, "../../packages/registry/src/index.ts"),
    pathJoin(cwd, "../../packages/contracts/src/merkle.ts"),
  ].filter((p) => existsSync(p));

  for (const file of candidates) {
    const content = readFs(file, "utf-8");
    const t0 = performance.now();
    try {
      await shave(file, shaveRegistry, { offline: true, intentStrategy: "static" });
    } catch {
      // count failure but continue
    }
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[profile] ${file.split("/").slice(-3).join("/")} — ${elapsed}ms`);
    // Log content hash for cache key reference
    console.log(`[profile]   contentHash=${sourceHash(content).slice(0, 16)}...`);
  }

  await reg.close();
});
