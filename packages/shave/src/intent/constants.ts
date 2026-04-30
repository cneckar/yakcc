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
