/**
 * Tests for extractIntent() — the core cache-read→miss→API→validate→write
 * sequence.
 *
 * WI-022: Every test that depends on Anthropic semantics (API-key guard,
 * OfflineCacheMissError on miss, mock client) now passes explicit
 * strategy: "llm" in the context. This is required because the default strategy
 * changed from (implicit LLM) to "static" in WI-022.
 *
 * Tests NOT gated with "llm": cache-hit behavior is strategy-agnostic (the
 * shared cache read→validate path runs identically for both strategies).
 *
 * Production trigger: universalize() calls extractIntent() for every candidate
 * block. The mock client in these tests replaces the Anthropic SDK, allowing
 * the full extraction pipeline to run without network access.
 *
 * Compound-interaction test: the "cache hit prevents second API call" test
 * exercises the exact sequence universalize uses in production:
 *   1. extractIntent called with source A → mock invoked once → card written.
 *   2. extractIntent called again with same source → cache hit → mock NOT invoked.
 * This proves the cache read→miss→write→hit cycle works end-to-end across
 * the file-cache and key-derivation modules.
 *
 * Note: ANTHROPIC_API_KEY is deliberately unset in unit tests; the mock client
 * is injected via ExtractIntentContext.client to satisfy the guard in extractIntent.
 */

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIntent } from "../cache/file-cache.js";
import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
import {
  AnthropicApiKeyMissingError,
  IntentCardSchemaError,
  OfflineCacheMissError,
} from "../errors.js";
import type { AnthropicLikeClient, AnthropicMessageResponse } from "./anthropic-client.js";
import { INTENT_SCHEMA_VERSION } from "./constants.js";
import { extractIntent } from "./extract.js";
import type { IntentCard } from "./types.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Build the JSON body that the model is expected to return inside <json>...</json>. */
function makeModelPayload(
  overrides?: Partial<{
    schemaVersion: number;
    behavior: string;
    inputs: unknown[];
    outputs: unknown[];
    preconditions: string[];
    postconditions: string[];
    notes: string[];
  }>,
) {
  return {
    schemaVersion: 1,
    behavior: "Returns the sum of two numbers",
    inputs: [
      { name: "a", typeHint: "number", description: "First operand" },
      { name: "b", typeHint: "number", description: "Second operand" },
    ],
    outputs: [{ name: "result", typeHint: "number", description: "Sum" }],
    preconditions: [],
    postconditions: ["result === a + b"],
    notes: [],
    ...overrides,
  };
}

/** Wrap a payload in <json>...</json> fences as the model would. */
function jsonFence(payload: unknown): string {
  return `<json>\n${JSON.stringify(payload, null, 2)}\n</json>`;
}

/** Create a mock AnthropicLikeClient that returns configurable text responses. */
function makeMockClient(responseText: string): {
  client: AnthropicLikeClient;
  callCount: () => number;
} {
  let count = 0;
  const client: AnthropicLikeClient = {
    async create(): Promise<AnthropicMessageResponse> {
      count++;
      return {
        content: [{ type: "text", text: responseText }],
      };
    },
  };
  return { client, callCount: () => count };
}

// ---------------------------------------------------------------------------
// Per-test tmpdir
// ---------------------------------------------------------------------------

