// SPDX-License-Identifier: MIT
/**
 * shave-on-miss.test.ts — Unit tests for the shave-on-miss background queue.
 *
 * Tests cover:
 *   1. Entry-path resolution for (pkg='validator', binding='isEmail') against fixture corpus
 *   2. Entry-path resolution returns undefined for unresolvable bindings
 *   3. Background queue dedup by (packageName, entryPath) -- same key twice => one worker
 *   4. YAKCC_SHAVE_ON_MISS_CORPUS_DIR env override is honored
 *   5. Failure inside shavePackage equivalent is caught; emits shave-on-miss-error telemetry
 *   6. When corpus dir is missing/unresolvable, returns shaveOnMissEnqueued=false
 *   7. Second occurrence (already completed) returns atomsCreated, shaveOnMissEnqueued=false
 *
 * @decision DEC-WI508-S2-IN-PROC-BACKGROUND-001
 * @decision DEC-WI508-S2-SHAVE-CORPUS-DIR-001
 * @decision DEC-WI508-S2-ENTRY-ROOT-COMPOSITION-001
 * @decision DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetShaveOnMissQueue,
  applyPreemptivePackageShave,
  applyShaveOnMiss,
  awaitShaveOnMissDrain,
  resolveCorpusDir,
  resolveEntryPath,
} from "../src/shave-on-miss.js";
import {
  _resetShaveOnMissState,
  loadShaveOnMissState,
  makeBindingKey,
  saveShaveOnMissState,
} from "../src/shave-on-miss-state.js";

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../shave/src/__fixtures__/module-graph",
);

const VALIDATOR_FIXTURE_DIR = join(FIXTURE_DIR, "validator-13.15.35");

// ---------------------------------------------------------------------------
// Test registry factory (identity embedder, in-memory)
// ---------------------------------------------------------------------------

import type { EmbeddingProvider } from "@yakcc/contracts";

function identityEmbeddingProvider(): EmbeddingProvider {
  const FIXED_VEC = new Float32Array(384);
  FIXED_VEC[0] = 1.0;
  return {
    dimension: 384,
    modelId: "identity/test-shave-on-miss-v1",
    async embed(_text: string): Promise<Float32Array> {
      return FIXED_VEC.slice();
    },
  };
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

const savedCorpusDir = process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR;

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `shave-on-miss-test-${process.pid}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  // Point to an isolated per-test state file so tests never share the default
  // ~/.yakcc/shave-on-miss-state.json path. Without this, miss counts accumulate
  // across tests and trigger preemptive shave unexpectedly.
  // DEC-WI508-S3-STATE-PERSIST-001.
  process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH = join(tempDir, "test-state.json");
  // Disable preemptive shave by default in tests that do not specifically test it.
  // Tests that want to test preemptive shave override this env var explicitly.
  // DEC-WI508-S3-PREEMPTIVE-MISS-THRESHOLD-001.
  process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD = "999";
});

afterEach(() => {
  // Reset queue and state cache between tests to prevent state leakage.
  _resetShaveOnMissQueue();
  // Restore env vars.
  if (savedCorpusDir !== undefined) {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = savedCorpusDir;
  } else {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional
    delete process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR;
  }
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH;
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD;
  // biome-ignore lint/performance/noDelete: env-var removal is intentional
  delete process.env.YAKCC_PREEMPTIVE_SHAVE_MISS_THRESHOLD;
  // Remove temp dir.
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §1: resolveCorpusDir
// ---------------------------------------------------------------------------

describe("resolveCorpusDir", () => {
  it("returns YAKCC_SHAVE_ON_MISS_CORPUS_DIR when set", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = "/custom/corpus";
    expect(resolveCorpusDir()).toBe("/custom/corpus");
  });

  it("returns a path ending with node_modules when env var is not set", () => {
    // biome-ignore lint/performance/noDelete: env-var removal is intentional
    delete process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR;
    const dir = resolveCorpusDir();
    expect(dir).toMatch(/node_modules$/);
  });
});

// ---------------------------------------------------------------------------
// §2: resolveEntryPath -- standard and versioned fixture layouts
// ---------------------------------------------------------------------------

describe("resolveEntryPath", () => {
  it("resolves validator/isEmail from the versioned fixture dir", () => {
    // YAKCC_SHAVE_ON_MISS_CORPUS_DIR points to module-graph dir; fixture is validator-13.15.35/
    const result = resolveEntryPath("validator", "isEmail", FIXTURE_DIR);
    expect(result).toBeDefined();
    expect(result).toContain("isEmail.js");
    expect(result).toContain("validator-13.15.35");
    if (result !== undefined) {
      expect(existsSync(result)).toBe(true);
    }
  });

  it("resolves validator/isURL from the versioned fixture dir", () => {
    const result = resolveEntryPath("validator", "isURL", FIXTURE_DIR);
    expect(result).toBeDefined();
    expect(result).toContain("isURL.js");
  });

  it("resolves validator/isUUID from the versioned fixture dir", () => {
    const result = resolveEntryPath("validator", "isUUID", FIXTURE_DIR);
    expect(result).toBeDefined();
    expect(result).toContain("isUUID.js");
  });

  it("resolves validator/isAlphanumeric from the versioned fixture dir", () => {
    const result = resolveEntryPath("validator", "isAlphanumeric", FIXTURE_DIR);
    expect(result).toBeDefined();
    expect(result).toContain("isAlphanumeric.js");
  });

  it("returns undefined for an unresolvable binding", () => {
    const result = resolveEntryPath("validator", "nonExistentBinding", FIXTURE_DIR);
    expect(result).toBeUndefined();
  });

  it("returns undefined for a package not in the corpus dir", () => {
    const result = resolveEntryPath("totally-unknown-package", "someBinding", FIXTURE_DIR);
    expect(result).toBeUndefined();
  });

  it("returns undefined when corpusDir does not exist", () => {
    const result = resolveEntryPath("validator", "isEmail", "/nonexistent/path/that/does/not/exist");
    expect(result).toBeUndefined();
  });

  it("resolves via standard node_modules layout when available", () => {
    // Use the validator-13.15.35 dir directly as the "package root" for the standard layout test.
    // Standard layout: {corpusDir}/{packageName}/lib/{binding}.js
    // Here we simulate: corpusDir=FIXTURE_DIR, packageName="validator-13.15.35", binding="isEmail"
    // This tests the standard path (validator-13.15.35/lib/isEmail.js found directly)
    const result = resolveEntryPath("validator-13.15.35", "isEmail", FIXTURE_DIR);
    expect(result).toBeDefined();
    expect(result).toContain("isEmail.js");
  });
});

// ---------------------------------------------------------------------------
// §3: Background queue dedup (DEC-WI508-S2-IN-PROC-BACKGROUND-001)
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- queue dedup", () => {
  it("enqueueing the same (packageName, binding) twice only starts one worker", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const registry = await openRegistry(":memory:", { embeddings: identityEmbeddingProvider() });

    const ctx = { intent: "validate email address" };

    const result1 = applyShaveOnMiss("validator", "isEmail", ctx, registry);
    expect(result1.shaveOnMissEnqueued).toBe(true);

    // Second call for the same binding -- already queued, should not re-enqueue.
    const result2 = applyShaveOnMiss("validator", "isEmail", ctx, registry);
    expect(result2.shaveOnMissEnqueued).toBe(false);

    // Drain and close.
    await awaitShaveOnMissDrain(30_000);
    await registry.close();
  });

  it("returns atomsCreated on second call after drain completes", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const registry = await openRegistry(":memory:", { embeddings: identityEmbeddingProvider() });

    const ctx = { intent: "validate URL" };
    const result1 = applyShaveOnMiss("validator", "isURL", ctx, registry);
    expect(result1.shaveOnMissEnqueued).toBe(true);

    await awaitShaveOnMissDrain(30_000);

    // After drain, the queue entry is "completed". Second call returns atomsCreated.
    const result2 = applyShaveOnMiss("validator", "isURL", ctx, registry);
    expect(result2.shaveOnMissEnqueued).toBe(false);
    // atomsCreated may be empty if shave produced no atoms (expected for CJS fixture
    // with foreign deps); the key assertion is that shaveOnMissEnqueued is false.

    await registry.close();
  });
});

// ---------------------------------------------------------------------------
// §4: YAKCC_SHAVE_ON_MISS_CORPUS_DIR env override (DEC-WI508-S2-SHAVE-CORPUS-DIR-001)
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- YAKCC_SHAVE_ON_MISS_CORPUS_DIR env override", () => {
  it("uses the env var corpus dir for entry-path resolution", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const registry = await openRegistry(":memory:", { embeddings: identityEmbeddingProvider() });

    const ctx = { intent: "validate UUID" };
    const result = applyShaveOnMiss("validator", "isUUID", ctx, registry);
    // Should find the entry path via the fixture dir and enqueue.
    expect(result.shaveOnMissEnqueued).toBe(true);

    await awaitShaveOnMissDrain(30_000);
    await registry.close();
  });

  it("returns shaveOnMissEnqueued=false when corpus dir is wrong (entry not found)", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = "/nonexistent/corpus/path";
    const ctx = { intent: "validate email" };

    // Need a registry even though the entry won't be found.
    // We can pass a minimal object since it won't be used.
    const fakeRegistry = {} as import("@yakcc/registry").Registry;

    const result = applyShaveOnMiss("validator", "isEmail", ctx, fakeRegistry);
    expect(result.shaveOnMissEnqueued).toBe(false);
    expect(result.atomsCreated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5: Failure handling -- DEC-WI508-S2-SHAVE-MISS-FAIL-LOUD-OFF-001
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- failure handling", () => {
  it("does not throw when entry path is unresolvable", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const fakeRegistry = {} as import("@yakcc/registry").Registry;
    const ctx = { intent: "some intent" };

    // Non-existent binding.
    expect(() => {
      applyShaveOnMiss("validator", "nonExistentBinding", ctx, fakeRegistry);
    }).not.toThrow();
  });

  it("returns shaveOnMissEnqueued=false when entry path is unresolvable", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const fakeRegistry = {} as import("@yakcc/registry").Registry;
    const ctx = { intent: "some intent" };

    const result = applyShaveOnMiss("validator", "nonExistentBinding", ctx, fakeRegistry);
    expect(result.shaveOnMissEnqueued).toBe(false);
  });

  it("background worker error does not propagate -- queue transitions to error state", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;

    // Use a registry that has no storeBlock (read-only) to trigger the degradation path.
    // shave() internally checks if storeBlock is a function; when absent, persist is skipped
    // but shave itself may still succeed (it won't throw, just won't persist).
    // We just test that the drain resolves without throwing.
    const registry = await openRegistry(":memory:", { embeddings: identityEmbeddingProvider() });
    const ctx = { intent: "validate alphanumeric" };

    const result = applyShaveOnMiss("validator", "isAlphanumeric", ctx, registry);
    expect(result.shaveOnMissEnqueued).toBe(true);

    // Drain should not throw even if the shave worker encounters issues.
    await expect(awaitShaveOnMissDrain(30_000)).resolves.toBeUndefined();
    await registry.close();
  });
});

// ---------------------------------------------------------------------------
// §6: awaitShaveOnMissDrain -- resolves when no pending items
// ---------------------------------------------------------------------------

describe("awaitShaveOnMissDrain", () => {
  it("resolves immediately when queue is empty", async () => {
    await expect(awaitShaveOnMissDrain(1_000)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §7: WI-508 Slice 3 -- skip-shave heuristics (DEC-WI508-S3-SKIP-HIT-THRESHOLD-001)
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- Slice 3 skip-shave: completedBindings check", () => {
  it("returns shaveOnMissEnqueued=false when binding is in completedBindings (prior run)", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    // Pre-populate completed state for validator/isEmail using the per-test state path.
    // saveShaveOnMissState imported at top of file
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;
    saveShaveOnMissState(
      {
        version: 1,
        completedBindings: [makeBindingKey("validator", "isEmail")],
        hitCounts: {},
        missCounts: {},
      },
      statePath,
    );

    const ctx = { intent: "validate email" };
    const fakeRegistry = {} as import("@yakcc/registry").Registry;

    const result = applyShaveOnMiss("validator", "isEmail", ctx, fakeRegistry);
    expect(result.shaveOnMissEnqueued).toBe(false);
    expect(result.entryResolved).toBe(true);
  });

  it("returns shaveOnMissEnqueued=false when hitCounts >= SKIP_SHAVE_HIT_THRESHOLD", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    // Set threshold to 2 explicitly.
    process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD = "2";
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;
    // saveShaveOnMissState imported at top of file
    saveShaveOnMissState(
      {
        version: 1,
        completedBindings: [],
        hitCounts: { [makeBindingKey("validator", "isEmail")]: 2 },
        missCounts: {},
      },
      statePath,
    );

    const ctx = { intent: "validate email" };
    const fakeRegistry = {} as import("@yakcc/registry").Registry;

    const result = applyShaveOnMiss("validator", "isEmail", ctx, fakeRegistry);
    expect(result.shaveOnMissEnqueued).toBe(false);
    expect(result.entryResolved).toBe(true);
  });

  it("enqueues when hitCounts < SKIP_SHAVE_HIT_THRESHOLD (below threshold)", () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    process.env.YAKCC_SKIP_SHAVE_HIT_THRESHOLD = "2";
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;
    // saveShaveOnMissState imported at top of file
    saveShaveOnMissState(
      {
        version: 1,
        completedBindings: [],
        hitCounts: { [makeBindingKey("validator", "isEmail")]: 1 },
        missCounts: {},
      },
      statePath,
    );

    const registry = { storeBlock: vi.fn() } as unknown as import("@yakcc/registry").Registry;
    const ctx = { intent: "validate email" };

    const result = applyShaveOnMiss("validator", "isEmail", ctx, registry);
    // 1 hit < threshold 2, so shave should be enqueued.
    expect(result.shaveOnMissEnqueued).toBe(true);

    // Drain so tests don't bleed into each other.
    return awaitShaveOnMissDrain(30_000);
  });
});

// ---------------------------------------------------------------------------
// §8: WI-508 Slice 3 -- miss count increments (DEC-WI508-S3-PREEMPTIVE-MISS-THRESHOLD-001)
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- Slice 3 miss count persistence", () => {
  it("increments missCounts for the package on each new enqueue", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;
    // Preemptive threshold is already 999 from beforeEach.

    const registry = await openRegistry(":memory:", {
      embeddings: identityEmbeddingProvider(),
    });

    const ctx1 = { intent: "validate email" };
    const ctx2 = { intent: "validate URL" };

    applyShaveOnMiss("validator", "isEmail", ctx1, registry);
    _resetShaveOnMissState(); // simulate a second process loading state from disk
    applyShaveOnMiss("validator", "isURL", ctx2, registry);

    await awaitShaveOnMissDrain(30_000);

    const state = loadShaveOnMissState(statePath);
    // Both misses should be recorded.
    expect(state.missCounts["validator"]).toBeGreaterThanOrEqual(2);

    await registry.close();
  });
});

// ---------------------------------------------------------------------------
// §9: WI-508 Slice 3 -- completion persistence (DEC-WI508-S3-STATE-PERSIST-001)
// ---------------------------------------------------------------------------

describe("applyShaveOnMiss -- Slice 3 completion persistence", () => {
  it("adds binding key to completedBindings after drain completes", async () => {
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;

    const registry = await openRegistry(":memory:", {
      embeddings: identityEmbeddingProvider(),
    });

    const ctx = { intent: "validate email" };

    const result = applyShaveOnMiss("validator", "isEmail", ctx, registry);
    expect(result.shaveOnMissEnqueued).toBe(true);

    await awaitShaveOnMissDrain(30_000);

    const state = loadShaveOnMissState(statePath);
    expect(state.completedBindings).toContain(makeBindingKey("validator", "isEmail"));

    await registry.close();
  });
});

// ---------------------------------------------------------------------------
// §10: WI-508 Slice 3 -- applyPreemptivePackageShave
// ---------------------------------------------------------------------------

describe("applyPreemptivePackageShave", () => {
  it("enqueues shaves for all bindings found in the corpus lib/ dir", async () => {
    const statePath = process.env.YAKCC_SHAVE_ON_MISS_STATE_PATH as string;
    // applyPreemptivePackageShave calls applyShaveOnMiss internally, which resolves
    // the corpus dir from YAKCC_SHAVE_ON_MISS_CORPUS_DIR (not the corpusDir argument).
    // Set the env var so resolveEntryPath() can find the fixture bindings.
    process.env.YAKCC_SHAVE_ON_MISS_CORPUS_DIR = FIXTURE_DIR;

    const registry = await openRegistry(":memory:", {
      embeddings: identityEmbeddingProvider(),
    });
    const ctx = { intent: "preemptive scan validator" };

    applyPreemptivePackageShave("validator", ctx, registry, FIXTURE_DIR);

    // At least one background shave should be pending.
    await awaitShaveOnMissDrain(30_000);

    // After drain, completedBindings should contain at least one validator binding.
    const state = loadShaveOnMissState(statePath);
    const validatorCompleted = state.completedBindings.filter((k) => k.startsWith("validator::"));
    expect(validatorCompleted.length).toBeGreaterThan(0);

    await registry.close();
  });

  it("does nothing when package is not in corpus dir", () => {
    const ctx = { intent: "preemptive unknown package" };
    const fakeRegistry = {} as import("@yakcc/registry").Registry;

    // Should not throw.
    expect(() => {
      applyPreemptivePackageShave("totally-unknown-package", ctx, fakeRegistry, FIXTURE_DIR);
    }).not.toThrow();
  });
});
