// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Intent extraction produces a structured
// IntentCard that captures behavioral semantics in a model- and version-tagged
// form. This enables cache invalidation when the model or prompt changes.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Content-addressed caching requires a stable, structured record of
// the extracted intent so future extractors can detect stale entries.

/**
 * A named, typed parameter extracted from a candidate block.
 * WI-010-02 fills the extractor that populates these from the AI response.
 */
export interface IntentParam {
  readonly name: string;
  readonly typeHint: string;
  readonly description: string;
}

/**
 * A structured record of the behavioral intent extracted from a candidate block.
 *
 * IntentCard is the unit of cache storage: it is keyed on the content hash of
 * the source text, the model version, and the prompt version. Changing any of
 * those three values produces a cache miss and re-extracts.
 *
 * schemaVersion is a discriminant that allows forward-compatible deserialization;
 * if the shape of IntentCard changes in a future work item, the schemaVersion
 * must be bumped and old cache entries are invalidated.
 */
export interface IntentCard {
  readonly schemaVersion: 1;
  readonly behavior: string;
  readonly inputs: readonly IntentParam[];
  readonly outputs: readonly IntentParam[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly notes: readonly string[];
  /** The model identifier used during extraction, e.g. "claude-3-5-haiku-20241022". */
  readonly modelVersion: string;
  /** A content-hash of the prompt template used, for cache invalidation. */
  readonly promptVersion: string;
  /** BLAKE3-256 hex of the candidate source bytes. Used as the cache key. */
  readonly sourceHash: string;
  /** ISO-8601 timestamp of extraction. */
  readonly extractedAt: string;
}
