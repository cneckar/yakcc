// @mock-exempt: @anthropic-ai/sdk is an external third-party SDK boundary (network I/O,
// API key, cloud service). The vi.mock here proves the static path NEVER touches
// the SDK — it is a negative proof (assert no import occurs), which cannot be
// achieved with a real implementation or in-memory fixture. This is the canonical
// acceptable mock use case per Sacred Practice #5.

/**
 * Integration test for the static intent extraction path.
 *
 * Two key proofs:
 *
 * 1. **No SDK import on static path.** vi.mock("@anthropic-ai/sdk") is
 *    configured to throw on any import attempt. The test calls universalize()
 *    with intentStrategy: "static" — if the static path ever imports the SDK,
 *    the mock throws and the test fails. This proves the Anthropic SDK is
 *    completely inert on the static hot path.
 *
 * 2. **Cache namespaces are disjoint.** Seed an LLM-mode card via
 *    seedIntentCache (using DEFAULT_MODEL / INTENT_PROMPT_VERSION tags), then
 *    call universalize() with intentStrategy: "static". The static path must
 *    MISS the LLM-cached entry (different key namespace) and produce its own
 *    file. Both files coexist with different cache keys.
 *
 * Production trigger sequence: orchestrator dispatches shave/universalize per
 * candidate block. The static path is the new default (strategy: "static").
 * These tests exercise the full public surface — universalize() → extractIntent()
 * → staticExtract() — to confirm correct wiring under realistic conditions.
 */

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIntentCard } from "./validate-intent-card.js";

// Mock @anthropic-ai/sdk to throw on any import attempt.
// If the static path ever imports the SDK, this mock will cause the import to fail.
vi.mock("@anthropic-ai/sdk", () => {
  throw new Error(
    "STATIC PATH MUST NOT IMPORT @anthropic-ai/sdk — SDK mock triggered unexpectedly",
  );
});

import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
// Import AFTER the mock is set up.
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
  STATIC_MODEL_TAG,
  STATIC_PROMPT_VERSION,
  seedIntentCache,
  universalize,
} from "../index.js";
import type { IntentCard } from "./types.js";

// ---------------------------------------------------------------------------
// Per-test tmpdir
// ---------------------------------------------------------------------------

let cacheDir: string;

