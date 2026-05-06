// SPDX-License-Identifier: MIT
// Vitest harness for extract.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./extract.props.js";

describe("extract.ts — Path A property corpus", () => {
  // -------------------------------------------------------------------------
  // (a) parseJsonFence happy path
  // -------------------------------------------------------------------------
  it("property: llm happy path returns validated IntentCard", async () => {
    await fc.assert(Props.prop_extract_llm_happy_path_returns_validated_card, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (b) parseJsonFence — fences absent
  // -------------------------------------------------------------------------
  it("property: llm no-fence response throws IntentCardSchemaError", async () => {
    await fc.assert(Props.prop_extract_llm_no_fence_throws_schema_error, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (c) parseJsonFence — end <= start (inverted fences)
  // -------------------------------------------------------------------------
  it("property: llm inverted fences throws IntentCardSchemaError", async () => {
    await fc.assert(Props.prop_extract_llm_inverted_fences_throws_schema_error, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (d) parseJsonFence — malformed JSON between fences
  // -------------------------------------------------------------------------
  it("property: llm malformed JSON in fence throws IntentCardSchemaError", async () => {
    await fc.assert(Props.prop_extract_llm_malformed_json_in_fence_throws_schema_error, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (e) strategy default resolves to 'static'
  // -------------------------------------------------------------------------
  it("property: omitting strategy defaults to static (no client needed)", async () => {
    await fc.assert(Props.prop_extract_strategy_default_is_static, {
      numRuns: 5,
    });
  });

  // -------------------------------------------------------------------------
  // (f) strategy='static' uses STATIC_MODEL_TAG / STATIC_PROMPT_VERSION
  // -------------------------------------------------------------------------
  it("property: strategy='static' uses STATIC_MODEL_TAG and STATIC_PROMPT_VERSION", async () => {
    await fc.assert(Props.prop_extract_static_strategy_uses_static_tags, {
      numRuns: 5,
    });
  });

  // -------------------------------------------------------------------------
  // (g) strategy='llm' uses ctx.model / ctx.promptVersion
  // -------------------------------------------------------------------------
  it("property: strategy='llm' card has modelVersion and promptVersion from ctx", async () => {
    await fc.assert(Props.prop_extract_llm_strategy_uses_ctx_model_and_prompt_version, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (h) srcHash determinism
  // -------------------------------------------------------------------------
  it("property: sourceHash is deterministic for same source", async () => {
    await fc.assert(Props.prop_extract_srcHash_is_deterministic, {
      numRuns: 20,
    });
  });

  it("property: sourceHash differs for distinct sources", async () => {
    await fc.assert(Props.prop_extract_srcHash_differs_for_different_sources, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (i) extractedAt whole-second truncation
  // -------------------------------------------------------------------------
  it("property: extractedAt is truncated to whole second ISO-8601", async () => {
    await fc.assert(Props.prop_extract_extractedAt_is_whole_second_iso8601, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (j) offline + cache miss → OfflineCacheMissError
  // -------------------------------------------------------------------------
  it("property: offline + cold cache throws OfflineCacheMissError", async () => {
    await fc.assert(
      Props.prop_extract_llm_offline_cache_miss_throws_OfflineCacheMissError,
      { numRuns: 20 },
    );
  });

  it("property: offline + warm cache returns cached card", async () => {
    await fc.assert(Props.prop_extract_llm_offline_cache_hit_returns_card, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // (k) no client + no API key → AnthropicApiKeyMissingError
  // -------------------------------------------------------------------------
  it("property: no client and no ANTHROPIC_API_KEY throws AnthropicApiKeyMissingError", async () => {
    await fc.assert(
      Props.prop_extract_llm_no_client_no_key_throws_AnthropicApiKeyMissingError,
      { numRuns: 20 },
    );
  });

  // -------------------------------------------------------------------------
  // (l) IntentCard fields from ctx
  // -------------------------------------------------------------------------
  it("property: llm card fields come from ctx (model, promptVersion, srcHash, extractedAt)", async () => {
    await fc.assert(Props.prop_extract_llm_card_fields_come_from_ctx, {
      numRuns: 20,
    });
  });

  it("property: llm result passes validateIntentCard (idempotent)", async () => {
    await fc.assert(Props.prop_extract_llm_result_passes_validateIntentCard, {
      numRuns: 20,
    });
  });

  // -------------------------------------------------------------------------
  // Compound interactions
  // -------------------------------------------------------------------------
  it("property: compound — static miss then hit returns same card from cache", async () => {
    await fc.assert(Props.prop_extract_static_compound_miss_then_hit, {
      numRuns: 5,
    });
  });

  it("property: compound — llm miss then hit (offline on second call succeeds)", async () => {
    await fc.assert(Props.prop_extract_llm_compound_miss_then_hit, {
      numRuns: 20,
    });
  });
});