let cacheDir: string;
const FROZEN_NOW = new Date("2025-06-15T12:00:00.000Z");

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `extract-test-${unique}`);
  await fsPromises.mkdir(cacheDir, { recursive: true });
  // Ensure ANTHROPIC_API_KEY is unset so the guard is exercised predictably
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await fsPromises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractIntent()", () => {
  // -------------------------------------------------------------------------
  // Happy path — LLM strategy (explicit strategy: "llm" required for mock client)
  // -------------------------------------------------------------------------

  it("happy path (llm): returns a valid IntentCard with correct envelope fields", async () => {
    const source = "function add(a: number, b: number) { return a + b; }";
    const model = "claude-haiku-4-5-20251001";
    const promptVersion = "1";
    const { client } = makeMockClient(jsonFence(makeModelPayload()));

    // WI-022: explicit strategy: "llm" required for Anthropic mock client path
    const card = await extractIntent(source, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });

    expect(card.schemaVersion).toBe(1);
    expect(card.behavior).toBe("Returns the sum of two numbers");
    expect(card.modelVersion).toBe(model);
    expect(card.promptVersion).toBe(promptVersion);
    expect(card.sourceHash).toHaveLength(64);
    expect(card.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    // extractedAt is truncated to whole second
    expect(card.extractedAt).toBe("2025-06-15T12:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // Cache hit: same source → client called once (LLM path)
  // -------------------------------------------------------------------------

  it("cache hit (llm): same source called twice → mock client called exactly once", async () => {
    const source = "function identity(x: string) { return x; }";
    // WI-022: explicit strategy: "llm" for Anthropic mock path
    const ctx = {
      strategy: "llm" as const,
      model: "claude-haiku-4-5-20251001",
      promptVersion: "1",
      cacheDir,
      now: () => FROZEN_NOW,
    };
    const { client, callCount } = makeMockClient(
      jsonFence(
        makeModelPayload({
          behavior: "Returns its input unchanged",
        }),
      ),
    );

    // First call: cache miss → API invoked
    const card1 = await extractIntent(source, { ...ctx, client });
    expect(callCount()).toBe(1);

    // Second call: cache hit → API NOT invoked again
    const card2 = await extractIntent(source, { ...ctx, client });
    expect(callCount()).toBe(1);

    expect(card1.sourceHash).toBe(card2.sourceHash);
    expect(JSON.stringify(card1)).toBe(JSON.stringify(card2));
  });

  // -------------------------------------------------------------------------
  // Cache miss when source changes (LLM path)
  // -------------------------------------------------------------------------

  it("changing source byte invalidates cache → mock called twice", async () => {
    // WI-022: explicit strategy: "llm"
    const ctx = {
      strategy: "llm" as const,
      model: "claude-haiku-4-5-20251001",
      promptVersion: "1",
      cacheDir,
      now: () => FROZEN_NOW,
    };
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));

    await extractIntent("source A", { ...ctx, client });
    await extractIntent("source B", { ...ctx, client });

    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cache invalidation by model (LLM path)
  // -------------------------------------------------------------------------

  it("changing model invalidates cache → mock called twice", async () => {
    const source = "const x = 1;";
    // WI-022: explicit strategy: "llm"
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));

    await extractIntent(source, {
      strategy: "llm",
      model: "model-a",
      promptVersion: "1",
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });
    await extractIntent(source, {
      strategy: "llm",
      model: "model-b",
      promptVersion: "1",
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });

    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cache invalidation by promptVersion (LLM path)
  // -------------------------------------------------------------------------

  it("changing promptVersion invalidates cache → mock called twice", async () => {
    const source = "const x = 1;";
    // WI-022: explicit strategy: "llm"
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));

    await extractIntent(source, {
      strategy: "llm",
      model: "model-a",
      promptVersion: "1",
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });
    await extractIntent(source, {
      strategy: "llm",
      model: "model-a",
      promptVersion: "2",
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });

    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Malformed model output (LLM path)
  // -------------------------------------------------------------------------

  it("model response missing JSON fence → throws IntentCardSchemaError", async () => {
    // WI-022: explicit strategy: "llm"
    const { client } = makeMockClient("Here is some text without any JSON fence.");
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
        client,
      }),
    ).rejects.toThrow(IntentCardSchemaError);
  });

  it("model response with JSON fence but invalid schema → throws IntentCardSchemaError", async () => {
    // Valid JSON, but schemaVersion wrong + extra field
    // WI-022: explicit strategy: "llm"
    const badPayload = { schemaVersion: 99, foo: "bar" };
    const { client } = makeMockClient(jsonFence(badPayload));
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
        client,
      }),
    ).rejects.toThrow(IntentCardSchemaError);
  });

  it("model response with no text content block → treats responseText as '' → throws IntentCardSchemaError", async () => {
    // When the API returns a response with no text block, responseText is ""
    // and parseJsonFence throws because there are no fences.
    // WI-022: explicit strategy: "llm"
    let count = 0;
    const client: AnthropicLikeClient = {
      async create() {
        count++;
        // Return only non-text blocks (e.g. tool_use) — no text block
        return { content: [{ type: "tool_use" }] };
      },
    };
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
        client,
      }),
    ).rejects.toThrow(IntentCardSchemaError);
    expect(count).toBe(1);
  });

  it("model response with JSON fence containing unparseable JSON → throws IntentCardSchemaError", async () => {
    // WI-022: explicit strategy: "llm"
    const { client } = makeMockClient("<json>{not valid json}</json>");
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
        client,
      }),
    ).rejects.toThrow(IntentCardSchemaError);
  });

  // -------------------------------------------------------------------------
  // Missing API key guard (LLM path only)
  // -------------------------------------------------------------------------

  it("missing API key + no client → throws AnthropicApiKeyMissingError", async () => {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
    delete process.env.ANTHROPIC_API_KEY;
    // WI-022: explicit strategy: "llm" — this error only fires on the LLM path
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
      }),
    ).rejects.toThrow(AnthropicApiKeyMissingError);
  });

  it("uses real clock when ctx.now is not provided (default now() branch)", async () => {
    const before = Date.now();
    // WI-022: explicit strategy: "llm" for this test (uses mock client)
    const { client } = makeMockClient(jsonFence(makeModelPayload()));
    const card = await extractIntent("function nowTest() {}", {
      strategy: "llm",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "1",
      cacheDir,
      client,
      // no now: — exercises the () => new Date() fallback
    });
    const after = Date.now();

    // extractedAt should be a valid ISO string within the test window
    const extractedTime = new Date(card.extractedAt).getTime();
    expect(extractedTime).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(extractedTime).toBeLessThanOrEqual(Math.ceil(after / 1000) * 1000);
  });

  it("missing API key guard fires BEFORE the mock would be invoked", async () => {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
    delete process.env.ANTHROPIC_API_KEY;
    // WI-022: explicit strategy: "llm" — API-key guard only fires on LLM path
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));
    // client NOT passed — the guard should throw before any client resolution
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
      }),
    ).rejects.toThrow(AnthropicApiKeyMissingError);
    // client was never called (it wasn't injected)
    expect(callCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Offline mode (LLM path — "static" is always offline-safe)
  // -------------------------------------------------------------------------

  it("offline + cache miss → throws OfflineCacheMissError, mock never invoked", async () => {
    // WI-022: explicit strategy: "llm" — OfflineCacheMissError is LLM-path only
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));
    await expect(
      extractIntent("const x = 1;", {
        strategy: "llm",
        model: "m",
        promptVersion: "1",
        cacheDir,
        offline: true,
        client,
      }),
    ).rejects.toThrow(OfflineCacheMissError);
    expect(callCount()).toBe(0);
  });

  it("offline + cache hit → returns IntentCard, mock never invoked", async () => {
    const source = "function cached() {}";
    const model = "claude-haiku-4-5-20251001";
    const promptVersion = "1";

    // Pre-seed the cache with a valid card (using LLM-mode tags to match strategy: "llm")
    const sh = sourceHash(source);
    const key = keyFromIntentInputs({
      sourceHash: sh,
      modelTag: model,
      promptVersion,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });
    const cachedCard: IntentCard = {
      schemaVersion: 1,
      behavior: "Pre-seeded cached behavior",
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      modelVersion: model,
      promptVersion,
      sourceHash: sh,
      extractedAt: FROZEN_NOW.toISOString(),
    };
    await writeIntent(cacheDir, key, cachedCard);

    // WI-022: explicit strategy: "llm" so key computation matches the seeded key
    const { client, callCount } = makeMockClient(jsonFence(makeModelPayload()));
    const result = await extractIntent(source, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      offline: true,
      client,
    });

    expect(result.behavior).toBe("Pre-seeded cached behavior");
    expect(callCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Schema-corrupt cache: valid JSON, but validateIntentCard fails
  // (lines 142-153 in extract.ts: the catch block after validateIntentCard)
  // -------------------------------------------------------------------------

  it("schema-corrupt cache (valid JSON, invalid IntentCard) is evicted then re-fetched", async () => {
    const source = "function schemaCorrupt() {}";
    const model = "claude-haiku-4-5-20251001";
    const promptVersion = "1";

    // Plant a cache file with valid JSON but a bad schemaVersion (schema violation)
    const sh = sourceHash(source);
    const key = keyFromIntentInputs({
      sourceHash: sh,
      modelTag: model,
      promptVersion,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    await fsPromises.mkdir(shardDir, { recursive: true });
    // Valid JSON but schemaVersion: 99 fails validateIntentCard
    await fsPromises.writeFile(
      join(shardDir, `${key}.json`),
      JSON.stringify({ schemaVersion: 99, behavior: "bad" }),
      "utf-8",
    );

    // WI-022: explicit strategy: "llm" so cache key matches the planted file
    const { client, callCount } = makeMockClient(
      jsonFence(
        makeModelPayload({
          behavior: "Schema-corrupt cache re-fetched",
        }),
      ),
    );

    const result = await extractIntent(source, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });
    // Should have re-fetched after evicting the schema-corrupt entry
    expect(result.behavior).toBe("Schema-corrupt cache re-fetched");
    expect(callCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Corrupt cache: evicted then re-fetched (LLM path)
  // -------------------------------------------------------------------------

  it("corrupt cache file is evicted, then re-fetched via API (mock invoked once)", async () => {
    const source = "function corrupt() {}";
    const model = "claude-haiku-4-5-20251001";
    const promptVersion = "1";

    // Compute the key and plant a corrupt file
    const sh = sourceHash(source);
    const key = keyFromIntentInputs({
      sourceHash: sh,
      modelTag: model,
      promptVersion,
      schemaVersion: INTENT_SCHEMA_VERSION,
    });
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    await fsPromises.mkdir(shardDir, { recursive: true });
    await fsPromises.writeFile(join(shardDir, `${key}.json`), "{corrupt", "utf-8");

    // WI-022: explicit strategy: "llm" so cache key matches the planted file
    const { client, callCount } = makeMockClient(
      jsonFence(
        makeModelPayload({
          behavior: "Function with corrupt cache evicted",
        }),
      ),
    );

    const result = await extractIntent(source, {
      strategy: "llm",
      model,
      promptVersion,
      cacheDir,
      client,
      now: () => FROZEN_NOW,
    });
    expect(result.behavior).toBe("Function with corrupt cache evicted");
    expect(callCount()).toBe(1);
  });
});