const NULL_REGISTRY = {
  async selectBlocks() {
    return [];
  },
  async getBlock() {
    return undefined;
  },
};

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `static-extract-integration-${unique}`);
  await fsPromises.mkdir(cacheDir, { recursive: true });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await fsPromises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("static intent extraction integration", () => {
  // -------------------------------------------------------------------------
  // Proof 1: no SDK import on static path
  // -------------------------------------------------------------------------

  it("universalize() with intentStrategy: 'static' never imports @anthropic-ai/sdk", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\n/** Sums two ints. @requires a >= 0 */ export function add(a: number, b: number): number { return a + b; }";

    // This will throw if @anthropic-ai/sdk is imported (vi.mock above intercepts it)
    const result = await universalize({ source }, NULL_REGISTRY, {
      intentStrategy: "static",
      cacheDir,
    });

    // Verify the card has the expected static-path fields
    const card = result.intentCard;
    expect(card.modelVersion).toBe(STATIC_MODEL_TAG);
    expect(card.promptVersion).toBe(STATIC_PROMPT_VERSION);
    expect(card.schemaVersion).toBe(1);
    expect(card.sourceHash).toHaveLength(64);
    expect(card.behavior).toBe("Sums two ints.");
    expect(card.preconditions).toContain("a >= 0");
    expect(card.inputs).toHaveLength(2);
    expect(card.inputs[0]).toMatchObject({ name: "a", typeHint: "number" });
    expect(card.inputs[1]).toMatchObject({ name: "b", typeHint: "number" });
    expect(card.outputs).toHaveLength(1);
    expect(card.outputs[0]).toMatchObject({ name: "return", typeHint: "number" });
    validateIntentCard(card); // must not throw
  });

  // -------------------------------------------------------------------------
  // Proof 2: no-JSDoc fallback via universalize
  // -------------------------------------------------------------------------

  it("static path: no-JSDoc source produces valid card with synthesized behavior", async () => {
    const source = "// SPDX-License-Identifier: MIT\nexport const id = (x: string): string => x;";

    const result = await universalize({ source }, NULL_REGISTRY, {
      intentStrategy: "static",
      cacheDir,
    });

    const card = result.intentCard;
    expect(card.modelVersion).toBe(STATIC_MODEL_TAG);
    // Behavior should be the synthesized signature string (no JSDoc)
    expect(card.behavior).toContain("id");
    expect(card.behavior).not.toMatch(/[\n\r]/);
    validateIntentCard(card);
  });

  // -------------------------------------------------------------------------
  // Proof 3: Cache namespaces are disjoint
  // -------------------------------------------------------------------------

  it("LLM-seeded card and static card have different keys (disjoint namespaces)", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\nexport function triple(n: number): number { return n * 3; }";

    // Seed an LLM-mode card (uses DEFAULT_MODEL / INTENT_PROMPT_VERSION tags)
    const llmCard: IntentCard = {
      schemaVersion: 1,
      behavior: "LLM-seeded card for triple",
      inputs: [{ name: "n", typeHint: "number", description: "" }],
      outputs: [{ name: "return", typeHint: "number", description: "" }],
      preconditions: [],
      postconditions: [],
      notes: [],
      modelVersion: DEFAULT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      sourceHash: sourceHash(source),
      extractedAt: new Date().toISOString(),
    };
    await seedIntentCache({ source, cacheDir }, llmCard);

    // Now call universalize with intentStrategy: "static" — should MISS the LLM entry
    const result = await universalize({ source }, NULL_REGISTRY, {
      intentStrategy: "static",
      cacheDir,
    });

    const staticCard = result.intentCard;
    expect(staticCard.modelVersion).toBe(STATIC_MODEL_TAG);
    expect(staticCard.promptVersion).toBe(STATIC_PROMPT_VERSION);

    // Verify both files coexist with different keys
    const srcHash = sourceHash(source);
    const llmKey = keyFromIntentInputs({
      sourceHash: srcHash,
      modelTag: DEFAULT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });
    const staticKey = keyFromIntentInputs({
      sourceHash: srcHash,
      modelTag: STATIC_MODEL_TAG,
      promptVersion: STATIC_PROMPT_VERSION,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });

    // Keys must be different
    expect(llmKey).not.toBe(staticKey);

    // Both files must exist on disk
    const llmPath = join(cacheDir, llmKey.slice(0, 3), `${llmKey}.json`);
    const staticPath = join(cacheDir, staticKey.slice(0, 3), `${staticKey}.json`);

    const [llmStat, staticStat] = await Promise.all([
      fsPromises.stat(llmPath).catch(() => null),
      fsPromises.stat(staticPath).catch(() => null),
    ]);

    expect(llmStat).not.toBeNull();
    expect(staticStat).not.toBeNull();
    expect(llmPath).not.toBe(staticPath);
  });

  // -------------------------------------------------------------------------
  // Proof 4: Static path produces a cache-hit on the second call
  // -------------------------------------------------------------------------

  it("static path: second call is a cache hit (no re-extraction)", async () => {
    const source =
      "// SPDX-License-Identifier: MIT\nexport function square(n: number): number { return n * n; }";

    const result1 = await universalize({ source }, NULL_REGISTRY, {
      intentStrategy: "static",
      cacheDir,
    });
    const result2 = await universalize({ source }, NULL_REGISTRY, {
      intentStrategy: "static",
      cacheDir,
    });

    // Both calls must produce the same card
    expect(result1.intentCard.sourceHash).toBe(result2.intentCard.sourceHash);
    expect(JSON.stringify(result1.intentCard)).toBe(JSON.stringify(result2.intentCard));
  });
});
