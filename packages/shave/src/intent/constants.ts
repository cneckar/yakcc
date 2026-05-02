// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Constants governing the intent extraction
// pipeline: model identifier, prompt version, and schema version. Changing any
// of these values forces a cache miss for all existing entries, which is the
// correct behavior when the extraction contract changes.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Centralizing these values in a single module prevents drift between
// the extractor, cache key derivation, and validator. All three must agree on
// the active schema version.

/**
 * Default Anthropic model used for intent extraction.
 * Override via ExtractIntentContext.model or ShaveOptions.model.
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Monotonic version tag for the system prompt template.
 * Bump this whenever the prompt text changes to invalidate cached results
 * that were produced by the old prompt.
 */
export const INTENT_PROMPT_VERSION = "1";

/**
 * Schema version discriminant for the IntentCard shape.
 * Must match the `schemaVersion` field written into every IntentCard.
 * Bump together with the IntentCard type definition in intent/types.ts.
 */
export const INTENT_SCHEMA_VERSION = 1 as const;

/**
 * @decision DEC-INTENT-STATIC-CACHE-001
 * @title Static extractor model/prompt version tags for cache-key isolation
 * @status accepted
 * @rationale
 *   The existing keyFromIntentInputs() BLAKE3 derivation (cache/key.ts) mixes
 *   modelTag and promptVersion into the composite cache key. By assigning
 *   "static-ts@1" and "static-jsdoc@1" — values that no Anthropic model
 *   identifier can equal — static and LLM cards land in permanently disjoint
 *   cache namespaces with no additional registry or discriminant field.
 *
 *   Versioning rule:
 *   - Bump STATIC_MODEL_TAG (@1->@2) when AST-extraction logic changes output
 *     shape for the same source (picker rules, type-hint format). This
 *     invalidates only the static cache namespace; LLM entries are untouched.
 *   - Bump STATIC_PROMPT_VERSION (@1->@2) when JSDoc parsing changes (new tag,
 *     prefix string, body normalization). Same isolation guarantee applies.
 *   Both bumps are backward-compatible from the LLM path's perspective.
 */
export const STATIC_MODEL_TAG = "static-ts@1";

/**
 * Monotonic version tag for the static JSDoc-parsing logic.
 * See DEC-INTENT-STATIC-CACHE-001 for versioning rules.
 */
export const STATIC_PROMPT_VERSION = "static-jsdoc@1";
