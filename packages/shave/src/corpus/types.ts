// SPDX-License-Identifier: MIT
// @decision DEC-CORPUS-001
// title: CorpusResult is the canonical output shape for property-test corpus extraction
// status: decided (WI-016)
// rationale:
//   Three extraction sources are tried in priority order: upstream-test adaptation (a),
//   documented-usage synthesis (b), and AI-derived synthesis (c). The CorpusResult
//   records which source succeeded so callers can reason about provenance. A single
//   fast-check file is produced regardless of source — multiple property checks are
//   bundled into one artifact file to satisfy the L0 manifest constraint of exactly
//   one "property_tests" artifact per atom (validateProofManifestL0).
//
//   DEC-SHAVE-002 offline discipline: sources (a) and (b) work without any API key.
//   Source (c) uses the same file-cache.ts surface as intent extraction (DEC-SHAVE-003)
//   with a distinct schemaVersion discriminant so corpus and intent cache entries
//   cannot collide.

/**
 * Which extraction source produced this corpus result.
 *
 * Priority order: upstream-test > documented-usage > ai-derived.
 * The highest-priority available source wins; the rest are not consulted.
 */
export type CorpusSource = "upstream-test" | "documented-usage" | "ai-derived";

/**
 * The output of extractCorpus() for a single atom.
 *
 * A CorpusResult carries a single fast-check property-test file that bundles
 * all property checks for the atom into one artifact. The `bytes` field holds
 * the UTF-8 encoded content; `path` is the canonical artifact path used in the
 * ProofManifest and artifact bytes map; `contentHash` is the BLAKE3-256 hex of
 * the content (for change-detection without re-reading bytes).
 */
export interface CorpusResult {
  /** Which of the three extraction sources produced this result. */
  readonly source: CorpusSource;
  /** UTF-8 encoded fast-check property-test file content. */
  readonly bytes: Uint8Array;
  /** Canonical artifact path for use in ProofManifest.artifacts[0].path. */
  readonly path: string;
  /** BLAKE3-256 hex hash of `bytes`. Used for change-detection. */
  readonly contentHash: string;
}

/**
 * Inputs to extractCorpus() describing the atom being processed.
 *
 * These mirror the fields available from an IntentCard + source text at
 * the point where buildTriplet() is called.
 */
export interface CorpusAtomSpec {
  /**
   * The raw source text of the atom.
   * Used by documented-usage synthesis (source (b)) to extract JSDoc examples
   * and infer the type signature for fast-check arbitrary construction.
   */
  readonly source: string;

  /**
   * The extracted intent card for this atom.
   * Used by all three sources. Source (a) uses propertyTests hints; source (b)
   * uses behavior/inputs/outputs/preconditions; source (c) sends the full card
   * to the AI for property synthesis.
   */
  readonly intentCard: IntentCardInput;

  /**
   * Root cache directory used by source (c) AI-derived synthesis.
   * Must match the cacheDir used in the test's ShaveOptions so that
   * seedCorpusCache writes to the right location.
   * Omitting this disables source (c).
   */
  readonly cacheDir?: string | undefined;
}

/**
 * Minimal IntentCard fields needed by corpus extraction.
 *
 * This interface is intentionally narrow so corpus/ does not import the full
 * IntentCard type from intent/types.ts (which would create a cross-module
 * dependency). Callers pass the full IntentCard; TypeScript structural typing
 * ensures compatibility.
 */
export interface IntentCardInput {
  readonly behavior: string;
  readonly inputs: readonly {
    readonly name: string;
    readonly typeHint: string;
    readonly description: string;
  }[];
  readonly outputs: readonly {
    readonly name: string;
    readonly typeHint: string;
    readonly description: string;
  }[];
  readonly preconditions: readonly string[];
  readonly postconditions: readonly string[];
  readonly notes: readonly string[];
  readonly sourceHash: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

/**
 * Options controlling which sources are attempted by extractCorpus().
 *
 * By default all three sources are enabled. Disable individual sources for
 * testing or to force a specific extraction path.
 */
export interface CorpusExtractionOptions {
  /**
   * Whether to attempt upstream-test adaptation (source a).
   * Default: true.
   */
  readonly enableUpstreamTest?: boolean | undefined;
  /**
   * Whether to attempt documented-usage synthesis (source b).
   * Default: true.
   */
  readonly enableDocumentedUsage?: boolean | undefined;
  /**
   * Whether to attempt AI-derived synthesis (source c).
   * Default: true.
   */
  readonly enableAiDerived?: boolean | undefined;
}
