/**
 * Public-API integration tests for universalize(), shave(), and
 * createIntentExtractionHook() — exercised via the pre-seeded cache path.
 *
 * Production trigger: universalize() is called by the continuous universalizer
 * loop; shave() is called by the CLI. These tests verify that the wired
 * universalize → extractIntent path correctly reads from cache, throws the
 * right error on offline+cache-miss, and throws on missing API key.
 *
 * The public universalize() signature does not accept a client injection option,
 * so tests drive the wired path by:
 *   a. Pre-seeding the cache with a valid IntentCard, then calling
 *      universalize(..., { cacheDir, offline: true }).
 *   b. Calling universalize(..., { offline: true }) without a seed to assert
 *      OfflineCacheMissError.
 *   c. Calling universalize(...) without API key to assert
 *      AnthropicApiKeyMissingError.
 *
 * Compound-interaction test: the "createIntentExtractionHook → intercept path"
 * test crosses universalize, extractIntent, the file-cache, and the key
 * derivation module in the same sequence the hook pipeline uses in production.
 */

import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIntent } from "./cache/file-cache.js";
import { keyFromIntentInputs, sourceHash } from "./cache/key.js";
import {
  AnthropicApiKeyMissingError,
  OfflineCacheMissError,
  createIntentExtractionHook,
  shave,
  universalize,
} from "./index.js";
import { DEFAULT_MODEL, INTENT_PROMPT_VERSION, INTENT_SCHEMA_VERSION } from "./intent/constants.js";
import type { IntentCard } from "./intent/types.js";
import type { ShaveRegistryView } from "./types.js";

// ---------------------------------------------------------------------------
// Shared noop registry
// ---------------------------------------------------------------------------

const noopRegistry: ShaveRegistryView = {
  selectBlocks(_specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
    return Promise.resolve([]);
  },
  getBlock(_merkleRoot: BlockMerkleRoot) {
    return Promise.resolve(undefined);
  },
};

// ---------------------------------------------------------------------------
// Per-test tmpdir + API key isolation
// ---------------------------------------------------------------------------

let cacheDir: string;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `index-test-${unique}`);
  await mkdir(cacheDir, { recursive: true });
  // Remove API key so tests don't accidentally make live calls
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Helper: pre-seed a valid IntentCard into the cache
// ---------------------------------------------------------------------------

