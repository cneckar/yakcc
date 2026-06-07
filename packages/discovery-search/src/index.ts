// SPDX-License-Identifier: Apache-2.0
// @decision DEC-1117-PLACEMENT-001
// @title @yakcc/discovery-search public browser-safe surface
// @status decided (MASTER_PLAN.md 2026-06-06)
// @rationale
//   This barrel is the ONLY entry point for consumers of the kit. Every symbol
//   re-exported here must be browser-safe (no node:*, no better-sqlite3, no
//   sqlite-vec, no ts-morph). The node-dep-isolation test in
//   embedder.parity.test.ts asserts this invariant by scanning the resolved
//   import graph of this file.
//
//   Narrow re-exports (not a God-barrel): only the public contract is exposed.
//   Internal helpers (makePipelineLoader, etc.) are NOT re-exported.

// Embedder — browser-safe bge-small pipeline
export {
  LOCAL_EMBED_MODEL_ID,
  LOCAL_EMBED_DIMENSION,
  createBrowserEmbedder,
  type BrowserEmbedder,
} from "./embedder.js";

// Scoring — cosine distance → combinedScore, score bands, thresholds
export {
  cosineDistanceToCombinedScore,
  assignScoreBand,
  cosineSimilarity,
  BAND_MIDPOINTS,
  M1_HIT_THRESHOLD,
  HYBRID_AUTO_ACCEPT_THRESHOLD,
  AUTO_ACCEPT_GAP_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  type ScoreBand,
} from "./score.js";

// Tier derivation — confidence tier from ranked candidates
export {
  deriveConfidenceTier,
  type ConfidenceTier,
  type ScoredCandidate,
} from "./tier.js";

// Search — pure linear cosine rank (browser search core)
export {
  rankCandidates,
  type RankedResult,
  type RankResult,
} from "./search.js";
