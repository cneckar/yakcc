// @decision DEC-CONTINUOUS-SHAVE-022: extractIntent is the single internal
// entry point for live intent extraction. It owns the cache read→miss→API→
// validate→write sequence. The function is intentionally NOT exported from
// index.ts so callers depend only on the stable public surface (universalize,
// shave, validateIntentCard). The extraction implementation can evolve freely.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Keeping extractIntent internal prevents callers from bypassing
// the cache or constructing partial IntentCards. All extraction must go through
// this function to guarantee cache consistency and validation invariants.

import { readIntent, writeIntent } from "../cache/file-cache.js";
import { sourceHash as computeSourceHash, keyFromIntentInputs } from "../cache/key.js";
import {
  AnthropicApiKeyMissingError,
  IntentCardSchemaError,
  OfflineCacheMissError,
} from "../errors.js";
import type { AnthropicLikeClient } from "./anthropic-client.js";
import { createDefaultAnthropicClient } from "./anthropic-client.js";
import { INTENT_SCHEMA_VERSION } from "./constants.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { IntentCard } from "./types.js";
import { validateIntentCard } from "./validate-intent-card.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Configuration context for a single extractIntent call.
 *
 * All fields are required except `offline`, `client`, and `now`, which have
 * well-defined defaults. The caller (universalize, or a test) assembles this
 * from ShaveOptions + constants.
 */
export interface ExtractIntentContext {
  /** Anthropic model identifier, e.g. DEFAULT_MODEL. */
  readonly model: string;
  /** Prompt version tag used in cache key derivation (INTENT_PROMPT_VERSION). */
  readonly promptVersion: string;
  /** Absolute path to the root of the intent cache directory. */
  readonly cacheDir: string;
  /**
   * When true, the extractor never makes API calls — throws OfflineCacheMissError
   * on a cache miss instead.
   */
  readonly offline?: boolean | undefined;
  /**
   * Injectable Anthropic client. When provided, used instead of constructing
   * the default SDK client. Allows tests to inject a mock without network access.
   */
  readonly client?: AnthropicLikeClient | undefined;
  /**
   * Clock override for extractedAt timestamp. Defaults to () => new Date().
   * Allows tests to assert a deterministic extractedAt value.
   */
  readonly now?: (() => Date) | undefined;
}

// ---------------------------------------------------------------------------
// JSON fence parser
// ---------------------------------------------------------------------------

/**
 * Extract the content between the first <json>…</json> fence pair.
 *
 * Throws IntentCardSchemaError if fences are absent or the content between
 * them is not parseable as JSON.
 */
function parseJsonFence(response: string): unknown {
  const openTag = "<json>";
  const closeTag = "</json>";
  const start = response.indexOf(openTag);
  const end = response.indexOf(closeTag);

  if (start === -1 || end === -1 || end <= start) {
    throw new IntentCardSchemaError(
      `API response missing <json>...</json> fences. Raw response (first 200 chars): ${response.slice(0, 200)}`,
    );
  }

  const jsonText = response.slice(start + openTag.length, end).trim();
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (err) {
    throw new IntentCardSchemaError(
      `API response contained malformed JSON between fences: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Core extractor
// ---------------------------------------------------------------------------

/**
 * Extract the behavioral intent from a unit of source code.
 *
 * This function is INTERNAL — it is not exported from index.ts.
 * WI-010-03 will wire universalize() to call this function.
 *
 * Sequence:
 *   1. Compute sourceHash = BLAKE3(normalize(unitSource)).
 *   2. Derive composite cacheKey from (sourceHash, model, promptVersion, schemaVersion).
 *   3. Attempt cache read via readIntent(cacheDir, cacheKey).
 *      - Hit: validate and return. On validation failure, delete corrupt entry
 *        and proceed as miss.
 *   4. On miss:
 *      a. If offline === true → throw OfflineCacheMissError.
 *      b. If no ANTHROPIC_API_KEY and no ctx.client → throw AnthropicApiKeyMissingError.
 *      c. Call the Anthropic API with the source as user turn.
 *      d. Parse the <json>…</json> fence → throw IntentCardSchemaError on failure.
 *      e. Assemble the full IntentCard (adds envelope fields).
 *      f. validateIntentCard → throw IntentCardSchemaError on violation.
 *      g. writeIntent (atomic) to cache.
 *      h. Return the validated card.
 *
 * @param unitSource - Raw source text of the candidate block.
 * @param ctx - Extraction context (model, promptVersion, cacheDir, flags).
 * @returns Validated IntentCard.
 */
export async function extractIntent(
  unitSource: string,
  ctx: ExtractIntentContext,
): Promise<IntentCard> {
  // Step 1 & 2: compute hashes and cache key.
  const srcHash = computeSourceHash(unitSource);
  const cacheKey = keyFromIntentInputs({
    sourceHash: srcHash,
    modelTag: ctx.model,
    promptVersion: ctx.promptVersion,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });

  // Step 3: attempt cache hit.
  const cached = await readIntent(ctx.cacheDir, cacheKey);
  if (cached !== undefined) {
    try {
      return validateIntentCard(cached);
    } catch (err) {
      // Corrupt cache entry — log, delete, and proceed as miss.
      console.warn(
        `[shave extractIntent] Corrupt cache entry for key ${cacheKey} (${
          err instanceof Error ? err.message : String(err)
        }); treating as miss.`,
      );
      // readIntent already deletes on parse error; validateIntentCard failures
      // require a manual eviction here.
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const shard = cacheKey.slice(0, 3);
      const filePath = join(ctx.cacheDir, shard, `${cacheKey}.json`);
      await unlink(filePath).catch(() => {
        // Best-effort; ignore.
      });
    }
  }

  // Step 4a: offline mode — no API calls.
  if (ctx.offline === true) {
    throw new OfflineCacheMissError(cacheKey);
  }

  // Step 4b: check for API key.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (ctx.client === undefined && !apiKey) {
    throw new AnthropicApiKeyMissingError();
  }

  // Step 4c: resolve client and call the API.
  // At this point either ctx.client is set or apiKey is a non-empty string
  // (the guard above ensures at least one is truthy).
  const client = ctx.client ?? (await createDefaultAnthropicClient(apiKey as string));

  const response = await client.create({
    model: ctx.model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: unitSource }],
    max_tokens: 2048,
  });

  // Extract text from the first text content block.
  const textBlock = response.content.find((b) => b.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const responseText = textBlock?.text ?? "";

  // Step 4d: parse the JSON fence.
  const raw = parseJsonFence(responseText);

  // Step 4e: assemble the full IntentCard.
  const now = (ctx.now ?? (() => new Date()))();
  // Truncate to whole second for a clean ISO-8601 timestamp.
  const extractedAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();

  const card = {
    ...(raw as Record<string, unknown>),
    modelVersion: ctx.model,
    promptVersion: ctx.promptVersion,
    sourceHash: srcHash,
    extractedAt,
  };

  // Step 4f: validate (throws IntentCardSchemaError on any violation).
  const validated = validateIntentCard(card);

  // Step 4g: write to cache atomically.
  await writeIntent(ctx.cacheDir, cacheKey, validated);

  // Step 4h: return.
  return validated;
}