async function seedCache(source: string, overrides?: Partial<IntentCard>): Promise<IntentCard> {
  const sh = sourceHash(source);
  const key = keyFromIntentInputs({
    sourceHash: sh,
    modelTag: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });
  const card: IntentCard = {
    schemaVersion: 1,
    behavior: "Parses comma-separated integers from a string",
    inputs: [{ name: "s", typeHint: "string", description: "Input string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    sourceHash: sh,
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
  await writeIntent(cacheDir, key, card);
  return card;
}

// ---------------------------------------------------------------------------
// universalize() — wired path tests
// ---------------------------------------------------------------------------

describe("universalize() — wired to extractIntent + decompose + slice", () => {
  it("offline + cache hit: returns the cached IntentCard via universalize", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\nfunction parseIntList(s: string) { return s.split(',').map(Number); }";
    const seeded = await seedCache(source);

    const result = await universalize({ source }, noopRegistry, { cacheDir, offline: true });

    expect(result.intentCard.schemaVersion).toBe(1);
    expect(result.intentCard.behavior).toBe(seeded.behavior);
    expect(result.intentCard.sourceHash).toBe(seeded.sourceHash);
    // WI-012-06: decomposition is now live — slicePlan is populated, not [].
    expect(result.slicePlan.length).toBeGreaterThan(0);
    // noopRegistry has no findByCanonicalAstHash → all entries are novel-glue.
    expect(result.slicePlan.every((e) => e.kind === "novel-glue")).toBe(true);
    // No registry matches → matchedPrimitives is empty.
    expect(result.matchedPrimitives).toEqual([]);
    // "decomposition" removed from stubbed — it is now live.
    expect(result.diagnostics.stubbed).not.toContain("decomposition");
    expect(result.diagnostics.stubbed).toContain("variance");
    // license-gate is now live (WI-013-02) — no longer in stubbed.
    expect(result.diagnostics.stubbed).not.toContain("license-gate");
  });

  it("offline + cache miss: throws OfflineCacheMissError", async () => {
    await expect(
      universalize(
        { source: "// SPDX-License-Identifier: MIT\nconst x = 999;" },
        noopRegistry,
        { cacheDir, offline: true },
      ),
    ).rejects.toThrow(OfflineCacheMissError);
  });

  it("no API key + non-offline: throws AnthropicApiKeyMissingError", async () => {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      universalize({ source: "// SPDX-License-Identifier: MIT\nconst y = 1;" }, noopRegistry, { cacheDir }),
    ).rejects.toThrow(AnthropicApiKeyMissingError);
  });

  it("diagnostics always contain cacheHits=0 and cacheMisses=0 (wired stub fields)", async () => {
    const source = "// SPDX-License-Identifier: MIT\nfunction diagTest() {}";
    await seedCache(source);

    const result = await universalize({ source }, noopRegistry, { cacheDir, offline: true });
    // The diagnostics.cacheHits/cacheMisses in the UniversalizeResult envelope are
    // sentinel zeros (cache tracking is WI-011). The actual cache hit is transparent.
    expect(result.diagnostics.cacheHits).toBe(0);
    expect(result.diagnostics.cacheMisses).toBe(0);
    // "decomposition" is no longer in stubbed — it is live as of WI-012-06.
    expect(result.diagnostics.stubbed).not.toContain("decomposition");
  });
});

// ---------------------------------------------------------------------------
// shave() — live wiring (WI-014-01)
// ---------------------------------------------------------------------------
// shave() is now a real file-ingestion pipeline. These tests drive it via
// a pre-seeded cache (offline=true) so no live Anthropic calls are made.

describe("shave() — live wiring (WI-014-01)", () => {
  it("throws an error mentioning the path when source file is not found", async () => {
    await expect(shave("/nonexistent/path/dummy.ts", noopRegistry)).rejects.toThrow(
      /source file not found/,
    );
  });

  it("offline + cache hit: returns non-empty atoms and intentCards for a real file", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\nfunction shaveTest(x: number) { return x + 1; }";
    await seedCache(source);

    const { writeFile, rm: rmFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const tmpPath = joinPath(tmpdir(), `shave-live-test-${randomUUID()}.ts`);
    await writeFile(tmpPath, source, "utf-8");
    try {
      const result = await shave(tmpPath, noopRegistry, { cacheDir, offline: true });
      expect(result.sourcePath).toBe(tmpPath);
      expect(result.intentCards.length).toBeGreaterThan(0);
      expect(result.atoms.length).toBeGreaterThan(0);
      // atoms carry deterministic placeholderIds keyed on canonicalAstHash
      expect(result.atoms[0]?.placeholderId).toMatch(/^shave-atom-/);
      // "decomposition" is live — not in stubbed
      expect(result.diagnostics.stubbed).not.toContain("decomposition");
      // "variance" is still stubbed (WI-014)
      expect(result.diagnostics.stubbed).toContain("variance");
    } finally {
      await rmFile(tmpPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createIntentExtractionHook() — compound interaction test
// -------------------------------------------------------------------------
// Exercises: hook factory → intercept → universalize → extractIntent →
// file-cache (read from pre-seeded cache) — crossing all layers in sequence.
// ---------------------------------------------------------------------------

describe("createIntentExtractionHook() — compound interaction", () => {
  it("intercept delegates to universalize and returns cached IntentCard", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\nfunction hookTest(x: number) { return x * 2; }";
    const seeded = await seedCache(source, { behavior: "Doubles its input" });

    const hook = createIntentExtractionHook();
    expect(hook.id).toBe("yakcc.shave.default");

    const result = await hook.intercept({ source }, noopRegistry, { cacheDir, offline: true });
    expect(result.intentCard.behavior).toBe("Doubles its input");
    expect(result.intentCard.sourceHash).toBe(seeded.sourceHash);
    // WI-012-06: slicePlan is now populated by the real slicer.
    expect(result.slicePlan.length).toBeGreaterThan(0);
  });

  it("hook shape: id and intercept present", () => {
    const hook = createIntentExtractionHook();
    expect(typeof hook.id).toBe("string");
    expect(typeof hook.intercept).toBe("function");
  });

  it("hook.intercept offline + cache miss → throws OfflineCacheMissError", async () => {
    const hook = createIntentExtractionHook();
    await expect(
      hook.intercept(
        { source: "// SPDX-License-Identifier: MIT\nconst z = 42;" },
        noopRegistry,
        { cacheDir, offline: true },
      ),
    ).rejects.toThrow(OfflineCacheMissError);
  });
});
