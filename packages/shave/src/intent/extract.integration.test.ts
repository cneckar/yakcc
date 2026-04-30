/**
 * Integration test for extractIntent() — makes a real Anthropic API call.
 *
 * This test is env-gated: it is a no-op unless ANTHROPIC_API_KEY is set.
 * It is intentionally excluded from default CI and the coverage include set.
 * Run it manually with:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @yakcc/shave test
 *
 * Production trigger: this is the only test that exercises the full
 * extractIntent → Anthropic SDK → validate path without mocking, confirming
 * that the live model produces output that passes validateIntentCard.
 */

import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, INTENT_PROMPT_VERSION } from "./constants.js";
import { extractIntent } from "./extract.js";
import { validateIntentCard } from "./validate-intent-card.js";

const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

let cacheDir: string;

beforeAll(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `extract-integration-${unique}`);
  await mkdir(cacheDir, { recursive: true });
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!HAS_API_KEY)("extractIntent() — live Anthropic API", () => {
  it("extracts a valid IntentCard from a real TypeScript function via the live API", async () => {
    const source = "function add(a: number, b: number): number { return a + b; }";

    const card = await extractIntent(source, {
      model: DEFAULT_MODEL,
      promptVersion: INTENT_PROMPT_VERSION,
      cacheDir,
    });

    // Must pass the validator without throwing
    expect(() => validateIntentCard(card)).not.toThrow();

    // Structural assertions on the live response
    expect(card.schemaVersion).toBe(1);
    expect(card.behavior.length).toBeGreaterThan(0);
    expect(card.modelVersion).toBe(DEFAULT_MODEL);
    expect(card.promptVersion).toBe(INTENT_PROMPT_VERSION);
    expect(card.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000); // Allow up to 30 seconds for the live API call
});
