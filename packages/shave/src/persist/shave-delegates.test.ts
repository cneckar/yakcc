/**
 * shave-delegates.test.ts — WI-423 regression: shave() delegates persistence
 * to universalize({persist:true}) — single authority (Sacred Practice #12).
 *
 * @decision DEC-V2-SHAVE-DELEGATES-UNIVERSALIZE-001 (WI-423)
 * title: shave() delegates atom persistence to universalize({persist:true})
 * status: accepted (WI-423)
 * rationale:
 *   WI-373 (PR #419) introduced universalize({persist:true}) as the canonical
 *   persistence primitive but left shave() with a duplicate inline loop. WI-423
 *   removes that loop and makes shave() call universalize({persist:true}).
 *
 *   This test suite guards against two regressions:
 *
 *   1. Double-persist (universalize called twice): storeBlock would be called
 *      2N times instead of N times for N novel-glue entries. We count storeBlock
 *      invocations on a spy registry and assert exactly N calls.
 *
 *   2. Zero-persist (universalize not called for persistence): storeBlock would
 *      be called 0 times. Same assertion catches this.
 *
 *   Because shave() and universalize() are co-located in the same module, a
 *   direct vi.spyOn(module, "universalize") cannot intercept the internal call.
 *   We instead verify the delegation contract through its observable side-effect:
 *   storeBlock call count matches novel-glue entry count exactly.
 *
 * Production trigger:
 *   shave() is the primary entry point for file-level bootstrap (bootstrap.ts
 *   walker). Every source file in the corpus passes through shave() with a full
 *   Registry. Incorrect call count here would silently corrupt the bootstrap DB
 *   (too many rows) or produce empty atoms (zero rows).
 *
 * Mocking boundary:
 *   - storeBlock: counted via a spy wrapper around an in-memory openRegistry.
 *     We use a real Registry so the underlying SQLite receives correct rows —
 *     the count is measured at the shave() call boundary, not mocked away.
 *   - Anthropic API: bypassed via intentStrategy:"static".
 *   - Filesystem: shave() reads a tmpFile; we write ATOMIC_SOURCE to it.
 *
 * Air-gap compliance:
 *   intentStrategy:"static" — no network, no API key required.
 */

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shave } from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * ATOMIC_SOURCE: single-leaf source (zero CF boundaries).
 * MIT license → passes the license gate.
 * Produces exactly one NovelGlueEntry → exactly one storeBlock call.
 */
const ATOMIC_SOURCE = `// SPDX-License-Identifier: MIT
const isDigit = (c: string): boolean => c >= "0" && c <= "9";`;

/**
 * MULTI_LEAF_SOURCE: two top-level if-statements (CF boundaries = 2 > 1).
 * Produces multiple NovelGlueEntries → multiple storeBlock calls.
 */
const MULTI_LEAF_SOURCE = [
  "// SPDX-License-Identifier: MIT",
  "declare const a: boolean;",
  "declare const b: boolean;",
  'if (a) { console.log("a-branch"); }',
  'if (b) { console.log("b-branch"); }',
].join("\n");

// ---------------------------------------------------------------------------
// Mock embedding provider — deterministic, no ONNX required
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider-shave-delegates",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let cacheDir: string;
let tmpFilePath: string;
let registry: Registry;

