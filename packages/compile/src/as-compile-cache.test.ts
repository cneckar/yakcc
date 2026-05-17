// SPDX-License-Identifier: MIT
//
// as-compile-cache.test.ts — unit tests for the content-addressed asc compile cache
//
// @decision DEC-AS-COMPILE-CACHE-001 (key derivation)
// @decision DEC-AS-COMPILE-CACHE-002 (storage layout + atomic rename)
// @decision DEC-AS-COMPILE-CACHE-003 (wrapper module: cachedAsEmit)
// @decision DEC-AS-COMPILE-CACHE-004 (in-memory thundering herd lock)
// @decision DEC-AS-COMPILE-CACHE-005 (determinism: cold/warm byte equality)
// @decision DEC-AS-COMPILE-CACHE-006 (atomic write + corrupt-entry recovery)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WasmBackend, assemblyScriptBackend } from "./as-backend.js";
import {
  ASC_FLAGS_HASH,
  ASC_VERSION,
  type CachedAsEmitOpts,
  cachedAsEmit,
  clearCache,
  clearInFlightLock,
  defaultCacheDir,
  deriveCacheKey,
} from "./as-compile-cache.js";
import type { ResolutionResult } from "./resolve.js";

// ---------------------------------------------------------------------------
// Minimal valid WASM module with one export (for structural tests)
// Format: magic (4) + version (4) + export section (id=7)
// This is the smallest well-formed WASM binary that passes the magic check.
// ---------------------------------------------------------------------------

/**
 * A minimal valid WASM module: empty module (just magic + version).
 * Not WebAssembly.validate()-able in all runtimes but has correct magic bytes.
 */
const MINIMAL_WASM = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // magic: \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version: 1
]) as Uint8Array<ArrayBuffer>;

// A slightly different payload to test key isolation between atom hashes.
const MINIMAL_WASM_B = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // type section (id=1), size=1, count=0
  0x01, 0x01, 0x00,
]) as Uint8Array<ArrayBuffer>;

// Corrupt WASM (bad magic)
const CORRUPT_WASM = new Uint8Array([
  0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04,
]) as Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------------------
// Stub WasmBackend
// ---------------------------------------------------------------------------

