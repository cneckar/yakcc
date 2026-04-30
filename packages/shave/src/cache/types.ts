// Cache types for the shave intent-extraction cache.
// WI-010-02 fills the implementation (file-cache.ts); these interfaces
// define the shape that the cache layer must satisfy.

import type { IntentCard } from "../intent/types.js";

/**
 * The cache key for a cached intent extraction result.
 *
 * Uniqueness is over (sourceHash, modelVersion, promptVersion):
 * any change to the source text or the extractor configuration produces
 * a distinct key and a cache miss.
 */
export interface CacheKey {
  /** BLAKE3-256 hex of the candidate source bytes. */
  readonly sourceHash: string;
  /** The model identifier used during extraction. */
  readonly modelVersion: string;
  /** Content-hash of the prompt template. */
  readonly promptVersion: string;
}

/**
 * A single cache entry wrapping an IntentCard with envelope metadata.
 *
 * The envelope allows the cache implementation to implement TTL-based
 * eviction and integrity checks without modifying the IntentCard shape.
 *
 * WI-010-02 fills the implementation that reads and writes these entries
 * from the file-system cache in packages/shave/src/cache/file-cache.ts.
 */
export interface CacheEntry {
  /** The extracted intent card. */
  readonly card: IntentCard;
  /** Unix epoch milliseconds of cache insertion. */
  readonly cachedAt: number;
  /** Cache format version — allows forward-compatible deserialization. */
  readonly cacheVersion: 1;
}