beforeEach(async () => {
  const unique = randomUUID();
  cacheDir = join(tmpdir(), `shave-delegates-test-${unique}`);
  tmpFilePath = join(tmpdir(), `shave-delegates-src-${unique}.ts`);
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await registry.close();
  await rm(tmpFilePath, { force: true });
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Spy registry wrapper — counts storeBlock invocations
// ---------------------------------------------------------------------------

/**
 * Wraps a Registry's storeBlock method with a call counter.
 * Returns the wrapped registry and a getter for the call count.
 *
 * Using a real registry (not a mock) ensures that:
 * - SQLite receives correct rows (no silent corruption).
 * - Idempotency (INSERT OR IGNORE) is exercised by the real storage layer.
 * - The count reflects actual delegation calls, not internal retries.
 */
function withStoreBlockSpy(reg: Registry): {
  spyRegistry: Registry;
  getStoreBlockCallCount: () => number;
} {
  let callCount = 0;
  const originalStoreBlock = reg.storeBlock.bind(reg);
  const spyRegistry: Registry = {
    ...reg,
    storeBlock: async (row) => {
      callCount++;
      return originalStoreBlock(row);
    },
  };
  return { spyRegistry, getStoreBlockCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// WI-423 regression: storeBlock call count = novel-glue entry count
//
// If shave() calls universalize() twice (double-persist), storeBlock would be
// called 2N times. If shave() reverts to an inline loop + universalize(), it
// would be called 2N or more times. Exactly N calls proves single delegation.
// ---------------------------------------------------------------------------

describe("WI-423 regression: shave() delegates to universalize({persist:true}) exactly once", () => {
  it("single-leaf source: storeBlock called exactly once (not zero, not twice)", async () => {
    await writeFile(tmpFilePath, ATOMIC_SOURCE, "utf-8");

    const { spyRegistry, getStoreBlockCallCount } = withStoreBlockSpy(registry);

    const result = await shave(tmpFilePath, spyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
    });

    // Exactly 1 novel-glue entry for ATOMIC_SOURCE → exactly 1 storeBlock call.
    const novelGlueAtoms = result.atoms.filter((a) => a.merkleRoot !== undefined);
    expect(novelGlueAtoms.length, "ATOMIC_SOURCE must produce exactly 1 persisted atom").toBe(1);

    expect(
      getStoreBlockCallCount(),
      "storeBlock must be called exactly once — not zero (no persist) and not twice (double-persist)",
    ).toBe(1);
  }, 60_000);

  it("multi-leaf source: storeBlock called exactly N times (one per novel-glue entry, no double-persist)", async () => {
    await writeFile(tmpFilePath, MULTI_LEAF_SOURCE, "utf-8");

    const { spyRegistry, getStoreBlockCallCount } = withStoreBlockSpy(registry);

    const result = await shave(tmpFilePath, spyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
    });

    const novelGlueAtoms = result.atoms.filter((a) => a.merkleRoot !== undefined);
    expect(
      novelGlueAtoms.length,
      "MULTI_LEAF_SOURCE must produce > 1 persisted atoms",
    ).toBeGreaterThan(1);

    // storeBlock must be called exactly once per novel-glue entry.
    // If the old inline loop runs in addition to universalize({persist:true}),
    // this count would be double. If universalize is not called, it would be 0.
    expect(
      getStoreBlockCallCount(),
      "storeBlock call count must equal novel-glue atom count (single delegation)",
    ).toBe(novelGlueAtoms.length);
  }, 60_000);

  it("read-only registry (no storeBlock): shave() completes without error, zero atoms persisted", async () => {
    // Graceful degradation: when registry.storeBlock is absent, shave() must
    // not throw — it returns atoms with merkleRoot=undefined. This verifies
    // that the hasPersist guard in the refactored shave() works correctly.
    await writeFile(tmpFilePath, ATOMIC_SOURCE, "utf-8");

    const readOnlyRegistry = {
      selectBlocks: registry.selectBlocks.bind(registry),
      getBlock: registry.getBlock.bind(registry),
      findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
      // storeBlock intentionally absent — read-only view
    };

    const result = await shave(tmpFilePath, readOnlyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
    });

    // No atoms persisted (no storeBlock), but shave() must succeed.
    const persistedAtoms = result.atoms.filter((a) => a.merkleRoot !== undefined);
    expect(persistedAtoms.length, "Read-only registry: no atoms should be persisted").toBe(0);

    // atoms array must still be populated (stubs exist even without persistence).
    expect(
      result.atoms.length,
      "atoms array must be non-empty even without persistence",
    ).toBeGreaterThan(0);
  }, 60_000);
});