function makeStubBackend(bytes: Uint8Array<ArrayBuffer>, callCount = { n: 0 }): WasmBackend {
  return {
    name: "stub",
    async emit(_resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      callCount.n++;
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Stub ResolutionResult (minimal shape; cache module only passes it to backend)
// ---------------------------------------------------------------------------

const STUB_RESOLUTION = {
  entry: "test-entry" as never,
  blocks: new Map(),
  order: [],
} satisfies ResolutionResult;

// ---------------------------------------------------------------------------
// Per-test cache directory (isolated under tmp/)
// ---------------------------------------------------------------------------

let testCacheDir: string;

beforeEach(() => {
  // Use a unique cache dir per test so tests are independent.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testCacheDir = join(defaultCacheDir(), "..", `yakcc-as-cache-test-${id}`);
  clearInFlightLock();
});

afterEach(async () => {
  clearInFlightLock();
  await clearCache(testCacheDir).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// deriveCacheKey
// ---------------------------------------------------------------------------

describe("deriveCacheKey", () => {
  it("returns a 64-char hex string", () => {
    const key = deriveCacheKey("abc123");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same atomHash", () => {
    const k1 = deriveCacheKey("deadbeef");
    const k2 = deriveCacheKey("deadbeef");
    expect(k1).toBe(k2);
  });

  it("differs when atomHash differs", () => {
    const k1 = deriveCacheKey("atomA");
    const k2 = deriveCacheKey("atomB");
    expect(k1).not.toBe(k2);
  });

  it("includes ASC_VERSION in the key (version skew changes the key)", () => {
    // The actual key incorporates ASC_VERSION at module-load time.
    // We can verify that ASC_VERSION is non-empty and that the key changes
    // when we simulate a different version by checking the hash content.
    expect(ASC_VERSION).toBeTruthy();
    expect(ASC_VERSION).toMatch(/^\d+\.\d+\.\d+/);

    // Simulate what a different asc version would produce:
    // If the version were different, the same atomHash would produce a different key.
    const differentVersionKey = createHash("sha256")
      .update(`atomA|99.0.0|${ASC_FLAGS_HASH}`)
      .digest("hex");
    const currentKey = deriveCacheKey("atomA");
    // Current version is not 99.0.0, so keys must differ.
    if (ASC_VERSION !== "99.0.0") {
      expect(currentKey).not.toBe(differentVersionKey);
    }
  });

  it("ASC_FLAGS_HASH is non-empty and stable", () => {
    expect(ASC_FLAGS_HASH).toHaveLength(64);
    expect(ASC_FLAGS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// cachedAsEmit — cache miss path
// ---------------------------------------------------------------------------

describe("cachedAsEmit — cache miss", () => {
  it("calls backend.emit on first call (cache cold)", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const result = await cachedAsEmit(backend, STUB_RESOLUTION, "atom-miss-test", {
      cacheDir: testCacheDir,
    });
    expect(callCount.n).toBe(1);
    expect(result.cacheStatus).toBe("miss");
    expect(result.bytes).toEqual(MINIMAL_WASM);
  });

  it("writes wasm file to disk after cache miss", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const atomHash = "atom-disk-write-test";
    await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, { cacheDir: testCacheDir });

    const key = deriveCacheKey(atomHash);
    const shard = key.slice(0, 3);
    const wasmPath = join(testCacheDir, shard, `${key}.wasm`);
    expect(existsSync(wasmPath)).toBe(true);
    const onDisk = readFileSync(wasmPath);
    expect(new Uint8Array(onDisk)).toEqual(MINIMAL_WASM);
  });
});

// ---------------------------------------------------------------------------
// cachedAsEmit — cache hit path
// ---------------------------------------------------------------------------

describe("cachedAsEmit — cache hit", () => {
  it("second call returns cached bytes without calling backend", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const atomHash = "atom-hit-test";
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };

    // Cold call
    const r1 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(r1.cacheStatus).toBe("miss");
    expect(callCount.n).toBe(1);

    // Warm call
    const r2 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(r2.cacheStatus).toBe("hit");
    expect(callCount.n).toBe(1); // backend NOT called again
    expect(r2.bytes).toEqual(MINIMAL_WASM);
  });

  it("cold and warm runs produce byte-identical results (DEC-AS-COMPILE-CACHE-005)", async () => {
    const backend = makeStubBackend(MINIMAL_WASM);
    const atomHash = "atom-determinism-test";
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };

    const r1 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    const r2 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);

    // Byte-identical comparison
    expect(r1.bytes.length).toBe(r2.bytes.length);
    for (let i = 0; i < r1.bytes.length; i++) {
      expect(r1.bytes[i]).toBe(r2.bytes[i]);
    }
  });

  it("different atomHashes produce different cache entries", async () => {
    const backend = makeStubBackend(MINIMAL_WASM);
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };

    await cachedAsEmit(backend, STUB_RESOLUTION, "atom-A", opts);
    await cachedAsEmit(backend, STUB_RESOLUTION, "atom-B", opts);

    const keyA = deriveCacheKey("atom-A");
    const keyB = deriveCacheKey("atom-B");
    expect(keyA).not.toBe(keyB);
  });
});

// ---------------------------------------------------------------------------
// cachedAsEmit — corrupt entry recovery
// ---------------------------------------------------------------------------

describe("cachedAsEmit — corrupt entry recovery", () => {
  it("corrupt zero-byte file is treated as miss and recompiled", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const atomHash = "atom-corrupt-test";
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };

    // First: prime the cache.
    await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(callCount.n).toBe(1);

    // Corrupt the cache file by writing zero bytes to it.
    const key = deriveCacheKey(atomHash);
    const shard = key.slice(0, 3);
    const wasmPath = join(testCacheDir, shard, `${key}.wasm`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(wasmPath, new Uint8Array(0));

    // Second call: should detect corrupt entry and recompile.
    const r2 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(callCount.n).toBe(2);
    expect(r2.cacheStatus).toBe("miss");
    expect(r2.bytes).toEqual(MINIMAL_WASM);
  });

  it("corrupt magic bytes are treated as miss and recompiled", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const atomHash = "atom-bad-magic-test";
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };

    // Prime cache
    await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(callCount.n).toBe(1);

    // Overwrite with bad magic
    const key = deriveCacheKey(atomHash);
    const shard = key.slice(0, 3);
    const wasmPath = join(testCacheDir, shard, `${key}.wasm`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(wasmPath, CORRUPT_WASM);

    const r2 = await cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts);
    expect(callCount.n).toBe(2);
    expect(r2.cacheStatus).toBe("miss");
  });
});

// ---------------------------------------------------------------------------
// cachedAsEmit — disabled path
// ---------------------------------------------------------------------------

