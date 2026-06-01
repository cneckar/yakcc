/**
 * Tests for openRegistryMatchingStoredProvider (registry-open.ts).
 *
 * @decision DEC-1069-REFEMIT-PROVIDER-001
 * @title registry-open — provider-matching helper for reference+compile tools
 * @status decided (wi-1069)
 * @rationale
 *   openRegistryMatchingStoredProvider must open registries embedded with EITHER
 *   createLocalEmbeddingProvider (Xenova/bge-small-en-v1.5, standard production
 *   registries) OR createOfflineEmbeddingProvider (yakcc/offline-blake3-stub,
 *   bootstrap registries) without throwing a provider-mismatch error.
 *
 *   Test strategy:
 *   (1) Opens a registry whose stored model is Xenova/bge-small-en-v1.5 without
 *       throwing. The registry is created with a lightweight fake provider whose
 *       modelId is "Xenova/bge-small-en-v1.5" (matches the real LOCAL_MODEL_ID)
 *       so the guard accepts it.  No model download is required because
 *       openRegistryMatchingStoredProvider only calls embed() on a vector search,
 *       which these tests never issue.
 *   (2) Opens a registry whose stored model is "yakcc/offline-blake3-stub" without
 *       throwing (fallback arm of the probe chain).
 *   (3) An unrecoverable error (bad file path, not a mismatch) is re-thrown.
 *
 *   This is the compound-interaction test for the production fix: it exercises
 *   the full openRegistryMatchingStoredProvider path end-to-end, crossing the
 *   local-provider probe → mismatch detection → offline fallback boundaries.
 *
 * Implements: yakcc#1069
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRegistryMatchingStoredProvider } from "./registry-open.js";

// ---------------------------------------------------------------------------
// Helpers — create seeded registry files on disk
// ---------------------------------------------------------------------------

/**
 * Create a real SQLite registry at `filePath` using the given modelId.
 *
 * Uses a lightweight fake EmbeddingProvider (no model download) whose modelId
 * is set to `modelId`. The registry stores this modelId in registry_meta so
 * openRegistryMatchingStoredProvider's probe logic exercises the right branch.
 */
async function seedRegistryFile(filePath: string, modelId: string): Promise<void> {
  const { openRegistry } = await import("@yakcc/registry");
  const fakeProvider = {
    modelId,
    dimension: 384,
    async embed(_text: string): Promise<Float32Array> {
      // Deterministic dummy vector — never used in these tests.
      return new Float32Array(384).fill(0.1);
    },
  };
  // Open (creates the file) and immediately close — we just need the metadata written.
  const reg = await openRegistry(filePath, { embeddings: fakeProvider });
  await reg.close();
}

// ---------------------------------------------------------------------------
// Suite setup — create temp dir inside project tmp/ (Sacred Practice #3)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  const projectTmp = new URL("../../../../../tmp", import.meta.url).pathname;
  await mkdir(projectTmp, { recursive: true });
  // Unique per-test directory to avoid collision between parallel runs.
  const unique = `registry-open-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpDir = join(projectTmp, unique);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) Opens a local-embedded (Xenova/bge-small-en-v1.5) registry successfully
// ---------------------------------------------------------------------------

describe("openRegistryMatchingStoredProvider — local-embedded registry (compound)", () => {
  it(
    "(1) opens a registry stored with Xenova/bge-small-en-v1.5 without mismatch error",
    async () => {
      // Seed a registry that stores "Xenova/bge-small-en-v1.5" as the embedding model.
      // This simulates the standard production registry built by yakcc bootstrap or
      // seedRegistry() on the default local path.
      const registryPath = join(tmpDir, "local-embedded.sqlite");
      await seedRegistryFile(registryPath, "Xenova/bge-small-en-v1.5");

      // This is the compound-interaction test: openRegistryMatchingStoredProvider
      // probe-opens with createLocalEmbeddingProvider() → modelId matches stored
      // "Xenova/bge-small-en-v1.5" → no throw → registry returned.
      // Pre-fix: calling openRegistry with createOfflineEmbeddingProvider() explicitly
      // would throw embedding_model_mismatch here (the production bug, issue #1069).
      let registry: Awaited<ReturnType<typeof openRegistryMatchingStoredProvider>> | undefined;
      await expect(
        openRegistryMatchingStoredProvider(registryPath).then((r) => {
          registry = r;
          return r;
        }),
      ).resolves.toBeDefined();

      // Registry is functional: enumerateSpecs returns an empty async iterable (no blocks stored).
      const specs = await registry!.enumerateSpecs();
      expect(Array.isArray(specs)).toBe(true);

      await registry!.close();
    },
  );
});

// ---------------------------------------------------------------------------
// (2) Opens an offline-embedded (yakcc/offline-blake3-stub) registry successfully
// ---------------------------------------------------------------------------

describe("openRegistryMatchingStoredProvider — offline-embedded registry", () => {
  it(
    "(2) opens a registry stored with yakcc/offline-blake3-stub via fallback arm",
    async () => {
      // Seed a registry that stores "yakcc/offline-blake3-stub".
      // This simulates a registry built by yakcc bootstrap (offline/air-gapped mode).
      const registryPath = join(tmpDir, "offline-embedded.sqlite");
      await seedRegistryFile(registryPath, "yakcc/offline-blake3-stub");

      // openRegistryMatchingStoredProvider tries local provider first → mismatch
      // ("Xenova/bge-small-en-v1.5" ≠ "yakcc/offline-blake3-stub") → retries with
      // createOfflineEmbeddingProvider() → matches → registry returned.
      let registry: Awaited<ReturnType<typeof openRegistryMatchingStoredProvider>> | undefined;
      await expect(
        openRegistryMatchingStoredProvider(registryPath).then((r) => {
          registry = r;
          return r;
        }),
      ).resolves.toBeDefined();

      const specs = await registry!.enumerateSpecs();
      expect(Array.isArray(specs)).toBe(true);

      await registry!.close();
    },
  );
});

// ---------------------------------------------------------------------------
// (3) Unrecoverable errors (not mismatch) are re-thrown
// ---------------------------------------------------------------------------

describe("openRegistryMatchingStoredProvider — non-mismatch errors propagate", () => {
  it("(3) throws on a path that is not a valid SQLite file", async () => {
    // Write a non-SQLite file to trigger an open error.
    const badPath = join(tmpDir, "not-a-db.sqlite");
    await writeFile(badPath, "this is not sqlite\n", "utf8");

    // Should throw — the error is not embedding_model_mismatch, so it propagates.
    await expect(openRegistryMatchingStoredProvider(badPath)).rejects.toThrow();
  });
});