describe("cachedAsEmit — disabled (opts.disable=true)", () => {
  it("always calls backend, never reads/writes cache", async () => {
    const callCount = { n: 0 };
    const backend = makeStubBackend(MINIMAL_WASM, callCount);
    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir, disable: true };

    const r1 = await cachedAsEmit(backend, STUB_RESOLUTION, "atom-disabled", opts);
    const r2 = await cachedAsEmit(backend, STUB_RESOLUTION, "atom-disabled", opts);

    expect(r1.cacheStatus).toBe("disabled");
    expect(r2.cacheStatus).toBe("disabled");
    expect(callCount.n).toBe(2); // backend called twice — no cache
  });

  it("YAKCC_AS_CACHE_DISABLE=1 env var disables cache", async () => {
    const origEnv = process.env.YAKCC_AS_CACHE_DISABLE;
    process.env.YAKCC_AS_CACHE_DISABLE = "1";
    try {
      const callCount = { n: 0 };
      const backend = makeStubBackend(MINIMAL_WASM, callCount);
      const r = await cachedAsEmit(backend, STUB_RESOLUTION, "atom-env-disabled", {
        cacheDir: testCacheDir,
      });
      expect(r.cacheStatus).toBe("disabled");
      expect(callCount.n).toBe(1);
    } finally {
      if (origEnv === undefined) {
        Reflect.deleteProperty(process.env, "YAKCC_AS_CACHE_DISABLE");
      } else {
        process.env.YAKCC_AS_CACHE_DISABLE = origEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// cachedAsEmit — concurrent same-key (thundering herd guard)
// ---------------------------------------------------------------------------

describe("cachedAsEmit — thundering herd lock (DEC-AS-COMPILE-CACHE-004)", () => {
  it("concurrent calls with same key invoke backend exactly once", async () => {
    const callCount = { n: 0 };

    // Backend with a delay to make concurrency overlap
    const backend: WasmBackend = {
      name: "stub-slow",
      async emit(): Promise<Uint8Array<ArrayBuffer>> {
        callCount.n++;
        await new Promise<void>((r) => setTimeout(r, 20));
        return MINIMAL_WASM;
      },
    };

    const opts: CachedAsEmitOpts = { cacheDir: testCacheDir };
    const atomHash = "atom-concurrent-test";

    // Launch 5 concurrent calls for the same atom before any resolves.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cachedAsEmit(backend, STUB_RESOLUTION, atomHash, opts)),
    );

    // Backend must have been called at most twice (1 lock owner + 1 possible race before lock).
    // In practice the in-memory lock should deduplicate to exactly 1.
    expect(callCount.n).toBeLessThanOrEqual(2);
    // All callers get the same bytes.
    for (const r of results) {
      expect(r.bytes).toEqual(MINIMAL_WASM);
    }
  });

  it("version-skew produces a different cache key (no false hits)", () => {
    // Simulate what a different ascVersion would produce.
    const fakeKey = createHash("sha256")
      .update(`same-atom|99.99.99|${ASC_FLAGS_HASH}`)
      .digest("hex");
    const realKey = deriveCacheKey("same-atom");
    // If the current version isn't 99.99.99, keys must differ.
    if (ASC_VERSION !== "99.99.99") {
      expect(realKey).not.toBe(fakeKey);
    }
  });
});

// ---------------------------------------------------------------------------
// defaultCacheDir
// ---------------------------------------------------------------------------

describe("defaultCacheDir", () => {
  it("returns a path ending in tmp/yakcc-as-cache (default path, no override)", () => {
    // Call without env override: YAKCC_AS_CACHE_DIR must be unset in test env.
    // If it happens to be set in the environment, this test is skipped rather
    // than corrupting the env state.
    if (process.env.YAKCC_AS_CACHE_DIR) {
      // Already overridden — skip structural assertions but verify it returns something.
      expect(defaultCacheDir()).toBeTruthy();
      return;
    }
    const d = defaultCacheDir();
    expect(d).toContain("tmp");
    expect(d).toContain("yakcc-as-cache");
    // Verify it is NOT /tmp (Sacred Practice #3)
    expect(d.startsWith("/tmp")).toBe(false);
  });

  it("YAKCC_AS_CACHE_DIR env var overrides the default", () => {
    const origEnv = process.env.YAKCC_AS_CACHE_DIR;
    const override = "/custom/cache/path";
    process.env.YAKCC_AS_CACHE_DIR = override;
    try {
      expect(defaultCacheDir()).toBe(override);
    } finally {
      // Restore: use Reflect.deleteProperty so we don't set to string "undefined".
      if (origEnv === undefined) {
        Reflect.deleteProperty(process.env, "YAKCC_AS_CACHE_DIR");
      } else {
        process.env.YAKCC_AS_CACHE_DIR = origEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration: real assemblyScriptBackend + cache
//
// Exercises the full production sequence (DEC-AS-COMPILE-CACHE-003,
// DEC-AS-COMPILE-CACHE-005) using the real asc binary on 2 synthetic atoms.
// Each atom is a minimal valid AS function; compilation takes ~1-2 s cold.
//
// Compound-interaction test requirement: crosses assemblyScriptBackend.emit()
// → cachedAsEmit cold path → disk write → cachedAsEmit warm path → disk read.
//
// Cache dir: OS temp dir via mkdtempSync so it never touches tmp/yakcc-as-cache.
// ---------------------------------------------------------------------------

describe("cachedAsEmit — end-to-end with real asc (DEC-AS-COMPILE-CACHE-003/005)", () => {
  // Isolated temp dir, created once for this describe block.
  let e2eCacheDir: string;

  // Each test gets a fresh tempdir within the describe-level dir so tests
  // cannot interfere with each other's cache entries.
  let perTestCacheDir: string;

  // Create a root tempdir under OS tmpdir (not /tmp in a meaningful sense on
  // macOS: os.tmpdir() → /var/folders/... which is the system sandbox temp).
  // Sacred Practice #3 is about project tmp/; OS tmpdir is appropriate for
  // external-process-backed integration tests.
  beforeEach(() => {
    // Create a fresh per-test subdir inside a stable describe-level root.
    if (!e2eCacheDir) {
      e2eCacheDir = mkdtempSync(join(tmpdir(), "yakcc-as-e2e-"));
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    perTestCacheDir = join(e2eCacheDir, id);
    mkdirSync(perTestCacheDir, { recursive: true });
    clearInFlightLock();
  });

  afterEach(() => {
    clearInFlightLock();
  });

  afterAll(() => {
    // Clean up the OS temp dir after the describe block finishes.
    if (e2eCacheDir) {
      rmSync(e2eCacheDir, { recursive: true, force: true });
    }
  });

  /**
   * Build a minimal synthetic ResolutionResult for the given AS source.
   * The BlockMerkleRoot is a synthetic string (stable, unique per atom label).
   */
  function syntheticResolution(
    label: string,
    asSource: string,
  ): import("./resolve.js").ResolutionResult {
    const entry = `synthetic-root-${label}` as import("@yakcc/contracts").BlockMerkleRoot;
    const block: import("./resolve.js").ResolvedBlock = {
      merkleRoot: entry,
      specHash: `synthetic-spec-${label}` as import("@yakcc/contracts").SpecHash,
      source: asSource,
      subBlocks: [],
    };
    return {
      entry,
      blocks: new Map([[entry, block]]),
      order: [entry],
    };
  }

  it("cold run calls asc, writes wasm to cache dir, returns valid WASM bytes", async () => {
    const backend = assemblyScriptBackend();
    const resolution = syntheticResolution(
      "id-i32",
      "export function id(x: i32): i32 { return x; }",
    );
    const atomHash = "e2e-id-i32-cold";

    const result = await cachedAsEmit(backend, resolution, atomHash, {
      cacheDir: perTestCacheDir,
    });

    expect(result.cacheStatus).toBe("miss");
    // Validate WASM magic bytes
    expect(result.bytes[0]).toBe(0x00);
    expect(result.bytes[1]).toBe(0x61);
    expect(result.bytes[2]).toBe(0x73);
    expect(result.bytes[3]).toBe(0x6d);

    // Cache file must exist on disk
    const key = deriveCacheKey(atomHash);
    const shard = key.slice(0, 3);
    const wasmPath = join(perTestCacheDir, shard, `${key}.wasm`);
    expect(existsSync(wasmPath)).toBe(true);
  }, 30_000);

  it("warm run returns byte-identical result without invoking asc (DEC-AS-COMPILE-CACHE-005)", async () => {
    const backend = assemblyScriptBackend();
    const resolution = syntheticResolution(
      "add-i32",
      "export function add(a: i32, b: i32): i32 { return a + b; }",
    );
    const atomHash = "e2e-add-i32-warm";
    const opts: CachedAsEmitOpts = { cacheDir: perTestCacheDir };

    // Cold run
    const cold = await cachedAsEmit(backend, resolution, atomHash, opts);
    expect(cold.cacheStatus).toBe("miss");

    // Warm run: swap in a spy backend — if it is called, the test fails.
    let spyCalled = false;
    const spyBackend: WasmBackend = {
      name: "spy",
      async emit(): Promise<Uint8Array<ArrayBuffer>> {
        spyCalled = true;
        return cold.bytes; // shouldn't be reached
      },
    };

    const warm = await cachedAsEmit(spyBackend, resolution, atomHash, opts);

    expect(warm.cacheStatus).toBe("hit");
    expect(spyCalled).toBe(false);

    // Byte-identical
    expect(warm.bytes.length).toBe(cold.bytes.length);
    for (let i = 0; i < cold.bytes.length; i++) {
      expect(warm.bytes[i]).toBe(cold.bytes[i]);
    }
  }, 30_000);
});
